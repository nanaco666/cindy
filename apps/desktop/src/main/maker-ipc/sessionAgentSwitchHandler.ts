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
}

/** 业务体(纯依赖注入,单测直接调):校验 → 交接 → 提交 → 重建。 */
export async function performSessionAgentSwitch(
  deps: MakerSessionAgentSwitchHandlerDeps,
  params: {
    sessionId: unknown;
    targetAgentKind: unknown;
    model: unknown;
    providerId?: unknown;
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
    return { switched: false, agentKind: targetAgentKind, model, engineReady: true };
  }

  const live = deps.getLiveSession(sessionId);
  if (live?.isTurnRunning()) {
    throwIpcError('SESSION_RUNNING', `Session ${sessionId} is running a turn`);
  }

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
