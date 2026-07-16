import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { isSidebarWindow } from '@/lib/sidebarWindow';

/**
 * 由主窗派生的附属窗口(会话多开副窗 / 右侧栏子窗口):主窗启动时已完成
 * env check + 热更检查,附属窗口一律跳过(初始 'passed' + 不跑 auto-check)。
 */
function isDerivedWindow(): boolean {
  return isSecondaryWindow() || isSidebarWindow();
}

/* ── Types ── */

/**
 * Startup phases (parallel since #26):
 * Phase 1 (background): update check — checking_update → updating → update_done
 * Phase 2 (foreground): binary check — checking → downloading → passed/failed
 * Phase 2 drives splash progress; Phase 1 can interrupt with relaunch dialog.
 */
export type EnvCheckStatus =
  | 'idle'
  | 'checking_update'      // Phase 1: pulling manifest, checking for app hot-update
  | 'updating'             // Phase 1: downloading app update
  | 'update_done'          // Phase 1: update downloaded, about to relaunch
  | 'manifest_failed'      // Phase 1: manifest fetch failed, need retry
  | 'download_failed'      // Phase 1: hotfix 下载失败/校验失败，需要用户重试
  | 'checking'             // Phase 2: checking CCD binary
  | 'downloading'          // Phase 2: downloading CCD binary
  | 'passed'               // All done
  | 'failed';              // Env check failed

export interface DownloadInfo {
  progress: number;
  speed?: string;
  downloaded?: string;
  total?: string;
}

export interface EnvCheckContextValue {
  status: EnvCheckStatus;
  result: EnvCheckResult | null;
  downloadProgress: number;
  downloadInfo: DownloadInfo;
  updateVersion?: string;
  /** D 场景顺序下载阶段：1 / 2；B/C 场景未定义。 */
  step?: 1 | 2;
  /** D 场景固定为 2；B/C 场景未定义。 */
  totalSteps?: 2;
  /** 自增 token——每次主进程发 reset payload 时 +1，供 SplashScreen 触发无动画归零。 */
  resetSignal: number;
  checkEnvironment: () => Promise<void>;
}

/* ── Context ── */

const EnvCheckContext = createContext<EnvCheckContextValue | null>(null);

/* ── Helpers ── */

function formatBytes(b: number): string {
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}

/* ── Provider ── */

