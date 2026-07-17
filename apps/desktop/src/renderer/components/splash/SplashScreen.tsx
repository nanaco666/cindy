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

const APP_VERSION = '0.0.150';

/**
 * E6-B 双模式 splash(设计稿浅色版 230:1014 补齐,"固定深底"假设作废)。
 *
 * 背景与文案色跟随亮暗:
 *  - 背景底色走 frozen token `--splash-bg`(dark #2A2828 / light #EDEDED,opaque);
 *    设计要求 #120F0F@0.85 / #FFFFFF@0.93 透壁纸 + 背景模糊,但 splash 是 main 窗
 *    overlay(App.tsx:234,非独立 BrowserWindow),vibrancy 经 IPC 在主题加载后才应用,
 *    splash 时机早于 vibrancy + 闪白风险 → 按裁决回退 opaque 近似,透壁纸记 TODO。
 *  - 字标按模式换图(白/深);手写体用 mask 着色(dark #FFFFFF / light #9A9DA3 系);
 *    加载区/版本行文案 dark 沿用 frozen splash-text/muted,light 用 text-secondary(#9A9A3 系)。
 *  - 进度条恢复双套(dark 白 alpha / light 黑 alpha,沿用 E6 前既有值)。
 *
 * 状态机零删改(useSplash.ts 未动):14 phase 文案/进度/3 失败弹窗全保留,仅重排版到品牌块下方。
 * 零投影;不碰 theme 冻结区(splash-bg/text token 不动)。
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

  if (phase === 'splash_done' || phase === 'splash_skipped') return null;

  const isMac = window.electronAPI?.platform === 'darwin';

  // 模式取值:frozen splash token(dark)↔ text-secondary(light #9A9DA3 系);手写体 mask 着色。
  const wordmark = isDark ? splashWordmarkDark : splashWordmarkLight;
  const mutedColor = isDark ? 'hsl(var(--splash-text-muted))' : 'hsl(var(--text-secondary))'; // light 用二级信息灰 #9A9DA3 系
  const labelColor = isDark ? 'hsl(var(--splash-text))' : 'hsl(var(--text-secondary))';
  // 手写体 "Dream it Create it":dark #FFFFFF / light #9A9DA3 系(均 token,无 hex)。
  const scriptFill = isDark
    ? 'hsl(var(--splash-text-destructive))' // dark = #FFFFFF
    : 'hsl(var(--text-secondary))'; // light = #9A9DA3

  return (
    <div
      className={cn(
        'fixed inset-0 z-[9999] overflow-hidden',
        'bg-[hsl(var(--splash-bg))]', // 跟随亮暗(dark #2A2828 / light #EDEDED,opaque 近似)
        phase === 'fading_out' ? 'opacity-0' : 'opacity-100',
      )}
      style={
        {
          transition: 'opacity var(--splash-fade-duration) var(--splash-fade-easing)',
          WebkitAppRegion: 'drag',
        } as React.CSSProperties
      }
      onTransitionEnd={onTransitionEnd}
      aria-hidden="true"
    >
      {/* ── 品牌块:少女立绘(两模式共用,alpha 渐隐)+ CINDY 字标(白/深按模式)── 零投影 */}
      <img
        src={splashIllustration}
        alt=""
        draggable={false}
        onError={skipSplash}
        className="pointer-events-none absolute left-1/2 top-1/2 h-[105%] w-auto max-w-none -translate-x-1/2 -translate-y-1/2 object-contain"
      />
      {/* CINDY 字标:叠在立绘下沿(立绘下 1/3 区),水平居中;白字(深底)/深字(浅底)按模式。 */}
      <img
        src={wordmark}
        alt=""
        draggable={false}
        className="pointer-events-none absolute left-1/2 top-[68%] h-[78px] w-auto -translate-x-1/2 -translate-y-1/2 object-contain"
      />
      {/* 手写体 "Dream it Create it":右下角,alpha mask 着色(dark 白 / light 灰)。 */}
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-[8%] right-[10%] h-[40px] w-[140px]"
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
      />
      {/* 版本行:左下账户样式。 */}
      <div className="pointer-events-none absolute bottom-[6%] left-[8%] flex flex-col gap-1">
        <span className="text-[13px] font-medium" style={{ color: labelColor }}>
          CINDY
        </span>
        <span className="text-[11px] font-normal" style={{ color: mutedColor }}>
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
              style={tipsDestructive ? undefined : ({ color: mutedColor } as React.CSSProperties)}
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
