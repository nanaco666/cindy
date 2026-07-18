#!/usr/bin/env node

import { constants, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const PROTOCOL_VERSION = 1;
const DEFAULT_API_BASE = 'http://localhost:3333';
const DEFAULT_CONTROLLER_DEVICE_ID = 'mobile-voice-credential-fetcher';
const DEFAULT_WAIT_FOR_READY_MS = 10_000;
const DL_VOICE_CREDENTIAL_SYNC_CHANNEL = 'device-link:voice:credential-sync';

const scriptDir = resolve(fileURLToPath(import.meta.url), '..');
const mobileRoot = resolve(scriptDir, '..');

loadEnvFile(resolve(mobileRoot, '.env'));

const options = parseArgs(process.argv.slice(2));
const accessTokenOverride = readSecretFile(
  options.accessTokenFile
    ?? process.env.XDT_MOBILE_AUTH_ACCESS_TOKEN_FILE,
) ?? readString(process.env.XDT_MOBILE_AUTH_ACCESS_TOKEN);
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
  ?? process.env.XDT_MOBILE_VOICE_FETCHER_DEVICE_ID
  ?? DEFAULT_CONTROLLER_DEVICE_ID;
const waitForReadyMs = options.waitForReadyMs
  ?? parseNonNegativeInteger(process.env.XDT_MOBILE_VOICE_FETCH_WAIT_MS, DEFAULT_WAIT_FOR_READY_MS);
const outputPath = resolve(
  options.output
    ?? process.env.XDT_MOBILE_VOICE_CREDENTIAL_OUTPUT
    ?? resolve(tmpdir(), 'xdt-mobile-voice-credential.json'),
);

let fetchedCredential = null;

if (options.dryRun) {
  console.log('fetch-mobile-voice-credential dry run');
  console.log(`- api base: ${apiBase}`);
  console.log(`- device-link api base: ${deviceLinkApiBase}`);
  console.log(`- auth: ${accessTokenOverride ? 'provided access token' : 'local dev-login'}`);
  console.log(`- controller device id: ${accessTokenOverride ? '<from token>' : controllerDeviceId}`);
  console.log(`- target device id: ${options.targetDeviceId ?? '<auto: exactly one controllable desktop>'}`);
  console.log(`- output: ${outputPath}`);
  console.log(`- wait for ready: ${waitForReadyMs}ms`);
  process.exit(0);
}

let controller = null;
let accessToken = null;
try {
  accessToken = accessTokenOverride ?? await devLogin();

  controller = await connectController(accessToken);
  const target = await selectTargetDevice(accessToken);
  await openLink(controller, target.deviceId);
  const credential = await invoke(controller, target.deviceId, DL_VOICE_CREDENTIAL_SYNC_CHANNEL, []);
  assertCredentialShape(credential);
  fetchedCredential = credential;
  const written = writeCredentialFile(outputPath, credential);

  console.log('fetch-mobile-voice-credential passed');
  console.log(`- host: ${target.name} (${target.deviceId})`);
  console.log(`- proxy: ${redactUrl(credential.proxyBaseUrl)}`);
  console.log(`- ASR: ${credential.asr.mode} / ${credential.asr.protocolProfile ?? 'unknown'} / ${credential.asr.model}`);
  console.log(`- ASR provider chain: ${credentialProviderChain(credential, 'asrProviderChain', credential.asr).length} candidate(s)`);
  console.log(`- refiner: ${credential.refiner.transport} / ${credential.refiner.model}`);
  console.log(`- refiner provider chain: ${credentialProviderChain(credential, 'refinerProviderChain', credential.refiner).length} candidate(s)`);
  console.log(`- output: ${written}`);
  console.log('Use this file with: pnpm --dir apps/mobile run test:voice-cloud:preflight:run -- --credential-file <output>');
} catch (error) {
  console.error(`fetch-mobile-voice-credential failed: ${redactError(error, fetchedCredential)}`);
  process.exitCode = 1;
} finally {
  controller?.close();
  if (!accessTokenOverride && accessToken) {
    await cleanupDevSession(accessToken);
  }
}

async function devLogin() {
  const login = await requestJson(`${apiBase}/api/auth/dev-login`, {
    label: 'dev login',
    method: 'POST',
    body: { deviceId: controllerDeviceId },
    hint: [
      'This helper can use local dev-login or an already-authenticated controller token.',
      'For local E2E, start the server with XDT_DEV_AUTH_ENABLED=1 and use the same dev account on desktop.',
      'For remote API smoke, provide XDT_MOBILE_AUTH_ACCESS_TOKEN_FILE with a mobile/controller token.',
    ].join('\n'),
  });
  const accessToken = readString(login?.accessToken);
  if (!accessToken) throw new Error('dev login did not return an accessToken');
  return accessToken;
}

async function connectController(accessToken) {
  const wsUrl = `${deviceLinkApiBase.replace(/^http/, 'ws')}/api/device-link/ws`;
  const ws = new WebSocket(wsUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const frames = [];
  const waiters = [];

  ws.on('open', () => {
    send(ws, {
      v: PROTOCOL_VERSION,
      kind: 'hello',
      payload: {
        deviceName: 'Mobile Voice Credential Fetcher',
        platform: 'node',
        appVersion: '0.0.0-voice-credential-fetch',
        remoteControlEnabled: false,
        busy: false,
      },
    });
  });
  ws.on('message', (raw) => {
    const frame = parseJson(String(raw));
    if (!frame || typeof frame !== 'object') return;
    frames.push(frame);
    if (frame.kind === 'ping') {
      send(ws, { v: PROTOCOL_VERSION, kind: 'pong' });
    }
    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index];
      if (waiter.predicate(frame)) {
        waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
    }
  });
  ws.on('error', (error) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });

  const ack = await waitForFrame(
    waiters,
    (frame) => frame.kind === 'hello-ack',
    'device-link hello-ack',
  );
  if (ack.payload?.serverProtocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`device-link protocol mismatch: server=${ack.payload?.serverProtocolVersion}`);
  }

  return {
    frames,
    ws,
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'voice credential fetch cleanup');
      }
    },
    nextFrame(predicate, label, timeoutMs = 10_000) {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return waitForFrame(waiters, predicate, label, timeoutMs);
    },
  };
}

