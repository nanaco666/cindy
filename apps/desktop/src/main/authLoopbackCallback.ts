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

/** Localized copy for the loopback callback page (resolved by the caller via main i18n). */
export interface AuthLoopbackPageInput {
  /** BCP 47 tag for the <html lang> attribute, e.g. 'zh-CN'. */
  htmlLang: string;
  variant: 'success' | 'error';
  title: string;
  body: string;
  /** Raw error code shown as muted monospace detail on the error page. */
  detail?: string;
  /** Optional CTA link (e.g. a `cindy://focus/...` deep link back to the app). */
  action?: { href: string; label: string };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 图标是静态 lucide 线稿(check / x),灰度、无动画,符合 DESIGN.md 单色规范。
const AUTH_PAGE_ICON_PATH: Record<AuthLoopbackPageInput['variant'], string> = {
  success: 'M20 6 9 17l-5-5',
  error: 'M18 6 6 18M6 6l12 12',
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
  const title = escapeHtml(input.title);
  const body = escapeHtml(input.body);
  const detail = input.detail ? `<p class="detail">${escapeHtml(input.detail)}</p>` : '';
  const action = input.action
    ? `<a class="cta" href="${escapeHtml(input.action.href)}">${escapeHtml(input.action.label)}</a>`
    : '';
  return `<!DOCTYPE html>
<html lang="${escapeHtml(input.htmlLang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:Inter,system-ui,-apple-system,'Segoe UI',sans-serif;background:#f8f8f6;color:#262626}
.card{box-sizing:border-box;background:#fff;border:1px solid #d7d7d4;border-radius:12px;padding:40px 44px;margin:16px;max-width:360px;text-align:center}
.badge{width:48px;height:48px;border-radius:9999px;background:#e5e5e5;color:#262626;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px}
h1{font-size:18px;font-weight:600;margin:0 0 8px;color:inherit}
p{font-size:14px;line-height:1.6;margin:0;color:#737373}
.detail{margin-top:12px;font-size:12px;color:#a3a3a3;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
.cta{display:inline-block;margin-top:24px;height:44px;line-height:44px;padding:0 24px;border-radius:9999px;background:#000;color:#fff;font-size:15px;font-weight:500;text-decoration:none;transition:background-color .15s}
.cta:hover{background:#262626}
@media (prefers-color-scheme:dark){
body{background:#1f1f1e;color:#d4d4d4}
.card{background:#2c2c2a;border-color:#3c3c3a}
.badge{background:#3c3c3a;color:#d4d4d4}
.detail{color:#737373}
.cta{background:#fff;color:#000}
.cta:hover{background:#e5e5e5}
}
</style>
</head>
<body>
<div class="card">
<span class="badge"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${AUTH_PAGE_ICON_PATH[input.variant]}"/></svg></span>
<h1>${title}</h1>
<p>${body}</p>
${detail}
${action}
</div>
</body>
</html>`;
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
