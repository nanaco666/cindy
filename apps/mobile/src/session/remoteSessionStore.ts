import { useEffect, useRef, useSyncExternalStore } from 'react';
import { SESSION_ACTIVITY_CHANNEL, type SessionActivityPayload } from '@lizi/device-link';
import {
  applyAgentTaskUpdateEvent,
  isSameAgentTaskAlias,
  normalizeAgentTaskUpdate,
  type AgentTaskUpdate,
} from '@lizi/maker-shared/agent-task';
import type { MobileGoalStatusPayload } from '@lizi/maker-shared/device-link-contract';
import type { RemoteSessionLiveActivity } from '@lizi/maker-shared/session-list';
import { buildDeviceIdentity, resolveCanonicalDeviceId } from '@lizi/maker-shared/mobile-home';
import { EMPTY_INPUT_PROJECTION, normalizeInputProjection } from '@/session/inputProjection';
import { sortPendingInteractions } from '@/session/interactionModel';
import { applySessionModelPrefPush } from '@/session/sessionModelMirror';
import {
  createLatestWriteGuard,
  createPendingWriteTracker,
  createSessionWriteQueue,
} from '@/session/swipeRowRegistry';
import { cacheSessionMessages, getCachedSessionMessages } from '@/session/mobileSessionMessageCache';
import type { MobileSystemCardType } from '@/session/systemCard';
import type { InputProjection, PendingInteraction, RemoteMessage, RemoteSession } from '@/session/types';

interface DeviceShard {
  deviceId: string;
  deviceName: string;
  sessions: RemoteSession[];
}

/**
 * 会话元数据在途写登记(app 级单例):首页乐观写(置顶/归档/删除/重命名)begin 时
 * track、settle 时 release;`sessions:patched` push 应用前经 filterPatch 遮蔽在途
 * 字段,防止同字段旧写的 push 回流把本机更新的乐观意图滚回(review P2)。
 */
export const sessionPendingWrites = createPendingWriteTracker();

/**
 * 会话元数据写序守卫与出网队列(app 级单例):首页滑动操作与会话详情页菜单是同一组
 * 元数据写的两个入口,写序状态与同字段串行必须**跨页面共享**(review P1:首页置顶
 * 在退避中,进详情页取消置顶——组件实例级守卫感知不到对方,退避恢复后旧写覆盖新写)。
 */
export const sessionMetaWriteGuard = createLatestWriteGuard();
export const sessionMetaWriteQueue = createSessionWriteQueue();

export interface RemoteSessionRunStatus {
  isRunning: boolean;
  sideTaskRunning: boolean;
  startedAt: number | null;
  status: string;
  tokenUsage: number;
}

interface SessionMessageSyncMarker {
  messageCount: number | null;
  updatedAt: string;
}

const EMPTY_SESSION_RUN_STATUS: RemoteSessionRunStatus = Object.freeze({
  isRunning: false,
  sideTaskRunning: false,
  startedAt: null,
  status: '',
  tokenUsage: 0,
});

const shards = new Map<string, DeviceShard>();
const messages = new Map<string, RemoteMessage[]>();
const pendingInteractions = new Map<string, PendingInteraction[]>();
/**
 * 乐观 resolve 在途抑制集合:交互卡批准 / 拒绝已在本地乐观撤卡、被控端还没有
 * 确认的 requestId。这个窗口里权威流(全量快照 setPendingInteractions / push
 * 重放 applyInteractionRequest)可能把同一张卡重新灌回来造成「闪回」——凡在
 * 集合中的 request 一律过滤。失败复原时由 InteractionPanel 显式移除;成功时
 * 转入 confirmedInteractionDismissals 延长抑制(见下)。
 * key = `${sessionId}\u0000${requestId}`。
 */
const inFlightInteractionResolves = new Set<string>();
/**
 * 已确认 dismiss 的延长抑制集合:resolve 成功后**不能立即**解除过滤——在决定
 * 提交前发出、resolve 之后才返回的慢权威读取(syncSession 的 getPendingInteractions,
 * 弱网正是高发场景)仍持有含这张卡的旧快照,直接落地会闪回(codex review P2)。
 * 条目留到「一轮不含该 requestId 的全量快照」到达(被控端已确认移除,自然过期)
 * 才删除;interaction-dismissed push **不**提前回收——push 之后仍可能有更早发出
 * 的在途旧快照晚到(见 applyRemotePush 该分支注释)。
 */
const confirmedInteractionDismissals = new Set<string>();

