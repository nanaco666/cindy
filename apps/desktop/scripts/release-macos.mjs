#!/usr/bin/env node

/**
 * release-macos.mjs — macOS 平台客户端发布脚本（arm64 + x64）
 *
 * 用法: node scripts/release-macos.mjs [version] [--region cn|global] [--arch arm64|x64]
 *   version 可选：major | minor | patch | x.y.z（默认 patch;该渠道首次发布必须传显式 x.y.z）
 *   --region 可选：cn(默认,国内渠道) | global(海外渠道)。区域决定应用身份
 *   (Cindy / CindyGlobal)、烘焙端点(config/endpoint*.json)与发布目标
 *   (XDT_* vs XDT_GLOBAL_* 的 OSS/CDN),见 docs/desktop-release-cn-global.md。
 *
 * 环境变量（可写入 apps/desktop/.env，已 gitignored）:
 *   FP_DEV_OSS_ACCESS_KEY_ID     — 必填，阿里云 AK
 *   FP_DEV_OSS_ACCESS_KEY_SECRET — 必填，阿里云 SK
 *   APPLE_APP_PASSWORD           — 必填，App-specific password（切勿入库）
 *   APPLE_ID / APPLE_TEAM_ID / APPLE_SIGN_IDENTITY — 通常无需设置:由
 *   release-regions.json 的 <region>.macSigning 按区域注入(env 显式值可覆盖;
 *   无代码默认值,两处都缺直接报错)
 *
 * 流程（每个架构）:
 *   1. 设置 production 环境变量
 *   2. electron-forge make (darwin)
 *   3. 找到 .app
 *   4. 签名 + 公证 + staple
 *   5. 打 DMG + 签名 DMG
 *   6. 创建 hotfix ZIP（自动更新用）
 *   7. 计算 SHA256 + 文件大小
 *   8. 从 CDN 拉取现有 manifest（如果有）
 *   9. 更新 darwin-<arch> 平台信息
 *   10. 上传到阿里云 OSS
 */

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ensureBinary } from '../../../scripts/ensure-agent-binaries.mjs';
import { desktopClientBuildEnv } from '../../../scripts/shared/client-endpoint-build-env.mjs';
import { resolveReleaseCdnBaseUrl } from '../../../scripts/shared/release-env.mjs';
import {
  uploadVersionedGzImmutable,
  verifyMacContactsPermissions,
  writeMacEntitlements,
  resolveAppleIdentity,
  OSS_BUCKET,
  OSS_PREFIX,
  OSS_REGION,
  refreshOssConfig,
  resolveOssCredentials,
  packagedAppName,
  releaseArtifactBasename,
  assertNotPublishingCindyToLegacyChannel } from './ci/lib.mjs';
import { applyReleaseRegionConfigToEnv } from './ci/release-regions.mjs';

const require = createRequire(import.meta.url);
const OSS = require('ali-oss');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(__dirname, '..');

