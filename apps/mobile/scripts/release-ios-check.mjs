#!/usr/bin/env node
// =============================================================================
// release-ios-check.mjs —— 自建线冷/热更只读预判(不依赖 EAS、无凭证)
//
// 本地用 expo-updates 算 runtimeVersion(与出包/客户端同源),再与 OSS 上
// mobile-ota/ios/canary-release.json(无 canary 时回退 stable release.json)记录的"上次冷更装机包 runtimeVersion"比对:
//   - 相等         → OTA_OK           (只改了 JS/TS,发热更即可)
//   - 不等         → COLD_BUILD_REQUIRED(动了原生输入,必须冷更出整包)
//   - 读不到基线   → BASELINE_UNKNOWN  (首发 / canary、stable 指针均未上传)
//
// 只读:只算本地指纹 + GET 公开 CDN 上的 canary/stable release 指针,不写任何东西、不碰 EAS。
// 真实更新地址来自 endpoint.json,不参与 build/fingerprint。
// =============================================================================

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, decideReleaseMode, resolveDesktopVersion } from './release-lib.mjs';
import { CDN_BASE, refreshOssConfig } from '../../../scripts/shared/oss.mjs';
import { mobileClientBuildEnv } from '../../../scripts/shared/client-endpoint-build-env.mjs';
import { formatSelfHostReleaseCommand, resolveSelfHostRegion, regionEnvOverrides, stripSelfHostRegionEnv } from './lib/self-host-region.mjs';
import { buildReleasePointerLocation, fetchCanaryReleaseBaseline } from './lib/release-pointers.mjs';

// NOTE: 不在模块顶层 refreshOssConfig / 派生 RELEASE_RECORD_CDN —— CDN 基址由 --region 决定,
// 在 main() resolve region、覆盖 XDT_OSS_* 后 refreshOssConfig() 时赋值。
const MOBILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
let RELEASE_RECORD_CDN;
let STABLE_RELEASE_RECORD_CDN;

function selfhostEnv(region) {
  const env = {
    ...process.env,
    ...mobileClientBuildEnv({ authRegion: region.authRegion }),
    EXPO_PUBLIC_XDT_OTA_SELFHOST: '1',
  };
  // 真实更新地址来自 endpoint.json,不参与 build/fingerprint;清掉残留避免污染指纹。
  delete env.EXPO_PUBLIC_XDT_OTA_URL;
  return stripSelfHostRegionEnv(env);
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
  return fetchCanaryReleaseBaseline({
    canaryUrl: RELEASE_RECORD_CDN,
    stableUrl: STABLE_RELEASE_RECORD_CDN,
  });
}

function nextStepFor(mode, region) {
  if (mode === 'OTA_OK') {
    return ['→ 只改了 JS/TS,指纹未变:发热更即可', `   ${formatSelfHostReleaseCommand('ios', 'ota', region, { execute: true })}`];
  }
  if (mode === 'COLD_BUILD_REQUIRED') {
    return ['→ 原生输入变化,指纹已变:必须冷更出整包', `   ${formatSelfHostReleaseCommand('ios', 'local', region, { execute: true })}`];
  }
  return ['→ 线上无基线(首发或 canary/stable release 指针未上传):按首次冷更处理', `   ${formatSelfHostReleaseCommand('ios', 'local', region, { execute: true })}`];
}

async function main() {
  const args = parseArgs(process.argv.slice(2)); // 预留位:后续可加 --json 等
  // --region 必填(cn|global):选出预判对应的地区(OSS release.json 基线 + 指纹身份)。
  const region = resolveSelfHostRegion(args);
  Object.assign(process.env, regionEnvOverrides(region));
  refreshOssConfig();
  RELEASE_RECORD_CDN = buildReleasePointerLocation({
    cdnBase: CDN_BASE, ossPrefix: '', platform: 'ios', channel: 'canary',
  }).url;
  STABLE_RELEASE_RECORD_CDN = buildReleasePointerLocation({
    cdnBase: CDN_BASE, ossPrefix: '', platform: 'ios', channel: 'stable',
  }).url;

  const env = selfhostEnv(region);
  const local = computeRuntimeVersion(env);
  const baseline = await fetchBaselineRecord();
  const mode = decideReleaseMode(local, baseline.record?.runtimeVersion ?? null);
  // 仅信息展示:出包时注入设置页「桌面版」二级版本号的取值(不影响冷/热更判定)。
  const desktopVersion = await resolveDesktopVersion({
    explicit: typeof args.desktopVersion === 'string' ? args.desktopVersion : process.env.EXPO_PUBLIC_DESKTOP_VERSION,
    cdnBase: CDN_BASE,
  });

  const baseLabel = baseline.record?.runtimeVersion
    ? `${baseline.record.runtimeVersion}${baseline.record.version ? ` [v${baseline.record.version} build ${baseline.record.buildNumber}]` : ''}`
    : '(无 / 首发)';

  console.log('');
  console.log(`target: mobile 自建线(ios, region=${region.authRegion}, ${region.iosBundleId})`);
  console.log(`local runtime : ${local}`);
  console.log(`baseline      : ${baseLabel}   ← ${baseline.source === 'none' ? 'canary/stable 均无记录' : `${baseline.source} 冷更指针`}`);
  console.log(`desktop ver   : ${desktopVersion || '(未解析到,设置页将不显示该行)'}   ← 设置页「桌面版」二级版本号`);
  console.log(`mode          : ${mode}`);
  console.log('');
  for (const line of nextStepFor(mode, region)) console.log(line);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
