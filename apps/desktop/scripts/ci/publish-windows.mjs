#!/usr/bin/env node

// =============================================================================
// publish-windows.mjs — CI 发布阶段：签名 + ZIP + 上传 OSS + 更新 manifest
//
// 用法: node scripts/ci/publish-windows.mjs --version <x.y.z>
//
// 必需的环境变量:
//   FP_DEV_OSS_ACCESS_KEY_ID       — 阿里云 AK
//   FP_DEV_OSS_ACCESS_KEY_SECRET   — 阿里云 SK
// 可选:
//   NPKG_TOKEN                     — Windows 代码签名令牌 (不设置则跳过签名)
//
// 前置条件:
//   build-windows.mjs 已执行成功，out/<PACKAGED_APP_NAME>-win32-x64/ 与 out/make/.../*Setup.exe 存在
// =============================================================================

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DESKTOP_ROOT,
  RELEASE_DIR,
  CDN_BASE,
  OSS_PREFIX,
  loadDotenv,
  sha256,
  fetchExistingManifest,
  writeReleaseManifest,
  maybeBuildClaudeCodeGz,
  createOSSClient,
  uploadToOSS,
  uploadVersionedGzImmutable,
  PACKAGED_APP_NAME, assertNotPublishingCindyToLegacyChannel } from './lib.mjs';

loadDotenv();
// 渠道冻结硬闸:Cindy 布局产物禁止发布到老 /xdt-maker 前缀(见 lib.mjs)。
assertNotPublishingCindyToLegacyChannel(OSS_PREFIX);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, '..');
const PLATFORM_KEY = 'win32-x64';

// ── 参数解析 ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let version = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version' && args[i + 1]) { version = args[++i]; continue; }
  }
  if (!version) {
    console.error('ERROR: --version <x.y.z> is required');
    process.exit(1);
  }
  return { version };
}

// ── 找 Setup.exe ──────────────────────────────────────────────────────────

function findSetupExe(makeBaseDir) {
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (entry.name.endsWith('.exe') && entry.name.toLowerCase().includes('setup')) {
        return full;
      }
    }
    return null;
  }
  return walk(makeBaseDir);
}

// ── npkg Code Signing ─────────────────────────────────────────────────────

