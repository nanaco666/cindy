import Constants from 'expo-constants';

export const APP_SCHEME = 'lizcn';
export const MOBILE_REDIRECT_URL = `${APP_SCHEME}://auth`;
export const MOBILE_OAUTH_STATE_PREFIX = `${APP_SCHEME}.`;

// EXPO_PUBLIC_* 优先使用构建环境；直接执行 EAS build 时由 app.config.js 的 extra 提供同一份配置。
const configuredBuildEnv = ((Constants.expoConfig?.extra as {
  xdtProductionEnv?: Record<string, string>;
} | null)?.xdtProductionEnv ?? {}) as Record<string, string>;
const configuredApiBaseUrl =
  process.env.EXPO_PUBLIC_XDT_API_BASE_URL?.trim() || configuredBuildEnv.EXPO_PUBLIC_XDT_API_BASE_URL;
const configuredDeviceLinkApiBaseUrl =
  process.env.EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL?.trim() ||
  configuredBuildEnv.EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL;
const configuredMobileVoiceBaseUrl =
  process.env.EXPO_PUBLIC_XDT_MOBILE_VOICE_LITELLM_BASE_URL?.trim() ||
  configuredBuildEnv.EXPO_PUBLIC_XDT_MOBILE_VOICE_LITELLM_BASE_URL;
const configuredFeishuAppId =
  process.env.EXPO_PUBLIC_FEISHU_APP_ID?.trim() || configuredBuildEnv.EXPO_PUBLIC_FEISHU_APP_ID;

export const DEFAULT_API_BASE_URL = configuredApiBaseUrl || '';
export const DEFAULT_DEVICE_LINK_API_BASE_URL =
  configuredDeviceLinkApiBaseUrl || '';
export const DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL =
  configuredMobileVoiceBaseUrl || '';

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

export const FEISHU_APP_ID = configuredFeishuAppId || '';

export function resolveEnvFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export const DEV_LOGIN_ENABLED = resolveEnvFlag(
  process.env.EXPO_PUBLIC_XDT_DEV_LOGIN_ENABLED,
);

export const NATIVE_FEISHU_LOGIN_ENABLED = resolveEnvFlag(
  process.env.EXPO_PUBLIC_XDT_NATIVE_FEISHU_LOGIN_ENABLED,
);

export function getMobileConfigIssues(
  env: Record<string, string | undefined> = {
    EXPO_PUBLIC_FEISHU_APP_ID: FEISHU_APP_ID,
  },
): MobileConfigIssue[] {
  const issues: MobileConfigIssue[] = [];
  if (!env.EXPO_PUBLIC_FEISHU_APP_ID?.trim()) {
    issues.push({
      key: 'EXPO_PUBLIC_FEISHU_APP_ID',
      message: '缺少飞书应用 ID，无法发起登录。',
    });
  }
  return issues;
}

export const API_BASE_URL = normalizeBaseUrl(configuredApiBaseUrl);

export const DEVICE_LINK_API_BASE_URL = resolveDeviceLinkApiBaseUrl(
  configuredDeviceLinkApiBaseUrl,
  API_BASE_URL,
);

export const MOBILE_VOICE_LITELLM_BASE_URL = normalizeBaseUrlWithDefault(
  configuredMobileVoiceBaseUrl,
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
export const DESKTOP_PACKAGE_VERSION = process.env.EXPO_PUBLIC_DESKTOP_VERSION?.trim() || '';

// 手机是远程控制端:只需身份,对飞书数据的操作通过控制 desktop 间接完成,故只申请身份级 scope。
// /authen/v1/user_info 的 name / avatar_url / open_id 无需 scope;email 需 contact:user.email:readonly
// (保留它是为了避免登录时把用户已有 email 覆盖为 null)。不申请 offline_access —— 控制端不需要
// 续期飞书 token。此 scope 仅用于浏览器兜底流;原生 LarkSSO 路径的 scope 由飞书后台应用配置决定。
export const OAUTH_SCOPE = [
  'contact:user.email:readonly',
].join(' ');
