#!/usr/bin/env node

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = resolve(fileURLToPath(import.meta.url), '..');
const mobileRoot = resolve(scriptDir, '..');
const repoRoot = resolve(mobileRoot, '..', '..');
const fetchCredentialScript = resolve(scriptDir, 'fetch-mobile-voice-credential.mjs');
const preflightScript = resolve(scriptDir, 'mobile-voice-cloud-preflight.mjs');
const serverKillPortScript = resolve(repoRoot, 'scripts/kill-port.mjs');
const DEFAULT_API_BASE = 'http://localhost:3333';
const DEFAULT_WAIT_FOR_READY_MS = 20_000;

const options = parseArgs(process.argv.slice(2));
const apiBase = normalizeBaseUrl(options.apiBase ?? process.env.XDT_MOBILE_E2E_API_BASE_URL ?? DEFAULT_API_BASE);
const deviceLinkApiBase = normalizeBaseUrl(
  options.deviceLinkBase
    ?? process.env.XDT_MOBILE_E2E_DEVICE_LINK_API_BASE_URL
    ?? process.env.EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL
    ?? deriveDeviceLinkApiBase(apiBase),
);
const accessTokenOverride = readSecretFile(options.accessTokenFile ?? process.env.XDT_MOBILE_AUTH_ACCESS_TOKEN_FILE);
const controllerDeviceId = options.controllerDeviceId
  ?? process.env.XDT_MOBILE_VOICE_FETCHER_DEVICE_ID
  ?? 'mobile-voice-real-cloud-smoke';
const waitForReadyMs = parseNonNegativeInteger(
  options.waitForReadyMs ?? process.env.XDT_MOBILE_VOICE_FETCH_WAIT_MS,
  DEFAULT_WAIT_FOR_READY_MS,
);
const credentialFile = resolve(
  options.credentialFile
    ?? process.env.XDT_MOBILE_VOICE_CREDENTIAL_FILE
    ?? resolve(tmpdir(), `xdt-mobile-voice-real-cloud-${process.pid}.json`),
);
const shouldCleanup = !options.keepCredentialFile && !options.credentialFile && !process.env.XDT_MOBILE_VOICE_CREDENTIAL_FILE;

