/**
 * 生产端点私有配置的唯一加载入口。
 *
 * 仓库保留空值 example；为方便当前 dev，真实 config/production-endpoints.json
 * 暂时受 Git 管理，CI / 发布环境也可在构建前覆盖它，或通过
 * CINDY_PRODUCTION_ENDPOINTS_FILE 指向其它绝对/相对路径。任何生产调用缺文件、
 * 缺字段、URL 非法或 OSS 配置为空都立即失败，禁止退回源码内默认值。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCTION_ENDPOINT_KEYS = Object.freeze([
  'apiBaseUrl',
  'authApiBaseUrlCn',
  'authApiBaseUrlGlobal',
  'deviceLinkApiBaseUrl',
  'oauthBrokerApiBaseUrl',
  'heartbeatUrl',
  'slackHookWsUrl',
  'websiteUrl',
  'xdGatewayBaseUrl',
  'cdnBaseUrl',
  'cdnInternalBaseUrl',
  'npkgBaseUrl',
]);
export const PRODUCTION_OSS_CONFIG_KEYS = Object.freeze([
  'ossBucket',
  'ossPrefix',
  'ossRegion',
]);
export const PRODUCTION_APP_CONFIG_KEYS = Object.freeze([
  'feishuAppId',
]);
export const PRODUCTION_SCALAR_CONFIG_KEYS = Object.freeze([
  ...PRODUCTION_APP_CONFIG_KEYS,
  ...PRODUCTION_OSS_CONFIG_KEYS,
]);
export const PRODUCTION_CONFIG_KEYS = Object.freeze([
  ...PRODUCTION_APP_CONFIG_KEYS,
  ...PRODUCTION_ENDPOINT_KEYS,
  ...PRODUCTION_OSS_CONFIG_KEYS,
]);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_PRODUCTION_ENDPOINTS_PATH = path.join(
  REPO_ROOT,
  'config',
  'production-endpoints.json',
);
export const PRODUCTION_ENDPOINTS_EXAMPLE_PATH = path.join(
  REPO_ROOT,
  'config',
  'production-endpoints.json.example',
);

const FIELD_PROTOCOLS = Object.freeze({
  apiBaseUrl: ['https:'],
  authApiBaseUrlCn: ['https:'],
  authApiBaseUrlGlobal: ['https:'],
  deviceLinkApiBaseUrl: ['https:'],
  oauthBrokerApiBaseUrl: ['https:'],
  heartbeatUrl: ['https:'],
  slackHookWsUrl: ['wss:'],
  websiteUrl: ['https:'],
  xdGatewayBaseUrl: ['https:'],
  cdnBaseUrl: ['https:'],
  cdnInternalBaseUrl: ['http:', 'https:'],
  npkgBaseUrl: ['https:'],
});

/** 解析配置路径；相对路径统一以仓库根目录为基准。 */
export function resolveProductionEndpointsPath(filePath = process.env.CINDY_PRODUCTION_ENDPOINTS_FILE) {
  if (!filePath?.trim()) return DEFAULT_PRODUCTION_ENDPOINTS_PATH;
  return path.resolve(REPO_ROOT, filePath.trim());
}

/**
 * 读取并严格校验真实生产端点文件。返回值只存在内存中，不打印配置内容。
 * @param {{ filePath?: string }} [options]
 */
export function loadProductionEndpoints(options = {}) {
  const configPath = resolveProductionEndpointsPath(options.filePath);
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(
        `缺少生产端点配置: ${configPath}。请复制 production-endpoints.json.example，` +
          '或由 CI 设置 CINDY_PRODUCTION_ENDPOINTS_FILE。',
      );
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`生产端点配置不是合法 JSON: ${configPath}`);
  }
  return validateProductionEndpoints(parsed, { source: configPath });
}

// 兼容需要在模块级读取权威配置的构建诊断代码。
export const productionEndpoints = loadProductionEndpoints();

/**
 * @param {unknown} value
 * @param {{ source?: string, allowEmpty?: boolean }} [options]
 */
