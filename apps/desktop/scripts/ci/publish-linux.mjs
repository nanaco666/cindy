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
  sha256,
  uploadToOSS,
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
  manifest.app.installer = {
    file: `app/${PLATFORM_KEY}/${installerName}`,
    sha256: sha256(releaseInstallerPath),
    size: fs.statSync(releaseInstallerPath).size,
  };

  const client = createOSSClient();

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
