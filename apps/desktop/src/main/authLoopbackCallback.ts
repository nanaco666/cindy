import { renderOAuthResultPage, type OAuthResultPageInput } from './oauthResultPage';

/** Result accepted from the system-browser loopback callback. */
export type AuthLoopbackResult = { code: string } | { error: string };

/** Owns the single cancellable system-browser authorization attempt. */
export interface AuthBrowserAuthorizationSlot {
  activate(cancel: () => void): () => void;
  cancelActive(): boolean;
}

export type AuthBrowserCancellationRace<T> = { cancelled: false; value: T } | { cancelled: true };

/** Creates an identity-safe cancellation slot so an older attempt cannot clear a newer one. */
export function createAuthBrowserAuthorizationSlot(): AuthBrowserAuthorizationSlot {
  let activeCancel: (() => void) | null = null;
  return {
    activate(cancel) {
      activeCancel = cancel;
      return () => {
        if (activeCancel === cancel) activeCancel = null;
      };
    },
    cancelActive() {
      const cancel = activeCancel;
      if (!cancel) return false;
      activeCancel = null;
      cancel();
      return true;
    },
  };
}

/**
 * Races post-callback work (notably the authorization-code exchange) against
 * the same cancellation signal that owns the loopback listener. The wrapped
 * operation may still settle later, but its result can no longer be accepted.
 */
export function raceAuthBrowserCancellation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<AuthBrowserCancellationRace<T>> {
  if (signal.aborted) return Promise.resolve({ cancelled: true });

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ cancelled: true });
    };

    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(signal.aborted ? { cancelled: true } : { cancelled: false, value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/** Localized copy for the login callback page (resolved by main i18n). */
export type AuthLoopbackPageInput = Omit<OAuthResultPageInput, 'variant'> & {
  variant: 'success' | 'error';
};

/**
 * Renders the standalone HTML page shown in the system browser after the
 * RFC 8252 loopback callback. Pure string builder so it stays unit-testable
 * outside Electron; all copy arrives pre-translated from the caller.
 *
 * Visuals mirror the desktop LoginPage (renderer/components/login) so the
 * browser page reads as a continuation of the same flow. The renderer theme
 * registry is unreachable from an external browser, so the default-theme
 * values of the exact tokens LoginPage consumes are inlined here (light/dark
 * via prefers-color-scheme). Source of truth: renderer/themes/colors.ts —
 *   page bg     --surface               #f8f8f6 / #1f1f1e
 *   card        --surface-elevated      #ffffff / #2c2c2a
 *   card border --border-default        #d7d7d4 / #3c3c3a
 *   title       --text-primary          #262626 / #d4d4d4
 *   body        --login-help-text (→ --text-tertiary-stone) #737373 both
 *   detail      --text-tertiary         #a3a3a3 / #737373
 *   badge       --surface-chip          #e5e5e5 / #3c3c3a
 *   CTA         --login-btn-bg/-text (→ --accent-cta-bg-pure / --accent-pure-cta-fg)
 *               #000 on #fff text / inverted in dark
 *   CTA hover   --login-btn-hover (→ --accent-hover) #262626 / #e5e5e5
 * If those defaults ever change, update this table in the same PR.
 */
export function renderAuthLoopbackPage(input: AuthLoopbackPageInput): string {
  return renderOAuthResultPage(input);
}

/**
 * Parses the RFC 8252 loopback request while enforcing the callback path and
 * the per-attempt state value. Unknown paths stay unhandled so the listener
 * can return 404 without completing the login attempt.
 */
export function parseAuthLoopbackCallback(
  requestUrl: string | undefined,
  expectedState: string,
): AuthLoopbackResult | null {
  if (!requestUrl) return null;

  let callback: URL;
  try {
    callback = new URL(requestUrl, 'http://127.0.0.1');
  } catch {
    return null;
  }

  if (callback.pathname !== '/auth/callback') return null;
  if (callback.searchParams.get('state') !== expectedState) {
    return { error: 'STATE_MISMATCH' };
  }

  const providerError = callback.searchParams.get('error');
  if (providerError) return { error: providerError };

  const code = callback.searchParams.get('code');
  return code ? { code } : { error: 'INVALID_AUTH_CODE' };
}