function interactionResolveKey(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`;
}

function isInteractionResolveSuppressed(sessionId: string, item: PendingInteraction): boolean {
  const requestId = item.request.requestId;
  if (typeof requestId !== 'string' || requestId.length === 0) return false;
  const key = interactionResolveKey(sessionId, requestId);
  return inFlightInteractionResolves.has(key) || confirmedInteractionDismissals.has(key);
}
const inputProjections = new Map<string, InputProjection>();
const sessionLiveActivity = new Map<string, RemoteSessionLiveActivity>();
const sessionRunning = new Map<string, boolean>();
const sessionRunStatus = new Map<string, RemoteSessionRunStatus>();
const sessionMessageSyncMarkers = new Map<string, SessionMessageSyncMarker>();
// Per-session live sub-agent task state, decoded from `agent_task_update` events (live-only,
// never persisted — see @lizi/maker-shared/agent-task). Keyed taskId/parentToolUseId → update.
const sessionTaskUpdates = new Map<string, ReadonlyMap<string, AgentTaskUpdate>>();
// 目标模式状态镜像:null = 已确认无 goal(get-status 拉过 / push 清除);缺项 = 尚未拉取。
const sessionGoalStatus = new Map<string, MobileGoalStatusPayload | null>();
// maker `status` 事件驱动的权威 turn 边界(与 sessionRunning 分开):sessionRunning 还会被
// activity 推送 / 活跃快照置 true,重连或 activity 先到时会污染 false→true 的 turn-start 检测,
// 导致 stale taskUpdates 清理被跳过。孤儿 agent_task 卡的渲染 gate 与 turn-start 清理都只认
// 这份边界,构成闭环:孤儿只在 maker turn 运行中渲染,而 maker turn start 必然先清 stale。
const sessionMakerTurnRunning = new Map<string, boolean>();
const sessionDeviceIndex = new Map<string, string>();
// 已收到 error-persisted 脏信号且缓存消息仍在的会话集合。session 页面监听此 Set,
// 检测到自身 sessionId 被加入时调 load() 触发整窗刷新(含 error 行),避免先清空导致空白帧。
const pendingRefreshSessions = new Set<string>();
const reseedHandlers = new Map<string, Set<() => void>>();
const subs = new Set<() => void>();
const emptyMessages: RemoteMessage[] = [];
const emptyPendingInteractions: PendingInteraction[] = [];
const EMPTY_TASK_UPDATES: ReadonlyMap<string, AgentTaskUpdate> = new Map();

let mergedSessions: RemoteSession[] = [];
let messageVersion = 0;
let storeVersion = 0;
// 当前权威设备列表(由首页从设备列表 API reconcile 后注入)。每次重算会话时基于它 + 当前 shards(stale 侧)
// 重建身份索引,用于给会话算展示用 canonicalDeviceId(把 re-link 后残留 stale shard 认领回当前设备);
// 为 null 时不归一,安全退化。
let deviceList: readonly { deviceId: string; name: string }[] | null = null;

function emit(): void {
  storeVersion += 1;
  for (const sub of subs) sub();
}

function recomputeSessions(): void {
  sessionDeviceIndex.clear();
  // 跨 shard 去重 + 设备身份归一化。re-link 后同一 session.id 可能同时存在于 stale / current 两个 shard;
  // 保留「物理 deviceId 是当前已知设备」的那条(current shard 优先,它路由正确且是真身),都不是已知设备
  // 时保留先遇到的。canonicalDeviceId 写展示用规范 id(认领回当前设备),deviceLinkDeviceId 保物理不动。
  // sessionDeviceIndex 记保留条的物理 shard —— applySessionPatch / 活动推送按真实来源设备路由。
  // 每次重算都基于当前设备列表 + 当前 shards(stale 侧)重建身份索引:认领要求当前设备侧名字唯一 + stale 侧
  // 同名也唯一(避免把两台同名旧机并到一台当前设备),placeholder 名(unknown / no)不参与匹配。
  const identity = deviceList
    ? buildDeviceIdentity(deviceList, [...shards.values()].map((s) => ({ deviceId: s.deviceId, name: s.deviceName })))
    : null;
  const byId = new Map<string, { session: RemoteSession; physicalDeviceId: string; known: boolean }>();
  for (const shard of shards.values()) {
    const canonicalDeviceId = identity
      ? resolveCanonicalDeviceId(shard.deviceId, shard.deviceName, identity) ?? shard.deviceId
      : shard.deviceId;
    const known = identity ? identity.knownDeviceIds.has(shard.deviceId) : false;
    for (const session of shard.sessions) {
      const existing = byId.get(session.id);
      // 已有记录时,只有「当前 shard 已知、而已存条来自未知 shard」才覆盖(current 顶掉 stale);否则保留先到。
      if (existing && !(known && !existing.known)) continue;
      byId.set(session.id, {
        session: session.canonicalDeviceId === canonicalDeviceId ? session : { ...session, canonicalDeviceId },
        physicalDeviceId: shard.deviceId,
        known,
      });
    }
  }
  const next: RemoteSession[] = [];
  for (const { session, physicalDeviceId } of byId.values()) {
    next.push(session);
    sessionDeviceIndex.set(session.id, physicalDeviceId);
  }
  for (const sessionId of [...sessionLiveActivity.keys()]) {
    if (!sessionDeviceIndex.has(sessionId)) sessionLiveActivity.delete(sessionId);
  }
  mergedSessions = next;
  emit();
}

function stamp(session: RemoteSession, deviceId: string, deviceName: string): RemoteSession {
  return { ...session, deviceLinkDeviceId: deviceId, deviceLinkDeviceName: deviceName };
}

function normalizeMessages(list: readonly RemoteMessage[]): RemoteMessage[] {
  return [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function messageKey(message: RemoteMessage): string {
  return message.id || message.clientId || `${message.role}:${message.createdAt}`;
}

/**
 * 同 key 消息合并时优先保留内容完整的一侧:被控端结果帧超限会把历史行内容截成
 * 占位串并打 agentMeta.remoteContentTruncated 标记(device-link dispatch),这种
 * 截断行不能覆盖已通过实时 push 拿到的完整内容;反向(完整行到达)照常覆盖。
 */
function preferCompleteMessage(existing: RemoteMessage | undefined, incoming: RemoteMessage): RemoteMessage {
  if (!existing) return incoming;
  const incomingTruncated = incoming.agentMeta?.remoteContentTruncated === true;
  const existingTruncated = existing.agentMeta?.remoteContentTruncated === true;
  return incomingTruncated && !existingTruncated ? existing : incoming;
}

function bumpMessageVersion(): void {
  messageVersion += 1;
}

// turn start 时暂存的 running codex collab worker 条目:map key → update。核心不变量是
// 「孤儿卡只渲染当前 maker turn 边界打开之后到达的 update(post-boundary evidence)」——
// 错过终态推送的 stale running 与活 worker 在数据上不可区分,任何按新鲜度/宽限的近似都
// 留有重放窗口。暂存条目不出现在 getSessionTaskUpdates(不渲染、inline 也不吃,inline 卡
// 状态由持久化的 tool_use/tool_result 自行推断);边界后收到同任务的新 update 即被召回参
// 与 merge(保住 title/description 等历史字段);到下一次 turn start 仍未被召回的直接丢弃
// (跨两个边界无任何存活证据)。live-only,随 removeDevice / clear 一起清。
const sessionParkedTaskUpdates = new Map<string, Map<string, AgentTaskUpdate>>();

// maker turn 边界 false→true 时的清扫:每个 turn 的 live task 状态从零开始。claude
// Task/Agent 子代理不跨 turn,残留即 stale,直接清;终态条目的 spawn tool_use / tool_result
// 已持久化,inline 渲染可接管,直接清;running codex collab worker(跑在独立会话、跨 turn
// 存活,update 推到主会话事件流——codex 的 agent_task_update 只由 collab:* 工具产生,见
// codex translator 的 handleCollabAgentToolCall)挪进暂存区等待 post-boundary 存活证据,
// 活 worker 的下一条 update 会立即召回它,卡片仅在边界到该条 update 之间短暂缺席。
function sweepStaleTaskUpdates(sessionId: string): boolean {
  // 上一轮暂存的条目到此作废:跨两个边界都没有等到任何新 update,判死。
  sessionParkedTaskUpdates.delete(sessionId);
  const map = sessionTaskUpdates.get(sessionId);
  if (!map || map.size === 0) return false;
  const parked = new Map<string, AgentTaskUpdate>();
  for (const [key, update] of map) {
    if (update.provider === 'codex' && update.status === 'running') parked.set(key, update);
  }
  if (parked.size > 0) sessionParkedTaskUpdates.set(sessionId, parked);
  sessionTaskUpdates.delete(sessionId);
  return true;
}

// 暂存召回:边界后到达的 update 是同任务仍存活的证据。把暂存里按 alias 匹配的历史条目
// 取回并入 prevMap,让 applyAgentTaskUpdateEvent 的 merge 吃到历史字段;未匹配的留在暂存。
function recallParkedTaskUpdates(
  sessionId: string,
  data: unknown,
  source: 'claude-code' | 'codex' | undefined,
  prevMap: ReadonlyMap<string, AgentTaskUpdate> | undefined,
): ReadonlyMap<string, AgentTaskUpdate> | undefined {
  const parkedMap = sessionParkedTaskUpdates.get(sessionId);
  if (!parkedMap || parkedMap.size === 0) return prevMap;
  const probe = normalizeAgentTaskUpdate(data, source);
  if (!probe) return prevMap;
  let recalled: Map<string, AgentTaskUpdate> | null = null;
  for (const [key, parked] of parkedMap) {
    if (!isSameAgentTaskAlias(parked, probe)) continue;
    if (!recalled) recalled = new Map(prevMap ?? []);
    recalled.set(key, parked);
    parkedMap.delete(key);
  }
  if (parkedMap.size === 0) sessionParkedTaskUpdates.delete(sessionId);
  return recalled ?? prevMap;
}

export const remoteSessionStore = {
  // 注入当前权威设备列表(首页从 /api/device-link/devices reconcile 后调用),用于设备身份归一化。
  // 仅在身份索引实际变化时重算,避免每次设备列表引用变动都刷新全部会话。
  setDeviceIdentity(devices: readonly { deviceId: string; name: string }[]): void {
    if (deviceListsEqual(deviceList, devices)) return;
    deviceList = devices.map((d) => ({ deviceId: d.deviceId, name: d.name }));
    recomputeSessions();
  },

  setDeviceSessions(deviceId: string, deviceName: string, rawSessions: readonly RemoteSession[]): void {
    let nextSessions = rawSessions.map((s) => stamp(s, deviceId, deviceName));
    const existing = shards.get(deviceId);
    // 在途乐观创建行保护:pendingLocalCreation 行由 newSessionCreation 管线负责生命
    // 周期(enqueue 落定清标 / 失败撤行),全量列表对账不能越权处置——(a) 比被控端
    // 建成更早发出的旧列表不含该 id,直接替换会让刚进入的会话从列表消失;(b) 建成后
    // enqueue 落定前的新列表含该 id 但无标,直接替换会提前解开禁发通道。缓存 hydrate
    // 白名单不含此标(mobileHomeListCache.coerceCachedSession),标只存在于本进程内存,
    // 不会出现「无管线接管的孤儿标」。
    const pendingRows = existing?.sessions.filter((s) => s.pendingLocalCreation === true) ?? [];
    if (pendingRows.length > 0) {
      const pendingIds = new Set(pendingRows.map((s) => s.id));
      const nextIds = new Set(nextSessions.map((s) => s.id));
      nextSessions = nextSessions.map((s) => (pendingIds.has(s.id) ? { ...s, pendingLocalCreation: true } : s));
      const missingRows = pendingRows.filter((s) => !nextIds.has(s.id));
      if (missingRows.length > 0) nextSessions = [...missingRows, ...nextSessions];
    }
    // 在途元数据写保护(review P1):重连触发的全量对账 / reseed 拉到的可能是被控端
    // 尚未处理本机写的旧快照,整表替换不得冲掉乐观意图——
    //  - 行仍在本地:在途字段用本地当前值覆盖快照值(其余字段照常吃快照);
    //  - 行已被本地乐观移出(归档/删除在途):不随旧快照复活,终态由该写的结局负责
    //    (失败回滚 upsert 插回 + reseed;成功后新快照自然无此行)。
    nextSessions = nextSessions.flatMap((s) => {
      const pendingFields = sessionPendingWrites.pendingFields(s.id);
      if (pendingFields.length === 0) return [s];
      const local = existing?.sessions.find((row) => row.id === s.id);
      if (!local) return [];
      const overlay: Record<string, unknown> = {};
      for (const field of pendingFields) {
        const localValue = (local as unknown as Record<string, unknown>)[field];
        overlay[field] = localValue;
        // overlay 藏起的权威快照值与 push 遮蔽同样可能是外部并发更新:差异留痕,
        // 由对应写的结局 consume 后 reseed 收敛(review P2)。
        sessionPendingWrites.noteMaskedValue(
          s.id,
          field,
          (s as unknown as Record<string, unknown>)[field],
          localValue,
        );
      }
      return [{ ...s, ...overlay } as RemoteSession];
    });
    // 对称保护(review P2):restore 在途把行乐观加回了当前列表,旧快照(被控端未
    // 处理该写)不含它——status 在途且本地有行、快照缺失时保留本地行,终态由该写
    // 的结局负责(成功后新快照自然包含;失败回滚还原 status,applySessionPatch 会
    // 把行移出)。其它字段在途的缺失行照常吃快照删除(外部删除是权威)。
    {
      const snapshotIds = new Set(nextSessions.map((s) => s.id));
      const pendingStatusRows = (existing?.sessions ?? []).filter((row) =>
        !snapshotIds.has(row.id) && sessionPendingWrites.pendingFields(row.id).includes('status'));
      if (pendingStatusRows.length > 0) nextSessions = [...pendingStatusRows, ...nextSessions];
    }
    if (
      existing
      && existing.deviceName === deviceName
      && remoteSessionListsEqual(existing.sessions, nextSessions)
    ) {
      return;
    }
    shards.set(deviceId, { deviceId, deviceName, sessions: nextSessions });
    recomputeSessions();
  },

  // 冷启动乐观 hydrate:仅当该设备 shard 尚不存在时,用本地首页快照缓存种入(先画缓存)。
  // 「if absent」是关键不变量——fresh loadHome 数据若已先到则绝不覆盖;fresh 之后到会走
  // setDeviceSessions 正常对账替换。与 hydrateMessagesIfEmpty 同一套语义,只作用于会话 shard。
  hydrateDeviceSessionsIfEmpty(deviceId: string, deviceName: string, rawSessions: readonly RemoteSession[]): void {
    if (!deviceId || rawSessions.length === 0 || shards.has(deviceId)) return;
    shards.set(deviceId, {
      deviceId,
      deviceName,
      // cacheSeeded 打标:缓存行字段经瘦身/截断(240 字符),只能撑首屏渲染与跳转,
      // 不能作为发送参数;会话页据此在 fresh 元数据到达前禁发(codex review R15)。
      // fresh 路径(setDeviceSessions / upsertDeviceSession)用服务器新对象,天然无标自净。
      sessions: rawSessions.map((s) => stamp({ ...s, cacheSeeded: true }, deviceId, deviceName)),
    });
    recomputeSessions();
  },

  upsertDeviceSession(deviceId: string, deviceName: string, rawSession: RemoteSession): void {
    const stamped = stamp(rawSession, deviceId, deviceName);
    const shard = shards.get(deviceId);
    if (!shard) {
      shards.set(deviceId, { deviceId, deviceName, sessions: [stamped] });
      recomputeSessions();
      return;
    }
    const next = shard.sessions.filter((s) => s.id !== rawSession.id);
    const existing = shard.sessions.find((s) => s.id === rawSession.id);
    if (
      existing
      && shard.deviceName === deviceName
      && remoteSessionEqual(existing, stamped)
      && shard.sessions[0]?.id === rawSession.id
    ) {
      return;
    }
    shard.deviceName = deviceName;
    shard.sessions = [stamped, ...next];
    recomputeSessions();
  },

  renameDevice(deviceId: string, deviceName: string): void {
    const shard = shards.get(deviceId);
    if (!shard || shard.deviceName === deviceName) return;
    shard.deviceName = deviceName;
    shard.sessions = shard.sessions.map((session) => stamp(session, deviceId, deviceName));
    recomputeSessions();
  },

  applySessionPatch(deviceId: string, sessionId: string, patch: Partial<RemoteSession>): void {
    const shard = shards.get(deviceId);
    if (!shard) {
      if (patch.status === 'active') reseedHandlers.get(deviceId)?.forEach((handler) => handler());
      return;
    }
    const idx = shard.sessions.findIndex((s) => s.id === sessionId);
    if (idx === -1) {
      if (patch.status === 'active') reseedHandlers.get(deviceId)?.forEach((handler) => handler());
      return;
    }
    let shouldReseedAfterPatch = false;
    if (patch.status === 'deleted' || patch.status === 'archived') {
      shard.sessions = shard.sessions.filter((s) => s.id !== sessionId);
      sessionLiveActivity.delete(sessionId);
    } else {
      const wasPinned = shard.sessions[idx].pinnedAt != null;
      const unpinned = Object.prototype.hasOwnProperty.call(patch, 'pinnedAt') && patch.pinnedAt == null;
      const patched = { ...shard.sessions[idx], ...patch } as RemoteSession;
      if (remoteSessionEqual(shard.sessions[idx], patched)) return;
      shard.sessions = shard.sessions.map((s) => (s.id === sessionId ? patched : s));
      shouldReseedAfterPatch = wasPinned && unpinned;
    }
    recomputeSessions();
    if (shouldReseedAfterPatch) this.requestReseed(deviceId);
  },

  setMessages(sessionId: string, list: readonly RemoteMessage[]): void {
    const next = normalizeMessages(list);
    if (remoteMessageListsEqual(messages.get(sessionId) ?? emptyMessages, next)) return;
    messages.set(sessionId, next);
    bumpMessageVersion();
    emit();
  },

  // 乐观 hydrate:仅当该会话当前还没有任何消息时,用本地缓存(冷开预览)种入。
  // 「if empty」是关键不变量——fresh 数据若已先到则不覆盖;fresh 之后到也会按 messageKey 对账替换。
  hydrateMessagesIfEmpty(sessionId: string, list: readonly RemoteMessage[]): void {
    if ((messages.get(sessionId)?.length ?? 0) > 0) return;
    const next = normalizeMessages(list);
    if (next.length === 0) return;
    messages.set(sessionId, next);
    bumpMessageVersion();
    emit();
  },

  setLatestMessageWindow(sessionId: string, list: readonly RemoteMessage[]): void {
    const latestWindow = normalizeMessages(list);
    if (latestWindow.length === 0) {
      this.setMessages(sessionId, []);
      return;
    }

    const existing = messages.get(sessionId) ?? [];
    const latestKeys = new Set(latestWindow.map(messageKey));
    const latestOldestCreatedAt = latestWindow[0].createdAt;
    const latestNewestCreatedAt = latestWindow[latestWindow.length - 1].createdAt;
    const hasOverlap = existing.some((item) => latestKeys.has(messageKey(item)));
    const byKey = new Map<string, RemoteMessage>();
    // 截断保护的比较基准必须覆盖全部 existing 行:下面的循环只把窗口外(更新/更旧)
    // 的行 seed 进 byKey,窗口内重叠的完整行若不在基准里,payload 超限的窗口刷新
    // (remoteContentTruncated)会拿 undefined 比较而照样覆盖它们。
    const existingByKey = new Map(existing.map((item) => [messageKey(item), item] as const));

    // A latest-page sync is authoritative for the tail of the conversation.
    // Only keep older cached pages when they overlap that page; otherwise stale
    // old windows can be rendered as if they were adjacent to fresh pushes.
    for (const item of existing) {
      const createdAt = item.createdAt;
      const isNewerThanLatestPage = createdAt.localeCompare(latestNewestCreatedAt) >= 0;
      const isOlderLoadedPage = hasOverlap && createdAt.localeCompare(latestOldestCreatedAt) < 0;
      if (isNewerThanLatestPage || isOlderLoadedPage) {
        byKey.set(messageKey(item), item);
      }
    }
    for (const item of latestWindow) {
      const key = messageKey(item);
      byKey.set(key, preferCompleteMessage(byKey.get(key) ?? existingByKey.get(key), item));
    }

    const next = normalizeMessages([...byKey.values()]);
    if (remoteMessageListsEqual(existing, next)) return;
    messages.set(sessionId, next);
    bumpMessageVersion();
    emit();
  },

  markSessionMessagesSynced(sessionId: string, session: Pick<RemoteSession, '_count' | 'updatedAt'>): void {
    if (!sessionId) return;
    sessionMessageSyncMarkers.set(sessionId, buildSessionMessageSyncMarker(session));
  },

  isSessionMessageWindowSynced(sessionId: string, session: Pick<RemoteSession, '_count' | 'updatedAt'>): boolean {
    const marker = sessionMessageSyncMarkers.get(sessionId);
    if (!marker) return false;
    return sessionMessageSyncMarkersEqual(marker, buildSessionMessageSyncMarker(session));
  },

  /** session 页面检测自身是否需要整窗刷新(收到 error-persisted 但消息未被清空)。 */
  hasPendingRefresh(sessionId: string): boolean {
    return pendingRefreshSessions.has(sessionId);
  },

  /** 消费 pending refresh 标记,返回 true 表示确实有待刷新,由调用方触发 load()。 */
  consumePendingRefresh(sessionId: string): boolean {
    if (!pendingRefreshSessions.has(sessionId)) return false;
    pendingRefreshSessions.delete(sessionId);
    return true;
  },

  mergeMessages(sessionId: string, list: readonly RemoteMessage[]): void {
    const byKey = new Map<string, RemoteMessage>();
    for (const item of messages.get(sessionId) ?? []) {
      byKey.set(messageKey(item), item);
    }
    for (const item of list) {
      const key = messageKey(item);
      byKey.set(key, preferCompleteMessage(byKey.get(key), item));
    }
    const next = normalizeMessages([...byKey.values()]);
    if (remoteMessageListsEqual(messages.get(sessionId) ?? emptyMessages, next)) return;
    messages.set(sessionId, next);
    bumpMessageVersion();
    emit();
  },

  appendMessage(sessionId: string, message: RemoteMessage): void {
    const existing = messages.get(sessionId) ?? [];
    if (existing.some((m) => (message.id && m.id === message.id) || (message.clientId && m.clientId === message.clientId))) return;
    messages.set(sessionId, normalizeMessages([...existing, message]));
    bumpMessageVersion();
    emit();
  },

  appendLocalSystemCard(
    sessionId: string,
    cardType: MobileSystemCardType,
    data: Record<string, unknown> = {},
    createdAt = new Date(),
  ): string {
    const clientId = `mobile-system-${cardType}-${createdAt.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
    this.appendMessage(sessionId, {
      id: clientId,
      clientId,
      sessionId,
      role: 'system',
      content: '',
      toolUseId: null,
      agentMeta: null,
      createdAt: createdAt.toISOString(),
      systemCardType: cardType,
      systemCardData: data,
    });
    return clientId;
  },

  patchMessageAgentMeta(sessionId: string, clientId: string, patch: Record<string, unknown>): void {
    const existing = messages.get(sessionId);
    if (!existing) return;
    let changed = false;
    const next = existing.map((message) => {
      if (message.clientId !== clientId && message.id !== clientId) return message;
      changed = true;
      return { ...message, agentMeta: { ...(message.agentMeta ?? {}), ...patch } };
    });
    if (!changed) return;
    messages.set(sessionId, next);
    emit();
  },

  setPendingInteractions(sessionId: string, list: readonly PendingInteraction[]): void {
    // 已确认 dismiss 的延长抑制条目按「缺席即过期」回收:本轮快照不含该
    // requestId = 被控端已确认移除,慢的旧快照此后不可能再带着它(权威读取按
    // 请求序返回),条目可以安全解除;仍含 = 这是 resolve 前发出的旧快照,保留
    // 抑制继续过滤(codex review P2「早发晚到」闪回)。
    const sessionPrefix = interactionResolveKey(sessionId, '');
    const presentIds = new Set(list
      .map((item) => item.request.requestId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0));
    for (const key of [...confirmedInteractionDismissals]) {
      if (!key.startsWith(sessionPrefix)) continue;
      if (!presentIds.has(key.slice(sessionPrefix.length))) confirmedInteractionDismissals.delete(key);
    }
    // 全量快照也要过在途抑制:决定已乐观提交、被控端还没确认时,快照仍会带着
    // 这张卡,不过滤就闪回。
    const next = dedupeInteractions(list.filter((item) => !isInteractionResolveSuppressed(sessionId, item)));
    if (deepValueEqual(pendingInteractions.get(sessionId) ?? emptyPendingInteractions, next)) return;
    pendingInteractions.set(sessionId, next);
    emit();
  },

  setInputProjection(sessionId: string, projection: unknown): void {
    const next = normalizeInputProjection(projection, sessionId);
    if (deepValueEqual(inputProjections.get(sessionId) ?? EMPTY_INPUT_PROJECTION, next)) return;
    inputProjections.set(sessionId, next);
    emit();
  },

  setSessionRunning(sessionId: string, running: boolean): void {
    if (!sessionId) return;
    // 本方法只被 maker 权威信号调用(done / terminal error / status-changed closed),
    // 与 maker turn 边界同步;activity / 快照流走 writeSessionRunStatus,不经过这里。
    // 边界变化必须独立参与 emit 判定:activity 流可能已把宽 run status 置 false,此时
    // writeSessionRunStatus 无变化,若不 emit,useSessionMakerTurnRunning 的订阅者会卡旧值。
    const turnBoundaryChanged = writeMakerTurnRunning(sessionId, running);
    const current = readSessionRunStatus(sessionId);
    const next: RemoteSessionRunStatus = {
      ...current,
      isRunning: running,
      sideTaskRunning: running ? current.sideTaskRunning : false,
      startedAt: running ? (current.startedAt ?? Date.now()) : null,
    };
    if (writeSessionRunStatus(sessionId, next) || turnBoundaryChanged) emit();
  },

  setActiveSessionSnapshots(deviceId: string, list: readonly unknown[]): void {
    const nextRunning = new Map<string, boolean>();
    for (const item of list) {
      if (!isRecord(item)) continue;
      const sessionId = readString(item, 'sessionId');
      if (sessionId && item.isTurnRunning === true) nextRunning.set(sessionId, true);
    }
    const scopedRunning = new Map<string, boolean>();
    for (const [sessionId, running] of sessionRunning) {
      if (sessionDeviceIndex.get(sessionId) !== deviceId) scopedRunning.set(sessionId, running);
    }
    for (const [sessionId, running] of nextRunning) {
      if (running) scopedRunning.set(sessionId, true);
    }
    if (runningMapsEqual(sessionRunning, scopedRunning)) return;
    let changed = false;
    const sessionIds = new Set([...sessionRunning.keys(), ...scopedRunning.keys()]);
    for (const sessionId of sessionIds) {
      const running = scopedRunning.get(sessionId) === true;
      // 权威快照报 idle 时同步关闭 maker turn 边界(只关不开):后台/断连错过终态事件后,
      // 边界会卡在 true、孤儿渲染 gate 常开;打开边界仍只归 maker status(打开必先 sweep)。
      if (!running) changed = writeMakerTurnRunning(sessionId, false) || changed;
      const current = readSessionRunStatus(sessionId);
      const next: RemoteSessionRunStatus = {
        ...current,
        isRunning: running,
        sideTaskRunning: running ? current.sideTaskRunning : false,
        startedAt: running ? (current.startedAt ?? Date.now()) : null,
      };
      changed = writeSessionRunStatus(sessionId, next) || changed;
    }
    if (changed) emit();
  },

  applyInteractionRequest(sessionId: string, item: PendingInteraction): void {
    // push 重放 / reseed 在乐观提交窗口内不得复活这张卡(见 inFlightInteractionResolves)。
    if (isInteractionResolveSuppressed(sessionId, item)) return;
    const existing = pendingInteractions.get(sessionId) ?? [];
    const next = dedupeInteractions([...existing, item]);
    if (deepValueEqual(existing, next)) return;
    pendingInteractions.set(sessionId, next);
    emit();
  },

  dismissInteraction(sessionId: string, requestId: string): void {
    const existing = pendingInteractions.get(sessionId) ?? [];
    const next = existing.filter((i) => i.request.requestId !== requestId);
    if (next.length === existing.length) return;
    pendingInteractions.set(sessionId, next);
    emit();
  },

  /**
   * 交互卡乐观 dismiss(批准 / 拒绝点击即撤卡):撤卡 + 登记在途抑制,让权威流
   * 在被控端确认前无法把同一张卡灌回来。结果落定后必须调 settleOptimistic-
   * InteractionDismiss 收口,否则该 requestId 的卡被永久抑制。
   */
  beginOptimisticInteractionDismiss(sessionId: string, requestId: string): void {
    if (!requestId) return;
    inFlightInteractionResolves.add(interactionResolveKey(sessionId, requestId));
    this.dismissInteraction(sessionId, requestId);
  },

  /**
   * 乐观 dismiss 收口:失败(restore)解除抑制并把原卡复原回面板供重试;成功
   * (confirmed)**不立即解除**——转入延长抑制集合,挡「resolve 前发出、resolve
   * 后才返回」的慢权威快照(否则旧快照会把已解决的卡灌回面板闪回),条目仅由
   * setPendingInteractions 的「缺席即过期」回收。
   */
  settleOptimisticInteractionDismiss(
    sessionId: string,
    requestId: string,
    outcome: { kind: 'confirmed' } | { kind: 'restore'; item: PendingInteraction },
  ): void {
    const key = interactionResolveKey(sessionId, requestId);
    inFlightInteractionResolves.delete(key);
    if (outcome.kind === 'restore') {
      this.applyInteractionRequest(sessionId, outcome.item);
    } else {
      confirmedInteractionDismissals.add(key);
    }
  },

  applyRemotePush(deviceId: string, channel: string, payload: unknown): void {
    if (channel === SESSION_ACTIVITY_CHANNEL) {
      this.applySessionActivity(deviceId, payload);
      return;
    }
    if (channel === 'local-db:sessions:created') {
      reseedHandlers.get(deviceId)?.forEach((handler) => handler());
      return;
    }
    if (channel === 'maker:session-model-pref:changed') {
      // 被控端会话「非选中模型」effort/fast 变更(被控端本地改 / 应用了任一控制端写穿)→
      // 刷新会话模型列表镜像(payload 自带 sessionId,镜像按会话隔离,非法 payload 静默忽略)。
      applySessionModelPrefPush(payload);
      return;
    }
    if (channel === 'local-db:sessions:patched' && isRecord(payload)) {
      const sessionId = readString(payload, 'sessionId');
      const patch = isRecord(payload.patch) ? payload.patch : null;
      if (sessionId && patch) {
        // 遮蔽本机在途写的字段:旧写的无差别 push 回流不得滚回更新的乐观意图,
        // 被遮字段的终态由对应写的对账 / 后续 push 收敛;全部被遮时跳过应用。
        // localRow 供差异留痕判定:本笔 echo push(同值)不留痕,避免每次成功写
        // 都误触发 reseed(review P2)。
        const localRow = shards.get(deviceId)?.sessions.find((s) => s.id === sessionId);
        const filtered = sessionPendingWrites.filterPatch(
          sessionId,
          patch,
          localRow as unknown as Record<string, unknown> | undefined,
        );
        if (Object.keys(filtered).length > 0) {
          this.applySessionPatch(deviceId, sessionId, filtered as Partial<RemoteSession>);
        }
      }
      return;
    }
    if (channel === 'local-db:messages:created' && isRecord(payload)) {
      const sessionId = readString(payload, 'sessionId');
      const message = isRecord(payload.message) ? (payload.message as unknown as RemoteMessage) : null;
      if (sessionId && message) this.appendMessage(sessionId, message);
      return;
    }
    if (channel === 'local-db:session:error-persisted' && isRecord(payload)) {
      const sessionId = readString(payload, 'sessionId');
      if (sessionId) {
        if (messages.has(sessionId)) {
          // 会话有缓存消息:保留消息(避免先清空导致空白帧),仅失效 sync marker + 标记待刷新。
          // session 页面监听到 pendingRefreshSessions 变化后调 load(),走 reopen 路径:
          // sync marker 已失效 → metaChanged=true → 拉最新消息窗口(含 error 行)整窗替换。
          sessionMessageSyncMarkers.delete(sessionId);
          pendingRefreshSessions.add(sessionId);
        } else {
          // 未缓存:清 sync marker + 标记待刷新。
          // 若 session 页面正在首次 listMessages(messages 尚未填充),需要 pendingRefreshSessions
          // 保证：即使那次 in-flight 请求的响应在 error 行写入之前发出（返回旧历史），
          // session 页面挂载/useSyncExternalStore 检测到 pending 后仍会重新调 load()，
          // 触发同步失效 → metaChanged=true → 整窗替换，error 卡正常浮现。
          messages.delete(sessionId);
          sessionMessageSyncMarkers.delete(sessionId);
          pendingRefreshSessions.add(sessionId);
        }
        bumpMessageVersion();
        emit();
      }
      return;
    }
    if (channel === 'maker:event' && isRecord(payload)) {
      const sessionId = readString(payload, 'sessionId');
      const event = isRecord(payload.event) ? payload.event : null;
      if (sessionId && event) this.applyMakerEvent(sessionId, event);
      return;
    }
    if (channel === 'maker:status-changed' && isRecord(payload)) {
      const sessionId = readString(payload, 'sessionId');
      const status = readString(payload, 'status');
      if (sessionId && status === 'closed') this.setSessionRunning(sessionId, false);
      return;
    }
    if (channel === 'usage:message-turn-cost' && isRecord(payload)) {
      const sessionId = readString(payload, 'sessionId');
      const clientId = readString(payload, 'clientId');
      const turnCostUsd = readNumber(payload, 'turnCostUsd');
      if (sessionId && clientId && turnCostUsd !== null && turnCostUsd > 0) {
        this.patchMessageAgentMeta(sessionId, clientId, {
          turnCostUsd,
          turnCostIsEstimate: payload.turnCostIsEstimate === true,
        });
      }
      return;
    }
    if (channel === 'maker:interaction-request' && isRecord(payload)) {
      const sessionId = readString(payload, 'sessionId');
      const request = isRecord(payload.request) ? payload.request : null;
      if (sessionId && request) {
        this.applyInteractionRequest(sessionId, {
          request: request as PendingInteraction['request'],
          persistId: readString(payload, 'persistId') ?? undefined,
        });
      }
      return;
    }
    if (channel === 'maker:interaction-dismissed' && isRecord(payload)) {
      const sessionId = readString(payload, 'sessionId');
      const requestId = readString(payload, 'requestId');
      if (sessionId && requestId) {
        // 注意:这里**不**提前回收延长抑制条目——push 到达只说明被控端已确认,
        // 不排除仍有「决定提交前发出、此刻还在途」的旧 getPendingInteractions
        // 快照晚于本 push 返回(弱网高发);提前回收会让那份旧快照把已解决的卡
        // 灌回面板闪回(codex review P2)。条目一律等 setPendingInteractions 的
        // 「缺席即过期」自然回收。
        this.dismissInteraction(sessionId, requestId);
      }
      return;
    }
    if (channel === 'maker:input:projection' && isRecord(payload)) {
      const sessionId = readString(payload, 'sessionId');
      if (sessionId) this.setInputProjection(sessionId, payload);
      return;
    }
    if (channel === 'maker:goal:status-changed' && isRecord(payload)) {
      const sessionId = readString(payload, 'sessionId');
      if (sessionId) {
        this.setGoalStatus(
          sessionId,
          isRecord(payload.goal) ? (payload.goal as unknown as MobileGoalStatusPayload) : null,
        );
      }
    }
  },

  setGoalStatus(sessionId: string, goal: MobileGoalStatusPayload | null): void {
    const existing = sessionGoalStatus.get(sessionId);
    if (sessionGoalStatus.has(sessionId) && deepValueEqual(existing, goal)) return;
    sessionGoalStatus.set(sessionId, goal);
    emit();
  },

  applySessionActivity(_deviceId: string, payload: unknown): void {
    if (!isRecord(payload)) return;
    const sessionId = readString(payload, 'sessionId');
    const phase = readString(payload, 'phase');
    if (!sessionId || !isRemoteSessionLiveActivityPhase(phase)) return;
    const compactDetail = typeof payload.compactDetail === 'string' ? payload.compactDetail : '';
    let changed = false;
    if (phase === 'running' || phase === 'needs-interaction') {
      const next: RemoteSessionLiveActivity = {
        sessionId,
        phase,
        compactDetail,
        interactionKind: readString(payload, 'interactionKind') ?? undefined,
        attention: payload.attention === true,
      };
      changed = writeSessionLiveActivity(sessionId, next) || changed;
      const current = readSessionRunStatus(sessionId);
      changed = writeSessionRunStatus(sessionId, {
        ...current,
        isRunning: true,
        sideTaskRunning: current.sideTaskRunning,
        startedAt: current.startedAt ?? Date.now(),
      }) || changed;
    } else {
      // completed / error 的未读态(attention=true)保留 liveActivity 条目 —— 会话行
      // 右侧状态槽靠 phase+attention 点亮完成绿点 / 出错红点(与桌面侧栏同语义);
      // 已读(attention=false,桌面侧真实展示后 relay 会重发)或收尾包才删除条目。
      // isRunning 等运行态照常收敛,不受保留影响。
      if (payload.attention === true) {
        changed = writeSessionLiveActivity(sessionId, {
          sessionId,
          phase,
          compactDetail,
          interactionKind: readString(payload, 'interactionKind') ?? undefined,
          attention: true,
        }) || changed;
      } else {
        changed = sessionLiveActivity.delete(sessionId) || changed;
      }
      // 权威 idle 恢复路径(completed / error 活动推送)同步关闭 maker turn 边界(只关不开):
      // 后台/断连错过终态 maker 事件后,边界会卡在 true、孤儿渲染 gate 常开,stale 得以重放。
      changed = writeMakerTurnRunning(sessionId, false) || changed;
      const current = readSessionRunStatus(sessionId);
      changed = writeSessionRunStatus(sessionId, {
        ...current,
        isRunning: false,
        sideTaskRunning: false,
        startedAt: null,
      }) || changed;
    }
    if (changed) emit();
  },

  applyMakerEvent(sessionId: string, event: Record<string, unknown>): void {
    const type = readString(event, 'type');
    if (type === 'agent_task_update') {
      const rawSource = readString(event, 'source');
      const source = rawSource === 'codex' || rawSource === 'claude-code' ? rawSource : undefined;
      const next = applyAgentTaskUpdateEvent(
        recallParkedTaskUpdates(sessionId, event.data, source, sessionTaskUpdates.get(sessionId)),
        event.data,
        source,
        new Date().toISOString(),
      );
      if (next) {
        sessionTaskUpdates.set(sessionId, next);
        emit();
      }
      return;
    }
    if (type === 'status') {
      const data = isRecord(event.data) ? event.data : null;
      const current = readSessionRunStatus(sessionId);
      const isRunning = typeof data?.isRunning === 'boolean' ? data.isRunning : current.isRunning;
      const rawTokenUsage = readNumber(data, 'tokenUsage');
      const rawStatus = readString(data, 'status');
      // turn-start 检测用 maker 自己的边界(不用 current.isRunning):activity 推送 / 活跃
      // 快照会先把 sessionRunning 置 true,重连场景首个 status 到达时宽状态已是 true,按它
      // 判定会漏掉真 turn start,stale 清理被跳过。
      const isTurnStart = isRunning && sessionMakerTurnRunning.get(sessionId) !== true;
      const turnBoundaryChanged = writeMakerTurnRunning(sessionId, isRunning);
      const tokenUsage = rawTokenUsage !== null && rawTokenUsage > 0
        ? rawTokenUsage
        : (isTurnStart ? 0 : current.tokenUsage);
      // maker turn 边界 false→true 时清掉上一轮残留的 live task updates:它们是 turn 级
      // live 状态,残留到下一轮会被渲染层的孤儿兜底当作"仍在运行的子 agent"追加到消息流
      // 末尾(桌面端靠 idle demote / clear 清,手机 store 是常驻单例,只能在 turn 边界收口)。
      // side task 拉起(skipTurnReset)不豁免:边界置 true 即打开孤儿渲染 gate,不清扫会让
      // 残留立刻重放;而选择性 sweep 本身保留 running codex worker(side task 主体),对
      // side task 无误伤。本轮真实存活的任务也会随后续 update 重建。
      let taskUpdatesCleared = false;
      if (isTurnStart) {
        taskUpdatesCleared = sweepStaleTaskUpdates(sessionId);
      }
      const next: RemoteSessionRunStatus = {
        isRunning,
        sideTaskRunning: isRunning ? data?.skipTurnReset === true : false,
        startedAt: isRunning ? (current.startedAt ?? Date.now()) : null,
        status: rawStatus ?? current.status,
        tokenUsage,
      };
      if (writeSessionRunStatus(sessionId, next) || taskUpdatesCleared || turnBoundaryChanged) emit();
      return;
    }
    if (type === 'done' || isTerminalMakerErrorEvent(event)) {
      this.setSessionRunning(sessionId, false);
    }
  },

  removeDevice(deviceId: string): void {
    const hadShard = shards.delete(deviceId);
    // Sweep per-session maps for this device regardless of whether the shard still exists, and
    // drop the index entries too — otherwise sessionDeviceIndex (and any maps it points at)
    // leak orphans when the shard was already pruned.
    let removedSession = false;
    for (const [sessionId, indexedDeviceId] of sessionDeviceIndex) {
      if (indexedDeviceId === deviceId) {
        messages.delete(sessionId);
        pendingInteractions.delete(sessionId);
        inputProjections.delete(sessionId);
        sessionLiveActivity.delete(sessionId);
        sessionRunning.delete(sessionId);
        sessionRunStatus.delete(sessionId);
        sessionMessageSyncMarkers.delete(sessionId);
        sessionTaskUpdates.delete(sessionId);
        sessionMakerTurnRunning.delete(sessionId);
        sessionParkedTaskUpdates.delete(sessionId);
        sessionDeviceIndex.delete(sessionId);
        removedSession = true;
      }
    }
    if (!hadShard && !removedSession) return;
    bumpMessageVersion();
    recomputeSessions();
  },

  clear(): void {
    shards.clear();
    messages.clear();
    pendingInteractions.clear();
    inFlightInteractionResolves.clear();
    confirmedInteractionDismissals.clear();
    inputProjections.clear();
    sessionLiveActivity.clear();
    sessionRunning.clear();
    sessionRunStatus.clear();
    sessionMessageSyncMarkers.clear();
    sessionTaskUpdates.clear();
    sessionMakerTurnRunning.clear();
    sessionParkedTaskUpdates.clear();
    sessionDeviceIndex.clear();
    reseedHandlers.clear();
    mergedSessions = [];
    deviceList = null;
    bumpMessageVersion();
    emit();
  },

  // Register a reseed handler for a device. Returns an unregister fn that removes only THIS
  // handler — multiple screens (Home + device detail) can subscribe the same device
  // concurrently without one's unmount clobbering the other's subscription.
  registerReseedHandler(deviceId: string, handler: () => void): () => void {
    let set = reseedHandlers.get(deviceId);
    if (!set) {
      set = new Set();
      reseedHandlers.set(deviceId, set);
    }
    set.add(handler);
    return () => {
      const current = reseedHandlers.get(deviceId);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) reseedHandlers.delete(deviceId);
    };
  },

  requestReseed(deviceId: string): void {
    reseedHandlers.get(deviceId)?.forEach((handler) => handler());
  },

  getSessionDeviceId(sessionId: string): string | undefined {
    return sessionDeviceIndex.get(sessionId);
  },

  getSessions(): RemoteSession[] {
    return mergedSessions;
  },

  getMessages(sessionId: string): RemoteMessage[] {
    return messages.get(sessionId) ?? emptyMessages;
  },

  getMessageVersion(): number {
    return messageVersion;
  },

  getStoreVersion(): number {
    return storeVersion;
  },

  getPendingInteractions(sessionId: string): PendingInteraction[] {
    return pendingInteractions.get(sessionId) ?? emptyPendingInteractions;
  },

  getInputProjection(sessionId: string): InputProjection {
    return inputProjections.get(sessionId) ?? EMPTY_INPUT_PROJECTION;
  },

  getSessionLiveActivity(sessionId: string): RemoteSessionLiveActivity | null {
    return sessionLiveActivity.get(sessionId) ?? null;
  },

  isSessionRunning(sessionId: string): boolean {
    return sessionRunning.get(sessionId) === true;
  },

  getSessionRunStatus(sessionId: string): RemoteSessionRunStatus {
    return readSessionRunStatus(sessionId);
  },

  getSessionTaskUpdates(sessionId: string): ReadonlyMap<string, AgentTaskUpdate> {
    return sessionTaskUpdates.get(sessionId) ?? EMPTY_TASK_UPDATES;
  },

  // undefined = 尚未拉取(unknown),null = 已确认无 goal——两者必须区分:压平成 null 会让
  // 目标视图在首次快照未返回时就放行创建,把被控端已有目标静默覆盖。
  getGoalStatus(sessionId: string): MobileGoalStatusPayload | null | undefined {
    return sessionGoalStatus.get(sessionId);
  },

  // maker status 驱动的权威 turn 边界(不含 activity / 快照流的宽 running)。孤儿 agent_task
  // 卡的渲染 gate 用它:与 turn-start 清理同源,保证「渲染开启时 map 必已清过 stale」。
  isSessionMakerTurnRunning(sessionId: string): boolean {
    return sessionMakerTurnRunning.get(sessionId) === true;
  },

  subscribe(cb: () => void): () => void {
    subs.add(cb);
    return () => subs.delete(cb);
  },
};

