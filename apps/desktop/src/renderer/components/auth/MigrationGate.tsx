import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';
import { createLogger } from '@/lib/logger';

const log = createLogger('MigrationGate');

/**
 * chat-data-localization V0.5 — 路由层迁移分发：
 *
 * - 入口已经过 ProtectedRoute（已认证）；这里只判断"主功能区是否可进入"。
 * - 流程：
 *   1) 调 `localDb.ensureReady(userId)`——按 userId 切换 / 兜底恢复 / 跑 schema migration
 *      失败：main 已弹 OS 对话框；这里阻断渲染（返回 null）让用户停留在空白
 *      （后续可点重启）。
 *   2) 读本地 `migration.getStatus()`：
 *        'in_progress'        → 续传 → /login/migration
 *        'done' / 'skipped'   → 渲染主功能 Outlet
 *        其它（null/'pending'）→ 看 AuthContext.migration 决定：
 *           pending → /login/migration（带 totals）
 *           none    → setStatus('done') → 渲染 Outlet（涵盖"全新设备"+"切片已 done"）
 *
 * 这个组件是 spec 中 AuthContext.handleLoginResponse 的等价实现——本项目的
 * AuthProvider 在 RouterProvider 之外，无法直接 useNavigate；分发逻辑迁移到
 * 路由层的本组件。结果等价。
 */
type GateDecision =
  | { phase: 'checking' }
  | { phase: 'ready' }
  | {
      phase: 'redirect-migration';
      totalSessions: number;
      totalMessages: number;
    }
  | { phase: 'fatal' };

/**
 * decision 失败的有限重试。fatal 会 `return null` 阻断整棵 UI 树(白屏),必须
 * 只留给确定性失败;而这里的失败常常是 transient —— 2026-07-15 实锤过一例:
 * 跨系统睡眠的 db worker RPC 假超时把 getStatus 打挂,一次挫折直接白屏到手动
 * Cmd+R。重试 2 次(间隔 1s)可消化这类瞬时故障,真死的 DbClient 依然会在
 * 第 3 次失败后落 fatal,保住"不永久停在 checking"的原有保证。
 */
const MAX_DECISION_RETRIES = 2;
const DECISION_RETRY_DELAY_MS = 1_000;

