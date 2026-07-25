#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptsDir = resolve(fileURLToPath(import.meta.url), '..');
const clientRepo = resolve(scriptsDir, '..');
const configuredRepo = process.env.XDT_SERVER_REPO?.trim();
const serverRepo = resolve(configuredRepo || resolve(clientRepo, '..', 'cindy-server'));

const serverPackagePath = resolve(serverRepo, 'package.json');
if (!existsSync(serverPackagePath)) {
  console.error([
    `Cindy server repository was not found at: ${serverRepo}`,
    'Clone xindong/cindy-server beside this repository, or set XDT_SERVER_REPO to its path.',
  ].join('\n'));
  process.exit(1);
}

const serverPackage = JSON.parse(readFileSync(serverPackagePath, 'utf8'));
if (!serverPackage.scripts?.['dev:server']) {
  console.error([
    `The repository at ${serverRepo} does not expose a pnpm dev:server script.`,
    'Set XDT_SERVER_REPO to the XDMaker/Cindy API server checkout used by local E2E.',
  ].join('\n'));
  process.exit(1);
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const child = spawn(pnpm, ['dev:server'], {
  cwd: serverRepo,
  env: process.env,
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}

child.on('error', (error) => {
  console.error(`Failed to start Cindy server from ${serverRepo}: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
