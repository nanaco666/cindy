const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_FILE_NAME = 'production-endpoints.json';
// 2026-07 端点清单重构后收缩:业务端点不再构建期烘焙(运行期由启动闸门从
// `<manifest base>/endpoint.json` 回填;dev 读仓内 config/endpoint.json)。
// 与 ESM 侧 productionMobileEnv 输出键集保持一致。
const MOBILE_ENV_FIELDS = Object.freeze({
  EXPO_PUBLIC_FEISHU_APP_ID: 'feishuAppId',
});

function resolveConfigPath() {
  const configured = process.env.CINDY_PRODUCTION_ENDPOINTS_FILE?.trim();
  return configured
    ? path.resolve(REPO_ROOT, configured)
    : path.join(REPO_ROOT, 'config', CONFIG_FILE_NAME);
}

/**
 * Load the public mobile build environment for app.config.js, which is a
 * CommonJS synchronous entry point and cannot import the ESM endpoint loader.
 */
function loadProductionMobileEnv() {
  const configPath = resolveConfigPath();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`Missing production endpoint config: ${configPath}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Production endpoint config is not valid JSON: ${configPath}`);
    }
    throw error;
  }

  const env = {};
  for (const [envKey, configKey] of Object.entries(MOBILE_ENV_FIELDS)) {
    const value = parsed?.[configKey];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Missing non-empty production endpoint field: ${configKey}`);
    }
    const normalized = value.trim();
    if (configKey === 'feishuAppId') {
      if (!/^cli_[a-z0-9]+$/i.test(normalized)) {
        throw new Error(`Invalid Feishu app id in production endpoint config: ${configKey}`);
      }
    } else {
      let url;
      try {
        url = new URL(normalized);
      } catch {
        throw new Error(`Invalid URL in production endpoint config: ${configKey}`);
      }
      if (url.protocol !== 'https:') {
        throw new Error(`Production mobile endpoint must use HTTPS: ${configKey}`);
      }
    }
    env[envKey] = normalized.replace(/\/+$/, '');
  }
  const authRegion = process.env.EXPO_PUBLIC_CINDY_AUTH_REGION?.trim() || 'cn';
  if (authRegion !== 'cn' && authRegion !== 'global') {
    throw new Error(`Invalid Cindy auth region: ${authRegion}; expected cn or global`);
  }
  const readHttpsField = (configKey) => {
    const raw = parsed?.[configKey];
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error(`Missing non-empty production endpoint field: ${configKey}`);
    }
    let url;
    try {
      url = new URL(raw.trim());
    } catch {
      throw new Error(`Invalid URL in production endpoint config: ${configKey}`);
    }
    if (url.protocol !== 'https:') {
      throw new Error(`Production mobile endpoint must use HTTPS: ${configKey}`);
    }
    return raw.trim().replace(/\/+$/, '');
  };
  env.EXPO_PUBLIC_CINDY_AUTH_REGION = authRegion;
  // 端点清单(endpoint.json)自举基址,按 region 二选一(与 ESM 侧 productionMobileEnv 对齐)。
  env.EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL = readHttpsField(
    authRegion === 'global' ? 'endpointManifestBaseUrlGlobal' : 'endpointManifestBaseUrlCn',
  );
  return Object.freeze(env);
}

module.exports = { loadProductionMobileEnv };
