import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BRAND_WEBSITE_URL } from '@lizi/maker-shared/branding';

import { useEnvCheck } from '@/contexts/EnvCheckContext';
import { useAuth } from '@/contexts/AuthContext';
import { useUpdateStatus } from '@/hooks/useUpdateStatus';

/* ── Types ── */

export type SplashPhase =
  | 'init'
  | 'splash_checking_update'   // Phase 1: checking manifest for hot-update
  | 'splash_updating'          // Phase 1: downloading app update
  | 'splash_update_done'       // Phase 1: update ready, restarting
  | 'splash_manifest_failed'   // Phase 1: manifest fetch failed
  | 'splash_download_failed'   // Phase 1: hotfix 下载失败/校验失败，需要用户重试
  | 'splash_spawn_failed'      // Phase 1: updater spawn 失败（EACCES 等）
  | 'splash_checking'          // Phase 2: checking CCD binary
  | 'splash_downloading'       // Phase 2: downloading CCD binary
  | 'splash_passed'            // All checks done
  | 'splash_failed'            // CCD check failed
  | 'fading_out'
  | 'splash_done'
  | 'splash_skipped';

interface TipsInfo {
  tipsText: string | null;
  tipsClickable: boolean;
  tipsDestructive: boolean;
}

const MIN_DISPLAY_MS = 1500;
const FADE_FALLBACK_MS = 500;
// splash_update_done 阶段先让 "更新完成，等待自动重启..." 这段提示文案显示 1.5s，
// 再自动触发 relaunch，避免下载条刚到 100% 用户还没看清就直接整个窗口黑掉。
const AUTO_RELAUNCH_DELAY_MS = 1_500;

