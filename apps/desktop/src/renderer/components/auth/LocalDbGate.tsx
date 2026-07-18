import { useEffect, useRef, useState } from 'react';
import { Outlet } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';
import { createLogger } from '@/lib/logger';

const log = createLogger('LocalDbGate');

/**
 * 路由层 localDb 就绪门（前身 MigrationGate；chat-data 云端迁移已随主 server
 * 退役，本组件只保留"库就绪"职责）：
 *
 * - 入口已经过 ProtectedRoute（已认证）；这里只判断"主功能区是否可进入"。
 * - 调 `localDb.ensureReady(userId)`——按 userId 切换 / 兜底恢复 / 跑 schema
 *   migration。成功后渲染主功能 Outlet；失败：main 已弹 OS 对话框，这里阻断
 *   渲染（返回 null）让用户停留在空白（后续可点重启）。
 * - ensureReady 成功后向 main 发 appReadyForBot 信号（IM bot 连接安全上线的
 *   前置条件），fire-and-forget。
 */
type GateDecision =
  | { phase: 'checking' }
  | { phase: 'ready' }
  | { phase: 'fatal' };

/**
 * decision 失败的有限重试。fatal 会 `return null` 阻断整棵 UI 树(白屏),必须
 * 只留给确定性失败;而这里的失败常常是 transient —— 2026-07-15 实锤过一例:
 * 跨系统睡眠的 db worker RPC 假超时把 ensureReady 打挂,一次挫折直接白屏到手动
 * Cmd+R。重试 2 次(间隔 1s)可消化这类瞬时故障,真死的 DbClient 依然会在
 * 第 3 次失败后落 fatal,保住"不永久停在 checking"的原有保证。
 */
const MAX_DECISION_RETRIES = 2;
const DECISION_RETRY_DELAY_MS = 1_000;

export function LocalDbGate() {
  const { user } = useAuth();
  const [decision, setDecision] = useState<GateDecision>({ phase: 'checking' });
  const [retryNonce, setRetryNonce] = useState(0);
  const retryCountRef = useRef(0);
  const previousUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const userId = user?.id ?? null;
    const userChanged = previousUserIdRef.current !== userId;
    previousUserIdRef.current = userId;
    // user 变化 = 一次全新决策,重试额度整体归零;只有 retryNonce 驱动的重跑才
    // 继承计数(否则重试永远数不满,fatal 不可达)。
    if (userChanged) {
      retryCountRef.current = 0;
      setDecision({ phase: 'checking' });
    }
    if (!user) {
      return () => {
        cancelled = true;
      };
    }

    (async () => {
     try {
      // ensureReady（按 userId 切换 db；失败 main 已弹对话框）
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

      retryCountRef.current = 0;
      setDecision({ phase: 'ready' });
     } catch (err) {
       // ensureReady IPC reject（典型：DbClient 未就绪）不能让 async 异常静默
       // 冒泡、decision 永远停在 'checking' → 永久黑屏。但一次挫折也不能直接
       // fatal(见 MAX_DECISION_RETRIES 注释):先有限重试,耗尽才 fatal。
       if (cancelled) return;
       if (retryCountRef.current < MAX_DECISION_RETRIES) {
         retryCountRef.current += 1;
         log.warn(
           `local-db gate decision failed, retrying (${retryCountRef.current}/${MAX_DECISION_RETRIES})`,
           err,
         );
         retryTimer = setTimeout(() => setRetryNonce((n) => n + 1), DECISION_RETRY_DELAY_MS);
         return;
       }
       log.error('local-db gate decision failed after retries', err);
       setDecision({ phase: 'fatal' });
     }
    })();

    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
    // 依赖 user.id——切账号 blank;同账号 refresh 不因对象引用变化卸载 Outlet。
    // retryNonce 驱动失败后的有限重试重跑。
  }, [user?.id, retryNonce]);

  if (!user || decision.phase === 'checking') {
    // 短暂检查窗口（通常 < 100ms）；返回 null 即可，App 已有 splash 兜底视觉
    return null;
  }

  if (decision.phase === 'fatal') {
    // 弹错对话框由 main 负责；这里阻断渲染，避免用户进入半残状态
    return null;
  }

  return <Outlet />;
}