function dedupeInteractions(list: readonly PendingInteraction[]): PendingInteraction[] {
  const byId = new Map<string, PendingInteraction>();
  for (const item of list) {
    byId.set(interactionDedupeKey(item), item);
  }
  return sortPendingInteractions([...byId.values()]);
}

function remoteSessionListsEqual(a: readonly RemoteSession[], b: readonly RemoteSession[]): boolean {
  return recordListsEqual(a, b, remoteSessionEqual);
}

function remoteMessageListsEqual(a: readonly RemoteMessage[], b: readonly RemoteMessage[]): boolean {
  return recordListsEqual(a, b, remoteMessageEqual);
}

function recordListsEqual<T>(
  a: readonly T[],
  b: readonly T[],
  equal: (left: T, right: T) => boolean,
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!equal(a[i], b[i])) return false;
  }
  return true;
}

function remoteSessionEqual(a: RemoteSession, b: RemoteSession): boolean {
  return shallowRecordEqual(a as unknown as Record<string, unknown>, b as unknown as Record<string, unknown>);
}

function remoteMessageEqual(a: RemoteMessage, b: RemoteMessage): boolean {
  return shallowRecordEqual(a as unknown as Record<string, unknown>, b as unknown as Record<string, unknown>);
}

function runningMapsEqual(a: ReadonlyMap<string, boolean>, b: ReadonlyMap<string, boolean>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

function deviceListsEqual(
  a: readonly { deviceId: string; name: string }[] | null,
  b: readonly { deviceId: string; name: string }[],
): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].deviceId !== b[i].deviceId || a[i].name !== b[i].name) return false;
  }
  return true;
}

