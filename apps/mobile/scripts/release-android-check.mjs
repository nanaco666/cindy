#!/usr/bin/env node
// =============================================================================
// release-android-check.mjs —— 自建线冷/热更只读预判(Android,不依赖 EAS、无凭证)
//
// 本地用 expo-updates 算 android runtimeVersion(与出包/客户端同源),再与 OSS 上
// mobile-ota/android/release.json 记录的"上次冷更装机包 runtimeVersion"比对:
//   - 相等         → OTA_OK           (只改了 JS/TS,发热更即可)
//   - 不等         → COLD_BUILD_REQUIRED(动了原生输入,必须冷更出整包)
//   - 读不到基线   → BASELINE_UNKNOWN  (首发 / release.json 尚未上传)
//
// 只读:只算本地指纹 + GET 公开 CDN 上的 release.json,不写、不碰 EAS/NPKG/keystore。
// 需要 EXPO_PUBLIC_XDT_OTA_URL(须与出包时一致,否则指纹不同源,判定失真)。versionCode 来自
// committed android-version.json,经 env 注入,保证与 local/ota 计算的指纹同源。
// =============================================================================

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, decideReleaseMode, resolveDesktopVersion } from './release-lib.mjs';
import { readAndroidVersionCode } from './lib/android-local.mjs';
import { CDN_BASE, refreshOssConfig } from '../../../scripts/shared/oss.mjs';
import { productionMobileEnv } from '../../../scripts/shared/production-endpoints.mjs';

refreshOssConfig();

const MOBILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const RELEASE_RECORD_CDN = `${CDN_BASE}/mobile-ota/android/release.json`;

function selfhostEnv(versionCode) {
  const otaUrl = process.env.EXPO_PUBLIC_XDT_OTA_URL?.trim();
  if (!otaUrl) throw new Error('release-android-check 需要 EXPO_PUBLIC_XDT_OTA_URL(须与出包时一致,才能算出同源指纹)');
  return {
    ...process.env,
    ...productionMobileEnv(),
    EXPO_PUBLIC_XDT_OTA_SELFHOST: '1',
    EXPO_PUBLIC_XDT_OTA_URL: otaUrl,
    XDT_ANDROID_VERSION_CODE: String(versionCode),
  };
}

function computeRuntimeVersion(env) {
  console.error('→ 本地算 runtimeVersion(expo-updates fingerprint,--platform android,self-host env,约 30-60s)…');
  const out = execFileSync(NPX, ['--yes', 'expo-updates', 'fingerprint:generate', '--platform', 'android'], {
    cwd: MOBILE_DIR, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const rtv = JSON.parse(out)?.hash;
  if (!rtv) throw new Error('fingerprint:generate 未返回 hash');
  return rtv;
}

async function fetchBaselineRecord() {
  try {
    // 可变指针 release.json:加 ?t= cache-bust,否则刚发完冷更立刻 check 会读到 CDN 边缘缓存的旧记录。
    const bustedUrl = `${RELEASE_RECORD_CDN}${RELEASE_RECORD_CDN.includes('?') ? '&' : '?'}t=${Date.now()}`;
    const res = await fetch(bustedUrl, { headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
    if (!res.ok) return null; // 404 = 尚无冷更记录(首发)
    const rec = await res.json();
    return {
      runtimeVersion: rec?.runtimeVersion ?? null,
      version: rec?.version ?? null,
      buildNumber: rec?.buildNumber ?? null,
    };
  } catch {
    return null; // 网络/解析失败按"无基线"处理,不阻断
  }
}

function nextStepFor(mode) {
  if (mode === 'OTA_OK') {
    return ['→ 只改了 JS/TS,指纹未变:发热更即可', '   pnpm mobile:release:android:ota -- --execute'];
  }
  if (mode === 'COLD_BUILD_REQUIRED') {
    return ['→ 原生输入变化,指纹已变:必须冷更出整包', '   pnpm mobile:release:android:local -- --execute'];
  }
  return ['→ 线上无基线(首发或 release.json 未上传):按首次冷更处理', '   pnpm mobile:release:android:local -- --execute'];
}

async function main() {
  const args = parseArgs(process.argv.slice(2)); // 预留位:后续可加 --json 等
  const versionCode = readAndroidVersionCode(MOBILE_DIR);
  const env = selfhostEnv(versionCode);
  const local = computeRuntimeVersion(env);
  const baseline = await fetchBaselineRecord();
  const mode = decideReleaseMode(local, baseline?.runtimeVersion ?? null);
  // 仅信息展示:出包时注入设置页「桌面版」二级版本号的取值(不影响冷/热更判定)。
  const desktopVersion = await resolveDesktopVersion({
    explicit: typeof args.desktopVersion === 'string' ? args.desktopVersion : process.env.EXPO_PUBLIC_DESKTOP_VERSION,
    cdnBase: CDN_BASE,
  });

  const baseLabel = baseline?.runtimeVersion
    ? `${baseline.runtimeVersion}${baseline.version ? ` [v${baseline.version} versionCode ${baseline.buildNumber}]` : ''}`
    : '(无 / 首发)';

  console.log('');
  console.log('target: mobile 自建线(android, com.xd.cindycn)');
  console.log(`local runtime : ${local}`);
  console.log(`baseline      : ${baseLabel}   ← 线上冷更 release.json`);
  console.log(`desktop ver   : ${desktopVersion || '(未解析到,设置页将不显示该行)'}   ← 设置页「桌面版」二级版本号`);
  console.log(`mode          : ${mode}`);
  console.log('');
  for (const line of nextStepFor(mode)) console.log(line);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
