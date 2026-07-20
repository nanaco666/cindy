// publish-desktop 发布纯逻辑(apps/desktop/scripts/ci/publish-lib.mjs)的回归测试:
// 参数解析、build-info 发布前校验、签名门禁、版本推进判定、manifest 组装、上传计划。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parsePublishArgs,
  candidatePlatformKeys,
  validateBuildInfoForPublish,
  assertPublishableSigning,
  assertAgentProbeSupported,
  assertManifestAgentEntries,
  compareSemver,
  resolveVersionAdvance,
  applyAppToManifest,
  planArtifactUploads,
} from '../../apps/desktop/scripts/ci/publish-lib.mjs';

const DEFAULTS = { platform: 'win32' };

// ── 编排层顺序契约(与 package-desktop 同款的源码顺序断言)────────────────────

test('publish orchestrator: region 选择先于 ensureBinary,binary 上传先于 manifest 上传', () => {
  const source = fs.readFileSync(
    new URL('../../apps/desktop/scripts/publish-desktop.mjs', import.meta.url),
    'utf8',
  );
  const regionIndex = source.indexOf('process.env.CINDY_AUTH_REGION = region;');
  const agentsIndex = source.indexOf('await publishAgentBinaries(');
  const manifestUploadIndex = source.indexOf('await uploadToOSS(client, manifestOssKey');
  assert.notEqual(regionIndex, -1);
  assert.notEqual(agentsIndex, -1);
  assert.notEqual(manifestUploadIndex, -1);
  assert.ok(regionIndex < agentsIndex);
  assert.ok(agentsIndex < manifestUploadIndex, '先传二进制、后传 manifest 的铁律不能倒');
});

// ── parsePublishArgs ─────────────────────────────────────────────────────────

test('parsePublishArgs: 缺 --version 直接拒绝', () => {
  assert.throws(() => parsePublishArgs([], DEFAULTS), /--version/);
});

test('parsePublishArgs: bump 关键字在发布侧不被接受', () => {
  assert.throws(() => parsePublishArgs(['--version', 'patch'], DEFAULTS), /x\.y\.z/);
});

test('parsePublishArgs: 默认 dry-run + cn + 全 arch', () => {
  const args = parsePublishArgs(['--version', '1.2.3'], DEFAULTS);
  assert.deepEqual(args, {
    region: 'cn',
    version: '1.2.3',
    platform: 'win32',
    arch: null,
    execute: false,
    requireRelogin: false,
    force: false,
  });
});

test('parsePublishArgs: 完整参数解析', () => {
  const args = parsePublishArgs(
    ['--region', 'global', '--version', '2.0.0', '--platform', 'darwin', '--arch', 'arm64', '--execute', '--require-relogin', '--force'],
    DEFAULTS,
  );
  assert.equal(args.region, 'global');
  assert.equal(args.version, '2.0.0');
  assert.equal(args.platform, 'darwin');
  assert.equal(args.arch, 'arm64');
  assert.equal(args.execute, true);
  assert.equal(args.requireRelogin, true);
  assert.equal(args.force, true);
});

test('parsePublishArgs: 非法 region / platform / arch 组合被拒绝', () => {
  assert.throws(() => parsePublishArgs(['--version', '1.0.0', '--region', 'jp'], DEFAULTS), /region/);
  assert.throws(() => parsePublishArgs(['--version', '1.0.0', '--platform', 'sunos'], DEFAULTS), /platform/);
  assert.throws(() => parsePublishArgs(['--version', '1.0.0', '--arch', 'arm64'], DEFAULTS), /arch/); // win32 无 arm64
});

test('candidatePlatformKeys: darwin 缺省展开双架构,指定 arch 只留一个', () => {
  assert.deepEqual(candidatePlatformKeys('darwin'), ['darwin-arm64', 'darwin-x64']);
  assert.deepEqual(candidatePlatformKeys('darwin', 'x64'), ['darwin-x64']);
  assert.deepEqual(candidatePlatformKeys('win32'), ['win32-x64']);
});

