// 启动端点清单闸门 hook(阻断式):冷启动时跑 runStartupEndpointResolve,
// 成功前业务树不挂载;失败进入 error 态由 _layout 渲染错误屏,用户点重试
// 再跑一次。**没有超时兜底 / 缓存降级**——拉不到就停在这。
// __DEV__ 直接放行(零网络,dev 端点行为与现状一致)。
// 时序:本闸门必须先于 OTA 检查更新(_layout 只在 ready 后挂载 OTA 门)。

import { useCallback, useEffect, useRef, useState } from 'react';

import { runStartupEndpointResolve } from './clientEndpointStartup';

export type StartupEndpointGateStatus = 'pending' | 'ready' | 'error';

export interface StartupEndpointGate {
  status: StartupEndpointGateStatus;
  /** status === 'error' 时的失败原因(fetch-failed / invalid-json / ...)。 */
  reason: string | null;
  /** 错误屏「重试」:回到 pending 并重新拉取。 */
  retry: () => void;
}

export function useStartupEndpointGate(): StartupEndpointGate {
  const enabled = !__DEV__;
  const [status, setStatus] = useState<StartupEndpointGateStatus>(enabled ? 'pending' : 'ready');
  const [reason, setReason] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const running = useRef(false);

  useEffect(() => {
    if (!enabled || status === 'ready' || running.current) return;
    if (status === 'error') return; // 等用户点重试
    running.current = true;
    let cancelled = false;
    void runStartupEndpointResolve().then((outcome) => {
      running.current = false;
      if (cancelled) return;
      if (outcome.ok) {
        setStatus('ready');
      } else {
        setReason(outcome.reason);
        setStatus('error');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, status, attempt]);

  const retry = useCallback(() => {
    setReason(null);
    setStatus('pending');
    setAttempt((n) => n + 1);
  }, []);

  return { status, reason, retry };
}
