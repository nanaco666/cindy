import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Building2, ExternalLink, Mail, Phone, UserRound } from 'lucide-react';
import { BRAND_NAME } from '@lizi/maker-shared/branding';
import type { SocialProvider, VerificationKind } from '@cindy/auth-client';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { WindowControls } from '@/components/title-bar/WindowControls';
import splashLogo from '@/assets/splash-logo.png';
import { useLogin } from '@/hooks/useLogin';

const primaryButtonClass = cn(
  'inline-flex h-11 w-full items-center justify-center gap-2 rounded-full px-6',
  'text-[15px] font-medium transition-colors',
  'bg-[var(--login-btn-bg)] text-[var(--login-btn-text)] hover:bg-[var(--login-btn-hover)]',
  'disabled:cursor-not-allowed disabled:opacity-60',
);

const secondaryButtonClass = cn(
  'inline-flex h-11 w-full items-center justify-center gap-2 rounded-full border px-5',
  'border-[var(--border-default)] bg-[var(--surface-elevated)] text-[15px] font-medium',
  'text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)]',
  'disabled:cursor-not-allowed disabled:opacity-60',
);

const inputClass = cn(
  'h-11 w-full rounded-full border border-[var(--border-default)]',
  'bg-[var(--surface-elevated)] px-4 text-[15px] text-[var(--text-primary)] outline-none',
  'placeholder:text-[var(--text-placeholder)] focus:ring-2 focus:ring-[var(--focus-ring-soft)]',
  'disabled:cursor-not-allowed disabled:opacity-60',
);

function BusyLabel({ children }: { children: ReactNode }) {
  return (
    <>
      <Spinner size={18} />
      {children}
    </>
  );
}