// ── validateBuildInfoForPublish ──────────────────────────────────────────────

function validBuildInfo(overrides = {}) {
  return {
    schemaVersion: 2,
    product: 'cindy-desktop',
    version: '1.2.3',
    versionless: false,
    region: 'cn',
    platform: 'win32',
    arch: 'x64',
    platformKey: 'win32-x64',
    files: [
      { role: 'installer', name: 'cindy-1.2.3-Setup.exe', sha256: 'a'.repeat(64), size: 100 },
      { role: 'hotfix', name: 'cindy-1.2.3-hotfix.zip', sha256: 'b'.repeat(64), size: 50 },
    ],
    signing: { installerSigned: true, internalExesSigned: true },
    ...overrides,
  };
}

const EXPECTED = { region: 'cn', version: '1.2.3', platformKey: 'win32-x64' };

test('validateBuildInfoForPublish: 合法 build-info 取出 installer/hotfix', () => {
  const { installer, hotfix } = validateBuildInfoForPublish(validBuildInfo(), EXPECTED);
  assert.equal(installer.name, 'cindy-1.2.3-Setup.exe');
  assert.equal(hotfix.name, 'cindy-1.2.3-hotfix.zip');
});

test('validateBuildInfoForPublish: versionless 拒发', () => {
  assert.throws(
    () => validateBuildInfoForPublish(validBuildInfo({ version: null, versionless: true }), EXPECTED),
    /versionless/,
  );
});

test('validateBuildInfoForPublish: region / version / platformKey 任一不匹配拒发', () => {
  assert.throws(() => validateBuildInfoForPublish(validBuildInfo({ region: 'global' }), EXPECTED), /region/);
  assert.throws(() => validateBuildInfoForPublish(validBuildInfo({ version: '9.9.9' }), EXPECTED), /版本不匹配/);
  assert.throws(
    () => validateBuildInfoForPublish(validBuildInfo({ platformKey: 'darwin-arm64' }), EXPECTED),
    /platformKey/,
  );
});

test('validateBuildInfoForPublish: schemaVersion 只认 2', () => {
  assert.throws(() => validateBuildInfoForPublish(validBuildInfo({ schemaVersion: 1 }), EXPECTED), /schemaVersion/);
});

test('validateBuildInfoForPublish: 非 linux 缺 hotfix 拒发,linux 允许 installer-only', () => {
  const noHotfix = validBuildInfo({
    files: [{ role: 'installer', name: 'cindy-1.2.3-Setup.exe', sha256: 'a'.repeat(64), size: 100 }],
  });
  assert.throws(() => validateBuildInfoForPublish(noHotfix, EXPECTED), /hotfix/);

  const linux = validBuildInfo({
    platform: 'linux',
    platformKey: 'linux-x64',
    signing: { mode: 'none' },
    files: [{ role: 'installer', name: 'cindy-1.2.3-amd64.deb', sha256: 'a'.repeat(64), size: 100 }],
  });
  const { hotfix } = validateBuildInfoForPublish(linux, { ...EXPECTED, platformKey: 'linux-x64' });
  assert.equal(hotfix, null);
});

test('validateBuildInfoForPublish: files 条目 sha256/size 非法拒发', () => {
  const bad = validBuildInfo({
    files: [{ role: 'installer', name: 'x.exe', sha256: 'not-a-hash', size: 100 }],
  });
  assert.throws(() => validateBuildInfoForPublish(bad, EXPECTED), /条目非法/);
});

// ── assertPublishableSigning ─────────────────────────────────────────────────

