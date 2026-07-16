#!/usr/bin/env node
// =============================================================================
// release-ios-ota.mjs —— 自建线 JS 热更(OTA)发布
//
// 流程:算 runtimeVersion(须与冷更整包同源)→ expo export → 按 Expo Updates Protocol
//       组装 manifest → 上传 bundle/assets(内容寻址)+ update.json + latest.json 到 OSS。
//
// 关键:runtimeVersion 必须与本机冷更 ipa 烧进的值逐字节一致(见 docs 红线 2)。因此优先
//       复用冷更脚本落盘的 release/ios-runtime.json;缺失才在同一 self-host env 下现算。
//
// 默认 dry-run(只算 + export + 打印计划);--execute 才真正上传并翻新 latest.json。
// --execute 前会先校验必需 public env(assertPublicEnv:缺 auth-server 区域/地址等则
// 中止,避免把空值烤进 bundle 后所有自建用户登录崩),再过两道发布闸门(与 release-ios-local.mjs
// 对称,均可用逃生开关跳过):
//   · git 闸门 assertProductionGitGate()(main/clean/HEAD;--skip-git-gate 跳过);
//   · runtime 基线校验:--execute 会**重算当前工作树指纹**(不信任可能过期的
//     release/ios-runtime.json),要它等于 CDN 冷更装机包记录 mobile-ota/ios/release.json
//     的 runtimeVersion,否则原生层已变、热更会推给跑着不同原生面的客户端,须先出冷更整包;
//     --skip-runtime-check 跳过,显式 --runtime-version 作人工 override(仍过基线校验)。
// OSS/CDN 复用 scripts/shared/oss.mjs(bucket smash-dev / dev-cdn.fp.xd.com,prefix xdt-maker)。
// 需要的 EXPO_PUBLIC_*(飞书 appId / api base 等)由运行环境提供(建议 eas env:exec production 包裹)。
// =============================================================================

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { parseArgs, assertProductionGitGate, assertPublicEnv, resolveDesktopVersion } from './release-lib.mjs';
import { buildAssetEntry, buildManifest, sha256Hex, assertOtaRuntimeMatchesBaseline } from './lib/ota-manifest.mjs';
import { createOSSClient, uploadToOSS, CDN_BASE, OSS_PREFIX } from '../../../scripts/shared/oss.mjs';

const MOBILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const OTA_ROOT = `${OSS_PREFIX}/mobile-ota`;              // OSS key 前缀
const ASSET_DIR = `${OTA_ROOT}/assets`;                  // 内容寻址目录
const RELEASE_RECORD_CDN = `${CDN_BASE}/mobile-ota/ios/release.json`; // 冷更装机包记录(release-ios-local 写)
const cdnUrl = (sha) => `${CDN_BASE}/mobile-ota/assets/${sha}`;

function log(msg) { console.error(msg); }

