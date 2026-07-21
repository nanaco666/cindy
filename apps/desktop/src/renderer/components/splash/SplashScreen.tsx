import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useSplash } from '@/hooks/useSplash';
import { useIsDarkMode } from '@/components/markdown/useIsDarkMode';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
// E6 品牌素材:少女立绘(两模式共用,alpha 渐隐)+ CINDY 字标(白/深双版)+ 手写体。
import splashIllustration from '@/assets/splash/illustration.webp';
import splashWordmarkDark from '@/assets/splash/wordmark.png'; // 白字标(深底)
import splashWordmarkLight from '@/assets/splash/wordmark-light.png'; // 深字标(浅底)
import splashScript from '@/assets/splash/script.png'; // 手写体 alpha(mask 着色)

/**
 * Splash v2 双模式启动画面。
 *
 * 状态机零删改(useSplash.ts 未动):14 phase 文案/进度/3 失败弹窗全保留,仅重排品牌块。
 * 背景为不透明 --surface(2026-07-19 用户拍板:加载完成前完全遮盖底下主界面),
 * 不使用 CSS backdrop-filter。
 */
export function SplashScreen() {
  const { t } = useTranslation();
  const isDark = useIsDarkMode();
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

  // D 场景顺序下载切换 codex 段时主进程发 reset payload,resetSignal 自增。
  // skipTransition 必须和 width=0 同帧生效,否则 transition 已经先把 100→0 跑成动画。
  // 用 ref 滞后一帧:本次渲染若 resetSignal 变了 → skipTransition=true 直接进 DOM;
  // 渲染提交后 effect 把 ref 追平,下次正常 progress 更新就恢复动画。
  const prevResetRef = useRef(resetSignal);
  const skipTransition = resetSignal !== prevResetRef.current;
  useEffect(() => {
    prevResetRef.current = resetSignal;
  });

  useEffect(() => {
    const root = document.documentElement;
    if (phase !== 'fading_out' && phase !== 'splash_done' && phase !== 'splash_skipped') {
      root.setAttribute('data-splash-active', '1');
    } else {
      root.removeAttribute('data-splash-active');
    }

    return () => {
      root.removeAttribute('data-splash-active');
    };
  }, [phase]);

  if (phase === 'splash_done' || phase === 'splash_skipped') return null;

  const isMac = window.electronAPI?.platform === 'darwin';

  // 模式取值:frozen splash token(dark)↔ text-secondary(light #9A9DA3 系);手写体 mask 着色。
  const wordmark = isDark ? splashWordmarkDark : splashWordmarkLight;
  const mutedColor = isDark ? 'hsl(var(--splash-text-muted))' : 'hsl(var(--text-secondary))'; // light 用二级信息灰 #9A9DA3 系
  // 手写体 "Dream it Create it":按 v2 规格固定为 dark #FFFFFF / light #9499A2。
  const scriptFill = isDark ? '#ffffff' : '#9499a2';

  return (
    <div
      className={cn(
        'fixed inset-0 z-[9999] overflow-hidden',
        phase === 'fading_out' ? 'opacity-0' : 'opacity-100',
      )}
      style={
        {
          // 2026-07-19 用户拍板:splash 期间必须完全盖住底下已挂载的主界面——
          // 换不透明 --surface(全主题皆不透明);半透明侧栏材质会把 app UI 透出来。
          background: 'var(--surface)',
          transition: 'opacity var(--splash-fade-duration) var(--splash-fade-easing)',
          WebkitAppRegion: 'drag',
        } as React.CSSProperties
      }
      onTransitionEnd={onTransitionEnd}
      aria-hidden="true"
    >
      {/* ── 品牌块:按设计稿固定自然尺寸排布,矮窗口整体等比缩放 ── */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[19.3%] h-[424.5px] w-[457px]"
        style={{
          transform: 'translateX(-50%) scale(min(1, calc(100vh / 700px)))',
          transformOrigin: 'top center',
        }}
        data-testid="splash-brand"
      >
        <img
          src={splashIllustration}
          alt=""
          draggable={false}
          onError={skipSplash}
          className="pointer-events-none absolute left-1/2 top-0 h-[457px] w-[457px] max-w-none -translate-x-1/2 object-contain"
          data-testid="splash-illustration"
        />
        {/* CINDY 字标:叠在立绘下三分之一,水平居中;白字(深底)/深字(浅底)按模式。 */}
        <img
          src={wordmark}
          alt=""
          draggable={false}
          className="pointer-events-none absolute left-1/2 top-[352.5px] h-[78px] w-[229.5px] -translate-x-1/2 object-contain drop-shadow-[0_2px_6.5px_rgba(0,0,0,0.25)]"
          data-testid="splash-wordmark"
        />
        {/* 手写体 "Dream it Create it":字标右缘 +9px,与字标底部略交叠。 */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-[352.25px] top-[410px] h-[89.5px] w-[225.5px]"
          style={{
            backgroundColor: scriptFill,
            WebkitMaskImage: `url(${splashScript})`,
            WebkitMaskRepeat: 'no-repeat',
            WebkitMaskPosition: 'center',
            WebkitMaskSize: 'contain',
            maskImage: `url(${splashScript})`,
            maskRepeat: 'no-repeat',
            maskPosition: 'center',
            maskSize: 'contain',
          }}
          data-testid="splash-script"
        />
      </div>

      {/* Toolbar:z-10 to stay above absolute layers(关闭/最小化,仅 Windows 原生 chrome) */}
      <div className="relative z-10 flex h-[46px] shrink-0 items-center justify-end px-2">
        {!isMac && (
          <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <WindowControls iconClassName="text-[hsl(var(--splash-text))]" />
          </div>
        )}
      </div>

      {/* ── 加载区:品牌块下方居中,弱化二级灰,状态机零删改 ── */}
      <div className="absolute inset-x-0 bottom-[18%] flex flex-col items-center justify-center gap-6 pointer-events-none">
        {/* Tip Row(14 phase 文案,居中、二级灰;destructive 态保留可点+下划线) */}
        {tipsText !== null && (
          <div className="flex items-center gap-2">
            <p
              className={cn(
                'text-[13px] leading-[1.43]',
                tipsDestructive
                  ? 'font-medium underline text-[hsl(var(--splash-text-destructive))]'
                  : 'font-normal',
                tipsClickable && 'cursor-pointer underline pointer-events-auto',
              )}
              style={
                {
                  color: tipsDestructive ? undefined : mutedColor,
                  // The splash root is an Electron drag region. Keep the retry tip
                  // in a no-drag hole so its click can reach the renderer.
                  WebkitAppRegion: tipsClickable ? 'no-drag' : undefined,
                } as React.CSSProperties
              }
              onClick={tipsClickable ? onTipsClick : undefined}
            >
              {tipsText}
            </p>
          </div>
        )}

        {/* Spinner Group:进度条 + 统计(下载态显示,弱化二级灰) */}
        {isDownloading && (
          <div className="flex flex-col items-center gap-1.5">
            {/* Progress Bar: 192x4, rounded 2px;双套(light 黑 alpha / dark 白 alpha) */}
            <div className="h-[4px] w-[192px] overflow-hidden rounded-[2px] bg-[#00000015] dark:bg-[#ffffff26]">
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
            <div
              className="flex items-center gap-1.5 text-[12px] font-normal"
              style={{ color: mutedColor }}
            >
              <span>{downloadProgress}%</span>
              {downloadInfo.speed && (
                <>
                  <span>·</span>
                  <span>{downloadInfo.speed}</span>
                </>
              )}
              {downloadInfo.downloaded && downloadInfo.total && (
                <>
                  <span>·</span>
                  <span>
                    {downloadInfo.downloaded} / {downloadInfo.total}
                  </span>
                </>
              )}
            </div>
          </div>
        )}
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
