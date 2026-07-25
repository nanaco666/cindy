// cua-driver update.mjs 纯函数单测。
//
// 验证：平台过滤（仅 darwin）、asset 文件名拼接规则、版本 pin 读取。
// 不做网络请求；不调用 ensurePlatform（需要网络+磁盘）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readPinnedVersion, ensurePlatform } from '../../tools/cua-driver/update.mjs';

// ── version pin ─────────────────────────────────────────────────────────────

test('readPinnedVersion: returns string version from tools/cua-driver/latest.json', () => {
  const version = readPinnedVersion();
  assert.ok(typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version),
    `Expected semver string, got: ${version}`);
});

// ── platform filter via ensurePlatform ───────────────────────────────────────
// ensurePlatform は非 darwin platformKey に対して静默でリターンする（ダウンロードしない）。
// 正常終了（例外なし・返値 undefined）を確認。

test('ensurePlatform: silently returns for linux-x64 (not darwin)', async () => {
  const result = await ensurePlatform({ version: '0.12.3', platformKey: 'linux-x64' });
  assert.equal(result, undefined);
});

test('ensurePlatform: silently returns for win32-x64 (not darwin)', async () => {
  const result = await ensurePlatform({ version: '0.12.3', platformKey: 'win32-x64' });
  assert.equal(result, undefined);
});

test('ensurePlatform: throws for unknown darwin platform key', async () => {
  await assert.rejects(
    () => ensurePlatform({ version: '0.12.3', platformKey: 'darwin-arm32' }),
    /Unknown darwin platform key for cua-driver/,
  );
});

// ── asset name validation ────────────────────────────────────────────────────
// tools/cua-driver/update.mjs 内部の PLATFORMS 定義を間接テスト:
// latest.json の runtimeAssets URL にアセット名が含まれることで asset naming を確認する。

test('latest.json runtimeAssets contain correct asset names for darwin platforms', async () => {
  const { default: latest } = await import('../../tools/cua-driver/latest.json', { with: { type: 'json' } });
  const { runtimeAssets, version } = latest;

  // darwin-arm64
  const arm64 = runtimeAssets['darwin-arm64'];
  assert.ok(arm64, 'runtimeAssets should have darwin-arm64');
  assert.ok(arm64.url.includes(`cua-driver-rs-${version}-darwin-arm64.tar.gz`),
    `darwin-arm64 URL should contain expected asset name, got: ${arm64.url}`);
  assert.ok(typeof arm64.sha256 === 'string' && /^[a-f0-9]{64}$/.test(arm64.sha256),
    `darwin-arm64 sha256 should be 64-char hex, got: ${arm64.sha256}`);

  // darwin-x64
  const x64 = runtimeAssets['darwin-x64'];
  assert.ok(x64, 'runtimeAssets should have darwin-x64');
  assert.ok(x64.url.includes(`cua-driver-rs-${version}-darwin-x86_64.tar.gz`),
    `darwin-x64 URL should contain expected asset name, got: ${x64.url}`);
  assert.ok(typeof x64.sha256 === 'string' && /^[a-f0-9]{64}$/.test(x64.sha256),
    `darwin-x64 sha256 should be 64-char hex, got: ${x64.sha256}`);

  // 非 darwin プラットフォームは runtimeAssets に存在しない
  assert.ok(!runtimeAssets['linux-x64'], 'runtimeAssets should not have linux-x64');
  assert.ok(!runtimeAssets['win32-x64'], 'runtimeAssets should not have win32-x64');
});

test('latest.json version matches semver and tag_name has correct prefix', async () => {
  const { default: latest } = await import('../../tools/cua-driver/latest.json', { with: { type: 'json' } });
  assert.ok(/^\d+\.\d+\.\d+$/.test(latest.version), `version should be semver: ${latest.version}`);
  assert.ok(latest.tag_name.startsWith('cua-driver-rs-v'), `tag_name should start with cua-driver-rs-v: ${latest.tag_name}`);
  assert.ok(latest.tag_name.endsWith(latest.version), `tag_name should end with version: ${latest.tag_name}`);
});
