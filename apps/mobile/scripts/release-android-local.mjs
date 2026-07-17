#!/usr/bin/env node
// =============================================================================
// release-android-local.mjs —— 自建线 Android 冷更(本机出签名 APK → 直传自有 OSS → 内部分发)
//
// 流程:git 闸门 → 读基线并按需自动 bump versionCode(≤ 基线时自增,写回 android-version.json)
//       → expo prebuild(com.xd.cindycn,注入 versionCode)→ patch build.gradle 用自有 keystore 自签
//       → gradlew assembleRelease → app-release.apk
//       → 从 APK 回读内嵌 runtimeVersion(assets/fingerprint,落盘供 OTA 复用)
//       → APK 直传 OSS(mobile-dist/android/<versionCode>/,installUrl = CDN 直链)
//       → 写整包版本记录 release.json 到 OSS(供 mobile-update-server /latest?platform=android)。
//
// runtimeVersion 取“真正烤进 APK 的 assets/fingerprint”为权威值(见 lib/embedded-runtime.mjs 头注):
// 客户端运行时读该内嵌值与 release.json 比对,不一致就弹整包更新。绝不用 CLI 独立现算——现算会把
// prebuild 各阶段内容不同的 android/ 目录也纳入指纹,与内嵌值错位 → 装了最新包仍反复弹整包更新。
//
// 分发不再经 NPKG:APK 自签即终版,无需任何重签/分发平台;客户端拿 installUrl 直下安装。
// (release-android-npkg.sh 保留,仅供手动往 NPKG 补传时使用。)
//
// 默认 dry-run(校验环境 + 打印计划,不构建、不上传);--execute 才跑完整链路
// (需 macOS + Android SDK + JDK 17 + keystore 口令 env + OSS AK/SK env,除非 --skip-upload)。
//
// 签名(见 docs/self-hosted-android-build-and-ota.md §7):自有 release keystore 自签即终版。
// 签名参数**零代码默认值**,路径 / alias / 两个口令全部由环境变量提供(--execute 构建时缺任一项
// 抛错;--apk 复用现成包时豁免):XDT_ANDROID_KEYSTORE_PATH / XDT_ANDROID_KEY_ALIAS /
// XDT_ANDROID_KEYSTORE_PASSWORD / XDT_ANDROID_KEY_PASSWORD。
// 签名套件本体(CindyMobileCer/Android/)在打包机的仓库外目录,不入仓。
// =============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  parseArgs,
  assertProductionGitGate,
  assertPublicEnv,
  formatBakedEnvLines,
  resolveDesktopVersion,
} from './release-lib.mjs';
import {
  assertBuildNumberMonotonic,
  buildReleaseRecord,
  fetchBaselineBuildNumber,
  compareBuildNumbers,
} from './lib/ios-local.mjs';
import { buildAndroidDistTarget, parseApkBadging, assertApkMetadata } from './lib/oss-dist.mjs';
import {
  readAndroidVersionCode,
  nextSequentialVersionCode,
  replaceVersionCodeInAndroidVersionJson,
  resolveAndroidSigningEnv,
  patchBuildGradleSigning,
  patchGradlePropertiesMemory,
} from './lib/android-local.mjs';
import { resolveJavaRuntimeEnv, javaRuntimeDetail } from './java-runtime-env.mjs';
import { clearBundlerCache } from './lib/bundler-cache.mjs';
import { readEmbeddedRuntimeVersionFromApk } from './lib/embedded-runtime.mjs';
import { createOSSClient, uploadToOSS, CDN_BASE, OSS_PREFIX, OSS_BUCKET, refreshOssConfig } from '../../../scripts/shared/oss.mjs';
import { productionMobileEnv } from '../../../scripts/shared/production-endpoints.mjs';

refreshOssConfig();

const MOBILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
// 必须与 app.config.js 自建分支的 SELFHOST_ANDROID_PACKAGE 一致(改身份时两处一起改),
// 否则出的 APK 包名与 validateApkMetadata 期望不符、校验会被拒。
const SELFHOST_PACKAGE = 'com.xd.cindycn';
const RELEASE_RECORD_KEY = `${OSS_PREFIX}/mobile-ota/android/release.json`;
const RELEASE_RECORD_CDN = `${CDN_BASE}/mobile-ota/android/release.json`;

function log(msg) { console.error(msg); }

// self-host 变体的构建环境:确保 prebuild/fingerprint 与安装包同源,并注入 versionCode。
function selfhostEnv(versionCode, desktopVersion) {
  const otaUrl = process.env.EXPO_PUBLIC_XDT_OTA_URL?.trim();
  if (!otaUrl) throw new Error('release-android-local 需要 EXPO_PUBLIC_XDT_OTA_URL(mobile-update-server 基址,用于烧进包的 updates.url)');
  const env = {
    ...process.env,
    ...productionMobileEnv(),
    EXPO_PUBLIC_XDT_OTA_SELFHOST: '1',
    EXPO_PUBLIC_XDT_OTA_URL: otaUrl,
    XDT_ANDROID_VERSION_CODE: String(versionCode),
  };
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
  const file = join(dir, 'android-runtime.json');
  writeFileSync(file, `${JSON.stringify({ runtimeVersion, platform: 'android' }, null, 2)}\n`);
  log(`  ✓ runtimeVersion 落盘 ${file}(release-android-ota.mjs 会复用)`);
}

// fail-closed 读取冷更基线 versionCode(仅 404/无记录 → null,其它失败抛错);见 lib/ios-local.mjs。
function fetchPreviousVersionCode() {
  return fetchBaselineBuildNumber(RELEASE_RECORD_CDN);
}

