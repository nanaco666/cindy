#!/usr/bin/env node

/**
 * release-windows.mjs — Windows 平台客户端发布脚本
 *
 * 用法: node scripts/release-windows.mjs [version] [--region cn|global]
 *   version 可选：major | minor | patch | x.y.z(默认 patch;该渠道首次发布必须传显式 x.y.z)
 *   --region 可选：cn(默认,国内渠道) | global(海外渠道)。区域决定应用身份
 *   (Cindy / CindyGlobal)、烘焙端点(config/endpoint*.json)与发布目标
 *   (XDT_* vs XDT_GLOBAL_* 的 OSS/CDN)。
 *
 * 环境变量:
 *   NPKG_TOKEN            — 必填,npkg 内网签名服务 token(缺失/签名失败/验签
 *                           不过一律立即中止:未签名 exe 禁止出渠道;调试产
 *                           未签名包走 package-desktop.mjs --allow-unsigned)
 *   OSS_ACCESS_KEY_ID     — 阿里云 AK
 *   OSS_ACCESS_KEY_SECRET — 阿里云 SK
 *   OSS_REGION            — 可选，默认 oss-cn-beijing
 *   XDT_CDN_BASE_URL      — 必填，CDN 地址
 *   XDT_OSS_BUCKET / XDT_OSS_PREFIX / XDT_OSS_REGION — 必填，发布目标
 *
 * 流程:
 *   1. 设置 production 环境变量
 *   2. electron-forge make (Windows)
 *   3. 找到 .exe 安装包
 *   4. 计算 SHA256 + 文件大小
 *   5. 从 CDN 拉取现有 manifest（如果有）
 *   6. 更新 win32-x64 平台信息
 *   7. 上传到阿里云 OSS
 */

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ensureBinary } from '../../../scripts/ensure-agent-binaries.mjs';
import { desktopClientBuildEnv } from '../../../scripts/shared/client-endpoint-build-env.mjs';
import { resolveReleaseCdnBaseUrl } from '../../../scripts/shared/release-env.mjs';
import {
  uploadVersionedGzImmutable,
  OSS_BUCKET,
  OSS_PREFIX,
  OSS_REGION,
  refreshOssConfig,
  resolveOssCredentials,
  packagedAppName,
  releaseArtifactBasename,
  assertNotPublishingCindyToLegacyChannel,
} from './ci/lib.mjs';
import { applyReleaseRegionConfigToEnv } from './ci/release-regions.mjs';

const require = createRequire(import.meta.url);
const OSS = require('ali-oss');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(__dirname, '..');

// Load .env from desktop root (gitignored, contains NPKG_TOKEN etc.)
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
const PLATFORM_KEY = 'win32-x64';
const CDN_BASE = resolveReleaseCdnBaseUrl(REGION);
// 产物基名按区域派生:out 目录 / exe 用应用身份名(Cindy / CindyGlobal),
// 安装包 / 热更 zip 文件名用发布渠道基名(cn 'cindy' / global 'cindy-global')。
const APP_NAME = packagedAppName(REGION);
const ARTIFACT_BASENAME = releaseArtifactBasename(REGION);

// NPKG 签名硬闸(fail fast):正式发布绝不允许未签名 exe 出渠道,缺 token 在
// 构建前就终止,不浪费一次完整 forge make。确需未签名包(调试/演练)不走
// release,用 package-desktop.mjs --allow-unsigned / --no-sign。
const NPKG_TOKEN = process.env.NPKG_TOKEN?.trim();
if (!NPKG_TOKEN) {
  console.error('ERROR: NPKG_TOKEN is required for Windows release (npkg 内网签名服务).');
  console.error('       未签名安装包禁止发布;调试用 package-desktop.mjs --allow-unsigned。');
  process.exit(1);
}

// ── Helpers ──

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

// 版本号写入策略:
//   1. APP_VERSION 环境变量传给 electron-forge,forge.config.ts 据此注入
//      packagerConfig.appVersion(只改 OS 层元数据:Win PE FileVersion)。
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

// 见 release-macos.mjs 同名函数注释:undici 复用 keep-alive 死连接导致的
// fetch EPIPE / UND_ERR_SOCKET。Windows 这里只在脚本开头拉一次 manifest(其后
// 复用变量,不再二次 fetch),不会撞上 mac 那种"长同步阻塞后复用死连接"的场景;
// 但同样套上有限重试,顺带兜住偶发网络抖动,保持两个发布脚本行为一致。
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

