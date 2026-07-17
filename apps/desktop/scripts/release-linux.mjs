#!/usr/bin/env node

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  CDN_BASE,
  DESKTOP_ROOT,
  LINUX_PLATFORM_KEY,
  OSS_PREFIX,
  PACKAGED_APP_NAME,
  RELEASE_DIR,
  createLinuxFirstReleaseManifest,
  createOSSClient,
  ensureLinuxRuntimeAssets,
  fetchExistingManifestIfAvailable,
  fetchReferenceManifest,
  findInstallerArtifact,
  loadDotenv,
  logLinuxPackagingRequirements,
  maybeBuildClaudeCodeGz,
  maybeBuildCodexGz,
  runDbValidate,
  sha256,
  uploadToOSS,
  uploadVersionedGzImmutable,
  writePackageVersion,
  writeReleaseManifest, assertNotPublishingCindyToLegacyChannel } from './ci/lib.mjs';
import { productionViteEnv } from '../../../scripts/shared/production-endpoints.mjs';

loadDotenv();
// 渠道冻结硬闸:Cindy 布局产物禁止发布到老 /xdt-maker 前缀(见 lib.mjs)。
assertNotPublishingCindyToLegacyChannel(OSS_PREFIX);

const PLATFORM_KEY = LINUX_PLATFORM_KEY;
const INSTALLER_EXT = 'deb';
const REFERENCE_PLATFORM_KEYS = ['linux-x64', 'darwin-arm64', 'darwin-x64', 'win32-x64'];

// Linux first release currently ships as a .deb installer via MakerDeb.
// This intentionally keeps the reviewed first-release updater posture:
// installer/manual-download only, with no `app.hotfix` published.

function parseArgs() {
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  return { versionArg: positional[0] ?? null };
}

function bumpPatch(version) {
  const parts = version.split('.');
  parts[2] = String(Number(parts[2]) + 1);
  return parts.join('.');
}

function resolveNextVersion(currentVersion, versionArg) {
  if (versionArg === 'major') {
    const parts = currentVersion.split('.');
    return `${Number(parts[0]) + 1}.0.0`;
  }
  if (versionArg === 'minor') {
    const parts = currentVersion.split('.');
    return `${parts[0]}.${Number(parts[1]) + 1}.0`;
  }
  if (versionArg === 'patch' || !versionArg) {
    return bumpPatch(currentVersion);
  }
  return versionArg;
}

