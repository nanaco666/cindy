#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveReleaseCdnBaseUrl } from '../../../scripts/shared/release-env.mjs';

export const MOBILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WORKTREE_ROOT = resolve(MOBILE_DIR, '../..');
export const EAS_CLI_SPEC = 'eas-cli@20.4.0';
export const NPX_BIN = process.platform === 'win32' ? 'npx.cmd' : 'npx';
export const EAS_LOGIN_ERROR_MESSAGE = '未登录 EAS,请先运行: npx eas-cli login';
export const RELEASE_ENV_EXEC_COMMANDS = Object.freeze({
  check: 'apps/mobile/scripts/release-check.mjs',
  prod: 'apps/mobile/scripts/release-prod.mjs',
});

// 2026-07 端点清单重构后收缩:业务端点不再构建期烘焙(运行期由启动闸门从
// `<manifest base>/endpoint.json` 回填),发版闸门只校验构建身份 + 清单自举基址。
export const PUBLIC_ENV_KEYS = [
  'EXPO_PUBLIC_CINDY_AUTH_REGION',
  'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL',
  'EXPO_PUBLIC_TAPTAP_CLIENT_ID',
  'EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN',
];

// 自建线的 TapDB / Google 公开配置来自 self-host-regions.json → Expo extra,不再要求
// EXPO_PUBLIC_* 注入。这里只校验自举启动所需的两个构建常量。
export const SELF_HOST_PUBLIC_ENV_KEYS = [
  'EXPO_PUBLIC_CINDY_AUTH_REGION',
  'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL',
];

export const EXTERNAL_PUBLIC_ENV_KEYS = [
  'EXPO_PUBLIC_CINDY_GOOGLE_WEB_CLIENT_ID',
  'EXPO_PUBLIC_CINDY_GOOGLE_IOS_CLIENT_ID',
  'EXPO_PUBLIC_CINDY_GOOGLE_IOS_URL_SCHEME',
  'EXPO_PUBLIC_CINDY_WECHAT_APP_ID',
  'EXPO_PUBLIC_CINDY_WECHAT_UNIVERSAL_LINK',
  'EXPO_PUBLIC_TAPTAP_CLIENT_ID',
  'EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN',
  'EXPO_PUBLIC_TAPDB_CHANNEL',
  'EXPO_PUBLIC_TAPDB_REGION',
];

/**
 * 已知烘焙键的用途注释(打印在每行值后面,发版者不用翻代码就知道每个键干嘛的)。
 * 新增烘焙键时同步补一条;不在表里的键会打印「未登记」提示,提醒确认它该不该进包。
 */
const BAKED_ENV_KEY_NOTES = {
  EXPO_PUBLIC_CINDY_AUTH_REGION: '构建区域 cn/global:决定登录线、appScheme 与端点清单基址',
  EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL:
    '端点清单自举基址:启动第一步拉 <此地址>/endpoint.json 回填业务端点(唯一不可远程覆盖的烘焙远程 URL)',
  EXPO_PUBLIC_XDT_OTA_SELFHOST:
    '自建分发变体标志:=1;真实热更/整包地址均来自 endpoint.json 的 mobileUpdateBaseUrl',
  EXPO_PUBLIC_DESKTOP_VERSION: '配对的桌面产品线版本(二级版本号,设置页展示;空则该行不显示)',
  EXPO_PUBLIC_TAPTAP_CLIENT_ID: 'TapDB 统计 client id(公开键,随包分发)',
  EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN: 'TapDB 统计 client token(公开键,随包分发)',
  EXPO_PUBLIC_TAPDB_CHANNEL: 'TapDB 上报渠道标识',
  EXPO_PUBLIC_TAPDB_REGION: 'TapDB 上报区域',
  EXPO_PUBLIC_CINDY_GOOGLE_WEB_CLIENT_ID: 'Google 登录 Web client id',
  EXPO_PUBLIC_CINDY_GOOGLE_IOS_CLIENT_ID: 'Google 登录 iOS client id',
  EXPO_PUBLIC_CINDY_GOOGLE_IOS_URL_SCHEME: 'Google 登录 iOS 回跳 URL scheme',
  EXPO_PUBLIC_CINDY_WECHAT_APP_ID: '微信登录 AppID',
  EXPO_PUBLIC_CINDY_WECHAT_UNIVERSAL_LINK: '微信登录 Universal Link',
  XDT_ANDROID_VERSION_CODE: 'Android 原生 versionCode(app.config.js 写入,冷更单调号)',
};