if (options.listDevices) {
  let stopServer = null;
  let accessToken = accessTokenOverride;
  try {
    if (options.startServer) {
      stopServer = startServerProcess();
      await waitForServerReady(apiBase, waitForReadyMs);
    }
    accessToken ??= await devLogin(controllerDeviceId);
    const devices = await fetchDevices(accessToken);
    printDevices(devices);
  } catch (error) {
    console.error(`mobile-voice-real-cloud-smoke device list failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    if (!accessTokenOverride && accessToken) {
      await requestJson(`${apiBase}/api/auth/logout`, {
        label: 'device-list logout',
        method: 'POST',
        token: accessToken,
        body: { deviceId: controllerDeviceId },
        optional: true,
      });
    }
    stopServer?.();
  }
  process.exit();
}

if (!options.run) {
  console.log('mobile-voice-real-cloud-smoke dry run');
  console.log(`- api base: ${apiBase}`);
  console.log(`- device-link api base: ${deviceLinkApiBase}`);
  console.log(`- start server: ${options.startServer ? 'yes' : 'no'}`);
  console.log(`- list devices: ${options.listDevices ? 'yes' : 'no'}`);
  console.log(`- target device id: ${options.targetDeviceId ?? process.env.XDT_MOBILE_VOICE_CREDENTIAL_TARGET_DEVICE_ID ?? '<auto>'}`);
  console.log(`- credential file: ${credentialFile}`);
  console.log(`- cleanup credential file: ${shouldCleanup ? 'yes' : 'no'}`);
  console.log(`- cloud candidates: ${options.allCandidates ? 'all ASR/refine provider candidates' : 'primary candidate only'}`);
  console.log(`- wait for ready: ${waitForReadyMs}ms`);
  if (options.startServer) console.log('- server command: pnpm dev:server');
  console.log('Use --list-devices first if more than one desktop may be online.');
  console.log('Add --run to fetch the desktop credential and call ASR/refine cloud endpoints.');
  process.exit(0);
}

let stopServer = null;
try {
  if (options.startServer) {
    stopServer = startServerProcess();
    await waitForServerReady(apiBase, waitForReadyMs);
  }
  const target = await resolveRealDesktopTarget();
  runNode(fetchCredentialScript, [
    '--output',
    credentialFile,
    '--api-base',
    apiBase,
    '--device-link-base',
    deviceLinkApiBase,
    '--target-device-id',
    target.deviceId,
    ...(options.accessTokenFile ? ['--access-token-file', options.accessTokenFile] : []),
    ...(options.controllerDeviceId ? ['--controller-device-id', options.controllerDeviceId] : []),
    '--wait-for-ready-ms',
    String(waitForReadyMs),
  ]);
  runNode(preflightScript, [
    '--run',
    '--credential-file',
    credentialFile,
    ...(options.allCandidates ? ['--all-candidates'] : []),
    ...(options.timeoutMs ? ['--timeout-ms', options.timeoutMs] : []),
  ]);
  console.log('mobile-voice-real-cloud-smoke passed');
} catch (error) {
  console.error(`mobile-voice-real-cloud-smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  stopServer?.();
  if (shouldCleanup && existsSync(credentialFile)) {
    try {
      unlinkSync(credentialFile);
    } catch {
      // Best effort cleanup. The file was created with 0600 by fetch-mobile-voice-credential.
    }
  }
}

function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: resolve(scriptDir, '..'),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${script} failed with exit code ${result.status ?? 1}`);
  }
}

function parseArgs(args) {
  const parsed = {
    accessTokenFile: process.env.XDT_MOBILE_AUTH_ACCESS_TOKEN_FILE,
    allCandidates: process.env.XDT_MOBILE_VOICE_PREFLIGHT_ALL_CANDIDATES === '1',
    apiBase: process.env.XDT_MOBILE_E2E_API_BASE_URL,
    deviceLinkBase: process.env.XDT_MOBILE_E2E_DEVICE_LINK_API_BASE_URL,
    controllerDeviceId: process.env.XDT_MOBILE_VOICE_FETCHER_DEVICE_ID,
    credentialFile: process.env.XDT_MOBILE_VOICE_CREDENTIAL_FILE,
    keepCredentialFile: process.env.XDT_MOBILE_VOICE_KEEP_CREDENTIAL_FILE === '1',
    listDevices: false,
    run: false,
    startServer: false,
    targetDeviceId: process.env.XDT_MOBILE_VOICE_CREDENTIAL_TARGET_DEVICE_ID,
    timeoutMs: process.env.XDT_MOBILE_VOICE_PREFLIGHT_TIMEOUT_MS,
    waitForReadyMs: process.env.XDT_MOBILE_VOICE_FETCH_WAIT_MS,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--run') {
      parsed.run = true;
      continue;
    }
    if (arg === '--all-candidates') {
      parsed.allCandidates = true;
      continue;
    }
    if (arg === '--dry-run') {
      parsed.run = false;
      continue;
    }
    if (arg === '--keep-credential-file') {
      parsed.keepCredentialFile = true;
      continue;
    }
    if (arg === '--list-devices') {
      parsed.listDevices = true;
      continue;
    }
    if (arg === '--start-server') {
      parsed.startServer = true;
      continue;
    }
    if (arg === '--api-base') {
      parsed.apiBase = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--device-link-base') {
      parsed.deviceLinkBase = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--target-device-id') {
      parsed.targetDeviceId = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--access-token-file') {
      parsed.accessTokenFile = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--controller-device-id') {
      parsed.controllerDeviceId = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--credential-file') {
      parsed.credentialFile = readArgValue(args, index, arg);
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

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_API_BASE).replace(/\/+$/, '');
}

// deriveDeviceLinkApiBase 收敛至共享 lib(仅本地 3333→3335 端口推导;生产域名分支已随 apiBaseUrl 退役删除)
import { deriveDeviceLinkApiBase } from './lib/device-link-base.mjs';

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
  console.log('mobile-voice-real-cloud-smoke started local server fixture');
  return () => {
    stopChild(child);
    cleanupServerPort();
  };
}

async function devLogin(deviceId) {
  const login = await requestJson(`${apiBase}/api/auth/dev-login`, {
    label: 'dev login',
    method: 'POST',
    body: { deviceId },
    hint: [
      'Device listing can use local dev-login or an already-authenticated controller token.',
      'For local E2E, start the server with XDT_DEV_AUTH_ENABLED=1 and use the same dev account on desktop.',
      'For remote API smoke, provide XDT_MOBILE_AUTH_ACCESS_TOKEN_FILE with a mobile/controller token.',
    ].join('\n'),
  });
  const accessToken = readString(login?.accessToken);
  if (!accessToken) throw new Error('dev login did not return an accessToken');
  return accessToken;
}

async function fetchDevices(accessToken) {
  const payload = await requestJson(`${deviceLinkApiBase}/api/device-link/devices`, {
    label: 'device list',
    token: accessToken,
  });
  return Array.isArray(payload?.devices) ? payload.devices : [];
}

function printDevices(devices) {
  const controllable = devices.filter(isControllableDevice);
  const realDesktopCandidates = devices.filter(isRealDesktopCandidate);
  console.log(`mobile-voice-real-cloud-smoke device list: ${devices.length} device(s), ${controllable.length} controllable, ${realDesktopCandidates.length} real desktop candidate(s)`);
  for (const device of devices) {
    const flags = [
      device.isSelf ? 'self' : 'remote',
      device.online ? 'online' : 'offline',
      device.remoteControlEnabled ? 'remote-on' : 'remote-off',
    ].join(',');
    console.log(`- ${device.deviceId ?? '<unknown>'} (${device.name ?? 'unknown'}, ${flags}, appVersion=${device.appVersion ?? 'unknown'})`);
  }
  if (realDesktopCandidates.length !== 1) {
    console.log('Pass --target-device-id <deviceId> when running the real cloud smoke.');
  }
}

async function resolveRealDesktopTarget() {
  let accessToken = accessTokenOverride;
  const guardDeviceId = `${controllerDeviceId}-target-guard`;
  try {
    accessToken ??= await devLogin(guardDeviceId);
    const devices = await fetchDevices(accessToken);
    const target = selectTargetDevice(devices);
    console.log(`mobile-voice-real-cloud-smoke target: ${target.name ?? 'unknown'} (${target.deviceId}, appVersion=${target.appVersion ?? 'unknown'})`);
    return target;
  } finally {
    if (!accessTokenOverride && accessToken) {
      await requestJson(`${apiBase}/api/auth/logout`, {
        label: 'target guard logout',
        method: 'POST',
        token: accessToken,
        body: { deviceId: guardDeviceId },
        optional: true,
      });
    }
  }
}

function selectTargetDevice(devices) {
  const candidates = devices.filter(isRealDesktopCandidate);
  if (options.targetDeviceId) {
    const target = candidates.find((device) => device.deviceId === options.targetDeviceId);
    if (target) return target;
    throw new Error(`target desktop is not a real controllable desktop candidate: ${options.targetDeviceId}`);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    return throwTargetSelectionError('multiple real controllable desktops found; pass --target-device-id explicitly', candidates);
  }
  return throwTargetSelectionError('no real controllable desktop found', devices.filter(isControllableDevice));
}

function throwTargetSelectionError(message, devices) {
  const lines = devices.length
    ? devices.map((device) => `- ${device.deviceId ?? '<unknown>'} (${device.name ?? 'unknown'}, appVersion=${device.appVersion ?? 'unknown'})`)
    : ['- none'];
  throw new Error([
    message,
    ...lines,
    'Requirements:',
    '- desktop is logged into the same account as this controller',
    '- desktop is online against the same API base',
    '- desktop remote control is enabled',
    '- target is a real desktop, not a mobile E2E/mock fixture',
  ].join('\n'));
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  try {
    const headers = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(`${options.label ?? url} returned ${response.status}: ${text}`);
    return parsed;
  } catch (error) {
    if (options.optional) return null;
    const suffix = options.hint ? `\n${options.hint}` : '';
    throw new Error(`${options.label ?? url} failed: ${error instanceof Error ? error.message : String(error)}${suffix}`);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForServerReady(baseUrl, waitForReadyMs) {
  const deadline = Date.now() + waitForReadyMs;
  let lastError = null;
  do {
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { Accept: 'application/json' },
      });
      if (response.ok) {
        console.log(`mobile-voice-real-cloud-smoke server ready: ${baseUrl}`);
        return;
      }
      lastError = new Error(`server health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await sleep(500);
  } while (true);
  throw new Error(`server health failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function pipeChildOutput(child, label) {
  child.stdout?.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      console.log(`[${label}] ${line}`);
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
}

function pnpmBin() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function cleanupServerPort() {
  spawnSync(process.execPath, [serverKillPortScript], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'ignore',
  });
}

function parseNonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`invalid non-negative integer: ${value}`);
  return parsed;
}

function isControllableDevice(device) {
  return device
    && device.isSelf !== true
    && device.online === true
    && device.remoteControlEnabled === true;
}

function isRealDesktopCandidate(device) {
  return isControllableDevice(device) && !isFixtureDevice(device);
}

function isFixtureDevice(device) {
  const deviceId = String(device?.deviceId ?? '');
  const name = String(device?.name ?? '');
  const appVersion = String(device?.appVersion ?? '');
  return deviceId.startsWith('mobile-e2e-')
    || deviceId.startsWith('mobile-local-desktop-voice-')
    || appVersion.includes('mobile-e2e')
    || name.includes('Mock');
}

function readSecretFile(path) {
  if (!path) return null;
  return readString(readFileSync(resolve(path), 'utf8'));
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