async function selectTargetDevice(accessToken) {
  const deadline = Date.now() + waitForReadyMs;
  let lastDevices = [];
  do {
    const devices = await fetchDevices(accessToken);
    lastDevices = devices;
    const selected = chooseTargetDevice(devices);
    if (selected) return selected;
    if (Date.now() >= deadline) break;
    await sleep(500);
  } while (true);
  throw new Error(buildNoTargetMessage(lastDevices));
}

async function fetchDevices(accessToken) {
  const result = await requestJson(`${deviceLinkApiBase}/api/device-link/devices`, {
    label: 'device list',
    token: accessToken,
  });
  if (!Array.isArray(result?.devices)) return [];
  return result.devices;
}

function chooseTargetDevice(devices) {
  const candidates = devices.filter((device) =>
    device
    && device.isSelf !== true
    && device.online === true
    && device.remoteControlEnabled === true,
  );
  if (options.targetDeviceId) {
    return candidates.find((device) => device.deviceId === options.targetDeviceId) ?? null;
  }
  if (candidates.length === 1) return candidates[0];
  return null;
}

function buildNoTargetMessage(devices) {
  const candidates = devices.filter((device) => device?.isSelf !== true && device?.online === true && device?.remoteControlEnabled === true);
  if (options.targetDeviceId) {
    return `target desktop is not controllable: ${options.targetDeviceId}`;
  }
  if (candidates.length > 1) {
    return [
      'multiple controllable desktops found; pass --target-device-id explicitly:',
      ...candidates.map((device) => `- ${device.deviceId} (${device.name ?? 'unknown'})`),
    ].join('\n');
  }
  return [
    'no controllable desktop found.',
    'Start this branch desktop against the same local server and enable remote control.',
    'Use from a terminal outside the running desktop dev tree:',
    '  pnpm restart:desktop:local',
    'Note: the restart wrapper stops existing XDMaker desktop dev processes before launching the local client.',
  ].join('\n');
}

async function openLink(client, targetDeviceId) {
  const id = requestId('link');
  const pending = client.nextFrame(
    (frame) =>
      (frame.kind === 'link-accept' || frame.kind === 'relay-error')
      && frame.id === id,
    'link-open',
  );
  send(client.ws, {
    v: PROTOCOL_VERSION,
    kind: 'link-open',
    id,
    dst: targetDeviceId,
    payload: {
      controllerName: 'Mobile Voice Credential Fetcher',
      protocolVersion: PROTOCOL_VERSION,
      appVersion: '0.0.0-voice-credential-fetch',
    },
  });
  const frame = await pending;
  if (frame.kind === 'relay-error') {
    throw new Error(`link-open failed: [${frame.payload?.code ?? 'UNKNOWN'}] ${frame.payload?.message ?? ''}`.trim());
  }
}

async function invoke(client, targetDeviceId, channel, args) {
  const id = requestId('invoke');
  const pending = client.nextFrame(
    (frame) =>
      (frame.kind === 'invoke-result' || frame.kind === 'relay-error')
      && frame.id === id,
    channel,
  );
  send(client.ws, {
    v: PROTOCOL_VERSION,
    kind: 'invoke',
    id,
    dst: targetDeviceId,
    payload: { channel, args },
  });
  const frame = await pending;
  if (frame.kind === 'relay-error') {
    throw new Error(`${channel} relay failed: [${frame.payload?.code ?? 'UNKNOWN'}] ${frame.payload?.message ?? ''}`.trim());
  }
  if (!frame.payload?.ok) {
    const code = frame.payload?.error?.code ?? 'UNKNOWN';
    const message = frame.payload?.error?.message ?? 'unknown error';
    throw new Error(`${channel} failed: [${code}] ${message}`);
  }
  return frame.payload.result;
}

