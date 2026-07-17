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
//   APPLE_ID                       — 默认 jiali@magiclizi.com
//   APPLE_TEAM_ID                  — 默认 WJ6LYABL8Z
//   APPLE_SIGN_IDENTITY            — 默认 Developer ID Application: Jiali Liu (WJ6LYABL8Z)
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
  verifyMacContactsPermissions,
  resolveAppleIdentity,
  PACKAGED_APP_NAME, assertNotPublishingCindyToLegacyChannel } from './lib.mjs';

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

// 身份默认值单点在 lib.mjs 的 resolveAppleIdentity(loadDotenv() 之后调用,.env 覆盖生效)。
const { appleId: APPLE_ID, teamId: APPLE_TEAM_ID, signIdentity: SIGN_IDENTITY } = resolveAppleIdentity();
const APPLE_APP_PASSWORD = process.env.APPLE_APP_PASSWORD;

if (!APPLE_APP_PASSWORD) {
  console.error('ERROR: APPLE_APP_PASSWORD is required for notarization.');
  console.error('       Set it in CI Variables or apps/desktop/.env');
  process.exit(1);
}

// ── Signing & Notarization ────────────────────────────────────────────────

function signApp(appPath, helperEntitlementsPath, mainEntitlementsPath) {
  console.log('    Removing provenance attributes...');
  exec(`/usr/bin/xattr -dr com.apple.provenance "${appPath}" 2>/dev/null || true`);

  // Electron apps must be signed from inside out — `--deep` doesn't
  // reliably timestamp nested Helper apps and frameworks.
  const signBase = `/usr/bin/codesign --force --timestamp --options runtime --sign "${SIGN_IDENTITY}"`;
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');

  // 0. Native modules in app.asar.unpacked/ (e.g. better_sqlite3.node)
  //    AutoUnpackNativesPlugin 把 *.node 解包到 app.asar.unpacked/ 后是独立文件，
  //    不在这里单签的话 Gatekeeper 会拒绝加载，app 直接打不开。
  const asarUnpackedDir = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked');
  if (fs.existsSync(asarUnpackedDir)) {
    console.log('    Signing native modules in app.asar.unpacked/...');
    exec(`find "${asarUnpackedDir}" -type f | while IFS= read -r f; do if file "$f" | grep -qE "Mach-O"; then ${signBase} "$f"; fi; done`);
  }

  // 0b. Bundled CLI tools under Contents/Resources/tools/ (ripgrep, voice
  // input text insertion helper). They are copied as extraResource, outside the
  // app binary and outside app.asar.unpacked, so notarization needs them signed
  // explicitly.
  const resourceToolsDir = path.join(appPath, 'Contents', 'Resources', 'tools');
  if (fs.existsSync(resourceToolsDir)) {
    console.log('    Signing bundled CLI tools in Contents/Resources/tools/...');
    exec(`find "${resourceToolsDir}" -type f | while IFS= read -r f; do if file "$f" | grep -qE "Mach-O"; then ${signBase} "$f"; fi; done`);
  }

  // 1. ALL Mach-O binaries (libraries, executables like chrome_crashpad_handler, ShipIt, etc.)
  console.log('    Signing all Mach-O binaries...');
  exec(`find "${frameworksDir}" -type f | while IFS= read -r f; do if file "$f" | grep -qE "Mach-O"; then ${signBase} "$f"; fi; done`);

  // 2. Helper apps (need entitlements for V8 JIT)
  console.log('    Signing helper apps...');
  exec(`find "${frameworksDir}" -name "*.app" -exec ${signBase} --entitlements "${helperEntitlementsPath}" {} \\;`);

  // 3. Framework bundles
  console.log('    Signing frameworks...');
  exec(`find "${frameworksDir}" -maxdepth 1 -name "*.framework" -exec ${signBase} {} \\;`);

  // 4. Main app bundle
  console.log('    Signing main app...');
  exec(`${signBase} --entitlements "${mainEntitlementsPath}" "${appPath}"`);

  // Verify entire bundle
  console.log('    Verifying signature...');
  exec(`/usr/bin/codesign --verify --deep --strict "${appPath}"`);
  verifyMacContactsPermissions(appPath);
}

function notarizeApp(appPath) {
  const zipPath = appPath + '.zip';

  console.log('    Compressing for notarization...');
  exec(`/usr/bin/ditto -c -k --keepParent "${appPath}" "${zipPath}"`);

  console.log('    Submitting to Apple notarization service (this may take a few minutes)...');
  exec(
    `/usr/bin/xcrun notarytool submit "${zipPath}" ` +
    `--apple-id "${APPLE_ID}" --password "${APPLE_APP_PASSWORD}" ` +
    `--team-id "${APPLE_TEAM_ID}" --wait`,
    { timeout: 1800000 }, // 30 min
  );

  fs.unlinkSync(zipPath);

  console.log('    Stapling notarization ticket...');
  exec(`/usr/bin/xcrun stapler staple "${appPath}"`);
}

function createDMG(appPath, dmgPath, volumeName) {
  const stagingDir = dmgPath + '.staging';

  if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  exec(`cp -R "${appPath}" "${stagingDir}/"`);
  fs.symlinkSync('/Applications', path.join(stagingDir, 'Applications'));

  if (fs.existsSync(dmgPath)) fs.unlinkSync(dmgPath);
  console.log('    Creating DMG...');
  exec(`/usr/bin/hdiutil create "${dmgPath}" -volname "${volumeName}" -srcfolder "${stagingDir}" -ov -format UDZO`);

  console.log('    Signing DMG...');
  exec(`/usr/bin/codesign --force --timestamp --sign "${SIGN_IDENTITY}" "${dmgPath}"`);

  fs.rmSync(stagingDir, { recursive: true });
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
