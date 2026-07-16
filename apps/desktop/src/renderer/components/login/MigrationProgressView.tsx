import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { BRAND_NAME } from '@lizi/maker-shared/branding';

import { useAuth } from '@/contexts/AuthContext';
import { migrationService, type MigrationProgress } from '@/lib/migrationService';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { cn } from '@/lib/utils';
import { useBrandLogo } from '@/hooks/useBrandLogo';
import { createLogger } from '@/lib/logger';

const log = createLogger('MigrationProgressView');

/**
 * chat-data-localization F4 / M-FE5：迁移过渡页（Migration Progress View）。
 *
 * 设计稿：doc/design_docs/login.pen 的 8 个 Migration frame
 *   - Initial / InProgress / Retrying / Failed × Light / Dark
 *
 * 行为：
 *   - 挂载时：根据本地 status decide start vs resume
 *   - 订阅 IPC progress 事件 → 更新进度条 + 文案 + 重试小字 + 失败弹窗
 *   - failed → AlertDialog（"稍后再试" / "现在跳过"）；跳过走二次确认
 *   - done → 200ms 缓冲后 navigate('/cc-agent')
 *   - 总数（分母）来源优先级：location.state > AuthContext.migration > 0
 */
interface LocationStateTotals {
  totalSessions?: number;
  totalMessages?: number;
}

