import Constants from 'expo-constants';

import { parseClientEndpointManifest } from '@lizi/maker-shared/client-endpoints';

export type CindyAuthRegion = 'cn' | 'global';

export interface MobileGoogleConfig {
  webClientId: string;
  iosClientId: string;
  iosUrlScheme: string;
}

const configuredExpoExtra = (Constants.expoConfig?.extra as {
  xdtProductionEnv?: Record<string, string>;
  cindy?: {
    regionConfigSource?: string;
    google?: Partial<MobileGoogleConfig>;
  };
} | null) ?? {};
const configuredBuildEnv = (configuredExpoExtra.xdtProductionEnv ?? {}) as Record<
  string,
  string
>;
const configuredRegionGoogle = configuredExpoExtra.cindy?.google;

function configuredValue(key: string): string {
  return process.env[key]?.trim() || configuredBuildEnv[key]?.trim() || '';
}

export const AUTH_REGION: CindyAuthRegion =
  configuredValue('EXPO_PUBLIC_CINDY_AUTH_REGION') === 'global' ? 'global' : 'cn';
export const APP_SCHEME = AUTH_REGION === 'global' ? 'cindy' : 'cindycn';
export const MOBILE_REDIRECT_URL = `${APP_SCHEME}://auth`;

// __DEV__ 端点初值来源:metro 构建期按 AUTH_REGION 把仓内
// config/endpoint.json 或 config/endpoint.global.json require 进 dev bundle
// (__DEV__ 常量折叠 + DCE 后 prod bundle 不含该 JSON)。与 desktop dev 读同一份
// region 正本同语义;正本非法直接抛错红屏(阻断语义:配置错要炸出来)。
// 显式 EXPO_PUBLIC_* env 仍然优先——「手机连本地 server」的既有工作流不变。
// prod(非 __DEV__)此处为空:生效端点由启动闸门拉取的 endpoint.json 回填
// live binding,闸门放行前业务树不挂载,初值空串不会被真实消费。
const DEV_MANIFEST_PARSED = (() => {
  if (!__DEV__) return null;
  const manifestPath =
    AUTH_REGION === 'global' ? 'config/endpoint.global.json' : 'config/endpoint.json';
  const raw: unknown =
    AUTH_REGION === 'global'
      ? // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../../../../config/endpoint.global.json')
      : // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../../../../config/endpoint.json');
  const parsed = parseClientEndpointManifest(JSON.stringify(raw), { allowHttp: true });
  if (!parsed.ok) {
    throw new Error(`${manifestPath} invalid (${parsed.reason}) — dev 端点正本必须能过客户端 parser`);
  }
  return parsed;
})();
const DEV_MANIFEST: Partial<Record<string, string>> = DEV_MANIFEST_PARSED?.endpoints ?? {};

// 显式 env 优先,dev 回落仓内正本;prod 为空串(闸门回填,见上)。
export const DEFAULT_DEVICE_LINK_API_BASE_URL =
  configuredValue('EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL') ||
  DEV_MANIFEST.deviceLinkApiBaseUrl ||
  '';
// 语音网关(litellm)地址不再有清单默认值(2026-07-17 退役 xdGatewayBaseUrl):
// 正常链路由桌面端经 device-link 凭据同步下发 proxyBaseUrl(desktop 侧来自
// model-access server 下发的 endpoint);本值仅供本地 e2e / dev 显式覆写。
export const DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL =
  configuredValue('EXPO_PUBLIC_XDT_MOBILE_VOICE_LITELLM_BASE_URL') || '';

export interface MobileConfigIssue {
  key: string;
  message: string;
}

export function normalizeBaseUrlWithDefault(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/$/, '') : fallback;
}

// 老 3333→3335 的"从主 API base 派生 relay"逻辑已随 apiBaseUrl 退役删除
// (本地没有 3333 主 server 了):连本地 relay 直接设
// EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL。
export function resolveDeviceLinkApiBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/$/, '') : DEFAULT_DEVICE_LINK_API_BASE_URL;
}

