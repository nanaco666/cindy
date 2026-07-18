#!/usr/bin/env node
// =============================================================================
// release-ios-check.mjs —— 自建线冷/热更只读预判(不依赖 EAS、无凭证)
//
// 本地用 expo-updates 算 runtimeVersion(与出包/客户端同源),再与 OSS 上
// mobile-ota/ios/release.json 记录的"上次冷更装机包 runtimeVersion"比对:
//   - 相等         → OTA_OK           (只改了 JS/TS,发热更即可)
//   - 不等         → COLD_BUILD_REQUIRED(动了原生输入,必须冷更出整包)
//   - 读不到基线   → BASELINE_UNKNOWN  (首发 / release.json 尚未上传)
//
// 只读:只算本地指纹 + GET 公开 CDN 上的 release.json,不写任何东西、不碰 EAS。
// 真实更新地址来自 endpoint.json,不参与 build/fingerprint。
// =============================================================================

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, decideReleaseMode, resolveDesktopVersion } from './release-lib.mjs';
import { CDN_BASE, refreshOssConfig } from '../../../scripts/shared/oss.mjs';
import { productionMobileEnv } from '../../../scripts/shared/production-endpoints.mjs';
import { formatSelfHostReleaseCommand, resolveSelfHostRegion, regionEnvOverrides } from './lib/self-host-region.mjs';

// NOTE: 不在模块顶层 refreshOssConfig / 派生 RELEASE_RECORD_CDN —— CDN 基址由 --region 决定,
// 在 main() resolve region、覆盖 XDT_OSS_* 后 refreshOssConfig() 时赋值。
const MOBILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
let RELEASE_RECORD_CDN;   // `${CDN_BASE}/mobile-ota/ios/release.json`

function selfhostEnv(region) {
  const env = {
    ...process.env,
    ...productionMobileEnv({ authRegion: region.authRegion }),
    EXPO_PUBLIC_XDT_OTA_SELFHOST: '1',
  };
  // 真实更新地址来自 endpoint.json,不参与 build/fingerprint;清掉残留避免污染指纹。
  delete env.EXPO_PUBLIC_XDT_OTA_URL;
  return env;
}

function computeRuntimeVersion(env) {
  console.error('→ 本地算 runtimeVersion(expo-updates fingerprint,self-host env,约 30-60s)…');
  const out = execFileSync(NPX, ['--yes', 'expo-updates', 'fingerprint:generate', '--platform', 'ios'], {
    cwd: MOBILE_DIR, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const rtv = JSON.parse(out)?.hash;
  if (!rtv) throw new Error('fingerprint:generate 未返回 hash');
  return rtv;
}

async function fetchBaselineRecord() {
  try {
    // 可变指针 release.json:加 ?t= cache-bust,否则刚发完冷更立刻 check 会读到 CDN 边缘缓存的旧记录、
    // 误判 OTA_OK 跳过必要整包更新(与 lib/ios-local fetchBaselineBuildNumber、OTA fetchColdBaselineRuntime 一致)。
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

function nextStepFor(mode, region) {
  if (mode === 'OTA_OK') {
    return ['→ 只改了 JS/TS,指纹未变:发热更即可', `   ${formatSelfHostReleaseCommand('ios', 'ota', region, { execute: true })}`];
  }
  if (mode === 'COLD_BUILD_REQUIRED') {
    return ['→ 原生输入变化,指纹已变:必须冷更出整包', `   ${formatSelfHostReleaseCommand('ios', 'local', region, { execute: true })}`];
  }
  return ['→ 线上无基线(首发或 release.json 未上传):按首次冷更处理', `   ${formatSelfHostReleaseCommand('ios', 'local', region, { execute: true })}`];
}

async function main() {
  const args = parseArgs(process.argv.slice(2)); // 预留位:后续可加 --json 等
  // --region 必填(cn|global):选出预判对应的地区(OSS release.json 基线 + 指纹身份)。
  const region = resolveSelfHostRegion(args);
  Object.assign(process.env, regionEnvOverrides(region));
  refreshOssConfig();
  RELEASE_RECORD_CDN = `${CDN_BASE}/mobile-ota/ios/release.json`;

  const env = selfhostEnv(region);
  const local = computeRuntimeVersion(env);
  const baseline = await fetchBaselineRecord();
  const mode = decideReleaseMode(local, baseline?.runtimeVersion ?? null);
  // 仅信息展示:出包时注入设置页「桌面版」二级版本号的取值(不影响冷/热更判定)。
  const desktopVersion = await resolveDesktopVersion({
    explicit: typeof args.desktopVersion === 'string' ? args.desktopVersion : process.env.EXPO_PUBLIC_DESKTOP_VERSION,
    cdnBase: CDN_BASE,
  });

  const baseLabel = baseline?.runtimeVersion
    ? `${baseline.runtimeVersion}${baseline.version ? ` [v${baseline.version} build ${baseline.buildNumber}]` : ''}`
    : '(无 / 首发)';

  console.log('');
  console.log(`target: mobile 自建线(ios, region=${region.authRegion}, ${region.iosBundleId})`);
  console.log(`local runtime : ${local}`);
  console.log(`baseline      : ${baseLabel}   ← 线上冷更 release.json`);
  console.log(`desktop ver   : ${desktopVersion || '(未解析到,设置页将不显示该行)'}   ← 设置页「桌面版」二级版本号`);
  console.log(`mode          : ${mode}`);
  console.log('');
  for (const line of nextStepFor(mode, region)) console.log(line);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