/**
 * 把「实际会内联进 JS bundle 的注入内容」整理成可打印行(自建冷更脚本的
 * dry-run / execute 计划输出共用)。口径:
 *  - metro 只内联 `EXPO_PUBLIC_*` 前缀的 env,构建 env 里全部该前缀键都列出
 *    (值本身随包公开分发,打印无泄密面);值为空串标注 `(空)` 便于发现漏配;
 *  - 每行尾部带 BAKED_ENV_KEY_NOTES 的用途注释;未登记键打「未登记」提醒;
 *  - `extraKeys` 列非 EXPO_PUBLIC 但同样影响包体的构建键(如 android 的
 *    XDT_ANDROID_VERSION_CODE 经 app.config.js 写进原生 versionCode);
 *  - 签名口令 / OSS AK 等其余 env 只驱动构建过程、不进包,不在此列。
 * @param {Record<string, string | undefined>} env 最终传给 prebuild/构建的 env
 * @param {{ extraKeys?: string[] }} [options]
 * @returns {string[]} 打印行(含节标题与说明,直接逐行 console.log)
 */
export function formatBakedEnvLines(env, { extraKeys = [] } = {}) {
  const keys = [
    ...Object.keys(env).filter((key) => key.startsWith('EXPO_PUBLIC_')),
    ...extraKeys.filter((key) => env[key] !== undefined),
  ].sort();
  const width = Math.max(0, ...keys.map((key) => key.length));
  const lines = ['baked env(将内联进 JS bundle 的全部注入内容,EXPO_PUBLIC_* 前缀):'];
  for (const key of keys) {
    const value = String(env[key] ?? '').trim();
    const note = BAKED_ENV_KEY_NOTES[key] ?? '⚠ 未登记键:确认它该不该进包,并补 BAKED_ENV_KEY_NOTES';
    lines.push(`  ${key.padEnd(width)} = ${value || '(空)'}  # ${note}`);
  }
  lines.push(
    '  (运行期业务端点来自 CDN endpoint.json + 包内正本兜底,不在烘焙列;签名/OSS 凭据只驱动构建、不进包)',
  );
  return lines;
}

// 桌面产品线 CDN manifest 基址 —— 与桌面发版脚本(apps/desktop/scripts/release-macos.mjs
// 的 CDN_BASE)读同一 Source of Truth。桌面版本(app.version)是唯一真实来源。
/**
 * 解析本次自建线打包要显示的「桌面包版本」(二级版本号,注入 EXPO_PUBLIC_DESKTOP_VERSION)。
 * 取值优先级:
 *   1. 显式值(CLI `--desktop-version` / env `EXPO_PUBLIC_DESKTOP_VERSION`)——手动指定配对 / 离线发版;
 *   2. 桌面 CDN manifest 的 `app.version`(当前线上桌面版本);
 *   3. 网络 / 解析失败 → `''`(设置页据此不渲染该行,不显示误导性空值)。
 * 仅自建线调用;EAS prod 不注入该值。fetch 走全局 fetch(Node 18+),
 * baseUrl / platformKey 可注入便于单测(参照 src/update/fetchLatestRelease.ts 风格)。
 * @param {{ explicit?: string; cdnBase?: string; platformKey?: string; timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function resolveDesktopVersion(opts = {}) {
  const explicit = typeof opts.explicit === 'string' ? opts.explicit.trim() : '';
  if (explicit) return explicit;
  const cdnBase = (opts.cdnBase ?? resolveReleaseCdnBaseUrl()).replace(/\/+$/, '');
  const platformKey = opts.platformKey ?? 'darwin-arm64';
  const timeoutMs = opts.timeoutMs ?? 8000;
  const url = `${cdnBase}/manifest-${platformKey}.json?t=${Date.now()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return '';
    const manifest = await res.json();
    const version = manifest?.app?.version;
    return typeof version === 'string' ? version.trim() : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析 CLI 参数:支持 `--key=value` / `--key value` / `--flag`;非 `--` token 进 `_`;
 * standalone `--` 作分隔符跳过。
 * @param {string[]} argv
 * @returns {{ _: string[]; [key: string]: string | boolean | string[] }}
 */
