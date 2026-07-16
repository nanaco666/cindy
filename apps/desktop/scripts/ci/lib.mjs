// =============================================================================
// 共享工具库 — CI 构建/发布脚本通用逻辑
//
// 这里只放纯辅助函数：哈希、压缩、OSS、CDN manifest、drizzle 校验、版本号写入等。
// 主流程逻辑由 build-* / publish-* 各自负责。
// =============================================================================

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// createGunzip / pipeline 供下方 immutable-guard 下载复核用;sha256 / gzipFile / OSS 原语
// 已抽到 scripts/shared/oss.mjs(下方 re-export),故不再本地 import crypto / createGzip。
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { ensureBinary } from '../../../../scripts/ensure-agent-binaries.mjs';
// OSS/CDN 原语(sha256 / gzip / ali-oss client / upload)已抽到仓库根 scripts/shared/oss.mjs,
// 供 desktop 与 mobile 共用;这里 re-export 保持既有 import 面(CDN_BASE / createOSSClient 等)不变。
import {
  CDN_BASE,
  OSS_BUCKET,
  OSS_PREFIX,
  OSS_REGION,
  resolveOssConfig,
  refreshOssConfig,
  sha256,
  gzipFile,
  createOSSClient,
  uploadToOSS,
} from '../../../../scripts/shared/oss.mjs';

