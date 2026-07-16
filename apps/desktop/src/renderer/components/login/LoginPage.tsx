import { useTranslation } from 'react-i18next';
import { FlaskConical, Link } from 'lucide-react';
import { BRAND_NAME } from '@lizi/maker-shared/branding';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { useBrandLogo } from '@/hooks/useBrandLogo';
import { useLogin } from '@/hooks/useLogin';

export function LoginPage() {
  const { isLoading, error, handleLogin, handleDevLogin } = useLogin();
  const brandLogo = useBrandLogo();
  const { t } = useTranslation();
  const isMac = window.electronAPI?.platform === 'darwin';
  const showDevLogin = import.meta.env.DEV;

  return (
    <div className="flex min-h-screen flex-col bg-[var(--login-bg)]">
      {/* Drag area + window controls */}
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
      <div className="flex flex-1 flex-col items-center justify-center">
        <div
          className={cn(
            'flex w-[400px] flex-col items-center rounded-[12px] p-[48px]',
            'border border-[var(--login-card-border)] bg-[var(--login-card-bg)]',
          )}
        >
          {/* Logo — 横向 wordmark,定宽、高度按比例 */}
          <img
            src={brandLogo}
            alt={BRAND_NAME}
            className="w-[216px] object-contain pointer-events-none"
            draggable={false}
          />

          {/* Spacer 32px */}
          <div className="h-[32px] w-full shrink-0" />

          {/* Divider */}
          <div className="h-px w-full bg-[var(--login-divider)]" />

          {/* Spacer 24px */}
          <div className="h-[24px] w-full shrink-0" />

          {/* Login Button — Black Pill CTA */}
          <button
            onClick={handleLogin}
            disabled={isLoading}
            className={cn(
              'inline-flex h-[48px] w-full items-center justify-center gap-2 rounded-full',
              'px-6 text-[16px] font-medium leading-[1.33] transition-colors',
              'bg-[var(--login-btn-bg)] text-[var(--login-btn-text)]',
              'hover:bg-[var(--login-btn-hover)]',
              'disabled:opacity-60 disabled:cursor-not-allowed',
            )}
          >
            {isLoading ? (
              <>
                <Spinner size={20} />
                {t('login.signingIn')}
              </>
            ) : (
              <>
                <Link size={20} />
                {t('login.feishuLogin')}
              </>
            )}
          </button>

          {showDevLogin && (
            <>
              <div className="h-[10px] w-full shrink-0" />
              <button
                onClick={handleDevLogin}
                disabled={isLoading}
                className={cn(
                  'inline-flex h-[44px] w-full items-center justify-center gap-2 rounded-full',
                  'border border-[var(--login-card-border)] px-6 text-[15px] font-medium leading-[1.33] transition-colors',
                  'bg-[var(--login-card-bg)] text-[var(--login-help-text)]',
                  'hover:bg-[var(--surface-chip)]',
                  'disabled:opacity-60 disabled:cursor-not-allowed',
                )}
              >
                <FlaskConical size={18} />
                {t('login.devLogin')}
              </button>
            </>
          )}

          {/* Spacer 12px */}
          <div className="h-[12px] w-full shrink-0" />

          {/* Help text */}
          <p className="text-center text-[14px] leading-[1.43] text-[var(--login-help-text)]">
            {t('login.helpText')}
          </p>

          {/* Error message — functional state, not in design spec */}
          {error && (
            <p className="mt-3 text-center text-sm text-[var(--login-error-text)]">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}
