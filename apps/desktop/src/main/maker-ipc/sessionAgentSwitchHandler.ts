/**
 * session-agent-switch:同一会话在 Claude Code / Codex 引擎间切换的 IPC handler。
 *
 * 切换时序(host 层组合,不动 maker-core 热路径——规则 10 风险面最小化):
 *   校验 → 构造交接文本(纯代码,agentHandoff.buildHandoffText)
 *   → 关旧 live session → DB 提交(agent_kind + model + provider_id,清 sdk_session_id)
 *   → 插 agent_switch 边界行(交接全文持久化于此,UI 可展开)
 *   → 登记 pending 注入 → 立即重建新引擎 session(消灭多窗口 stale createOpts 竞态)。
 *
 * 失败语义:
 *  - DB 提交之前任何失败 → 原样抛错,会话状态不变;
 *  - DB 提交即切换成功的 commit point;之后边界行插入失败只降级(无分隔条,注入
 *    靠内存 pending 保住本进程内语义),新引擎 spawn 失败返回 engineReady=false,
 *    下一条消息走既有 lazy-create 路径重试并复用其错误呈现。
 *
 * v1 边界:远程会话(remoteHostId)与 Orca 协同会话不支持切换(UNSUPPORTED_CAPABILITY);
 * turn 进行中拒绝(SESSION_RUNNING);切回不复用旧原生会话——每次切换都重新交接。
 */

import type { AgentKind } from '@lizi/maker-core';

import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';
import {
  buildHandoffText,
  type DbAgentKind,
  type HandoffSourceMessage,
} from './agentHandoff.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** DB 'cc'/'codex' ↔ maker-core 'claude-code'/'codex' 映射(与 register.ts 各处内联口径一致)。 */
export function toDbAgentKind(kind: AgentKind): DbAgentKind {
  return kind === 'codex' ? 'codex' : 'cc';
}

export function toMakerAgentKind(dbKind: string): AgentKind {
  return dbKind === 'codex' ? 'codex' : 'claude-code';
}

/** 交接 framing 与边界卡展示用的引擎名。 */
export function agentEngineLabel(dbKind: DbAgentKind): string {
  return dbKind === 'codex' ? 'Codex' : 'Claude Code';
}

/** role='agent_switch' 边界行的 content 结构(与 renderer AgentSwitchContent 对齐)。 */
export interface AgentSwitchBoundaryContent {
  fromAgentKind: DbAgentKind;
  toAgentKind: DbAgentKind;
  fromModel: string | null;
  toModel: string | null;
  /** 旧引擎的原生 session id 快照(仅取证/未来切回增量续接用,不参与 v1 逻辑)。 */
  fromSdkSessionId: string | null;
  handoff: string;
}

export interface AgentSwitchSessionRow {
  id: string;
  agentKind: string;
  model: string | null;
  status: string;
  remoteHostId: string | null;
  orcaRole: string | null;
  sdkSessionId: string | null;
}

