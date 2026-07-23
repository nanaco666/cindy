/**
 * Unified standalone OAuth callback/result page used by Desktop-owned browser
 * flows. These pages run in the system browser, so renderer theme tokens are
 * unavailable; the inlined values mirror docs/design-rules/cindy-design-system.md's default light/dark theme.
 */

import { DEEP_LINK_URL_PREFIX } from '../shared/deepLinkSchemes';

export type OAuthResultPageLang = 'zh' | 'en' | 'ja' | 'ko';
export type OAuthResultPageVariant = 'success' | 'warning' | 'error';
export type OAuthResultPageTheme = 'light' | 'dark';

export interface OAuthResultPageInput {
  /** BCP 47 tag for the html lang attribute. */
  htmlLang: string;
  variant: OAuthResultPageVariant;
  title: string;
  body: string;
  /** Raw diagnostic text rendered as escaped monospace detail. */
  detail?: string;
  /** Optional CTA, normally a cindy://focus/... link back to the app. */
  action?: { href: string; label: string };
  /** Preview-only override. Production omits it and follows the OS setting. */
  theme?: OAuthResultPageTheme;
}

export const OAUTH_RESULT_HTML_LANG: Record<OAuthResultPageLang, string> = {
  zh: 'zh-CN',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
};

/** Selects the first supported language in browser preference order. */
export function pickOAuthResultPageLang(acceptLanguage: string | undefined): OAuthResultPageLang {
  if (typeof acceptLanguage !== 'string' || acceptLanguage.length === 0) return 'en';
  for (const part of acceptLanguage.split(',')) {
    const primary = part.trim().split(';')[0]?.trim().toLowerCase() ?? '';
    if (primary.startsWith('zh')) return 'zh';
    if (primary.startsWith('ja')) return 'ja';
    if (primary.startsWith('ko')) return 'ko';
    if (primary.startsWith('en')) return 'en';
  }
  return 'en';
}

const RETURN_LABEL: Record<OAuthResultPageLang, (brandName: string) => string> = {
  zh: (brandName) => `返回 ${brandName}`,
  en: (brandName) => `Return to ${brandName}`,
  ja: (brandName) => `${brandName} に戻る`,
  ko: (brandName) => `${brandName}(으)로 돌아가기`,
};

/** Builds the stable app-focus CTA shared by browser callback pages. */
export function buildOAuthReturnAction(
  lang: OAuthResultPageLang,
  source: string,
  brandName: string,
): { href: string; label: string } {
  return {
    href: `${DEEP_LINK_URL_PREFIX}focus/${encodeURIComponent(source)}`,
    label: RETURN_LABEL[lang](brandName),
  };
}

interface ProviderOAuthCopy {
  successTitle: string;
  successBody: string;
  errorTitle: string;
  missingCodeBody: string;
  invalidStateBody: string;
  exchangeFailedBody: string;
}