async function fetchExistingManifest() {
  // canary-release V0.1: 所有 release 默认进 canary 通道。优先以 canary
  // manifest 为版本基线;如果 canary 还没创建过(首次切换流程时),回退到
  // stable manifest 拿基线版本号 —— 避免首次 canary 发布因 404 而失败。
  // ?t= cache-bust 必须带:CDN 对裸 URL 有边缘缓存,读到陈旧基线会误判
  // claude/codex "版本变了" 而重复上传同版本(2026-07-03 事故直接诱因)。
  const canaryUrl = `${CDN_BASE}/manifest-${PLATFORM_KEY}-canary.json?t=${Date.now()}`;
  const canaryRes = await fetchWithRetry(canaryUrl);
  if (canaryRes.ok) return await canaryRes.json();
  if (canaryRes.status !== 404) {
    throw new Error(`Failed to fetch canary manifest (${canaryRes.status}): ${canaryUrl}`);
  }
  console.warn(`    canary manifest missing — falling back to stable manifest for version baseline`);
  const stableUrl = `${CDN_BASE}/manifest-${PLATFORM_KEY}.json?t=${Date.now()}`;
  const stableRes = await fetchWithRetry(stableUrl);
  if (stableRes.ok) return await stableRes.json();
  if (stableRes.status !== 404) {
    throw new Error(`Failed to fetch manifest (${stableRes.status}): ${stableUrl}`);
  }
  // canary 与 stable 都不存在:全新渠道(如 global 首发)。返回 null,由调用方
  // 要求显式 x.y.z 版本号后从空 manifest 起步。
  return null;
}

