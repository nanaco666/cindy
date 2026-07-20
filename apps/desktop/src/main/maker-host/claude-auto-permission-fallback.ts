/**
 * Claude Code Auto 权限分类器故障检测与会话降级。
 *
 * 观察器只读 proxy 响应元数据，不改写响应；coordinator 在确认持久态仍为 auto 后，
 * 把单个活跃 Claude 会话切到 ask。分类器不可用时 fail-to-prompt，而不是让所有工具
 * 调用继续 fail-closed。
 */

import type { PermissionMode } from '@lizi/maker-core';
import type { ResponseObserver, ResponseObserverCtx } from '@lizi/anthropic-compat-proxy';

const CLASSIFIER_SYSTEM_PREFIX = 'You are a security monitor for autonomous AI coding agents.';

/** Proxy 识别出的单次分类器故障。 */
export interface ClaudeAutoClassifierUnavailableSignal {
  sessionId: string;
  status: number;
}

/** 广播给 renderer/device-link 的降级结果。 */
export interface ClaudeAutoPermissionFallbackEvent {
  sessionId: string;
  from: 'auto';
  to: 'ask';
  reason: 'classifier_unavailable';
  status: number;
}

interface FallbackSession {
  agentKind: string;
  setPermissionMode(mode: PermissionMode): Promise<void>;
}

interface FallbackLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** coordinator 的 host 依赖；使用回调注入，模块本身不依赖 Electron/DB。 */
export interface ClaudeAutoPermissionFallbackDeps {
  getSession(sessionId: string): FallbackSession | undefined;
  getSessionMeta(sessionId: string): Promise<{ permissionMode?: PermissionMode } | null>;
  /**
   * 条件持久化(SQL 级 compare-and-swap):仅当持久态仍为 'auto' 时写成 'ask'。
   * 返回 false = 用户并发切到了其它档,写库被放弃,调用方按最新持久态回滚 runtime。
   */
  persistPermissionModeIfAuto(sessionId: string): Promise<boolean>;
  broadcast(event: ClaudeAutoPermissionFallbackEvent): void;
  logger: FallbackLogger;
}

type UnavailableListener = (signal: ClaudeAutoClassifierUnavailableSignal) => void;
let unavailableListener: UnavailableListener = () => {};

/** 由 maker IPC 接线层注入；传 no-op 可在测试/退出时解除。 */
export function setClaudeAutoClassifierUnavailableListener(listener: UnavailableListener): void {
  unavailableListener = listener;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstSystemText(system: unknown): string | null {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system) || system.length === 0) return null;
  const first = system[0];
  if (!isRecord(first) || first.type !== 'text' || typeof first.text !== 'string') {
    return null;
  }
  return first.text;
}

/**
 * 精确识别 Claude Code 内部 Auto 安全分类器请求。
 * 只在错误响应路径调用；畸形/未来未知形态一律 false，避免误降级普通模型请求。
 */
export function isClaudeAutoClassifierRequest(requestBody: Buffer): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBody.toString('utf8'));
  } catch {
    return false;
  }
  if (!isRecord(parsed) || parsed.max_tokens !== 64) return false;
  return firstSystemText(parsed.system)?.startsWith(CLASSIFIER_SYSTEM_PREFIX) === true;
}

/**
 * 创建只读响应观察器。成功响应和非 429/5xx 错误均为 O(1) 短路，不 parse body、
 * 不返回 sink，因此不会 tee SSE 热路径。
 */
export function createClaudeAutoClassifierFailureObserver(
  resolveSessionId: (sdkSessionId: string) => string | null,
): ResponseObserver {
  return (ctx: ResponseObserverCtx) => {
    if (ctx.status !== 429 && ctx.status < 500) return undefined;
    const sdkSessionId = ctx.requestHeaders['x-claude-code-session-id'];
    if (!sdkSessionId) return undefined;
    const sessionId = resolveSessionId(sdkSessionId);
    if (!sessionId || !isClaudeAutoClassifierRequest(ctx.requestBody)) return undefined;

    try {
      unavailableListener({ sessionId, status: ctx.status });
    } catch {
      // observer 只能旁路通知；listener 异常不得影响上游响应 pipe。
    }
    return undefined;
  };
}

/**
 * 创建 per-session fallback coordinator。in-flight 集合只防同一轮 429 retry storm；
 * 完成后即释放，因此用户以后手动重新开启 Auto 时仍能再次降级。
 */
export function createClaudeAutoPermissionFallbackCoordinator(
  deps: ClaudeAutoPermissionFallbackDeps,
): (signal: ClaudeAutoClassifierUnavailableSignal) => Promise<boolean> {
  const inFlight = new Set<string>();

  return async (signal) => {
    if (inFlight.has(signal.sessionId)) return false;
    inFlight.add(signal.sessionId);
    let session: FallbackSession | undefined;
    try {
      const before = await deps.getSessionMeta(signal.sessionId);
      if (before?.permissionMode !== 'auto') return false;

      session = deps.getSession(signal.sessionId);
      if (!session || session.agentKind !== 'claude-code') return false;

      // 先切 runtime，立刻阻止 CLI 后续动作继续进入 classifier；持久化用 SQL 级
      // 条件写(仅持久态仍为 auto 时命中)，彻底闭合「读到 auto 之后、写库之前用户
      // 手动切档」的窗口——未命中时以用户刚保存的选择为准恢复 runtime，不广播降级。
      await session.setPermissionMode('ask');
      const applied = await deps.persistPermissionModeIfAuto(signal.sessionId);
      if (!applied) {
        const latest = await deps.getSessionMeta(signal.sessionId);
        if (latest?.permissionMode && latest.permissionMode !== 'ask') {
          await session.setPermissionMode(latest.permissionMode);
        }
        return false;
      }
      const event: ClaudeAutoPermissionFallbackEvent = {
        sessionId: signal.sessionId,
        from: 'auto',
        to: 'ask',
        reason: 'classifier_unavailable',
        status: signal.status,
      };
      deps.broadcast(event);
      deps.logger.info('auto permission classifier unavailable; session downgraded to ask', {
        sessionId: signal.sessionId,
        status: signal.status,
      });
      return true;
    } catch (error) {
      // runtime 已切但持久化失败时，以 DB 真相回滚，避免 selector 与 SDK 权限档分叉。
      if (session) {
        try {
          const persisted = await deps.getSessionMeta(signal.sessionId);
          if (persisted?.permissionMode) {
            await session.setPermissionMode(persisted.permissionMode);
          }
        } catch {
          // 原错误才是诊断主因；回滚失败只保持 fail-closed，不覆盖日志。
        }
      }
      deps.logger.warn('auto permission fallback failed', {
        sessionId: signal.sessionId,
        status: signal.status,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      inFlight.delete(signal.sessionId);
    }
  };
}
