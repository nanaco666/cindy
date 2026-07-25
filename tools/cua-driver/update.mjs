#!/usr/bin/env node

/**
 * update.mjs — 下载 trycua/cua 的 cua-driver-rs GitHub Release 二进制。
 *
 * 仅 darwin 平台需要下载（companion app 是 macOS-only）；其它平台静默跳过，不报错。
 *
 * 用法：
 *   pnpm update:cua-driver               # 拉最新版（tag 前缀 cua-driver-rs-v）
 *   pnpm update:cua-driver 0.12.3        # 指定版本（裸版本号，脚本内拼 tag）
 *   pnpm update:cua-driver --version=0.12.3 --force
 *   node tools/cua-driver/update.mjs --platform=darwin-arm64
 *
 * 流程（不指定版本）：
 *   1. 拉取 GitHub Releases 的 latest 元数据（筛 cua-driver-rs-v* tag）
 *   2. 与本地 latest.json 对比 version
 *   3. 版本相同且 updates 目录齐全：刷新缓存 + re-promote，退出
 *   4. 版本不同 / 文件缺失：从 checksums.txt 获取 SHA256 → 下载 tarball → 校验 → 解包完整内容
 *      到 tools/cua-driver/updates/<version>/<platform>/，成功后 promote 到 apps/cua-driver-bin/<platform>/
 *
 * 流程（指定版本）：同上但直接取对应 tag 的元数据，并写回 latest.json 使其成为唯一 pin 来源。
 *
 * 供应链加固：tarball 下载后，先从官方 checksums.txt（同 release）取 SHA256 校验，不符 / 拿不到
 * 一律删归档并抛错（fail-closed），绝不解压 / 落地。
 *
 * 落盘结构（完整 payload 保留，tar 内所有文件都解到版本目录）：
 *   tools/cua-driver/updates/<version>/<platform>/
 *     ├── cua-driver                      ← 裸二进制（主要使用）
 *     ├── CuaDriver.app/                  ← 同一 Mach-O 的 LaunchServices 壳
 *     ├── libcua_driver_sdk.dylib
 *     └── cua_driver_node_runtime.node
 *
 *   apps/cua-driver-bin/<platform>/
 *     ├── cua-driver                      ← promote 后的裸二进制（ensureBinary 管理）
 *     ├── .version                        ← 版本标记，供 ensure-agent-binaries.mjs skip 判定
 *     └── <tarball 其余内容>               ← promote 时整目录同步（cp -r）
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const REPO = 'trycua/cua';
const TAG_PREFIX = 'cua-driver-rs-v';
const RELEASES_LATEST_URL = `https://api.github.com/repos/${REPO}/releases`;
const RELEASES_BY_TAG_URL = (tag) => `https://api.github.com/repos/${REPO}/releases/tags/${tag}`;
const CACHE_FILE = path.join(__dirname, 'latest.json');
const UPDATES_DIR = path.join(__dirname, 'updates');
const BIN_DIR = path.join(PROJECT_ROOT, 'apps', 'cua-driver-bin');

/**
 * 支持的平台。cua-driver 仅支持 macOS（companion app 是 macOS 专用）。
 * 仅 darwin-arm64 与 darwin-x64 两个平台为下载目标。
 * 非 darwin 调用静默跳过（不报错）。
 *
 * asset 命名规则（0.12.3 实测）：
 *   darwin-arm64: cua-driver-rs-<ver>-darwin-arm64.tar.gz
 *   darwin-x64:   cua-driver-rs-<ver>-darwin-x86_64.tar.gz
 */