// 读 CDN 冷更装机包记录的 runtimeVersion —— 在装客户端实际运行的原生 runtime 基线。
// 无记录(尚未出过冷更整包)或网络失败返回 null,由调用方按闸门策略处理。
async function fetchColdBaselineRuntime() {
  try {
    // 可变指针 release.json:加 ?t= cache-bust,避免刚发完冷更就读到 CDN 边缘缓存的旧 runtime。
    const url = `${RELEASE_RECORD_CDN}?t=${Date.now()}`;
    const res = await fetch(url, { headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
    if (!res.ok) return null;
    return (await res.json())?.runtimeVersion ?? null;
  } catch {
    return null;
  }
}

// runtime 基线闸门(--execute 用):判定逻辑在 lib/ota-manifest.mjs(纯函数,已单测),
// 这里只负责把判定结果转成日志。
function assertRuntimeMatchesColdBaseline({ runtimeVersion, baselineRuntime, skip }) {
  const r = assertOtaRuntimeMatchesBaseline({ runtimeVersion, baselineRuntime, skip, recordUrl: RELEASE_RECORD_CDN });
  if (r.skipped) log('  warn: --skip-runtime-check,跳过 runtime 基线校验(仅在明确知情时用)');
  else log(`  ✓ runtime 基线校验通过(${runtimeVersion} == 冷更装机包 ${baselineRuntime})`);
}

// self-host 变体的构建环境:确保 export/fingerprint 与安装包同源。
function selfhostEnv(desktopVersion) {
  const otaUrl = process.env.EXPO_PUBLIC_XDT_OTA_URL?.trim();
  if (!otaUrl) throw new Error('release-ios-ota 需要 EXPO_PUBLIC_XDT_OTA_URL(mobile-update-server 基址)');
  const env = { ...process.env, EXPO_PUBLIC_XDT_OTA_SELFHOST: '1', EXPO_PUBLIC_XDT_OTA_URL: otaUrl };
  // 二级版本号:仅 JS 层(不进 @expo/fingerprint,不改 runtimeVersion,与冷更整包同源);空则不注入。
  if (desktopVersion) env.EXPO_PUBLIC_DESKTOP_VERSION = desktopVersion;
  return env;
}

// 现算当前工作树的 expo-updates 指纹(self-host env)—— 本次 export 的 JS 真正对应的原生面。
// ⚠️ TODO(runtimeVersion 一致性,后续 PR):此处 CLI 现算会把已生成的 ios/(prebuild 各阶段内容不同)
// 纳入指纹,与冷更包真正烤进的内嵌 fingerprint 不一定相等(release-ios-local 已改为从 .ipa 回读内嵌值
// 写 release.json)。二者错位时,本脚本的 runtime 基线闸门会误判、且热更会发布到客户端查不到的路径。
// 治本方案是让 CLI 指纹忽略生成的 ios/ + 构建产物(fingerprint.config.cjs),使 CLI 值 == 内嵌值。
function computeFingerprint(env) {
  log('→ 算 runtimeVersion(expo-updates fingerprint,self-host env,约 30-60s)…');
  const out = execFileSync(NPX, ['--yes', 'expo-updates', 'fingerprint:generate', '--platform', 'ios'], {
    cwd: MOBILE_DIR, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const rtv = JSON.parse(out)?.hash;
  if (!rtv) throw new Error('fingerprint:generate 未返回 hash');
  return rtv;
}

// dry-run / 快速预览用:优先复用冷更落盘值或 --runtime-version,缺失才现算。
// ⚠️ 缓存值可能过期(冷更后原生层又变),故 --execute 的发布安全校验不走这里,改用 computeFingerprint 重算。
function runtimeFromFileOrCompute(args, env) {
  if (args.runtimeVersion) return String(args.runtimeVersion);
  const file = args.runtimeFile ? String(args.runtimeFile) : resolve(MOBILE_DIR, 'release/ios-runtime.json');
  if (existsSync(file)) {
    const rtv = JSON.parse(readFileSync(file, 'utf8'))?.runtimeVersion;
    if (rtv) { log(`→ 复用冷更 runtimeVersion(${file}): ${rtv}`); return String(rtv); }
  }
  log('→ 未找到冷更 runtime 记录,现算 fingerprint…');
  return computeFingerprint(env);
}

function runExport(distDir, env) {
  log('→ expo export -p ios …');
  // --clear:清 bundler 缓存,确保 EXPO_PUBLIC_ 变更(TAPTAP / API 等)被重新内联,不吃旧缓存。
  execFileSync(NPX, ['--yes', 'expo', 'export', '--platform', 'ios', '--clear', '--output-dir', distDir], {
    cwd: MOBILE_DIR, env, stdio: 'inherit',
  });
}

// 尽力取 public expo config 作为 manifest.extra.expoClient(供 OTA 后 Constants.expoConfig 可用)。
function readExpoPublicConfig(env) {
  try {
    const out = execFileSync(NPX, ['--yes', 'expo', 'config', '--json', '--type', 'public'], {
      cwd: MOBILE_DIR, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(out);
  } catch {
    log('  warn: 取 public expo config 失败,manifest.extra 置空(不影响热更加载,Constants 可能受限)');
    return null;
  }
}

// 读 dist/metadata.json,组装 launchAsset + assets(含 CDN url)与待上传文件清单。
function collectUpdate(distDir, runtimeVersion, expoClient) {
  const metadata = JSON.parse(readFileSync(join(distDir, 'metadata.json'), 'utf8'));
  const ios = metadata?.fileMetadata?.ios;
  if (!ios?.bundle) throw new Error('metadata.json 缺 fileMetadata.ios.bundle');

  const uploads = []; // { ossKey, localPath, contentType }
  const addFile = (relPath, ext, isLaunchAsset) => {
    const localPath = join(distDir, relPath);
    const bytes = readFileSync(localPath);
    const sha = sha256Hex(bytes);
    const entry = buildAssetEntry({ bytes, ext, url: cdnUrl(sha), isLaunchAsset });
    uploads.push({ ossKey: `${ASSET_DIR}/${sha}`, localPath, contentType: entry.contentType });
    return entry;
  };

  const launchAsset = addFile(ios.bundle, 'hbc', true);
  const assets = (ios.assets ?? []).map((a) => addFile(a.path, a.ext, false));

  const manifest = buildManifest({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    runtimeVersion,
    launchAsset,
    assets,
    expoClient: expoClient ?? undefined,
  });
  return { manifest, uploads };
}

async function objectExists(client, key) {
  try { await client.head(key); return true; } catch { return false; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const desktopVersion = await resolveDesktopVersion({
    explicit: typeof args.desktopVersion === 'string' ? args.desktopVersion : process.env.EXPO_PUBLIC_DESKTOP_VERSION,
    cdnBase: CDN_BASE,
  });
  log(desktopVersion
    ? `→ 桌面包版本(二级版本号): ${desktopVersion}`
    : '→ 桌面包版本(二级版本号): 未解析到,设置页将不显示该行(可用 --desktop-version x.y.z 指定)');
  const env = selfhostEnv(desktopVersion);
  const distDir = args.dist ? resolve(String(args.dist)) : resolve(MOBILE_DIR, 'dist');

  // dry-run 用缓存/参数值快速预览;--execute 会重算当前工作树指纹作为权威发布值(见下)。
  let runtimeVersion = runtimeFromFileOrCompute(args, env);
  const baselineRuntime = await fetchColdBaselineRuntime();
  let runtimeMatchesBaseline = baselineRuntime != null && baselineRuntime === runtimeVersion;

  // 发布闸门只在 --execute 生效,且早于 expo export —— 缺配置/mismatch 快速失败,不白跑一次导出。
  if (args.execute) {
    // 必需 public env 齐全,否则 expo export 会把空 auth-server 配置等烤进 bundle,
    // 发出去后所有自建用户登录崩(与 release-prod/beta 用同一 gate)。建议 eas env:exec production 包裹。
    assertPublicEnv(env, { variant: 'production' });
    if (!args.skipGitGate) assertProductionGitGate();
    else log('  warn: --skip-git-gate,跳过 main/clean/HEAD 校验(仅本地迭代用)');
    if (!args.skipRuntimeCheck) {
      // ⚠️ 不信任可能过期的 release/ios-runtime.json —— 重算当前工作树指纹,它才是本次 expo export
      // 的 JS 真正对应的原生面。要它等于 CDN 冷更基线;不等 = 原生层已变(缓存值即便"碰巧"等于基线
      // 也会被识破),必须先出冷更整包。显式 --runtime-version 视为人工 override(仍过基线校验)。
      const currentFingerprint = args.runtimeVersion ? String(args.runtimeVersion) : computeFingerprint(env);
      assertRuntimeMatchesColdBaseline({ runtimeVersion: currentFingerprint, baselineRuntime, skip: false });
      runtimeVersion = currentFingerprint;   // 用权威指纹发布(与基线一致时二者相等)
      runtimeMatchesBaseline = true;
    } else {
      assertRuntimeMatchesColdBaseline({ runtimeVersion, baselineRuntime, skip: true });
    }
  }

  if (!args.skipExport) runExport(distDir, env);
  else log(`→ --skip-export:复用已有 ${distDir}`);
  if (!existsSync(distDir)) throw new Error(`dist 不存在:${distDir}(去掉 --skip-export?)`);

  const expoClient = args.noExpoConfig ? null : readExpoPublicConfig(env);
  const { manifest, uploads } = collectUpdate(distDir, runtimeVersion, expoClient);

  const manifestKey = `${OTA_ROOT}/ios/${runtimeVersion}/${manifest.id}/update.json`;
  const latestKey = `${OTA_ROOT}/ios/${runtimeVersion}/latest.json`;
  const manifestJson = JSON.stringify(manifest);

  // ── 计划打印 ──
  console.log('');
  console.log(`target: mobile OTA (ios, runtimeVersion=${runtimeVersion})`);
  console.log(`baseline: 冷更装机包 runtimeVersion=${baselineRuntime ?? '(无记录)'}${runtimeMatchesBaseline ? ' — 一致 ✓' : ' — 不一致/缺失 ✗'}`);
  console.log(`updateId: ${manifest.id}`);
  console.log(`assets: ${uploads.length}(launch + ${uploads.length - 1})`);
  console.log(`manifest → ${manifestKey}`);
  console.log(`latest   → ${latestKey}`);
  console.log(`cdn base : ${CDN_BASE}/mobile-ota`);
  if (!args.execute) {
    console.log('note: 上方 runtimeVersion 为缓存/参数快照;--execute 会重算当前工作树指纹并与基线严格比对');
    if (!runtimeMatchesBaseline) {
      console.log('warn: 缓存 runtime 与冷更基线不一致/缺失,--execute 大概率被拦截(需先出冷更整包,或显式 --skip-runtime-check)');
    }
    console.log('dry-run: 传 --execute 才真正上传并翻新 latest.json');
    return;
  }

  // ── 执行上传 ──
  const client = createOSSClient();
  let uploaded = 0, skipped = 0;
  for (const u of uploads) {
    if (await objectExists(client, u.ossKey)) { skipped += 1; continue; }
    await uploadToOSS(client, u.ossKey, u.localPath, { headers: { 'Content-Type': u.contentType } });
    uploaded += 1;
  }
  log(`  ✓ assets 上传 ${uploaded} 个,复用已存在 ${skipped} 个`);

  // 先传归档 update.json,再翻新 latest.json 指针(latest 最后,避免指向未就绪产物)。
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const tmp = join(mkdtempSync(join(tmpdir(), 'xdt-ota-')), 'update.json');
  writeFileSync(tmp, manifestJson);
  await uploadToOSS(client, manifestKey, tmp, { headers: { 'Content-Type': 'application/json' } });
  await uploadToOSS(client, latestKey, tmp, { headers: { 'Content-Type': 'application/json' } });
  console.log('');
  console.log('==================== OTA 发布完成 ====================');
  console.log(`  runtimeVersion : ${runtimeVersion}`);
  console.log(`  updateId       : ${manifest.id}`);
  console.log(`  manifest(CDN) : ${CDN_BASE}/mobile-ota/ios/${runtimeVersion}/latest.json`);
  console.log('======================================================');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