export function parseArgs(argv) {
  /** @type {{ _: string[]; [key: string]: string | boolean | string[] }} */
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // standalone `--` 是约定分隔符(pnpm run 会把它一起转发进来),跳过,
    // 否则它会被当成空 key 并吞掉下一个位置参数(如 `some-cmd -- alice` 里的 alice)。
    if (arg === '--') continue;
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (inlineValue != null) {
      args[key] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

export function loadMobileConfig(mobileDir = MOBILE_DIR) {
  return {
    mobileDir,
    appJsonPath: resolve(mobileDir, 'app.json'),
    easJsonPath: resolve(mobileDir, 'eas.json'),
    appJson: readJson(resolve(mobileDir, 'app.json')),
    easJson: readJson(resolve(mobileDir, 'eas.json')),
  };
}

export function saveEasJson(easJson, mobileDir = MOBILE_DIR) {
  writeFileSync(resolve(mobileDir, 'eas.json'), `${JSON.stringify(easJson, null, 2)}\n`);
}

export function resolveBuildProfile(easJson, profileName, seen = new Set()) {
  const profile = easJson?.build?.[profileName];
  if (!profile) throw new Error(`Missing EAS build profile: ${profileName}`);
  if (seen.has(profileName)) throw new Error(`Circular EAS profile extends: ${[...seen, profileName].join(' -> ')}`);
  if (!profile.extends) return clone(profile);
  const parent = resolveBuildProfile(easJson, profile.extends, new Set([...seen, profileName]));
  return deepMerge(parent, withoutKey(profile, 'extends'));
}

export function resolveTarget(config, options = {}) {
  const kind = options.kind ?? options.target ?? 'production';
  const region = resolveAuthRegion(options.region);
  if (kind === 'staging') {
    const profile =
      options.profile ?? (region === 'global' ? 'adhoc-global' : 'adhoc');
    const resolved = resolveBuildProfile(config.easJson, profile);
    return {
      kind: 'staging',
      region,
      profile,
      channel: resolved.channel ?? 'staging',
      branch: options.branch ?? resolved.channel ?? 'staging',
      environment: options.environment ?? 'preview',
      variant: 'production',
      publicEnv: clone(resolved.env ?? {}),
    };
  }
  if (kind === 'production') {
    const profile =
      options.profile ??
      (region === 'global' ? 'production-global' : 'production');
    const resolved = resolveBuildProfile(config.easJson, profile);
    return {
      kind: 'production',
      region,
      profile,
      channel: resolved.channel ?? 'production',
      branch: options.branch ?? resolved.channel ?? 'production',
      environment: options.environment ?? 'production',
      variant: 'production',
      publicEnv: clone(resolved.env ?? {}),
    };
  }
  throw new Error(`Unknown mobile release target: ${kind}`);
}

export function assertTargetProfile(config, target) {
  const profile = resolveBuildProfile(config.easJson, target.profile);
  if (profile.channel !== target.channel) {
    throw new Error(`Profile ${target.profile} channel mismatch: expected ${target.channel}, got ${profile.channel ?? '(missing)'}`);
  }
  if (profile.env?.EXPO_PUBLIC_CINDY_AUTH_REGION !== target.region) {
    throw new Error(
      `Profile ${target.profile} must set EXPO_PUBLIC_CINDY_AUTH_REGION=${target.region}`,
    );
  }
  return profile;
}

export function resolveAuthRegion(value = 'cn') {
  const region = String(value ?? 'cn').trim() || 'cn';
  if (region !== 'cn' && region !== 'global')
    throw new Error('--region must be cn or global');
  return region;
}

export function assertEasLoggedIn({
  mobileDir = MOBILE_DIR,
  check = () => runEasWhoami({ mobileDir }),
} = {}) {
  try {
    const user = check();
    if (!String(user ?? '').trim()) throw new Error('empty EAS whoami output');
    return true;
  } catch {
    throw new Error(EAS_LOGIN_ERROR_MESSAGE);
  }
}

// 用 eas-cli 的权威指纹(与 eas build / eas update 实际烧进包的 runtimeVersion 一致)。
// 不能用本地 @expo/fingerprint 的 createFingerprintAsync:实测它与 eas-cli 的版本/环境不同会算出
// 不同 hash(本地 vs eas-cli),导致冷热判定误报 COLD_BUILD_REQUIRED。`--build-profile` 会自动套用
// 该 profile 在 eas.json 里的 env,并加载 fingerprint.config.cjs。
// 代价:要联网 + 调 eas-cli(~30-60s),比本地慢,但这是 release 脚本、非热路径,换的是正确性。
export async function computeFingerprint({ mobileDir = MOBILE_DIR, target, platform = 'ios' } = {}) {
  const profile = target?.profile;
  if (!profile) throw new Error('computeFingerprint requires target.profile');
  const output = execNpxSync([
    '--yes',
    EAS_CLI_SPEC,
    'fingerprint:generate',
    '--platform',
    platform,
    '--build-profile',
    profile,
    '--json',
    '--non-interactive',
    // --json 会带上全部 fingerprint sources,输出可能 > 1MB,必须调大 maxBuffer 否则 ENOBUFS。
  ], {
    cwd: mobileDir,
    encoding: 'utf8',
    env: buildEasCommandEnv(target.publicEnv),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return parseFingerprintOutput(output);
}

export function targetPlatformsForRelease(target, appJson) {
  if (target.kind === 'production') return ['ios'];
  return appJson?.expo?.android?.versionCode == null ? ['ios'] : ['ios', 'android'];
}

export async function computeTargetFingerprints({ mobileDir = MOBILE_DIR, target, platforms = targetPlatformsForRelease(target) } = {}) {
  console.error('→ 正在通过 EAS 计算权威指纹(约 30-60s)…');
  const byPlatform = {};
  for (const platform of platforms) {
    byPlatform[platform] = await computeFingerprint({ mobileDir, target, platform });
  }
  return {
    byPlatform,
    hash: platforms.length === 1 ? byPlatform[platforms[0]]?.hash ?? null : null,
  };
}

export function parseFingerprintOutput(output) {
  const parsed = JSON.parse(output);
  const hash = parsed.hash ?? parsed.fingerprint?.hash;
  if (!hash || typeof hash !== 'string') {
    throw new Error('eas fingerprint:generate did not return a hash');
  }
  return { hash, sources: parsed.sources };
}

export function assertPublicEnv(env, { variant = 'production', requiredKeys = PUBLIC_ENV_KEYS } = {}) {
  const missing = [];
  for (const key of requiredKeys) {
    if (!String(env[key] ?? '').trim()) missing.push(key);
  }
  if (variant === 'production' && String(env.EXPO_PUBLIC_APP_VARIANT ?? '').trim() === 'beta') {
    throw new Error('Production OTA environment must not set EXPO_PUBLIC_APP_VARIANT=beta');
  }
  if (missing.length) {
    throw new Error(`Missing required mobile OTA environment: ${missing.join(', ')}`);
  }
  return true;
}

export function resolveCommandPublicEnv(publicEnv = {}, baseEnv = process.env, externalKeys = EXTERNAL_PUBLIC_ENV_KEYS) {
  const externalEnv = {};
  for (const key of externalKeys) {
    const value = baseEnv[key];
    if (String(value ?? '').trim()) externalEnv[key] = value;
  }
  return { ...externalEnv, ...(publicEnv ?? {}) };
}

export function resolveReleaseEnvExecEnvironment(command, args = {}) {
  if (command === 'prod') {
    const targets = String(args.targets ?? 'production,staging').split(',').map((item) => item.trim()).filter(Boolean);
    return targets.length > 0 && targets.every((target) => target === 'staging') ? 'preview' : 'production';
  }
  if (command !== 'check') throw new Error(`Unknown mobile release command: ${command}`);

  const target = String(args.target ?? '').trim();
  if (target === 'staging') return 'preview';
  return 'production';
}

export function resolveReleaseEnvExecRuns(command, forwardedArgs = []) {
  if (command !== 'prod') {
    return [{
      environment: resolveReleaseEnvExecEnvironment(command, parseArgs(forwardedArgs)),
      forwardedArgs,
    }];
  }

  const args = parseArgs(forwardedArgs);
  const targets = String(args.targets ?? 'production,staging').split(',').map((item) => item.trim()).filter(Boolean);
  const uniqueTargets = [...new Set(targets)];
  if (uniqueTargets.length <= 1) {
    return [{
      environment: resolveReleaseEnvExecEnvironment(command, args),
      forwardedArgs,
    }];
  }

  return uniqueTargets.map((target) => ({
    environment: target === 'staging' ? 'preview' : 'production',
    forwardedArgs: replaceTargetsArg(forwardedArgs, target),
  }));
}

export function resolveReleaseEnvExecRunPlan(command, forwardedArgs = []) {
  const runs = resolveReleaseEnvExecRuns(command, forwardedArgs);
  if (command !== 'prod' || runs.length <= 1 || !hasExecuteFlag(forwardedArgs)) {
    return runs.map((run) => ({ ...run, phase: 'run' }));
  }

  return [
    ...runs.map((run) => ({
      ...run,
      forwardedArgs: stripExecuteFlag(run.forwardedArgs),
      phase: 'preflight',
    })),
    ...runs.map((run) => ({ ...run, phase: 'run' })),
  ];
}

export function buildReleaseEnvExecShellCommand(command, forwardedArgs = [], platform = process.platform) {
  const script = RELEASE_ENV_EXEC_COMMANDS[command];
  if (!script) throw new Error(`Unknown mobile release command: ${command}`);
  if (platform === 'win32') {
    return `cd /d ..\\.. && ${buildWindowsCmdCommand('node', [script, ...forwardedArgs])}`;
  }
  const args = forwardedArgs.map((arg) => shellQuote(String(arg))).join(' ');
  return `cd ../.. && node ${shellQuote(script)}${args ? ` ${args}` : ''}`;
}

export function buildReleaseEnvExecCommand(environment, shellCommand) {
  return commandSpec(NPX_BIN, [
    '--yes',
    EAS_CLI_SPEC,
    'env:exec',
    environment,
    shellCommand,
    '--non-interactive',
  ]);
}

export function readLatestBuildRuntime(target, { cwd = MOBILE_DIR } = {}) {
  const output = execNpxSync(buildLatestBuildRuntimeArgs(target), {
    cwd,
    encoding: 'utf8',
    env: buildEasCommandEnv(target.publicEnv),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const builds = JSON.parse(output);
  return summarizeLatestBuildRuntime(Array.isArray(builds) ? builds : [], target);
}

export function buildLatestBuildRuntimeArgs(target) {
  return [
    '--yes',
    EAS_CLI_SPEC,
    'build:list',
    '--platform',
    'all',
    '--status',
    'finished',
    '--channel',
    target.channel,
    '--build-profile',
    target.profile,
    '--limit',
    '10',
    '--json',
    '--non-interactive',
  ];
}

export function summarizeLatestBuildRuntime(builds, target = {}) {
  const byPlatform = {};
  for (const build of builds) {
    const platform = String(build.platform ?? build.platformType ?? '').toLowerCase();
    const runtimeVersion = build.runtimeVersion ?? build.runtime?.version ?? build.fingerprintHash ?? null;
    const appBuildVersion = build.appBuildVersion ?? build.buildVersion ?? build.versionCode ?? null;
    if (!platform || byPlatform[platform]) continue;
    byPlatform[platform] = {
      id: build.id ?? null,
      platform,
      runtimeVersion,
      appBuildVersion: appBuildVersion == null ? null : String(appBuildVersion),
      gitCommitHash: build.gitCommitHash ?? null,
      channel: build.channel ?? target.channel ?? null,
    };
  }
  const runtimes = Object.values(byPlatform).map((item) => item.runtimeVersion).filter(Boolean);
  const uniqueRuntimes = [...new Set(runtimes)];
  return {
    byPlatform,
    runtimeVersion: uniqueRuntimes.length === 1 ? uniqueRuntimes[0] : null,
    runtimeMismatch: uniqueRuntimes.length > 1,
  };
}

export function decideReleaseMode(localRuntime, latestRuntime) {
  if (!latestRuntime) return 'BASELINE_UNKNOWN';
  return localRuntime === latestRuntime ? 'OTA_OK' : 'COLD_BUILD_REQUIRED';
}

export function decideTargetReleaseMode(localFingerprints, latest, platforms) {
  for (const platform of platforms) {
    if (!latest?.byPlatform?.[platform]?.runtimeVersion) return 'BASELINE_UNKNOWN';
  }
  for (const platform of platforms) {
    if (localFingerprints?.byPlatform?.[platform]?.hash !== latest.byPlatform[platform].runtimeVersion) {
      return 'COLD_BUILD_REQUIRED';
    }
  }
  return 'OTA_OK';
}

export function formatLocalRuntime(localFingerprints, platforms) {
  if (platforms.length === 1) return localFingerprints.byPlatform[platforms[0]]?.hash ?? null;
  return platforms.map((platform) => `${platform}=${localFingerprints.byPlatform[platform]?.hash ?? 'unknown'}`).join(', ');
}

export function formatLatestRuntime(latest, platforms) {
  if (platforms.length === 1) return latest?.byPlatform?.[platforms[0]]?.runtimeVersion ?? null;
  return platforms.map((platform) => `${platform}=${latest?.byPlatform?.[platform]?.runtimeVersion ?? 'unknown'}`).join(', ');
}

export function easBuildPlatformForReleasePlatforms(platforms) {
  const unique = [...new Set(platforms)];
  if (unique.length === 1) return unique[0];
  if (unique.includes('ios') && unique.includes('android')) return 'all';
  throw new Error(`Unsupported EAS build platform set: ${unique.join(', ')}`);
}

export function assertBuildPlatformWithinReleasePlatforms(platform, releasePlatform) {
  if (!['ios', 'android', 'all'].includes(platform)) {
    throw new Error('--platform must be ios, android, or all');
  }
  if (releasePlatform === 'all') return true;
  if (platform !== releasePlatform) {
    throw new Error(`--platform ${platform} exceeds checked release platform ${releasePlatform}`);
  }
  return true;
}

export function assertReleaseTargetsAllowed(targetNames, allowedTargets, commandName) {
  if (!targetNames.length) throw new Error(`${commandName} requires at least one target`);
  const allowed = new Set(allowedTargets);
  const invalid = targetNames.filter((targetName) => !allowed.has(targetName));
  if (invalid.length) {
    throw new Error(`${commandName} targets must be ${allowedTargets.join(', ')}; got ${invalid.join(', ')}`);
  }
  return true;
}

export function assertVersionMonotonic({ appJson, latestBuilds = {}, platforms = ['ios', 'android'] }) {
  const failures = [];
  if (platforms.includes('ios')) {
    const current = appJson?.expo?.ios?.buildNumber;
    const latest = latestBuilds.ios?.appBuildVersion;
    if (!current) failures.push('ios.buildNumber is missing');
    else if (latest && compareVersionParts(current, latest) <= 0) {
      failures.push(`ios.buildNumber must be greater than latest App Store build (${current} <= ${latest})`);
    }
  }
  if (platforms.includes('android')) {
    const current = appJson?.expo?.android?.versionCode;
    const latest = latestBuilds.android?.appBuildVersion;
    if (current == null) {
      // Android 正式发版走 NPKG 企业包(非 Google Play),pending 飞书 Android 登记。
      // versionCode 被有意识加入前,不要因它缺失而阻断 iOS 发布。
    } else if (latest && Number(current) <= Number(latest)) {
      failures.push(`android.versionCode must be greater than latest Android build (${current} <= ${latest})`);
    }
  }
  if (failures.length) throw new Error(failures.join('; '));
  return true;
}

/**
 * @param {{ target: { kind: string }; latest?: { byPlatform?: Record<string, { runtimeVersion?: string | null }> } | null; allowUnknownBaseline?: boolean; platforms?: string[] }} options
 */
export function assertKnownBaseline({ target, latest, allowUnknownBaseline = false, platforms = ['ios', 'android'] } = {}) {
  const hasRequiredBaselines = platforms.every((platform) => latest?.byPlatform?.[platform]?.runtimeVersion);
  if (hasRequiredBaselines) return true;
  if (allowUnknownBaseline) {
    console.warn(`warning: ${target.kind} has no known latest build baseline; treating this as an explicit first-release override`);
    return true;
  }
  throw new Error(`${target.kind} release requires a known latest build baseline; pass --allow-unknown-baseline only for an intentional first release`);
}

/**
 * @param {{ target: { kind: string }; mode: string; latest?: { byPlatform?: Record<string, unknown> } | null; appJson: unknown; allowUnknownBaseline?: boolean; platforms?: string[] }} options
 */
export function assertColdReleaseAllowed({ target, mode, latest, appJson, allowUnknownBaseline = false, platforms = ['ios', 'android'] } = {}) {
  if (mode === 'OTA_OK') return true;
  assertKnownBaseline({ target, latest, allowUnknownBaseline, platforms });
  assertVersionMonotonic({
    appJson,
    latestBuilds: latest?.byPlatform ?? {},
    platforms,
  });
  return true;
}

/**
 * @param {{ kind: string }} target
 * @param {string} platform
 */
export function assertProductionPlatformAllowed(target, platform) {
  if (target.kind === 'production' && platform !== 'ios') {
    throw new Error('Production release only supports --platform ios while Android production is pending NPKG rollout');
  }
}

/**
 * @param {{ target?: { kind: string; region?: string }; env?: Record<string, string | undefined> }} [options]
 */
export function assertProductionSubmitTarget({
  target,
  env = process.env,
} = {}) {
  if (target?.kind !== 'production') return true;
  const region = resolveAuthRegion(target.region);
  const key =
    region === 'global' ? 'CINDY_GLOBAL_APP_STORE_ID' : 'CINDY_CN_APP_STORE_ID';
  const appStoreId = String(env[key] ?? '').trim();
  if (!/^\d+$/.test(appStoreId)) {
    throw new Error(
      `Production ${region} build requires numeric ${key} in the release environment`,
    );
  }
  return appStoreId;
}

/**
 * @param {{ target: { kind: string }; mode: string; latest?: { byPlatform?: Record<string, { appBuildVersion?: string | null }> } | null }} options
 */
export function shouldAutoSubmitColdBuild({ target, mode, latest } = {}) {
  // CN and Global have separate ASC apps whose numeric IDs live in the release environment.
  // eas.json cannot safely interpolate those IDs into submit profiles, so builds stay fail-closed
  // and submission is an explicit App Store Connect step.
  void target;
  void mode;
  void latest;
  return false;
}

/**
 * @param {unknown} target
 * @param {string} message
 * @param {{ platform: string }} options
 */
export function buildUpdateCommand(target, message, { platform } = {}) {
  if (!platform) throw new Error('buildUpdateCommand requires platform');
  // 统一:OTA 直接注入该 profile 的 EXPO_PUBLIC_* env。
  // 少数不进仓库的客户端公开 env(如 TapTap client token)由 buildEasCommandEnv 从
  // allowlist 外部环境补入,不会出现在 dry-run command spec 里。
  // 同时显式传 target.environment:新版 eas-cli 在 --non-interactive update 下要求该 flag。
  // EAS Environment 只提供外部敏感/明文变量;profile env 仍由本脚本直接注入。
  const environment = target.environment ?? (target.kind === 'production' ? 'production' : 'preview');
  return commandSpec(NPX_BIN, [
    '--yes',
    EAS_CLI_SPEC,
    'update',
    '--branch',
    target.branch,
    '--platform',
    platform,
    '--message',
    message,
    '--environment',
    environment,
    '--non-interactive',
  ], target.publicEnv ?? {});
}

/**
 * @param {unknown} target
 * @param {{ platform: string; autoSubmit?: boolean; message?: string }} options
 */
export function buildColdBuildCommand(target, { platform, autoSubmit = false, message } = {}) {
  if (!platform) throw new Error('buildColdBuildCommand requires platform');
  const args = [
    '--yes',
    EAS_CLI_SPEC,
    'build',
    '--platform',
    platform,
    '--profile',
    target.profile,
    '--non-interactive',
  ];
  if (autoSubmit) args.push('--auto-submit');
  if (message) args.push('--message', message);
  return commandSpec(NPX_BIN, args);
}

export function formatPlan(plan) {
  const lines = [];
  lines.push(`target: ${plan.target.kind} (${plan.target.profile} -> ${plan.target.channel})`);
  lines.push(`mode: ${plan.mode}`);
  if (plan.localRuntime) lines.push(`local runtime: ${plan.localRuntime}`);
  if (plan.latestRuntime) lines.push(`latest runtime: ${plan.latestRuntime}`);
  for (const command of plan.commands ?? []) {
    const spec = normalizeCommandSpec(command);
    const envKeys = Object.keys(spec.env ?? {});
    if (envKeys.length) {
      lines.push(`env: ${envKeys.map((key) => `${key}=${spec.env[key]}`).join(' ')}`);
    }
    lines.push(`$ ${formatCommandSpec(spec)}`);
  }
  if (!plan.execute) lines.push('dry-run: pass --execute to run the command(s)');
  return lines.join('\n');
}

export function formatCommandSpec(command) {
  const spec = normalizeCommandSpec(command);
  return [spec.bin, ...spec.args].join(' ');
}

export function executePlan(plan, { cwd = MOBILE_DIR } = {}) {
  if (!plan.execute) {
    console.log(formatPlan(plan));
    return { executed: false };
  }
  for (const command of plan.commands ?? []) {
    const spec = normalizeCommandSpec(command);
    const result = runCommandSync(spec, {
      cwd,
      env: buildEasCommandEnv(spec.env),
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      throw new Error(`Command failed: ${[spec.bin, ...spec.args].join(' ')}`);
    }
  }
  return { executed: true };
}

export function assertProductionGitGate({
  cwd = WORKTREE_ROOT,
  git = (args) => gitValue(args, cwd),
  getRemoteMainTip = () => readRemoteMainTip({ cwd }),
} = {}) {
  const branch = git(['branch', '--show-current']);
  if (branch !== 'main') throw new Error(`Production release must run on main, current branch is ${branch || '(detached)'}`);
  const status = git(['status', '--short']);
  if (status) throw new Error('Production release requires a clean worktree');
  const head = git(['rev-parse', 'HEAD']);
  const remoteMain = getRemoteMainTip();
  if (!remoteMain) throw new Error('Production release could not read remote origin/main tip');
  if (head !== remoteMain) throw new Error(`Production release requires HEAD == remote origin/main (${head} != ${remoteMain})`);
  return true;
}

function compareVersionParts(a, b) {
  const aa = String(a).split('.').map((part) => Number(part));
  const bb = String(b).split('.').map((part) => Number(part));
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i += 1) {
    const av = Number.isFinite(aa[i]) ? aa[i] : 0;
    const bv = Number.isFinite(bb[i]) ? bb[i] : 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return clone(override);
  const out = clone(base);
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : clone(value);
  }
  return out;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function withoutKey(object, key) {
  const copy = { ...object };
  delete copy[key];
  return copy;
}

function gitValue(args, cwd = WORKTREE_ROOT) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function gitRequiredValue(args, cwd = WORKTREE_ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function readRemoteMainTip({ cwd = WORKTREE_ROOT } = {}) {
  const output = gitRequiredValue(['ls-remote', 'origin', 'refs/heads/main'], cwd);
  const [hash] = output.split(/\s+/);
  if (!hash) throw new Error('Unable to read remote origin/main tip via git ls-remote');
  return hash;
}

export function fileExists(path) {
  return existsSync(path);
}

export function stripPublicEnvKeys(env = process.env) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (key.startsWith('EXPO_PUBLIC_')) delete next[key];
  }
  return next;
}

export function buildEasCommandEnv(publicEnv = {}, baseEnv = process.env) {
  return { ...stripPublicEnvKeys(baseEnv), EXPO_NO_DOTENV: '1', ...resolveCommandPublicEnv(publicEnv, baseEnv) };
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function replaceTargetsArg(args, target) {
  const next = [];
  let replaced = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--targets') {
      next.push(arg, target);
      i += 1;
      replaced = true;
      continue;
    }
    if (arg.startsWith('--targets=')) {
      next.push(`--targets=${target}`);
      replaced = true;
      continue;
    }
    next.push(arg);
  }
  if (!replaced) next.push('--targets', target);
  return next;
}

function hasExecuteFlag(args) {
  return args.some((arg) => arg === '--execute' || arg.startsWith('--execute='));
}

function stripExecuteFlag(args) {
  return args.filter((arg) => arg !== '--execute' && !arg.startsWith('--execute='));
}

function runEasWhoami({ mobileDir = MOBILE_DIR } = {}) {
  return execNpxSync(buildEasWhoamiArgs(), {
    cwd: mobileDir,
    encoding: 'utf8',
    env: buildEasCommandEnv(),
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function buildEasWhoamiArgs() {
  return [
    '--yes',
    EAS_CLI_SPEC,
    'whoami',
  ];
}

export function quoteWindowsCmdArg(arg) {
  const value = String(arg);
  if (!value) return '""';
  if (!/[()\s"%!^&|<>]/.test(value)) return value;
  return `"${value.replace(/(["^%])/g, '^$1')}"`;
}

export function buildWindowsCmdCommand(bin, args) {
  return [bin, ...args].map(quoteWindowsCmdArg).join(' ');
}

function isAlreadyExistsCommandResult(result) {
  return /already exists|exists already|has already been created/i.test(commandResultOutput(result));
}

function commandFailedMessage(command, result) {
  const output = commandResultOutput(result);
  return [`Command failed: ${formatCommandSpec(command)}`, output].filter(Boolean).join('\n');
}

function commandResultOutput(result) {
  return [result.stdout, result.stderr]
    .map((item) => Buffer.isBuffer(item) ? item.toString('utf8') : String(item ?? ''))
    .map((item) => item.trim())
    .filter(Boolean)
    .join('\n');
}

function execNpxSync(args, options) {
  if (process.platform !== 'win32') return execFileSync(NPX_BIN, args, options);
  return execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', buildWindowsCmdCommand(NPX_BIN, args)], options);
}

export function runCommandSync(spec, options) {
  if (process.platform !== 'win32') return spawnSync(spec.bin, spec.args, options);
  return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', buildWindowsCmdCommand(spec.bin, spec.args)], options);
}

function commandSpec(bin, args, env = {}) {
  return { bin, args, env };
}

function normalizeCommandSpec(command) {
  if (Array.isArray(command)) {
    const [bin, ...args] = command;
    return { bin, args, env: {} };
  }
  return { bin: command.bin, args: command.args ?? [], env: command.env ?? {} };
}
