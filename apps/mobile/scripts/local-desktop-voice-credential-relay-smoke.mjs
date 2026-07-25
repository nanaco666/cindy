#!/usr/bin/env node

import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = resolve(fileURLToPath(import.meta.url), '..');
const mobileRoot = resolve(scriptDir, '..');
const repoRoot = resolve(mobileRoot, '..', '..');
const exportCredentialScript = resolve(scriptDir, 'export-local-desktop-voice-credential.mjs');
const fetchCredentialScript = resolve(scriptDir, 'fetch-mobile-voice-credential.mjs');
const mockHostScript = resolve(scriptDir, 'mock-device-link-host.mjs');
const preflightScript = resolve(scriptDir, 'mobile-voice-cloud-preflight.mjs');
const serverKillPortScript = resolve(repoRoot, 'scripts/kill-port.mjs');

const DEFAULT_API_BASE = 'http://localhost:3333';
const DEFAULT_WAIT_FOR_READY_MS = 20_000;

const options = parseArgs(process.argv.slice(2));
const apiBase = normalizeBaseUrl(options.apiBase ?? process.env.XDT_MOBILE_E2E_API_BASE_URL ?? DEFAULT_API_BASE);
const hostDeviceId = options.hostDeviceId
  ?? process.env.XDT_MOBILE_LOCAL_DESKTOP_RELAY_HOST_DEVICE_ID
  ?? `mobile-local-desktop-voice-host-${process.pid}`;
const controllerDeviceId = options.controllerDeviceId
  ?? process.env.XDT_MOBILE_VOICE_FETCHER_DEVICE_ID
  ?? `mobile-local-desktop-voice-fetcher-${process.pid}`;
const waitForReadyMs = parseNonNegativeInteger(
  options.waitForReadyMs ?? process.env.XDT_MOBILE_VOICE_FETCH_WAIT_MS,
  DEFAULT_WAIT_FOR_READY_MS,
);
const sourceCredentialFile = resolve(
  options.sourceCredentialFile
    ?? process.env.XDT_MOBILE_LOCAL_DESKTOP_SOURCE_CREDENTIAL_FILE
    ?? resolve(tmpdir(), `xdt-mobile-local-desktop-voice-source-${process.pid}.json`),
);
const fetchedCredentialFile = resolve(
  options.fetchedCredentialFile
    ?? process.env.XDT_MOBILE_LOCAL_DESKTOP_FETCHED_CREDENTIAL_FILE
    ?? resolve(tmpdir(), `xdt-mobile-local-desktop-voice-fetched-${process.pid}.json`),
);
const shouldCleanupSource = !options.keepCredentialFiles
  && !options.sourceCredentialFile
  && !process.env.XDT_MOBILE_LOCAL_DESKTOP_SOURCE_CREDENTIAL_FILE;
const shouldCleanupFetched = !options.keepCredentialFiles
  && !options.fetchedCredentialFile
  && !process.env.XDT_MOBILE_LOCAL_DESKTOP_FETCHED_CREDENTIAL_FILE;

let stopServer = null;
let stopMockHost = null;

process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

if (options.dryRun) {
  console.log('local-desktop-voice-credential-relay-smoke dry run');
  console.log(`- api base: ${apiBase}`);
  console.log(`- start server: ${options.startServer ? 'yes' : 'no'}`);
  console.log(`- host device id: ${hostDeviceId}`);
  console.log(`- controller device id: ${controllerDeviceId}`);
  console.log(`- userData: ${options.userDataDir ?? process.env.XDT_MOBILE_LOCAL_DESKTOP_USER_DATA_DIR ?? '<auto>'}`);
  console.log(`- source credential file: ${sourceCredentialFile}`);
  console.log(`- fetched credential file: ${fetchedCredentialFile}`);
  console.log(`- cleanup credential files: ${shouldCleanupSource || shouldCleanupFetched ? 'yes' : 'no'}`);
  console.log(`- cloud candidates: ${options.allCandidates ? 'all ASR/refine provider candidates' : 'primary candidate only'}`);
  console.log(`- wait for ready: ${waitForReadyMs}ms`);
  if (options.startServer) console.log('- server command: pnpm dev:server');
  console.log('- desktop process: not started or restarted');
  process.exit(0);
}