// Load .env from desktop root (gitignored, contains APPLE_APP_PASSWORD etc.)
try {
  const envFile = fs.readFileSync(path.join(DESKTOP_ROOT, '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
} catch { /* no .env file, that's fine */ }

// 发布区域:cn(国内,默认)/ global(海外)。区域决定应用身份、烘焙端点与
// 发布目标渠道,必须在 refreshOssConfig 之前解析。
const REGION = (() => {
  const idx = process.argv.indexOf('--region');
  const value = idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : 'cn';
  if (!['cn', 'global', 'dev'].includes(value)) {
    console.error(`ERROR: --region must be cn, global or dev (got "${value}")`);
    process.exit(1);
  }
  return value;
})();
// forge.config.ts(appId / exe 基名)与 ensureBinary 的 CDN fallback 都读这个变量。
process.env.CINDY_AUTH_REGION = REGION;

// 发布目标优先从发版机本地 scripts/release-regions.json 取(env 显式值优先,
// 见 ci/release-regions.mjs;真机密 AK/SK 等仍走 env / .env)。
applyReleaseRegionConfigToEnv(REGION);

refreshOssConfig(REGION);
// 渠道冻结硬闸:Cindy 布局产物禁止发布到老 /xdt-maker 前缀(见 lib.mjs)。
assertNotPublishingCindyToLegacyChannel(OSS_PREFIX);

const PROJECT_ROOT = path.resolve(DESKTOP_ROOT, '../..');
const RELEASE_DIR = path.join(DESKTOP_ROOT, 'release');
const CDN_BASE = resolveReleaseCdnBaseUrl(REGION);
// 产物基名按区域派生:out 目录 / .app 用应用身份名(Cindy / CindyGlobal),
// 安装包 / 热更 zip 文件名用发布渠道基名(cn 'cindy' / global 'cindy-global')。
const APP_NAME = packagedAppName(REGION);
const ARTIFACT_BASENAME = releaseArtifactBasename(REGION);

// Apple signing config(身份解析单点在 ci/lib.mjs 的 resolveAppleIdentity,此处
// 在 .env 加载之后调用)。APPLE_APP_PASSWORD 是敏感凭据,绝对不允许 fallback 到源码
// 里的硬编码默认值 —— 从 env / .env 读不到就直接 abort。
const { appleId: APPLE_ID, teamId: APPLE_TEAM_ID, signIdentity: SIGN_IDENTITY } = resolveAppleIdentity();
// 区域证书由 release-regions.json 的 macSigning 注入(cn X.D. Network / global
// XD Entertainment);这里显式打印,防止静默回落到代码默认身份签错证书。
console.log(`==> Sign identity: ${SIGN_IDENTITY} (team ${APPLE_TEAM_ID}, notary ${APPLE_ID})`);
const APPLE_APP_PASSWORD = process.env.APPLE_APP_PASSWORD;

if (!APPLE_APP_PASSWORD) {
  console.error('ERROR: APPLE_APP_PASSWORD is required for notarization.');
  console.error('       Set it in apps/desktop/.env or export it in your shell.');
  console.error('       Generate one at: https://appleid.apple.com/ → Sign-in & Security → App-Specific Passwords');
  process.exit(1);
}

const ALL_ARCHS = ['arm64', 'x64'];

// Parse --arch flag from argv
const archFlag = (() => {
  const idx = process.argv.indexOf('--arch');
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
})();
const ARCHS = archFlag ? [archFlag] : ALL_ARCHS;

// ── Helpers ──

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

// 版本号写入策略:
//   1. APP_VERSION 环境变量传给 electron-forge,forge.config.ts 据此注入
//      packagerConfig.appVersion(只改 OS 层元数据:CFBundleShortVersionString)。
//   2. 同时临时改写磁盘上的 package.json —— electron-packager 会把它
//      拷到 asar 里,运行时 app.getVersion() 优先读那里,不改会永远
//      拿到占位符 0.0.0-dev,导致热更新版本比较全部失真。
//   3. 脚本退出前(正常/异常/信号)一律把 package.json 恢复成 0.0.0-dev
//      占位版,保证 git 工作区干净,消除 Win/Mac 双平台 release 的冲突。
//   → CDN manifest 是版本号的唯一真实来源(Source of Truth),
//     package.json 只在 make 期间短暂持有真实版本号。
const PACKAGE_JSON_PATH = path.join(DESKTOP_ROOT, 'package.json');
const ORIGINAL_PACKAGE_JSON = fs.readFileSync(PACKAGE_JSON_PATH, 'utf8');

function writePackageVersion(version) {
  const pkg = JSON.parse(ORIGINAL_PACKAGE_JSON);
  pkg.version = version;
  fs.writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + '\n');
}

function restorePackageJson() {
  try { fs.writeFileSync(PACKAGE_JSON_PATH, ORIGINAL_PACKAGE_JSON); } catch { /* ignore */ }
}

process.on('exit', restorePackageJson);
process.on('SIGINT', () => { restorePackageJson(); process.exit(130); });
process.on('SIGTERM', () => { restorePackageJson(); process.exit(143); });

function bumpPatch(ver) {
  const parts = ver.split('.');
  parts[2] = String(Number(parts[2]) + 1);
  return parts.join('.');
}

function exec(cmd, opts = {}) {
  console.log(`    $ ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', ...opts });
}

// undici(Node 全局 fetch)会把上一次请求用过的 keep-alive 连接留在池里复用。
// 本脚本前后两次拉 manifest(开头算版本号、结尾写回更新),中间隔着几分钟的
// 同步阻塞(electron-forge make / codesign / notarytool / ditto / hdiutil)。
// 同步阻塞会冻住事件循环 → undici 清理空闲连接的定时器无法触发 → 那条早被
// CDN/NAT 静默断开的死连接一直留在池里;结尾复用它发请求时,write 失败抛
// UND_ERR_SOCKET / EPIPE(表现为 `TypeError: fetch failed`),整条发布挂掉。
// 关键:报错后 undici 会把坏连接踢出池,所以紧接着重试就会建新连接成功
// (已在 cn-ios 上实测复现并验证重试有效)。这里对连接级错误做有限重试。
async function fetchWithRetry(url, { retries = 3, delayMs = 1000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url);
    } catch (err) {
      lastErr = err;
      const code = err?.cause?.code || err?.code || err?.message || String(err);
      console.warn(`    fetch ${url} failed (attempt ${attempt}/${retries}): ${code}; retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function fetchExistingManifest(platformKey) {
  // canary-release V0.1: 默认基线取 canary;首次发 canary 时回退到 stable。
  // ?t= cache-bust 必须带:CDN 对裸 URL 有边缘缓存,读到陈旧基线会误判
  // claude/codex "版本变了" 而重复上传同版本(2026-07-03 事故直接诱因)。
  const canaryUrl = `${CDN_BASE}/manifest-${platformKey}-canary.json?t=${Date.now()}`;
  const canaryRes = await fetchWithRetry(canaryUrl);
  if (canaryRes.ok) return await canaryRes.json();
  if (canaryRes.status !== 404) {
    throw new Error(`Failed to fetch canary manifest (${canaryRes.status}): ${canaryUrl}`);
  }
  console.warn(`    canary manifest missing — falling back to stable manifest for version baseline`);
  const stableUrl = `${CDN_BASE}/manifest-${platformKey}.json?t=${Date.now()}`;
  const stableRes = await fetchWithRetry(stableUrl);
  if (stableRes.ok) return await stableRes.json();
  if (stableRes.status !== 404) {
    throw new Error(`Failed to fetch manifest (${stableRes.status}): ${stableUrl}`);
  }
  // canary 与 stable 都不存在:全新渠道(如 global 首发)。返回 null,由调用方
  // 要求显式 x.y.z 版本号后从空 manifest 起步。
  return null;
}

function getLocalClaudeCodeVersion(platformKey) {
  const binPath = path.join(PROJECT_ROOT, 'apps', 'claude-code-bin', platformKey, 'claude');
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

// Apple Silicon 主机能通过 Rosetta 2 跑 darwin-x64 binary,所以两个 arch 都能在 arm64
// 主机上探测;Intel 主机跑不了 arm64 binary,但 Intel-only release 已经是少数 case。
function getLocalCodexVersion(platformKey) {
  const binPath = path.join(PROJECT_ROOT, 'apps', 'codex-bin', platformKey, 'codex');
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

async function gzipFile(srcPath, destPath) {
  const src = fs.createReadStream(srcPath);
  const dest = fs.createWriteStream(destPath);
  const gzip = createGzip();
  await pipeline(src, gzip, dest);
}

function createOSSClient() {
  const { accessKeyId, accessKeySecret } = resolveOssCredentials(REGION);
  return new OSS({
    region: OSS_REGION,
    accessKeyId,
    accessKeySecret,
    bucket: OSS_BUCKET,
    timeout: 600_000, // 10 min
  });
}

const MULTIPART_THRESHOLD = 10 * 1024 * 1024; // 10 MB

async function uploadToOSS(client, ossKey, localPath, options = {}) {
  const MAX_RETRIES = 3;
  const size = fs.statSync(localPath).size;
  if (size > MULTIPART_THRESHOLD) {
    let lastPercent = 0;
    let checkpoint;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await client.multipartUpload(ossKey, localPath, {
          parallel: 4,
          partSize: 5 * 1024 * 1024,
          headers: options.headers,
          checkpoint,
          progress(p, _checkpoint) {
            checkpoint = _checkpoint;
            const pct = Math.floor(p * 100);
            if (pct >= lastPercent + 10) {
              lastPercent = pct;
              console.log(`      ${pct}%`);
            }
          },
        });
        break;
      } catch (err) {
        if (attempt === MAX_RETRIES) throw err;
        const delay = attempt * 3;
        console.warn(`      Upload failed (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);
        console.warn(`      Retrying in ${delay}s (resuming from checkpoint)...`);
        await new Promise((r) => setTimeout(r, delay * 1000));
      }
    }
  } else {
    await client.put(ossKey, localPath, options);
  }
}

// ── Release护栏：drizzle 资源验证 + release manifest ──

/**
 * 校验 packaged .app 内 Contents/Resources/drizzle/ 包含 _journal.json + 所有 NNNN_*.sql。
 */
function verifyPackagedDrizzle(appPath) {
  console.log(`==> Verifying packaged drizzle/ inside ${path.basename(appPath)} ...`);
  const drizzleOut = path.join(appPath, 'Contents', 'Resources', 'drizzle');
  if (!fs.existsSync(drizzleOut)) {
    console.error(`ERROR: packaged Contents/Resources/drizzle/ missing at ${drizzleOut}`);
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
  console.log(`    verified ${expectedSql.length} sql file(s) + journal under packaged Contents/Resources/drizzle/`);
}

/**
 * 生成 release manifest JSON，记录本次 build 的 schema 版本、commit、构建时间等。
 */
function writeReleaseManifest(destPath, ctx) {
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
  } catch { /* not in a git work tree, leave blank */ }

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

// ── Signing & Notarization ──

function signApp(appPath, helperEntitlementsPath, mainEntitlementsPath) {
  console.log('    Removing provenance attributes...');
  exec(`/usr/bin/xattr -dr com.apple.provenance "${appPath}" 2>/dev/null || true`);

  // Electron apps must be signed from inside out — `--deep` doesn't
  // reliably timestamp nested Helper apps and frameworks.
  const signBase = `/usr/bin/codesign --force --timestamp --options runtime --sign "${SIGN_IDENTITY}"`;
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');

  // 0. Native modules in app.asar.unpacked/ (e.g. better_sqlite3.node)
  //    AutoUnpackNativesPlugin 把 *.node 解包到 app.asar.unpacked/ 后，这些是独立文件，
  //    不会被 app.asar 的签名覆盖。不在这里单签的话，Gatekeeper / library validation
  //    会在启动时拒绝加载，app 直接打不开。
  const asarUnpackedDir = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked');
  if (fs.existsSync(asarUnpackedDir)) {
    console.log('    Signing native modules in app.asar.unpacked/...');
    exec(`find "${asarUnpackedDir}" -type f | while IFS= read -r f; do if file "$f" | grep -qE "Mach-O"; then ${signBase} "$f"; fi; done`);
  }

  // 0b. Bundled CLI tools under Contents/Resources/tools/ (e.g. ripgrep/rg)
  //     这些是 extraResource 直接拷进去的裸二进制，main app 签名不会下钻到这里。
  //     Apple 公证会拒绝任何未签 / 未启用 hardened runtime 的 Mach-O。
  const resourceToolsDir = path.join(appPath, 'Contents', 'Resources', 'tools');
  if (fs.existsSync(resourceToolsDir)) {
    console.log('    Signing bundled CLI tools in Contents/Resources/tools/...');
    exec(`find "${resourceToolsDir}" -type f | while IFS= read -r f; do if file "$f" | grep -qE "Mach-O"; then ${signBase} "$f"; fi; done`);
    console.log('    Signing bundled resource app bundles...');
    exec(`find "${resourceToolsDir}" -depth -type d -name "*.app" -exec ${signBase} {} \\;`);
  }

  // 1. ALL Mach-O binaries (libraries, executables like chrome_crashpad_handler, ShipIt, etc.)
  console.log('    Signing all Mach-O binaries...');
  exec(`find "${frameworksDir}" -type f | while IFS= read -r f; do if file "$f" | grep -qE "Mach-O"; then ${signBase} "$f"; fi; done`);

  // 2. Helper apps (need entitlements for V8 JIT)
  console.log('    Signing helper apps...');
  exec(`find "${frameworksDir}" -name "*.app" -exec ${signBase} --entitlements "${helperEntitlementsPath}" {} \\;`);

  // 3. Framework bundles
  console.log('    Signing frameworks...');
  exec(`find "${frameworksDir}" -maxdepth 1 -name "*.framework" -exec ${signBase} {} \\;`);

  // 4. Main app bundle
  console.log('    Signing main app...');
  exec(`${signBase} --entitlements "${mainEntitlementsPath}" "${appPath}"`);

  // Verify entire bundle
  console.log('    Verifying signature...');
  exec(`/usr/bin/codesign --verify --deep --strict "${appPath}"`);
  verifyMacContactsPermissions(appPath);
}

async function notarizeApp(appPath) {
  const zipPath = appPath + '.zip';

  console.log('    Compressing for notarization...');
  exec(`/usr/bin/ditto -c -k --keepParent "${appPath}" "${zipPath}"`);

  console.log('    Submitting to Apple notarization service (this may take a few minutes)...');
  exec(
    `/usr/bin/xcrun notarytool submit "${zipPath}" ` +
    `--apple-id "${APPLE_ID}" --password "${APPLE_APP_PASSWORD}" ` +
    `--team-id "${APPLE_TEAM_ID}" --wait`,
    { timeout: 1800000 }, // 30 min
  );

  // Clean up notarization zip
  fs.unlinkSync(zipPath);

  console.log('    Stapling notarization ticket...');
  exec(`/usr/bin/xcrun stapler staple "${appPath}"`);
}

function createDMG(appPath, dmgPath, volumeName) {
  const stagingDir = dmgPath + '.staging';

  // Clean staging
  if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  // Copy signed .app + Applications symlink
  exec(`cp -R "${appPath}" "${stagingDir}/"`);
  fs.symlinkSync('/Applications', path.join(stagingDir, 'Applications'));

  // Create DMG
  if (fs.existsSync(dmgPath)) fs.unlinkSync(dmgPath);
  console.log('    Creating DMG...');
  exec(`/usr/bin/hdiutil create "${dmgPath}" -volname "${volumeName}" -srcfolder "${stagingDir}" -ov -format UDZO`);

  // Sign DMG
  console.log('    Signing DMG...');
  exec(`/usr/bin/codesign --force --timestamp --sign "${SIGN_IDENTITY}" "${dmgPath}"`);

  // Clean staging
  fs.rmSync(stagingDir, { recursive: true });
}

// ── Main ──

async function main() {
  // release-relogin-on-update: 把 --require-relogin 从位置参数里剔除,
  // 也支持 REQUIRE_RELOGIN=1 环境变量(CI 友好)。
  const argVersion = process.argv.filter(
    (_, i) =>
      i >= 2 &&
      process.argv[i - 1] !== '--arch' &&
      _ !== '--arch' &&
      process.argv[i - 1] !== '--region' &&
      _ !== '--region' &&
      _ !== '--require-relogin',
  )[0];
  const requireRelogin =
    process.argv.includes('--require-relogin') ||
    process.env.REQUIRE_RELOGIN === '1' ||
    process.env.REQUIRE_RELOGIN === 'true';
  if (requireRelogin) {
    console.log('==> --require-relogin enabled: this release will force users to re-authorize Feishu after update');
  }

  // agent 二进制不再进 git/LFS——打包/上传 CDN 前按需下载各构建 arch 的 claude/codex/ripgrep。
  for (const arch of ARCHS) {
    for (const kind of ['claude', 'codex', 'ripgrep']) {
      await ensureBinary(kind, `darwin-${arch}`);
    }
  }

  console.log(`==> Release region: ${REGION} (app: ${APP_NAME}, CDN: ${CDN_BASE})`);

  // Use darwin-arm64 manifest as version reference
  const refManifest = await fetchExistingManifest('darwin-arm64');
  const isExplicitVersion = /^\d+\.\d+\.\d+$/.test(argVersion ?? '');
  if (!refManifest && !isExplicitVersion) {
    // 全新渠道没有版本基线,bump 关键字无从计算 —— 首发必须显式指定版本号。
    console.error(`ERROR: no canary/stable manifest found on this channel (${CDN_BASE}).`);
    console.error('       First release on a fresh channel requires an explicit x.y.z version, e.g.');
    console.error(`       node scripts/release-macos.mjs 1.0.0 --region ${REGION}`);
    process.exit(1);
  }
  const cdnVersion = refManifest?.app?.version;
  const hasCdnVersion = cdnVersion && cdnVersion !== '0.0.0';

  if (refManifest && !hasCdnVersion) {
    console.error(`ERROR: CDN manifest has no valid version (got "${cdnVersion}"). Aborting release.`);
    console.error(`       URL: ${CDN_BASE}/manifest-darwin-arm64-canary.json (or stable fallback)`);
    process.exit(1);
  }
  console.log(`==> CDN current version: ${cdnVersion ?? '(none — fresh channel)'}`);

  let version;
  if (argVersion === 'major') {
    const parts = cdnVersion.split('.');
    version = `${Number(parts[0]) + 1}.0.0`;
  } else if (argVersion === 'minor') {
    const parts = cdnVersion.split('.');
    version = `${parts[0]}.${Number(parts[1]) + 1}.0`;
  } else if (argVersion === 'patch') {
    version = bumpPatch(cdnVersion);
  } else if (argVersion) {
    version = argVersion;
  } else {
    version = bumpPatch(cdnVersion);
  }

  console.log(`==> New version: ${version}`);

  // 把版本号写进 package.json —— electron-packager 会把它拷到 asar 里,
  // 运行时 app.getVersion() 读那里。process exit handler 会在脚本结束时
  // 自动恢复成占位符 0.0.0-dev,所以 git 工作区不会留痕。
  writePackageVersion(version);

  // Pre-flight: db migration 完整性校验（drizzle 文件序号、journal、schema drift）
  console.log('==> Running db:validate pre-flight...');
  const validateResult = spawnSync('pnpm', ['db:validate'], {
    stdio: 'inherit',
    cwd: DESKTOP_ROOT,
    shell: true,
  });
  if (validateResult.status !== 0) {
    console.error('ERROR: db:validate failed; aborting release.');
    process.exit(1);
  }

  // Prepare entitlements + release dir
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  const helperEntitlementsPath = path.join(RELEASE_DIR, 'build-helper.entitlements');
  const mainEntitlementsPath = path.join(RELEASE_DIR, 'build-main.entitlements');
  writeMacEntitlements(helperEntitlementsPath);
  writeMacEntitlements(mainEntitlementsPath, { appleEvents: true });

  const client = createOSSClient();

  for (const arch of ARCHS) {
    const platformKey = `darwin-${arch}`;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`==> Building for ${platformKey}`);
    console.log(`${'='.repeat(60)}`);

    // 1. Clean previous build output
    const outDir = path.join(DESKTOP_ROOT, 'out');
    if (fs.existsSync(outDir)) {
      console.log('==> Cleaning previous build output...');
      fs.rmSync(outDir, { recursive: true, force: true });
    }

    // 2a. Build remote bundles (cc-mgr.mjs / proxy.mjs) — release path bypasses
    // npm `prebuild` hook (we call `npx electron-forge make` directly, not
    // `pnpm build`), so we have to invoke the bundle/stage script explicitly.
    // Idempotent: mtime check skips when bundles are already current.
    console.log('==> Building remote bundles...');
    execSync('node scripts/build-remote-bundles.mjs', {
      cwd: DESKTOP_ROOT,
      stdio: 'inherit',
    });

    // 2b. Build
    console.log('==> Running electron-forge make...');
    execSync(`npx electron-forge make --platform darwin --arch ${arch}`, {
      cwd: DESKTOP_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        ...desktopClientBuildEnv({ allowEnvOverride: false, authRegion: REGION }),
        CINDY_AUTH_REGION: REGION,
        APP_VERSION: version, // forge.config.ts 读取此变量注入到 packagerConfig.appVersion
      },
    });

    // 3. Find .app
    const packagedDir = path.join(DESKTOP_ROOT, 'out', `${APP_NAME}-darwin-${arch}`);
    const appPath = path.join(packagedDir, `${APP_NAME}.app`);
    if (!fs.existsSync(appPath)) {
      console.error(`ERROR: ${appPath} not found`);
      process.exit(1);
    }
    console.log(`==> Found app: ${appPath}`);

    // 3.5 Post-build verify: <app>/Contents/Resources/drizzle/ contains all sql + journal
    verifyPackagedDrizzle(appPath);

    // 3.6 Post-build smoke test: launch packaged .app with --smoke-test
    // 注意：smoke 必须在签名/公证之前跑，否则每次 smoke 都等一轮公证（太慢）；
    // 且未签名的 .app 在 macOS 上只要 --user-data-dir 指定临时目录也能起来。
    console.log('==> Running packaged smoke test...');
    const smokeResult = spawnSync(
      'node',
      ['scripts/smoke-packaged.mjs', `--platform=darwin`, `--arch=${arch}`, `--app-name=${APP_NAME}`],
      {
        stdio: 'inherit',
        cwd: DESKTOP_ROOT,
        shell: false,
      },
    );
    if (smokeResult.status !== 0) {
      console.error('ERROR: packaged smoke test failed; aborting release.');
      process.exit(1);
    }

    // 4. Sign + Notarize
    console.log('==> Signing...');
    signApp(appPath, helperEntitlementsPath, mainEntitlementsPath);

    console.log('==> Notarizing...');
    await notarizeApp(appPath);

    // 5. Create DMG (contains signed + notarized .app)
    const dmgName = `${ARTIFACT_BASENAME}-${version}-${arch}.dmg`;
    const dmgPath = path.join(RELEASE_DIR, dmgName);
    console.log('==> Creating DMG...');
    // DMG 卷名 = 应用身份名(cn 'Cindy x.y.z' / global 'CindyGlobal x.y.z')。
    createDMG(appPath, dmgPath, `${APP_NAME} ${version}`);

    const dmgHash = sha256(dmgPath);
    const dmgSize = fs.statSync(dmgPath).size;
    console.log(`    DMG SHA256: ${dmgHash}`);
    console.log(`    DMG Size:   ${(dmgSize / 1024 / 1024).toFixed(1)} MB`);

    // 6. Hotfix ZIP (from packaged dir, for auto-update)
    const hotfixZipName = `${ARTIFACT_BASENAME}-${version}-${arch}.zip`;
    const hotfixZipPath = path.join(RELEASE_DIR, hotfixZipName);
    console.log('==> Creating hotfix ZIP...');
    if (fs.existsSync(hotfixZipPath)) fs.unlinkSync(hotfixZipPath);
    exec(`/usr/bin/ditto -c -k "${packagedDir}" "${hotfixZipPath}"`);

    const zipHash = sha256(hotfixZipPath);
    const zipSize = fs.statSync(hotfixZipPath).size;
    console.log(`    ZIP SHA256: ${zipHash}`);
    console.log(`    ZIP Size:   ${(zipSize / 1024 / 1024).toFixed(1)} MB`);

    // 7. Update manifest(全新渠道首次发布时从空骨架起步)
    const manifest = (await fetchExistingManifest(platformKey)) ?? { app: {} };
    manifest.app.version = version;
    manifest.app.hotfix = {
      file: `hotfix/${platformKey}/${hotfixZipName}`,
      sha256: zipHash,
      size: zipSize,
    };
    manifest.app.installer = {
      file: `app/${platformKey}/${dmgName}`,
      sha256: dmgHash,
      size: dmgSize,
    };
    // release-relogin-on-update: 见 release-windows.mjs 同段注释。
    if (requireRelogin) {
      manifest.app.requireRelogin = true;
    } else {
      delete manifest.app.requireRelogin;
    }

    // 8. Claude Code binary — compare by version AND content hash
    // (upstream sometimes ships a rebuilt bin without bumping --version)
    const localCCVersion = getLocalClaudeCodeVersion(platformKey);
    const cdnCCVersion = manifest.claudeCode?.version || '0.0.0';
    const cdnCCBinaryHash = manifest.claudeCode?.binarySha256 || '';

    console.log(`\n==> Claude Code compare (${platformKey})`);
    if (localCCVersion) {
      const binPath = path.join(PROJECT_ROOT, 'apps', 'claude-code-bin', platformKey, 'claude');
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

      if (versionDiffers || hashDiffers) {
        const reasons = [];
        if (versionDiffers) reasons.push(`version ${cdnCCVersion} → ${localCCVersion}`);
        if (hashDiffers) reasons.push('binary content changed');
        console.log(`    → verdict: UPLOAD (${reasons.join(', ')})`);

        const gzPath = path.join(RELEASE_DIR, `claude-${arch}.gz`);
        console.log(`    Compressing claude → claude.gz ...`);
        await gzipFile(binPath, gzPath);
        const ccHash = sha256(gzPath);
        const ccSize = fs.statSync(gzPath).size;
        console.log(`    gz size:          ${(ccSize / 1024 / 1024).toFixed(1)} MB (${ccSize} bytes)`);
        console.log(`    gz sha256:        ${ccHash}`);

        // immutable 守卫上传:同版本路径已存在同源对象时复用远端 sha256/size(不覆盖);
        // 存在不同内容时抛错中止发版(需人工用 release-claude-code.mjs --force 处理)。
        const ccFileRel = `claude-code/${localCCVersion}/${platformKey}/claude.gz`;
        console.log(`    Uploading claude.gz → ${OSS_PREFIX}/${ccFileRel}`);
        const ccPub = await uploadVersionedGzImmutable({
          client,
          ossKey: `${OSS_PREFIX}/${ccFileRel}`,
          gzPath,
          gzSha256: ccHash,
          gzSize: ccSize,
          binarySha256: localBinHash,
        });

        manifest.claudeCode = {
          version: localCCVersion,
          file: ccFileRel,
          sha256: ccPub.gzSha256,
          size: ccPub.gzSize,
          binarySha256: ccPub.binarySha256,
        };
      } else {
        console.log(`    → verdict: SKIP (version and binary hash match CDN)`);
      }
    } else {
      console.log(`    SKIP: getLocalClaudeCodeVersion returned null (bin missing or --version failed)`);
    }

    // 8b. Codex binary — same compare-by-version-and-hash strategy as Claude Code.
    // upstream 偶尔会重打 binary 不动版本号,所以版本和 sha256 任一不一致就重传。
    const localCodexVersion = getLocalCodexVersion(platformKey);
    const cdnCodexVersion = manifest.codex?.version || '0.0.0';
    const cdnCodexBinaryHash = manifest.codex?.binarySha256 || '';

    console.log(`\n==> Codex compare (${platformKey})`);
    if (localCodexVersion) {
      const binPath = path.join(PROJECT_ROOT, 'apps', 'codex-bin', platformKey, 'codex');
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

      if (versionDiffers || hashDiffers) {
        const reasons = [];
        if (versionDiffers) reasons.push(`version ${cdnCodexVersion} → ${localCodexVersion}`);
        if (hashDiffers) reasons.push('binary content changed');
        console.log(`    → verdict: UPLOAD (${reasons.join(', ')})`);

        const gzPath = path.join(RELEASE_DIR, `codex-${arch}.gz`);
        console.log(`    Compressing codex → codex.gz ...`);
        await gzipFile(binPath, gzPath);
        const codexHash = sha256(gzPath);
        const codexSize = fs.statSync(gzPath).size;
        console.log(`    gz size:          ${(codexSize / 1024 / 1024).toFixed(1)} MB (${codexSize} bytes)`);
        console.log(`    gz sha256:        ${codexHash}`);

        // immutable 守卫上传:同 claude 段,冲突时抛错中止发版。
        const codexFileRel = `codex/${localCodexVersion}/${platformKey}/codex.gz`;
        console.log(`    Uploading codex.gz → ${OSS_PREFIX}/${codexFileRel}`);
        const codexPub = await uploadVersionedGzImmutable({
          client,
          ossKey: `${OSS_PREFIX}/${codexFileRel}`,
          gzPath,
          gzSha256: codexHash,
          gzSize: codexSize,
          binarySha256: localBinHash,
        });

        manifest.codex = {
          version: localCodexVersion,
          file: codexFileRel,
          sha256: codexPub.gzSha256,
          size: codexPub.gzSize,
          binarySha256: codexPub.binarySha256,
        };
      } else {
        console.log(`    → verdict: SKIP (version and binary hash match CDN)`);
      }
    } else {
      console.log(`    SKIP: getLocalCodexVersion returned null (bin missing or --version failed)`);
    }

    // canary-release V0.1: 默认发到 canary 通道
    const manifestPath = path.join(RELEASE_DIR, `manifest-${platformKey}-canary.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

    // 9. Upload to OSS (claude/codex gz 已在上面经 immutable 守卫处理)
    console.log('==> Uploading to OSS...');

    const dmgOssKey = `${OSS_PREFIX}/app/${platformKey}/${dmgName}`;
    console.log(`    Uploading ${dmgName} → ${dmgOssKey}`);
    await uploadToOSS(client, dmgOssKey, dmgPath);

    const zipOssKey = `${OSS_PREFIX}/hotfix/${platformKey}/${hotfixZipName}`;
    console.log(`    Uploading ${hotfixZipName} → ${zipOssKey}`);
    await uploadToOSS(client, zipOssKey, hotfixZipPath);

    const manifestOssKey = `${OSS_PREFIX}/manifest-${platformKey}-canary.json`;
    console.log(`    Uploading manifest-${platformKey}-canary.json → ${manifestOssKey}`);
    await uploadToOSS(client, manifestOssKey, manifestPath, {
      headers: { 'Cache-Control': 'no-cache' },
    });

    // 10. Release manifest: 记录本次 arch 的 schema 版本 / commit / timestamp
    const releaseManifestPath = path.join(
      RELEASE_DIR,
      `manifest-release-${platformKey}-${version}.json`,
    );
    writeReleaseManifest(releaseManifestPath, { version, platformKey, arch });

    console.log(`==> ${platformKey} done!`);
  }

  // Done
  console.log('');
  console.log('=== Release complete ===');
  console.log(`App:    ${version}`);
  console.log(`Region: ${REGION}`);
  for (const arch of ARCHS) {
    const platformKey = `darwin-${arch}`;
    console.log(`\n[${platformKey}]`);
    console.log(`  DMG:      ${CDN_BASE}/app/${platformKey}/${ARTIFACT_BASENAME}-${version}-${arch}.dmg`);
    console.log(`  Hotfix:   ${CDN_BASE}/hotfix/${platformKey}/${ARTIFACT_BASENAME}-${version}-${arch}.zip`);
    console.log(`  Manifest: ${CDN_BASE}/manifest-${platformKey}-canary.json (canary channel)`);
  }
  console.log(`\n  → 发布到 stable: pnpm release:promote:mac${REGION === 'global' ? ':global' : ''}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
