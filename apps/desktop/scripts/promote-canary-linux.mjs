#!/usr/bin/env node

/**
 * Promote the Linux canary manifest to stable.
 *
 * Linux release uploads manifest-linux-x64-canary.json first. Fresh packaged
 * installs read the stable manifest before login, so a real stable rollout must
 * promote the reviewed canary manifest to manifest-linux-x64.json.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CDN_BASE,
  LINUX_PLATFORM_KEY,
  OSS_PREFIX,
  createOSSClient,
  loadDotenv,
  uploadToOSS,
} from './ci/lib.mjs';

loadDotenv();

const PLATFORM_KEY = LINUX_PLATFORM_KEY;

function parseArgs() {
  const args = process.argv.slice(2);
  return { yes: args.includes('--yes') };
}

async function fetchManifest(channel) {
  const suffix = channel === 'canary' ? '-canary' : '';
  const url = `${CDN_BASE}/manifest-${PLATFORM_KEY}${suffix}.json?t=${Date.now()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    if (res.status === 404 && channel === 'stable') return { text: null, json: null };
    throw new Error(`Failed to fetch ${channel} manifest (${res.status}): ${url}`);
  }
  const text = await res.text();
  return { text, json: JSON.parse(text) };
}

function summarize(label, manifest) {
  console.log(`\n  ${label}:`);
  console.log(`    app.version:        ${manifest?.app?.version ?? '(none)'}`);
  console.log(`    app.installer.file: ${manifest?.app?.installer?.file ?? '(none)'}`);
  console.log(`    app.hotfix.file:    ${manifest?.app?.hotfix?.file ?? '(none)'}`);
  console.log(`    claudeCode.version: ${manifest?.claudeCode?.version ?? '(none)'}`);
  console.log(`    codex.version:      ${manifest?.codex?.version ?? '(none)'}`);
}

// 特例:app 上线前的老 stable manifest 只有 codex/claudeCode 段、没有 app.version
// (首次 app promote 必然命中),备份到 back-up/pre-app/ 目录而不是中止。
async function backupStableManifest(client, stableText, stableJson) {
  let version = stableJson?.app?.version;
  if (!version) {
    console.log('==> Current stable manifest has no app section (pre-app legacy); backing up to back-up/pre-app/');
    version = 'pre-app';
  }
  if (!/^[\w.+-]+$/.test(version)) {
    throw new Error(`Stable version contains invalid path characters: ${version}`);
  }

  const backupKey = `${OSS_PREFIX}/back-up/${version}/manifest-${PLATFORM_KEY}.json`;
  const tmpPath = path.join(os.tmpdir(), `manifest-${PLATFORM_KEY}-backup-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, stableText);
  try {
    console.log(`\n==> Backing up current stable to ${backupKey}`);
    await uploadToOSS(client, backupKey, tmpPath, {
      headers: { 'Cache-Control': 'no-cache' },
    });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

async function uploadStableManifest(client, canaryText) {
  const ossKey = `${OSS_PREFIX}/manifest-${PLATFORM_KEY}.json`;
  const tmpPath = path.join(os.tmpdir(), `manifest-${PLATFORM_KEY}-promote-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, canaryText);
  try {
    console.log(`\n==> Uploading canary manifest as stable: ${ossKey}`);
    await uploadToOSS(client, ossKey, tmpPath, {
      headers: { 'Cache-Control': 'no-cache' },
    });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

async function main() {
  const { yes } = parseArgs();

  console.log('=== Promote canary -> stable (Linux x64) ===');

  const canary = await fetchManifest('canary');
  const stable = await fetchManifest('stable');

  summarize('Current STABLE manifest', stable.json);
  summarize('Incoming CANARY manifest', canary.json);

  if (!yes) {
    console.log('\n  [DRY RUN] No changes uploaded.');
    if (stable.json) {
      console.log(`  Current stable v${stable.json.app?.version ?? '?'} would be backed up first.`);
    } else {
      console.log('  No current stable manifest; backup would be skipped.');
    }
    console.log('  Run with --yes to promote canary to stable.');
    return;
  }

  const client = createOSSClient();
  if (stable.json && stable.text) {
    await backupStableManifest(client, stable.text, stable.json);
  } else {
    console.log('\n==> No current stable manifest; skipping backup.');
  }

  await uploadStableManifest(client, canary.text);

  console.log('\n=== Promote complete ===');
  console.log(`Stable manifest: ${CDN_BASE}/manifest-${PLATFORM_KEY}.json`);
  console.log(`App version now: ${canary.json.app.version}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
