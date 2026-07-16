#!/usr/bin/env node

/**
 * release-claude-code.mjs — 单独发布 Claude Code binary（不重新打包 app）
 *
 * 用法:
 *   node scripts/release-claude-code.mjs [--version 2.1.112] [--platform win32-x64,darwin-arm64,darwin-x64,linux-x64] [--dry-run] [--force]
 *
 * 环境变量（非 dry-run 必需）:
 *   FP_DEV_OSS_ACCESS_KEY_ID     — 阿里云 AK
 *   FP_DEV_OSS_ACCESS_KEY_SECRET — 阿里云 SK
 *
 * 流程（每个平台）:
 *   1. 读取本地 apps/claude-code-bin/<platformKey>/claude(.exe)  ← 手动放置
 *   2. 拉取 CDN canary manifest（404 回退 stable 拿基线），比对版本号 + binary sha256
 *   3. 如有变化：gzip 压缩 → 计算 sha256/size → 上传 → 更新并上传 canary manifest
 *   4. 无变化：跳过（dry-run 时仅打印，不上传）
 *
 * 通道: 全部走 canary（manifest-<platform>-canary.json），由 promote-canary-* 脚本统一提升到 stable。
 * 顺序铁律: 先上传 .gz → 再写 manifest → 再上传 manifest（防止 manifest 指向 404 binary）
 *
 * 选项:
 *   --version <semver>  可选；不传时从 host 平台的本地 binary 执行 claude --version 自动探测
 *   --platform <list>   可选，逗号分隔，例如 win32-x64,darwin-arm64,linux-x64
 *   --dry-run           只打印结果，不上传 OSS / 不更新 manifest
 *   --force             即使版本和 hash 相同也强制上传
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ensureBinary } from '../../../scripts/ensure-agent-binaries.mjs';
import { resolveCdnBaseUrl } from '../../../scripts/shared/production-endpoints.mjs';
import {
  loadDotenv,
  uploadVersionedGzImmutable,
  OSS_BUCKET,
  OSS_PREFIX,
  OSS_REGION,
} from './ci/lib.mjs';

const require = createRequire(import.meta.url);
const OSS = require('ali-oss');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(DESKTOP_ROOT, '../..');
const RELEASE_DIR = path.join(DESKTOP_ROOT, 'release');

// 独立发布与完整 app 发版遵守同一配置时序：先加载 desktop .env，
// loadDotenv 内部会刷新共享 OSS live bindings，再解析 CDN 地址。
loadDotenv();
const CDN_BASE = resolveCdnBaseUrl();

const ALL_PLATFORMS = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64'];

// ── CLI 参数解析 ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function getFlag(name) {
  const idx = argv.indexOf(name);
  if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
  return null;
}

const VERSION_FLAG = getFlag('--version');
const DRY_RUN = argv.includes('--dry-run');
const FORCE = argv.includes('--force');
const platformFilter = getFlag('--platform');

const PLATFORMS = platformFilter
  ? ALL_PLATFORMS.filter((p) => platformFilter.split(',').includes(p))
  : ALL_PLATFORMS;

if (PLATFORMS.length === 0) {
  console.error(`ERROR: no platforms matched filter "${platformFilter}"`);
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function binaryName(platformKey) {
  return platformKey.startsWith('win32') ? 'claude.exe' : 'claude';
}

function getLocalBinPath(platformKey) {
  return path.join(PROJECT_ROOT, 'apps', 'claude-code-bin', platformKey, binaryName(platformKey));
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

async function gzipFile(srcPath, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const src = fs.createReadStream(srcPath);
  const dest = fs.createWriteStream(destPath);
  await pipeline(src, createGzip(), dest);
}

function getHostPlatformKey() {
  return `${process.platform}-${process.arch}`;
}

function detectVersionFromHost() {
  const hostKey = getHostPlatformKey();
  const binPath = getLocalBinPath(hostKey);
  if (!fs.existsSync(binPath)) return { version: null, hostKey };
  if (process.platform !== 'win32') {
    try { fs.chmodSync(binPath, 0o755); } catch {}
  }
  try {
    const output = execSync(`"${binPath}" --version`, { encoding: 'utf8', timeout: 10000 });
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return { version: match ? match[1] : null, hostKey };
  } catch (err) {
    console.warn(`    WARN: failed to exec ${binPath} --version: ${err.message}`);
    return { version: null, hostKey };
  }
}

async function fetchExistingManifest(platformKey) {
  // canary-release: 优先读 canary manifest 作为基线；首次 canary 发布回退到 stable。
  // ?t= cache-bust 必须带:CDN 对裸 URL 有边缘缓存,读到陈旧基线会误判"版本变了"
  // 而重复上传同版本(2026-07-03 事故直接诱因)。
  const canaryUrl = `${CDN_BASE}/manifest-${platformKey}-canary.json?t=${Date.now()}`;
  const canaryRes = await fetch(canaryUrl);
  if (canaryRes.ok) return await canaryRes.json();
  if (canaryRes.status !== 404) {
    throw new Error(`Failed to fetch canary manifest (${canaryRes.status}): ${canaryUrl}`);
  }
  console.warn(`    canary manifest missing — falling back to stable manifest for version baseline`);
  const stableUrl = `${CDN_BASE}/manifest-${platformKey}.json?t=${Date.now()}`;
  const stableRes = await fetch(stableUrl);
  if (!stableRes.ok) throw new Error(`Failed to fetch stable manifest (${stableRes.status}): ${stableUrl}`);
  return await stableRes.json();
}

function getAKSK() {
  const accessKeyId = process.env.FP_DEV_OSS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.FP_DEV_OSS_ACCESS_KEY_SECRET;
  if (!accessKeyId || !accessKeySecret) {
    console.error('ERROR: FP_DEV_OSS_ACCESS_KEY_ID and FP_DEV_OSS_ACCESS_KEY_SECRET must be set');
    process.exit(1);
  }
  return { accessKeyId, accessKeySecret };
}

function createOSSClient() {
  const { accessKeyId, accessKeySecret } = getAKSK();
  return new OSS({ region: OSS_REGION, accessKeyId, accessKeySecret, bucket: OSS_BUCKET, timeout: 600_000 });
}

const MULTIPART_THRESHOLD = 10 * 1024 * 1024;

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
            if (pct >= lastPercent + 10) { lastPercent = pct; console.log(`      ${pct}%`); }
          },
        });
        break;
      } catch (err) {
        if (attempt === MAX_RETRIES) throw err;
        const delay = attempt * 3;
        console.warn(`      Upload failed (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);
        console.warn(`      Retrying in ${delay}s...`);
        await new Promise((r) => setTimeout(r, delay * 1000));
      }
    }
  } else {
    await client.put(ossKey, localPath, options);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // 凭证 fail-fast（dry-run 模式不需要凭证）
  if (!DRY_RUN) getAKSK();

  if (DRY_RUN) console.log('==> DRY RUN mode — no uploads will happen\n');
  if (FORCE) console.log('==> FORCE mode — will upload even if version/hash match\n');

  fs.mkdirSync(RELEASE_DIR, { recursive: true });

  // claude 二进制不再进 git/LFS——发版前按需从上游下载各目标平台（pin 版本见 tools/claude/latest.json）。
  // 仅当未显式指定 --version 时才自动 ensure pin 版本：传了 --version 说明发布方手动 stage 了
  // 特定版本的 binary，绝不能用 pin 版本覆盖它（否则会把 pin 版本以 --version 的标签传到 CDN）。
  // 失败必须 fatal（不能 best-effort）：apps/claude-code-bin 现已被 gitignore、会跨 pin 残留旧 binary，
  // 若某平台刷新失败仍继续，后面 upload 循环只判 existsSync，会把陈旧 binary 以 host 探测出的新
  // VERSION 标签传上 CDN。ensureBinary 成功返回即保证 .version 标记 == pin，失败抛出 → 中止发版。
  if (!VERSION_FLAG) {
    for (const platformKey of PLATFORMS) {
      await ensureBinary('claude', platformKey);
    }
  }

  // 决定版本号：--version 优先；否则从 host 平台的 binary 自动探测
  let VERSION = VERSION_FLAG;
  if (!VERSION) {
    const { version, hostKey } = detectVersionFromHost();
    if (!version) {
      console.error(`ERROR: --version not provided and could not auto-detect from ${hostKey} binary`);
      console.error(`       Place binary at apps/claude-code-bin/${hostKey}/${binaryName(hostKey)} or pass --version <semver>`);
      process.exit(1);
    }
    VERSION = version;
    console.log(`==> Claude Code version (auto-detected from ${hostKey}): ${VERSION}`);
  } else {
    console.log(`==> Claude Code version (from --version): ${VERSION}`);
  }
  console.log(`==> Platforms: ${PLATFORMS.join(', ')}\n`);

  const client = DRY_RUN ? null : createOSSClient();
  const skipped = [];
  const uploaded = [];
  const failed = [];

  for (const platformKey of PLATFORMS) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`==> Claude Code binary for ${platformKey}`);
    console.log(`${'='.repeat(60)}`);

    const binPath = getLocalBinPath(platformKey);
    if (!fs.existsSync(binPath)) {
      console.log(`    SKIP: binary not found at ${binPath}`);
      skipped.push(platformKey);
      continue;
    }

    const binSize = fs.statSync(binPath).size;
    const localBinHash = sha256(binPath);

    console.log(`    bin path:       ${binPath}`);
    console.log(`    bin size:       ${(binSize / 1024 / 1024).toFixed(1)} MB (${binSize} bytes)`);
    console.log(`    local version:  ${VERSION}`);
    console.log(`    local sha256:   ${localBinHash}`);

    let manifest;
    try {
      manifest = await fetchExistingManifest(platformKey);
    } catch (err) {
      console.warn(`    WARN: failed to fetch manifest for ${platformKey}: ${err.message}`);
      manifest = {};
    }

    const cdnVersion = manifest.claudeCode?.version || '0.0.0';
    const cdnBinaryHash = manifest.claudeCode?.binarySha256 || '';

    console.log(`    CDN version:    ${cdnVersion}`);
    console.log(`    CDN sha256:     ${cdnBinaryHash || '(none)'}`);

    const versionDiffers = VERSION !== cdnVersion;
    const hashDiffers = cdnBinaryHash ? localBinHash !== cdnBinaryHash : false;
    const needsUpload = FORCE || versionDiffers || hashDiffers;

    if (!needsUpload) {
      console.log(`    → verdict: SKIP (version and binary hash match CDN)`);
      skipped.push(platformKey);
      continue;
    }

    const reasons = [];
    if (FORCE) reasons.push('--force');
    if (versionDiffers) reasons.push(`version ${cdnVersion} → ${VERSION}`);
    if (hashDiffers) reasons.push('binary content changed');
    console.log(`    → verdict: UPLOAD (${reasons.join(', ')})`);

    // gzip：保留历史命名约定 → claude.gz / claude.exe.gz
    const gzName = `${binaryName(platformKey)}.gz`;
    const gzPath = path.join(RELEASE_DIR, `${platformKey}-${gzName}`);
    console.log(`\n    Compressing → ${gzPath} ...`);
    try {
      await gzipFile(binPath, gzPath);
    } catch (err) {
      console.warn(`    WARN: gzip failed for ${platformKey}: ${err.message}`);
      failed.push(platformKey);
      continue;
    }
    const gzSha256 = sha256(gzPath);
    const gzSize = fs.statSync(gzPath).size;
    console.log(`    gz size:        ${(gzSize / 1024 / 1024).toFixed(1)} MB (${gzSize} bytes)`);
    console.log(`    gz sha256:      ${gzSha256}`);

    const gzFileRel = `claude-code/${VERSION}/${platformKey}/${gzName}`;
    const manifestLocalPath = path.join(RELEASE_DIR, `manifest-${platformKey}-canary.json`);

    if (DRY_RUN) {
      manifest.claudeCode = {
        version: VERSION,
        file: gzFileRel,
        sha256: gzSha256,
        size: gzSize,
        binarySha256: localBinHash,
      };
      fs.writeFileSync(manifestLocalPath, JSON.stringify(manifest, null, 2) + '\n');
      console.log(`    Manifest written: ${manifestLocalPath}`);
      console.log(`    [DRY RUN] would upload: ${gzFileRel}`);
      console.log(`    [DRY RUN] would upload: manifest-${platformKey}-canary.json`);
      uploaded.push(platformKey);
      continue;
    }

    // 顺序铁律：先传 binary。immutable 守卫:同版本路径已存在同源对象时不覆盖,
    // 复用远端 sha256/size;存在不同内容时报错(--force 才允许覆盖)。见 ci/lib.mjs。
    const ossKey = `${OSS_PREFIX}/${gzFileRel}`;
    console.log(`\n    Uploading → ${ossKey}`);
    let publishInfo;
    try {
      publishInfo = await uploadVersionedGzImmutable({
        client,
        ossKey,
        gzPath,
        gzSha256,
        gzSize,
        binarySha256: localBinHash,
        force: FORCE,
      });
    } catch (err) {
      console.warn(`    WARN: OSS upload failed for ${platformKey}: ${err.message}`);
      failed.push(platformKey);
      continue;
    }
    if (publishInfo.uploaded) console.log(`    Upload complete.`);

    // 顺序铁律：再写 manifest → 再传 manifest。sha256/size 一律取守卫返回值
    // (reuse 场景下是远端对象的值,manifest 必须描述用户实际会下载到的字节)。
    manifest.claudeCode = {
      version: VERSION,
      file: gzFileRel,
      sha256: publishInfo.gzSha256,
      size: publishInfo.gzSize,
      binarySha256: publishInfo.binarySha256,
    };
    fs.writeFileSync(manifestLocalPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`    Manifest written: ${manifestLocalPath}`);

    // 顺序铁律：再传 manifest（canary 通道）
    const manifestOssKey = `${OSS_PREFIX}/manifest-${platformKey}-canary.json`;
    console.log(`    Uploading manifest → ${manifestOssKey}`);
    try {
      await uploadToOSS(client, manifestOssKey, manifestLocalPath, {
        headers: { 'Cache-Control': 'no-cache' },
      });
    } catch (err) {
      console.warn(`    WARN: manifest upload failed for ${platformKey}: ${err.message}`);
      failed.push(platformKey);
      continue;
    }

    console.log(`\n==> ${platformKey} done!`);
    console.log(`    CDN gz:       ${CDN_BASE}/claude-code/${VERSION}/${platformKey}/${gzName}`);
    console.log(`    CDN manifest: ${CDN_BASE}/manifest-${platformKey}-canary.json (canary channel)`);
    uploaded.push(platformKey);
  }

  // 汇总
  console.log(`\n${'='.repeat(60)}`);
  console.log(`=== Claude Code release summary ===`);
  if (uploaded.length) console.log(`    uploaded: ${uploaded.join(', ')}`);
  if (skipped.length)  console.log(`    skipped:  ${skipped.join(', ')}`);
  if (failed.length)   console.log(`    failed:   ${failed.join(', ')}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