function getLocalClaudeCodeVersion() {
  const binPath = path.join(PROJECT_ROOT, 'apps', 'claude-code-bin', PLATFORM_KEY, 'claude.exe');
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

function getLocalCodexVersion() {
  const binPath = path.join(PROJECT_ROOT, 'apps', 'codex-bin', PLATFORM_KEY, 'codex.exe');
  if (!fs.existsSync(binPath)) return null;
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
 * 校验 packaged 目录下 resources/drizzle/ 包含 _journal.json + 所有 NNNN_*.sql。
 * packagedDir 对应 electron-forge 产物根目录（含 resources/ 子目录）。
 * macOS 调用方传入 `<packagedDir>/<PACKAGED_APP_NAME>.app/Contents/Resources` 的父路径方案略有不同，
 * 本 helper 只管 Windows 的 `<packagedDir>/resources/drizzle/`。
 */
function verifyPackagedDrizzle(packagedDir) {
  console.log(`==> Verifying packaged drizzle/ under ${packagedDir} ...`);
  const drizzleOut = path.join(packagedDir, 'resources', 'drizzle');
  if (!fs.existsSync(drizzleOut)) {
    console.error(`ERROR: packaged resources/drizzle/ missing at ${drizzleOut}`);
    process.exit(1);
  }
  const journalPath = path.join(drizzleOut, 'meta', '_journal.json');
  if (!fs.existsSync(journalPath)) {
    console.error(`ERROR: packaged meta/_journal.json missing at ${journalPath}`);
    process.exit(1);
  }
  // 源 drizzle 目录（开发时的）：每个 NNNN_*.sql 都要在 packaged 副本里出现
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
  console.log(`    verified ${expectedSql.length} sql file(s) + journal under packaged resources/drizzle/`);
}

/**
 * 生成 release manifest JSON，记录本次 build 的 schema 版本、commit、构建时间等。
 * @param {string} destPath  写入路径（通常在 RELEASE_DIR 内）
 * @param {{ version: string, platformKey: string, arch: string }} ctx
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

// ── npkg Code Signing ──

/**
 * Sign a Windows .exe via npkg code-signing service.
 * Calls sign.py (faithful port of the official Python example).
 */
function signWindowsExe(exePath, token) {
  const signScript = path.join(__dirname, 'sign.py');
  execSync(`python "${signScript}" "${path.resolve(exePath)}" "${token}"`, {
    stdio: 'inherit',
  });
}

/**
 * Authenticode 验签硬闸:状态必须是 Valid,否则立即中止发布。
 * 拦两类事故:npkg 服务返回了未签/坏签产物、forge make 阶段签名被静默跳过。
 */
function assertAuthenticodeSigned(exePath) {
  console.log(`==> Verifying Authenticode signature: ${path.basename(exePath)}`);
  const status = execSync(
    `powershell -NoProfile -Command "(Get-AuthenticodeSignature -FilePath '${path.resolve(exePath).replace(/'/g, "''")}').Status"`,
    { encoding: 'utf8' },
  ).trim();
  if (status !== 'Valid') {
    console.error(`ERROR: Authenticode status is "${status}" (expected "Valid"): ${exePath}`);
    console.error('       签名无效的 exe 禁止发布,已中止。');
    process.exit(1);
  }
  console.log('    Authenticode: Valid');
}

// ── Main ──

function bumpPatch(ver) {
  const parts = ver.split('.');
  parts[2] = String(Number(parts[2]) + 1);
  return parts.join('.');
}

async function main() {
  // release-relogin-on-update: 把 --require-relogin 从 argv 里拣出来,
  // 剩下的位置参数才是 version 标识(major/minor/patch/x.y.z)。
  // 也支持 REQUIRE_RELOGIN=1 环境变量,方便 CI 不需要改命令模板。
  // 位置参数 = 去掉 --flags 及带值 flag(--region <val>)的值之后剩下的 token。
  const flagsWithValue = new Set(['--region']);
  const positionalArgs = process.argv
    .slice(2)
    .filter((a, i, arr) => !a.startsWith('--') && !flagsWithValue.has(arr[i - 1]));
  const requireRelogin =
    process.argv.includes('--require-relogin') ||
    process.env.REQUIRE_RELOGIN === '1' ||
    process.env.REQUIRE_RELOGIN === 'true';
  const argVersion = positionalArgs[0]; // 可选：major, minor, patch, 或具体版本号
  if (requireRelogin) {
    console.log('==> --require-relogin enabled: this release will force users to re-authorize Feishu after update');
  }

  // agent 二进制不再进 git/LFS——打包/上传 CDN 前按需下载 win32-x64 的 claude/codex/ripgrep。
  for (const kind of ['claude', 'codex', 'ripgrep']) {
    await ensureBinary(kind, PLATFORM_KEY);
  }

  console.log(`==> Release region: ${REGION} (app: ${APP_NAME}, CDN: ${CDN_BASE})`);

  // 1. Version — 从 CDN 拉取当前版本，自动 bump
  const fetchedManifest = await fetchExistingManifest();
  const isExplicitVersion = /^\d+\.\d+\.\d+$/.test(argVersion ?? '');
  if (!fetchedManifest && !isExplicitVersion) {
    // 全新渠道没有版本基线,bump 关键字无从计算 —— 首发必须显式指定版本号。
    console.error(`ERROR: no canary/stable manifest found on this channel (${CDN_BASE}).`);
    console.error('       First release on a fresh channel requires an explicit x.y.z version, e.g.');
    console.error(`       node scripts/release-windows.mjs 1.0.0 --region ${REGION}`);
    process.exit(1);
  }
  const existingManifest = fetchedManifest ?? { app: {} };
  const cdnVersion = existingManifest.app.version;
  const hasCdnVersion = cdnVersion && cdnVersion !== '0.0.0';

  if (fetchedManifest && !hasCdnVersion) {
    console.error(`ERROR: CDN manifest has no valid version (got "${cdnVersion}"). Aborting release.`);
    console.error(`       URL: ${CDN_BASE}/manifest-${PLATFORM_KEY}-canary.json (or stable fallback)`);
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

  // 1.5 Pre-flight: db migration 完整性校验（drizzle 文件序号、journal、schema drift）
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

  // 2. Clean previous build output (stale app.asar can be locked by AV / indexer)
  const outDir = path.join(DESKTOP_ROOT, 'out');
  if (fs.existsSync(outDir)) {
    console.log('==> Cleaning previous build output...');
    try {
      fs.rmSync(outDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`ERROR: Cannot remove ${outDir} — is ${APP_NAME}.exe still running or is antivirus scanning it?`);
      console.error(err.message);
      process.exit(1);
    }
  }

  // 3. Build remote bundles (cc-mgr.mjs / proxy.mjs) — release path bypasses
  // npm `prebuild` hook (we call `npx electron-forge make` directly, not
  // `pnpm build`), so we have to invoke the bundle/stage script explicitly.
  // Idempotent: mtime check skips when bundles are already current.
  console.log('==> Building remote bundles...');
  execSync('node scripts/build-remote-bundles.mjs', {
    cwd: DESKTOP_ROOT,
    stdio: 'inherit',
  });

  // 4. Build
  console.log('==> Running electron-forge make...');
  execSync('npx electron-forge make --platform win32 --arch x64', {
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

  // 3. Find .exe — search recursively under out/make/ for the NSIS installer
  const makeBaseDir = path.join(DESKTOP_ROOT, 'out', 'make');
  function findExe(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findExe(full);
        if (found) return found;
      } else if (entry.name.endsWith('.exe') && entry.name.toLowerCase().includes('setup')) {
        return full;
      }
    }
    return null;
  }
  const exePath = findExe(makeBaseDir);
  if (!exePath) {
    console.error('ERROR: No Setup.exe found under', makeBaseDir);
    process.exit(1);
  }
  const exeFile = path.basename(exePath);
  console.log(`==> Found installer: ${exeFile}`);

  // 3.5 Post-build verify: resources/drizzle/ contains all sql + journal
  // NSIS installer wraps the packaged dir verbatim, so verifying out/<PACKAGED_APP_NAME>-win32-x64/
  // is the accurate way to check drizzle files landed. Verifying inside the .exe
  // would require unpacking NSIS, and the installer just copies this dir.
  const packagedForVerify = path.join(DESKTOP_ROOT, 'out', `${APP_NAME}-win32-x64`);
  verifyPackagedDrizzle(packagedForVerify);

  // 3.6 Post-build smoke test: launch packaged exe with --smoke-test
  console.log('==> Running packaged smoke test...');
  const smokeResult = spawnSync(
    'node',
    ['scripts/smoke-packaged.mjs', '--platform=win32', '--arch=x64', `--app-name=${APP_NAME}`],
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

  // 4. Prepare release directory
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  const releaseExeName = `${ARTIFACT_BASENAME}-${version}-Setup.exe`;
  const releaseExePath = path.join(RELEASE_DIR, releaseExeName);
  fs.copyFileSync(exePath, releaseExePath);

  // 4a. npkg 签名(token 已在启动硬闸校验;sign.py 非零退出会抛错中止发布)
  console.log('==> Signing installer via npkg...');
  signWindowsExe(releaseExePath, NPKG_TOKEN);

  // 4a2. Authenticode 验签兜底:签名服务静默失败 / 产物实际未签在这里拦下。
  assertAuthenticodeSigned(releaseExePath);

  // 4b. SHA256 + size (computed AFTER signing so hash matches the signed binary)
  const hash = sha256(releaseExePath);
  const size = fs.statSync(releaseExePath).size;
  console.log(`==> Installer: ${releaseExeName}`);
  console.log(`    SHA256: ${hash}`);
  console.log(`    Size:   ${(size / 1024 / 1024).toFixed(1)} MB`);

  // 5. Create hotfix ZIP from packaged app (for auto-update, no installer overhead)
  const packagedDir = path.join(DESKTOP_ROOT, 'out', `${APP_NAME}-win32-x64`);
  // 热更 zip 会被 updater 原样落盘,包内主 exe 同样不允许未签名(内部 exe 由
  // forge make 阶段的 signPackagedExes 签,这里验签兜底)。
  assertAuthenticodeSigned(path.join(packagedDir, `${APP_NAME}.exe`));
  const hotfixZipName = `${ARTIFACT_BASENAME}-${version}.zip`;
  const hotfixZipPath = path.join(RELEASE_DIR, hotfixZipName);
  console.log('==> Creating hotfix ZIP from packaged app...');
  if (fs.existsSync(hotfixZipPath)) fs.unlinkSync(hotfixZipPath);
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${packagedDir}\\*' -DestinationPath '${hotfixZipPath}'"`,
    { stdio: 'inherit' }
  );
  const zipHash = sha256(hotfixZipPath);
  const zipSize = fs.statSync(hotfixZipPath).size;
  console.log(`    ZIP SHA256: ${zipHash}`);
  console.log(`    ZIP Size:   ${(zipSize / 1024 / 1024).toFixed(1)} MB`);

  // 6. Update manifest (tracks hotfix ZIP for auto-update)
  const manifest = existingManifest;

  manifest.app.version = version;
  manifest.app.hotfix = {
    file: `hotfix/${PLATFORM_KEY}/${hotfixZipName}`,
    sha256: zipHash,
    size: zipSize,
  };
  manifest.app.installer = {
    file: `app/${PLATFORM_KEY}/${releaseExeName}`,
    sha256: hash,
    size,
  };
  // release-relogin-on-update: 写入 true 时客户端 updateService 会在下载完
  // 写一个 one-shot 标记文件,新版本第一次启动时把 refresh_token 清掉,把
  // 用户踢回登录页重新走 auth-server 登录(用于新增 scope / auth 协议变更场景)。
  // 不需要时显式删掉字段,避免 CDN 上残留旧标记影响后续 release。
  if (requireRelogin) {
    manifest.app.requireRelogin = true;
  } else {
    delete manifest.app.requireRelogin;
  }

  // canary-release V0.1: 默认发到 canary 通道
  const manifestPath = path.join(RELEASE_DIR, `manifest-${PLATFORM_KEY}-canary.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // OSS client 提前到 claude/codex 段之前创建:immutable 守卫需要在决定 manifest
  // 内容时就查询/上传远端对象(先传 binary → 再定 manifest → 最后传 manifest)。
  const client = createOSSClient();

  // 7. Check Claude Code binary — compare by version AND content hash
  // (upstream sometimes ships a rebuilt bin without bumping --version)
  const localCCVersion = getLocalClaudeCodeVersion();
  const cdnCCVersion = existingManifest.claudeCode?.version || '0.0.0';
  const cdnCCBinaryHash = existingManifest.claudeCode?.binarySha256 || '';
  let uploadClaudeCode = false;

  console.log(`\n==> Claude Code compare (${PLATFORM_KEY})`);
  if (localCCVersion) {
    const binPath = path.join(PROJECT_ROOT, 'apps', 'claude-code-bin', PLATFORM_KEY, 'claude.exe');
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

      const gzPath = path.join(RELEASE_DIR, 'claude.exe.gz');
      console.log(`    Compressing claude.exe → claude.exe.gz ...`);
      await gzipFile(binPath, gzPath);
      const ccHash = sha256(gzPath);
      const ccSize = fs.statSync(gzPath).size;
      console.log(`    gz size:          ${(ccSize / 1024 / 1024).toFixed(1)} MB (${ccSize} bytes)`);
      console.log(`    gz sha256:        ${ccHash}`);

      // immutable 守卫上传:同版本路径已存在同源对象时复用远端 sha256/size(不覆盖);
      // 存在不同内容时抛错中止整个发版(需人工用 release-claude-code.mjs --force 处理)。
      const ccFileRel = `claude-code/${localCCVersion}/${PLATFORM_KEY}/claude.exe.gz`;
      console.log(`    Uploading claude.exe.gz → ${OSS_PREFIX}/${ccFileRel}`);
      const ccPub = await uploadVersionedGzImmutable({
        client,
        ossKey: `${OSS_PREFIX}/${ccFileRel}`,
        gzPath,
        gzSha256: ccHash,
        gzSize: ccSize,
        binarySha256: localBinHash,
      });
      uploadClaudeCode = ccPub.uploaded;

      manifest.claudeCode = {
        version: localCCVersion,
        file: ccFileRel,
        sha256: ccPub.gzSha256,
        size: ccPub.gzSize,
        binarySha256: ccPub.binarySha256,
      };

      // Rewrite manifest with claude code info
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    } else {
      console.log(`    → verdict: SKIP (version and binary hash match CDN)`);
    }
  } else {
    console.log(`    SKIP: getLocalClaudeCodeVersion returned null (bin missing or --version failed)`);
  }

  // 7b. Check Codex binary — same compare-by-version-and-hash strategy as Claude Code.
  // upstream 偶尔会重打 binary 不动版本号,所以版本和 sha256 任一不一致就重传。
  const localCodexVersion = getLocalCodexVersion();
  const cdnCodexVersion = existingManifest.codex?.version || '0.0.0';
  const cdnCodexBinaryHash = existingManifest.codex?.binarySha256 || '';
  let uploadCodex = false;

  console.log(`\n==> Codex compare (${PLATFORM_KEY})`);
  if (localCodexVersion) {
    const binPath = path.join(PROJECT_ROOT, 'apps', 'codex-bin', PLATFORM_KEY, 'codex.exe');
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

      const gzPath = path.join(RELEASE_DIR, 'codex.exe.gz');
      console.log(`    Compressing codex.exe → codex.exe.gz ...`);
      await gzipFile(binPath, gzPath);
      const codexHash = sha256(gzPath);
      const codexSize = fs.statSync(gzPath).size;
      console.log(`    gz size:          ${(codexSize / 1024 / 1024).toFixed(1)} MB (${codexSize} bytes)`);
      console.log(`    gz sha256:        ${codexHash}`);

      // immutable 守卫上传:同 claude 段,冲突时抛错中止发版。
      const codexFileRel = `codex/${localCodexVersion}/${PLATFORM_KEY}/codex.exe.gz`;
      console.log(`    Uploading codex.exe.gz → ${OSS_PREFIX}/${codexFileRel}`);
      const codexPub = await uploadVersionedGzImmutable({
        client,
        ossKey: `${OSS_PREFIX}/${codexFileRel}`,
        gzPath,
        gzSha256: codexHash,
        gzSize: codexSize,
        binarySha256: localBinHash,
      });
      uploadCodex = codexPub.uploaded;

      manifest.codex = {
        version: localCodexVersion,
        file: codexFileRel,
        sha256: codexPub.gzSha256,
        size: codexPub.gzSize,
        binarySha256: codexPub.binarySha256,
      };

      // Rewrite manifest with codex info
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    } else {
      console.log(`    → verdict: SKIP (version and binary hash match CDN)`);
    }
  } else {
    console.log(`    SKIP: getLocalCodexVersion returned null (bin missing or --version failed)`);
  }

  // 8. Upload to OSS (claude/codex gz 已在上面经 immutable 守卫处理)
  console.log('==> Uploading to OSS...');

  // Upload installer
  const exeOssKey = `${OSS_PREFIX}/app/${PLATFORM_KEY}/${releaseExeName}`;
  console.log(`    Uploading ${releaseExeName} → ${exeOssKey}`);
  await uploadToOSS(client, exeOssKey, releaseExePath);

  // Upload hotfix ZIP
  const zipOssKey = `${OSS_PREFIX}/hotfix/${PLATFORM_KEY}/${hotfixZipName}`;
  console.log(`    Uploading ${hotfixZipName} → ${zipOssKey}`);
  await uploadToOSS(client, zipOssKey, hotfixZipPath);

  const manifestOssKey = `${OSS_PREFIX}/manifest-${PLATFORM_KEY}-canary.json`;
  console.log(`    Uploading manifest-${PLATFORM_KEY}-canary.json → ${manifestOssKey}`);
  await uploadToOSS(client, manifestOssKey, manifestPath, {
    headers: { 'Cache-Control': 'no-cache' },
  });

  // 9.5 Release manifest: 记录本次 build 的 schema 版本 / commit / timestamp
  const releaseManifestPath = path.join(RELEASE_DIR, `manifest-release-${PLATFORM_KEY}-${version}.json`);
  writeReleaseManifest(releaseManifestPath, { version, platformKey: PLATFORM_KEY, arch: 'x64' });

  // 10. Done
  console.log('');
  console.log('=== Release complete ===');
  console.log(`App:         ${version}`);
  console.log(`Region:      ${REGION}`);
  console.log(`Platform:    ${PLATFORM_KEY}`);
  console.log(`Installer:   ${CDN_BASE}/app/${PLATFORM_KEY}/${releaseExeName}`);
  console.log(`Hotfix ZIP:  ${CDN_BASE}/hotfix/${PLATFORM_KEY}/${hotfixZipName}`);
  if (uploadClaudeCode) {
    console.log(`Claude Code: ${localCCVersion} (updated)`);
  }
  if (uploadCodex) {
    console.log(`Codex:       ${localCodexVersion} (updated)`);
  }
  console.log(`Manifest:    ${CDN_BASE}/manifest-${PLATFORM_KEY}-canary.json (canary channel)`);
  console.log(`             → 发布到 stable: pnpm release:promote:win${REGION === 'global' ? ':global' : ''}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