/** Auth-server login UI. It handles presentation only; main owns all credentials and tickets. */
export function LoginPage() {
  const { isLoading, errorCode, loginState, dispatch, clearError } = useLogin();
  const { t } = useTranslation();
  const isMac = window.electronAPI?.platform === 'darwin';
  const [identifierKind, setIdentifierKind] = useState<VerificationKind>('email');
  const [identifier, setIdentifier] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [bindingContact, setBindingContact] = useState('');
  const [bindingCode, setBindingCode] = useState('');

  useEffect(() => {
    if (loginState?.step !== 'identifier') return;
    setIdentifierKind(loginState.providers.attribution);
    setVerificationCode('');
    setBindingContact('');
    setBindingCode('');
  }, [
    loginState?.step,
    loginState?.step === 'identifier' ? loginState.providers.attribution : null,
  ]);

  const errorMessage = useMemo(() => {
    if (!errorCode) return null;
    return t(`login.errors.${errorCode}`, {
      defaultValue: t('login.errors.fallback'),
    });
  }, [errorCode, t]);

  const reset = () => {
    clearError();
    void dispatch({ type: 'reset' });
  };

  const submitIdentifier = (event: FormEvent) => {
    event.preventDefault();
    const value = identifier.trim();
    if (!value) return;
    if (identifierKind === 'email') {
      void dispatch({ type: 'discover', email: value });
    } else {
      void dispatch({ type: 'request-code', kind: 'phone', identifier: value });
    }
  };

  const renderIdentifier = () => {
    if (!loginState || loginState.step !== 'identifier') return null;
    const providers = loginState.providers;
    const showTabs = providers.email && providers.phone;
    return (
      <>
        <Header title={t('login.title')} subtitle={t('login.subtitle')} />

        {showTabs && (
          <div className="mb-4 flex w-full rounded-full bg-[var(--surface-chip)] p-1">
            {(['phone', 'email'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                disabled={isLoading}
                onClick={() => {
                  setIdentifierKind(kind);
                  setIdentifier('');
                  clearError();
                }}
                className={cn(
                  'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full text-[13px] transition-colors',
                  identifierKind === kind
                    ? 'bg-[var(--surface-elevated)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                )}
              >
                {kind === 'phone' ? <Phone size={15} /> : <Mail size={15} />}
                {t(`login.${kind}`)}
              </button>
            ))}
          </div>
        )}

        <form className="w-full space-y-3" onSubmit={submitIdentifier}>
          <input
            autoFocus
            required
            disabled={isLoading}
            type={identifierKind === 'email' ? 'email' : 'tel'}
            autoComplete={identifierKind === 'email' ? 'email' : 'tel'}
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            placeholder={t(
              identifierKind === 'email' ? 'login.emailPlaceholder' : 'login.phonePlaceholder',
            )}
            className={inputClass}
          />
          <button
            className={primaryButtonClass}
            disabled={isLoading || !identifier.trim()}
            type="submit"
          >
            {isLoading ? <BusyLabel>{t('login.working')}</BusyLabel> : t('login.continue')}
          </button>
        </form>

        {providers.social.length > 0 && (
          <>
            <Divider label={t('login.or')} />
            <div className="grid w-full gap-2">
              {providers.social.map((provider) => (
                <button
                  key={provider}
                  type="button"
                  disabled={isLoading}
                  className={secondaryButtonClass}
                  onClick={() =>
                    void dispatch({
                      type: 'start-browser',
                      kind: 'social',
                      providerOrConnectionId: provider,
                      label: t(`login.social.${provider}`),
                    })
                  }
                >
                  <SocialMark provider={provider} />
                  {t('login.socialButton', { provider: t(`login.social.${provider}`) })}
                </button>
              ))}
            </div>
          </>
        )}
      </>
    );
  };

  const renderMethodChoice = () => {
    if (loginState?.step !== 'method-choice') return null;
    const ssoMethods = loginState.methods.filter((method) => method.type === 'sso');
    const emailAllowed =
      loginState.methods.some((method) => method.type === 'email_code') &&
      !ssoMethods.some((method) => method.ssoRequired);
    // 命中企业域名时按 console 同款框架提示「企业身份 / 个人身份」；无 SSO 时保持纯邮箱确认
    const orgName = ssoMethods[0]?.orgName;
    return (
      <>
        <BackButton disabled={isLoading} onClick={reset} label={t('login.back')} />
        <Header
          title={t('login.chooseMethod')}
          subtitle={
            orgName
              ? t('login.orgDetected', { email: loginState.email, org: orgName })
              : loginState.email
          }
        />
        <div className="w-full space-y-2">
          {ssoMethods.map((method) => (
            <button
              key={method.connectionId}
              type="button"
              disabled={isLoading}
              className={cn(
                primaryButtonClass,
                'h-auto min-h-12 justify-start rounded-xl px-4 py-3 text-left',
              )}
              onClick={() =>
                void dispatch({
                  type: 'start-browser',
                  kind: 'sso',
                  providerOrConnectionId: method.connectionId,
                  label: method.connectionName,
                })
              }
            >
              <Building2 className="shrink-0" size={18} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{t('login.enterpriseLogin')}</span>
                <span className="block truncate text-[12px] font-normal opacity-75">
                  {t('login.enterpriseVia', { name: method.connectionName || method.orgName })}
                </span>
              </span>
              <ExternalLink className="shrink-0" size={15} />
            </button>
          ))}
          {emailAllowed &&
            (ssoMethods.length > 0 ? (
              <button
                type="button"
                disabled={isLoading}
                className={cn(
                  secondaryButtonClass,
                  'h-auto min-h-12 justify-start rounded-xl px-4 py-3 text-left',
                )}
                onClick={() =>
                  void dispatch({
                    type: 'request-code',
                    kind: 'email',
                    identifier: loginState.email,
                  })
                }
              >
                <UserRound className="shrink-0" size={18} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{t('login.personalLogin')}</span>
                  <span className="block truncate text-[12px] font-normal text-[var(--text-secondary)]">
                    {t('login.personalDesc')}
                  </span>
                </span>
              </button>
            ) : (
              <button
                type="button"
                disabled={isLoading}
                className={primaryButtonClass}
                onClick={() =>
                  void dispatch({
                    type: 'request-code',
                    kind: 'email',
                    identifier: loginState.email,
                  })
                }
              >
                <Mail size={18} />
                {t('login.emailCode')}
              </button>
            ))}
        </div>
        {ssoMethods.some((method) => method.ssoRequired) && (
          <p className="mt-4 text-center text-[13px] leading-5 text-[var(--text-secondary)]">
            {t('login.ssoRequired')}
          </p>
        )}
      </>
    );
  };

  const renderVerification = () => {
    if (loginState?.step !== 'verification-code') return null;
    const submit = (event: FormEvent) => {
      event.preventDefault();
      if (!verificationCode) return;
      void dispatch({
        type: 'verify-code',
        kind: loginState.kind,
        identifier: loginState.identifier,
        code: verificationCode,
      });
    };
    return (
      <>
        <BackButton disabled={isLoading} onClick={reset} label={t('login.back')} />
        <Header
          title={t('login.enterCode')}
          subtitle={t('login.codeSentTo', { identifier: loginState.identifier })}
        />
        <form className="w-full space-y-3" onSubmit={submit}>
          <input
            autoFocus
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            disabled={isLoading}
            value={verificationCode}
            onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, ''))}
            placeholder={t('login.codePlaceholder')}
            className={cn(inputClass, 'text-center tracking-[0.35em]')}
          />
          <button
            type="submit"
            disabled={isLoading || verificationCode.length !== 6}
            className={primaryButtonClass}
          >
            {isLoading ? <BusyLabel>{t('login.verifying')}</BusyLabel> : t('login.signIn')}
          </button>
          <button
            type="button"
            disabled={isLoading}
            className="w-full text-center text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            onClick={() =>
              void dispatch({
                type: 'request-code',
                kind: loginState.kind,
                identifier: loginState.identifier,
              })
            }
          >
            {t('login.resendCode')}
          </button>
        </form>
      </>
    );
  };

  const renderAccountSelection = () => {
    if (loginState?.step !== 'account-selection') return null;
    return (
      <>
        <BackButton disabled={isLoading} onClick={reset} label={t('login.back')} />
        <Header title={t('login.chooseAccount')} subtitle={t('login.chooseAccountSubtitle')} />
        <div className="w-full space-y-2">
          {loginState.accounts.map((account) => (
            <button
              key={account.id}
              type="button"
              disabled={isLoading}
              className={cn(
                secondaryButtonClass,
                'h-auto min-h-12 justify-start rounded-xl px-4 py-3 text-left',
              )}
              onClick={() => void dispatch({ type: 'select-account', accountId: account.id })}
            >
              {account.kind === 'org' ? (
                <Building2 className="shrink-0" size={18} />
              ) : (
                <UserRound className="shrink-0" size={18} />
              )}
              <span className="min-w-0">
                <span className="block truncate">{account.displayName}</span>
                <span className="block truncate text-[12px] font-normal text-[var(--text-secondary)]">
                  {account.orgName || account.email || t('login.personalAccount')}
                </span>
              </span>
            </button>
          ))}
        </div>
      </>
    );
  };

  const renderBinding = () => {
    if (loginState?.step !== 'binding') return null;
    const contact = loginState.contact ?? bindingContact;
    const request = (event: FormEvent) => {
      event.preventDefault();
      if (!bindingContact.trim()) return;
      void dispatch({ type: 'request-binding-code', contact: bindingContact.trim() });
    };
    const verify = (event: FormEvent) => {
      event.preventDefault();
      if (!contact || bindingCode.length !== 6) return;
      void dispatch({ type: 'verify-binding', contact, code: bindingCode });
    };
    return (
      <>
        <BackButton disabled={isLoading} onClick={reset} label={t('login.cancel')} />
        <Header
          title={t(`login.binding.${loginState.bindType}Title`)}
          subtitle={t(`login.binding.${loginState.bindType}Subtitle`)}
        />
        {!loginState.codeRequested ? (
          <form className="w-full space-y-3" onSubmit={request}>
            <input
              autoFocus
              required
              type={loginState.bindType === 'email' ? 'email' : 'tel'}
              autoComplete={loginState.bindType === 'email' ? 'email' : 'tel'}
              disabled={isLoading}
              value={bindingContact}
              onChange={(event) => setBindingContact(event.target.value)}
              placeholder={t(
                loginState.bindType === 'email'
                  ? 'login.emailPlaceholder'
                  : 'login.phonePlaceholder',
              )}
              className={inputClass}
            />
            <button
              type="submit"
              disabled={isLoading || !bindingContact.trim()}
              className={primaryButtonClass}
            >
              {isLoading ? <BusyLabel>{t('login.working')}</BusyLabel> : t('login.sendCode')}
            </button>
          </form>
        ) : (
          <form className="w-full space-y-3" onSubmit={verify}>
            <p className="truncate text-center text-[13px] text-[var(--text-secondary)]">
              {contact}
            </p>
            <input
              autoFocus
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              disabled={isLoading}
              value={bindingCode}
              onChange={(event) => setBindingCode(event.target.value.replace(/\D/g, ''))}
              placeholder={t('login.codePlaceholder')}
              className={cn(inputClass, 'text-center tracking-[0.35em]')}
            />
            <button
              type="submit"
              disabled={isLoading || bindingCode.length !== 6}
              className={primaryButtonClass}
            >
              {isLoading ? (
                <BusyLabel>{t('login.verifying')}</BusyLabel>
              ) : (
                t('login.completeSignIn')
              )}
            </button>
          </form>
        )}
      </>
    );
  };

  const renderContent = () => {
    if (!loginState) {
      return <Header title={t('login.preparing')} subtitle={t('login.preparingSubtitle')} />;
    }
    if (loginState.step === 'error') {
      return (
        <>
          <Header title={t('login.unavailable')} subtitle={t('login.errors.fallback')} />
          <button type="button" disabled={isLoading} className={primaryButtonClass} onClick={reset}>
            {isLoading ? <BusyLabel>{t('login.working')}</BusyLabel> : t('login.retry')}
          </button>
        </>
      );
    }
    if (loginState.step === 'browser-redirect') {
      return (
        <>
          <Header title={t('login.browserWaiting')} subtitle={loginState.label} />
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => void dispatch({ type: 'cancel-browser' })}
          >
            {t('login.cancel')}
          </button>
        </>
      );
    }
    if (loginState.step === 'completed') return null;
    return (
      renderIdentifier() ??
      renderMethodChoice() ??
      renderVerification() ??
      renderAccountSelection() ??
      renderBinding()
    );
  };

  return (
    <div className="flex min-h-screen flex-col bg-[var(--login-bg)]">
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

      <div className="flex flex-1 items-center justify-center px-6 py-8">
        <main
          className={cn(
            'flex min-h-[560px] w-[440px] max-w-full flex-col items-center rounded-xl px-10 py-8',
            'border border-[var(--login-card-border)] bg-[var(--login-card-bg)]',
          )}
        >
          <img
            src={splashLogo}
            alt={BRAND_NAME}
            className="pointer-events-none mb-5 h-24 w-24 rounded-xl object-contain"
            draggable={false}
          />
          <span className="mb-6 rounded-full bg-[var(--surface-chip)] px-3 py-1 text-[11px] text-[var(--text-secondary)]">
            {t(
              import.meta.env.VITE_CINDY_AUTH_REGION === 'global'
                ? 'login.globalRegion'
                : 'login.cnRegion',
            )}
          </span>
          <div className="flex w-full flex-1 flex-col items-center justify-center">
            {renderContent()}
          </div>
          {errorMessage && (
            <p
              role="alert"
              className="mt-5 text-center text-[13px] leading-5 text-[var(--login-error-text)]"
            >
              {errorMessage}
            </p>
          )}
        </main>
      </div>
    </div>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6 text-center">
      <h1 className="text-[24px] font-medium leading-8 text-[var(--text-primary)]">{title}</h1>
      <p className="mt-2 break-words text-[14px] leading-5 text-[var(--text-secondary)]">
        {subtitle}
      </p>
    </div>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <div className="my-5 flex w-full items-center gap-3">
      <span className="h-px flex-1 bg-[var(--login-divider)]" />
      <span className="text-[12px] text-[var(--text-secondary)]">{label}</span>
      <span className="h-px flex-1 bg-[var(--login-divider)]" />
    </div>
  );
}

function BackButton({
  disabled,
  label,
  onClick,
}: {
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="mb-3 inline-flex self-start items-center gap-1 text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-60"
    >
      <ArrowLeft size={15} />
      {label}
    </button>
  );
}

function SocialMark({ provider }: { provider: SocialProvider }) {
  const label = provider === 'apple' ? '' : provider === 'google' ? 'G' : '微';
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[var(--border-default)] text-[12px]">
      {label}
    </span>
  );
}