function readSessionRunStatus(sessionId: string): RemoteSessionRunStatus {
  return sessionRunStatus.get(sessionId) ?? EMPTY_SESSION_RUN_STATUS;
}

// 写 maker turn 边界,返回是否实际变化——变化必须参与调用方的 emit 判定(宽 run status
// 可能已被 activity / 快照流改到相同值,单靠 writeSessionRunStatus 的返回值会漏通知)。
function writeMakerTurnRunning(sessionId: string, running: boolean): boolean {
  const prev = sessionMakerTurnRunning.get(sessionId) === true;
  if (running === prev) return false;
  if (running) sessionMakerTurnRunning.set(sessionId, true);
  else sessionMakerTurnRunning.delete(sessionId);
  return true;
}

function writeSessionRunStatus(sessionId: string, next: RemoteSessionRunStatus): boolean {
  const current = readSessionRunStatus(sessionId);
  if (shallowRecordEqual(current as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>)) {
    return false;
  }
  sessionRunStatus.set(sessionId, next);
  if (next.isRunning) sessionRunning.set(sessionId, true);
  else sessionRunning.delete(sessionId);
  return true;
}

function buildSessionMessageSyncMarker(session: Pick<RemoteSession, '_count' | 'updatedAt'>): SessionMessageSyncMarker {
  const count = session._count?.messages;
  return {
    updatedAt: session.updatedAt,
    messageCount: typeof count === 'number' && Number.isFinite(count) ? count : null,
  };
}

