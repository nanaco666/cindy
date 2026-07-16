#!/usr/bin/env node

/**
 * release-ripgrep.mjs — 单独发布 ripgrep binary（不重新打包 app）
 *
 * 用法:
 *   node scripts/release-ripgrep.mjs [--version 15.1.0] [--platform win32-x64,darwin-arm64,darwin-x64,linux-x64] [--dry-run] [--force]
 *
 * 目的:
 *   给 scripts/ensure-agent-binaries.mjs 的 ripgrep CDN/OSS fallback 预置裸二进制 .gz。
 *
 * 通道:
 *   全部走 canary manifest；fallback 即使没有 manifest 字段也能按路径下载，但写入
 *   manifest.ripgrep 后可额外校验 .gz sha256 与解压后二进制 sha256。
 */

import fs from 'node:fs';
import path from 'node:path';

import { ensureBinary } from '../../../scripts/ensure-agent-binaries.mjs';
import {
  CDN_BASE,
  OSS_PREFIX,
  loadDotenv,
  PROJECT_ROOT,
  RELEASE_DIR,
  createOSSClient,
  fetchExistingManifest,
  gzipFile,
  sha256,
  uploadToOSS,
  uploadVersionedGzImmutable,
} from './ci/lib.mjs';

// 独立发布与完整 app 发版遵守同一配置时序：先加载 desktop .env，
// loadDotenv 内部会刷新共享 OSS live bindings，再读取 CDN / OSS 配置。
loadDotenv();

const ALL_PLATFORMS = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64'];
const PINNED_VERSION = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'tools', 'ripgrep', 'latest.json'), 'utf8')).version;

const argv = process.argv.slice(2);

function getFlag(name) {
  const idx = argv.indexOf(name);
  if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
  return null;
}

const VERSION = getFlag('--version') ?? PINNED_VERSION;
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

function binaryName(platformKey) {
  return platformKey.startsWith('win32') ? 'rg.exe' : 'rg';
}

function getLocalBinPath(platformKey) {
  return path.join(PROJECT_ROOT, 'apps', 'ripgrep-bin', platformKey, binaryName(platformKey));
}