function writeCredentialFile(path, credential) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = resolve(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(credential, null, 2)}\n`, 'utf8');
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return path;
}

function assertCredentialShape(credential) {
  if (!credential || typeof credential !== 'object') throw new Error('voice credential is required');
  if (credential.temporary !== true || credential.credentialVersion !== 1) {
    throw new Error('unsupported voice credential version');
  }
  if (!readString(credential.proxyBaseUrl)) throw new Error('voice credential missing proxyBaseUrl');
  if (!readString(credential.proxyApiKey)) throw new Error('voice credential missing proxyApiKey');
  if (!credential.asr || typeof credential.asr !== 'object') throw new Error('voice credential missing ASR config');
  if (!readString(credential.asr.model) || !readString(credential.asr.mode)) {
    throw new Error('voice credential missing ASR model or mode');
  }
  assertProviderChainShape(credential, 'asrProviderChain', ['model', 'mode']);
  if (!credential.refiner || typeof credential.refiner !== 'object') throw new Error('voice credential missing refiner config');
  if (!readString(credential.refiner.model) || !readString(credential.refiner.transport)) {
    throw new Error('voice credential missing refiner model or transport');
  }
  assertProviderChainShape(credential, 'refinerProviderChain', ['model', 'transport']);
}

function assertProviderChainShape(credential, property, requiredFields) {
  const chain = credential[property];
  if (chain === undefined) return;
  if (!Array.isArray(chain) || chain.length === 0) {
    throw new Error(`voice credential ${property} must be a non-empty array`);
  }
  for (const [index, item] of chain.entries()) {
    if (!item || typeof item !== 'object') throw new Error(`voice credential ${property}[${index}] must be an object`);
    for (const field of requiredFields) {
      if (!readString(item[field])) throw new Error(`voice credential ${property}[${index}] missing ${field}`);
    }
  }
}

function credentialProviderChain(credential, property, fallback) {
  return Array.isArray(credential[property]) && credential[property].length > 0
    ? credential[property]
    : [fallback];
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

async function cleanupDevSession(accessToken) {
  await sleep(100);
  await requestJson(`${deviceLinkApiBase}/api/device-link/devices/${encodeURIComponent(controllerDeviceId)}`, {
    label: 'fetcher device cleanup',
    method: 'DELETE',
    token: accessToken,
    optional: true,
  });
  await requestJson(`${apiBase}/api/auth/logout`, {
    label: 'fetcher logout',
    method: 'POST',
    token: accessToken,
    body: { deviceId: controllerDeviceId },
    optional: true,
  });
}

function waitForFrame(waiters, predicate, label, timeoutMs = 10_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);
    waiters.push({ predicate, resolve: resolvePromise, reject: rejectPromise, timer });
  });
}

function send(ws, frame) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(frame));
}

function requestId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function redactError(error, credential) {
  let text = error instanceof Error ? error.message : String(error);
  const key = credential?.proxyApiKey;
  if (!readString(key)) return text;
  for (const candidate of redactionCandidates(key)) {
    text = text.split(candidate).join('[REDACTED]');
  }
  return text;
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return '<invalid-url>';
  }
}

function redactionCandidates(secret) {
  const candidates = [
    secret,
    encodeURIComponent(secret),
    encodeURI(secret),
  ];
  return candidates.filter((candidate, index) =>
    candidate.length > 0 && candidates.indexOf(candidate) === index,
  );
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseNonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`invalid non-negative integer: ${value}`);
  return parsed;
}

function parseArgs(args) {
  const parsed = {
    accessTokenFile: undefined,
    apiBase: undefined,
    controllerDeviceId: undefined,
    dryRun: false,
    output: undefined,
    targetDeviceId: undefined,
    waitForReadyMs: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--dry-run') {
      parsed.dryRun = true;
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
    if (arg === '--controller-device-id') {
      parsed.controllerDeviceId = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--access-token-file') {
      parsed.accessTokenFile = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--target-device-id') {
      parsed.targetDeviceId = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--output') {
      parsed.output = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--wait-for-ready-ms') {
      parsed.waitForReadyMs = parseNonNegativeInteger(readArgValue(args, index, arg), NaN);
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
  return value.trim().replace(/\/$/, '');
}

// deriveDeviceLinkApiBase 收敛至共享 lib(仅本地 3333→3335 端口推导;生产域名分支已随 apiBaseUrl 退役删除)
import { deriveDeviceLinkApiBase } from './lib/device-link-base.mjs';

function readSecretFile(path) {
  if (!path) return null;
  return readString(readFileSync(resolve(path), 'utf8'));
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
}
