const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_FILE_NAME = 'production-endpoints.json';
const MOBILE_ENV_FIELDS = Object.freeze({
  EXPO_PUBLIC_FEISHU_APP_ID: 'feishuAppId',
  EXPO_PUBLIC_XDT_API_BASE_URL: 'apiBaseUrl',
  EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL: 'deviceLinkApiBaseUrl',
  EXPO_PUBLIC_XDT_MOBILE_VOICE_LITELLM_BASE_URL: 'xdGatewayBaseUrl',
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
  return Object.freeze(env);
}

module.exports = { loadProductionMobileEnv };