export {
  CDN_BASE,
  OSS_BUCKET,
  OSS_PREFIX,
  OSS_REGION,
  resolveOssConfig,
  refreshOssConfig,
  sha256,
  gzipFile,
  createOSSClient,
  uploadToOSS,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPTS_DIR = path.resolve(__dirname, '..');
export const DESKTOP_ROOT = path.resolve(SCRIPTS_DIR, '..');
export const PROJECT_ROOT = path.resolve(DESKTOP_ROOT, '../..');
export const RELEASE_DIR = path.join(DESKTOP_ROOT, 'release');

// CDN_BASE / OSS_BUCKET / OSS_PREFIX / OSS_REGION 由 scripts/shared/oss.mjs 提供并在顶部 re-export。

// ── Apple 公证/签名身份(macOS release / publish 共用;单点定义)────────────
// 均为公开身份信息(非密钥;APPLE_APP_PASSWORD 才是密钥,只从 env 读、无默认)。
// 默认值与 .gitlab-ci.env 保持一致;CI / 本机可用同名 env 覆盖。
// 必须是函数而非模块级 const:env 在调用时读取——消费脚本先 loadDotenv()/读
// apps/desktop/.env 再调用,.env 里的覆盖值才生效(模块体在 import 阶段先于
// 消费方 .env 加载执行)。
export function resolveAppleIdentity() {
  return {
    appleId: process.env.APPLE_ID || 'jiali@magiclizi.com',
    teamId: process.env.APPLE_TEAM_ID || 'WJ6LYABL8Z',
    signIdentity:
      process.env.APPLE_SIGN_IDENTITY || 'Developer ID Application: Jiali Liu (WJ6LYABL8Z)',
  };
}

// ── .env 读取 ──────────────────────────────────────────────────────────────

export function loadDotenv(envFilePath = path.join(DESKTOP_ROOT, '.env')) {
  try {
    const envFile = fs.readFileSync(envFilePath, 'utf8');
    for (const line of envFile.split('\n')) {
      const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch { /* no .env file, that's fine */ }
  refreshOssConfig();
}

// ── 命令封装 ────────────────────────────────────────────────────────────────
// (sha256 / gzipFile 已移至 scripts/shared/oss.mjs,顶部 re-export)

export function exec(cmd, opts = {}) {
  console.log(`    $ ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', ...opts });
}

// ── package.json 版本号写入 (退出时自动恢复) ────────────────────────────────
//
// electron-packager 会把 package.json 拷到 asar 内部，运行时 app.getVersion()
// 优先读那里。占位符 0.0.0-dev 不改的话热更新版本比较全部失真。
// 任何 exit / SIGINT / SIGTERM 都恢复，保证 git 工作区干净。

const PACKAGE_JSON_PATH = path.join(DESKTOP_ROOT, 'package.json');
let originalPackageJson = null;

export function writePackageVersion(version) {
  if (originalPackageJson === null) {
    originalPackageJson = fs.readFileSync(PACKAGE_JSON_PATH, 'utf8');
    process.on('exit', restorePackageJson);
    process.on('SIGINT', () => { restorePackageJson(); process.exit(130); });
    process.on('SIGTERM', () => { restorePackageJson(); process.exit(143); });
  }
  const pkg = JSON.parse(originalPackageJson);
  pkg.version = version;
  fs.writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + '\n');
}

function restorePackageJson() {
  if (originalPackageJson === null) return;
  try { fs.writeFileSync(PACKAGE_JSON_PATH, originalPackageJson); } catch { /* ignore */ }
}

// ── CDN manifest ───────────────────────────────────────────────────────────

// 基线 manifest 必须带 ?t= cache-bust:CDN 对裸 URL 有边缘缓存(源站 Cache-Control:
// no-cache 不一定被 CDN 尊重),客户端 manifestService 与 promote-canary-* 都带了,
// 唯独发布脚本此前漏了——2026-07-03 事故的直接诱因就是发版时读到陈旧基线,误判
// "版本变了" 而对已存在的版本化路径做了字节不同的覆盖上传。
export async function fetchExistingManifestIfAvailable(platformKey) {
  const canaryUrl = `${CDN_BASE}/manifest-${platformKey}-canary.json?t=${Date.now()}`;
  const canaryRes = await fetch(canaryUrl);
  if (canaryRes.ok) {
    return await canaryRes.json();
  }
  if (canaryRes.status !== 404) {
    throw new Error(`Failed to fetch canary manifest (${canaryRes.status}): ${canaryUrl}`);
  }
  const stableUrl = `${CDN_BASE}/manifest-${platformKey}.json?t=${Date.now()}`;
  const stableRes = await fetch(stableUrl);
  if (stableRes.ok) {
    return await stableRes.json();
  }
  if (stableRes.status === 404) {
    return null;
  }
  throw new Error(`Failed to fetch stable manifest (${stableRes.status}): ${stableUrl}`);
}

export async function fetchExistingManifest(platformKey) {
  const manifest = await fetchExistingManifestIfAvailable(platformKey);
  if (manifest) return manifest;
  throw new Error(`No manifest found for ${platformKey}`);
}

export async function fetchReferenceManifest(platformKeys) {
  for (const platformKey of platformKeys) {
    const manifest = await fetchExistingManifestIfAvailable(platformKey);
    if (manifest) {
      return { manifest, platformKey };
    }
  }
  throw new Error(`No reference manifest found for: ${platformKeys.join(', ')}`);
}

export function createInitialManifest(version, options = {}) {
  return {
    app: {
      version,
      ...(options.releaseNotes ? { releaseNotes: options.releaseNotes } : {}),
    },
    claudeCode: {
      version: '0.0.0',
      file: '',
      sha256: '',
      size: 0,
    },
  };
}

/**
 * Linux first release is installer/manual-download only.
 * Reuse this helper anywhere we mint a Linux manifest so `app.hotfix` and
 * `app.requireRelogin` can never leak back in through copy/paste drift.
 */
export function createLinuxFirstReleaseManifest(version, baseManifest) {
  const releaseNotes = baseManifest?.app?.releaseNotes;
  const manifest = baseManifest
    ? JSON.parse(JSON.stringify(baseManifest))
    : createInitialManifest(version, { releaseNotes });
  manifest.app = {
    ...(manifest.app ?? {}),
    version,
  };
  delete manifest.app.hotfix;
  delete manifest.app.requireRelogin;
  delete manifest.app.installer;
  delete manifest.installer;
  return manifest;
}

export const LINUX_PLATFORM_KEY = 'linux-x64';
const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';
const MIN_LINUX_RUNTIME_ASSET_SIZE_BYTES = 1024;

function readFilePrefix(filePath, length) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function linuxRuntimeAssetPaths(platformKey = LINUX_PLATFORM_KEY) {
  return [
    path.join(DESKTOP_ROOT, 'native', 'sqlite-vec', platformKey, 'vec0.so'),
  ];
}

export function collectLinuxRuntimeAssetProblems(assetPaths = linuxRuntimeAssetPaths()) {
  const missing = [];
  const invalid = [];
  for (const filePath of assetPaths) {
    if (!fs.existsSync(filePath)) {
      missing.push(filePath);
      continue;
    }
    const stat = fs.statSync(filePath);
    const prefix = readFilePrefix(filePath, LFS_POINTER_PREFIX.length);
    if (stat.size < MIN_LINUX_RUNTIME_ASSET_SIZE_BYTES || prefix === LFS_POINTER_PREFIX) {
      invalid.push(filePath);
    }
  }
  return { missing, invalid };
}

export async function ensureLinuxRuntimeAssets({
  label = 'Linux runtime assets',
  platformKey = LINUX_PLATFORM_KEY,
} = {}) {
  // agent CLI 二进制（claude/codex/ripgrep）不再走 LFS——按需从上游下载到 apps/<kind>-bin/<platform>/。
  for (const kind of ['claude', 'codex', 'ripgrep']) {
    try {
      await ensureBinary(kind, platformKey);
    } catch (err) {
      console.error(`ERROR: ${label}: failed to download ${kind} (${platformKey}): ${err.message}`);
      console.error(`Fix: run "pnpm update:${kind}" or check upstream availability / network.`);
      process.exit(1);
    }
  }

  // sqlite-vec 仍走 Git LFS——只校验它（claude/codex/ripgrep 已由上面下载兜底）。
  const sqliteVecPath = path.join(DESKTOP_ROOT, 'native', 'sqlite-vec', platformKey, 'vec0.so');
  const { missing, invalid } = collectLinuxRuntimeAssetProblems([sqliteVecPath]);
  if (missing.length === 0 && invalid.length === 0) return;
  if (missing.length > 0) {
    console.error(`ERROR: ${label} missing:`);
    for (const filePath of missing) {
      console.error(`  - ${filePath}`);
    }
  }
  if (invalid.length > 0) {
    console.error(`ERROR: ${label} invalid or still stored as Git LFS pointers:`);
    for (const filePath of invalid) {
      console.error(`  - ${filePath}`);
    }
  }
  console.error('sqlite-vec is still Git-LFS managed; run `git lfs pull` to materialize it before release.');
  process.exit(1);
}

export function logLinuxPackagingRequirements() {
  console.log('==> Linux first release packaging note:');
  console.log('    - Current packaging target is .deb (MakerDeb), not AppImage.');
  console.log('    - Linux builders need Debian packaging tools: fakeroot, dpkg, desktop-file-utils.');
  console.log('    - Native rebuild still needs the usual Electron toolchain: python3, make, gcc/g++.');
}

export function findInstallerArtifact(makeBaseDir, extension) {
  const stack = [makeBaseDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.name.endsWith(`.${extension}`)) return full;
    }
  }
  return null;
}

// ── Release manifest (本次构建的元数据) ─────────────────────────────────────

export function writeReleaseManifest(destPath, ctx) {
  const journalPath = path.join(DESKTOP_ROOT, 'drizzle', 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  const schemaVersionMax = entries.reduce(
    (max, e) => (typeof e.idx === 'number' && e.idx > max ? e.idx : max),
    -1,
  );
  const migrationFiles = fs
    .readdirSync(path.join(DESKTOP_ROOT, 'drizzle'))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

  let commitSha = '';
  try {
    commitSha = execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd: DESKTOP_ROOT }).trim();
  } catch { /* not in a git work tree */ }

  let electronVersion = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_ROOT, 'package.json'), 'utf-8'));
    electronVersion = (pkg.devDependencies && pkg.devDependencies.electron) || '';
  } catch { /* ignore */ }

  const manifest = {
    version: ctx.version,
    commit_sha: commitSha,
    build_time: new Date().toISOString(),
    platform: ctx.platformKey.split('-')[0],
    arch: ctx.arch,
    schema_version_max: schemaVersionMax,
    migration_files: migrationFiles,
    node_version: process.version,
    electron_version: electronVersion,
  };
  fs.writeFileSync(destPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`==> Release manifest written: ${destPath}`);
}

// ── Drizzle 校验 ───────────────────────────────────────────────────────────
//
// macOS:   appPath/Contents/Resources/drizzle/
// Windows: packagedDir/resources/drizzle/

export function verifyPackagedDrizzle(drizzleOut) {
  console.log(`==> Verifying packaged drizzle/ at ${drizzleOut} ...`);
  if (!fs.existsSync(drizzleOut)) {
    console.error(`ERROR: packaged drizzle/ missing at ${drizzleOut}`);
    process.exit(1);
  }
  const journalPath = path.join(drizzleOut, 'meta', '_journal.json');
  if (!fs.existsSync(journalPath)) {
    console.error(`ERROR: packaged meta/_journal.json missing at ${journalPath}`);
    process.exit(1);
  }
  const srcDrizzle = path.join(DESKTOP_ROOT, 'drizzle');
  const expectedSql = fs
    .readdirSync(srcDrizzle)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f));
  if (expectedSql.length === 0) {
    console.error(`ERROR: source drizzle/ has no NNNN_*.sql files`);
    process.exit(1);
  }
  for (const f of expectedSql) {
    const out = path.join(drizzleOut, f);
    if (!fs.existsSync(out)) {
      console.error(`ERROR: packaged drizzle/${f} missing at ${out}`);
      process.exit(1);
    }
  }
  console.log(`    verified ${expectedSql.length} sql file(s) + journal`);
}

// ── DB validation pre-flight ───────────────────────────────────────────────

export function runDbValidate() {
  console.log('==> Running db:validate pre-flight...');
  const result = spawnSync('pnpm', ['db:validate'], {
    stdio: 'inherit',
    cwd: DESKTOP_ROOT,
    shell: true,
  });
  if (result.status !== 0) {
    console.error('ERROR: db:validate failed; aborting.');
    process.exit(1);
  }
}

// ── macOS local signing ────────────────────────────────────────────────────

export function writeMacEntitlements(destPath, { appleEvents = false } = {}) {
  const appleEventsEntitlement = appleEvents
    ? `    <key>com.apple.security.automation.apple-events</key>
    <true/>
`
    : '';
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
${appleEventsEntitlement}</dict>
</plist>`;
  fs.writeFileSync(destPath, content);
}

function readCodesignEntitlements(bundlePath) {
  const result = spawnSync(
    '/usr/bin/codesign',
    ['-d', '--entitlements', '-', '--xml', bundlePath],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`codesign entitlement inspection failed for ${bundlePath}: ${result.stderr || result.stdout}`);
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function hasAppleEventsEntitlement(entitlements) {
  return /<key>com\.apple\.security\.automation\.apple-events<\/key>\s*<true\s*\/>/.test(entitlements);
}

function readPlistString(infoPlistPath, key) {
  const result = spawnSync(
    '/usr/libexec/PlistBuddy',
    ['-c', `Print :${key}`, infoPlistPath],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`packaged Info.plist is missing ${key}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

/** Verify the packaged Contacts/JXA privacy contract after signing. */
export function verifyMacContactsPermissions(appPath) {
  const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist');
  const appleEventsUsage = readPlistString(infoPlistPath, 'NSAppleEventsUsageDescription');
  const contactsUsage = readPlistString(infoPlistPath, 'NSContactsUsageDescription');
  for (const [key, value] of [
    ['NSAppleEventsUsageDescription', appleEventsUsage],
    ['NSContactsUsageDescription', contactsUsage],
  ]) {
    if (!/import/i.test(value) || !/(add|update|export)/i.test(value)) {
      throw new Error(`${key} must accurately describe Contacts import and explicit export/update`);
    }
  }

  if (!hasAppleEventsEntitlement(readCodesignEntitlements(appPath))) {
    throw new Error('main app is missing com.apple.security.automation.apple-events=true');
  }

  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');
  const helperApps = fs.readdirSync(frameworksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    .map((entry) => path.join(frameworksDir, entry.name));
  for (const helperApp of helperApps) {
    if (hasAppleEventsEntitlement(readCodesignEntitlements(helperApp))) {
      throw new Error(`helper app must not receive Apple Events entitlement: ${helperApp}`);
    }
  }
  console.log('==> Verified macOS Contacts usage descriptions and main-only Apple Events entitlement');
}

export function adhocSignMacApp(appPath, helperEntitlementsPath, mainEntitlementsPath) {
  console.log('==> Ad-hoc signing macOS app for local packaged testing...');
  const signBase = '/usr/bin/codesign --force --options runtime --sign -';
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');

  const asarUnpackedDir = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked');
  if (fs.existsSync(asarUnpackedDir)) {
    exec(`find "${asarUnpackedDir}" -type f | while IFS= read -r f; do if file "$f" | grep -qE "Mach-O"; then ${signBase} "$f"; fi; done`);
  }

  const resourceToolsDir = path.join(appPath, 'Contents', 'Resources', 'tools');
  if (fs.existsSync(resourceToolsDir)) {
    exec(`find "${resourceToolsDir}" -type f | while IFS= read -r f; do if file "$f" | grep -qE "Mach-O"; then ${signBase} "$f"; fi; done`);
  }

  exec(`find "${frameworksDir}" -type f | while IFS= read -r f; do if file "$f" | grep -qE "Mach-O"; then ${signBase} "$f"; fi; done`);
  exec(`find "${frameworksDir}" -name "*.app" -exec ${signBase} --entitlements "${helperEntitlementsPath}" {} \\;`);
  exec(`find "${frameworksDir}" -maxdepth 1 -name "*.framework" -exec ${signBase} {} \\;`);
  exec(`${signBase} --entitlements "${mainEntitlementsPath}" "${appPath}"`);
  exec(`/usr/bin/codesign --verify --deep --strict "${appPath}"`);
  verifyMacContactsPermissions(appPath);
}

// ── Smoke test (启动 packaged app) ──────────────────────────────────────────

export function runSmokeTest(platform, arch) {
  console.log('==> Running packaged smoke test...');
  const result = spawnSync(
    'node',
    ['scripts/smoke-packaged.mjs', `--platform=${platform}`, `--arch=${arch}`],
    { stdio: 'inherit', cwd: DESKTOP_ROOT, shell: false },
  );
  if (result.status !== 0) {
    console.error('ERROR: packaged smoke test failed; aborting.');
    process.exit(1);
  }
}

// ── Claude Code 二进制 ──────────────────────────────────────────────────────

export function getLocalClaudeCodeVersion(platformKey, binaryName = 'claude') {
  const binPath = path.join(PROJECT_ROOT, 'apps', 'claude-code-bin', platformKey, binaryName);
  if (!fs.existsSync(binPath)) return null;
  try { fs.chmodSync(binPath, 0o755); } catch {}
  try {
    const output = execSync(`"${binPath}" -v`, { encoding: 'utf8', timeout: 10000 });
    const match = output.match(/^([\d.]+)/);
    return match ? match[1] : null;
  } catch (err) {
    console.warn(`    WARN: failed to exec ${binPath} --version: ${err.message}`);
    return null;
  }
}

/**
 * 比较本地 Claude Code 二进制与 CDN 上的版本和哈希，决定是否需要上传。
 * 返回 { uploadClaudeCode, gzPath, ccHash, ccSize, localBinHash } 或 null。
 */
export async function maybeBuildClaudeCodeGz({ platformKey, manifest, binaryName }) {
  const localCCVersion = getLocalClaudeCodeVersion(platformKey, binaryName);
  const cdnCCVersion = manifest.claudeCode?.version || '0.0.0';
  const cdnCCBinaryHash = manifest.claudeCode?.binarySha256 || '';

  console.log(`\n==> Claude Code compare (${platformKey})`);
  if (!localCCVersion) {
    console.log(`    SKIP: local bin missing or --version failed`);
    return null;
  }

  const binPath = path.join(PROJECT_ROOT, 'apps', 'claude-code-bin', platformKey, binaryName);
  const binSize = fs.statSync(binPath).size;
  const localBinHash = sha256(binPath);

  console.log(`    bin path:         ${binPath}`);
  console.log(`    bin size:         ${(binSize / 1024 / 1024).toFixed(1)} MB (${binSize} bytes)`);
  console.log(`    local  version:   ${localCCVersion}`);
  console.log(`    local  sha256:    ${localBinHash}`);
  console.log(`    CDN    version:   ${cdnCCVersion}`);
  console.log(`    CDN    sha256:    ${cdnCCBinaryHash || '(none)'}`);

  const versionDiffers = localCCVersion !== cdnCCVersion;
  const hashDiffers = cdnCCBinaryHash ? localBinHash !== cdnCCBinaryHash : false;

  if (!versionDiffers && !hashDiffers) {
    console.log(`    → verdict: SKIP (version and binary hash match CDN)`);
    return null;
  }

  const reasons = [];
  if (versionDiffers) reasons.push(`version ${cdnCCVersion} → ${localCCVersion}`);
  if (hashDiffers) reasons.push('binary content changed');
  console.log(`    → verdict: UPLOAD (${reasons.join(', ')})`);

  const gzName = binaryName === 'claude.exe' ? 'claude.exe.gz' : `claude-${platformKey.split('-')[1]}.gz`;
  const gzPath = path.join(RELEASE_DIR, gzName);
  console.log(`    Compressing → ${gzName} ...`);
  await gzipFile(binPath, gzPath);
  const ccHash = sha256(gzPath);
  const ccSize = fs.statSync(gzPath).size;
  console.log(`    gz size:          ${(ccSize / 1024 / 1024).toFixed(1)} MB (${ccSize} bytes)`);
  console.log(`    gz sha256:        ${ccHash}`);

  return {
    localCCVersion,
    localBinHash,
    gzPath,
    gzName: binaryName === 'claude.exe' ? 'claude.exe.gz' : 'claude.gz',
    ccHash,
    ccSize,
  };
}

function getLocalCodexVersion(platformKey, binaryName = 'codex') {
  const binPath = path.join(PROJECT_ROOT, 'apps', 'codex-bin', platformKey, binaryName);
  if (!fs.existsSync(binPath)) return null;
  try { fs.chmodSync(binPath, 0o755); } catch {}
  try {
    const output = execSync(`"${binPath}" --version`, { encoding: 'utf8', timeout: 10000 });
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch (err) {
    console.warn(`    WARN: failed to exec ${binPath} --version: ${err.message}`);
    return null;
  }
}

export async function maybeBuildCodexGz({ platformKey, manifest, binaryName }) {
  const localCodexVersion = getLocalCodexVersion(platformKey, binaryName);
  const cdnCodexVersion = manifest.codex?.version || '0.0.0';
  const cdnCodexBinaryHash = manifest.codex?.binarySha256 || '';

  console.log(`\n==> Codex compare (${platformKey})`);
  if (!localCodexVersion) {
    console.log('    SKIP: local bin missing or --version failed');
    return null;
  }

  const binPath = path.join(PROJECT_ROOT, 'apps', 'codex-bin', platformKey, binaryName);
  const binSize = fs.statSync(binPath).size;
  const localBinHash = sha256(binPath);

  console.log(`    bin path:         ${binPath}`);
  console.log(`    bin size:         ${(binSize / 1024 / 1024).toFixed(1)} MB (${binSize} bytes)`);
  console.log(`    local  version:   ${localCodexVersion}`);
  console.log(`    local  sha256:    ${localBinHash}`);
  console.log(`    CDN    version:   ${cdnCodexVersion}`);
  console.log(`    CDN    sha256:    ${cdnCodexBinaryHash || '(none)'}`);

  const versionDiffers = localCodexVersion !== cdnCodexVersion;
  const hashDiffers = cdnCodexBinaryHash ? localBinHash !== cdnCodexBinaryHash : false;

  if (!versionDiffers && !hashDiffers) {
    console.log('    -> verdict: SKIP (version and binary hash match CDN)');
    return null;
  }

  const reasons = [];
  if (versionDiffers) reasons.push(`version ${cdnCodexVersion} -> ${localCodexVersion}`);
  if (hashDiffers) reasons.push('binary content changed');
  console.log(`    -> verdict: UPLOAD (${reasons.join(', ')})`);

  // Keep the local temp artifact platform-qualified so parallel/staged release
  // runs do not clobber each other, but publish the canonical CDN object name
  // (`codex.gz`) to match the existing Claude manifest convention.
  const gzPath = path.join(RELEASE_DIR, binaryName === 'codex.exe' ? 'codex.exe.gz' : `codex-${platformKey.split('-')[1]}.gz`);
  console.log(`    Compressing -> ${path.basename(gzPath)} ...`);
  await gzipFile(binPath, gzPath);
  const codexHash = sha256(gzPath);
  const codexSize = fs.statSync(gzPath).size;
  console.log(`    gz size:          ${(codexSize / 1024 / 1024).toFixed(1)} MB (${codexSize} bytes)`);
  console.log(`    gz sha256:        ${codexHash}`);

  return {
    localCodexVersion,
    localBinHash,
    gzPath,
    gzName: binaryName === 'codex.exe' ? 'codex.exe.gz' : 'codex.gz',
    codexHash,
    codexSize,
  };
}

// ── 阿里云 OSS ─────────────────────────────────────────────────────────────
// createOSSClient / uploadToOSS / getAKSK 已移至 scripts/shared/oss.mjs(顶部 re-export);
// 下方 immutable 守卫通过 re-export 的 uploadToOSS / sha256 复用它们。

// ── 版本化二进制对象 immutable 守卫 ─────────────────────────────────────────
//
// 事故背景 (2026-07-03): claude-code/2.1.198/win32-x64/claude.exe.gz 在前后两次发版
// 中被重复 gzip + 覆盖上传到同一 OSS 路径。gzip 输出不可复现(同一 exe 两次压缩字节
// 不同),manifest 指向第二次的 sha256,而内网 CDN 边缘节点仍缓存第一次的字节 →
// 客户端下载后 sha256 校验必失败,内网 Windows 用户全部「环境初始化失败」。
//
// 原则:带版本号的 OSS 路径(claude-code/<ver>/... codex/<ver>/... ripgrep/<ver>/...)
// 一经上传即视为 immutable,发布二进制一律走本守卫,不要直接 uploadToOSS:
//   - 远端不存在           → 正常上传,并写 x-oss-meta-{gz,binary}-sha256,后续复核免下载
//   - 远端存在且二进制同源 → 不上传,复用远端对象的 sha256/size 写 manifest。用户实际
//                           下载的是远端字节,manifest 必须描述远端对象,而不是本地重压
//                           的"等价"文件;同源与否以解压后二进制 sha256 为准(gz 字节
//                           因 gzip 不可复现没有比较意义)
//   - 远端存在且二进制不同 → 冲突(同一版本号出现两种内容,例如上游重打了 binary 没
//                           bump 版本)。默认抛错拒绝;仅 force=true 时覆盖,且覆盖后
//                           必须人工刷新内外网 CDN 缓存(告警会打印具体 URL)。
//                           注意:同源场景即使 force 也走复用——覆盖等价字节没有任何
//                           收益,只会重新制造 manifest 与 CDN 边缘缓存的字节分裂。
//
// 2026-07 之前上传的远端老对象没有 sha meta,此时把 gz 下载回来解压计算——只发生
// 在同版本复发布的低频路径,用一次下载换确定性是值得的。

async function headVersionedGz(client, ossKey) {
  try {
    const res = await client.head(ossKey);
    const headers = res?.res?.headers ?? {};
    const meta = res?.meta ?? {};
    return {
      gzSha256: meta['gz-sha256'] ?? headers['x-oss-meta-gz-sha256'] ?? null,
      binarySha256: meta['binary-sha256'] ?? headers['x-oss-meta-binary-sha256'] ?? null,
      gzSize: Number(headers['content-length']) || 0,
    };
  } catch (err) {
    const status = err?.status ?? err?.res?.status;
    if (status === 404 || err?.code === 'NoSuchKey') return null;
    throw err;
  }
}

async function computeRemoteGzInfo(client, ossKey) {
  const tmpGz = path.join(os.tmpdir(), `xdt-immutable-check-${process.pid}-${Date.now()}.gz`);
  const tmpBin = `${tmpGz}.bin`;
  try {
    await client.get(ossKey, tmpGz);
    const gzSha256 = sha256(tmpGz);
    const gzSize = fs.statSync(tmpGz).size;
    await pipeline(fs.createReadStream(tmpGz), createGunzip(), fs.createWriteStream(tmpBin));
    const binarySha256 = sha256(tmpBin);
    return { gzSha256, gzSize, binarySha256 };
  } finally {
    try { fs.unlinkSync(tmpGz); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpBin); } catch { /* ignore */ }
  }
}

/**
 * 上传版本化 .gz 到 OSS,遵守 immutable 守卫(见上方大注释)。
 *
 * @returns {{ uploaded: boolean, gzSha256: string, gzSize: number, binarySha256: string }}
 *   写入 manifest 时必须使用返回值里的 gzSha256/gzSize/binarySha256(reuse 场景下是
 *   远端对象的值,与本地新压的 gz 不同),不要继续用本地计算的值。
 * @throws 远端存在不同内容且未 force 时抛错(调用方按各自流程中止/标记失败)。
 */
export async function uploadVersionedGzImmutable({
  client,
  ossKey,
  gzPath,
  gzSha256,
  gzSize,
  binarySha256,
  force = false,
}) {
  let remote = await headVersionedGz(client, ossKey);

  // meta 缺失/不完整(2026-07 之前的老对象)或 HEAD 未返回 content-length(gzSize=0)
  // → 下载复核,保证 reuse 时写进 manifest 的一定是远端对象的真实哈希与体积,绝不回退
  // 用本地值凑数、也绝不让 size:0 进 manifest(客户端 downloader 按 size 强校验,
  // size 错 = 该资产对全体用户下载必失败,与本次事故同级)。
  if (remote && (!remote.binarySha256 || !remote.gzSha256 || !remote.gzSize)) {
    console.log(`    immutable guard: remote object missing sha meta or size — downloading to verify: ${ossKey}`);
    remote = await computeRemoteGzInfo(client, ossKey);
  }

  if (remote && remote.binarySha256 === binarySha256) {
    console.log(`    immutable guard: ${ossKey} already holds the same binary — reusing remote sha256/size, no upload`);
    return { uploaded: false, gzSha256: remote.gzSha256, gzSize: remote.gzSize, binarySha256: remote.binarySha256 };
  }

  if (remote) {
    const rel = ossKey.startsWith(`${OSS_PREFIX}/`) ? ossKey.slice(OSS_PREFIX.length + 1) : ossKey;
    if (!force) {
      throw new Error(
        `immutable guard: ${ossKey} already exists with DIFFERENT binary content ` +
        `(remote binary sha256 ${remote.binarySha256} != local ${binarySha256}). ` +
        `版本化路径不允许覆盖上传——覆盖会与 CDN 边缘缓存产生字节分裂,导致客户端 sha256 校验失败 ` +
        `(2026-07-03 事故)。确认远端内容确实过期时,用对应 release-*.mjs 加 --force 覆盖,` +
        `覆盖后必须刷新内外网 CDN 该 URL 的缓存。`,
      );
    }
    console.warn(`    !! FORCE overwrite of existing versioned object: ${ossKey}`);
    console.warn('    !! 上传完成后必须手动刷新内外网 CDN 缓存,否则边缘节点会继续下发旧字节:');
    console.warn(`       - ${CDN_BASE}/${rel}`);
    console.warn(`       - http://xdtown-static-maker.xdcdn.cn:20080/xdt-maker/${rel}`);
  }

  await uploadToOSS(client, ossKey, gzPath, {
    meta: { 'gz-sha256': gzSha256, 'binary-sha256': binarySha256 },
  });
  return { uploaded: true, gzSha256, gzSize, binarySha256 };
}
