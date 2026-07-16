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
const serverKillPortScript = resolve(repoRoot, 'scripts/kill-port.mjs');
const DEFAULT_API_BASE = 'http://localhost:3333';
const DEFAULT_CONTROLLER_DEVICE_ID = 'mobile-voice-real-desktop-doctor';
const DEFAULT_WAIT_FOR_READY_MS = 2_000;

const options = parseArgs(process.argv.slice(2));
const apiBase = normalizeBaseUrl(
  options.apiBase
    ?? process.env.XDT_MOBILE_E2E_API_BASE_URL
    ?? DEFAULT_API_BASE,
);
const deviceLinkApiBase = normalizeBaseUrl(
  options.deviceLinkBase
    ?? process.env.XDT_MOBILE_E2E_DEVICE_LINK_API_BASE_URL
    ?? process.env.EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL
    ?? deriveDeviceLinkApiBase(apiBase),
);
const controllerDeviceId = options.controllerDeviceId
  ?? process.env.XDT_MOBILE_VOICE_DOCTOR_DEVICE_ID
  ?? DEFAULT_CONTROLLER_DEVICE_ID;
const waitForReadyMs = parseNonNegativeInteger(
  options.waitForReadyMs ?? process.env.XDT_MOBILE_VOICE_FETCH_WAIT_MS,
  DEFAULT_WAIT_FOR_READY_MS,
);
const accessTokenOverride = readSecretFile(
  options.accessTokenFile
    ?? process.env.XDT_MOBILE_AUTH_ACCESS_TOKEN_FILE,
) ?? readString(process.env.XDT_MOBILE_AUTH_ACCESS_TOKEN);
const credentialFile = resolve(
  options.credentialFile
    ?? process.env.XDT_MOBILE_VOICE_CREDENTIAL_FILE
    ?? resolve(tmpdir(), `xdt-mobile-voice-doctor-${process.pid}.json`),
);
const shouldCleanupCredential = !options.keepCredentialFile
  && !options.credentialFile
  && !process.env.XDT_MOBILE_VOICE_CREDENTIAL_FILE;

let accessToken = null;
let stopServer = null;

process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

try {
  console.log('mobile-voice-real-desktop-doctor');
  console.log(`- api base: ${apiBase}`);
  console.log(`- device-link api base: ${deviceLinkApiBase}`);
  console.log(`- start server: ${options.startServer ? 'yes' : 'no'}`);
  console.log(`- fetch credential: ${options.fetchCredential ? 'yes' : 'no'}`);
  console.log(`- target device id: ${options.targetDeviceId ?? '<auto: exactly one controllable desktop>'}`);

  await ensureServerReady(apiBase, waitForReadyMs);
  accessToken = accessTokenOverride ?? await devLogin(controllerDeviceId);
  const devices = await fetchDevices(accessToken);
  const target = selectTargetDevice(devices);
  printDeviceSummary(devices, target);

  if (options.fetchCredential) {
    runCredentialFetch(target.deviceId);
    console.log('- credential sync: passed');
  } else {
    console.log('- credential sync: skipped; pass --fetch-credential to verify the device-link voice credential channel.');
  }

  console.log('mobile-voice-real-desktop-doctor passed');
} catch (error) {
  console.error(`mobile-voice-real-desktop-doctor failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (!accessTokenOverride && accessToken) {
    await requestJson(`${apiBase}/api/auth/logout`, {
      label: 'doctor logout',
      method: 'POST',
      token: accessToken,
      body: { deviceId: controllerDeviceId },
      optional: true,
    });
  }
  if (shouldCleanupCredential && existsSync(credentialFile)) {
    try {
      unlinkSync(credentialFile);
    } catch {
      // Best effort cleanup. fetch-mobile-voice-credential creates this file as 0600.
    }
  }
  stopServer?.();
  stopServer = null;
}

async function ensureServerReady(baseUrl, timeoutMs) {
  if (await isServerReady(baseUrl)) {
    console.log('- local server: ready');
    return;
  }
  if (!options.startServer) {
    throw new Error([
      `local server is not ready at ${baseUrl}: fetch failed`,
      'Start the local API relay first or rerun this doctor with --start-server.',
      'Then start a desktop client against the same server from a normal terminal:',
      '  pnpm restart:desktop:local',
    ].join('\n'));
  }
  stopServer = startServerProcess();
  await waitForServerReady(baseUrl, timeoutMs);
}

async function isServerReady(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServerReady(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  do {
    try {
      if (await isServerReady(baseUrl)) {
        console.log('- local server: ready');
        return;
      }
      lastError = new Error('health is not ready yet');
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await sleep(250);
  } while (true);
  throw new Error([
    `local server is not ready at ${baseUrl}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    'Start the local API relay with --start-server or run it separately.',
    'Then start a desktop client against the same server from a normal terminal:',
    '  pnpm restart:desktop:local',
  ].join('\n'));
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
  console.log('- local server: starting');
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
      'The doctor needs either local dev auth or an authenticated controller token.',
      'For local E2E, run server with XDT_DEV_AUTH_ENABLED=1.',
      'For remote API checks, pass XDT_MOBILE_AUTH_ACCESS_TOKEN_FILE.',
    ].join('\n'),
  });
  const token = readString(login?.accessToken);
  if (!token) throw new Error('dev login did not return an accessToken');
  console.log('- auth: local dev-login');
  return token;
}

