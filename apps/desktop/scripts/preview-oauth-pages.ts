import { createServer } from 'node:http';

import { BRAND_NAME } from '@lizi/maker-shared/branding';

import {
  buildOAuthReturnAction,
  getProviderOAuthResultCopy,
  OAUTH_RESULT_HTML_LANG,
  renderOAuthResultPage,
  type OAuthResultPageInput,
  type OAuthResultPageLang,
  type OAuthResultPageTheme,
} from '../src/main/oauthResultPage.js';

const PAGE_KINDS = [
  'login-success',
  'login-error',
  'xai-success',
  'xai-error',
  'generic-success',
  'generic-error',
  'ghost-success',
  'ghost-error',
  'claude-error',
  'warning',
] as const;

type PageKind = (typeof PAGE_KINDS)[number];

/** Human-readable labels for the preview toolbar; callback copy lives below. */
const PAGE_LABELS: Record<PageKind, string> = {
  'login-success': 'Cindy 登录 · 成功',
  'login-error': 'Cindy 登录 · 失败',
  'xai-success': 'xAI · 成功',
  'xai-error': 'xAI · 失败',
  'generic-success': '通用模型供应商 · 成功',
  'generic-error': '通用模型供应商 · 失败',
  'ghost-success': '意识 OAuth · 成功',
  'ghost-error': '意识 OAuth · 失败',
  'claude-error': 'Claude · 本地失败页',
  warning: '需要继续操作 · 警告',
};

interface PreviewCopy {
  loginSuccess: { title: string; body: string };
  loginError: { title: string; body: string };
  ghostSuccess: { title: string; body: string };
  ghostError: { title: string; body: string };
  warning: { title: string; body: string };
}

/** Preview-only sample copy. Production flows keep their own localized business copy. */
const PREVIEW_COPY: Record<OAuthResultPageLang, PreviewCopy> = {
  zh: {
    loginSuccess: { title: '登录成功', body: '你可以返回 Cindy 继续使用。' },
    loginError: { title: '登录未完成', body: '请返回 Cindy 重新发起登录。' },
    ghostSuccess: { title: '授权成功', body: '意识账号已经连接，你可以返回 Cindy 继续。' },
    ghostError: { title: '授权失败', body: '回调参数不完整或校验失败，请返回 Cindy 重试。' },
    warning: { title: '需要继续操作', body: '请返回 Cindy，完成当前工作区的安装后继续。' },
  },
  en: {
    loginSuccess: { title: 'Sign-in complete', body: 'You can return to Cindy to continue.' },
    loginError: {
      title: 'Sign-in not completed',
      body: 'Return to Cindy and start the sign-in again.',
    },
    ghostSuccess: {
      title: 'Authorization complete',
      body: 'The account is connected. Return to Cindy to continue.',
    },
    ghostError: {
      title: 'Authorization failed',
      body: 'The callback is incomplete or failed validation. Return to Cindy and try again.',
    },
    warning: {
      title: 'Action required',
      body: 'Return to Cindy and finish installing in the current workspace.',
    },
  },
  ja: {
    loginSuccess: { title: 'ログインが完了しました', body: 'Cindy に戻って続行できます。' },
    loginError: {
      title: 'ログインを完了できませんでした',
      body: 'Cindy に戻ってログインをやり直してください。',
    },
    ghostSuccess: {
      title: '認可が完了しました',
      body: 'アカウントが接続されました。Cindy に戻って続行できます。',
    },
    ghostError: {
      title: '認可に失敗しました',
      body: 'コールバックの検証に失敗しました。Cindy に戻って再試行してください。',
    },
    warning: {
      title: '操作が必要です',
      body: 'Cindy に戻り、現在のワークスペースへのインストールを完了してください。',
    },
  },
  ko: {
    loginSuccess: { title: '로그인 완료', body: 'Cindy로 돌아가 계속할 수 있습니다.' },
    loginError: {
      title: '로그인이 완료되지 않았습니다',
      body: 'Cindy로 돌아가 로그인을 다시 시작하세요.',
    },
    ghostSuccess: {
      title: '인증 완료',
      body: '계정이 연결되었습니다. Cindy로 돌아가 계속할 수 있습니다.',
    },
    ghostError: {
      title: '인증 실패',
      body: '콜백 검증에 실패했습니다. Cindy로 돌아가 다시 시도하세요.',
    },
    warning: {
      title: '추가 작업 필요',
      body: 'Cindy로 돌아가 현재 워크스페이스 설치를 완료하세요.',
    },
  },
};

function isPageKind(value: string | null): value is PageKind {
  return PAGE_KINDS.includes(value as PageKind);
}

function isLang(value: string | null): value is OAuthResultPageLang {
  return value === 'zh' || value === 'en' || value === 'ja' || value === 'ko';
}

function isTheme(value: string | null): value is OAuthResultPageTheme {
  return value === 'light' || value === 'dark';
}