try {
  await ensureServerReady();
  runNode(exportCredentialScript, [
    '--output',
    sourceCredentialFile,
    ...(options.userDataDir ? ['--user-data-dir', options.userDataDir] : []),
    ...(options.proxyBaseUrl ? ['--proxy-base-url', options.proxyBaseUrl] : []),
    ...(options.timeoutMs ? ['--timeout-ms', options.timeoutMs] : []),
  ]);
  stopMockHost = startMockHostProcess();
  await stopMockHost.ready;
  runNode(fetchCredentialScript, [
    '--output',
    fetchedCredentialFile,
    '--api-base',
    apiBase,
    '--target-device-id',
    hostDeviceId,
    '--controller-device-id',
    controllerDeviceId,
    '--wait-for-ready-ms',
    String(waitForReadyMs),
  ]);
  runNode(preflightScript, [
    '--run',
    '--credential-file',
    fetchedCredentialFile,
    ...(options.allCandidates ? ['--all-candidates'] : []),
    ...(options.timeoutMs ? ['--timeout-ms', options.timeoutMs] : []),
  ]);
  console.log('local-desktop-voice-credential-relay-smoke passed');
  console.log(`- host device: ${hostDeviceId}`);
  console.log('- source credential: local desktop safeStorage/userData');
  console.log('- fetched credential: device-link:voice:credential-sync');
  console.log('- cloud preflight: passed without printing proxyApiKey');
} catch (error) {
  console.error(`local-desktop-voice-credential-relay-smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  cleanup();
}

async function ensureServerReady() {
  if (await isServerReady()) {
    console.log(`local-desktop-voice-credential-relay-smoke reusing local server: ${apiBase}`);
    return;
  }
  if (!options.startServer) {
    throw new Error([
      `local server is not ready: ${apiBase}`,
      'Start it with XDT_DEV_AUTH_ENABLED=1 REDIS_URL=redis://127.0.0.1:6379 pnpm dev:server,',
      'or rerun with --start-server.',
    ].join('\n'));
  }
  stopServer = startServerProcess();
  await waitForServerReady();
}

async function isServerReady() {
  try {
    const response = await fetch(`${apiBase}/api/health`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServerReady() {
  const deadline = Date.now() + waitForReadyMs;
  let lastError = null;
  do {
    try {
      if (await isServerReady()) {
        console.log(`local-desktop-voice-credential-relay-smoke server ready: ${apiBase}`);
        return;
      }
      lastError = new Error('server health is not ready yet');
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await sleep(500);
  } while (true);
  throw new Error(`server health failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function startServerProcess() {
  const child = spawn(pnpmBin(), ['dev:server'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      XDT_DEV_AUTH_ENABLED: process.env.XDT_DEV_AUTH_ENABLED ?? '1',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeChildOutput(child, 'server');
  console.log('local-desktop-voice-credential-relay-smoke started local server fixture');
  return () => {
    stopChild(child);
    cleanupServerPort();
  };
}

function startMockHostProcess() {
  let readySettled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const readyTimer = setTimeout(() => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(new Error(`mock host did not become ready within ${Math.max(waitForReadyMs, 10_000)}ms: ${hostDeviceId}`));
  }, Math.max(waitForReadyMs, 10_000));
  const markReady = () => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(readyTimer);
    resolveReady();
  };
  const child = spawn(process.execPath, [
    mockHostScript,
    '--api-base',
    apiBase,
    '--device-id',
    hostDeviceId,
    '--scenario',
    'voice',
    '--voice-credential-file',
    sourceCredentialFile,
  ], {
    cwd: mobileRoot,
    env: {
      ...process.env,
      XDT_MOBILE_E2E_API_BASE_URL: apiBase,
      XDT_MOBILE_E2E_HOST_DEVICE_ID: hostDeviceId,
      XDT_MOBILE_E2E_MOCK_SCENARIO: 'voice',
      XDT_MOBILE_VOICE_CREDENTIAL_FILE: sourceCredentialFile,
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeChildOutput(child, 'mock-host', (line) => {
    if (line.includes('mock-device-link-host ready')) markReady();
  });
  child.on('exit', (code, signal) => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(readyTimer);
    rejectReady(new Error(`mock host exited before ready: code=${code ?? 'null'} signal=${signal ?? 'null'}`));
  });
  const stop = () => stopChild(child);
  stop.ready = ready;
  console.log(`local-desktop-voice-credential-relay-smoke started mock host fixture: ${hostDeviceId}`);
  return stop;
}

function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: mobileRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${script} failed with exit code ${result.status ?? 1}`);
  }
}

function pipeChildOutput(child, label, onStdoutLine) {
  child.stdout?.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      console.log(`[${label}] ${line}`);
      onStdoutLine?.(line);
    }
  });
  child.stderr?.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      console.error(`[${label}] ${line}`);
    }
  });
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // noop
    }
  }
  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // noop
      }
    }
  }, 2_000).unref();
}

function cleanup() {
  stopMockHost?.();
  stopMockHost = null;
  stopServer?.();
  stopServer = null;
  cleanupFile(sourceCredentialFile, shouldCleanupSource);
  cleanupFile(fetchedCredentialFile, shouldCleanupFetched);
}

function cleanupFile(path, shouldCleanup) {
  if (!shouldCleanup || !existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    // Best effort cleanup. Credential helpers create these files with 0600.
  }
}

function cleanupServerPort() {
  spawnSync(process.execPath, [serverKillPortScript], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'ignore',
  });
}

function pnpmBin() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function normalizeBaseUrl(value) {
  return String(value).trim().replace(/\/$/, '');
}

function parseNonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`invalid non-negative integer: ${value}`);
  return parsed;
}

function parseArgs(args) {
  const parsed = {
    allCandidates: process.env.XDT_MOBILE_VOICE_PREFLIGHT_ALL_CANDIDATES === '1',
    apiBase: process.env.XDT_MOBILE_E2E_API_BASE_URL,
    controllerDeviceId: process.env.XDT_MOBILE_VOICE_FETCHER_DEVICE_ID,
    dryRun: false,
    fetchedCredentialFile: process.env.XDT_MOBILE_LOCAL_DESKTOP_FETCHED_CREDENTIAL_FILE,
    hostDeviceId: process.env.XDT_MOBILE_LOCAL_DESKTOP_RELAY_HOST_DEVICE_ID,
    keepCredentialFiles: process.env.XDT_MOBILE_VOICE_KEEP_CREDENTIAL_FILE === '1',
    proxyBaseUrl: process.env.XDT_MOBILE_LOCAL_DESKTOP_PROXY_BASE_URL,
    sourceCredentialFile: process.env.XDT_MOBILE_LOCAL_DESKTOP_SOURCE_CREDENTIAL_FILE,
    startServer: true,
    timeoutMs: process.env.XDT_MOBILE_VOICE_PREFLIGHT_TIMEOUT_MS,
    userDataDir: process.env.XDT_MOBILE_LOCAL_DESKTOP_USER_DATA_DIR,
    waitForReadyMs: process.env.XDT_MOBILE_VOICE_FETCH_WAIT_MS,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--all-candidates') {
      parsed.allCandidates = true;
      continue;
    }
    if (arg === '--keep-credential-files' || arg === '--keep-credential-file') {
      parsed.keepCredentialFiles = true;
      continue;
    }
    if (arg === '--start-server') {
      parsed.startServer = true;
      continue;
    }
    if (arg === '--no-start-server') {
      parsed.startServer = false;
      continue;
    }
    if (arg === '--api-base') {
      parsed.apiBase = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--host-device-id') {
      parsed.hostDeviceId = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--controller-device-id') {
      parsed.controllerDeviceId = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--source-credential-file') {
      parsed.sourceCredentialFile = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--fetched-credential-file') {
      parsed.fetchedCredentialFile = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--user-data-dir') {
      parsed.userDataDir = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--proxy-base-url') {
      parsed.proxyBaseUrl = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--wait-for-ready-ms') {
      parsed.waitForReadyMs = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

function readArgValue(args, index, flag) {
  const value = args[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