function sessionMessageSyncMarkersEqual(
  marker: SessionMessageSyncMarker,
  next: SessionMessageSyncMarker,
): boolean {
  if (marker.updatedAt !== next.updatedAt) return false;
  if (next.messageCount === null) return true;
  return marker.messageCount === next.messageCount;
}

function writeSessionLiveActivity(sessionId: string, next: RemoteSessionLiveActivity): boolean {
  const current = sessionLiveActivity.get(sessionId);
  if (current && shallowRecordEqual(
    current as unknown as Record<string, unknown>,
    next as unknown as Record<string, unknown>,
  )) {
    return false;
  }
  sessionLiveActivity.set(sessionId, next);
  return true;
}

function isRemoteSessionLiveActivityPhase(value: string | null): value is SessionActivityPayload['phase'] {
  return value === 'running' || value === 'needs-interaction' || value === 'completed' || value === 'error';
}

function isTerminalMakerErrorEvent(event: Record<string, unknown>): boolean {
  if (readString(event, 'type') !== 'error') return false;
  const data = isRecord(event.data) ? event.data : null;
  if (!data) return true;
  if (typeof data.isTerminal === 'boolean') return data.isTerminal;
  if (typeof data.willRetry === 'boolean') return !data.willRetry;
  return true;
}

function shallowRecordEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepValueEqual(a[key], b[key])) return false;
  }
  return true;
}

function deepValueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || isRecord(a)) {
    return safeStableStringify(a) === safeStableStringify(b);
  }
  if (Array.isArray(b) || isRecord(b)) return false;
  return false;
}

function interactionDedupeKey(item: PendingInteraction): string {
  const requestId = item.request.requestId;
  if (typeof requestId === 'string' && requestId.length > 0) return `request:${requestId}`;
  if (item.persistId) return `persist:${item.persistId}`;
  return `request-shape:${safeStableStringify(item.request)}`;
}

function safeStableStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown, key: string): string | null {
  const raw = isRecord(value) ? value[key] : null;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function readNumber(value: unknown, key: string): number | null {
  const raw = isRecord(value) ? value[key] : null;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

export function useRemoteSessions(): RemoteSession[] {
  return useSyncExternalStore(remoteSessionStore.subscribe, remoteSessionStore.getSessions);
}

// 本地「最近消息」缓存持久化的去抖间隔:消息流式更新很频繁,只在静默一小段后落盘一次。
const SESSION_MESSAGE_CACHE_PERSIST_DEBOUNCE_MS = 600;

export function useSessionMessages(sessionId: string, deviceId?: string): RemoteMessage[] {
  const messages = useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.getMessages(sessionId),
  );
  useSessionMessageCacheSync(sessionId, deviceId, messages);
  return messages;
}

// 数据层接线:首次访问某 (deviceId, sessionId) 时从本地缓存乐观 hydrate;消息更新后去抖持久化。
// 写在 store 层(非 render 层),屏幕只管把已有的 deviceId 传进来。
function useSessionMessageCacheSync(
  sessionId: string,
  deviceId: string | undefined,
  messages: RemoteMessage[],
): void {
  const hydratedKeyRef = useRef<string | null>(null);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 持久化在定时器回调里读最新值,避免把每次渲染的 messages 都闭包进 timer。
  const ctxRef = useRef<{ deviceId?: string; sessionId: string; messages: RemoteMessage[] }>({
    deviceId,
    sessionId,
    messages,
  });
  ctxRef.current = { deviceId, sessionId, messages };

  // 乐观 hydrate:每个 (deviceId, sessionId) 只跑一次;缓存回来时若 store 仍为空才种入。
  useEffect(() => {
    if (!deviceId || !sessionId) return;
    const key = `${deviceId}::${sessionId}`;
    if (hydratedKeyRef.current === key) return;
    hydratedKeyRef.current = key;
    let cancelled = false;
    void getCachedSessionMessages(deviceId, sessionId)
      .then((cached) => {
        if (cancelled || cached.length === 0) return;
        remoteSessionStore.hydrateMessagesIfEmpty(sessionId, cached);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [deviceId, sessionId]);

  // 去抖持久化:messages 变化时重排定时器,静默后落盘最新快照。
  useEffect(() => {
    if (!deviceId || !sessionId || messages.length === 0) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      const ctx = ctxRef.current;
      if (!ctx.deviceId || !ctx.sessionId || ctx.messages.length === 0) return;
      void cacheSessionMessages(ctx.deviceId, ctx.sessionId, ctx.messages).catch(() => undefined);
    }, SESSION_MESSAGE_CACHE_PERSIST_DEBOUNCE_MS);
  }, [deviceId, sessionId, messages]);

  // 卸载时把尚未落盘的最新快照立即 flush(防止快速返回导致最后一次更新丢失)。
  useEffect(() => () => {
    if (!persistTimerRef.current) return;
    clearTimeout(persistTimerRef.current);
    persistTimerRef.current = null;
    const ctx = ctxRef.current;
    if (!ctx.deviceId || !ctx.sessionId || ctx.messages.length === 0) return;
    void cacheSessionMessages(ctx.deviceId, ctx.sessionId, ctx.messages).catch(() => undefined);
  }, []);
}

export function useRemoteMessageVersion(): number {
  return useSyncExternalStore(remoteSessionStore.subscribe, remoteSessionStore.getMessageVersion);
}

export function useRemoteSessionStoreVersion(): number {
  return useSyncExternalStore(remoteSessionStore.subscribe, remoteSessionStore.getStoreVersion);
}

export function useSessionPendingInteractions(sessionId: string): PendingInteraction[] {
  return useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.getPendingInteractions(sessionId),
  );
}

export function useSessionInputProjection(sessionId: string): InputProjection {
  return useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.getInputProjection(sessionId),
  );
}

export function useSessionRunning(sessionId: string): boolean {
  return useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.isSessionRunning(sessionId),
  );
}

export function useSessionRunStatus(sessionId: string): RemoteSessionRunStatus {
  return useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.getSessionRunStatus(sessionId),
  );
}

export function useSessionTaskUpdates(sessionId: string): ReadonlyMap<string, AgentTaskUpdate> {
  return useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.getSessionTaskUpdates(sessionId),
  );
}

/** 目标模式状态镜像(undefined = 尚未拉取,null = 已确认无 goal;页面打开时用 goal.getStatus 补一次拉取)。 */
export function useSessionGoalStatus(sessionId: string): MobileGoalStatusPayload | null | undefined {
  return useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.getGoalStatus(sessionId),
  );
}

export function useSessionMakerTurnRunning(sessionId: string): boolean {
  return useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.isSessionMakerTurnRunning(sessionId),
  );
}