/** Builds one preview from the same renderer used by production callbacks. */
function renderPreviewPage(
  kind: PageKind,
  lang: OAuthResultPageLang,
  theme: OAuthResultPageTheme,
): string {
  const samples = PREVIEW_COPY[lang];
  const action = buildOAuthReturnAction(lang, `preview-${kind}`, BRAND_NAME);
  const base: Pick<OAuthResultPageInput, 'htmlLang' | 'theme' | 'action'> = {
    htmlLang: OAUTH_RESULT_HTML_LANG[lang],
    theme,
    action,
  };

  if (kind.startsWith('xai-') || kind.startsWith('generic-') || kind === 'claude-error') {
    const providerName = kind.startsWith('xai-')
      ? 'xAI'
      : kind === 'claude-error'
        ? 'Claude'
        : 'Acme AI';
    const provider = getProviderOAuthResultCopy(lang, providerName, BRAND_NAME);
    const success = kind.endsWith('-success');
    return renderOAuthResultPage({
      ...base,
      variant: success ? 'success' : 'error',
      title: success ? provider.successTitle : provider.errorTitle,
      body: success ? provider.successBody : provider.exchangeFailedBody,
      detail: success ? undefined : 'preview_error_code',
    });
  }

  const page =
    kind === 'login-success'
      ? { ...samples.loginSuccess, variant: 'success' as const }
      : kind === 'login-error'
        ? { ...samples.loginError, variant: 'error' as const, detail: 'STATE_MISMATCH' }
        : kind === 'ghost-success'
          ? { ...samples.ghostSuccess, variant: 'success' as const }
          : kind === 'ghost-error'
            ? { ...samples.ghostError, variant: 'error' as const, detail: 'access_denied' }
            : { ...samples.warning, variant: 'warning' as const };

  return renderOAuthResultPage({ ...base, ...page });
}

function renderToolbar(
  kind: PageKind,
  lang: OAuthResultPageLang,
  theme: OAuthResultPageTheme,
): string {
  const pageOptions = PAGE_KINDS.map(
    (value) =>
      `<option value="${value}"${value === kind ? ' selected' : ''}>${PAGE_LABELS[value]}</option>`,
  ).join('');
  const langOptions = (
    [
      ['zh', '简体中文'],
      ['en', 'English'],
      ['ja', '日本語'],
      ['ko', '한국어'],
    ] as const
  )
    .map(
      ([value, label]) =>
        `<option value="${value}"${value === lang ? ' selected' : ''}>${label}</option>`,
    )
    .join('');
  const themeOptions = (['light', 'dark'] as const)
    .map(
      (value) => `<option value="${value}"${value === theme ? ' selected' : ''}>${value}</option>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cindy OAuth 回调页预览</title>
<style>
*{box-sizing:border-box}body{margin:0;height:100vh;display:grid;grid-template-rows:auto 1fr;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:#ececea;color:#262626}
.toolbar{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid #d7d7d4;background:#f8f8f6}.title{font-size:14px;font-weight:600;margin-right:auto}.field{display:flex;align-items:center;gap:6px;font-size:12px;color:#737373}select,.open{height:34px;border:1px solid #c7c7c3;border-radius:8px;background:#fff;color:#262626;padding:0 10px;font:inherit}.open{display:inline-flex;align-items:center;text-decoration:none;font-size:12px}iframe{width:100%;height:100%;border:0;background:#f8f8f6}@media(max-width:720px){.toolbar{align-items:stretch;flex-wrap:wrap}.title{width:100%;margin:0}.field{flex:1;min-width:140px}.field select{width:100%}}
</style>
</head>
<body>
<div class="toolbar">
  <div class="title">Cindy OAuth 回调页 · 真实渲染器预览</div>
  <label class="field">页面<select id="kind">${pageOptions}</select></label>
  <label class="field">语言<select id="lang">${langOptions}</select></label>
  <label class="field">主题<select id="theme">${themeOptions}</select></label>
  <a class="open" id="open" target="_blank" rel="noreferrer">单独打开</a>
</div>
<iframe id="preview" title="OAuth result page preview"></iframe>
<script>
const fields={kind:document.querySelector('#kind'),lang:document.querySelector('#lang'),theme:document.querySelector('#theme')};
const frame=document.querySelector('#preview');const open=document.querySelector('#open');
function refresh(){const query=new URLSearchParams({kind:fields.kind.value,lang:fields.lang.value,theme:fields.theme.value});const page='/page?'+query;frame.src=page;open.href=page;history.replaceState(null,'','/?'+query)}
Object.values(fields).forEach((field)=>field.addEventListener('change',refresh));refresh();
</script>
</body>
</html>`;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/favicon.ico') {
    response.writeHead(204).end();
    return;
  }

  const kind = isPageKind(url.searchParams.get('kind'))
    ? url.searchParams.get('kind')
    : 'login-success';
  const lang = isLang(url.searchParams.get('lang')) ? url.searchParams.get('lang') : 'zh';
  const theme = isTheme(url.searchParams.get('theme')) ? url.searchParams.get('theme') : 'light';
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (url.pathname === '/page') {
    response.end(renderPreviewPage(kind, lang, theme));
    return;
  }
  if (url.pathname === '/') {
    response.end(renderToolbar(kind, lang, theme));
    return;
  }
  response.writeHead(404).end('Not Found');
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (typeof address !== 'object' || address === null) return;
  process.stdout.write(`Cindy OAuth callback preview: http://127.0.0.1:${address.port}\n`);
});

process.once('SIGINT', () => server.close(() => process.exit(0)));
process.once('SIGTERM', () => server.close(() => process.exit(0)));
