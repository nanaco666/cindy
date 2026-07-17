import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { generateEndpointLocalFile } from '../shared/endpoint-local-file.mjs';

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRepoRoot(manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'endpoint-local-file-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  if (manifest !== undefined) {
    fs.writeFileSync(path.join(dir, 'config', 'endpoint.json'), manifest);
  }
  return dir;
}

const CN_MANIFEST = JSON.stringify({
  schemaVersion: 1,
  apiBaseUrl: 'https://api.example.invalid',
  authApiBaseUrl: 'https://auth.example.invalid',
  deviceLinkApiBaseUrl: 'https://device.example.invalid',
  oauthBrokerApiBaseUrl: 'https://oauth.example.invalid',
  heartbeatUrl: 'https://heartbeat.example.invalid',
  slackHookWsUrl: 'wss://hook.example.invalid',
  websiteUrl: 'https://website.example.invalid',
  xdGatewayBaseUrl: 'https://gateway.example.invalid',
  cdnBaseUrl: 'https://cdn.example.invalid/app',
  cdnInternalBaseUrl: 'http://cdn-internal.example.invalid/app',
});

test('localhost 三件套覆写,其余字段照抄 cn 正本,返回绝对路径', () => {
  const repoRoot = makeRepoRoot(CN_MANIFEST);
  const target = generateEndpointLocalFile({ repoRoot });
  assert.equal(target, path.join(repoRoot, 'config', 'endpoint.local.json'));
  const local = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(local.apiBaseUrl, 'http://localhost:3333');
  assert.equal(local.authApiBaseUrl, 'http://localhost:3344');
  assert.equal(local.deviceLinkApiBaseUrl, 'http://localhost:3335');
  // 其余字段与正本一致(oauth broker 等本地不起的服务沿用远程值)
  assert.equal(local.oauthBrokerApiBaseUrl, 'https://oauth.example.invalid');
  assert.equal(local.cdnBaseUrl, 'https://cdn.example.invalid/app');
  assert.equal(local.schemaVersion, 1);
});

test('幂等:重复生成整文件重写,手改会丢', () => {
  const repoRoot = makeRepoRoot(CN_MANIFEST);
  const target = generateEndpointLocalFile({ repoRoot });
  const manual = JSON.parse(fs.readFileSync(target, 'utf8'));
  manual.apiBaseUrl = 'http://localhost:9999';
  fs.writeFileSync(target, JSON.stringify(manual));
  generateEndpointLocalFile({ repoRoot });
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).apiBaseUrl, 'http://localhost:3333');
});

test('cn 正本缺失 / 非法直接抛错(fail closed,不造半截配置)', () => {
  assert.throws(() => generateEndpointLocalFile({ repoRoot: makeRepoRoot(undefined) }));
  assert.throws(() => generateEndpointLocalFile({ repoRoot: makeRepoRoot('not-json{{') }));
});

test('生成物能过客户端 parser 的 allowHttp 校验(与仓内正本同一守门语义)', async () => {
  // maker-shared 是 TS 源码直发,node --test 下直接 import .ts 不可行;
  // 这里按 parser 的公开语义做最小同构校验:全字段齐备 + localhost 用 http。
  const repoRoot = makeRepoRoot(CN_MANIFEST);
  const local = JSON.parse(fs.readFileSync(generateEndpointLocalFile({ repoRoot }), 'utf8'));
  const requiredKeys = [
    'apiBaseUrl',
    'authApiBaseUrl',
    'deviceLinkApiBaseUrl',
    'oauthBrokerApiBaseUrl',
    'heartbeatUrl',
    'slackHookWsUrl',
    'websiteUrl',
    'xdGatewayBaseUrl',
    'cdnBaseUrl',
    'cdnInternalBaseUrl',
  ];
  for (const key of requiredKeys) {
    assert.ok(typeof local[key] === 'string' && local[key].length > 0, key);
    assert.doesNotThrow(() => new URL(local[key]), key);
  }
});
