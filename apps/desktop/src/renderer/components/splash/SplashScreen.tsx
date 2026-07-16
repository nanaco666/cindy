import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useSplash } from '@/hooks/useSplash';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useBrandLogo } from '@/hooks/useBrandLogo';

export function SplashScreen() {
  const { t } = useTranslation();
  const brandLogo = useBrandLogo();
  const {
    phase,
    isDownloading,
    downloadProgress,
    downloadInfo,
    resetSignal,
    tipsText,
    tipsClickable,
    tipsDestructive,
    showManifestFailedDialog,
    showDownloadFailedDialog,
    showSpawnFailedDialog,
    onRetryManifest,
    onRetryDownload,
    onSpawnFailedDownload,
    onTipsClick,
    onTransitionEnd,
    skipSplash,
  } = useSplash();

  // D 场景顺序下载切换 codex 段时主进程发 reset payload，resetSignal 自增。
  // skipTransition 必须和 width=0 同帧生效，否则 transition 已经先把 100→0 跑成动画。
  // 用 ref 滞后一帧：本次渲染若 resetSignal 变了 → skipTransition=true 直接进 DOM；
  // 渲染提交后 effect 把 ref 追平，下次正常 progress 更新就恢复动画。
  const prevResetRef = useRef(resetSignal);
  const skipTransition = resetSignal !== prevResetRef.current;
  useEffect(() => {
    prevResetRef.current = resetSignal;
  });

  if (phase === 'splash_done' || phase === 'splash_skipped') return null;

  const isMac = window.electronAPI?.platform === 'darwin';

  return (
    <div
      className={cn(
        'fixed inset-0 z-[9999]',
        'bg-[hsl(var(--splash-bg))]',
        phase === 'fading_out' ? 'opacity-0' : 'opacity-100',
      )}
      style={{
        transition: 'opacity var(--splash-fade-duration) var(--splash-fade-easing)',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
      onTransitionEnd={onTransitionEnd}
      aria-hidden="true"
    >
      {/* Toolbar: z-10 to stay above absolute layers */}
      <div className="relative z-10 flex h-[46px] shrink-0 items-center justify-end px-2">
        {!isMac && (
          <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <WindowControls iconClassName="text-[hsl(var(--splash-text))]" />
          </div>
        )}
      </div>

      {/* Logo — absolute center of entire window (ignores toolbar) */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex h-[490px] w-[490px] items-center justify-center">
          <img
            src={brandLogo}
            alt=""
            className="w-[464px] object-contain"
            draggable={false}
            onError={skipSplash}
          />
        </div>
      </div>

      {/* Loading Area — centered in window, offset below center by paddingTop */}
      <div
        className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
        style={{ paddingTop: '320px' }}
      >
        <div className="flex flex-col items-center gap-6">
          {/* Tip Row */}
          {tipsText !== null && (
            <div className="flex items-center gap-2">
              <p
                className={cn(
                  'text-[14px] leading-[1.43]',
                  tipsDestructive
                    ? 'font-medium underline text-[hsl(var(--splash-text-destructive))]'
                    : 'font-normal text-[hsl(var(--splash-text))]',
                  tipsClickable && 'cursor-pointer underline pointer-events-auto',
                )}
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                onClick={tipsClickable ? onTipsClick : undefined}
              >
                {tipsText}
              </p>
            </div>
          )}

          {/* Spinner Group: progress bar + stats */}
          {isDownloading && (
            <div className="flex flex-col items-center gap-1.5">
              {/* Progress Bar: 192x4, rounded 2px */}
              <div
                className={cn(
                  'h-[4px] w-[192px] overflow-hidden rounded-[2px]',
                  'bg-[#00000015] dark:bg-[#ffffff26]',
                )}
              >
                <div
                  className={cn(
                    'h-full rounded-[2px]',
                    skipTransition ? '' : 'transition-[width] duration-300',
                    'bg-[#00000060] dark:bg-[#ffffff99]',
                  )}
                  style={{ width: `${downloadProgress}%` }}
                />
              </div>

              {/* Stats Row: gap 6, 12px font */}
              <div className="flex items-center gap-1.5 text-[12px] font-normal">
                <span className="text-[hsl(var(--splash-text))]">
                  {downloadProgress}%
                </span>
                {downloadInfo.speed && (
                  <>
                    <span className="text-[hsl(var(--splash-text-muted))]">·</span>
                    <span className="text-[hsl(var(--splash-text))]">
                      {downloadInfo.speed}
                    </span>
                  </>
                )}
                {downloadInfo.downloaded && downloadInfo.total && (
                  <>
                    <span className="text-[hsl(var(--splash-text-muted))]">·</span>
                    <span className="text-[hsl(var(--splash-text))]">
                      {downloadInfo.downloaded} / {downloadInfo.total}
                    </span>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Manifest failed dialog (network error, retry) ── */}
      <ConfirmDialog
        open={showManifestFailedDialog}
        onOpenChange={() => {}}
        title={t('splash.manifestFailed.title')}
        description={t('splash.manifestFailed.description')}
        confirmText={t('splash.manifestFailed.confirm')}
        showCancel={false}
        onConfirm={onRetryManifest}
      />

      {/* ── Download failed dialog (hotfix download/verify failed, retry) ── */}
      <ConfirmDialog
        open={showDownloadFailedDialog}
        onOpenChange={() => {}}
        title={t('splash.downloadFailed.title')}
        description={t('splash.downloadFailed.description')}
        confirmText={t('splash.downloadFailed.confirm')}
        showCancel={false}
        onConfirm={onRetryDownload}
      />

      {/* ── Spawn failed dialog (updater exe could not be launched) ── */}
      <ConfirmDialog
        open={showSpawnFailedDialog}
        onOpenChange={() => {}}
        title={t('splash.spawnFailed.title')}
        description={t('splash.spawnFailed.description')}
        confirmText={t('splash.spawnFailed.confirm')}
        showCancel={false}
        onConfirm={onSpawnFailedDownload}
      />
    </div>
  );
}
