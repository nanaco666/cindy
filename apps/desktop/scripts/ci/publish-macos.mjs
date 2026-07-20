#!/usr/bin/env node

// =============================================================================
// publish-macos.mjs — CI 发布阶段：签名 + 公证 + DMG + 上传 OSS + 更新 manifest
//
// 用法: node scripts/ci/publish-macos.mjs --arch <arm64|x64> --version <x.y.z>
//
// 必需的环境变量:
//   FP_DEV_OSS_ACCESS_KEY_ID       — 阿里云 AK
//   FP_DEV_OSS_ACCESS_KEY_SECRET   — 阿里云 SK
//   APPLE_APP_PASSWORD             — Apple 公证密码
// 可选:
//   APPLE_ID / APPLE_TEAM_ID / APPLE_SIGN_IDENTITY — 由 release-regions.json 的
//   macSigning 注入或 env 显式提供(无代码默认值,缺失报错;本脚本属 cn 单渠道
//   legacy CI 线,默认应用 cn.macSigning)
//
// 前置条件:
//   build-macos.mjs 已执行成功，out/<PACKAGED_APP_NAME>-darwin-<arch>/<PACKAGED_APP_NAME>.app 存在
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import {
  DESKTOP_ROOT,
  RELEASE_DIR,
  CDN_BASE,
  OSS_PREFIX,
  loadDotenv,
  exec,
  sha256,
  fetchExistingManifest,
  writeReleaseManifest,
  maybeBuildClaudeCodeGz,
  createOSSClient,
  uploadToOSS,
  uploadVersionedGzImmutable,
  writeMacEntitlements,
  resolveAppleIdentity,
  signMacAppWithIdentity,
  notarizeMacApp,
  createMacDMG,
  PACKAGED_APP_NAME, assertNotPublishingCindyToLegacyChannel } from './lib.mjs';
import { applyMacSigningConfigToEnv } from './release-regions.mjs';

loadDotenv();
// 渠道冻结硬闸:Cindy 布局产物禁止发布到老 /xdt-maker 前缀(见 lib.mjs)。
assertNotPublishingCindyToLegacyChannel(OSS_PREFIX);

// ── 参数解析 ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let arch = null;
  let version = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--arch' && args[i + 1]) { arch = args[++i]; continue; }
    if (args[i] === '--version' && args[i + 1]) { version = args[++i]; continue; }
  }
  if (!arch || !['arm64', 'x64'].includes(arch)) {
    console.error('ERROR: --arch <arm64|x64> is required');
    process.exit(1);
  }
  if (!version) {
    console.error('ERROR: --version <x.y.z> is required');
    process.exit(1);
  }
  return { arch, version };
}

// ── 环境变量校验 ──────────────────────────────────────────────────────────

// 身份解析单点在 lib.mjs 的 resolveAppleIdentity(零默认值);本脚本是 cn 单渠道
// legacy CI 线,先应用 cn.macSigning(文件缺失时要求 env 显式提供)。
applyMacSigningConfigToEnv('cn');
const { appleId: APPLE_ID, teamId: APPLE_TEAM_ID, signIdentity: SIGN_IDENTITY } = resolveAppleIdentity();
const APPLE_APP_PASSWORD = process.env.APPLE_APP_PASSWORD;

if (!APPLE_APP_PASSWORD) {
  console.error('ERROR: APPLE_APP_PASSWORD is required for notarization.');
  console.error('       Set it in CI Variables or apps/desktop/.env');
  process.exit(1);
}

// ── Signing & Notarization ────────────────────────────────────────────────
// 实现已收进 lib.mjs(signMacAppWithIdentity / notarizeMacApp / createMacDMG,
// 与 package-desktop.mjs 共用);这里只保留绑定本脚本 Apple 身份的薄封装。

const APPLE_IDENTITY = {
  appleId: APPLE_ID,
  teamId: APPLE_TEAM_ID,
  signIdentity: SIGN_IDENTITY,
  applePassword: APPLE_APP_PASSWORD,
};

function signApp(appPath, helperEntitlementsPath, mainEntitlementsPath) {
  signMacAppWithIdentity(appPath, helperEntitlementsPath, mainEntitlementsPath, APPLE_IDENTITY);
}

function notarizeApp(appPath) {
  notarizeMacApp(appPath, APPLE_IDENTITY);
}