export function deviceLinkWsUrl(apiBaseUrl = DEVICE_LINK_API_BASE_URL): string {
  return apiBaseUrl.replace(/^http/, 'ws') + '/api/device-link/ws';
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

// auth 不分 cn/global 字段:dev 读 cn 正本(dev 默认 region=cn);prod 由 region 化
// 清单回填。显式 env 覆写仍最高优先。
export let AUTH_API_BASE_URL = normalizeBaseUrlWithDefault(
  configuredValue('EXPO_PUBLIC_CINDY_AUTH_BASE_URL'),
  DEV_MANIFEST.authApiBaseUrl ?? '',
);

/** 本地 / self-host 构建只认 region JSON 写入的 Expo extra;EAS 线使用 EXPO_PUBLIC_*。 */
export function resolveMobileGoogleConfig(
  regionConfigAuthoritative: boolean,
  regionConfig: Partial<MobileGoogleConfig> | undefined,
  env: Record<string, string | undefined> = process.env,
): MobileGoogleConfig {
  if (regionConfigAuthoritative) {
    return {
      webClientId: regionConfig?.webClientId?.trim() || '',
      iosClientId: regionConfig?.iosClientId?.trim() || '',
      iosUrlScheme: regionConfig?.iosUrlScheme?.trim() || '',
    };
  }
  return {
    webClientId: env.EXPO_PUBLIC_CINDY_GOOGLE_WEB_CLIENT_ID?.trim() || '',
    iosClientId: env.EXPO_PUBLIC_CINDY_GOOGLE_IOS_CLIENT_ID?.trim() || '',
    iosUrlScheme: env.EXPO_PUBLIC_CINDY_GOOGLE_IOS_URL_SCHEME?.trim() || '',
  };
}

const GOOGLE_CONFIG = resolveMobileGoogleConfig(
  configuredExpoExtra.cindy?.regionConfigSource === 'self-host-regions',
  configuredRegionGoogle,
  {
    EXPO_PUBLIC_CINDY_GOOGLE_WEB_CLIENT_ID:
      process.env.EXPO_PUBLIC_CINDY_GOOGLE_WEB_CLIENT_ID,
    EXPO_PUBLIC_CINDY_GOOGLE_IOS_CLIENT_ID:
      process.env.EXPO_PUBLIC_CINDY_GOOGLE_IOS_CLIENT_ID,
    EXPO_PUBLIC_CINDY_GOOGLE_IOS_URL_SCHEME:
      process.env.EXPO_PUBLIC_CINDY_GOOGLE_IOS_URL_SCHEME,
  },
);
export const GOOGLE_WEB_CLIENT_ID = GOOGLE_CONFIG.webClientId;
export const GOOGLE_IOS_CLIENT_ID = GOOGLE_CONFIG.iosClientId;
export const GOOGLE_IOS_URL_SCHEME = GOOGLE_CONFIG.iosUrlScheme;
export const WECHAT_APP_ID =
  process.env.EXPO_PUBLIC_CINDY_WECHAT_APP_ID?.trim() || '';
export const WECHAT_UNIVERSAL_LINK =
  process.env.EXPO_PUBLIC_CINDY_WECHAT_UNIVERSAL_LINK?.trim() || '';

export let DEVICE_LINK_API_BASE_URL = resolveDeviceLinkApiBaseUrl(
  configuredValue('EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL'),
);

// 二进制版本号:审核模式匹配基准。优先原生层版本(iOS CFBundleShortVersionString /
// Android versionName,OTA 热更后不漂移),expoConfig.version 兜底(dev / 测试环境
// 拿不到原生值)。与 mobileTapdb 的版本上报取值口径一致。
export const APP_BINARY_VERSION =
  (Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? '').trim();

/**
 * 纯函数:清单 review(送审版本号)与二进制版本号严格相等才进入审核模式;
 * 任一侧为空恒 false(清单没填 = 关闭;拿不到版本号 = 宁可不进审核模式,
 * 也不能让线上用户误失去更新通道)。
 */
export function isReviewModeActive(
  reviewVersion: string | null | undefined,
  appBinaryVersion: string,
): boolean {
  const review = reviewVersion?.trim();
  const binary = appBinaryVersion.trim();
  return Boolean(review) && review === binary;
}

// 手机版审核模式(清单可选字段 review = 送审版本号,缺失/空串 = 关闭):App 审核
// 期间线上清单填送审构建的二进制版本号,仅版本命中的构建关闭全部 JS 显式更新检查
// (启动 JS 热更门 / 整包检查 / resume 静默检查)、设置页隐藏「检查更新 / 检查整包
// 更新」;存量其它版本用户不受影响。覆盖边界与运维义务(原生层后台检查管不到、
// 过审发布后须清空字段)见 maker-shared clientEndpoints 的 CLIENT_ENDPOINT_REVIEW_KEY
// 注释。live binding:prod 由启动闸门回填,闸门 ready 前业务树不挂载,消费点
// (更新 hooks / 设置页)读到的一定是清单值;dev 读仓内正本。仅 mobile 消费,
// desktop 忽略该字段。
export let REVIEW_MODE = isReviewModeActive(
  DEV_MANIFEST_PARSED?.reviewVersion,
  APP_BINARY_VERSION,
);

// 非 live binding(清单不再承载语音网关地址,启动闸门无覆写路径):env 覆写为空时
// 即空串,真实地址走桌面端凭据同步(mobileVoiceCredentialStore 的 proxyBaseUrl)。
export const MOBILE_VOICE_LITELLM_BASE_URL = DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL
  ? normalizeBaseUrlWithDefault(DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL, '')
  : '';

// 端点清单(endpoint.json)的自举拉取基址(启动闸门专用),按 region 构建期二选一
// 烘焙(EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL ← region 对应 endpoint*.json 的
// cdnBaseUrl)。**烘焙常量、不接受远程覆盖**——拉清单的
// 地址若吃清单自己的字段,配错一次就把自己锁死(与 desktop 同则)。这是客户端
// 唯一"有感"的烘焙远程 URL。
export const ENDPOINT_MANIFEST_BASE_URL = configuredValue(
  'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL',
).replace(/\/+$/, '');

/**
 * 启动闸门拉到远程端点清单后回写运行期端点(仅覆盖清单中出现的字段;
 * 空值忽略,烘焙值兜底)。auth 字段不分 region——国内/海外两条 CDN 各发
 * 各的清单,无脑取。deviceLinkApiBaseUrl 是清单必填字段,恒被覆写。
 */
export function applyResolvedClientEndpoints(resolved: {
  authApiBaseUrl?: string;
  deviceLinkApiBaseUrl?: string;
  mobileUpdateBaseUrl?: string;
  /** 审核模式送审版本号(parser 产出,null = 清单未填;undefined = 不改动)。 */
  reviewVersion?: string | null;
}): void {
  if (resolved.authApiBaseUrl) {
    AUTH_API_BASE_URL = normalizeBaseUrlWithDefault(resolved.authApiBaseUrl, AUTH_API_BASE_URL);
  }
  if (resolved.deviceLinkApiBaseUrl) {
    DEVICE_LINK_API_BASE_URL = resolved.deviceLinkApiBaseUrl.replace(/\/$/, '');
  }
  // 仅自建变体吃清单覆写,保住「非自建 ⇒ OTA_SERVER_BASE_URL 恒空串」不变量
  // (调用点虽都有 IS_OTA_SELFHOST 门控,这里再挡一层,变体身份始终由烧包决定)。
  if (resolved.mobileUpdateBaseUrl && IS_OTA_SELFHOST) {
    OTA_SERVER_BASE_URL = resolved.mobileUpdateBaseUrl.replace(/\/+$/, '');
  }
  if (resolved.reviewVersion !== undefined) {
    REVIEW_MODE = isReviewModeActive(resolved.reviewVersion, APP_BINARY_VERSION);
  }
}

// 自建分发服务基址,唯一来源是 endpoint.json 的 mobileUpdateBaseUrl:
// - `${base}/manifest`:useStartupOtaGate 在手动 check/fetch 前运行时覆写 expo-updates URL;
// - `${base}/latest`:整包发现(runtimeVersion 不同则引导安装新包)。
// live binding:启动闸门成功前保持空串,业务树与 OTA 门均未挂载;自建变体由
// applyResolvedClientEndpoints 回填,非自建变体恒空串。真实更新地址不再构建期注入。
export let OTA_SERVER_BASE_URL = '';

// 是否自建变体 —— 必须与 app.config.js 的构建门控读同一个 EXPO_PUBLIC_XDT_OTA_SELFHOST 标志。
// 真实更新地址只来自 endpoint 清单,不能拿它反推包身份,否则会破坏 EAS / 自建两条线隔离。
// EXPO_PUBLIC_ 前缀保证该标志会被 inline 进 JS bundle,
// 与包的真实身份严格对齐。详见 docs/self-hosted-ios-build-and-ota.md。
export const IS_OTA_SELFHOST = process.env.EXPO_PUBLIC_XDT_OTA_SELFHOST === '1';

// 二级版本号:本次自建线打包所配对的桌面产品线版本(如 `0.0.147`)。仅自建线发版脚本
// 会经 selfhostEnv() 注入该值(取自桌面 CDN manifest 的当前版本),EAS beta/prod 不注入。
// EXPO_PUBLIC_ 前缀由 Metro 在打包时内联进 JS bundle(不进 @expo/fingerprint,OTA 安全、
// 不改 runtimeVersion)。空值表示 dev / 非自建 / 未注入,设置页据此不渲染该行。
export const DESKTOP_PACKAGE_VERSION =
  process.env.EXPO_PUBLIC_DESKTOP_VERSION?.trim() || '';
