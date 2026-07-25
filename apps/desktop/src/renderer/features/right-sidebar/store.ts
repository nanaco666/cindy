/**
 * RightSidebar Tab Store —— module-level singleton,per-sessionId 分片缓存 + IPC 集成。
 *
 * 设计要点:
 *  - cache 按 sessionId 分桶(Map<sessionId, TabBucket>),跨 session 互不串。
 *  - 首次访问某 sessionId 调用 `ensureHydrated(sessionId)` 触发 IPC list 拉取并 hydrate。
 *  - 操作(addTab / closeTab / setActiveTab / patchTabState / reorderTabs)走"乐观更新 cache
 *    + IPC 写"的模式:乐观本地改,IPC 同步写,写失败回滚 cache + rethrow。
 *  - subscribe(listener) 接收 sessionId-aware 通知;消费方(RightSidebarShell)通过
 *    React 的 useSyncExternalStore 订阅当前 sessionId 的桶变化。
 *
 * Phase 2 简化(后续优化):
 *  - 所有写都立即调用 IPC,无 debounce。Phase 3/5 真有高频 patch(浏览器 url 等)再加 debounce。
 *  - 错误暴露走 caller 的 catch + console.error;Phase 7 加 toast 统一暴露。
 *
 * 模块单例 → RightSidebar 整树 unmount/remount(session 切换时 MainLayout L553 条件渲染)也不丢数据。
 */

import { createLogger } from '@/lib/logger';
import { getSessionDeviceId } from '@/features/device-link/remoteProjectsStore';
import { getTabKind } from './registry';
import type { TabKindId, TabState } from './types';

const log = createLogger('rightSidebar.store');

/** Bucket = 某个 session 的 tab 列表 + 激活 + hydrate 状态。 */
export interface TabBucket {
  /** false = 尚未从 IPC 加载,Shell 应渲染 placeholder。 */
  hydrated: boolean;
  tabs: TabState[];
  activeTabId: string | null;
}

type Listener = (sessionId: string) => void;
export type TabCloseInterceptor = () => Promise<boolean | void> | boolean | void;

const MAX_TABS_PER_SESSION = 20;
const MAX_STATE_JSON_BYTES = 16 * 1024;
const cache = new Map<string, TabBucket>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<Listener>();
const memoryOnlySessions = new Set<string>();
const closeInterceptors = new Map<string, TabCloseInterceptor>();

interface RightSidebarTabsListResult {
  tabs: Array<{ id: string; kind: string; state: unknown }>;
  activeTabId: string | null;
  /** false = session is not present in this device's local sessions table. */
  persistable?: boolean;
}

/**
 * cache miss 时 getBucket 返回的稳定单例。
 *
 * 必须是单例 reference,因为 RightSidebarShell 走 useSyncExternalStore 订阅当前
 * sessionId 的桶 —— React 用 Object.is 比较 snapshot,若 cache miss 每次返回新对象
 * 会触发无限重渲染(也会报警告)。
 *
 * 语义是"尚未加载,Shell 应渲染占位而非 EmptyState"。setBucket 的 cache miss base
 * 走 hydrated:true 的 inline 对象,不复用此常量(写操作 = 已接管 session 状态)。
 */
const EMPTY_BUCKET: TabBucket = { hydrated: false, tabs: [], activeTabId: null };

function notify(sessionId: string): void {
  for (const l of listeners) l(sessionId);
}

function ipcApi() {
  return typeof window !== 'undefined'
    ? window.electronAPI?.localDb?.rightSidebarTabs
    : undefined;
}