export function validateProductionEndpoints(value, options = {}) {
  const source = options.source ?? 'production endpoints';
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} 必须是 JSON object`);
  }
  const unknownKeys = Object.keys(value).filter((key) => !PRODUCTION_CONFIG_KEYS.includes(key));
  if (unknownKeys.length) {
    throw new Error(`${source} 包含未知字段: ${unknownKeys.join(', ')}`);
  }

  const result = {};
  for (const key of PRODUCTION_CONFIG_KEYS) {
    const raw = value[key];
    if (options.allowEmpty && raw === '') {
      result[key] = '';
      continue;
    }
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error(`${source} 缺少非空字段: ${key}`);
    }
    if (key === 'feishuAppId' && !/^cli_[a-z0-9]+$/i.test(raw.trim())) {
      throw new Error(`${source} 字段 feishuAppId 格式非法`);
    }
    if (PRODUCTION_SCALAR_CONFIG_KEYS.includes(key)) {
      result[key] = raw.trim();
      continue;
    }
    const normalized = raw.trim().replace(/\/+$/, '');
    let url;
    try {
      url = new URL(normalized);
    } catch {
      throw new Error(`${source} 字段 ${key} 不是合法绝对 URL`);
    }
    if (!FIELD_PROTOCOLS[key].includes(url.protocol)) {
      throw new Error(`${source} 字段 ${key} 协议必须是 ${FIELD_PROTOCOLS[key].join(' 或 ')}`);
    }
    if (url.username || url.password) {
      throw new Error(`${source} 字段 ${key} 不允许在 URL 中携带凭据`);
    }
    result[key] = normalized;
  }
  return Object.freeze(result);
}

/** 读取 example 并校验字段集合；空值是 example 的预期格式。 */
export function validateProductionEndpointsExample() {
  const parsed = JSON.parse(fs.readFileSync(PRODUCTION_ENDPOINTS_EXAMPLE_PATH, 'utf8'));
  return validateProductionEndpoints(parsed, {
    source: PRODUCTION_ENDPOINTS_EXAMPLE_PATH,
    allowEmpty: true,
  });
}

/** 单个端点解析；显式环境变量仅作为开发/诊断覆盖。 */
export function resolveEndpoint(key, envVarName) {
  if (!PRODUCTION_ENDPOINT_KEYS.includes(key)) throw new Error(`未知生产端点字段: ${key}`);
  const override = envVarName ? process.env[envVarName]?.trim() : '';
  return override || loadProductionEndpoints()[key];
}

/** CDN 基址；发布诊断仍允许 XDT_CDN_BASE_URL 显式覆盖。 */
export function resolveCdnBaseUrl() {
  return resolveEndpoint('cdnBaseUrl', 'XDT_CDN_BASE_URL');
}

/** Desktop 正式构建所需的全部 Vite 端点变量。 */
export function productionViteEnv({ allowEnvOverride = true, authRegion } = {}) {
  const endpoints = loadProductionEndpoints();
  const pick = (envName, key) =>
    (allowEnvOverride ? process.env[envName]?.trim() : '') || endpoints[key];
  const region =
    authRegion ||
    process.env.CINDY_AUTH_REGION?.trim() ||
    (allowEnvOverride ? process.env.VITE_CINDY_AUTH_REGION?.trim() : '') ||
    'cn';
  if (region !== 'cn' && region !== 'global') {
    throw new Error(`Invalid Cindy auth region: ${region}; expected cn or global`);
  }
  const authBaseUrl =
    region === 'global' ? endpoints.authApiBaseUrlGlobal : endpoints.authApiBaseUrlCn;
  return {
    VITE_FEISHU_APP_ID: pick('VITE_FEISHU_APP_ID', 'feishuAppId'),
    VITE_API_BASE_URL: pick('VITE_API_BASE_URL', 'apiBaseUrl'),
    VITE_CINDY_AUTH_REGION: region,
    VITE_CINDY_AUTH_BASE_URL:
      (allowEnvOverride ? process.env.VITE_CINDY_AUTH_BASE_URL?.trim() : '') || authBaseUrl,
    VITE_DEVICE_LINK_API_BASE_URL: pick(
      'VITE_DEVICE_LINK_API_BASE_URL',
      'deviceLinkApiBaseUrl',
    ),
    VITE_OAUTH_BROKER_API_BASE_URL: pick(
      'VITE_OAUTH_BROKER_API_BASE_URL',
      'oauthBrokerApiBaseUrl',
    ),
    VITE_HEARTBEAT_URL: pick('VITE_HEARTBEAT_URL', 'heartbeatUrl'),
    VITE_SLACK_HOOK_WS_URL: pick('VITE_SLACK_HOOK_WS_URL', 'slackHookWsUrl'),
    VITE_WEBSITE_URL: pick('VITE_WEBSITE_URL', 'websiteUrl'),
    VITE_XDPROXY_BASE_URL: pick('VITE_XDPROXY_BASE_URL', 'xdGatewayBaseUrl'),
    VITE_CDN_BASE_URL: pick('VITE_CDN_BASE_URL', 'cdnBaseUrl'),
    VITE_CDN_INTERNAL_BASE_URL: pick('VITE_CDN_INTERNAL_BASE_URL', 'cdnInternalBaseUrl'),
  };
}

/** Mobile/EAS 构建所需的公开端点变量。 */
export function productionMobileEnv({ authRegion } = {}) {
  const endpoints = loadProductionEndpoints();
  const region =
    authRegion || process.env.EXPO_PUBLIC_CINDY_AUTH_REGION?.trim() || 'cn';
  if (region !== 'cn' && region !== 'global') {
    throw new Error(`Invalid Cindy auth region: ${region}; expected cn or global`);
  }
  return {
    EXPO_PUBLIC_FEISHU_APP_ID: endpoints.feishuAppId,
    EXPO_PUBLIC_CINDY_AUTH_REGION: region,
    EXPO_PUBLIC_CINDY_AUTH_BASE_URL:
      region === 'global' ? endpoints.authApiBaseUrlGlobal : endpoints.authApiBaseUrlCn,
    EXPO_PUBLIC_XDT_API_BASE_URL: endpoints.apiBaseUrl,
    EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL: endpoints.deviceLinkApiBaseUrl,
    EXPO_PUBLIC_XDT_MOBILE_VOICE_LITELLM_BASE_URL: endpoints.xdGatewayBaseUrl,
    EXPO_PUBLIC_XDT_CDN_BASE_URL: endpoints.cdnBaseUrl,
  };
}
