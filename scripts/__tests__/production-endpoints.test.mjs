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
import { resolveOssConfig } from '../shared/oss.mjs';

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
  // 2026-07 端点清单重构:mobile 构建注入收缩为身份 + 清单自举基址,
  // 业务端点运行期由启动闸门回填。
  assert.deepEqual(productionMobileEnv(), {
    EXPO_PUBLIC_FEISHU_APP_ID: values.feishuAppId,
    EXPO_PUBLIC_CINDY_AUTH_REGION: 'cn',
    EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL: values.endpointManifestBaseUrlCn,
  });
  assert.equal(
    productionMobileEnv({ authRegion: 'global' }).EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL,
    values.endpointManifestBaseUrlGlobal,
  );
  assert.deepEqual(resolveOssConfig(), {
    cdnBase: values.cdnBaseUrl,
    bucket: values.ossBucket,
    prefix: values.ossPrefix,
    region: values.ossRegion,
  });
  assert.deepEqual(productionViteEnv({ allowEnvOverride: false }), {
    VITE_FEISHU_APP_ID: values.feishuAppId,
    VITE_CINDY_AUTH_REGION: 'cn',
    VITE_ENDPOINT_MANIFEST_BASE_URL: values.endpointManifestBaseUrlCn,
  });
  assert.equal(
    productionViteEnv({ allowEnvOverride: false, authRegion: 'global' })
      .VITE_ENDPOINT_MANIFEST_BASE_URL,
    values.endpointManifestBaseUrlGlobal,
  );
});

test('缺字段、非法协议和 URL 内凭据都会 fail closed', () => {
  const missing = fixtureEndpoints();
  delete missing.apiBaseUrl;
  process.env.CINDY_PRODUCTION_ENDPOINTS_FILE = writeFixture(missing);
  assert.throws(() => loadProductionEndpoints(), /apiBaseUrl/);

  const missingApp = fixtureEndpoints();
  delete missingApp.feishuAppId;
  process.env.CINDY_PRODUCTION_ENDPOINTS_FILE = writeFixture(missingApp);
  assert.throws(() => loadProductionEndpoints(), /feishuAppId/);

  process.env.CINDY_PRODUCTION_ENDPOINTS_FILE = writeFixture({
    ...fixtureEndpoints(),
    feishuAppId: 'invalid-app-id',
  });
  assert.throws(() => loadProductionEndpoints(), /feishuAppId/);

  const missingOss = fixtureEndpoints();
  delete missingOss.ossBucket;
  process.env.CINDY_PRODUCTION_ENDPOINTS_FILE = writeFixture(missingOss);
  assert.throws(() => loadProductionEndpoints(), /ossBucket/);

  process.env.CINDY_PRODUCTION_ENDPOINTS_FILE = writeFixture({
    ...fixtureEndpoints(),
    unknownField: 'https://unknown.example.invalid',
  });
  assert.throws(() => loadProductionEndpoints(), /unknownField/);

  process.env.CINDY_PRODUCTION_ENDPOINTS_FILE = writeFixture({
    ...fixtureEndpoints(),
    endpointManifestBaseUrlCn: 'http://hotfix-cn.example.invalid/app',
  });
  assert.throws(() => loadProductionEndpoints(), /endpointManifestBaseUrlCn/);

  process.env.CINDY_PRODUCTION_ENDPOINTS_FILE = writeFixture({
    ...fixtureEndpoints(),
    apiBaseUrl: 'https://user:pass@api.example.invalid',
  });
  assert.throws(() => loadProductionEndpoints(), /携带凭据/);
});

function fixtureEndpoints() {
  return {
    feishuAppId: 'cli_testapp',
    apiBaseUrl: 'https://api.example.invalid',
    authApiBaseUrlCn: 'https://auth-cn.example.invalid',
    authApiBaseUrlGlobal: 'https://auth-global.example.invalid',
    deviceLinkApiBaseUrl: 'https://relay.example.invalid',
    xdGatewayBaseUrl: 'https://gateway.example.invalid',
    cdnBaseUrl: 'https://cdn.example.invalid/app',
    cdnInternalBaseUrl: 'http://cdn-internal.example.invalid/app',
    npkgBaseUrl: 'https://npkg.example.invalid',
    endpointManifestBaseUrlCn: 'https://hotfix-cn.example.invalid/app',
    endpointManifestBaseUrlGlobal: 'https://hotfix-global.example.invalid/app',
    ossBucket: 'test-bucket',
    ossPrefix: 'test-prefix',
    ossRegion: 'oss-test-region',
  };
}

function writeFixture(value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'production-endpoints-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'production-endpoints.json');
  fs.writeFileSync(filePath, JSON.stringify(value));
  return filePath;
}