async function fetchDevices(token) {
  const payload = await requestJson(`${deviceLinkApiBase}/api/device-link/devices`, {
    label: 'device list',
    token,
  });
  return Array.isArray(payload?.devices) ? payload.devices : [];
}

function selectTargetDevice(devices) {
  const controllable = devices.filter(isRealDesktopCandidate);
  if (options.targetDeviceId) {
    const target = controllable.find((device) => device.deviceId === options.targetDeviceId);
    if (target) return target;
    throw new Error(`target desktop is not a real controllable desktop candidate: ${options.targetDeviceId}`);
  }
  if (controllable.length === 1) return controllable[0];
  if (controllable.length === 0) {
    throw new Error([
      'no controllable desktop found.',
      'Requirements:',
      '- desktop is logged into the same account as this controller',
      '- desktop is online against the same API base',
      '- desktop remote control is enabled',
      '- desktop branch contains device-link:voice:credential-sync',
      '- target is a real desktop, not a mobile E2E/mock fixture',
    ].join('\n'));
  }
  throw new Error([
    'multiple controllable desktops found; pass --target-device-id explicitly:',
    ...controllable.map((device) => `- ${device.deviceId} (${device.name ?? 'unknown'})`),
  ].join('\n'));
}

function printDeviceSummary(devices, target) {
  const controllable = devices.filter(isControllableDevice);
  const realDesktopCandidates = devices.filter(isRealDesktopCandidate);
  console.log(`- devices: ${devices.length} total, ${controllable.length} controllable, ${realDesktopCandidates.length} real desktop candidate(s)`);
  console.log(`- selected desktop: ${target.name ?? 'unknown'} (${target.deviceId}, appVersion=${target.appVersion ?? 'unknown'})`);
}

function runCredentialFetch(targetDeviceId) {
  const args = [
    fetchCredentialScript,
    '--api-base',
    apiBase,
    '--device-link-base',
    deviceLinkApiBase,
    '--target-device-id',
    targetDeviceId,
    '--output',
    credentialFile,
    '--wait-for-ready-ms',
    String(waitForReadyMs),
    ...(options.accessTokenFile ? ['--access-token-file', options.accessTokenFile] : []),
    ...(options.controllerDeviceId ? ['--controller-device-id', options.controllerDeviceId] : []),
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: mobileRoot,
    env: process.env,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    throw new Error(`credential fetch failed${output ? `:\n${redactKnownCredentialOutput(output)}` : ''}`);
  }
  const output = result.stdout.trim();
  if (output) {
    for (const line of output.split(/\r?\n/)) {
      if (line.includes('proxyApiKey')) continue;
      console.log(`  ${line}`);
    }
  }
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

function parseArgs(args) {
  const parsed = {
    accessTokenFile: process.env.XDT_MOBILE_AUTH_ACCESS_TOKEN_FILE,
    apiBase: process.env.XDT_MOBILE_E2E_API_BASE_URL,
    deviceLinkBase: process.env.XDT_MOBILE_E2E_DEVICE_LINK_API_BASE_URL,
    controllerDeviceId: process.env.XDT_MOBILE_VOICE_DOCTOR_DEVICE_ID,
    credentialFile: process.env.XDT_MOBILE_VOICE_CREDENTIAL_FILE,
    fetchCredential: process.env.XDT_MOBILE_VOICE_DOCTOR_FETCH_CREDENTIAL === '1',
    keepCredentialFile: process.env.XDT_MOBILE_VOICE_KEEP_CREDENTIAL_FILE === '1',
    targetDeviceId: process.env.XDT_MOBILE_VOICE_CREDENTIAL_TARGET_DEVICE_ID,
    waitForReadyMs: process.env.XDT_MOBILE_VOICE_FETCH_WAIT_MS,
    startServer: process.env.XDT_MOBILE_VOICE_DOCTOR_START_SERVER === '1',
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--fetch-credential') {
      parsed.fetchCredential = true;
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
    if (arg === '--keep-credential-file') {
      parsed.keepCredentialFile = true;
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

// deriveDeviceLinkApiBase 收敛至共享 lib(生产域名走 config/production-endpoints.json 权威源)
import { deriveDeviceLinkApiBase } from './lib/device-link-base.mjs';

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

function redactKnownCredentialOutput(value) {
  return value.replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]');
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

function cleanupServerPort() {
  spawnSync(process.execPath, [serverKillPortScript], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'ignore',
  });
}

function cleanup() {
  stopServer?.();
  stopServer = null;
  if (shouldCleanupCredential && existsSync(credentialFile)) {
    try {
      unlinkSync(credentialFile);
    } catch {
      // Best effort cleanup. fetch-mobile-voice-credential creates this file as 0600.
    }
  }
}

function pnpmBin() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
