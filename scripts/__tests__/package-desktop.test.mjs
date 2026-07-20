// package-desktop 打包纯逻辑(apps/desktop/scripts/ci/package-lib.mjs)的回归测试:
// 参数解析、版本解析(版本无关默认 / 显式 / bump)、产物目录与 build-info 组装。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  VERSIONLESS_VERSION,
  parsePackageArgs,
  bumpVersion,
  resolvePackageVersion,
  artifactRelDir,
  artifactBaseName,
  buildBuildInfo,
} from '../../apps/desktop/scripts/ci/package-lib.mjs';

const DEFAULTS = { platform: 'win32', arch: 'x64' };

test('global package selects its region before agent binary CDN fallback', () => {
  const source = fs.readFileSync(
    new URL('../../apps/desktop/scripts/package-desktop.mjs', import.meta.url),
    'utf8',
  );
  const regionIndex = source.indexOf('process.env.CINDY_AUTH_REGION = region;');
  const ensureIndex = source.indexOf('await ensureBinary(kind, platformKey);');
  assert.notEqual(regionIndex, -1);
  assert.notEqual(ensureIndex, -1);
  assert.ok(regionIndex < ensureIndex);
});

test('parsePackageArgs: 容忍 pnpm 透传的裸 --(pnpm 10 不剥离 run-script 分隔符)', () => {
  const args = parsePackageArgs(['--', '--region', 'cn', '--version', '0.1.0'], DEFAULTS);
  assert.equal(args.region, 'cn');
  assert.equal(args.versionSpec, '0.1.0');
});

test('parsePackageArgs: 零参数默认 = 当前平台 + cn + 版本无关', () => {
  const args = parsePackageArgs([], DEFAULTS);
  assert.deepEqual(args, {
    platform: 'win32',
    region: 'cn',
    versionSpec: null,
    skipSmoke: false,
    allowUnsigned: false,
    noSign: false,
    archs: ['x64'],
  });
});

test('parsePackageArgs: darwin 缺省双架构连打,显式 --arch 只打单架构', () => {
  const darwinDefaults = { platform: 'darwin', arch: 'arm64' };
  assert.deepEqual(parsePackageArgs([], darwinDefaults).archs, ['arm64', 'x64']);
  assert.deepEqual(parsePackageArgs(['--arch', 'x64'], darwinDefaults).archs, ['x64']);
  // win 机器上 --platform darwin(会被编排层交叉打包硬闸拦,解析层同样给双架构)
  assert.deepEqual(parsePackageArgs(['--platform', 'darwin'], DEFAULTS).archs, ['arm64', 'x64']);
});

test('parsePackageArgs: --no-sign 隐含 --allow-unsigned', () => {
  const args = parsePackageArgs(['--no-sign'], DEFAULTS);
  assert.equal(args.noSign, true);
  assert.equal(args.allowUnsigned, true);
});

test('parsePackageArgs: 完整参数解析', () => {
  const args = parsePackageArgs(
    ['--platform', 'darwin', '--arch', 'arm64', '--region', 'global', '--version', '1.2.3', '--skip-smoke', '--allow-unsigned'],
    DEFAULTS,
  );
  assert.equal(args.platform, 'darwin');
  assert.deepEqual(args.archs, ['arm64']);
  assert.equal(args.region, 'global');
  assert.equal(args.versionSpec, '1.2.3');
  assert.equal(args.skipSmoke, true);
  assert.equal(args.allowUnsigned, true);
});

test('parsePackageArgs: 非法值逐项报错', () => {
  assert.throws(() => parsePackageArgs(['--region', 'us'], DEFAULTS), /region/);
  assert.throws(() => parsePackageArgs(['--channel', 'release'], DEFAULTS), /未知参数/);
  assert.throws(() => parsePackageArgs(['--platform', 'freebsd'], DEFAULTS), /platform/);
  assert.throws(() => parsePackageArgs(['--version', 'v1.2.3'], DEFAULTS), /--version/);
  assert.throws(() => parsePackageArgs(['--version', '1.2'], DEFAULTS), /--version/);
  assert.throws(() => parsePackageArgs(['--unknown'], DEFAULTS), /未知参数/);
  // 缺值的 flag(值位被下一个 flag 占据)
  assert.throws(() => parsePackageArgs(['--region', '--skip-smoke'], DEFAULTS), /需要一个值/);
  // win32 不支持 arm64
  assert.throws(() => parsePackageArgs(['--arch', 'arm64'], DEFAULTS), /arch/);
});

