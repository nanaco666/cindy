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

// 2026-07 端点清单重构:客户端运行期业务端点全部来自 config/endpoint*.json 清单,
// 本文件只保留仍有构建/发版/dev 工具消费的字段(oauthBroker / heartbeat /
// slackHook / website 四个纯运行期字段已随烘焙注入退役,从此处删除)。
// apiBaseUrl(老主 server xdt-api)已于 2026-07-18 整体退役,最后的构建工具
// 消费方(device-link-base.mjs 的生产域名替换分支)一并删除,此处不再声明。
export const PRODUCTION_ENDPOINT_KEYS = Object.freeze([
  'authApiBaseUrlCn',
  'authApiBaseUrlGlobal',
  'deviceLinkApiBaseUrl',
  'xdGatewayBaseUrl',
  'cdnBaseUrl',
  'npkgBaseUrl',
  // 端点清单(endpoint.json)的自举拉取基址,按 region 打包烘焙进客户端——
  // 这是客户端唯一"有感"的烘焙远程 URL,其余业务端点全部来自清单本身。
  'endpointManifestBaseUrlCn',
  'endpointManifestBaseUrlGlobal',
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
  authApiBaseUrlCn: ['https:'],
  authApiBaseUrlGlobal: ['https:'],
  deviceLinkApiBaseUrl: ['https:'],
  xdGatewayBaseUrl: ['https:'],
  cdnBaseUrl: ['https:'],
  npkgBaseUrl: ['https:'],
  endpointManifestBaseUrlCn: ['https:'],
  endpointManifestBaseUrlGlobal: ['https:'],
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

/**
 * Desktop 正式构建所需的 Vite 变量。
 * 2026-07 端点清单重构后收缩为构建身份 + 清单自举基址三件套——业务端点
 * (api / auth / device-link / heartbeat / slack hook / website / 网关 / 更新链
 * CDN)不再构建期烘焙,运行期由 clientEndpointsService 阻断式解析清单
 * (packaged 拉 `<manifest base>/endpoint.json`,dev 读仓内 config/endpoint.json)。
 */
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
  const endpointManifestBaseUrl =
    region === 'global'
      ? endpoints.endpointManifestBaseUrlGlobal
      : endpoints.endpointManifestBaseUrlCn;
  return {
    VITE_FEISHU_APP_ID: pick('VITE_FEISHU_APP_ID', 'feishuAppId'),
    VITE_CINDY_AUTH_REGION: region,
    VITE_ENDPOINT_MANIFEST_BASE_URL:
      (allowEnvOverride ? process.env.VITE_ENDPOINT_MANIFEST_BASE_URL?.trim() : '') ||
      endpointManifestBaseUrl,
  };
}

/**
 * Mobile/EAS 构建所需的公开端点变量。
 * 2026-07 端点清单重构后收缩为 region + 清单自举基址——业务端点
 * (api / auth / device-link / 网关)不再构建期烘焙,运行期由启动闸门从
 * `<manifest base>/endpoint.json` 拉取回填(dev 读仓内 config/endpoint.json)。
 */
export function productionMobileEnv({ authRegion } = {}) {
  const endpoints = loadProductionEndpoints();
  const region =
    authRegion || process.env.EXPO_PUBLIC_CINDY_AUTH_REGION?.trim() || 'cn';
  if (region !== 'cn' && region !== 'global') {
    throw new Error(`Invalid Cindy auth region: ${region}; expected cn or global`);
  }
  return {
    EXPO_PUBLIC_CINDY_AUTH_REGION: region,
    EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL:
      region === 'global'
        ? endpoints.endpointManifestBaseUrlGlobal
        : endpoints.endpointManifestBaseUrlCn,
  };
}
