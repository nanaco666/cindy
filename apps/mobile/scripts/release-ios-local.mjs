#!/usr/bin/env node
// =============================================================================
// release-ios-local.mjs —— 自建线 iOS 冷更(本机出整包 → NPKG 企业重签 → 自有 OSS 分发)
//
// 流程:git 闸门 → 读基线并按需自动 bump ios.buildNumber(≤ 基线时自增,写回 app.json)
//       → expo prebuild(com.xd.cindycn)→ pod install → xcodebuild archive/export(dev 签)→ .ipa
//       → 从 .ipa 回读内嵌 runtimeVersion(EXUpdates.bundle/fingerprint,落盘供 OTA 复用)
//       → release-ios.sh upload(NPKG_EXPECT_BUNDLE=com.xd.cindycn,借 NPKG 企业重签)
//       → release-ios.sh download 拉回重签后的 .ipa → 直传 OSS(ipa + manifest.plist + install.html)
//       → 写整包版本记录 release.json 到 OSS(供 mobile-update-server /latest)。
//
// runtimeVersion 取“真正烤进 .ipa 的 fingerprint”为权威值(见 lib/embedded-runtime.mjs 头注):
// 客户端运行时读该内嵌值与 release.json 比对,不一致就弹整包更新。绝不用 CLI 独立现算——现算会把
// prebuild 各阶段内容不同的 ios/ 目录纳入指纹,与内嵌值错位 → 装了最新包仍反复弹整包更新。
// NPKG 企业重签只换签名、不改 bundle 内 fingerprint 文件,故读出包时的本地 ipa 即权威值。
//
// 分发链路:装机流量全走自有 OSS/CDN(itmsUrl 指向 OSS 上的 manifest.plist,其内指向
// OSS 上的重签 ipa;installUrl 是 OSS 上的安装页)。NPKG 只在发版机上参与企业重签一步
// ——企业证书(UE5H8B62F9.*)在 NPKG 侧,这一步无法绕开,但用户下载不再经过 NPKG。
//
// 默认 dry-run(校验环境 + 解析 workspace/scheme + 打印计划,不构建、不上传);
// --execute 才跑完整链路(需 macOS + Xcode + 已装 dev 证书/描述文件 + NPKG 白名单)。
//
// 签名(见 docs/self-hosted-ios-build-and-ota.md §3/§7):dev profile cindycn_dev /
// Team NTC4BJ542G / bundle com.xd.cindycn;NPKG strip 后企业重签(UE5H8B62F9.*)。
// 证书套件(profile + p12)在打包机 /Users/cn-ios/Documents/cindy/CindyMobileCer/iOS/cn/,不进仓库。
// 可用环境变量覆盖:XDT_IOS_TEAM_ID / XDT_IOS_PROFILE_NAME / XDT_IOS_SIGN_IDENTITY /
//   XDT_IOS_PROFILE_PATH(描述文件路径,--execute 时会安装到系统目录)。
// =============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import {
  parseArgs,
  assertProductionGitGate,
  assertPublicEnv,
  resolveDesktopVersion,
} from './release-lib.mjs';
import {
  parseNpkgInstallLinks,
  assertBuildNumberMonotonic,
  buildExportOptionsPlist,
  buildReleaseRecord,
  fetchBaselineBuildNumber,
  compareBuildNumbers,
  nextDateBuildNumber,
  replaceBuildNumberInAppJson,
} from './lib/ios-local.mjs';
import { buildIosDistTargets, buildItmsManifestPlist, buildItmsUrl, buildInstallHtml } from './lib/oss-dist.mjs';
import { clearBundlerCache } from './lib/bundler-cache.mjs';
import { readEmbeddedRuntimeVersionFromIpa } from './lib/embedded-runtime.mjs';
import { createOSSClient, uploadToOSS, CDN_BASE, OSS_PREFIX, OSS_BUCKET } from '../../../scripts/shared/oss.mjs';

const MOBILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const SELFHOST_BUNDLE_ID = 'com.xd.cindycn';
const RELEASE_RECORD_KEY = `${OSS_PREFIX}/mobile-ota/ios/release.json`;
const RELEASE_RECORD_CDN = `${CDN_BASE}/mobile-ota/ios/release.json`;

const SIGN = {
  teamId: process.env.XDT_IOS_TEAM_ID || 'NTC4BJ542G',
  profileName: process.env.XDT_IOS_PROFILE_NAME || 'cindycn_dev',
  identity: process.env.XDT_IOS_SIGN_IDENTITY || 'Apple Development',
  profilePath: process.env.XDT_IOS_PROFILE_PATH || '',
};

function log(msg) { console.error(msg); }

function selfhostEnv(desktopVersion) {
  const otaUrl = process.env.EXPO_PUBLIC_XDT_OTA_URL?.trim();
  if (!otaUrl) throw new Error('release-ios-local 需要 EXPO_PUBLIC_XDT_OTA_URL(mobile-update-server 基址,用于烧进包的 updates.url)');
  const env = { ...process.env, EXPO_PUBLIC_XDT_OTA_SELFHOST: '1', EXPO_PUBLIC_XDT_OTA_URL: otaUrl };
  // 二级版本号:自建线包所配对的桌面产品线版本;仅有值时注入(空则设置页不显示该行)。
  if (desktopVersion) env.EXPO_PUBLIC_DESKTOP_VERSION = desktopVersion;
  return env;
}

function readAppJson() {
  return JSON.parse(readFileSync(resolve(MOBILE_DIR, 'app.json'), 'utf8'));
}

function writeRuntimeFile(runtimeVersion) {
  const dir = resolve(MOBILE_DIR, 'release');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, 'ios-runtime.json');
  writeFileSync(file, `${JSON.stringify({ runtimeVersion, platform: 'ios' }, null, 2)}\n`);
  log(`  ✓ runtimeVersion 落盘 ${file}(release-ios-ota.mjs 会复用)`);
}

// fail-closed 读取冷更基线 buildNumber(仅 404/无记录 → null,其它失败抛错);见 lib/ios-local.mjs。
function fetchPreviousBuildNumber() {
  return fetchBaselineBuildNumber(RELEASE_RECORD_CDN);
}

function findWorkspace() {
  const iosDir = resolve(MOBILE_DIR, 'ios');
  if (!existsSync(iosDir)) return null;
  const ws = readdirSync(iosDir).find((f) => f.endsWith('.xcworkspace'));
  if (!ws) return null;
  return { path: join(iosDir, ws), scheme: basename(ws, '.xcworkspace') };
}

function ensureProfileInstalled() {
  if (!SIGN.profilePath) {
    log('  warn: 未设 XDT_IOS_PROFILE_PATH;假设描述文件已装入系统(~/Library/MobileDevice/Provisioning Profiles)');
    return;
  }
  if (!existsSync(SIGN.profilePath)) throw new Error(`描述文件不存在:${SIGN.profilePath}`);
  const dest = join(homedir(), 'Library/MobileDevice/Provisioning Profiles');
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  copyFileSync(SIGN.profilePath, join(dest, basename(SIGN.profilePath)));
  log(`  ✓ 已安装描述文件 ${basename(SIGN.profilePath)}`);
}