test('assertPublishableSigning: win 未签名拒发,mac 非公证拒发,linux 放行', () => {
  assert.throws(
    () => assertPublishableSigning(validBuildInfo({ signing: { installerSigned: false } })),
    /未签名/,
  );
  assert.doesNotThrow(() => assertPublishableSigning(validBuildInfo()));

  const macAdhoc = validBuildInfo({ platform: 'darwin', signing: { mode: 'adhoc' } });
  assert.throws(() => assertPublishableSigning(macAdhoc), /developer-id\+notarized/);
  const macSigned = validBuildInfo({ platform: 'darwin', signing: { mode: 'developer-id+notarized' } });
  assert.doesNotThrow(() => assertPublishableSigning(macSigned));

  assert.doesNotThrow(() => assertPublishableSigning(validBuildInfo({ platform: 'linux', signing: { mode: 'none' } })));
});

// ── 跨平台代传硬闸 / manifest agent 段断言 ───────────────────────────────────

test('assertAgentProbeSupported: 异平台拒绝,同平台放行', () => {
  assert.throws(() => assertAgentProbeSupported('darwin', 'win32'), /跨平台代传/);
  assert.doesNotThrow(() => assertAgentProbeSupported('win32', 'win32'));
});

test('assertManifestAgentEntries: 缺段 / 占位版本 / 缺 file 都拒绝,完整放行', () => {
  const ok = {
    claudeCode: { version: '2.1.0', file: 'claude-code/2.1.0/win32-x64/claude.exe.gz' },
    codex: { version: '0.5.0', file: 'codex/0.5.0/win32-x64/codex.exe.gz' },
  };
  assert.doesNotThrow(() => assertManifestAgentEntries(ok));
  assert.throws(() => assertManifestAgentEntries({ codex: ok.codex }), /claudeCode/);
  assert.throws(
    () => assertManifestAgentEntries({ ...ok, codex: { version: '0.0.0', file: 'x' } }),
    /codex/,
  );
  assert.throws(
    () => assertManifestAgentEntries({ ...ok, claudeCode: { version: '2.1.0', file: '' } }),
    /claudeCode/,
  );
});

// ── 编排层门禁接线(源码断言:门禁必须真的被调用)──────────────────────────

test('publish orchestrator: 跨平台硬闸在入口生效,agent 段断言先于 manifest 上传', () => {
  const source = fs.readFileSync(
    new URL('../../apps/desktop/scripts/publish-desktop.mjs', import.meta.url),
    'utf8',
  );
  const probeGateIndex = source.indexOf('assertAgentProbeSupported(platform)');
  const agentsIndex = source.indexOf('await publishAgentBinaries(');
  const entriesGateIndex = source.indexOf('assertManifestAgentEntries(manifest)');
  const manifestUploadIndex = source.indexOf('await uploadToOSS(client, manifestOssKey');
  assert.notEqual(probeGateIndex, -1);
  assert.notEqual(entriesGateIndex, -1);
  assert.ok(probeGateIndex < agentsIndex);
  assert.ok(agentsIndex < entriesGateIndex);
  assert.ok(entriesGateIndex < manifestUploadIndex);
});

// ── 版本推进判定 ─────────────────────────────────────────────────────────────

test('compareSemver: 数值比较而非字典序', () => {
  assert.equal(compareSemver('0.10.0', '0.9.0'), 1);
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
  assert.equal(compareSemver('1.2.3', '1.10.0'), -1);
});

test('resolveVersionAdvance: fresh / advance / republish / 回退拒绝与 force 放行', () => {
  assert.equal(resolveVersionAdvance({ newVersion: '1.0.0', cdnVersion: null }).kind, 'fresh');
  assert.equal(resolveVersionAdvance({ newVersion: '1.0.0', cdnVersion: '0.0.0' }).kind, 'fresh');
  assert.equal(resolveVersionAdvance({ newVersion: '1.1.0', cdnVersion: '1.0.9' }).kind, 'advance');
  assert.equal(resolveVersionAdvance({ newVersion: '1.1.0', cdnVersion: '1.1.0' }).kind, 'republish');
  assert.throws(() => resolveVersionAdvance({ newVersion: '1.0.0', cdnVersion: '1.1.0' }), /版本回退/);
  assert.equal(
    resolveVersionAdvance({ newVersion: '1.0.0', cdnVersion: '1.1.0', force: true }).kind,
    'rollback-forced',
  );
});

