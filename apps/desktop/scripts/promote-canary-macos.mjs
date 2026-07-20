#!/usr/bin/env node

/**
 * promote-canary-macos.mjs — 将 CDN 上的 macOS canary manifest 提升为 stable
 *
 * canary-release V0.1
 *
 * 用法:
 *   node scripts/promote-canary-macos.mjs                  # dry-run，两个 arch 都打印
 *   node scripts/promote-canary-macos.mjs --yes            # 提升 darwin-arm64 + darwin-x64
 *   node scripts/promote-canary-macos.mjs --arch arm64     # 仅 dry-run arm64
 *   node scripts/promote-canary-macos.mjs --arch x64 --yes # 仅提升 x64
 *   node scripts/promote-canary-macos.mjs --region global --yes  # 海外渠道(默认 cn)
 *
 * 流程: 与 windows 版相同，每个 arch 独立处理。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const OSS = require('ali-oss');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(__dirname, '..');

try {
  const envFile = fs.readFileSync(path.join(DESKTOP_ROOT, '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
} catch { /* no .env file */ }

import { resolveReleaseCdnBaseUrl } from '../../../scripts/shared/release-env.mjs';
import { OSS_BUCKET, OSS_PREFIX, OSS_REGION, refreshOssConfig, resolveOssCredentials } from '../../../scripts/shared/oss.mjs';
import { applyReleaseRegionConfigToEnv } from './ci/release-regions.mjs';

// 发布区域:cn(国内,默认)/ global(海外),与 release-macos.mjs 同一套渠道配置。
const REGION = (() => {
  const idx = process.argv.indexOf('--region');
  const value = idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : 'cn';
  if (!['cn', 'global', 'dev'].includes(value)) {
    console.error(`ERROR: --region must be cn, global or dev (got "${value}")`);
    process.exit(1);
  }
  return value;
})();

// 发布目标优先从发版机本地 scripts/release-regions.json 取(env 显式值优先,
// 见 ci/release-regions.mjs;真机密 AK/SK 等仍走 env / .env)。
applyReleaseRegionConfigToEnv(REGION);

refreshOssConfig(REGION);
const CDN_BASE = resolveReleaseCdnBaseUrl(REGION);

const ALL_ARCHS = ['arm64', 'x64'];

function parseArgs() {
  const args = process.argv.slice(2);
  const yes = args.includes('--yes');
  const archIdx = args.indexOf('--arch');
  let archs = ALL_ARCHS;
  if (archIdx >= 0 && args[archIdx + 1]) {
    const requested = args[archIdx + 1];
    if (!ALL_ARCHS.includes(requested)) {
      console.error(`ERROR: --arch must be one of ${ALL_ARCHS.join(', ')}`);
      process.exit(1);
    }
    archs = [requested];
  }
  return { yes, archs };
}

function createOSSClient() {
  const { accessKeyId, accessKeySecret } = resolveOssCredentials(REGION);
  return new OSS({
    region: OSS_REGION,
    accessKeyId,
    accessKeySecret,
    bucket: OSS_BUCKET,
    timeout: 600_000,
  });
}

async function fetchManifest(platformKey, channel) {
  const suffix = channel === 'canary' ? '-canary' : '';
  const url = `${CDN_BASE}/manifest-${platformKey}${suffix}.json?t=${Date.now()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    if (res.status === 404 && channel === 'stable') return { text: null, json: null };
    throw new Error(`Failed to fetch ${channel} manifest (${res.status}): ${url}`);
  }
  const text = await res.text();
  return { text, json: JSON.parse(text) };
}

function summarize(label, m) {
  console.log(`  ${label}:`);
  console.log(`    app.version:        ${m?.app?.version ?? '(none)'}`);
  console.log(`    app.hotfix.file:    ${m?.app?.hotfix?.file ?? '(none)'}`);
  console.log(`    app.requireRelogin: ${m?.app?.requireRelogin ?? false}`);
  console.log(`    claudeCode.version: ${m?.claudeCode?.version ?? '(none)'}`);
}

// 覆盖 stable 前，把该 arch 当前 stable manifest 按其版本号备份到 OSS 的 back-up/<version>/ 目录。
// 备份任何环节失败都会抛错，调用方据此中止 promote —— 确保"备份成功才能完成发布"。
async function backupStableManifest(client, platformKey, stableText, stableJson) {
  const version = stableJson?.app?.version;
  if (!version) {
    throw new Error(`[${platformKey}] 当前 stable manifest 缺少 app.version，无法确定备份目录，已中止 promote。`);
  }
  if (!/^[\w.+-]+$/.test(version)) {
    throw new Error(`[${platformKey}] stable 版本号含非法字符，拒绝作为备份目录名: ${version}`);
  }
  const backupKey = `${OSS_PREFIX}/back-up/${version}/manifest-${platformKey}.json`;
  console.log(`  ==> Backing up current stable (v${version}) → ${backupKey}`);
  const tmpPath = path.join(os.tmpdir(), `manifest-${platformKey}-backup-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, stableText);
  try {
    const result = await client.put(backupKey, tmpPath, {
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (!result?.res || result.res.status !== 200) {
      throw new Error(`[${platformKey}] 备份上传返回异常状态: ${result?.res?.status}`);
    }
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
  console.log(`  ==> backup OK: ${CDN_BASE}/back-up/${version}/manifest-${platformKey}.json`);
}

async function promoteOne(client, arch, yes) {
  const platformKey = `darwin-${arch}`;
  console.log(`\n--- ${platformKey} ---`);

  const canary = await fetchManifest(platformKey, 'canary');
  const stable = await fetchManifest(platformKey, 'stable');

  summarize('Current STABLE', stable.json);
  console.log('');
  summarize('Incoming CANARY', canary.json);

  if (!yes) {
    console.log('  [DRY RUN]');
    if (stable.json) {
      console.log(`  → 覆盖前会先把当前 stable (v${stable.json?.app?.version ?? '?'}) 备份到 back-up/<version>/`);
    } else {
      console.log('  → 当前无 stable manifest（首次发布），无需备份。');
    }
    return;
  }

  // 覆盖 stable 前先备份当前 stable；备份失败会抛错中止，下面的覆盖不会执行。
  if (stable.json && stable.text) {
    await backupStableManifest(client, platformKey, stable.text, stable.json);
  } else {
    console.log('  ==> 当前无 stable manifest（首次发布），跳过备份。');
  }

  console.log(`  ==> Uploading canary manifest as stable...`);
  const tmpPath = path.join(os.tmpdir(), `manifest-${platformKey}-promote-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, canary.text);

  try {
    const ossKey = `${OSS_PREFIX}/manifest-${platformKey}.json`;
    console.log(`     ${tmpPath} → ${ossKey}`);
    await client.put(ossKey, tmpPath, {
      headers: { 'Cache-Control': 'no-cache' },
    });
    console.log(`  ==> done: ${CDN_BASE}/manifest-${platformKey}.json @ ${canary.json.app.version}`);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

async function main() {
  const { yes, archs } = parseArgs();
  console.log(`=== Promote canary → stable (macOS, ${archs.join(' + ')}, region: ${REGION}) ===`);
  console.log(`    CDN: ${CDN_BASE}`);

  // 仅在真要执行时才创建 OSS client（dry-run 不需要 AK/SK）
  const client = yes ? createOSSClient() : null;

  for (const arch of archs) {
    await promoteOne(client, arch, yes);
  }

  if (!yes) {
    console.log('\n  No changes uploaded. Run with --yes to promote.');
  } else {
    console.log('\n=== Promote complete ===');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