const PLATFORMS = [
  {
    key: 'darwin-arm64',
    /** GitHub release asset 中 tarball 内目录名的后缀 */
    assetSuffix: 'darwin-arm64',
    /** asset 文件名模板（插入 version） */
    assetName: (version) => `cua-driver-rs-${version}-darwin-arm64.tar.gz`,
    binFile: 'cua-driver',
  },
  {
    key: 'darwin-x64',
    assetSuffix: 'darwin-x86_64',
    assetName: (version) => `cua-driver-rs-${version}-darwin-x86_64.tar.gz`,
    binFile: 'cua-driver',
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function ghHeaders() {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'xdt-maker-cua-driver-update',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  return res.text();
}

async function downloadFile(url, destPath) {
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  if (!res.body) throw new Error(`Download returned no body: ${url}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
}

function sha256File(filePath) {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function formatMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

const LFS_POINTER_HEADER = 'version https://git-lfs.github.com/spec/v1';

/**
 * 检查文件是否为有效二进制（LFS pointer 或小于 1KB 则视为无效）。
 */
function isUsableCache(filePath) {
  try {
    if (fs.statSync(filePath).size < 1024) return false;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(64);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      if (buf.subarray(0, n).toString('utf8').startsWith(LFS_POINTER_HEADER)) return false;
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * versionFromTag: "cua-driver-rs-v0.12.3" → "0.12.3"
 */
function versionFromTag(tag) {
  const m = tag.match(new RegExp(`^${TAG_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+\\.\\d+\\.\\d+)$`));
  if (!m) throw new Error(`Unexpected cua-driver tag format: ${tag} (expected ${TAG_PREFIX}X.Y.Z)`);
  return m[1];
}

function normalizeVersion(version) {
  const v = version.trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`Invalid cua-driver version: ${version} (expected X.Y.Z)`);
  return v;
}

/**
 * 从 GitHub Releases 的 cua-driver-rs-v* 中选出最新版本。
 * monorepo 中混有多个 tag，无法使用 /releases/latest，
 * 改为拉取列表（最多 100 条）并从 cua-driver-rs-v* 中选最新。
 *
 * 注意：上游 cua-driver-rs 目前只发 prerelease，因此仅排除 draft，
 * 保留 prerelease（其他项目排除 prerelease 是因为"有稳定版"，
 * 而 cua-driver-rs 全部都是 prerelease，排除后将什么都找不到）。
 */
async function fetchLatestCuaDriverRelease() {
  // 分页拉取 1 页（100 条）即已足够；发布频率不至于超出
  const url = `${RELEASES_LATEST_URL}?per_page=100`;
  const releases = await fetchJson(url);
  if (!Array.isArray(releases)) throw new Error('GitHub releases response is not an array');
  // 仅排除 draft；保留 prerelease（上游 cua-driver-rs 只发 prerelease）
  const cua = releases
    .filter((r) => !r.draft && typeof r.tag_name === 'string' && r.tag_name.startsWith(TAG_PREFIX))
    .sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
  if (!cua.length) throw new Error(`No cua-driver-rs-v* release found in trycua/cua`);
  return cua[0];
}

async function fetchReleaseMeta(tag) {
  if (tag) return fetchJson(RELEASES_BY_TAG_URL(tag));
  return fetchLatestCuaDriverRelease();
}

/**
 * 仅拒绝 draft；允许 prerelease。
 * 上游 cua-driver-rs 只发 prerelease，若排除 prerelease，
 * 无论是 pin 指定还是拉取最新，都将无法安装任何版本。
 */
function assertStableRelease(meta) {
  if (!meta || typeof meta !== 'object') throw new Error('Malformed GitHub release metadata');
  if (meta.draft) throw new Error(`Refusing draft release: ${meta.tag_name}`);
  // 不排除 prerelease（上游 cua-driver-rs 的所有发布都是 prerelease）
}

// ── SHA256 via checksums.txt ────────────────────────────────────────────────

/**
 * 拉取 checksums.txt 并返回指定文件名的 SHA256。
 * 格式示例（带 markdown 包装）：
 *   ## SHA256 Checksums
 *   ```
 *   f57254...  cua-driver-rs-0.12.3-darwin-arm64.tar.gz
 *   ```
 */
async function fetchChecksumForAsset(version, assetFileName) {
  const checksumUrl = `https://github.com/trycua/cua/releases/download/${TAG_PREFIX}${version}/checksums.txt`;
  const text = await fetchText(checksumUrl);
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    // each line: "<sha256hex>  <filename>" — two spaces separator
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2 && parts[parts.length - 1] === assetFileName) {
      const candidate = parts[0];
      if (/^[a-fA-F0-9]{64}$/.test(candidate)) return candidate.toLowerCase();
    }
  }
  throw new Error(`SHA256 for ${assetFileName} not found in checksums.txt for v${version}`);
}

// ── Download & extract ─────────────────────────────────────────────────────

async function extractTarGz(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', '-'], {
      cwd: destDir,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) { resolve(); return; }
      const suffix = stderr.trim() ? `\n${stderr.trim()}` : '';
      reject(new Error(`tar exited with code ${code}${suffix}`));
    });
    fs.createReadStream(archivePath).pipe(child.stdin);
  });
}