function signWindowsExe(exePath, token) {
  const signScript = path.join(SCRIPTS_DIR, 'sign.py');
  execSync(`python "${signScript}" "${path.resolve(exePath)}" "${token}"`, {
    stdio: 'inherit',
  });
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const { version } = parseArgs();

  console.log('='.repeat(60));
  console.log(`==> Publish Windows x64, version ${version}`);
  console.log('='.repeat(60));

  // 0. 前置：确保 build 阶段产物存在
  const packagedDir = path.join(DESKTOP_ROOT, 'out', `${PACKAGED_APP_NAME}-win32-x64`);
  if (!fs.existsSync(packagedDir)) {
    console.error(`ERROR: ${packagedDir} not found.`);
    console.error(`       Run: node scripts/ci/build-windows.mjs --version ${version}`);
    process.exit(1);
  }
  const makeBaseDir = path.join(DESKTOP_ROOT, 'out', 'make');
  const exePath = findSetupExe(makeBaseDir);
  if (!exePath) {
    console.error(`ERROR: No Setup.exe found under ${makeBaseDir}`);
    console.error(`       Run: node scripts/ci/build-windows.mjs --version ${version}`);
    process.exit(1);
  }
  console.log(`==> Using pre-built packaged dir: ${packagedDir}`);
  console.log(`==> Using pre-built installer:    ${exePath}`);

  // 1. 准备 release 目录
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  const releaseExeName = `xdt-maker-${version}-Setup.exe`;
  const releaseExePath = path.join(RELEASE_DIR, releaseExeName);
  fs.copyFileSync(exePath, releaseExePath);

  // 2. 代码签名 (可选，需要 NPKG_TOKEN)
  const npkgToken = process.env.NPKG_TOKEN;
  if (npkgToken) {
    console.log('==> Signing installer via npkg...');
    signWindowsExe(releaseExePath, npkgToken);
  } else {
    console.log('==> NPKG_TOKEN not set, skipping code signing');
  }

  // 3. 计算 SHA256 + size (签名后再算)
  const exeHash = sha256(releaseExePath);
  const exeSize = fs.statSync(releaseExePath).size;
  console.log(`==> Installer: ${releaseExeName}`);
  console.log(`    SHA256: ${exeHash}`);
  console.log(`    Size:   ${(exeSize / 1024 / 1024).toFixed(1)} MB`);

  // 4. Hotfix ZIP (from packaged dir)
  const hotfixZipName = `xdt-maker-${version}.zip`;
  const hotfixZipPath = path.join(RELEASE_DIR, hotfixZipName);
  console.log('==> Creating hotfix ZIP from packaged app...');
  if (fs.existsSync(hotfixZipPath)) fs.unlinkSync(hotfixZipPath);
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${packagedDir}\\*' -DestinationPath '${hotfixZipPath}'"`,
    { stdio: 'inherit' },
  );
  const zipHash = sha256(hotfixZipPath);
  const zipSize = fs.statSync(hotfixZipPath).size;
  console.log(`    ZIP SHA256: ${zipHash}`);
  console.log(`    ZIP Size:   ${(zipSize / 1024 / 1024).toFixed(1)} MB`);

  // 5. Update manifest
  const manifest = await fetchExistingManifest(PLATFORM_KEY);
  manifest.app.version = version;
  manifest.app.hotfix = {
    file: `hotfix/${PLATFORM_KEY}/${hotfixZipName}`,
    sha256: zipHash,
    size: zipSize,
  };
  manifest.app.installer = {
    file: `app/${PLATFORM_KEY}/${releaseExeName}`,
    sha256: exeHash,
    size: exeSize,
  };

  // 6. Claude Code (compare version + hash)
  const client = createOSSClient();
  const cc = await maybeBuildClaudeCodeGz({
    platformKey: PLATFORM_KEY,
    manifest,
    binaryName: 'claude.exe',
  });
  if (cc) {
    // immutable 守卫上传:同版本路径已存在同源对象时复用远端 sha256/size(不覆盖);
    // 存在不同内容时抛错中止发布。见 lib.mjs uploadVersionedGzImmutable 注释。
    const ccFileRel = `claude-code/${cc.localCCVersion}/${PLATFORM_KEY}/claude.exe.gz`;
    console.log(`    Uploading claude.exe.gz → ${OSS_PREFIX}/${ccFileRel}`);
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

  const manifestPath = path.join(RELEASE_DIR, `manifest-${PLATFORM_KEY}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // 7. Upload to OSS (claude gz 已在上面经 immutable 守卫处理)
  console.log('==> Uploading to OSS...');

  const exeOssKey = `${OSS_PREFIX}/app/${PLATFORM_KEY}/${releaseExeName}`;
  console.log(`    Uploading ${releaseExeName} → ${exeOssKey}`);
  await uploadToOSS(client, exeOssKey, releaseExePath);

  const zipOssKey = `${OSS_PREFIX}/hotfix/${PLATFORM_KEY}/${hotfixZipName}`;
  console.log(`    Uploading ${hotfixZipName} → ${zipOssKey}`);
  await uploadToOSS(client, zipOssKey, hotfixZipPath);

  const manifestOssKey = `${OSS_PREFIX}/manifest-${PLATFORM_KEY}.json`;
  console.log(`    Uploading manifest-${PLATFORM_KEY}.json → ${manifestOssKey}`);
  await uploadToOSS(client, manifestOssKey, manifestPath, {
    headers: { 'Cache-Control': 'no-cache' },
  });

  // 8. Release manifest
  const releaseManifestPath = path.join(
    RELEASE_DIR,
    `manifest-release-${PLATFORM_KEY}-${version}.json`,
  );
  writeReleaseManifest(releaseManifestPath, { version, platformKey: PLATFORM_KEY, arch: 'x64' });

  console.log('');
  console.log('=== Publish complete ===');
  console.log(`App:        ${version}`);
  console.log(`Installer:  ${CDN_BASE}/app/${PLATFORM_KEY}/${releaseExeName}`);
  console.log(`Hotfix ZIP: ${CDN_BASE}/hotfix/${PLATFORM_KEY}/${hotfixZipName}`);
  console.log(`Manifest:   ${CDN_BASE}/manifest-${PLATFORM_KEY}.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
