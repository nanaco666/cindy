/**
 * sessionModelMemory —— 已创建会话内的「(agent, 来源/provider, model) → effort/fast」记忆,
 * 按 sessionId **完全隔离**、**仅运行期**(模块级 Map,不持久化,app 重启即清空)。
 *
 * 与 providerModelMemory 的关系(为什么要单独一份):
 *   - providerModelMemory 是**草稿(New Maker)专属**的跨会话持久记忆:草稿页里为某供应商
 *     模型配置过的 effort/fast,下次新建会话选到它时恢复。
 *   - 本 store 是**会话专属**的运行期记忆:会话创建后,用户在该会话里对【非当前选中】模型
 *     预设 effort/fast(经 ModelSelector 的 Edit),或在会话内切模型/来源时恢复该模型在
 *     **本会话**里上次用过的 effort/fast。每个 session 各记各的,绝不互相影响、也绝不写回
 *     草稿记忆 —— 这正是「草稿默认值被会话内修改污染」那个 bug 的隔离边界。
 *
 * 谁读谁写:仅 ChatInput 在 session 上下文(传入 sessionId、非 device-link)下,把本 store 的
 *   get/set 包成 modelMemory 注入 ModelSelector;草稿上下文注入的是 providerModelMemory。
 *
 * copy-on-create 种子(seedSession):从草稿创建会话时,NewMakerDraftRoute 把草稿
 *   (providerModelMemory)当前状态整体快照种进新会话 —— 使新会话里**所有**供应商模型的
 *   effort/fast 默认等于草稿当时的值。种完之后会话内的编辑只动这份拷贝,与草稿、与其它
 *   会话彻底隔离。当前选中模型的 effort/fast 另由会话 DB 持有(种子只决定**非选中**行的默认)。
 *
 * 为什么不持久化(产品决策,2026-06):当前**选中**模型的 effort/fast 已由会话 DB
 *   (sessions.model/effort/fastMode + initialEffort/fastMode props)持久化,跨重启不丢;
 *   非选中模型的预设只是会话内的便捷记忆,重启后回落模型默认即可,不值得引入按 sessionId
 *   膨胀的 localStorage + 删除会话时的清理负担。
 *
 * device-link 已创建会话现在也复用本 store(2026-06:与本地会话同口径)—— 非选中模型的 effort/fast
 *   预设记在控制端、按远程会话的 sessionId 隔离;用户选中该模型时由 ChatInput 经隧道把 effort/fast
 *   推给被控端(被控端仍是当前状态的权威)。仅 device-link **草稿**(无 sessionId)不参与:草稿期能力
 *   以被控端为准、不读本机记忆,由 ChatInput 把 modelMemory 置 undefined。
 */

import { useSyncExternalStore } from 'react';

import type { AgentKind } from '@/hooks/useAgentCapabilities';
import type { Effort } from '@/lib/userPreferences.types';

/** 单个 (agent, 来源) 槽:该会话下每个模型各自的 effort / fast。 */
interface Slot {
  effortByModel: Record<string, Effort>;
  fastByModel: Record<string, boolean>;
}

// sessionId → (`${agent}:${providerId}` → Slot)。模块级、进程内、不落盘。
const store = new Map<string, Map<string, Slot>>();