/**
 * tarball 解压后含有嵌套目录（cua-driver-rs-<ver>-<platform>/）。
 * 将其内容（cua-driver 二进制、CuaDriver.app、dylib、.node）移动到 destDir 根目录下。
 */
function flattenExtractedContents(extractDir) {
  const entries = fs.readdirSync(extractDir, { withFileTypes: true });
  // tarball 顶层应该只有一个目录
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length !== 1) {
    // 也存在二进制直接解压到根目录的情况，目录数不为 1 时直接使用当前结构
    return;
  }
  const nestedDir = path.join(extractDir, dirs[0].name);
  for (const entry of fs.readdirSync(nestedDir, { withFileTypes: true })) {
    const src = path.join(nestedDir, entry.name);
    const dst = path.join(extractDir, entry.name);
    if (!fs.existsSync(dst)) {
      fs.renameSync(src, dst);
    }
  }
  try { fs.rmdirSync(nestedDir); } catch { /* ignore if not empty */ }
}

async function downloadPlatform(version, platform, { force = false } = {}) {
  const assetFileName = platform.assetName(version);
  const destDir = path.join(UPDATES_DIR, version, platform.key);
  const finalBinPath = path.join(destDir, platform.binFile);

  fs.mkdirSync(destDir, { recursive: true });

  if (!force && isUsableCache(finalBinPath)) {
    const size = fs.statSync(finalBinPath).size;
    console.log(`  [${platform.key}] skip (already exists, ${formatMB(size)})`);
    return;
  }

  const url = `https://github.com/trycua/cua/releases/download/${TAG_PREFIX}${version}/${assetFileName}`;
  console.log(`  [${platform.key}] fetching SHA256 from checksums.txt...`);
  const expectedHash = await fetchChecksumForAsset(version, assetFileName);

  console.log(`  [${platform.key}] ${url}`);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `cua-driver-${version}-${platform.key}-`));
  const tmpArchive = path.join(tmpRoot, assetFileName);
  const extractDir = path.join(tmpRoot, 'extract');
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    await downloadFile(url, tmpArchive);
    const actualHash = sha256File(tmpArchive);
    if (actualHash !== expectedHash) {
      throw new Error(`SHA256 mismatch for ${assetFileName}: expected ${expectedHash}, got ${actualHash}`);
    }
    console.log(`    [${platform.key}] sha256 ok`);

    await extractTarGz(tmpArchive, extractDir);
    flattenExtractedContents(extractDir);

    // 确认：裸二进制是否存在
    const extractedBin = path.join(extractDir, platform.binFile);
    if (!fs.existsSync(extractedBin)) {
      throw new Error(`No ${platform.binFile} found after extracting ${assetFileName}`);
    }

    // 将所有解压文件复制到 destDir（保留完整 payload）
    for (const entry of fs.readdirSync(extractDir, { withFileTypes: true })) {
      const src = path.join(extractDir, entry.name);
      const dst = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        fs.cpSync(src, dst, { recursive: true, force: true });
      } else {
        fs.copyFileSync(src, dst);
      }
    }

    // 为裸二进制赋予执行权限
    try { fs.chmodSync(finalBinPath, 0o755); } catch { /* ignore */ }

    const size = fs.statSync(finalBinPath).size;
    console.log(`    -> ${finalBinPath} (${formatMB(size)}, sha256 ok)`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// ── Promote ────────────────────────────────────────────────────────────────

/**
 * 将 updates/<version>/<platform>/ 的全部内容复制到 apps/cua-driver-bin/<platform>/。
 * promote 包含裸二进制 + CuaDriver.app + dylib + .node 的完整 payload。
 */
function promoteOnePlatform(version, platform) {
  const srcDir = path.join(UPDATES_DIR, version, platform.key);
  const destDir = path.join(BIN_DIR, platform.key);
  const srcBin = path.join(srcDir, platform.binFile);

  if (!fs.existsSync(srcBin)) {
    console.warn(`  [${platform.key}] WARN: source binary missing, skipping (${srcBin})`);
    return;
  }

  fs.mkdirSync(destDir, { recursive: true });

  try {
    // 复制全部内容（已有文件覆盖）
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const src = path.join(srcDir, entry.name);
      const dst = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        fs.cpSync(src, dst, { recursive: true, force: true });
      } else {
        try {
          fs.copyFileSync(src, dst);
        } catch (err) {
          if (err.code === 'EBUSY' || err.code === 'ETXTBSY') {
            console.warn(`  [${platform.key}] WARN: target locked (probably running): ${dst}. Close the app and re-run.`);
            return;
          }
          throw err;
        }
      }
    }
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'ETXTBSY') {
      console.warn(`  [${platform.key}] WARN: target locked (probably running). Close the app and re-run.`);
      return;
    }
    throw err;
  }

  // 执行权限
  const destBin = path.join(destDir, platform.binFile);
  try { fs.chmodSync(destBin, 0o755); } catch { /* ignore */ }

  // 版本标记（供 ensure-agent-binaries.mjs 的 skip 判定使用）
  try { fs.writeFileSync(path.join(destDir, '.version'), `${version}\n`); } catch { /* ignore */ }

  const size = fs.statSync(destBin).size;
  console.log(`  [${platform.key}] -> ${destDir} (binary ${formatMB(size)})`);
}