export function EnvCheckProvider({ children }: { children: ReactNode }) {
  // 「在新窗口打开」的副窗口:由主窗右键开出,主窗启动时已完成 env check + 热更检查,
  // 副窗不再重跑——初始即 'passed' 放行主 UI,避免首帧空白/splash 闪现;下面的
  // auto-check effect 也会对副窗 early-return,彻底不触发热更检查(prod 下若后台已下好
  // 补丁,重跑会命中 action:'relaunch' 把整个 app 重启)。
  const [status, setStatus] = useState<EnvCheckStatus>(
    isDerivedWindow() ? 'passed' : 'idle',
  );
  const [result, setResult] = useState<EnvCheckResult | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadInfo, setDownloadInfo] = useState<DownloadInfo>({ progress: 0 });
  const [updateVersion, setUpdateVersion] = useState<string | undefined>();
  const [step, setStep] = useState<1 | 2 | undefined>(undefined);
  const [totalSteps, setTotalSteps] = useState<2 | undefined>(undefined);
  const [resetSignal, setResetSignal] = useState(0);

  // Phase 2 活跃期间抑制 Phase 1 的 progress 事件，避免 splash 状态跳变（#26）
  const suppressUpdateProgressRef = useRef(false);
  // Retry 防护：递增 callId，Phase 1 返回后校验是否仍为当前调用，避免旧 promise 干扰新流程
  const callIdRef = useRef(0);
  // Mirror status to ref so the grace-period tick (delayed setTimeout) can see
  // the latest value synchronously — closing over `status` from useCallback
  // would always read the stale value at checkEnvironment() call time.
  const statusRef = useRef<EnvCheckStatus>('idle');
  useEffect(() => { statusRef.current = status; }, [status]);

  // Listen to CCD download progress from main process
  useEffect(() => {
    const unsubCCD = window.electronAPI.onBinaryDownloadProgress((payload) => {
      if (!payload) return;
      // Terminal failure: escape splash immediately so the user sees retry,
      // instead of waiting for the (synchronous) checkEnvironment IPC to return.
      if (payload.failed === true) {
        setStatus('failed');
        return;
      }
      // step / totalSteps 跟 payload 走（缺省即清掉，保证 B/C 场景不残留 D 场景的标签）
      setStep(payload.step);
      setTotalSteps(payload.totalSteps);
      // reset payload：先 bump 信号让 SplashScreen 关闭 transition，再 set 进度=0。
      // payload.reset === true 时主进程已经把 progress 显式设成 0，按下面常规分支处理即可。
      if (payload.reset === true) {
        setResetSignal((n) => n + 1);
      }
      if (typeof payload.progress === 'number') {
        setDownloadProgress(payload.progress);
        setDownloadInfo({
          progress: payload.progress,
          speed: payload.speed,
          downloaded: payload.downloaded,
          total: payload.total,
        });
        setStatus('downloading');
      }
    });

    // Listen to app update download progress — only during startup (splash phase).
    // Once env check passes, background update progress must NOT reset status,
    // otherwise EnvCheckGuard unmounts the entire main UI mid-session.
    const unsubUpdate = window.electronAPI.onAppUpdateProgress?.((payload) => {
      setStatus((prev) => {
        // Ignore progress events after env check has passed — background poll only.
        if (prev === 'passed') return prev;
        if (!payload) return prev;
        // Phase 2 活跃期间抑制 Phase 1 progress，避免 splash 状态跳变（#26）
        if (suppressUpdateProgressRef.current) return prev;
        // Phase-1 终态保护：update_done / download_failed / manifest_failed 一旦确定就不再被
        // 后到的 app-update-progress 事件（progress 或 failed）刷掉。Electron `webContents.send`
        // 和 `ipcMain.handle` 的 invoke reply 走不同内部通道，到渲染端不保证 FIFO——
        // 若 invoke reply 先到、progress 事件后到，progress=100 的尾包会把 update_done
        // 覆盖回 'updating'，splash 卡在 100% 不再切到重启对话框；同理 failed 事件也不应
        // 翻动已经定好的终态。
        if (prev === 'update_done' || prev === 'download_failed' || prev === 'manifest_failed') {
          return prev;
        }
        // Terminal failure during startup: drop into download_failed so the splash
        // dialog appears. Background polls (prev === 'passed') are filtered above.
        if (payload.failed === true) {
          return 'download_failed';
        }
        if (typeof payload.progress === 'number') {
          setDownloadProgress(payload.progress);
          setDownloadInfo({
            progress: payload.progress,
            speed: payload.speed,
            downloaded: formatBytes(payload.received),
            total: formatBytes(payload.total),
          });
          return 'updating';
        }
        return prev;
      });
    });

    return () => {
      unsubCCD();
      unsubUpdate?.();
    };
  }, []);

  const checkEnvironment = useCallback(async () => {
    const thisCallId = ++callIdRef.current;
    setDownloadProgress(0);
    setDownloadInfo({ progress: 0 });

    // ── Phase 1 (background): update check — fire-and-forget promise ──
    const updatePromise = (async () => {
      try {
        return await window.electronAPI.checkAppUpdate();
      } catch {
        return null;
      }
    })();

    // ── Phase 2 (foreground): binary check — drives splash state ──
    suppressUpdateProgressRef.current = true;
    setStatus('checking');

    let phase2Passed = false;
    try {
      const res = await window.electronAPI.checkEnvironment();
      setResult(res);
      phase2Passed = res.allPassed;
    } catch {
      setStatus('failed');
      suppressUpdateProgressRef.current = false;
      return;
    }

    suppressUpdateProgressRef.current = false;

    if (!phase2Passed) {
      setStatus('failed');
      return;
    }

    // Retry 防护：若用户在 Phase 2 期间点了重试，此调用已过期，丢弃后续结果
    if (thisCallId !== callIdRef.current) return;

    // ── Phase 2 passed, maker:* IPC registered — resolve Phase 1 ──
    // Grace 设计:Phase 1 一般 ~8ms 拿到 manifest 结论(内网 CDN);若 3s 内还没回,
    // 多半是 manifest 慢或本身没更新,放行进主界面避免阻塞启动(#26 原意)。
    // 但若 grace 到点时 Phase 1 已经在下补丁(status === 'updating'),不能硬切到
    // passed 把正在下载的补丁踢出 splash——必须等下完,否则会出现"补丁下完后直接进
    // 主界面、不触发 relaunch 提示"的回归。
    const UPDATE_GRACE_MS = 3_000;
    type UpdateResult = Awaited<typeof updatePromise>;
    const updateResult = await new Promise<UpdateResult>((resolve) => {
      let settled = false;
      const safeResolve = (v: UpdateResult) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };

      void updatePromise.then(safeResolve);

      const tick = () => {
        if (settled) return;
        // 正在下补丁/已下完待重启 → 继续等 updatePromise,不超时
        if (statusRef.current === 'updating' || statusRef.current === 'update_done') {
          setTimeout(tick, 500);
          return;
        }
        safeResolve(null);
      };
      setTimeout(tick, UPDATE_GRACE_MS);
    });

    // 再次校验：grace period 期间可能发生了 retry
    if (thisCallId !== callIdRef.current) return;

    if (updateResult?.hasUpdate && updateResult?.action === 'relaunch') {
      setStatus('update_done');
      setUpdateVersion(updateResult.version);
      return;
    }

    // No update / manifest failed / download failed / grace timeout expired
    // → enter app. Background 30-min poll will catch updates later.
    setStatus('passed');
  }, []);

  // Auto-check on mount
  // Dev mode: skip update check (Phase 1), but still run env check (Phase 2)
  // to ensure claudeCodePath is set for the SDK.
  useEffect(() => {
    // 副窗口 / 右侧栏子窗口直接放行(见上方 status 初始化注释),不跑任何启动检查。
    if (isDerivedWindow()) return;
    const isDev = import.meta.env.DEV;
    if (isDev) {
      (async () => {
        setStatus('checking');
        try {
          const res = await window.electronAPI.checkEnvironment();
          setResult(res);
          setStatus('passed');
        } catch {
          setStatus('passed');
        }
      })();
      return;
    }
    checkEnvironment();
  }, [checkEnvironment]);

  const value = useMemo(
    () => ({ status, result, downloadProgress, downloadInfo, updateVersion, step, totalSteps, resetSignal, checkEnvironment }),
    [status, result, downloadProgress, downloadInfo, updateVersion, step, totalSteps, resetSignal, checkEnvironment],
  );

  return <EnvCheckContext.Provider value={value}>{children}</EnvCheckContext.Provider>;
}

/* ── Guard ── */

export function EnvCheckGuard({ children }: { children: ReactNode }) {
  const { status } = useEnvCheck();
  if (status !== 'passed') return null;
  return <>{children}</>;
}

/* ── Hook ── */

export function useEnvCheck(): EnvCheckContextValue {
  const context = useContext(EnvCheckContext);
  if (!context) {
    throw new Error('useEnvCheck must be used within EnvCheckProvider');
  }
  return context;
}
