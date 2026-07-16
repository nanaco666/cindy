/**
 * production-endpoints.mjs — 生产域名权威源(config/production-endpoints.json)的
 * Node 脚本读取入口。构建 / 发布 / 运维脚本需要生产域名默认值时一律 import 本模块,
 * 不要再各自写 URL 字面量(scripts/check-endpoint-literals.mjs 门禁扫描)。
 *
 * 用 import.meta.url 定位 JSON,不依赖 cwd —— 各脚本从任意目录执行都能读到。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const jsonPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'config',
  'production-endpoints.json',
);

/**
 * @type {{
 *   apiBaseUrl: string,
 *   deviceLinkApiBaseUrl: string,
 *   oauthBrokerApiBaseUrl: string,
 *   heartbeatUrl: string,
 *   slackHookWsUrl: string,
 *   xdGatewayBaseUrl: string,
 *   cdnBaseUrl: string,
 *   cdnInternalBaseUrl: string,
 *   npkgBaseUrl: string,
 * }}
 */
export const productionEndpoints = JSON.parse(readFileSync(jsonPath, 'utf8'));

/**
 * 通用 resolver:`process.env[envVarName] || productionEndpoints[key]`。
 * env 在每次调用时读取(不缓存),便于测试注入与运行中切换。
 *
 * @param {keyof typeof productionEndpoints} key
 * @param {string} [envVarName] 允许覆盖该端点的环境变量名;省略则不接受 env 覆盖
 * @returns {string}
 */
export function resolveEndpoint(key, envVarName) {
  const override = envVarName ? process.env[envVarName] : undefined;
  return override || productionEndpoints[key];
}

/** CDN 基址:XDT_CDN_BASE_URL 可覆盖(发布/兜底下载脚本的统一入口)。 */
export function resolveCdnBaseUrl() {
  return resolveEndpoint('cdnBaseUrl', 'XDT_CDN_BASE_URL');
}

/**
 * 桌面端生产构建注入的三个 VITE_* 端点 env,spread 进 execSync 的 env 即可:
 * `env: { ...process.env, ...productionViteEnv() }`。
 *
 * @param {{ allowEnvOverride?: boolean }} [opts]
 *   allowEnvOverride=true(默认,CI 构建脚本用):外部已设同名 env 时尊重外部值;
 *   allowEnvOverride=false(本机正式 release 脚本用):无条件用权威源,防止本机
 *   残留的 .env / shell 变量把正式包指到错误环境。
 */
export function productionViteEnv({ allowEnvOverride = true } = {}) {
  const pick = (envName, key) =>
    (allowEnvOverride ? process.env[envName] : undefined) || productionEndpoints[key];
  return {
    VITE_API_BASE_URL: pick('VITE_API_BASE_URL', 'apiBaseUrl'),
    VITE_DEVICE_LINK_API_BASE_URL: pick('VITE_DEVICE_LINK_API_BASE_URL', 'deviceLinkApiBaseUrl'),
    VITE_OAUTH_BROKER_API_BASE_URL: pick('VITE_OAUTH_BROKER_API_BASE_URL', 'oauthBrokerApiBaseUrl'),
  };
}