function promoteToVendorBin(version, platforms = PLATFORMS) {
  console.log('');
  console.log('==> Promoting to apps/cua-driver-bin/ ...');
  for (const platform of platforms) {
    promoteOnePlatform(version, platform);
  }
}

// ── Cache ──────────────────────────────────────────────────────────────────

function readCachedVersion() {
  if (!fs.existsSync(CACHE_FILE)) return null;
  try {
    const json = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return json.version || null;
  } catch {
    return null;
  }
}

function saveCache(meta, version) {
  const cache = {
    version,
    tag_name: meta.tag_name,
    name: meta.name ?? meta.tag_name,
    html_url: meta.html_url ?? `https://github.com/${REPO}/releases/tag/${meta.tag_name}`,
    prerelease: meta.prerelease,
    draft: meta.draft,
    published_at: meta.published_at,
    runtimeAssets: Object.fromEntries(
      PLATFORMS.map((p) => [
        p.key,
        {
          url: `https://github.com/${REPO}/releases/download/${TAG_PREFIX}${version}/${p.assetName(version)}`,
          // SHA256 在下载时已验证，此处保存到 latest.json 供参考
          sha256: null, // update 时异步获取，暂为 null（在 ensurePlatform 内重新获取）
        },
      ]),
    ),
  };
  fs.mkdirSync(__dirname, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n');
}

function targetsExist(version, platforms) {
  return platforms.every((p) => isUsableCache(path.join(UPDATES_DIR, version, p.key, p.binFile)));
}

// ── Programmatic API（供 scripts/ensure-agent-binaries.mjs 使用） ───────────

/** 读 latest.json 里 pin 的版本号。 */
export function readPinnedVersion() {
  return readCachedVersion();
}

/**
 * 确保单个平台的二进制就位：下载并 promote 到 apps/cua-driver-bin/<platformKey>/。
 * 非 darwin 平台静默跳过（不下载，不报错）。
 */
export async function ensurePlatform({ version, platformKey, force = false }) {
  const platform = PLATFORMS.find((p) => p.key === platformKey);
  if (!platform) {
    // 非 darwin 平台——静默跳过，不报错（companion app 是 macOS-only）
    if (!platformKey.startsWith('darwin')) return;
    throw new Error(`Unknown darwin platform key for cua-driver: ${platformKey}`);
  }
  const v = normalizeVersion(version);
  await downloadPlatform(v, platform, { force });
  promoteOnePlatform(v, platform);
}

// ── Args ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { version: null, force: false, help: false, platform: null };
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--force' || a === '-f') args.force = true;
    else if (a.startsWith('--platform=')) args.platform = a.slice('--platform='.length);
    else if (a.startsWith('--version=')) args.version = a.slice('--version='.length);
    else if (!a.startsWith('-')) args.version = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function resolvePlatforms(platformKey) {
  if (!platformKey) return PLATFORMS;
  const p = PLATFORMS.find((p) => p.key === platformKey);
  if (!p) throw new Error(`Unknown --platform=${platformKey} (known: ${PLATFORMS.map((p) => p.key).join(', ')})`);
  return [p];
}

function usage() {
  console.log(`Usage:
  pnpm update:cua-driver
  pnpm update:cua-driver 0.12.3
  pnpm update:cua-driver --version=0.12.3 --force

Downloads macOS cua-driver binaries from https://github.com/${REPO}/releases
and verifies every archive with the matching official checksums.txt.
Non-darwin platforms are silently skipped (macOS-only companion app).`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { version: requestedVersion, force, help, platform } = parseArgs(process.argv.slice(2));
  if (help) { usage(); return; }
  const targets = resolvePlatforms(platform);

  // 非 darwin 构建机（CI 等）的调用静默跳过
  const darwinTargets = targets.filter((p) => p.key.startsWith('darwin'));
  if (darwinTargets.length === 0) {
    console.log('[cua-driver] No darwin targets; skipping (cua-driver is macOS-only).');
    return;
  }

  if (requestedVersion) {
    const version = normalizeVersion(requestedVersion);
    const tag = `${TAG_PREFIX}${version}`;
    console.log(`==> Pinning cua-driver to ${version} (specified, tag=${tag})...`);
    const meta = await fetchReleaseMeta(tag);
    assertStableRelease(meta);
    for (const p of darwinTargets) {
      await downloadPlatform(version, p, { force });
    }
    promoteToVendorBin(version, darwinTargets);
    saveCache(meta, version);
    console.log('');
    console.log('=== Done ===');
    console.log(`Version: ${version}`);
    console.log(`Output:  ${path.join(UPDATES_DIR, version)}`);
    console.log(`Bin:     ${BIN_DIR}`);
    return;
  }

  console.log(`==> Fetching latest stable cua-driver-rs release from GitHub (${REPO})...`);
  const meta = await fetchReleaseMeta(null);
  assertStableRelease(meta);
  const latestVersion = versionFromTag(meta.tag_name);
  const cachedVersion = readCachedVersion();
  console.log(`    Latest: ${latestVersion} (${meta.tag_name})`);
  console.log(`    Cached: ${cachedVersion ?? '(none)'}`);

  if (cachedVersion === latestVersion && !force && targetsExist(latestVersion, darwinTargets)) {
    saveCache(meta, latestVersion);
    promoteToVendorBin(latestVersion, darwinTargets);
    console.log('==> Already up to date.');
    return;
  }

  console.log(`==> New version detected (${cachedVersion ?? 'none'} → ${latestVersion}), downloading...`);
  for (const p of darwinTargets) {
    await downloadPlatform(latestVersion, p, { force });
  }
  saveCache(meta, latestVersion);
  promoteToVendorBin(latestVersion, darwinTargets);

  console.log('');
  console.log('=== Done ===');
  console.log(`Version: ${latestVersion}`);
  console.log(`Output:  ${path.join(UPDATES_DIR, latestVersion)}`);
  console.log(`Bin:     ${BIN_DIR}`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