function makeTabId(): string {
  // Phase 2 简易 id;不引入 nanoid 依赖。冲突概率 ~10^-12,实际不可能。
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function setBucket(sessionId: string, next: Partial<TabBucket>): TabBucket {
  const current = cache.get(sessionId);
  // cache miss + 写操作:用 hydrated:true 作 merge base —— 写入意味着我们已接管该
  // session 状态,不再需要 ensureHydrated 回填。EMPTY_BUCKET 只用于 getBucket 的
  // "尚未加载"语义,两条路径必须区分,否则 partial setBucket 会让 merged.hydrated
  // 一直停在 false,Shell 永远渲染占位。
  const base: TabBucket = current ?? { hydrated: true, tabs: [], activeTabId: null };
  const merged: TabBucket = { ...base, ...next };
  cache.set(sessionId, merged);
  notify(sessionId);
  return merged;
}

/**
 * per-session 的持久化边界。false = 纯内存模式,所有 IPC 写(以及 hydrate 的
 * list)都跳过。两类来源:
 *  - device-link 远程会话(getSessionDeviceId 命中):right_sidebar_tabs 表对
 *    sessions 表有 FK(ON DELETE CASCADE),远程会话的 sessionId 不在控制端
 *    本地 sessions 表,写入必撞 FOREIGN KEY 约束(真机实测:addTab reject →
 *    tab"一闪"加不上)。前置判定,连 list 都不发。
 *  - 运行时探测(memoryOnlySessions):hydrate 的 list 返回 persistable=false,
 *    或首次写撞 FK 错误后标记。
 * 内存模式不跨重启持久化——tab 布局属会话视图态,远程会话在控制端本就是
 * 镜像,重开重建可接受。
 */
function shouldPersist(sessionId: string): boolean {
  return !memoryOnlySessions.has(sessionId) && !getSessionDeviceId(sessionId);
}

function isMissingSessionPersistenceError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes('SQLITE_CONSTRAINT_FOREIGNKEY') ||
    err.message.includes('FOREIGN KEY constraint failed')
  );
}

function markMemoryOnlySession(sessionId: string): void {
  memoryOnlySessions.add(sessionId);
}

function validateMemoryOnlyStateSize(state: unknown): void {
  const json = state === undefined ? '{}' : JSON.stringify(state);
  if (typeof json !== 'string') {
    throw new Error('tab state JSON must be serializable');
  }
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > MAX_STATE_JSON_BYTES) {
    throw new Error(`tab state JSON too large: ${bytes} bytes (limit ${MAX_STATE_JSON_BYTES})`);
  }
}

/**
 * 当前快照(同步)。无 sessionId 或 cache miss 时返回 EMPTY_BUCKET 单例
 * (hydrated:false,语义 "尚未加载")。
 *
 * 返回 reference 必须稳定 —— Shell 走 useSyncExternalStore 订阅,React 用 Object.is
 * 比较 snapshot,cache miss 返回新对象会触发警告 / 无限重渲染。
 */
export function getBucket(sessionId: string | null | undefined): TabBucket {
  if (!sessionId) return EMPTY_BUCKET;
  return cache.get(sessionId) ?? EMPTY_BUCKET;
}

/** 首次访问 sessionId 触发 IPC list 拉取;后续命中 cache 即 noop。dedupe 并发请求。 */
export async function ensureHydrated(sessionId: string): Promise<void> {
  if (!sessionId) return;
  const current = cache.get(sessionId);
  if (current?.hydrated) return;
  const existing = inflight.get(sessionId);
  if (existing) return existing;
  const ipc = ipcApi();
  if (!ipc || !shouldPersist(sessionId)) {
    // SSR / 测试 / preload 未就绪,或纯内存会话(device-link 远程)——
    // 标记空 hydrated,防止 useEffect 无限重试;不发 list IPC。
    setBucket(sessionId, { hydrated: true, tabs: [], activeTabId: null });
    return;
  }
  const promise = (async () => {
    try {
      const result = await ipc.list({ sessionId }) as RightSidebarTabsListResult;
      if (result.persistable === false) {
        markMemoryOnlySession(sessionId);
      } else {
        memoryOnlySessions.delete(sessionId);
      }
      const tabs: TabState[] = result.tabs.map((row) => ({
        id: row.id,
        kind: row.kind as TabKindId,
        state: row.state,
      }));
      setBucket(sessionId, { hydrated: true, tabs, activeTabId: result.activeTabId });
    } finally {
      inflight.delete(sessionId);
    }
  })();
  inflight.set(sessionId, promise);
  return promise;
}

/** 新增 tab —— 走乐观本地添加 + IPC upsert + setActive,失败回滚 cache。 */
export async function addTab(
  sessionId: string,
  kind: TabKindId,
  initialState: unknown = null,
): Promise<TabState> {
  const prev = getBucket(sessionId);
  if (prev.tabs.length >= MAX_TABS_PER_SESSION) {
    throw new Error(`session ${sessionId} already has ${MAX_TABS_PER_SESSION} tabs (limit reached)`);
  }
  if (!shouldPersist(sessionId)) {
    validateMemoryOnlyStateSize(initialState);
  }
  const id = makeTabId();
  const position = prev.tabs.length;
  const newTab: TabState = { id, kind, state: initialState };
  setBucket(sessionId, { tabs: [...prev.tabs, newTab], activeTabId: id });
  try {
    const ipc = ipcApi();
    if (ipc && shouldPersist(sessionId)) {
      await ipc.upsert({ id, sessionId, kind, position, state: initialState });
      await ipc.setActive({ sessionId, id });
    }
    return newTab;
  } catch (err) {
    if (isMissingSessionPersistenceError(err)) {
      markMemoryOnlySession(sessionId);
      return newTab;
    }
    log.error('addTab IPC failed; rolling back cache', { sessionId, kind, err });
    setBucket(sessionId, { tabs: prev.tabs, activeTabId: prev.activeTabId });
    throw err;
  }
}