function createDMG(appPath, dmgPath, volumeName) {
  createMacDMG(appPath, dmgPath, volumeName, APPLE_IDENTITY);
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const { arch, version } = parseArgs();
  const platformKey = `darwin-${arch}`;

  console.log('='.repeat(60));
  console.log(`==> Publish macOS ${arch}, version ${version}`);
  console.log('='.repeat(60));

  // 0. 前置：确保 build 阶段产物存在
  const packagedDir = path.join(DESKTOP_ROOT, 'out', `${PACKAGED_APP_NAME}-darwin-${arch}`);
  const appPath = path.join(packagedDir, `${PACKAGED_APP_NAME}.app`);
  if (!fs.existsSync(appPath)) {
    console.error(`ERROR: ${appPath} not found.`);
    console.error(`       Run: node scripts/ci/build-macos.mjs --arch ${arch} --version ${version}`);
    process.exit(1);
  }
  console.log(`==> Using pre-built app: ${appPath}`);

  // 1. 准备 entitlements + release dir
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  const helperEntitlementsPath = path.join(RELEASE_DIR, 'build-helper.entitlements');
  const mainEntitlementsPath = path.join(RELEASE_DIR, 'build-main.entitlements');
  writeMacEntitlements(helperEntitlementsPath);
  writeMacEntitlements(mainEntitlementsPath, { appleEvents: true });

  // 2. Sign + Notarize
  console.log('==> Signing...');
  signApp(appPath, helperEntitlementsPath, mainEntitlementsPath);

  console.log('==> Notarizing...');
  notarizeApp(appPath);

  // 3. Create DMG (contains signed + notarized .app)
  const dmgName = `xdt-maker-${version}-${arch}.dmg`;
  const dmgPath = path.join(RELEASE_DIR, dmgName);
  console.log('==> Creating DMG...');
  createDMG(appPath, dmgPath, `xdt-maker ${version}`);

  const dmgHash = sha256(dmgPath);
  const dmgSize = fs.statSync(dmgPath).size;
  console.log(`    DMG SHA256: ${dmgHash}`);
  console.log(`    DMG Size:   ${(dmgSize / 1024 / 1024).toFixed(1)} MB`);

  // 4. Hotfix ZIP (from packaged dir, for auto-update)
  const hotfixZipName = `xdt-maker-${version}-${arch}.zip`;
  const hotfixZipPath = path.join(RELEASE_DIR, hotfixZipName);
  console.log('==> Creating hotfix ZIP...');
  if (fs.existsSync(hotfixZipPath)) fs.unlinkSync(hotfixZipPath);
  exec(`/usr/bin/ditto -c -k "${packagedDir}" "${hotfixZipPath}"`);

  const zipHash = sha256(hotfixZipPath);
  const zipSize = fs.statSync(hotfixZipPath).size;
  console.log(`    ZIP SHA256: ${zipHash}`);
  console.log(`    ZIP Size:   ${(zipSize / 1024 / 1024).toFixed(1)} MB`);

  // 5. Update manifest
  const manifest = await fetchExistingManifest(platformKey);
  manifest.app.version = version;
  manifest.app.hotfix = {
    file: `hotfix/${platformKey}/${hotfixZipName}`,
    sha256: zipHash,
    size: zipSize,
  };
  manifest.app.installer = {
    file: `app/${platformKey}/${dmgName}`,
    sha256: dmgHash,
    size: dmgSize,
  };

  // 6. Claude Code (compare version + hash)
  const client = createOSSClient();
  const cc = await maybeBuildClaudeCodeGz({
    platformKey,
    manifest,
    binaryName: 'claude',
  });
  if (cc) {
    // immutable 守卫上传:同版本路径已存在同源对象时复用远端 sha256/size(不覆盖);
    // 存在不同内容时抛错中止发布。见 lib.mjs uploadVersionedGzImmutable 注释。
    const ccFileRel = `claude-code/${cc.localCCVersion}/${platformKey}/claude.gz`;
    console.log(`    Uploading claude.gz → ${OSS_PREFIX}/${ccFileRel}`);
    const ccPub = await uploadVersionedGzImmutable({
      client,
      ossKey: `${OSS_PREFIX}/${ccFileRel}`,
      gzPath: cc.gzPath,
      gzSha256: cc.ccHash,
      gzSize: cc.ccSize,
      binarySha256: cc.localBinHash,
    });
    manifest.claudeCode = {
      version: cc.localCCVersion,
      file: ccFileRel,
      sha256: ccPub.gzSha256,
      size: ccPub.gzSize,
      binarySha256: ccPub.binarySha256,
    };
  }

  const manifestPath = path.join(RELEASE_DIR, `manifest-${platformKey}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // 7. Upload to OSS (claude gz 已在上面经 immutable 守卫处理)
  console.log('==> Uploading to OSS...');

  const dmgOssKey = `${OSS_PREFIX}/app/${platformKey}/${dmgName}`;
  console.log(`    Uploading ${dmgName} → ${dmgOssKey}`);
  await uploadToOSS(client, dmgOssKey, dmgPath);

  const zipOssKey = `${OSS_PREFIX}/hotfix/${platformKey}/${hotfixZipName}`;
  console.log(`    Uploading ${hotfixZipName} → ${zipOssKey}`);
  await uploadToOSS(client, zipOssKey, hotfixZipPath);

  const manifestOssKey = `${OSS_PREFIX}/manifest-${platformKey}.json`;
  console.log(`    Uploading manifest-${platformKey}.json → ${manifestOssKey}`);
  await uploadToOSS(client, manifestOssKey, manifestPath, {
    headers: { 'Cache-Control': 'no-cache' },
  });

  // 8. Release manifest (本次构建的元数据)
  const releaseManifestPath = path.join(
    RELEASE_DIR,
    `manifest-release-${platformKey}-${version}.json`,
  );
  writeReleaseManifest(releaseManifestPath, { version, platformKey, arch });

  console.log('');
  console.log('=== Publish complete ===');
  console.log(`App:      ${version}`);
  console.log(`DMG:      ${CDN_BASE}/app/${platformKey}/${dmgName}`);
  console.log(`Hotfix:   ${CDN_BASE}/hotfix/${platformKey}/${hotfixZipName}`);
  console.log(`Manifest: ${CDN_BASE}/manifest-${platformKey}.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