export interface MakerSessionAgentSwitchHandlerDeps {
  getSessionRow(sessionId: string): Promise<AgentSwitchSessionRow | null>;
  getLiveSession(sessionId: string): { isTurnRunning(): boolean } | null | undefined;
  closeSession(sessionId: string): Promise<void>;
  listMessagesForHandoff(sessionId: string): Promise<HandoffSourceMessage[]>;
  /** 提交切换:update agent_kind/model/provider_id + 清 sdk_session_id + 广播 sessions:patched。 */
  applyAgentSwitchToDb(
    sessionId: string,
    patch: { agentKind: DbAgentKind; model: string; providerId: string | null | undefined },
  ): Promise<void>;
  insertBoundaryMessage(sessionId: string, content: AgentSwitchBoundaryContent): Promise<void>;
  setPendingHandoff(sessionId: string, handoff: string): void;
  /** 从 DB 行(切换已提交后的新值)重建 live session;抛错 = 引擎未就绪。 */
  bootstrapSwitchedSession(sessionId: string): Promise<void>;
  /**
   * close→bootstrap 窗口的 onClose 重副作用抑制(desktop 注入
   * withRehydrateCloseSuppressed)——切换的瞬态 close 绝不能触发 worktree
   * stash/清理等 session 收尾钩子(与 Orca rehydrate 同保护)。
   */
  withCloseSuppressed<T>(sessionId: string, fn: () => Promise<T>): Promise<T>;
  /**
   * pending 切换意图注册表。缺省(测试最小 harness)时 turn 运行中回落抛
   * SESSION_RUNNING 的旧语义。
   */
  pendingSwitches?: PendingAgentSwitchRegistry;
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

export interface SessionAgentSwitchResult {
  switched: boolean;
  agentKind: AgentKind;
  model: string;
  /** 新引擎 live session 是否已就绪;false 时下一条消息走 lazy-create 重试。 */
  engineReady: boolean;
  /**
   * turn 运行中登记为 pending:切换不打断当前 turn,推迟到下一条消息发送时刻
   * 由 send 事务执行(applyPendingAgentSwitchIfIdle)。true 时 switched=false,
   * 会话状态(DB / 消息流 / chip)保持旧引擎——旧 turn 确实仍由旧引擎驱动。
   */
  deferred?: boolean;
}

/** 运行中登记的切换意图(下一条消息发送时刻执行)。 */
export interface PendingAgentSwitchIntent {
  targetAgentKind: AgentKind;
  model: string;
  providerId: string | null | undefined;
}

/**
 * pending 切换意图注册表(内存;重启丢失可接受——与凭证 deferred 同级的轻量意图,
 * 用户重开后重新选择即可)。同 session 重复登记 = 覆盖(用户改主意);SET_MODEL /
 * 同引擎 no-op 切换会清除(用户选回当前引擎)。
 */
export interface PendingAgentSwitchRegistry {
  set(sessionId: string, intent: PendingAgentSwitchIntent): void;
  get(sessionId: string): PendingAgentSwitchIntent | undefined;
  clear(sessionId: string): void;
}

export function createPendingAgentSwitchRegistry(): PendingAgentSwitchRegistry {
  const pending = new Map<string, PendingAgentSwitchIntent>();
  return {
    set: (sessionId, intent) => void pending.set(sessionId, intent),
    get: (sessionId) => pending.get(sessionId),
    clear: (sessionId) => void pending.delete(sessionId),
  };
}

/** 业务体(纯依赖注入,单测直接调):校验 → 交接 → 提交 → 重建。 */
export async function performSessionAgentSwitch(
  deps: MakerSessionAgentSwitchHandlerDeps,
  params: {
    sessionId: unknown;
    targetAgentKind: unknown;
    model: unknown;
    providerId?: unknown;
    /**
     * pending-apply 路径(send 事务派发前执行):跳过新引擎立即重建——send 随后
     * 的 lazy-create 会按 DB 新值 spawn(reconcileCreateOptsWithDb 校正兜底),
     * 不必重复 bootstrap 一次。
     */
    skipBootstrap?: boolean;
  },
): Promise<SessionAgentSwitchResult> {
  const { sessionId, targetAgentKind, model, providerId } = params;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throwIpcError('INVALID_PARAMS', 'sessionId required');
  }
  if (targetAgentKind !== 'claude-code' && targetAgentKind !== 'codex') {
    throwIpcError('INVALID_PARAMS', 'targetAgentKind must be claude-code | codex');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throwIpcError('INVALID_PARAMS', 'model required');
  }
  if (providerId !== undefined && providerId !== null && typeof providerId !== 'string') {
    throwIpcError('INVALID_PARAMS', 'providerId must be string | null');
  }

  const row = await deps.getSessionRow(sessionId);
  if (!row || row.status === 'deleted') {
    throwIpcError('NOT_FOUND', `Session ${sessionId} not found`);
  }
  if (row.remoteHostId) {
    // SSH 远程会话:agent 进程在远端机器,cc-manager 链路仅覆盖 Claude,v1 不支持切换。
    throwIpcError('UNSUPPORTED_CAPABILITY', 'agent switch is not supported for remote sessions');
  }
  if (row.orcaRole) {
    // Orca lead/worker:协同运行时对 agent 形态有独立契约(docs/orca-team-architecture.md),不掺和。
    throwIpcError('UNSUPPORTED_CAPABILITY', 'agent switch is not supported for Orca sessions');
  }

  const fromDbKind: DbAgentKind = row.agentKind === 'codex' ? 'codex' : 'cc';
  const toDbKind: DbAgentKind = targetAgentKind === 'codex' ? 'codex' : 'cc';
  if (fromDbKind === toDbKind) {
    // 同引擎 = 纯模型切换,调用方应走 SET_MODEL;这里按 no-op 成功返回。
    // 顺带清 pending:用户先登记了跨引擎切换、又选回当前引擎 = 改主意取消。
    deps.pendingSwitches?.clear(sessionId);
    return { switched: false, agentKind: targetAgentKind, model, engineReady: true };
  }

