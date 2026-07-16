#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  CDN_BASE,
  DESKTOP_ROOT,
  LINUX_PLATFORM_KEY,
  OSS_PREFIX,
  RELEASE_DIR,
  createLinuxFirstReleaseManifest,
  createOSSClient,
  fetchExistingManifestIfAvailable,
  fetchReferenceManifest,
  findInstallerArtifact,
  loadDotenv,
  maybeBuildClaudeCodeGz,
  maybeBuildCodexGz,
  sha256,
  uploadToOSS,
  uploadVersionedGzImmutable,
  writeReleaseManifest,
} from './lib.mjs';

loadDotenv();

const PLATFORM_KEY = LINUX_PLATFORM_KEY;
const REFERENCE_PLATFORM_KEYS = ['linux-x64', 'darwin-arm64', 'darwin-x64', 'win32-x64'];

// Linux first release currently publishes a .deb installer via MakerDeb.
// Keep `app.hotfix` absent and treat this as installer-only/manual-download
// posture until a reviewed AppImage or updater design replaces it.

function parseArgs() {
  const args = process.argv.slice(2);
  let version = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version' && args[i + 1]) version = args[++i];
  }
  if (!version) {
    console.error('ERROR: --version <x.y.z> is required');
    process.exit(1);
  }
  return { version };
}

async function main() {
  const { version } = parseArgs();
  const installerPath = findInstallerArtifact(path.join(DESKTOP_ROOT, 'out', 'make'), 'deb');
  if (!installerPath) {
    console.error('ERROR: Linux .deb artifact not found. Run build-linux first.');
    process.exit(1);
  }

  const linuxManifest = await fetchExistingManifestIfAvailable(PLATFORM_KEY);
  const reference = linuxManifest
    ? { manifest: linuxManifest, platformKey: PLATFORM_KEY }
    : await fetchReferenceManifest(REFERENCE_PLATFORM_KEYS.filter((key) => key !== PLATFORM_KEY));

  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  const installerName = `xdt-maker-${version}.deb`;
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
    // 存在不同内容时抛错中止发布。见 lib.mjs uploadVersionedGzImmutable 注释。
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
    throw new Error('Linux publish requires a valid claudeCode manifest entry.');
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
    throw new Error('Linux publish requires a valid codex manifest entry.');
  }

  const manifestPath = path.join(RELEASE_DIR, `manifest-${PLATFORM_KEY}-canary.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

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

  console.log(`Installer: ${CDN_BASE}/app/${PLATFORM_KEY}/${installerName}`);
  console.log(`Manifest:  ${CDN_BASE}/manifest-${PLATFORM_KEY}-canary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