/**
 * 单例 kind helper —— bucket 内若已存在该 kind 的 tab 则 setActive,
 * 否则 addTab。返回最终 tab(新建或已有)。专门给 review 这种"每 session 至多 1 个"
 * 的 plugin 用,避免分散调用方手写"先 find 再 add"的判存语义。
 *
 * 不保证 bucket 已 hydrated:调用方应在 hydrated 后才调,否则可能在 IPC list
 * 完成前先 addTab,后到的 list 结果会跟乐观写的 tab 合并冲突。RightSidebarShell
 * 的 EmptyState 触发路径已经 hydrated(bucket.hydrated=true)。
 */
export async function addOrFocusSingletonTab(
  sessionId: string,
  kind: TabKindId,
  initialState: unknown = null,
): Promise<TabState> {
  const bucket = getBucket(sessionId);
  const existing = bucket.tabs.find((t) => t.kind === kind);
  if (existing) {
    if (bucket.activeTabId !== existing.id) {
      await setActiveTab(sessionId, existing.id);
    }
    return existing;
  }
  return addTab(sessionId, kind, initialState);
}

export function setTabCloseInterceptor(
  tabId: string,
  interceptor: TabCloseInterceptor | null,
): () => void {
  if (!interceptor) {
    closeInterceptors.delete(tabId);
    return () => undefined;
  }
  closeInterceptors.set(tabId, interceptor);
  return () => {
    if (closeInterceptors.get(tabId) === interceptor) closeInterceptors.delete(tabId);
  };
}

export function hasTabCloseInterceptor(tabId: string): boolean {
  return closeInterceptors.has(tabId);
}

/** 关 tab —— 优先激活右邻 → 左邻 → null。失败回滚。
 *  plugin.onBeforeClose 给 plugin 释放 main 进程资源的机会(terminal 在这里 dispose PTY)。
 *  默认失败不阻断关闭流程;只有 plugin 明确返回 false 时才否决关闭。 */
export async function closeTab(
  sessionId: string,
  tabId: string,
  opts: { skipBeforeClose?: boolean } = {},
): Promise<void> {
  const prev = getBucket(sessionId);
  const idx = prev.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  const tab = prev.tabs[idx];
  const nextTabs = prev.tabs.filter((t) => t.id !== tabId);
  let nextActiveId = prev.activeTabId;
  if (tabId === prev.activeTabId) {
    nextActiveId = nextTabs[idx]?.id ?? nextTabs[idx - 1]?.id ?? null;
  }

  // 先调 close interceptor / plugin onBeforeClose,后改 cache + IPC。
  // 在 cache 改之前调,plugin 拿到的还是 closing tab 的稳定状态。
  const plugin = getTabKind(tab.kind);
  if (!opts.skipBeforeClose) {
    const interceptor = closeInterceptors.get(tabId);
    if (interceptor) {
      try {
        const shouldContinue = await interceptor();
        if (shouldContinue === false) return;
      } catch (err) {
        log.warn('tab close interceptor failed (vetoed)', { sessionId, tabId, kind: tab.kind, err });
        return;
      }
    }
    if (plugin?.onBeforeClose) {
      try {
        const shouldContinue = await plugin.onBeforeClose(tab.state, { tabId, sessionId });
        if (shouldContinue === false) return;
      } catch (err) {
        log.warn('plugin onBeforeClose failed (ignored)', { sessionId, tabId, kind: tab.kind, err });
      }
    }
  }

  setBucket(sessionId, { tabs: nextTabs, activeTabId: nextActiveId });
  try {
    const ipc = ipcApi();
    if (ipc && shouldPersist(sessionId)) {
      await ipc.close({ id: tabId });
      if (nextActiveId !== prev.activeTabId) {
        await ipc.setActive({ sessionId, id: nextActiveId });
      }
    }
  } catch (err) {
    log.error('closeTab IPC failed; rolling back cache', { sessionId, tabId, err });
    setBucket(sessionId, { tabs: prev.tabs, activeTabId: prev.activeTabId });
    throw err;
  }
}