/** Localized copy shared by xAI and descriptor-driven model providers. */
export function getProviderOAuthResultCopy(
  lang: OAuthResultPageLang,
  providerName: string,
  brandName: string,
): ProviderOAuthCopy {
  switch (lang) {
    case 'zh':
      return {
        successTitle: '授权成功',
        successBody: `${providerName} 已连接到 ${brandName}。你可以返回应用继续。`,
        errorTitle: '授权未完成',
        missingCodeBody: `没有收到 ${providerName} 的授权码，请返回 ${brandName} 重试。`,
        invalidStateBody: `授权校验失败，请返回 ${brandName} 重新发起连接。`,
        exchangeFailedBody: `连接 ${providerName} 时发生错误，请返回 ${brandName} 重试。`,
      };
    case 'ja':
      return {
        successTitle: '認可が完了しました',
        successBody: `${providerName} が ${brandName} に接続されました。アプリに戻って続行できます。`,
        errorTitle: '認可を完了できませんでした',
        missingCodeBody: `${providerName} から認可コードを受信できませんでした。${brandName} に戻って再試行してください。`,
        invalidStateBody: `認可の検証に失敗しました。${brandName} に戻って接続をやり直してください。`,
        exchangeFailedBody: `${providerName} への接続中にエラーが発生しました。${brandName} に戻って再試行してください。`,
      };
    case 'ko':
      return {
        successTitle: '인증 완료',
        successBody: `${providerName} 계정이 ${brandName}에 연결되었습니다. 앱으로 돌아가 계속할 수 있습니다.`,
        errorTitle: '인증이 완료되지 않았습니다',
        missingCodeBody: `${providerName} 인증 코드를 받지 못했습니다. ${brandName}(으)로 돌아가 다시 시도하세요.`,
        invalidStateBody: `인증 검증에 실패했습니다. ${brandName}(으)로 돌아가 연결을 다시 시작하세요.`,
        exchangeFailedBody: `${providerName} 연결 중 오류가 발생했습니다. ${brandName}(으)로 돌아가 다시 시도하세요.`,
      };
    default:
      return {
        successTitle: 'Authorization complete',
        successBody: `${providerName} is now connected to ${brandName}. You can return to the app to continue.`,
        errorTitle: 'Authorization not completed',
        missingCodeBody: `No authorization code was received from ${providerName}. Return to ${brandName} and try again.`,
        invalidStateBody: `Authorization validation failed. Return to ${brandName} and start the connection again.`,
        exchangeFailedBody: `Something went wrong while connecting ${providerName}. Return to ${brandName} and try again.`,
      };
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Static monochrome Lucide paths; icons never animate. */
const RESULT_ICON: Record<OAuthResultPageVariant, string> = {
  success: '<path d="M20 6 9 17l-5-5"/>',
  error: '<path d="M18 6 6 18M6 6l12 12"/>',
  warning:
    '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
};

/** Renders the production callback page shell shared by every Desktop OAuth flow. */
export function renderOAuthResultPage(input: OAuthResultPageInput): string {
  const title = escapeHtml(input.title);
  const body = escapeHtml(input.body);
  const detail = input.detail ? `<p class="detail">${escapeHtml(input.detail)}</p>` : '';
  const action = input.action
    ? `<a class="cta" href="${escapeHtml(input.action.href)}">${escapeHtml(input.action.label)}</a>`
    : '';
  const themeAttr = input.theme ? ` data-theme="${input.theme}"` : '';
  return `<!DOCTYPE html>
<html lang="${escapeHtml(input.htmlLang)}"${themeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title} · Cindy</title>
<style>
:root{color-scheme:light;--page:#f8f8f6;--card:#fff;--border:#d7d7d4;--text:#262626;--muted:#737373;--detail:#a3a3a3;--chip:#e5e5e5;--cta:#000;--cta-text:#fff;--cta-hover:#262626}
:root[data-theme="dark"]{color-scheme:dark;--page:#1f1f1e;--card:#2c2c2a;--border:#3c3c3a;--text:#d4d4d4;--muted:#a3a3a3;--detail:#737373;--chip:#3c3c3a;--cta:#fff;--cta-text:#000;--cta-hover:#e5e5e5}
@media(prefers-color-scheme:dark){:root:not([data-theme]){color-scheme:dark;--page:#1f1f1e;--card:#2c2c2a;--border:#3c3c3a;--text:#d4d4d4;--muted:#a3a3a3;--detail:#737373;--chip:#3c3c3a;--cta:#fff;--cta-text:#000;--cta-hover:#e5e5e5}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--page);color:var(--text)}
.card{width:min(100%,400px);padding:40px 44px;text-align:center;background:var(--card);border:1px solid var(--border);border-radius:12px}
.badge{width:48px;height:48px;margin:0 auto 20px;display:flex;align-items:center;justify-content:center;border-radius:9999px;background:var(--chip);color:var(--text)}
h1{margin:0 0 10px;font-size:20px;line-height:1.3;font-weight:500;color:var(--text)}
p{margin:0;font-size:14px;line-height:1.6;font-weight:400;color:var(--muted)}
.detail{margin-top:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;color:var(--detail);overflow-wrap:anywhere}
.cta{display:inline-flex;min-height:44px;margin-top:24px;padding:10px 24px;align-items:center;justify-content:center;border-radius:9999px;background:var(--cta);color:var(--cta-text);font-size:15px;line-height:1.4;font-weight:500;text-decoration:none;transition:background-color .15s ease}
.cta:hover{background:var(--cta-hover)}
.cta:focus-visible{outline:3px solid rgba(59,130,246,.5);outline-offset:3px}
@media(max-width:480px){.card{padding:32px 24px}.badge{margin-bottom:16px}h1{font-size:18px}}
</style>
</head>
<body data-cindy-oauth-result="${input.variant}">
<main class="card">
<span class="badge" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">${RESULT_ICON[input.variant]}</svg></span>
<h1>${title}</h1>
<p>${body}</p>
${detail}
${action}
</main>
</body>
</html>`;
}
