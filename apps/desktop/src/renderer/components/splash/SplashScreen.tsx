import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useSplash } from '@/hooks/useSplash';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
// E6 品牌素材(少女立绘底部渐隐 + CINDY 白字标 + 手写体 Dream it Create it)。
// 来自 figma-login-assets/(splash-illustration-fade@2x / splash-wordmark@2x / desktop-script@2x)。
import splashIllustration from '@/assets/splash/illustration.webp';
import splashWordmark from '@/assets/splash/wordmark.png';
import splashScript from '@/assets/splash/script.png';

/**
 * 固定深底:splash 是 CINDY 品牌启动屏,设计只给深底版(Figma 230:520 变体 B),
 * 不随亮暗切换。splash-bg/text 等 token 被 cindyDecisionData.ts 钉在
 * light=#EDEDED / dark=#2A2828,无法在 cindy-light.ts 把 splash-bg 改 dark
 * (会破坏 cindyDecisionData 断言 + 越一哥 E5D 地盘)。故在 splash 根局部
 * override 这些 CSS var 为 dark 值(cindy-dark.ts 同值),仅影响 splash 子树,
 * 不动 theme 文件 / cindyDecisionData。⚠️ 固定深底假设待用户确认(见 E6 报告)。
 */
const FIXED_DARK_SPLASH_VARS: React.CSSProperties = {
  '--splash-bg': '0.0 2.4% 16.1%', // #2A2828 CINDY dark surface
  '--splash-text': '216.0 4.1% 75.9%', // #BFC1C4 AA splash text(dark 版)
  '--splash-text-muted': '216.0 4.1% 75.9%', // #BFC1C4
  '--splash-text-destructive': '0.0 0.0% 100.0%', // 白
} as React.CSSProperties;

const APP_VERSION = '0.0.150';

export function SplashScreen() {
  const { t } = useTranslation();
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

  if (phase === 'splash_done' || phase === 'splash_skipped') return null;

  const isMac = window.electronAPI?.platform === 'darwin';

  return (
    <div
      className={cn(
        'fixed inset-0 z-[9999] overflow-hidden',
        'bg-[hsl(var(--splash-bg))]',
        phase === 'fading_out' ? 'opacity-0' : 'opacity-100',
      )}
      style={
        {
          ...FIXED_DARK_SPLASH_VARS,
          transition: 'opacity var(--splash-fade-duration) var(--splash-fade-easing)',
          WebkitAppRegion: 'drag',
        } as React.CSSProperties
      }
      onTransitionEnd={onTransitionEnd}
      aria-hidden="true"
    >
      {/* ── 品牌块:少女立绘(底部渐隐,绝对定位)+ CINDY 白字标(叠在立绘下沿)── 零投影 */}
      {/* 立绘:水平居中、垂直偏下,底部渐隐遮罩已烧进 PNG。 */}
      <img
        src={splashIllustration}
        alt=""
        draggable={false}
        onError={skipSplash}
        className="pointer-events-none absolute left-1/2 top-1/2 h-[105%] w-auto max-w-none -translate-x-1/2 -translate-y-1/2 object-contain"
      />
      {/* CINDY 白字标:叠在立绘下沿(立绘下 1/3 区),水平居中。 */}
      <img
        src={splashWordmark}
        alt=""
        draggable={false}
        className="pointer-events-none absolute left-1/2 top-[68%] h-[78px] w-auto -translate-x-1/2 -translate-y-1/2 object-contain"
      />
      {/* 手写体 "Dream it Create it":右下角。 */}
      <img
        src={splashScript}
        alt=""
        draggable={false}
        className="pointer-events-none absolute bottom-[8%] right-[10%] h-[40px] w-auto object-contain opacity-90"
      />
      {/* 版本行:左下账户样式。 */}
      <div className="pointer-events-none absolute bottom-[6%] left-[8%] flex flex-col gap-1">
        <span className="text-[13px] font-medium text-[hsl(var(--splash-text))]">CINDY</span>
        <span className="text-[11px] font-normal text-[hsl(var(--splash-text-muted))]">
          XD.Inc · {APP_VERSION}
        </span>
      </div>

      {/* Toolbar:z-10 to stay above absolute layers(关闭/最小化,仅 Windows 原生 chrome) */}
      <div className="relative z-10 flex h-[46px] shrink-0 items-center justify-end px-2">
        {!isMac && (
          <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <WindowControls iconClassName="text-[hsl(var(--splash-text))]" />
          </div>
        )}
      </div>

      {/* ── 加载区:品牌块下方居中,弱化二级灰(splash-text-muted),状态机零删改 ── */}
      <div className="absolute inset-x-0 bottom-[18%] flex flex-col items-center justify-center gap-6 pointer-events-none">
        {/* Tip Row(14 phase 文案,居中、二级灰;destructive 态保留可点+下划线) */}
        {tipsText !== null && (
          <div className="flex items-center gap-2">
            <p
              className={cn(
                'text-[13px] leading-[1.43]',
                tipsDestructive
                  ? 'font-medium underline text-[hsl(var(--splash-text-destructive))]'
                  : 'font-normal text-[hsl(var(--splash-text-muted))]',
                tipsClickable && 'cursor-pointer underline pointer-events-auto',
              )}
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              onClick={tipsClickable ? onTipsClick : undefined}
            >
              {tipsText}
            </p>
          </div>
        )}

        {/* Spinner Group:进度条 + 统计(下载态显示,弱化二级灰) */}
        {isDownloading && (
          <div className="flex flex-col items-center gap-1.5">
            {/* Progress Bar: 192x4, rounded 2px */}
            <div
              className={cn('h-[4px] w-[192px] overflow-hidden rounded-[2px]', 'bg-[#ffffff26]')}
            >
              <div
                className={cn(
                  'h-full rounded-[2px]',
                  skipTransition ? '' : 'transition-[width] duration-300',
                  'bg-[#ffffff99]',
                )}
                style={{ width: `${downloadProgress}%` }}
              />
            </div>

            {/* Stats Row: gap 6, 12px font */}
            <div className="flex items-center gap-1.5 text-[12px] font-normal">
              <span className="text-[hsl(var(--splash-text-muted))]">{downloadProgress}%</span>
              {downloadInfo.speed && (
                <>
                  <span className="text-[hsl(var(--splash-text-muted))]">·</span>
                  <span className="text-[hsl(var(--splash-text-muted))]">{downloadInfo.speed}</span>
                </>
              )}
              {downloadInfo.downloaded && downloadInfo.total && (
                <>
                  <span className="text-[hsl(var(--splash-text-muted))]">·</span>
                  <span className="text-[hsl(var(--splash-text-muted))]">
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