// 变更通知(供 ModelSelector / ChatInput 在 device-link 远程 push 改本 store 时重渲染)。
// 本 store 是纯 Map、无内建响应式;set* 真正改值后 bump version + emit,订阅方据此重算行显示。
const listeners = new Set<() => void>();
let version = 0;
function emit(): void {
  version++;
  for (const l of listeners) l();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function getVersion(): number {
  return version;
}
/** React hook —— 订阅本 store 的变更版本号,值变即触发重渲染(useSyncExternalStore)。 */
export function useSessionModelMemoryVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

function slotKey(agent: AgentKind, providerId: string): string {
  return `${agent}:${providerId}`;
}

/** 取(可选创建)某会话下某 (agent, 来源) 的槽。create=false 时不存在返回 undefined。 */
function getSlot(
  sessionId: string,
  agent: AgentKind,
  providerId: string,
  create: boolean,
): Slot | undefined {
  let byProvider = store.get(sessionId);
  if (!byProvider) {
    if (!create) return undefined;
    byProvider = new Map();
    store.set(sessionId, byProvider);
  }
  const k = slotKey(agent, providerId);
  let slot = byProvider.get(k);
  if (!slot && create) {
    slot = { effortByModel: {}, fastByModel: {} };
    byProvider.set(k, slot);
  }
  return slot;
}

/** 读某会话下 (agent, 来源, 模型) 记下的 effort;无记录返回 undefined。 */
export function getSessionModelEffort(
  sessionId: string,
  agent: AgentKind,
  providerId: string,
  model: string,
): Effort | undefined {
  if (!sessionId || !providerId || !model) return undefined;
  return getSlot(sessionId, agent, providerId, false)?.effortByModel[model];
}

/** 写某会话下 (agent, 来源, 模型) 的 effort(不影响同会话其它模型 / 其它会话 / 草稿记忆)。 */
export function setSessionModelEffort(
  sessionId: string,
  agent: AgentKind,
  providerId: string,
  model: string,
  effort: Effort,
): void {
  if (!sessionId || !providerId || !model || !effort) return;
  const slot = getSlot(sessionId, agent, providerId, true)!;
  if (slot.effortByModel[model] === effort) return; // 同值短路:不 emit / 不触发跨进程同步
  slot.effortByModel[model] = effort;
  emit();
}

/** 读某会话下 (agent, 来源, 模型) 记下的 fast;无记录返回 undefined。 */
export function getSessionModelFast(
  sessionId: string,
  agent: AgentKind,
  providerId: string,
  model: string,
): boolean | undefined {
  if (!sessionId || !providerId || !model) return undefined;
  return getSlot(sessionId, agent, providerId, false)?.fastByModel[model];
}

/** 写某会话下 (agent, 来源, 模型) 的 fast(不影响同会话其它模型 / 其它会话 / 草稿记忆)。 */
export function setSessionModelFast(
  sessionId: string,
  agent: AgentKind,
  providerId: string,
  model: string,
  enabled: boolean,
): void {
  if (!sessionId || !providerId || !model) return;
  const slot = getSlot(sessionId, agent, providerId, true)!;
  if (slot.fastByModel[model] === enabled) return; // 同值短路
  slot.fastByModel[model] = enabled;
  emit();
}

/**
 * copy-on-create:把草稿快照(providerModelMemory.snapshotForSeed())整体种进某会话,作为该会话
 * 里所有供应商模型 effort/fast 的初始默认。**仅当该 sessionId 尚无记忆时种**(防重复 / 防覆盖
 * 已有会话内编辑);snapshot 为空则不占坑直接返回。深拷贝,种进去的记忆与草稿物理隔离。
 * snapshot 形状(按 `${agent}:${providerId}` 槽 → {effortByModel, fastByModel})与 providerModelMemory
 * 对齐,结构化匹配,两个 store 不互相 import。
 */
export function seedSession(
  sessionId: string,
  snapshot: Record<string, { effortByModel: Record<string, Effort>; fastByModel: Record<string, boolean> }>,
): void {
  if (!sessionId || store.has(sessionId)) return;
  const entries = Object.entries(snapshot);
  if (entries.length === 0) return;
  const byProvider = new Map<string, Slot>();
  for (const [k, slot] of entries) {
    byProvider.set(k, {
      effortByModel: { ...slot.effortByModel },
      fastByModel: { ...slot.fastByModel },
    });
  }
  store.set(sessionId, byProvider);
  emit();
}

/**
 * 记忆作用域决策(纯函数,供 ChatInput 构建 modelMemory + 单测)。
 *   - 已创建会话(有 sessionId,本地或 device-link)→ 'session'(本 store,按 sessionId 隔离;
 *     device-link 会话的预设由 ChatInput 在选中时经隧道推给被控端,被控端仍是当前状态权威)
 *   - device-link 草稿(有 deviceLinkDeviceId、无 sessionId)→ 'none'(草稿期能力 / 记忆以被控端为准,不掺本机)
 *   - 本地草稿(无 sessionId)→ 'draft'(providerModelMemory,跨会话持久)
 */
export function pickMemoryScope(args: {
  sessionId?: string;
  deviceLinkDeviceId?: string | null;
}): 'session' | 'draft' | 'none' {
  // 有 sessionId(已创建会话)一律 'session' —— 本地与 device-link 同口径(后者预设在选中时经隧道
  // 推给被控端,见 ChatInput.handleProviderChange 远程分支)。仅草稿期(无 sessionId)分流:
  // device-link 草稿退到 'none'(不掺本机),本地草稿退到 'draft'(providerModelMemory 持久)。
  if (args.sessionId) return 'session';
  return args.deviceLinkDeviceId ? 'none' : 'draft';
}

/** 测试用 —— 清空整个进程内 store(其它代码不应调用)。 */
export function __resetForTest(): void {
  store.clear();
  emit();
}