export function useSplash() {
  const { status: envStatus, downloadProgress, downloadInfo, updateVersion, step, totalSteps, resetSignal, checkEnvironment } = useEnvCheck();
  const { isInitializing: authInitializing } = useAuth();
  const { errorCode: updateErrorCode } = useUpdateStatus();

  const [phase, setPhase] = useState<SplashPhase>('init');
  const [minTimeElapsed, setMinTimeElapsed] = useState(false);

  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minTimeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Effect 1: minimum display timer ──
  useEffect(() => {
    minTimeTimerRef.current = setTimeout(() => setMinTimeElapsed(true), MIN_DISPLAY_MS);
    return () => {
      if (minTimeTimerRef.current !== null) {
        clearTimeout(minTimeTimerRef.current);
        minTimeTimerRef.current = null;
      }
    };
  }, []);

  // ── Effect 2: envStatus drives phase ──
  useEffect(() => {
    switch (envStatus) {
      case 'checking_update': setPhase('splash_checking_update'); break;
      case 'updating': setPhase('splash_updating'); break;
      case 'update_done': setPhase('splash_update_done'); break;
      case 'manifest_failed': setPhase('splash_manifest_failed'); break;
      case 'download_failed': setPhase('splash_download_failed'); break;
      case 'checking': setPhase('splash_checking'); break;
      case 'downloading': setPhase('splash_downloading'); break;
      case 'passed': setPhase('splash_passed'); break;
      case 'failed': setPhase('splash_failed'); break;
    }
  }, [envStatus]);

  // ── Effect 2b: updater spawn failure overrides the relaunch dialog ──
  useEffect(() => {
    if (updateErrorCode === 'updater_spawn_failed' && phase === 'splash_update_done') {
      setPhase('splash_spawn_failed');
    }
  }, [updateErrorCode, phase]);

  // ── Effect 3: fade-out trigger ──
  useEffect(() => {
    if (phase === 'splash_passed' && minTimeElapsed && !authInitializing) {
      setPhase('fading_out');
    }
  }, [phase, minTimeElapsed, authInitializing]);

  // ── Effect 4: fading_out fallback ──
  useEffect(() => {
    if (phase !== 'fading_out') return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const delay = reducedMotion ? 10 : FADE_FALLBACK_MS;

    fallbackTimerRef.current = setTimeout(() => {
      setPhase('splash_done');
    }, delay);

    return () => {
      if (fallbackTimerRef.current !== null) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
    };
  }, [phase]);

  // ── Tips derivation ──
  const tips: TipsInfo = useMemo<TipsInfo>(() => {
    switch (phase) {
      case 'splash_checking_update':
        return { tipsText: '检查更新中...', tipsClickable: false, tipsDestructive: false };
      case 'splash_updating':
        return { tipsText: '小镇更新中...', tipsClickable: false, tipsDestructive: false };
      case 'splash_update_done':
        return { tipsText: '更新完成，等待自动重启...', tipsClickable: false, tipsDestructive: false };
      case 'splash_manifest_failed':
        return { tipsText: null, tipsClickable: false, tipsDestructive: false }; // Dialog takes over
      case 'splash_download_failed':
        return { tipsText: null, tipsClickable: false, tipsDestructive: false }; // Dialog takes over
      case 'splash_spawn_failed':
        return { tipsText: null, tipsClickable: false, tipsDestructive: false }; // Dialog takes over
      case 'splash_checking':
        return { tipsText: '运行环境检测中...', tipsClickable: false, tipsDestructive: false };
      case 'splash_downloading': {
        // D 场景（两个 vendor 都需要下载）显示 (x/2) 进度标签；B/C 场景维持单文案。
        const suffix = step && totalSteps ? `(${step}/${totalSteps})` : '';
        return { tipsText: `正在召唤村民...${suffix}`, tipsClickable: false, tipsDestructive: false };
      }
      case 'splash_passed':
      case 'fading_out':
        return { tipsText: '正在进入小镇中...', tipsClickable: false, tipsDestructive: false };
      case 'splash_failed':
        return { tipsText: '环境初始化失败，点击重试', tipsClickable: true, tipsDestructive: true };
      default:
        return { tipsText: null, tipsClickable: false, tipsDestructive: false };
    }
  }, [phase, step, totalSteps]);

  // ── Dialogs ──
  // splash_update_done 不再用弹窗;改为先展示 "更新完成，等待自动重启..." tip,
  // AUTO_RELAUNCH_DELAY_MS 后由下面的 Effect 5 自动 relaunch。
  const showManifestFailedDialog = phase === 'splash_manifest_failed';
  const showDownloadFailedDialog = phase === 'splash_download_failed';
  const showSpawnFailedDialog = phase === 'splash_spawn_failed';

  const onRetryManifest = useCallback(() => {
    checkEnvironment();
  }, [checkEnvironment]);

  const onRetryDownload = useCallback(() => {
    checkEnvironment();
  }, [checkEnvironment]);

  // ── Effect 5: splash_update_done 自动 relaunch ──
  // 进入该 phase 表示补丁已下载就绪。短暂展示 "更新完成，等待自动重启..." 文案后
  // 自动触发 relaunch。用 ref 保证同一会话只触发一次;若期间 spawn 失败,Effect 2b
  // 会把 phase 切到 splash_spawn_failed,这里依然只是已经发过一次 IPC,由 spawn 失败
  // dialog 接管。
  const autoRelaunchFiredRef = useRef(false);
  useEffect(() => {
    if (phase !== 'splash_update_done') {
      autoRelaunchFiredRef.current = false;
      return;
    }
    if (autoRelaunchFiredRef.current) return;

    const timer = setTimeout(() => {
      autoRelaunchFiredRef.current = true;
      const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
      void window.electronAPI.autoRelaunchToUpdate(theme)
        .then((result) => {
          // Conditions may have changed since update-check-startup replied.
          // Re-enter the normal startup flow instead of leaving the user on a
          // permanent "waiting to restart" splash when main safely defers.
          if (!result.accepted) void checkEnvironment();
        })
        .catch(() => {
          // A successful relaunch normally destroys this renderer before the
          // invoke settles. If the process remains alive, retrying the startup
          // checks is the safest recovery from an IPC/handler failure.
          void checkEnvironment();
        });
    }, AUTO_RELAUNCH_DELAY_MS);

    return () => clearTimeout(timer);
  }, [phase, checkEnvironment]);

  const onSpawnFailedDownload = useCallback(() => {
    window.open(BRAND_WEBSITE_URL, '_blank');
  }, []);

  // ── Show progress bar during download phases ──
  const isDownloading = phase === 'splash_downloading' || phase === 'splash_updating';

  // ── Event handlers ──
  const onTipsClick = useCallback(() => {
    if (phase === 'splash_failed') {
      checkEnvironment();
    }
  }, [phase, checkEnvironment]);

  const onTransitionEnd = useCallback(
    (e: React.TransitionEvent) => {
      if (e.propertyName === 'opacity' && phase === 'fading_out') {
        setPhase('splash_done');
      }
    },
    [phase],
  );

  const skipSplash = useCallback(() => {
    if (fallbackTimerRef.current !== null) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    if (minTimeTimerRef.current !== null) {
      clearTimeout(minTimeTimerRef.current);
      minTimeTimerRef.current = null;
    }
    setPhase('splash_skipped');
  }, []);

  return {
    phase,
    isDownloading,
    downloadProgress,
    downloadInfo,
    resetSignal,
    tipsText: tips.tipsText,
    tipsClickable: tips.tipsClickable,
    tipsDestructive: tips.tipsDestructive,
    showManifestFailedDialog,
    showDownloadFailedDialog,
    showSpawnFailedDialog,
    updateVersion,
    onRetryManifest,
    onRetryDownload,
    onSpawnFailedDownload,
    onTipsClick,
    onTransitionEnd,
    skipSplash,
  };
}