/** 关闭某个 session bucket 的全部 tab,逐个走 closeTab 以触发 plugin cleanup。 */
export async function closeAllTabs(sessionId: string): Promise<void> {
  const tabIds = getBucket(sessionId).tabs.map((t) => t.id);
  for (const tabId of tabIds) {
    await closeTab(sessionId, tabId);
  }
}

/** 切换激活 tab —— 同 id 即 noop。失败回滚。 */
export async function setActiveTab(
  sessionId: string,
  tabId: string | null,
): Promise<void> {
  const prev = getBucket(sessionId);
  if (tabId === prev.activeTabId) return;
  setBucket(sessionId, { activeTabId: tabId });
  try {
    const ipc = ipcApi();
    if (ipc && shouldPersist(sessionId)) await ipc.setActive({ sessionId, id: tabId });
  } catch (err) {
    if (isMissingSessionPersistenceError(err)) {
      markMemoryOnlySession(sessionId);
      return;
    }
    log.error('setActiveTab IPC failed; rolling back cache', { sessionId, tabId, err });
    setBucket(sessionId, { activeTabId: prev.activeTabId });
    throw err;
  }
}

/** patch 单个 tab 的 state(plugin 改 URL / 文件选中等用)。失败回滚。 */
export async function patchTabState(
  sessionId: string,
  tabId: string,
  patch: (current: unknown) => unknown,
): Promise<void> {
  const prev = getBucket(sessionId);
  const idx = prev.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  const oldTab = prev.tabs[idx];
  const newState = patch(oldTab.state);
  if (!shouldPersist(sessionId)) {
    validateMemoryOnlyStateSize(newState);
  }
  const nextTabs = [...prev.tabs];
  nextTabs[idx] = { ...oldTab, state: newState };
  setBucket(sessionId, { tabs: nextTabs });
  try {
    const ipc = ipcApi();
    if (ipc && shouldPersist(sessionId)) {
      await ipc.upsert({
        id: tabId,
        sessionId,
        kind: oldTab.kind,
        position: idx,
        state: newState,
      });
    }
  } catch (err) {
    if (isMissingSessionPersistenceError(err)) {
      markMemoryOnlySession(sessionId);
      return;
    }
    log.error('patchTabState IPC failed; rolling back cache', { sessionId, tabId, err });
    setBucket(sessionId, { tabs: prev.tabs });
    throw err;
  }
}

/** 重排序 tab,orderedIds 必须包含 same session 当前**全部** tab id。失败回滚。 */
export async function reorderTabs(
  sessionId: string,
  orderedIds: string[],
): Promise<void> {
  const prev = getBucket(sessionId);
  if (orderedIds.length !== prev.tabs.length) return;
  const map = new Map(prev.tabs.map((t) => [t.id, t]));
  const nextTabs: TabState[] = [];
  for (const id of orderedIds) {
    const t = map.get(id);
    if (!t) return; // id 不在当前列表 —— 放弃 reorder
    nextTabs.push(t);
  }
  setBucket(sessionId, { tabs: nextTabs });
  try {
    const ipc = ipcApi();
    if (ipc && shouldPersist(sessionId)) await ipc.reorder({ sessionId, orderedIds });
  } catch (err) {
    if (isMissingSessionPersistenceError(err)) {
      markMemoryOnlySession(sessionId);
      return;
    }
    log.error('reorderTabs IPC failed; rolling back cache', { sessionId, err });
    setBucket(sessionId, { tabs: prev.tabs });
    throw err;
  }
}

/**
 * 失效全部 session 桶缓存(保留 memoryOnlySessions 标记 —— 那是"该会话可否持久化"
 * 的事实,不随缓存失效而变)。侧边栏宿主窗口切换(内嵌 ↔ 独立子窗口)时调用:
 * 另一个 renderer 接管期间本 renderer 的缓存必然过期,下次 ensureHydrated 重新
 * 走 IPC list 拉真相。notify 所有已缓存的 sessionId,让挂着的 useSyncExternalStore
 * 立刻看到 EMPTY_BUCKET(hydrated:false)并触发重拉。
 */
export function invalidateSessionCaches(): void {
  const sessionIds = [...cache.keys()];
  cache.clear();
  inflight.clear();
  for (const sessionId of sessionIds) notify(sessionId);
}

/** 订阅任意 sessionId 的桶变化;listener 自行根据 sessionId 过滤。 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试 / 登出清理。 */
export function _resetStore(): void {
  cache.clear();
  inflight.clear();
  memoryOnlySessions.clear();
  closeInterceptors.clear();
  listeners.clear();
}