  const live = deps.getLiveSession(sessionId);
  if (live?.isTurnRunning()) {
    // turn 运行中不打断:登记切换意图,推迟到下一条消息发送时刻执行(send 事务
    // 的 applyPendingAgentSwitchIfIdle)。旧 turn 继续由旧引擎跑完——此期间
    // DB / 消息流 / 模型 chip 保持旧引擎是**真实**状态,不做乐观翻转。
    if (deps.pendingSwitches) {
      deps.pendingSwitches.set(sessionId, {
        targetAgentKind,
        model,
        providerId: providerId as string | null | undefined,
      });
      deps.log.info('agent-switch: deferred until next send (turn running)', {
        sessionId,
        targetAgentKind,
        model,
      });
      return { switched: false, agentKind: targetAgentKind, model, engineReady: true, deferred: true };
    }
    throwIpcError('SESSION_RUNNING', `Session ${sessionId} is running a turn`);
  }
  // 空闲立即切换:本次执行覆盖任何历史 pending(同一意图的最新表达)。
  deps.pendingSwitches?.clear(sessionId);

  // 交接文本先于任何状态变更构造(失败不留半切换状态)。
  const sourceMessages = await deps.listMessagesForHandoff(sessionId);
  const handoff = buildHandoffText(sourceMessages, {
    fromLabel: agentEngineLabel(fromDbKind),
    toLabel: agentEngineLabel(toDbKind),
  });

  return deps.withCloseSuppressed(sessionId, async () => {
    if (live) {
      await deps.closeSession(sessionId);
    }

    // ---- commit point:此后切换生效 ----
    await deps.applyAgentSwitchToDb(sessionId, {
      agentKind: toDbKind,
      model,
      providerId: providerId as string | null | undefined,
    });

    try {
      await deps.insertBoundaryMessage(sessionId, {
        fromAgentKind: fromDbKind,
        toAgentKind: toDbKind,
        fromModel: row.model,
        toModel: model,
        fromSdkSessionId: row.sdkSessionId,
        handoff,
      });
    } catch (err) {
      // 降级:分隔条缺失是外观问题;注入语义由下面的内存 pending 保住(本进程内)。
      deps.log.warn('agent-switch: boundary message insert failed (degraded)', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    deps.setPendingHandoff(sessionId, handoff);

    let engineReady = true;
    if (!params.skipBootstrap) {
      try {
        await deps.bootstrapSwitchedSession(sessionId);
      } catch (err) {
        engineReady = false;
        deps.log.warn('agent-switch: bootstrap new engine failed; next send will lazy-create', {
          sessionId,
          targetAgentKind,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    deps.log.info('agent-switch: switched', {
      sessionId,
      from: fromDbKind,
      to: toDbKind,
      model,
      engineReady,
      handoffChars: handoff.length,
    });
    return { switched: true, agentKind: targetAgentKind, model, engineReady };
  });
}

/**
 * send 事务派发前执行 pending 切换(makerSendTransaction.applyPendingAgentSwitch
 * 钩子的实现体)。语义:
 *  - 无 pending → no-op;
 *  - turn 仍在跑(排队消息提前 drain 等竞态)→ 保留 pending 本次不 apply,交给
 *    send 事务既有的 SESSION_RUNNING guard / coordinator 重试;
 *  - 空闲 → 清 pending 并执行完整切换事务(skipBootstrap:随后的 lazy-create 会按
 *    DB 新值 spawn)。执行失败不阻塞发送——log 后按旧引擎继续(意图已清,用户可
 *    从消息流没有出现分隔线看出切换未生效并重试)。
 */
export async function applyPendingAgentSwitchIfIdle(
  deps: MakerSessionAgentSwitchHandlerDeps,
  sessionId: string,
): Promise<void> {
  const intent = deps.pendingSwitches?.get(sessionId);
  if (!intent) return;
  const live = deps.getLiveSession(sessionId);
  if (live?.isTurnRunning()) return;
  deps.pendingSwitches?.clear(sessionId);
  try {
    await performSessionAgentSwitch(deps, {
      sessionId,
      targetAgentKind: intent.targetAgentKind,
      model: intent.model,
      providerId: intent.providerId,
      skipBootstrap: true,
    });
  } catch (err) {
    deps.log.warn('agent-switch: pending apply failed; sending with current engine', {
      sessionId,
      targetAgentKind: intent.targetAgentKind,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export function registerMakerSessionAgentSwitchHandler(
  registry: IpcHandlerRegistry,
  deps: MakerSessionAgentSwitchHandlerDeps,
): void {
  registry.handle(
    MAKER_INVOKE.SWITCH_SESSION_AGENT,
    async (
      _e,
      sessionId: unknown,
      targetAgentKind: unknown,
      model: unknown,
      providerId: unknown,
    ) => performSessionAgentSwitch(deps, { sessionId, targetAgentKind, model, providerId }),
  );
}
