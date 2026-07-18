import Constants from 'expo-constants';

export type CindyAuthRegion = 'cn' | 'global';

const configuredBuildEnv = ((Constants.expoConfig?.extra as {
  xdtProductionEnv?: Record<string, string>;
} | null)?.xdtProductionEnv ?? {}) as Record<string, string>;

function configuredValue(key: string): string {
  return process.env[key]?.trim() || configuredBuildEnv[key]?.trim() || '';
}

export const AUTH_REGION: CindyAuthRegion =
  configuredValue('EXPO_PUBLIC_CINDY_AUTH_REGION') === 'global' ? 'global' : 'cn';
export const APP_SCHEME = AUTH_REGION === 'global' ? 'cindy' : 'cindycn';
export const MOBILE_REDIRECT_URL = `${APP_SCHEME}://auth`;

// 生产值由 app.config.js 从统一 JSON 注入；源码不保留生产 URL fallback。
export const DEFAULT_API_BASE_URL = configuredValue('EXPO_PUBLIC_XDT_API_BASE_URL');
export const DEFAULT_AUTH_API_BASE_URL_CN = '';
export const DEFAULT_AUTH_API_BASE_URL_GLOBAL = '';
export const DEFAULT_DEVICE_LINK_API_BASE_URL = configuredValue(
  'EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL',
);
export const DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL = configuredValue(
  'EXPO_PUBLIC_XDT_MOBILE_VOICE_LITELLM_BASE_URL',
);

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

export const MOBILE_VISUAL_MOCK_ENABLED = __DEV__ && resolveEnvFlag(
  process.env.EXPO_PUBLIC_CINDY_MOBILE_VISUAL_MOCK,
);

export const MOBILE_VISUAL_MOCK_REALDATA_URL = __DEV__
  ? process.env.EXPO_PUBLIC_CINDY_MOBILE_REALDATA_URL?.trim() || ''
  : '';

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

// ── 运行期可覆写端点(ESM live binding)─────────────────────────────────────
// 下面四个端点用 `export let`:启动闸门(useStartupEndpointGate)拉取远程端点
// 清单后经 applyResolvedClientEndpoints 重赋值,importer 通过 live binding 看到
// 新值(消费点全部是调用时读取,无模块顶层捕获——新增顶层派生前先想清楚)。
// 初始值即构建期烘焙值;__DEV__ 下闸门不拉取,行为与现状完全一致。

export let API_BASE_URL = normalizeBaseUrl(
  configuredValue('EXPO_PUBLIC_XDT_API_BASE_URL'),
);

export let AUTH_API_BASE_URL = normalizeBaseUrlWithDefault(
  configuredValue('EXPO_PUBLIC_CINDY_AUTH_BASE_URL'),
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

export let DEVICE_LINK_API_BASE_URL = resolveDeviceLinkApiBaseUrl(
  configuredValue('EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL'),
  API_BASE_URL,
);

export let MOBILE_VOICE_LITELLM_BASE_URL = normalizeBaseUrlWithDefault(
  configuredValue('EXPO_PUBLIC_XDT_MOBILE_VOICE_LITELLM_BASE_URL'),
  DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL,
);

// 远程端点清单的拉取基址(启动闸门专用)。**烘焙常量、不接受远程覆盖**——
// 拉清单的地址若吃清单自己的 cdnBaseUrl,配错一次就把自己锁死(与 desktop 同则)。
export const CDN_BASE_URL = configuredValue('EXPO_PUBLIC_XDT_CDN_BASE_URL').replace(/\/+$/, '');

/**
 * 启动闸门拉到远程端点清单后回写运行期端点(仅覆盖清单中出现的字段;
 * 空值忽略,烘焙值兜底)。auth 字段不分 region——国内/海外两条 CDN 各发
 * 各的清单,无脑取;派生端点同步重算:device-link 未显式给出时按新 apiBase
 * 走 localRelay 派生链。
 */
export function applyResolvedClientEndpoints(resolved: {
  apiBaseUrl?: string;
  authApiBaseUrl?: string;
  deviceLinkApiBaseUrl?: string;
  xdGatewayBaseUrl?: string;
}): void {
  if (resolved.apiBaseUrl) {
    API_BASE_URL = normalizeBaseUrl(resolved.apiBaseUrl);
  }
  if (resolved.authApiBaseUrl) {
    AUTH_API_BASE_URL = normalizeBaseUrlWithDefault(resolved.authApiBaseUrl, AUTH_API_BASE_URL);
  }
  if (resolved.deviceLinkApiBaseUrl) {
    DEVICE_LINK_API_BASE_URL = resolved.deviceLinkApiBaseUrl.replace(/\/$/, '');
  } else if (resolved.apiBaseUrl) {
    DEVICE_LINK_API_BASE_URL = resolveDeviceLinkApiBaseUrl(
      configuredValue('EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL'),
      API_BASE_URL,
    );
  }
  if (resolved.xdGatewayBaseUrl) {
    MOBILE_VOICE_LITELLM_BASE_URL = normalizeBaseUrlWithDefault(
      resolved.xdGatewayBaseUrl,
      MOBILE_VOICE_LITELLM_BASE_URL,
    );
  }
}

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