function run(cmd, args, opts = {}) {
  log(`  $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: MOBILE_DIR, stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`命令失败(${r.status}): ${cmd} ${args.join(' ')}`);
}

function buildIpa(env) {
  run(NPX, ['--yes', 'expo', 'prebuild', '--platform', 'ios', '--clean'], { env });
  run(NPX, ['--yes', 'pod-install'], { env });

  const ws = findWorkspace();
  if (!ws) throw new Error('prebuild 后未找到 ios/*.xcworkspace');
  log(`→ workspace=${basename(ws.path)} scheme=${ws.scheme}`);

  const outDir = mkdtempSync(join(tmpdir(), 'xdt-ios-build-'));
  const archivePath = join(outDir, 'app.xcarchive');
  const exportDir = join(outDir, 'export');
  const plistPath = join(outDir, 'ExportOptions.plist');
  writeFileSync(plistPath, buildExportOptionsPlist({ teamId: SIGN.teamId, bundleId: SELFHOST_BUNDLE_ID, profileName: SIGN.profileName }));

  // xcodebuild 的 RN embed 阶段内部触发 expo export:embed 打 JS bundle,无法透传 --clear;
  // 构建前清 Metro/Babel 缓存,确保 EXPO_PUBLIC_ 变更(TAPTAP / API 等)被重新内联,不吃旧缓存。
  clearBundlerCache({ mobileDir: MOBILE_DIR, log });

  ensureProfileInstalled();
  run('xcodebuild', [
    '-workspace', ws.path, '-scheme', ws.scheme, '-configuration', 'Release',
    '-archivePath', archivePath, '-sdk', 'iphoneos', 'archive',
    'CODE_SIGN_STYLE=Manual', `DEVELOPMENT_TEAM=${SIGN.teamId}`,
    `PROVISIONING_PROFILE_SPECIFIER=${SIGN.profileName}`, `CODE_SIGN_IDENTITY=${SIGN.identity}`,
  ], { env });
  run('xcodebuild', ['-exportArchive', '-archivePath', archivePath, '-exportOptionsPlist', plistPath, '-exportPath', exportDir], { env });

  const ipa = readdirSync(exportDir).find((f) => f.endsWith('.ipa'));
  if (!ipa) throw new Error(`export 未产出 .ipa:${exportDir}`);
  return join(exportDir, ipa);
}

function uploadToNpkg(ipaPath, tag, env) {
  log(`→ release-ios.sh upload(NPKG_EXPECT_BUNDLE=${SELFHOST_BUNDLE_ID},借 NPKG 企业重签)…`);
  const r = spawnSync('bash', [resolve(MOBILE_DIR, 'scripts/release-ios.sh'), 'upload', ipaPath, '--tag', tag], {
    cwd: MOBILE_DIR, encoding: 'utf8', env: { ...env, NPKG_EXPECT_BUNDLE: SELFHOST_BUNDLE_ID },
  });
  process.stdout.write(r.stdout ?? '');
  process.stderr.write(r.stderr ?? '');
  if (r.status !== 0) throw new Error(`NPKG 上传失败(白名单未配 ${SELFHOST_BUNDLE_ID}?见 docs §13)`);
  const links = parseNpkgInstallLinks(r.stdout);
  if (!links.childId) throw new Error('未能从 NPKG 输出解析企业子包 id(需要它下载重签 ipa 转传 OSS)');
  return links;
}

// 把企业重签后的 .ipa 从 NPKG 拉回本地(token 在 release-ios.sh 侧加载,Node 不接触)。
function downloadRepackedIpa(childId, env) {
  const dest = join(mkdtempSync(join(tmpdir(), 'xdt-ios-repack-')), `repack-${childId}.ipa`);
  const r = spawnSync('bash', [resolve(MOBILE_DIR, 'scripts/release-ios.sh'), 'download', String(childId), dest], {
    cwd: MOBILE_DIR, stdio: 'inherit', env,
  });
  if (r.status !== 0 || !existsSync(dest)) throw new Error(`下载企业重签 ipa 失败(子包 ${childId})`);
  return dest;
}

// 重签 ipa + itms manifest plist + 安装页 直传自有 OSS,返回写进 release.json 的链接。
async function uploadDistToOSS(client, repackedIpaPath, version, buildNumber) {
  const targets = buildIosDistTargets({ ossPrefix: OSS_PREFIX, cdnBase: CDN_BASE, version, buildNumber });
  log(`→ 上传重签 ipa → oss://${OSS_BUCKET}/${targets.ipa.key}`);
  await uploadToOSS(client, targets.ipa.key, repackedIpaPath, { headers: { 'Content-Type': 'application/octet-stream' } });

  const tmpDir = mkdtempSync(join(tmpdir(), 'xdt-ios-dist-'));
  const manifestPath = join(tmpDir, 'manifest.plist');
  writeFileSync(manifestPath, buildItmsManifestPlist({ ipaUrl: targets.ipa.url, bundleId: SELFHOST_BUNDLE_ID, buildNumber, title: 'XDMaker' }));
  await uploadToOSS(client, targets.manifest.key, manifestPath, { headers: { 'Content-Type': 'text/xml' } });

  const itmsUrl = buildItmsUrl(targets.manifest.url);
  const pagePath = join(tmpDir, 'install.html');
  writeFileSync(pagePath, buildInstallHtml({ itmsUrl, title: 'XDMaker', version, buildNumber }));
  await uploadToOSS(client, targets.page.key, pagePath, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

  log(`  ✓ 安装页 ${targets.page.url}`);
  return { installUrl: targets.page.url, itmsUrl };
}

async function uploadReleaseRecord(client, record) {
  const tmp = join(mkdtempSync(join(tmpdir(), 'xdt-rec-')), 'release.json');
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  await uploadToOSS(client, RELEASE_RECORD_KEY, tmp, { headers: { 'Content-Type': 'application/json' } });
  log(`  ✓ 整包版本记录 → ${RELEASE_RECORD_CDN}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const desktopVersion = await resolveDesktopVersion({
    explicit: typeof args.desktopVersion === 'string' ? args.desktopVersion : process.env.EXPO_PUBLIC_DESKTOP_VERSION,
    cdnBase: CDN_BASE,
  });
  log(desktopVersion
    ? `  桌面包版本(二级版本号): ${desktopVersion}`
    : '  桌面包版本(二级版本号): 未解析到,设置页将不显示该行(可用 --desktop-version x.y.z 指定)');
  const env = selfhostEnv(desktopVersion);
  const appJson = readAppJson();
  const version = appJson?.expo?.version ?? '';
  let buildNumber = appJson?.expo?.ios?.buildNumber ?? '';
  const message = String(args.message ?? args.m ?? '');

  if (!args.skipGitGate) assertProductionGitGate();
  else log('  warn: --skip-git-gate,跳过 main/clean/HEAD 校验(仅本地迭代用)');

  // --skip-record 是"CDN 基线不可读/首发"的逃生开关:此时不写 release.json,buildNumber 单调
  // 门禁本就无意义,必须在读基线之前短路——否则 fetchBaselineBuildNumber 的 fail-closed 抛错会
  // 让 --skip-record --execute 也走不下去,逃生开关名不副实(Greptile P1)。
  let previousBuildNumber = null;
  let autoBumped = false;
  if (args.skipRecord) {
    log('  --skip-record:跳过冷更基线读取与 buildNumber 单调校验(不写 release.json)');
  } else {
    previousBuildNumber = await fetchPreviousBuildNumber();
    // 检测到整包但版本文件没 bump(≤ 线上基线)→ 自动自增 app.json 的 ios.buildNumber:
    // dry-run 只预告不写盘;--execute 写盘发生在 fingerprint/prebuild 之前,保证烤进包、
    // 记录进 release.json 的是同一个新号。写盘后工作区会脏(git 闸门已过),完成后需 commit 回 main。
    if (!buildNumber || (previousBuildNumber != null && compareBuildNumbers(buildNumber, previousBuildNumber) <= 0)) {
      // --ipa 复用现成包时禁止自动 bump:包内 CFBundleVersion 在出包时已定格,这里改 app.json
      // 只会让 release.json 宣告一个包里不存在的版本号(装机端照旧无法覆盖升级)。维持旧行为:
      // 落到下方单调断言报错,由人工对齐版本号后重新出包。
      if (args.ipa) {
        log('  --ipa 复用现成包:跳过自动 bump(包内 CFBundleVersion 已定格,自动改 app.json 会与包内不一致)');
      } else {
        const next = nextDateBuildNumber(buildNumber, previousBuildNumber);
        if (args.execute) {
          const appJsonPath = resolve(MOBILE_DIR, 'app.json');
          writeFileSync(appJsonPath, replaceBuildNumberInAppJson(readFileSync(appJsonPath, 'utf8'), next));
          log(`  ✓ 自动 bump app.json ios.buildNumber:${buildNumber || '(空)'} → ${next}`);
          autoBumped = true;
        } else {
          log(`  dry-run:buildNumber ${buildNumber || '(空)'} 未大于线上基线 ${previousBuildNumber ?? '(无)'},--execute 时将自动 bump 为 ${next}`);
        }
        buildNumber = next;
      }
    }
    assertBuildNumberMonotonic(buildNumber, previousBuildNumber);
  }

  // 计划打印
  console.log('');
  console.log(`target: mobile 冷更(ios, ${SELFHOST_BUNDLE_ID})`);
  console.log(`version / buildNumber: ${version} / ${buildNumber}${previousBuildNumber ? ` (上一条 ${previousBuildNumber})` : (args.skipRecord ? ' (--skip-record,跳过基线)' : ' (首发)')}`);
  console.log(`sign: team=${SIGN.teamId} profile=${SIGN.profileName} identity="${SIGN.identity}"`);
  console.log('steps: prebuild → pod-install → xcodebuild archive/export → 从 .ipa 回读 runtimeVersion → NPKG 企业重签 → 重签 ipa 直传 OSS(manifest.plist + install.html)→ 写 release.json');
  if (!args.execute) {
    console.log('dry-run: 传 --execute 才真正构建 + 上传(需 macOS + Xcode + 证书 + NPKG 白名单 + OSS AK/SK env)');
    return;
  }

  if (process.platform !== 'darwin') throw new Error('--execute 需在 macOS 上运行(xcodebuild)');

  // 必需 public env 齐全,否则 prebuild/xcodebuild 会把空 EXPO_PUBLIC_FEISHU_APP_ID 等烤进整包,
  // 装机后登录崩(与 release-prod/beta / OTA 脚本用同一 gate)。建议 eas env:exec production 包裹。
  assertPublicEnv(env, { variant: 'production' });

  const ipaPath = args.ipa ? resolve(String(args.ipa)) : buildIpa(env);
  log(`  ✓ ipa: ${ipaPath}`);

  // 权威 runtimeVersion = 真正烤进 .ipa 的 EXUpdates.bundle/fingerprint(iOS 运行时实际读取处)。
  // 用出包时的本地 ipa 读取即可:NPKG 企业重签只换签名、不改 bundle 内 fingerprint 文件。
  const runtimeVersion = readEmbeddedRuntimeVersionFromIpa(ipaPath);
  writeRuntimeFile(runtimeVersion);
  log(`  ✓ runtimeVersion(读自 .ipa 内嵌 fingerprint): ${runtimeVersion}`);

  if (args.skipNpkg) { log('  --skip-npkg:跳过重签/上传与版本记录'); return; }
  const npkg = uploadToNpkg(ipaPath, String(args.tag ?? 'release'), env);
  const repackedIpa = downloadRepackedIpa(npkg.childId, env);

  const client = createOSSClient();
  const links = await uploadDistToOSS(client, repackedIpa, version, buildNumber);

  if (!args.skipRecord) {
    const record = buildReleaseRecord({
      version, buildNumber, runtimeVersion,
      installUrl: links.installUrl, itmsUrl: links.itmsUrl,
      releaseNotes: message || undefined,
    });
    await uploadReleaseRecord(client, record);
  }

  console.log('');
  console.log('==================== 冷更发布完成 ====================');
  console.log(`  runtimeVersion : ${runtimeVersion}`);
  console.log(`  install        : ${links.installUrl}(安装页,itms 走 OSS;NPKG 链接仅发版备查)`);
  console.log('  下一步:纯 JS 改动用 `pnpm mobile:release:ios:ota -- --execute` 发热更(复用此 runtimeVersion)');
  if (autoBumped) {
    console.log(`  ⚠ app.json ios.buildNumber 已自动 bump 为 ${buildNumber},记得 commit + push 回 main(否则下次 git 闸门会拦)`);
  }
  console.log('======================================================');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