function run(cmd, args, opts = {}) {
  log(`  $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: MOBILE_DIR, stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`命令失败(${r.status}): ${cmd} ${args.join(' ')}`);
}

// patch 生成的 android/app/build.gradle,让 release 用自有 keystore 自签(幂等,纯函数在 lib/android-local）。
function patchGradleSigning() {
  const gradlePath = resolve(MOBILE_DIR, 'android/app/build.gradle');
  if (!existsSync(gradlePath)) throw new Error(`prebuild 后未找到 ${gradlePath}`);
  const patched = patchBuildGradleSigning(readFileSync(gradlePath, 'utf8'));
  writeFileSync(gradlePath, patched);
  log('  ✓ 已 patch android/app/build.gradle:release 用自有 keystore 自签(口令走 env,不落盘)');
}

// 调大生成工程的 Gradle heap / metaspace。只动 prebuild 产物,不影响 fingerprint。
function patchGradleProps() {
  const props = resolve(MOBILE_DIR, 'android/gradle.properties');
  if (!existsSync(props)) throw new Error(`prebuild 后未找到 ${props}`);
  writeFileSync(props, patchGradlePropertiesMemory(readFileSync(props, 'utf8')));
  log('  ✓ 已 patch android/gradle.properties(bump heap/metaspace)');
}

function buildApk(env) {
  // 签名参数零默认值,prebuild 前先强制解析(fail-fast,缺 env 不白跑数分钟 prebuild;
  // --apk 复用现成包的路径不进本函数,天然豁免)。
  const signEnv = resolveAndroidSigningEnv(env);

  // prebuild 生成原生工程(注入 SELFHOST env → package=com.xd.cindycn + versionCode)。
  run(NPX, ['--yes', 'expo', 'prebuild', '--platform', 'android', '--clean'], { env });
  patchGradleSigning();
  patchGradleProps();

  // gradle 内部触发 expo export:embed 打 JS bundle,无法透传 --clear;打包前清 Metro/Babel 缓存,
  // 确保 EXPO_PUBLIC_ 变更(TAPTAP / API 等)被重新内联,不吃旧缓存(如 placeholder)。
  clearBundlerCache({ mobileDir: MOBILE_DIR, log });

  // gradlew assembleRelease:需 JDK 17 + keystore 签名 env。
  const javaEnv = resolveJavaRuntimeEnv({ ...env, ...signEnv });
  log(`  → gradle 用 ${javaRuntimeDetail(javaEnv)}`);
  const androidDir = resolve(MOBILE_DIR, 'android');
  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  run(gradlew, ['assembleRelease'], { cwd: androidDir, env: javaEnv });

  const apkDir = join(androidDir, 'app/build/outputs/apk/release');
  const apk = existsSync(apkDir) ? readdirSync(apkDir).find((f) => f.endsWith('.apk')) : null;
  if (!apk) throw new Error(`assembleRelease 未产出 .apk:${apkDir}`);
  return join(apkDir, apk);
}

// APK 直传自有 OSS:自签即终版,installUrl = CDN 直链,客户端 Linking.openURL 直下安装。
async function uploadApkToOSS(client, apkPath, version, versionCode) {
  const target = buildAndroidDistTarget({ ossPrefix: OSS_PREFIX, cdnBase: CDN_BASE, version, versionCode });
  log(`→ 上传 APK → oss://${OSS_BUCKET}/${target.key}`);
  await uploadToOSS(client, target.key, apkPath, { headers: { 'Content-Type': 'application/vnd.android.package-archive' } });
  log(`  ✓ 安装直链 ${target.url}`);
  return target.url;
}

// 定位 aapt2(Android SDK build-tools)。优先 ANDROID_HOME / ANDROID_SDK_ROOT 下最高版本 build-tools,
// 兜底 PATH。找不到返回 null(由调用方按 required 决定抛错还是降级 warn)。
function locateAapt2() {
  const bin = process.platform === 'win32' ? 'aapt2.exe' : 'aapt2';
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (sdk) {
    const btRoot = join(sdk, 'build-tools');
    if (existsSync(btRoot)) {
      const versions = readdirSync(btRoot).sort().reverse(); // 版本号字符串降序,取最高
      for (const v of versions) {
        const p = join(btRoot, v, bin);
        if (existsSync(p)) return p;
      }
    }
  }
  // 兜底:PATH 上直接可用
  const probe = spawnSync(bin, ['version'], { encoding: 'utf8' });
  return probe.status === 0 ? bin : null;
}

// 上传前校验 APK 内嵌 manifest 的 package / versionCode 与本次发版目标一致。
// required=true(--apk 手动指定外部包)时定位不到 aapt2 直接抛错(操作者选了手动路径就得保证能校验);
// required=false(默认 build 路径,包由 prebuild 注入、构造上一致)时降级 warn,不阻断发版。
function validateApkMetadata(apkPath, expectPackage, expectVersionCode, { required }) {
  const aapt2 = locateAapt2();
  if (!aapt2) {
    const base = 'aapt2 未找到(Android SDK build-tools 不在 ANDROID_HOME/PATH)';
    if (required) throw new Error(`${base}——--apk 手动指定外部包时必须能校验 package/versionCode,请确保 build-tools 可用`);
    log(`  warn: ${base},跳过 APK manifest 校验(默认 build 路径的包由 prebuild 注入,构造上一致)`);
    return;
  }
  const r = spawnSync(aapt2, ['dump', 'badging', apkPath], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`aapt2 dump badging 失败:${r.stderr || r.stdout || `exit ${r.status}`}`);
  assertApkMetadata(parseApkBadging(r.stdout), { expectPackage, expectVersionCode });
  log(`  ✓ APK manifest 校验通过(package=${expectPackage}, versionCode=${expectVersionCode})`);
}

async function uploadReleaseRecord(client, record) {
  const tmp = join(tmpdir(), `xdt-android-rec-${process.pid}.json`);
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  await uploadToOSS(client, RELEASE_RECORD_KEY, tmp, { headers: { 'Content-Type': 'application/json' } });
  log(`  ✓ 整包版本记录 → ${RELEASE_RECORD_CDN}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appJson = readAppJson();
  const version = appJson?.expo?.version ?? '';
  let versionCode = readAndroidVersionCode(MOBILE_DIR);
  const message = String(args.message ?? args.m ?? '');
  const desktopVersion = await resolveDesktopVersion({
    explicit: typeof args.desktopVersion === 'string' ? args.desktopVersion : process.env.EXPO_PUBLIC_DESKTOP_VERSION,
    cdnBase: CDN_BASE,
  });
  log(desktopVersion
    ? `  桌面包版本(二级版本号): ${desktopVersion}`
    : '  桌面包版本(二级版本号): 未解析到,设置页将不显示该行(可用 --desktop-version x.y.z 指定)');

  if (!args.skipGitGate) assertProductionGitGate();
  else log('  warn: --skip-git-gate,跳过 main/clean/HEAD 校验(仅本地迭代用)');

  // 签名 env 预检必须在自动 bump 写盘之前:否则缺 env 时 android-version.json 已被写脏,
  // 下一次执行会被 git gate 拒绝,得人工收拾未发布的版本号(Greptile P1)。
  // buildApk 内仍会再解析一次(取用值);--apk 复用现成包不构建,豁免。
  if (args.execute && !args.apk) resolveAndroidSigningEnv(process.env);

  // --skip-record 是"CDN 基线不可读/首发"的逃生开关:此时不写 release.json,versionCode 单调
  // 门禁本就无意义,必须在读基线之前短路(与 iOS 脚本对称,Greptile P1)。
  let previousVersionCode = null;
  let autoBumped = false;
  if (args.skipRecord) {
    log('  --skip-record:跳过冷更基线读取与 versionCode 单调校验(不写 release.json)');
  } else {
    previousVersionCode = await fetchPreviousVersionCode();
    // 检测到整包但版本文件没 bump(≤ 线上基线)→ 自动自增 android-version.json 的 versionCode:
    // dry-run 只预告不写盘;--execute 写盘发生在 env 构建之前(versionCode 经
    // XDT_ANDROID_VERSION_CODE 注入 fingerprint/prebuild,必须用新号,否则烤进包的
    // versionCode 与 release.json 记录不一致)。写盘后工作区会脏(git 闸门已过),完成后需 commit 回 main。
    if (previousVersionCode != null && compareBuildNumbers(versionCode, previousVersionCode) <= 0) {
      // --apk 复用现成包时禁止自动 bump:APK manifest 里的 versionCode 在出包时已定格,这里改
      // android-version.json 只会让 release.json 宣告一个包里不存在的版本号(装机端照旧无法
      // 覆盖升级)。维持旧行为:落到下方单调断言报错,由人工对齐版本号后重新出包。
      if (args.apk) {
        log('  --apk 复用现成包:跳过自动 bump(APK manifest versionCode 已定格,自动改版本文件会与包内不一致)');
      } else {
        const next = nextSequentialVersionCode(versionCode, previousVersionCode);
        if (args.execute) {
          const file = resolve(MOBILE_DIR, 'android-version.json');
          writeFileSync(file, replaceVersionCodeInAndroidVersionJson(readFileSync(file, 'utf8'), next));
          log(`  ✓ 自动 bump android-version.json versionCode:${versionCode} → ${next}`);
          autoBumped = true;
        } else {
          log(`  dry-run:versionCode ${versionCode} 未大于线上基线 ${previousVersionCode},--execute 时将自动 bump 为 ${next}`);
        }
        versionCode = next;
      }
    }
    assertBuildNumberMonotonic(versionCode, previousVersionCode);
  }

  // env 必须在自动 bump 之后构建:selfhostEnv 把 versionCode 注入 XDT_ANDROID_VERSION_CODE。
  const env = selfhostEnv(versionCode, desktopVersion);

  // 计划打印
  console.log('');
  console.log(`target: mobile 冷更(android, ${SELFHOST_PACKAGE})`);
  console.log(`version / versionCode: ${version} / ${versionCode}${previousVersionCode ? ` (上一条 ${previousVersionCode})` : (args.skipRecord ? ' (--skip-record,跳过基线)' : ' (首发)')}`);
  // 签名 env 现值预览(pre-flight 信号;口令项只报 set/未设,绝不打印值)。严格校验在 buildApk 内。
  const signPreview = ['XDT_ANDROID_KEYSTORE_PATH', 'XDT_ANDROID_KEY_ALIAS', 'XDT_ANDROID_KEYSTORE_PASSWORD', 'XDT_ANDROID_KEY_PASSWORD']
    .map((name) => `${name}=${env[name]?.trim() ? (name.includes('PASSWORD') ? 'set' : env[name].trim()) : '未设'}`)
    .join(' ');
  console.log(`sign: 自有 keystore 自签(零代码默认值,--execute 构建时四项 env 必填;${signPreview}),终版,不经任何重签`);
  console.log(`steps: prebuild → patch build.gradle 签名 → gradlew assembleRelease → 从 APK 回读 runtimeVersion → APK 直传 OSS(${CDN_BASE}/mobile-dist/android/)→ 写 release.json`);
  // XDT_ANDROID_VERSION_CODE 非 EXPO_PUBLIC 前缀,但经 app.config.js 写进原生 versionCode,一并列出
  for (const line of formatBakedEnvLines(env, { extraKeys: ['XDT_ANDROID_VERSION_CODE'] })) console.log(line);
  if (!args.execute) {
    console.log('dry-run: 传 --execute 才真正构建 + 上传(需 Android SDK + JDK 17 + keystore 口令 env + OSS AK/SK env)');
    return;
  }

  // 必需 public env 齐全,否则 prebuild/gradle 会把空 auth-server 配置等烤进整包,
  // 装机后登录崩(与 release-prod/beta / OTA 脚本用同一 gate)。建议 eas env:exec production 包裹。
  assertPublicEnv(env, { variant: 'production' });

  const apkPath = args.apk ? resolve(String(args.apk)) : buildApk(env);
  log(`  ✓ apk: ${apkPath}`);

  // 权威 runtimeVersion = 真正烤进 APK 的 assets/fingerprint(客户端运行时就读它比对是否需要整包更新)。
  // 对 --apk 复用外部包同样成立:读该包内嵌值,保证 release.json 宣告的与装机包内嵌的严格一致。
  const runtimeVersion = readEmbeddedRuntimeVersionFromApk(apkPath);
  writeRuntimeFile(runtimeVersion);
  log(`  ✓ runtimeVersion(读自 APK 内嵌 assets/fingerprint): ${runtimeVersion}`);

  // --skip-upload(旧名 --skip-npkg 兼容):只构建,跳过上传与版本记录。
  if (args.skipUpload || args.skipNpkg) { log('  --skip-upload:跳过上传与版本记录'); return; }
  // 上传前校验 APK 内嵌 manifest 与目标一致(尤其 --apk 传外部预构包:stale / 包名错的包
  // 若直传 OSS 并写进 release.json,会成为广播更新却装不上已装应用)。
  validateApkMetadata(apkPath, SELFHOST_PACKAGE, versionCode, { required: Boolean(args.apk) });
  const client = createOSSClient();
  const installUrl = await uploadApkToOSS(client, apkPath, version, versionCode);

  if (!args.skipRecord) {
    const record = buildReleaseRecord({
      version, buildNumber: versionCode, runtimeVersion,
      installUrl,
      releaseNotes: message || undefined,
    });
    await uploadReleaseRecord(client, record);
  }

  console.log('');
  console.log('==================== 冷更发布完成 ====================');
  console.log(`  runtimeVersion : ${runtimeVersion}`);
  console.log(`  install        : ${installUrl}`);
  console.log('  下一步:纯 JS 改动用 `pnpm mobile:release:android:ota -- --execute` 发热更(复用此 runtimeVersion)');
  if (autoBumped) {
    console.log(`  ⚠ android-version.json versionCode 已自动 bump 为 ${versionCode},记得 commit + push 回 main(否则下次 git 闸门会拦)`);
  }
  console.log('======================================================');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
