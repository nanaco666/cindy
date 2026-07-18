/** Result accepted from the system-browser loopback callback. */
export type AuthLoopbackResult = { code: string } | { error: string };

/** Owns the single cancellable system-browser authorization attempt. */
export interface AuthBrowserAuthorizationSlot {
  activate(cancel: () => void): () => void;
  cancelActive(): boolean;
}

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
