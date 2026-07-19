#!/usr/bin/env node

/**
 * promote-canary-windows.mjs — 将 CDN 上的 Windows canary manifest 提升为 stable
 *
 * canary-release V0.1
 *
 * 用法:
 *   node scripts/promote-canary-windows.mjs           # dry-run，仅打印将要提升的版本
 *   node scripts/promote-canary-windows.mjs --yes     # 真正执行覆盖
 *   node scripts/promote-canary-windows.mjs --region global --yes  # 海外渠道(默认 cn)
 *
 * 流程:
 *   1. 从 CDN 拉 manifest-win32-x64-canary.json
 *   2. 打印版本号、hotfix 文件、安装包供人工确认
 *   3. 不带 --yes → 退出
 *   4. 带 --yes → 把同一份 JSON 上传为 manifest-win32-x64.json 覆盖 stable
 *
 * 注意: 安装包 / 热更新 zip / claude-code 二进制本身已经在 release 时上传过，
 * 此脚本只搬动 manifest.json —— 因为 canary 与 stable 共享同一批底层文件。
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

// 复用 release 脚本的 .env 加载逻辑
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

// 发布区域:cn(国内,默认)/ global(海外),与 release-windows.mjs 同一套渠道配置。
const REGION = (() => {
  const idx = process.argv.indexOf('--region');
  const value = idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : 'cn';
  if (!['cn', 'global'].includes(value)) {
    console.error(`ERROR: --region must be cn or global (got "${value}")`);
    process.exit(1);
  }
  return value;
})();

// 发布目标优先从发版机本地 scripts/release-regions.json 取(env 显式值优先,
// 见 ci/release-regions.mjs;真机密 AK/SK 等仍走 env / .env)。
applyReleaseRegionConfigToEnv(REGION);

refreshOssConfig(REGION);
const PLATFORM_KEY = 'win32-x64';
const CDN_BASE = resolveReleaseCdnBaseUrl(REGION);

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

async function fetchCanaryManifest() {
  // 加 timestamp 强制绕开 CDN 缓存，确保我们 promote 的是最新 canary
  const url = `${CDN_BASE}/manifest-${PLATFORM_KEY}-canary.json?t=${Date.now()}`;
  console.log(`==> Fetching canary manifest: ${url}`);
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to fetch canary manifest (${res.status}): ${url}`);
  }
  const text = await res.text();
  return { text, json: JSON.parse(text) };
}

async function fetchStableManifest() {
  const url = `${CDN_BASE}/manifest-${PLATFORM_KEY}.json?t=${Date.now()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    if (res.status === 404) return { text: null, json: null };
    throw new Error(`Failed to fetch stable manifest (${res.status}): ${url}`);
  }
  const text = await res.text();
  return { text, json: JSON.parse(text) };
}

// 覆盖 stable 前，把当前 stable manifest 按其版本号备份到 OSS 的 back-up/<version>/ 目录。
// 备份任何环节失败都会抛错，调用方据此中止 promote —— 确保"备份成功才能完成发布"。
async function backupStableManifest(client, stableText, stableJson) {
  const version = stableJson?.app?.version;
  if (!version) {
    throw new Error('当前 stable manifest 缺少 app.version，无法确定备份目录，已中止 promote。');
  }
  if (!/^[\w.+-]+$/.test(version)) {
    throw new Error(`stable 版本号含非法字符，拒绝作为备份目录名: ${version}`);
  }
  const backupKey = `${OSS_PREFIX}/back-up/${version}/manifest-${PLATFORM_KEY}.json`;
  console.log(`\n==> Backing up current stable (v${version}) → ${backupKey}`);
  const tmpPath = path.join(os.tmpdir(), `manifest-${PLATFORM_KEY}-backup-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, stableText);
  try {
    const result = await client.put(backupKey, tmpPath, {
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (!result?.res || result.res.status !== 200) {
      throw new Error(`备份上传返回异常状态: ${result?.res?.status}`);
    }
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
  console.log(`    backup OK: ${CDN_BASE}/back-up/${version}/manifest-${PLATFORM_KEY}.json`);
}

function summarize(label, m) {
  console.log(`\n  ${label}:`);
  console.log(`    app.version:      ${m?.app?.version ?? '(none)'}`);
  console.log(`    app.hotfix.file:  ${m?.app?.hotfix?.file ?? '(none)'}`);
  console.log(`    app.hotfix.size:  ${m?.app?.hotfix?.size ?? '(none)'}`);
  console.log(`    app.requireRelogin: ${m?.app?.requireRelogin ?? false}`);
  console.log(`    claudeCode.version: ${m?.claudeCode?.version ?? '(none)'}`);
}

async function main() {
  const args = process.argv.slice(2);
  const yes = args.includes('--yes');

  console.log(`=== Promote canary → stable (Windows, region: ${REGION}) ===`);
  console.log(`    CDN: ${CDN_BASE}\n`);

  const { text, json: canaryManifest } = await fetchCanaryManifest();
  const { text: stableText, json: stableManifest } = await fetchStableManifest();

  summarize('Current STABLE manifest', stableManifest);
  summarize('Incoming CANARY manifest', canaryManifest);

  if (!yes) {
    console.log('\n  [DRY RUN] No changes uploaded.');
    if (stableManifest) {
      console.log(`  → 覆盖前会先把当前 stable (v${stableManifest?.app?.version ?? '?'}) 备份到 back-up/<version>/`);
    } else {
      console.log('  → 当前无 stable manifest（首次发布），无需备份。');
    }
    console.log('  → Run with --yes to promote canary version above to stable.');
    return;
  }

  const client = createOSSClient();

  // 覆盖 stable 前先备份当前 stable；backupStableManifest 失败会抛错中止，下面的覆盖不会执行。
  if (stableManifest && stableText) {
    await backupStableManifest(client, stableText, stableManifest);
  } else {
    console.log('\n==> 当前无 stable manifest（首次发布），跳过备份。');
  }

  console.log(`\n==> Uploading canary manifest as stable...`);
  const tmpPath = path.join(os.tmpdir(), `manifest-${PLATFORM_KEY}-promote-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, text);

  try {
    const ossKey = `${OSS_PREFIX}/manifest-${PLATFORM_KEY}.json`;
    console.log(`    ${tmpPath} → ${ossKey}`);
    await client.put(ossKey, tmpPath, {
      headers: { 'Cache-Control': 'no-cache' },
    });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }

  console.log('\n=== Promote complete ===');
  console.log(`Stable manifest:  ${CDN_BASE}/manifest-${PLATFORM_KEY}.json`);
  console.log(`App version now:  ${canaryManifest.app.version}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
