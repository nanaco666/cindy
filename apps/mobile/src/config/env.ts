export type CindyAuthRegion = 'cn' | 'global';

export const AUTH_REGION: CindyAuthRegion =
  process.env.EXPO_PUBLIC_CINDY_AUTH_REGION === 'global' ? 'global' : 'cn';
export const APP_SCHEME = AUTH_REGION === 'global' ? 'cindy' : 'cindycn';
export const MOBILE_REDIRECT_URL = `${APP_SCHEME}://auth`;

// ⚠️ 生产域名权威源是仓库根 config/production-endpoints.json,以下默认值必须与其一致
//    (scripts/check-endpoint-literals.mjs 做一致性校验;eas.json 各 profile 的注入值同理)。
export const DEFAULT_API_BASE_URL = 'https://xdt-api.magiclizi.com';
export const DEFAULT_AUTH_API_BASE_URL_CN = 'https://auth.cindy.com.cn';
export const DEFAULT_AUTH_API_BASE_URL_GLOBAL = 'https://auth.cindy.app';
export const DEFAULT_DEVICE_LINK_API_BASE_URL =
  'https://xdmaker-device-link.magiclizi.com';
export const DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL =
  'https://llm-proxy.tapsvc.com';

export interface MobileConfigIssue {
  key: string;
  message: string;
}

export function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/$/, '') : DEFAULT_API_BASE_URL;
}

export function normalizeBaseUrlWithDefault(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/$/, '') : fallback;
}

export function resolveDeviceLinkApiBaseUrl(
  value: string | undefined,
  apiBaseUrl = API_BASE_URL,
): string {
  const trimmed = value?.trim();
  if (trimmed) return trimmed.replace(/\/$/, '');
  const localRelayBase = localRelayBaseForApi(apiBaseUrl);
  return localRelayBase ?? DEFAULT_DEVICE_LINK_API_BASE_URL;
}

export function deviceLinkWsUrl(apiBaseUrl = DEVICE_LINK_API_BASE_URL): string {
  return apiBaseUrl.replace(/^http/, 'ws') + '/api/device-link/ws';
}

function localRelayBaseForApi(apiBaseUrl: string): string | null {
  try {
    const url = new URL(apiBaseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.port !== '3333') return null;
    url.port = '3335';
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function resolveEnvFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export const DEV_LOGIN_ENABLED = resolveEnvFlag(
  process.env.EXPO_PUBLIC_XDT_DEV_LOGIN_ENABLED,
);

export function getMobileConfigIssues(
  env: Record<string, string | undefined> = {
    EXPO_PUBLIC_CINDY_AUTH_BASE_URL:
      process.env.EXPO_PUBLIC_CINDY_AUTH_BASE_URL,
  },
): MobileConfigIssue[] {
  const issues: MobileConfigIssue[] = [];
  const explicitBaseUrl = env.EXPO_PUBLIC_CINDY_AUTH_BASE_URL?.trim();
  if (explicitBaseUrl && !isHttpUrl(explicitBaseUrl)) {
    issues.push({
      key: 'EXPO_PUBLIC_CINDY_AUTH_BASE_URL',
      message: '登录服务地址必须是 http(s) URL。',
    });
  }
  return issues;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      Boolean(url.hostname)
    );
  } catch {
    return false;
  }
}

export const API_BASE_URL = normalizeBaseUrl(
  process.env.EXPO_PUBLIC_XDT_API_BASE_URL,
);

export const AUTH_API_BASE_URL = normalizeBaseUrlWithDefault(
  process.env.EXPO_PUBLIC_CINDY_AUTH_BASE_URL,
  AUTH_REGION === 'global'
    ? DEFAULT_AUTH_API_BASE_URL_GLOBAL
    : DEFAULT_AUTH_API_BASE_URL_CN,
);

export const GOOGLE_WEB_CLIENT_ID =
  process.env.EXPO_PUBLIC_CINDY_GOOGLE_WEB_CLIENT_ID?.trim() || '';
export const GOOGLE_IOS_CLIENT_ID =
  process.env.EXPO_PUBLIC_CINDY_GOOGLE_IOS_CLIENT_ID?.trim() || '';
export const GOOGLE_IOS_URL_SCHEME =
  process.env.EXPO_PUBLIC_CINDY_GOOGLE_IOS_URL_SCHEME?.trim() || '';
export const WECHAT_APP_ID =
  process.env.EXPO_PUBLIC_CINDY_WECHAT_APP_ID?.trim() || '';
export const WECHAT_UNIVERSAL_LINK =
  process.env.EXPO_PUBLIC_CINDY_WECHAT_UNIVERSAL_LINK?.trim() || '';

export const DEVICE_LINK_API_BASE_URL = resolveDeviceLinkApiBaseUrl(
  process.env.EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL,
  API_BASE_URL,
);

export const MOBILE_VOICE_LITELLM_BASE_URL = normalizeBaseUrlWithDefault(
  process.env.EXPO_PUBLIC_XDT_MOBILE_VOICE_LITELLM_BASE_URL,
  DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL,
);

// 自建分发(自托管 OTA)服务基址。仅自建变体的包会注入 EXPO_PUBLIC_XDT_OTA_URL,
// 运行时用它拼 `${base}/latest` 做整包发现(runtimeVersion 不同则引导跳 NPKG)。
export const OTA_SERVER_BASE_URL = (process.env.EXPO_PUBLIC_XDT_OTA_URL?.trim().replace(/\/+$/, '')) || '';

// 是否自建变体 —— 必须与 app.config.js 的构建门控读同一个 EXPO_PUBLIC_XDT_OTA_SELFHOST 标志,
// 而非仅凭 EXPO_PUBLIC_XDT_OTA_URL 是否存在。否则某 EAS 包若恰好在 public env 里带了该 URL
// (但没走自建构建),运行时却误开自建 /latest 检查、提示用户装自建包,破坏两条线的更新隔离。
// EXPO_PUBLIC_ 前缀保证该标志会被 inline 进 JS bundle,
// 与包的真实身份严格对齐。详见 docs/self-hosted-ios-build-and-ota.md。
export const IS_OTA_SELFHOST = process.env.EXPO_PUBLIC_XDT_OTA_SELFHOST === '1';

// 二级版本号:本次自建线打包所配对的桌面产品线版本(如 `0.0.147`)。仅自建线发版脚本
// 会经 selfhostEnv() 注入该值(取自桌面 CDN manifest 的当前版本),EAS beta/prod 不注入。
// EXPO_PUBLIC_ 前缀由 Metro 在打包时内联进 JS bundle(不进 @expo/fingerprint,OTA 安全、
// 不改 runtimeVersion)。空值表示 dev / 非自建 / 未注入,设置页据此不渲染该行。
export const DESKTOP_PACKAGE_VERSION =
  process.env.EXPO_PUBLIC_DESKTOP_VERSION?.trim() || '';