export function MigrationProgressView() {
  const navigate = useNavigate();
  const location = useLocation();
  const brandLogo = useBrandLogo();
  const { migration: ctxMigration } = useAuth();
  const { t } = useTranslation();

  const stateTotals = (location.state ?? {}) as LocationStateTotals;
  const ctxTotals =
    ctxMigration?.status === 'pending'
      ? {
          totalSessions: ctxMigration.totalSessions,
          totalMessages: ctxMigration.totalMessages,
        }
      : { totalSessions: 0, totalMessages: 0 };

  const initialTotalSessions = stateTotals.totalSessions ?? ctxTotals.totalSessions ?? 0;
  const initialTotalMessages = stateTotals.totalMessages ?? ctxTotals.totalMessages ?? 0;
  const initialTotal = initialTotalSessions;

  const [progress, setProgress] = useState<MigrationProgress>({ phase: 'idle' });
  const [showFailDialog, setShowFailDialog] = useState(false);
  const [showSkipConfirm, setShowSkipConfirm] = useState(false);

  // Avoid double-start (StrictMode mounts twice in dev)
  const startedRef = useRef(false);
  const isMac = window.electronAPI?.platform === 'darwin';

  useEffect(() => {
    const unsub = migrationService.onProgress((p) => {
      setProgress(p);
      if (p.phase === 'failed') {
        setShowFailDialog(true);
      }
      if (p.phase === 'done') {
        // 200ms 缓冲让最后一帧"100%"被用户看到，再跳转
        window.setTimeout(() => {
          navigate('/cc-agent', { replace: true });
        }, 200);
      }
    });

    if (!startedRef.current) {
      startedRef.current = true;
      (async () => {
        const localStatus = await migrationService.getStatus();
        if (localStatus === 'in_progress') {
          // 续传——main 内部从 last_session_id 继续；不重置 totals
          await migrationService.resume();
        } else if (localStatus === 'done' || localStatus === 'skipped') {
          // 已完成/跳过：用户不应再到这页（MigrationGate 会兜底），保险起见直接出
          navigate('/cc-agent', { replace: true });
        } else {
          // pending / null → 首次启动迁移
          await migrationService.start({
            totalSessions: initialTotalSessions,
            totalMessages: initialTotalMessages,
          });
        }
      })().catch((err) => {
        log.error('kickoff failed', err);
      });
    }

    return () => {
      unsub();
    };
  }, [initialTotalMessages, initialTotalSessions, navigate]);

  // ── 进度条百分比 ────────────────────────────────────────────────
  const totalForBar =
    'total' in progress && progress.total > 0 ? progress.total : initialTotal;
  const syncedForBar = 'synced' in progress ? progress.synced : 0;
  const percent =
    progress.phase === 'idle'
      ? 0
      : Math.min(
          100,
          Math.round((syncedForBar / Math.max(totalForBar, 1)) * 100),
        );

  // ── 进度条颜色（按状态切换 token） ───────────────────────────────
  const fillColorVar = useMemo(() => {
    if (progress.phase === 'failed') return 'var(--migration-bar-fill-failed)';
    if (progress.phase === 'retrying') return 'var(--migration-bar-fill-retry)';
    return 'var(--migration-bar-fill)';
  }, [progress.phase]);

  // ── Detail 文案（与设计稿 4 个 frame 对齐） ───────────────────────
  const detailText = useMemo(() => {
    if (progress.phase === 'idle') return t('migration.detail.idle');
    if (progress.phase === 'failed' || progress.phase === 'retrying') {
      return t('migration.detail.paused', { synced: syncedForBar, total: totalForBar });
    }
    if (progress.phase === 'running') {
      if (progress.etaSeconds) {
        return t('migration.detail.runningWithEta', {
          synced: syncedForBar,
          total: totalForBar,
          eta: formatEta(progress.etaSeconds, t),
        });
      }
      return t('migration.detail.running', { synced: syncedForBar, total: totalForBar });
    }
    if (progress.phase === 'done') {
      return t('migration.detail.done', { synced: syncedForBar, total: totalForBar });
    }
    return '';
  }, [progress, syncedForBar, totalForBar, t]);

  // ── Card wrapper opacity（failed 时 0.5 让 dialog 凸出） ─────────
  const cardWrapperOpacity = progress.phase === 'failed' ? 0.5 : 1;

  // ── Handlers ─────────────────────────────────────────────────────
  const handleRetryLater = useCallback(() => {
    // "稍后再试"——纯关弹窗；用户可自行重启或等下次启动续传
    setShowFailDialog(false);
  }, []);

  const handleOpenSkipConfirm = useCallback(() => {
    setShowFailDialog(false);
    setShowSkipConfirm(true);
  }, []);

  const handleConfirmSkip = useCallback(async () => {
    try {
      await migrationService.abort();
      await migrationService.setStatus('skipped');
    } catch (err) {
      log.error('skip failed', err);
    } finally {
      setShowSkipConfirm(false);
      navigate('/cc-agent', { replace: true });
    }
  }, [navigate]);

  return (
    <div className="flex min-h-screen flex-col bg-[var(--login-bg)]">
      {/* Drag area + window controls — 与 LoginPage 一致的 46px toolbar */}
      <div
        className="flex h-[46px] w-full shrink-0 items-center justify-end"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {!isMac && (
          <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <WindowControls />
          </div>
        )}
      </div>

      {/* Card wrapper — vertically centered */}
      <div
        className="flex flex-1 flex-col items-center justify-center transition-opacity"
        style={{ opacity: cardWrapperOpacity }}
      >
        <div
          className={cn(
            'flex w-[560px] flex-col items-center rounded-[12px] p-[48px]',
            'border border-[var(--login-card-border)] bg-[var(--login-card-bg)]',
          )}
        >
          {/* Logo — 横向 wordmark,定宽、高度按比例(与 LoginPage 一致) */}
          <img
            src={brandLogo}
            alt={BRAND_NAME}
            className="w-[216px] object-contain pointer-events-none"
            draggable={false}
          />

          {/* Spacer 32 */}
          <div className="h-[32px] w-full shrink-0" />

          {/* Title — Inter 24 SemiBold lineHeight 1.33 — center */}
          <h1
            className={cn(
              'w-full text-center font-semibold text-foreground',
              'text-[24px] leading-[1.33]',
            )}
          >
            {t('migration.title')}
          </h1>

          {/* Spacer 12 */}
          <div className="h-[12px] w-full shrink-0" />

          {/* Subtitle — Inter 14 normal lineHeight 1.5 — Stone */}
          <p className="w-full text-center text-[14px] leading-[1.5] text-[var(--login-help-text)]">
            {t('migration.subtitle')}
          </p>

          {/* Spacer 32 */}
          <div className="h-[32px] w-full shrink-0" />

          {/* Progress bar — 480×8 px, radius 9999 */}
          <div
            className="relative h-[8px] w-[480px] overflow-hidden rounded-full"
            style={{
              backgroundColor: 'var(--migration-bar-track)',
              border: '1px solid var(--migration-bar-track-border)',
            }}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div
              className="h-full rounded-full transition-[width,background-color] duration-300 ease-out"
              style={{
                width: `${percent}%`,
                backgroundColor: fillColorVar,
              }}
            />
          </div>

          {/* Spacer 16 */}
          <div className="h-[16px] w-full shrink-0" />

          {/* Detail caption — Inter 12 normal lineHeight 1.33 */}
          <p className="w-full text-center text-[12px] leading-[1.33] text-[var(--migration-detail-text)]">
            {detailText}
          </p>

          {/* Retry notice — only when retrying — Inter 12 SemiBold #EF4444 */}
          {progress.phase === 'retrying' && (
            <>
              <div className="h-[8px] w-full shrink-0" />
              <p
                className="w-full text-center text-[12px] font-semibold leading-[1.33]"
                style={{ color: 'var(--migration-retry-text)' }}
              >
                {t('migration.retryNotice', { attempt: progress.attempt })}
              </p>
            </>
          )}
        </div>
      </div>

      {/* Failed AlertDialog — 设计稿 yvVC8 frame */}
      <AlertDialog.Root open={showFailDialog} onOpenChange={setShowFailDialog}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay
            className="fixed inset-0 z-[10000]"
            style={{ backgroundColor: 'var(--migration-overlay)' }}
          />
          <AlertDialog.Content
            className={cn(
              'fixed left-1/2 top-1/2 z-[10000] -translate-x-1/2 -translate-y-1/2',
              'flex w-[440px] flex-col gap-5 rounded-[12px] p-[32px]',
              'border border-[var(--login-card-border)] bg-[var(--login-card-bg)]',
            )}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <div className="flex flex-col gap-2">
              <AlertDialog.Title className="text-[18px] font-semibold leading-[1.33] text-foreground">
                {t('migration.failedDialog.title')}
              </AlertDialog.Title>
              <AlertDialog.Description className="text-[14px] leading-[1.5] text-[var(--login-help-text)]">
                {t('migration.failedDialog.description')}
              </AlertDialog.Description>
            </div>
            <div className="flex justify-end gap-3">
              {/* Skip button — White Pill secondary */}
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  onClick={handleOpenSkipConfirm}
                  className={cn(
                    'inline-flex items-center justify-center rounded-full',
                    'px-6 py-[10px] text-[14px] font-medium leading-[1.43]',
                    'border border-[var(--update-btn-border)] bg-[var(--login-card-bg)] text-[var(--update-btn-text)]',
                    'hover:bg-[var(--update-btn-hover)]',
                    'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                  )}
                >
                  {t('migration.failedDialog.skip')}
                </button>
              </AlertDialog.Cancel>
              {/* Retry button — Black Pill primary */}
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  onClick={handleRetryLater}
                  className={cn(
                    'inline-flex items-center justify-center rounded-full',
                    'px-6 py-[10px] text-[14px] font-medium leading-[1.43]',
                    'bg-[var(--login-btn-bg)] text-[var(--login-btn-text)]',
                    'hover:bg-[var(--login-btn-hover)]',
                    'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                  )}
                >
                  {t('migration.failedDialog.retry')}
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      {/* Skip confirm — 二次确认 */}
      <AlertDialog.Root open={showSkipConfirm} onOpenChange={setShowSkipConfirm}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay
            className="fixed inset-0 z-[10000]"
            style={{ backgroundColor: 'var(--migration-overlay)' }}
          />
          <AlertDialog.Content
            className={cn(
              'fixed left-1/2 top-1/2 z-[10000] -translate-x-1/2 -translate-y-1/2',
              'flex w-[440px] flex-col gap-5 rounded-[12px] p-[32px]',
              'border border-[var(--login-card-border)] bg-[var(--login-card-bg)]',
            )}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <div className="flex flex-col gap-2">
              <AlertDialog.Title className="text-[18px] font-semibold leading-[1.33] text-foreground">
                {t('migration.skipConfirm.title')}
              </AlertDialog.Title>
              <AlertDialog.Description className="text-[14px] leading-[1.5] text-[var(--login-help-text)]">
                {t('migration.skipConfirm.description')}
              </AlertDialog.Description>
            </div>
            <div className="flex justify-end gap-3">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  className={cn(
                    'inline-flex items-center justify-center rounded-full',
                    'px-6 py-[10px] text-[14px] font-medium leading-[1.43]',
                    'border border-[var(--update-btn-border)] bg-[var(--login-card-bg)] text-[var(--update-btn-text)]',
                    'hover:bg-[var(--update-btn-hover)]',
                    'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                  )}
                >
                  {t('migration.skipConfirm.back')}
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  onClick={handleConfirmSkip}
                  className={cn(
                    'inline-flex items-center justify-center rounded-full',
                    'px-6 py-[10px] text-[14px] font-medium leading-[1.43]',
                    'bg-[var(--login-btn-bg)] text-[var(--login-btn-text)]',
                    'hover:bg-[var(--login-btn-hover)]',
                    'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                  )}
                >
                  {t('migration.skipConfirm.confirm')}
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}

function formatEta(seconds: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return t('migration.eta.seconds', { seconds: Math.ceil(seconds) });
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (s === 0) return t('migration.eta.minutes', { m });
  return t('migration.eta.minutesSeconds', { m, s });
}