test('bumpVersion: major/minor/patch 语义', () => {
  assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4');
  assert.throws(() => bumpVersion('abc', 'patch'), /基线版本非法/);
});

test('resolvePackageVersion: 缺省 = 版本无关占位,不触碰 CDN', async () => {
  let fetched = false;
  const result = await resolvePackageVersion(null, async () => { fetched = true; return '1.0.0'; });
  assert.deepEqual(result, { version: VERSIONLESS_VERSION, versionless: true });
  assert.equal(fetched, false);
});

test('resolvePackageVersion: 显式 x.y.z 原样返回且不触碰 CDN;占位符 0.0.0 拒绝', async () => {
  let fetched = false;
  const result = await resolvePackageVersion('2.5.0', async () => { fetched = true; return '1.0.0'; });
  assert.deepEqual(result, { version: '2.5.0', versionless: false });
  assert.equal(fetched, false);
  await assert.rejects(() => resolvePackageVersion('0.0.0', async () => '1.0.0'), /版本无关占位符/);
});

test('resolvePackageVersion: bump 关键字走 CDN 基线;无有效基线报错', async () => {
  const result = await resolvePackageVersion('patch', async () => '1.4.9');
  assert.deepEqual(result, { version: '1.4.10', versionless: false });
  await assert.rejects(() => resolvePackageVersion('minor', async () => '0.0.0'), /基线/);
  await assert.rejects(() => resolvePackageVersion('minor', async () => ''), /基线/);
});

test('artifactRelDir / artifactBaseName: region 目录 + cindy-* 命名', () => {
  assert.equal(
    artifactRelDir({ region: 'cn', version: '0.0.0', versionless: true, platformKey: 'win32-x64' }),
    'artifacts/cn/unversioned/win32-x64',
  );
  assert.equal(
    artifactRelDir({ region: 'global', version: '1.2.3', versionless: false, platformKey: 'darwin-arm64' }),
    'artifacts/global/1.2.3/darwin-arm64',
  );
  assert.equal(
    artifactRelDir({ region: 'dev', version: '1.2.3', versionless: false, platformKey: 'darwin-arm64' }),
    'artifacts/dev/1.2.3/darwin-arm64',
  );
  assert.equal(artifactBaseName({ version: '0.0.0', versionless: true }), 'cindy-unversioned');
  assert.equal(artifactBaseName({ version: '1.2.3', versionless: false }), 'cindy-1.2.3');
});

test('buildBuildInfo: 版本无关时 version 记 null,platformKey 拼装正确', () => {
  const base = {
    version: '0.0.0',
    versionless: true,
    region: 'cn',
    platform: 'win32',
    arch: 'x64',
    commitSha: 'abc123',
    electronVersion: '41.2.0',
    schemaVersionMax: 42,
    migrationFiles: ['0000_init.sql'],
    files: [{ role: 'installer', name: 'cindy-unversioned-Setup.exe', sha256: 'x', size: 1 }],
    signing: { installerSigned: false },
  };
  const info = buildBuildInfo(base);
  assert.equal(info.schemaVersion, 2);
  assert.equal(info.product, 'cindy-desktop');
  assert.equal(info.version, null);
  assert.equal(info.versionless, true);
  assert.equal(info.platformKey, 'win32-x64');
  assert.equal(info.region, 'cn');
  assert.equal(Object.hasOwn(info, 'channel'), false);
  assert.ok(typeof info.buildTime === 'string' && info.buildTime.length > 0);

  const versioned = buildBuildInfo({ ...base, version: '1.2.3', versionless: false });
  assert.equal(versioned.version, '1.2.3');
  assert.equal(versioned.versionless, false);
});