export function MigrationGate() {
  const { user, migration } = useAuth();
  const location = useLocation();
  const [decision, setDecision] = useState<GateDecision>({ phase: 'checking' });
  const [retryNonce, setRetryNonce] = useState(0);
  const retryCountRef = useRef(0);
  const previousUserIdRef = useRef<string | null>(null);
  const previousMigrationKeyRef = useRef<string | null>(null);
  const migrationKey = useMemo(() => {
    if (!migration) return 'unset';
    if (migration.status === 'pending') {
      return `pending:${migration.totalSessions}:${migration.totalMessages}`;
    }
    return migration.status;
  }, [migration]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const userId = user?.id ?? null;
    const userChanged = previousUserIdRef.current !== userId;
    previousUserIdRef.current = userId;
    // user 或 migrationKey 任一变化 = 一次全新决策,重试额度整体归零;
    // 只有 retryNonce 驱动的重跑才继承计数(否则重试永远数不满,fatal 不可达)。
    const migrationKeyChanged = previousMigrationKeyRef.current !== migrationKey;
    previousMigrationKeyRef.current = migrationKey;
    if (userChanged || migrationKeyChanged) {
      retryCountRef.current = 0;
    }
    if (userChanged) {
      setDecision({ phase: 'checking' });
    }
    if (!user) {
      return () => {
        cancelled = true;
      };
    }

    // 决策成功统一走这里:清零重试计数,下一次 transient 故障重新享有完整重试额度。
    const succeed = (next: GateDecision): void => {
      retryCountRef.current = 0;
      setDecision(next);
    };

    (async () => {
     try {
      // Step 1: ensureReady（按 userId 切换 db；失败 main 已弹对话框）
      const ready = await window.electronAPI.localDb.ensureReady(user.id);
      if (cancelled) return;
      if (!ready.ready) {
        log.error('ensureReady failed', ready.error);
        setDecision({ phase: 'fatal' });
        return;
      }

      // Signal main "user logged in + localDb is open" so the FeishuBot WS
      // connection can come online safely. Gated and idempotent in main —
      // re-mounts and account switches are no-ops after the first call.
      // Fire-and-forget: the gate decision below MUST NOT block on bot startup.
      void window.electronAPI.appReadyForBot().catch((err) => {
        log.warn('appReadyForBot signal failed (non-fatal)', err);
      });

      // Step 2: 本地状态最高优先级
      const localStatus = await window.electronAPI.localDb.migration.getStatus();
      if (cancelled) return;
      if (localStatus === 'in_progress') {
        succeed({
          phase: 'redirect-migration',
          totalSessions:
            migration?.status === 'pending' ? migration.totalSessions : 0,
          totalMessages:
            migration?.status === 'pending' ? migration.totalMessages : 0,
        });
        return;
      }
      if (localStatus === 'done' || localStatus === 'skipped') {
        succeed({ phase: 'ready' });
        return;
      }

      // Step 3: 看响应分支（V0.5 两态）
      if (migration?.status === 'pending') {
        succeed({
          phase: 'redirect-migration',
          totalSessions: migration.totalSessions,
          totalMessages: migration.totalMessages,
        });
        return;
      }

      // 默认 / 'none' / migration 还没拿到 → 视作 done 进入主界面
      // （服务端 count 失败兜底降级 / 全新设备 / 切片已 done 过——客户端无须区分）
      try {
        await window.electronAPI.localDb.migration.setStatus('done');
      } catch (err) {
        log.warn('setStatus(done) failed', err);
      }
      if (cancelled) return;
      succeed({ phase: 'ready' });
     } catch (err) {
       // 任何一步 IPC reject（典型：DbClient 未就绪导致 getStatus 抛错）都不能让
       // async 异常静默冒泡、decision 永远停在 'checking' → 永久黑屏。但一次挫折
       // 也不能直接 fatal(见 MAX_DECISION_RETRIES 注释):先有限重试,耗尽才 fatal。
       if (cancelled) return;
       if (retryCountRef.current < MAX_DECISION_RETRIES) {
         retryCountRef.current += 1;
         log.warn(
           `migration gate decision failed, retrying (${retryCountRef.current}/${MAX_DECISION_RETRIES})`,
           err,
         );
         retryTimer = setTimeout(() => setRetryNonce((n) => n + 1), DECISION_RETRY_DELAY_MS);
         return;
       }
       log.error('migration gate decision failed after retries', err);
       setDecision({ phase: 'fatal' });
     }
    })();

    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
    // 依赖 user.id 与 migration 值——切账号 blank;同账号 refresh 不因对象引用变化卸载
    // Outlet。retryNonce 驱动失败后的有限重试重跑。
  }, [user?.id, migrationKey, retryNonce]);

  if (!user || decision.phase === 'checking') {
    // 短暂检查窗口（通常 < 100ms）；返回 null 即可，App 已有 splash 兜底视觉
    return null;
  }

  if (decision.phase === 'fatal') {
    // 弹错对话框由 main 负责；这里阻断渲染，避免用户进入半残状态
    return null;
  }

  if (decision.phase === 'redirect-migration') {
    // 已经在 /login/migration 上则直接渲染（避免无限重定向；其实路由树不会到这里，
    // 因为 /login/migration 不挂 MigrationGate）；以防万一加判定。
    if (location.pathname === '/login/migration') return <Outlet />;
    return (
      <Navigate
        to="/login/migration"
        replace
        state={{
          totalSessions: decision.totalSessions,
          totalMessages: decision.totalMessages,
        }}
      />
    );
  }

  return <Outlet />;
}