async function main() {
  const { versionArg } = parseArgs();

  const linuxManifest = await fetchExistingManifestIfAvailable(PLATFORM_KEY);
  const reference = linuxManifest
    ? { manifest: linuxManifest, platformKey: PLATFORM_KEY }
    : await fetchReferenceManifest(REFERENCE_PLATFORM_KEYS.filter((key) => key !== PLATFORM_KEY));
  const versionBaseline = linuxManifest?.app?.version || reference.manifest.app.version;
  const version = resolveNextVersion(versionBaseline, versionArg);

  console.log(`==> Linux release version: ${version}`);
  if (!linuxManifest) {
    console.log(`==> No existing Linux manifest. Using ${reference.platformKey} as version/release-notes baseline.`);
  }

  await ensureLinuxRuntimeAssets({ label: 'Linux release assets' });
  logLinuxPackagingRequirements();
  writePackageVersion(version);
  runDbValidate();

  const outDir = path.join(DESKTOP_ROOT, 'out');
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  console.log('==> Building remote bundles...');
  execSync('node scripts/build-remote-bundles.mjs', {
    cwd: DESKTOP_ROOT,
    stdio: 'inherit',
  });

  console.log('==> Running electron-forge make for Linux x64...');
  execSync('npx electron-forge make --platform linux --arch x64', {
    cwd: DESKTOP_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ...productionViteEnv({ allowEnvOverride: false }),
      APP_VERSION: version,
    },
  });

  const packagedDir = path.join(DESKTOP_ROOT, 'out', `${PACKAGED_APP_NAME}-${PLATFORM_KEY}`);
  if (!fs.existsSync(packagedDir)) {
    console.error(`ERROR: packaged dir not found: ${packagedDir}`);
    process.exit(1);
  }

  console.log('==> Running packaged smoke test...');
  execSync('node scripts/smoke-packaged.mjs --platform=linux --arch=x64', {
    cwd: DESKTOP_ROOT,
    stdio: 'inherit',
  });

  const installerPath = findInstallerArtifact(path.join(DESKTOP_ROOT, 'out', 'make'), INSTALLER_EXT);
  if (!installerPath) {
    console.error('ERROR: Linux installer not found under out/make.');
    process.exit(1);
  }

  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  const installerName = `xdt-maker-${version}.${INSTALLER_EXT}`;
  const releaseInstallerPath = path.join(RELEASE_DIR, installerName);
  fs.copyFileSync(installerPath, releaseInstallerPath);

  const manifest = createLinuxFirstReleaseManifest(version, linuxManifest ?? reference.manifest);
  if (!linuxManifest) {
    manifest.claudeCode = {
      version: '0.0.0',
      file: '',
      sha256: '',
      size: 0,
    };
    delete manifest.codex;
  }
  manifest.app.installer = {
    file: `app/${PLATFORM_KEY}/${installerName}`,
    sha256: sha256(releaseInstallerPath),
    size: fs.statSync(releaseInstallerPath).size,
  };

  // OSS client 提前创建:claude/codex 段的 immutable 守卫需要先查/传远端对象,
  // 再用其返回值写 manifest(先 binary → 后 manifest 的顺序铁律)。
  const client = createOSSClient();

  const claude = await maybeBuildClaudeCodeGz({
    platformKey: PLATFORM_KEY,
    manifest,
    binaryName: 'claude',
  });
  if (claude) {
    // immutable 守卫上传:同版本路径已存在同源对象时复用远端 sha256/size(不覆盖);
    // 存在不同内容时抛错中止发版。见 ci/lib.mjs uploadVersionedGzImmutable 注释。
    const ccFileRel = `claude-code/${claude.localCCVersion}/${PLATFORM_KEY}/${claude.gzName}`;
    console.log(`    Uploading ${claude.gzName} -> ${OSS_PREFIX}/${ccFileRel}`);
    const ccPub = await uploadVersionedGzImmutable({
      client,
      ossKey: `${OSS_PREFIX}/${ccFileRel}`,
      gzPath: claude.gzPath,
      gzSha256: claude.ccHash,
      gzSize: claude.ccSize,
      binarySha256: claude.localBinHash,
    });
    manifest.claudeCode = {
      version: claude.localCCVersion,
      file: ccFileRel,
      sha256: ccPub.gzSha256,
      size: ccPub.gzSize,
      binarySha256: ccPub.binarySha256,
    };
  }
  if (!manifest.claudeCode?.file) {
    throw new Error('Linux release requires a valid claudeCode manifest entry.');
  }

  const codex = await maybeBuildCodexGz({
    platformKey: PLATFORM_KEY,
    manifest,
    binaryName: 'codex',
  });
  if (codex) {
    // immutable 守卫上传:同 claude 段。
    const codexFileRel = `codex/${codex.localCodexVersion}/${PLATFORM_KEY}/${codex.gzName}`;
    console.log(`    Uploading ${codex.gzName} -> ${OSS_PREFIX}/${codexFileRel}`);
    const codexPub = await uploadVersionedGzImmutable({
      client,
      ossKey: `${OSS_PREFIX}/${codexFileRel}`,
      gzPath: codex.gzPath,
      gzSha256: codex.codexHash,
      gzSize: codex.codexSize,
      binarySha256: codex.localBinHash,
    });
    manifest.codex = {
      version: codex.localCodexVersion,
      file: codexFileRel,
      sha256: codexPub.gzSha256,
      size: codexPub.gzSize,
      binarySha256: codexPub.binarySha256,
    };
  }
  if (!manifest.codex?.file) {
    throw new Error('Linux release requires a valid codex manifest entry.');
  }

  const manifestPath = path.join(RELEASE_DIR, `manifest-${PLATFORM_KEY}-canary.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  console.log('==> Uploading Linux installer + manifest to OSS...');
  await uploadToOSS(
    client,
    `${OSS_PREFIX}/app/${PLATFORM_KEY}/${installerName}`,
    releaseInstallerPath,
  );
  await uploadToOSS(
    client,
    `${OSS_PREFIX}/manifest-${PLATFORM_KEY}-canary.json`,
    manifestPath,
    { headers: { 'Cache-Control': 'no-cache' } },
  );

  const releaseManifestPath = path.join(
    RELEASE_DIR,
    `manifest-release-${PLATFORM_KEY}-${version}.json`,
  );
  writeReleaseManifest(releaseManifestPath, { version, platformKey: PLATFORM_KEY, arch: 'x64' });

  console.log('=== Linux release complete ===');
  console.log(`Installer: ${CDN_BASE}/app/${PLATFORM_KEY}/${installerName}`);
  console.log(`Manifest:  ${CDN_BASE}/manifest-${PLATFORM_KEY}-canary.json`);
  console.log('\n  -> Publish to stable: pnpm release:promote:linux');
  console.log('Note: Linux manifest intentionally omits app.hotfix in first release.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