async function main() {
  if (DRY_RUN) console.log('==> DRY RUN mode — no uploads will happen\n');
  if (FORCE) console.log('==> FORCE mode — will upload even if version/hash match\n');

  fs.mkdirSync(RELEASE_DIR, { recursive: true });

  if (!getFlag('--version')) {
    for (const platformKey of PLATFORMS) {
      await ensureBinary('ripgrep', platformKey);
    }
  }

  console.log(`==> ripgrep version: ${VERSION}`);
  console.log(`==> platforms: ${PLATFORMS.join(', ')}\n`);

  const client = DRY_RUN ? null : createOSSClient();
  const skipped = [];
  const uploaded = [];
  const failed = [];

  for (const platformKey of PLATFORMS) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`==> ripgrep binary for ${platformKey}`);
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

    let manifest = null;
    try {
      manifest = await fetchExistingManifest(platformKey);
    } catch (err) {
      console.warn(`    WARN: failed to fetch manifest for ${platformKey}: ${err.message}`);
      console.warn('    Will upload binary only; CDN fallback can still use the path without manifest sha verification.');
    }

    const cdnVersion = manifest?.ripgrep?.version || '0.0.0';
    const cdnBinaryHash = manifest?.ripgrep?.binarySha256 || '';
    console.log(`    CDN version:    ${cdnVersion}`);
    console.log(`    CDN sha256:     ${cdnBinaryHash || '(none)'}`);

    const versionDiffers = VERSION !== cdnVersion;
    const hashDiffers = cdnBinaryHash ? localBinHash !== cdnBinaryHash : false;
    const needsUpload = FORCE || versionDiffers || hashDiffers || !manifest?.ripgrep;

    if (!needsUpload) {
      console.log('    -> verdict: SKIP (version and binary hash match CDN)');
      skipped.push(platformKey);
      continue;
    }

    const reasons = [];
    if (FORCE) reasons.push('--force');
    if (!manifest) reasons.push('manifest unavailable');
    else if (!manifest.ripgrep) reasons.push('manifest missing ripgrep field');
    if (versionDiffers) reasons.push(`version ${cdnVersion} -> ${VERSION}`);
    if (hashDiffers) reasons.push('binary content changed');
    console.log(`    -> verdict: UPLOAD (${reasons.join(', ')})`);

    const gzName = `${binaryName(platformKey)}.gz`;
    const gzPath = path.join(RELEASE_DIR, `${platformKey}-${gzName}`);
    console.log(`\n    Compressing -> ${gzPath} ...`);
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

    const gzFileRel = `ripgrep/${VERSION}/${platformKey}/${gzName}`;

    if (DRY_RUN) {
      if (manifest) {
        manifest.ripgrep = {
          version: VERSION,
          file: gzFileRel,
          sha256: gzSha256,
          size: gzSize,
          binarySha256: localBinHash,
        };
        const dryManifestPath = path.join(RELEASE_DIR, `manifest-${platformKey}-canary.json`);
        fs.writeFileSync(dryManifestPath, JSON.stringify(manifest, null, 2) + '\n');
        console.log(`    Manifest written: ${dryManifestPath}`);
        console.log(`    [DRY RUN] would upload: manifest-${platformKey}-canary.json`);
      }
      console.log(`    [DRY RUN] would upload: ${gzFileRel}`);
      uploaded.push(platformKey);
      continue;
    }

    // 顺序铁律:先传 binary。immutable 守卫:同版本路径已存在同源对象时复用远端
    // sha256/size(不覆盖);存在不同内容时报错(--force 才允许覆盖)。见 ci/lib.mjs。
    const ossKey = `${OSS_PREFIX}/${gzFileRel}`;
    console.log(`\n    Uploading -> ${ossKey}`);
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

    let manifestLocalPath = null;
    if (manifest) {
      // sha256/size 取守卫返回值(reuse 场景下是远端对象的值)。
      manifest.ripgrep = {
        version: VERSION,
        file: gzFileRel,
        sha256: publishInfo.gzSha256,
        size: publishInfo.gzSize,
        binarySha256: publishInfo.binarySha256,
      };
      manifestLocalPath = path.join(RELEASE_DIR, `manifest-${platformKey}-canary.json`);
      fs.writeFileSync(manifestLocalPath, JSON.stringify(manifest, null, 2) + '\n');
      console.log(`    Manifest written: ${manifestLocalPath}`);
    }

    if (manifestLocalPath) {
      const manifestOssKey = `${OSS_PREFIX}/manifest-${platformKey}-canary.json`;
      console.log(`    Uploading manifest -> ${manifestOssKey}`);
      try {
        await uploadToOSS(client, manifestOssKey, manifestLocalPath, {
          headers: { 'Cache-Control': 'no-cache' },
        });
      } catch (err) {
        console.warn(`    WARN: manifest upload failed for ${platformKey}: ${err.message}`);
        failed.push(platformKey);
        continue;
      }
    }

    console.log(`\n==> ${platformKey} done!`);
    console.log(`    CDN gz:       ${CDN_BASE}/ripgrep/${VERSION}/${platformKey}/${gzName}`);
    if (manifestLocalPath) console.log(`    CDN manifest: ${CDN_BASE}/manifest-${platformKey}-canary.json (canary channel)`);
    uploaded.push(platformKey);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('=== ripgrep release summary ===');
  if (uploaded.length) console.log(`    uploaded: ${uploaded.join(', ')}`);
  if (skipped.length) console.log(`    skipped:  ${skipped.join(', ')}`);
  if (failed.length) console.log(`    failed:   ${failed.join(', ')}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
