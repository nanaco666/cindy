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