// ── manifest 组装 ────────────────────────────────────────────────────────────

const INSTALLER = { name: 'cindy-1.2.3-Setup.exe', sha256: 'a'.repeat(64), size: 100 };
const HOTFIX = { name: 'cindy-1.2.3-hotfix.zip', sha256: 'b'.repeat(64), size: 50 };

test('applyAppToManifest: 全新渠道从空骨架起步', () => {
  const m = applyAppToManifest(null, {
    platform: 'win32', platformKey: 'win32-x64', version: '1.2.3',
    requireRelogin: false, installer: INSTALLER, hotfix: HOTFIX,
  });
  assert.equal(m.app.version, '1.2.3');
  assert.equal(m.app.installer.file, 'app/win32-x64/cindy-1.2.3-Setup.exe');
  assert.equal(m.app.hotfix.file, 'hotfix/win32-x64/cindy-1.2.3-hotfix.zip');
  assert.equal('requireRelogin' in m.app, false);
});

test('applyAppToManifest: 不改传入的现有 manifest,保留 claudeCode 等无关段', () => {
  const existing = {
    app: { version: '1.0.0', requireRelogin: true, releaseNotes: 'hi' },
    claudeCode: { version: '2.0.0', file: 'claude-code/2.0.0/win32-x64/claude.exe.gz' },
  };
  const m = applyAppToManifest(existing, {
    platform: 'win32', platformKey: 'win32-x64', version: '1.2.3',
    requireRelogin: false, installer: INSTALLER, hotfix: HOTFIX,
  });
  // 原对象不被改动
  assert.equal(existing.app.version, '1.0.0');
  assert.equal(existing.app.requireRelogin, true);
  // 新 manifest:版本推进、requireRelogin 删干净、无关段原样保留
  assert.equal(m.app.version, '1.2.3');
  assert.equal('requireRelogin' in m.app, false);
  assert.equal(m.app.releaseNotes, 'hi');
  assert.deepEqual(m.claudeCode, existing.claudeCode);
});

test('applyAppToManifest: requireRelogin=true 写入标记', () => {
  const m = applyAppToManifest(null, {
    platform: 'win32', platformKey: 'win32-x64', version: '1.2.3',
    requireRelogin: true, installer: INSTALLER, hotfix: HOTFIX,
  });
  assert.equal(m.app.requireRelogin, true);
});

test('applyAppToManifest: linux installer-only,剥掉 hotfix/requireRelogin/历史 installer 段', () => {
  const existing = {
    app: { version: '1.0.0', hotfix: { file: 'x' }, requireRelogin: true },
    installer: { legacy: true },
  };
  const m = applyAppToManifest(existing, {
    platform: 'linux', platformKey: 'linux-x64', version: '1.2.3',
    requireRelogin: true, installer: { name: 'cindy-1.2.3-amd64.deb', sha256: 'c'.repeat(64), size: 10 },
    hotfix: null,
  });
  assert.equal(m.app.version, '1.2.3');
  assert.equal(m.app.installer.file, 'app/linux-x64/cindy-1.2.3-amd64.deb');
  assert.equal('hotfix' in m.app, false);
  assert.equal('requireRelogin' in m.app, false);
  assert.equal('installer' in m, false);
});

// ── 上传计划 ─────────────────────────────────────────────────────────────────

test('planArtifactUploads: installer + hotfix 的 OSS key 布局', () => {
  const uploads = planArtifactUploads('cindy', 'win32-x64', { installer: INSTALLER, hotfix: HOTFIX });
  assert.deepEqual(uploads.map((u) => u.ossKey), [
    'cindy/app/win32-x64/cindy-1.2.3-Setup.exe',
    'cindy/hotfix/win32-x64/cindy-1.2.3-hotfix.zip',
  ]);
});

test('planArtifactUploads: 无 hotfix 时只有 installer', () => {
  const uploads = planArtifactUploads('cindy', 'linux-x64', { installer: INSTALLER, hotfix: null });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].role, 'installer');
});
