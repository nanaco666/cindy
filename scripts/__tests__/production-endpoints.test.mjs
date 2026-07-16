import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import {
  loadProductionEndpoints,
  productionMobileEnv,
  productionViteEnv,
  validateProductionEndpointsExample,
} from '../shared/production-endpoints.mjs';

const tempDirs = [];
const originalConfigPath = process.env.CINDY_PRODUCTION_ENDPOINTS_FILE;

afterEach(() => {
  if (originalConfigPath == null) delete process.env.CINDY_PRODUCTION_ENDPOINTS_FILE;
  else process.env.CINDY_PRODUCTION_ENDPOINTS_FILE = originalConfigPath;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('example 只声明完整字段集合且值为空', () => {
  const example = validateProductionEndpointsExample();
  assert.ok(Object.values(example).every((value) => value === ''));
});

test('私有 JSON 是 Desktop/Mobile 构建注入的唯一输入', () => {
  const values = fixtureEndpoints();
  const filePath = writeFixture(values);
  process.env.CINDY_PRODUCTION_ENDPOINTS_FILE = filePath;

  assert.deepEqual({ ...loadProductionEndpoints() }, values);
  assert.deepEqual(productionMobileEnv(), {
    EXPO_PUBLIC_XDT_API_BASE_URL: values.apiBaseUrl,
    EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL: values.deviceLinkApiBaseUrl,
    EXPO_PUBLIC_XDT_MOBILE_VOICE_LITELLM_BASE_URL: values.xdGatewayBaseUrl,
  });
  assert.deepEqual(productionViteEnv({ allowEnvOverride: false }), {
    VITE_API_BASE_URL: values.apiBaseUrl,
    VITE_DEVICE_LINK_API_BASE_URL: values.deviceLinkApiBaseUrl,
    VITE_OAUTH_BROKER_API_BASE_URL: values.oauthBrokerApiBaseUrl,
    VITE_HEARTBEAT_URL: values.heartbeatUrl,
    VITE_SLACK_HOOK_WS_URL: values.slackHookWsUrl,
    VITE_XDPROXY_BASE_URL: values.xdGatewayBaseUrl,
    VITE_CDN_BASE_URL: values.cdnBaseUrl,
    VITE_CDN_INTERNAL_BASE_URL: values.cdnInternalBaseUrl,
  });
});

test('缺字段、非法协议和 URL 内凭据都会 fail closed', () => {
  const missing = fixtureEndpoints();
  delete missing.apiBaseUrl;
  process.env.CINDY_PRODUCTION_ENDPOINTS_FILE = writeFixture(missing);
  assert.throws(() => loadProductionEndpoints(), /apiBaseUrl/);

  process.env.CINDY_PRODUCTION_ENDPOINTS_FILE = writeFixture({
    ...fixtureEndpoints(),
    unknownField: 'https://unknown.example.invalid',
  });
  assert.throws(() => loadProductionEndpoints(), /unknownField/);

  process.env.CINDY_PRODUCTION_ENDPOINTS_FILE = writeFixture({
    ...fixtureEndpoints(),
    slackHookWsUrl: 'https://hook.example.invalid',
  });
  assert.throws(() => loadProductionEndpoints(), /slackHookWsUrl/);

  process.env.CINDY_PRODUCTION_ENDPOINTS_FILE = writeFixture({
    ...fixtureEndpoints(),
    apiBaseUrl: 'https://user:pass@api.example.invalid',
  });
  assert.throws(() => loadProductionEndpoints(), /携带凭据/);
});

function fixtureEndpoints() {
  return {
    apiBaseUrl: 'https://api.example.invalid',
    deviceLinkApiBaseUrl: 'https://relay.example.invalid',
    oauthBrokerApiBaseUrl: 'https://oauth.example.invalid',
    heartbeatUrl: 'https://heartbeat.example.invalid',
    slackHookWsUrl: 'wss://hook.example.invalid',
    xdGatewayBaseUrl: 'https://gateway.example.invalid',
    cdnBaseUrl: 'https://cdn.example.invalid/app',
    cdnInternalBaseUrl: 'http://cdn-internal.example.invalid/app',
    npkgBaseUrl: 'https://npkg.example.invalid',
  };
}

function writeFixture(value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-endpoints-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'production-endpoints.json');
  fs.writeFileSync(filePath, JSON.stringify(value));
  return filePath;
}
