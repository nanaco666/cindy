#!/usr/bin/env node

import { constants, chmodSync, closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = resolve(fileURLToPath(import.meta.url), '..');
const mobileRoot = resolve(scriptDir, '..');
const repoRoot = resolve(mobileRoot, '..', '..');
const preflightScript = resolve(scriptDir, 'mobile-voice-cloud-preflight.mjs');
const { productionEndpoints } = await import(
  new URL('../../../scripts/shared/production-endpoints.mjs', import.meta.url)
);
const DEFAULT_PROXY_BASE_URL = productionEndpoints.xdGatewayBaseUrl;
const DEFAULT_OUTPUT = resolve(tmpdir(), `xdt-mobile-local-desktop-voice-${process.pid}.json`);
const LITELLM_REALTIME_TRANSCRIPTION_PATH = '/openai/passthrough/v1/realtime?intent=transcription';
const LITELLM_CHAT_COMPLETIONS_PATH = '/v1/chat/completions';

const ASR_PROFILES = {
  'elevenlabs-scribe-realtime': {
    id: 'elevenlabs-scribe-realtime',
    model: 'scribe_v2_realtime',
    auth: 'api-key',
    mode: 'elevenlabs-realtime',
  },
  'openai-realtime-whisper': {
    id: 'openai-realtime-whisper',
    model: 'gpt-realtime-whisper',
    auth: 'codex',
    mode: 'realtime-websocket',
    realtime: {
      pcmSampleRate: 24_000,
      protocolProfile: 'openai-transcription-manual',
    },
  },
  'litellm-gpt-realtime-whisper': {
    id: 'litellm-gpt-realtime-whisper',
    model: 'gpt-realtime-whisper',
    auth: 'api-key',
    mode: 'realtime-websocket',
    realtime: {
      endpointPath: LITELLM_REALTIME_TRANSCRIPTION_PATH,
      litellmHeaderModel: 'gpt-realtime-whisper',
      pcmSampleRate: 24_000,
      protocolProfile: 'openai-transcription-manual',
    },
  },
  'litellm-qwen3-asr-flash-realtime': {
    id: 'litellm-qwen3-asr-flash-realtime',
    model: 'qwen3-asr-flash-realtime',
    auth: 'api-key',
    mode: 'realtime-websocket',
    realtime: {
      endpointPath: '/dashscope/api-ws/v1/realtime?model=qwen3-asr-flash-realtime',
      pcmSampleRate: 16_000,
      protocolProfile: 'qwen-asr-server-vad',
    },
  },
  'litellm-volcengine-sauc-asr': {
    id: 'litellm-volcengine-sauc-asr',
    model: 'volcengine-sauc-asr',
    auth: 'api-key',
    mode: 'provider-native-websocket',
    nativeWebSocket: {
      endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
      pcmSampleRate: 16_000,
      protocolProfile: 'volcengine-sauc-duration',
      resourceId: 'volc.seedasr.sauc.duration',
    },
  },
  'litellm-batch': {
    id: 'litellm-batch',
    model: 'elevenlabs/scribe_v2',
    auth: 'api-key',
    mode: 'batch-http',
  },
};

const REFINER_PROFILES = {
  'codex-gpt-5.4-mini': {
    id: 'codex-gpt-5.4-mini',
    model: 'gpt-5.4-mini',
    auth: 'codex',
    transport: 'codex-responses',
  },
  'codex-gpt-5.4-nano': {
    id: 'codex-gpt-5.4-nano',
    model: 'gpt-5.4-nano',
    auth: 'codex',
    transport: 'codex-responses',
  },
  'litellm-gpt-5.4-mini': {
    id: 'litellm-gpt-5.4-mini',
    model: 'gpt-5.4-mini',
    auth: 'api-key',
    transport: 'litellm-chat-completions',
  },
  'litellm-gpt-5.4-nano': {
    id: 'litellm-gpt-5.4-nano',
    model: 'gpt-5.4-nano',
    auth: 'api-key',
    transport: 'litellm-chat-completions',
  },
  'litellm-deepseek-v4-flash': {
    id: 'litellm-deepseek-v4-flash',
    model: 'deepseek/deepseek-v4-flash',
    auth: 'api-key',
    transport: 'litellm-chat-completions',
  },
  'litellm-qwen3.6-plus': {
    id: 'litellm-qwen3.6-plus',
    model: 'qwen/qwen3.6-plus',
    auth: 'api-key',
    transport: 'litellm-chat-completions',
  },
  'litellm-qwen3.7-max': {
    id: 'litellm-qwen3.7-max',
    model: 'qwen/qwen3.7-max',
    auth: 'api-key',
    transport: 'litellm-chat-completions',
  },
  'litellm-glm-5.1': {
    id: 'litellm-glm-5.1',
    model: 'z-ai/glm-5.1',
    auth: 'api-key',
    transport: 'litellm-chat-completions',
  },
  'litellm-kimi-k2.6': {
    id: 'litellm-kimi-k2.6',
    model: 'moonshotai/kimi-k2.6',
    auth: 'api-key',
    transport: 'litellm-chat-completions',
  },
};

const DEFAULT_ASR_PROVIDER = 'litellm-volcengine-sauc-asr';
const DEFAULT_ASR_CHAIN = [
  'litellm-volcengine-sauc-asr',
  'litellm-qwen3-asr-flash-realtime',
  'litellm-gpt-realtime-whisper',
];
const DEFAULT_REFINER_PROVIDER = 'codex-gpt-5.4-mini';
const DEFAULT_REFINER_CHAIN = [
  'codex-gpt-5.4-mini',
  'litellm-gpt-5.4-mini',
  'litellm-deepseek-v4-flash',
];

const ASR_ALIASES = {
  '': DEFAULT_ASR_PROVIDER,
  xd: DEFAULT_ASR_PROVIDER,
  'xd-litellm': DEFAULT_ASR_PROVIDER,
  'xd-litellm-realtime': DEFAULT_ASR_PROVIDER,
  litellm: DEFAULT_ASR_PROVIDER,
  'litellm-realtime': DEFAULT_ASR_PROVIDER,
  'gpt-realtime-whisper': 'litellm-gpt-realtime-whisper',
  'litellm-gpt-realtime-whisper': 'litellm-gpt-realtime-whisper',
  'qwen3-asr-flash-realtime': 'litellm-qwen3-asr-flash-realtime',
  'litellm-qwen3-asr-flash-realtime': 'litellm-qwen3-asr-flash-realtime',
  'litellm-volcengine-sauc-asr': 'litellm-volcengine-sauc-asr',
  openai: 'openai-realtime-whisper',
  'openai-realtime': 'openai-realtime-whisper',
  'openai-realtime-whisper': 'openai-realtime-whisper',
  'openai-direct': 'openai-realtime-whisper',
  'codex-realtime': 'openai-realtime-whisper',
  'litellm-batch': 'litellm-batch',
  batch: 'litellm-batch',
  elevenlabs: 'elevenlabs-scribe-realtime',
  scribe: 'elevenlabs-scribe-realtime',
  'scribe-realtime': 'elevenlabs-scribe-realtime',
  scribe_v2_realtime: 'elevenlabs-scribe-realtime',
  'elevenlabs-scribe-realtime': 'elevenlabs-scribe-realtime',
};

const REFINER_ALIASES = {
  '': DEFAULT_REFINER_PROVIDER,
  codex: DEFAULT_REFINER_PROVIDER,
  'codex-gpt-5.4-mini': 'codex-gpt-5.4-mini',
  'codex-gpt-5.4-nano': 'codex-gpt-5.4-nano',
  litellm: 'litellm-gpt-5.4-mini',
  'xd-litellm': 'litellm-gpt-5.4-mini',
  'litellm-gpt-5.4-mini': 'litellm-gpt-5.4-mini',
  'litellm-gpt-5.4-nano': 'litellm-gpt-5.4-nano',
  'deepseek-v4-flash': 'litellm-deepseek-v4-flash',
  'litellm-deepseek-v4-flash': 'litellm-deepseek-v4-flash',
  'qwen3.6-plus': 'litellm-qwen3.6-plus',
  'qwen/qwen3.6-plus': 'litellm-qwen3.6-plus',
  'litellm-qwen3.6-plus': 'litellm-qwen3.6-plus',
  'qwen3.7-max': 'litellm-qwen3.7-max',
  'qwen/qwen3.7-max': 'litellm-qwen3.7-max',
  'litellm-qwen3.7-max': 'litellm-qwen3.7-max',
  'glm-5.1': 'litellm-glm-5.1',
  'z-ai/glm-5.1': 'litellm-glm-5.1',
  'litellm-glm-5.1': 'litellm-glm-5.1',
  'kimi-k2.6': 'litellm-kimi-k2.6',
  'moonshotai/kimi-k2.6': 'litellm-kimi-k2.6',
  'litellm-kimi-k2.6': 'litellm-kimi-k2.6',
};

const options = parseArgs(process.argv.slice(2));
const outputPath = resolve(options.output ?? process.env.XDT_MOBILE_LOCAL_DESKTOP_VOICE_CREDENTIAL_FILE ?? DEFAULT_OUTPUT);
const shouldCleanup = options.preflight && !options.keepCredentialFile && !options.output && !process.env.XDT_MOBILE_LOCAL_DESKTOP_VOICE_CREDENTIAL_FILE;

if (options.listUserData) {
  const candidates = discoverUserDataCandidates(options);
  console.log('local desktop voice credential userData candidates');
  for (const candidate of candidates) {
    const info = inspectUserDataCandidate(candidate);
    console.log(`- ${candidate}`);
    console.log(`  api key file: ${info.hasApiKeyFile ? 'yes' : 'no'}`);
    console.log(`  voice models: ${info.hasModelSelection ? 'yes' : 'no'}`);
    console.log(`  voice data: ${info.hasVoiceData ? 'yes' : 'no'}`);
  }
  process.exit(0);
}

if (options.dryRun) {
  const userDataDir = selectUserDataDir(options);
  console.log('export-local-desktop-voice-credential dry run');
  console.log(`- userData: ${userDataDir}`);
  console.log(`- output: ${outputPath}`);
  console.log(`- preflight: ${options.preflight ? 'yes' : 'no'}`);
  console.log(`- cloud candidates: ${options.allCandidates ? 'all ASR/refine provider candidates' : 'primary candidate only'}`);
  console.log(`- cleanup credential file: ${shouldCleanup ? 'yes' : 'no'}`);
  process.exit(0);
}

let credentialForRedaction = null;
try {
  const userDataDir = selectUserDataDir(options);
  const apiKey = readSafeStorageApiKey(userDataDir);
  credentialForRedaction = { proxyApiKey: apiKey };
  const credential = buildCredential({
    userDataDir,
    proxyApiKey: apiKey,
    proxyBaseUrl: options.proxyBaseUrl ?? process.env.XDT_MOBILE_LOCAL_DESKTOP_PROXY_BASE_URL ?? DEFAULT_PROXY_BASE_URL,
  });
  credentialForRedaction = credential;
  const written = writeCredentialFile(outputPath, credential);
  console.log('export-local-desktop-voice-credential passed');
  console.log(`- userData: ${userDataDir}`);
  console.log(`- proxy: ${redactUrl(credential.proxyBaseUrl)}`);
  console.log(`- ASR: ${credential.asr.mode} / ${credential.asr.protocolProfile ?? 'unknown'} / ${credential.asr.model}`);
  console.log(`- ASR provider chain: ${credential.asrProviderChain.length} candidate(s)`);
  console.log(`- refiner: ${credential.refiner.transport} / ${credential.refiner.model}`);
  console.log(`- refiner provider chain: ${credential.refinerProviderChain.length} candidate(s)`);
  console.log(`- output: ${written}`);
  if (options.preflight) {
    runNode(preflightScript, [
      '--run',
      '--credential-file',
      written,
      ...(options.allCandidates ? ['--all-candidates'] : []),
      ...(options.timeoutMs ? ['--timeout-ms', options.timeoutMs] : []),
    ]);
    console.log('export-local-desktop-voice-credential preflight passed');
  } else {
    console.log('Use this file with: pnpm --dir apps/mobile run test:voice-cloud:preflight:run -- --credential-file <output>');
  }
} catch (error) {
  console.error(`export-local-desktop-voice-credential failed: ${redactError(error, credentialForRedaction)}`);
  process.exitCode = 1;
} finally {
  if (shouldCleanup && existsSync(outputPath)) {
    try {
      rmSync(outputPath, { force: true });
    } catch {
      // Best effort cleanup. The file was created with 0600.
    }
  }
}

function buildCredential({ userDataDir, proxyApiKey, proxyBaseUrl }) {
  const selection = readVoiceModelSelection(userDataDir);
  const asrProvider = resolveAlias(selection?.asrProvider, ASR_ALIASES, DEFAULT_ASR_PROVIDER);
  const refinerProvider = resolveAlias(selection?.refinerProvider, REFINER_ALIASES, DEFAULT_REFINER_PROVIDER);
  const refinerModel = readNonEmptyString(selection?.refinerModel);
  const asr = toMobileAsrConfig(ASR_PROFILES[asrProvider]);
  const refiner = toMobileRefinerConfig(REFINER_PROFILES[refinerProvider], refinerModel);
  const asrProviderChain = uniqueByProvider([
    asr,
    ...resolveChain(selection?.asrProviderChain, asrProvider, DEFAULT_ASR_CHAIN, ASR_ALIASES).map((provider) =>
      toMobileAsrConfig(ASR_PROFILES[provider]),
    ),
  ]);
  const refinerProviderChain = uniqueByProvider([
    refiner,
    ...resolveChain(selection?.refinerProviderChain, refinerProvider, DEFAULT_REFINER_CHAIN, REFINER_ALIASES).map((provider) =>
      toMobileRefinerConfig(REFINER_PROFILES[provider], provider === refinerProvider ? refinerModel : undefined),
    ),
  ]);
  return {
    temporary: true,
    credentialVersion: 1,
    issuedAt: new Date().toISOString(),
    hostDeviceId: `local-desktop:${basename(userDataDir)}`,
    proxyBaseUrl,
    proxyApiKey,
    asr,
    asrProviderChain,
    refiner,
    refinerProviderChain,
    settings: readVoiceSettings(userDataDir),
  };
}

function toMobileAsrConfig(profile) {
  const unsupportedReason = mobileRealtimeAsrUnsupportedReason(profile);
  if (unsupportedReason) throw new Error(unsupportedReason);
  const mobileOpenAiProxy = profile.auth === 'codex'
    && profile.mode === 'realtime-websocket'
    && profile.realtime?.protocolProfile === 'openai-transcription-manual';
  const endpointPath = profile.mode === 'batch-http'
    ? '/v1/audio/transcriptions'
    : profile.realtime?.endpointPath
      ?? (mobileOpenAiProxy ? LITELLM_REALTIME_TRANSCRIPTION_PATH : undefined)
      ?? profile.nativeWebSocket?.endpointPath;
  const config = {
    provider: profile.id,
    model: profile.model,
    auth: mobileOpenAiProxy ? 'api-key' : profile.auth,
    mode: profile.mode,
  };
  if (endpointPath) config.endpointPath = endpointPath;
  const pcmSampleRate = profile.realtime?.pcmSampleRate ?? profile.nativeWebSocket?.pcmSampleRate;
  if (pcmSampleRate) config.pcmSampleRate = pcmSampleRate;
  const protocolProfile = profile.realtime?.protocolProfile ?? profile.nativeWebSocket?.protocolProfile;
  if (protocolProfile) config.protocolProfile = protocolProfile;
  if (profile.nativeWebSocket?.resourceId) config.resourceId = profile.nativeWebSocket.resourceId;
  if (profile.realtime?.litellmHeaderModel) config.litellmHeaderModel = profile.realtime.litellmHeaderModel;
  else if (mobileOpenAiProxy) config.litellmHeaderModel = profile.model;
  return config;
}

function mobileRealtimeAsrUnsupportedReason(profile) {
  if (profile.mode === 'batch-http') {
    return [
      `Mobile realtime voice input cannot use desktop ASR provider ${profile.id}:`,
      'the profile is batch-http and cannot stream partial ASR text while recording.',
      'Select a realtime ASR provider on desktop, then export the mobile voice credential again.',
    ].join(' ');
  }
  if (profile.mode === 'elevenlabs-realtime') {
    return [
      `Mobile realtime voice input cannot use desktop ASR provider ${profile.id}:`,
      'the temporary mobile credential sync only tunnels the XD Proxy key,',
      'but this desktop profile requires a direct ElevenLabs API key.',
    ].join(' ');
  }
  if (profile.mode === 'realtime-websocket') {
    const protocol = profile.realtime?.protocolProfile;
    if (protocol === 'openai-transcription-manual' || protocol === 'qwen-asr-server-vad') return null;
    return `Mobile realtime voice input does not support realtime ASR protocol ${protocol ?? 'unknown'} for ${profile.id}.`;
  }
  if (profile.mode === 'provider-native-websocket') {
    const protocol = profile.nativeWebSocket?.protocolProfile;
    if (protocol === 'volcengine-sauc-duration') return null;
    return `Mobile realtime voice input does not support native ASR protocol ${protocol ?? 'unknown'} for ${profile.id}.`;
  }
  return `Mobile realtime voice input does not support desktop ASR mode ${profile.mode} for ${profile.id}.`;
}

function toMobileRefinerConfig(profile, selectedModel) {
  const mobileProxyTransport = profile.transport === 'codex-responses';
  const config = {
    provider: profile.id,
    model: selectedModel || profile.model,
    auth: mobileProxyTransport ? 'api-key' : profile.auth,
    transport: mobileProxyTransport ? 'litellm-chat-completions' : profile.transport,
  };
  if (config.transport === 'litellm-chat-completions') config.endpointPath = LITELLM_CHAT_COMPLETIONS_PATH;
  return config;
}

function readSafeStorageApiKey(userDataDir) {
  const helperDir = mkdtempSync(join(tmpdir(), 'xdt-mobile-read-safe-storage-'));
  const helperPath = join(helperDir, 'read-key.cjs');
  writeFileSync(helperPath, `
const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');
const userDataDir = process.argv[2];
app.setName('xdt-maker');
app.setPath('userData', userDataDir);
app.whenReady().then(() => {
  try {
    const file = path.join(app.getPath('userData'), 'safe-storage', 'api_key.enc');
    if (!safeStorage.isEncryptionAvailable()) {
      console.log(JSON.stringify({ ok: false, error: 'safeStorage encryption is not available' }));
      return;
    }
    if (!fs.existsSync(file)) {
      console.log(JSON.stringify({ ok: false, error: 'safe-storage/api_key.enc not found' }));
      return;
    }
    const value = safeStorage.decryptString(Buffer.from(fs.readFileSync(file, 'utf8'), 'base64'));
    console.log(JSON.stringify({ ok: true, value }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error && error.message ? error.message : String(error) }));
  } finally {
    app.quit();
  }
});
`, { mode: 0o600 });
  try {
    const electron = resolveElectronBinary();
    const result = spawnSync(electron, [helperPath, userDataDir], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Electron helper exited with code ${result.status ?? 1}`);
    const line = result.stdout.trim().split(/\r?\n/).at(-1) || '{}';
    const parsed = JSON.parse(line);
    if (!parsed.ok || typeof parsed.value !== 'string' || !parsed.value.trim()) {
      throw new Error(parsed.error || 'safeStorage helper did not return an API key');
    }
    return parsed.value.trim();
  } finally {
    rmSync(helperDir, { recursive: true, force: true });
  }
}

function resolveElectronBinary() {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  const candidates = [
    resolve(repoRoot, 'apps', 'desktop', 'node_modules', '.bin', `electron${suffix}`),
    resolve(repoRoot, 'node_modules', '.bin', `electron${suffix}`),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('Electron binary not found; run pnpm install first.');
  return found;
}

function selectUserDataDir(opts) {
  if (opts.userDataDir) return assertUsableUserData(resolve(opts.userDataDir));
  const candidates = discoverUserDataCandidates(opts);
  const usable = candidates.filter((candidate) => inspectUserDataCandidate(candidate).hasApiKeyFile);
  if (usable.length === 0) {
    throw new Error('No local XDMaker userData with safe-storage/api_key.enc was found. Pass --user-data-dir explicitly.');
  }
  if (usable.length > 1) {
    const preferred = usable.find((candidate) => basename(candidate) === 'xdt-maker');
    if (preferred) return preferred;
    throw new Error([
      'Multiple local XDMaker userData directories have API keys. Pass --user-data-dir explicitly:',
      ...usable.map((candidate) => `- ${candidate}`),
    ].join('\n'));
  }
  return usable[0];
}

function assertUsableUserData(userDataDir) {
  const info = inspectUserDataCandidate(userDataDir);
  if (!info.exists) throw new Error(`userData does not exist: ${userDataDir}`);
  if (!info.hasApiKeyFile) throw new Error(`safe-storage/api_key.enc not found under userData: ${userDataDir}`);
  return userDataDir;
}

function discoverUserDataCandidates(opts) {
  const explicit = opts.userDataDir ?? process.env.XDT_MOBILE_LOCAL_DESKTOP_USER_DATA_DIR;
  if (explicit) return [resolve(explicit)];
  const supportRoot = platformApplicationSupportRoot();
  const candidates = [
    join(supportRoot, 'xdt-maker'),
    join(supportRoot, 'xdt-maker-dev'),
    join(supportRoot, 'xdt-maker-dev-B'),
  ];
  return uniqueStrings(candidates).filter((candidate) => existsSync(candidate));
}

function platformApplicationSupportRoot() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

function inspectUserDataCandidate(userDataDir) {
  return {
    exists: existsSync(userDataDir),
    hasApiKeyFile: existsSync(join(userDataDir, 'safe-storage', 'api_key.enc')),
    hasModelSelection: existsSync(join(userDataDir, 'voice-input-models.json')),
    hasVoiceData: existsSync(join(userDataDir, 'voice-input-data.v1.json')),
  };
}

function readVoiceModelSelection(userDataDir) {
  return readJsonFile(join(userDataDir, 'voice-input-models.json')) ?? {};
}

function readVoiceSettings(userDataDir) {
  const data = readJsonFile(join(userDataDir, 'voice-input-data.v1.json'));
  const settings = data && typeof data === 'object' && data.settings && typeof data.settings === 'object'
    ? data.settings
    : {};
  return {
    language: readNonEmptyString(settings.language) || 'auto',
    refinementEnabled: settings.refinementEnabled !== false,
    playInteractionSound: Boolean(settings.playInteractionSound),
    refinementInstructions: readNonEmptyString(settings.refinementInstructions) || undefined,
    dictionaryEntries: Array.isArray(settings.dictionaryEntries)
      ? settings.dictionaryEntries.map(normalizeDictionaryEntry).filter(Boolean)
      : [],
    voiceInputHistory: Array.isArray(data?.history)
      ? data.history.map((entry) => readNonEmptyString(entry?.text)).filter(Boolean).slice(-20)
      : [],
  };
}

function normalizeDictionaryEntry(entry) {
  const text = readNonEmptyString(entry?.text);
  if (!text) return null;
  return {
    text,
    frequency: typeof entry.frequency === 'number' && Number.isFinite(entry.frequency) ? entry.frequency : 1,
    aliases: Array.isArray(entry.aliases)
      ? entry.aliases.map((alias) => ({
        text: readNonEmptyString(alias?.text) || '',
        count: typeof alias?.count === 'number' && Number.isFinite(alias.count) ? alias.count : 1,
      })).filter((alias) => alias.text)
      : [],
  };
}

function readJsonFile(pathname) {
  try {
    if (!existsSync(pathname)) return null;
    return JSON.parse(readFileSync(pathname, 'utf8'));
  } catch {
    return null;
  }
}

function resolveAlias(value, aliases, fallback) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return aliases[normalized] ?? fallback;
}

function resolveChain(value, head, defaultChain, aliases) {
  const rawEntries = Array.isArray(value)
    ? value.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];
  const source = rawEntries.length > 0 ? rawEntries : defaultChain;
  const result = [head];
  for (const item of source) {
    const resolved = resolveAlias(item, aliases, '');
    if (resolved && !result.includes(resolved)) result.push(resolved);
  }
  return result;
}

function uniqueByProvider(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item?.provider || seen.has(item.provider)) continue;
    seen.add(item.provider);
    result.push(item);
  }
  return result;
}

function writeCredentialFile(pathname, credential) {
  const dir = dirname(pathname);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = resolve(dir, `.${basename(pathname)}.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(credential, null, 2)}\n`, 'utf8');
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, pathname);
  chmodSync(pathname, 0o600);
  return pathname;
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

function redactError(error, credential) {
  let text = error instanceof Error ? error.message : String(error);
  const key = credential?.proxyApiKey;
  if (!readNonEmptyString(key)) return text;
  for (const candidate of redactionCandidates(key)) {
    text = text.split(candidate).join('[REDACTED]');
  }
  return text;
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    if (url.username) url.username = '[REDACTED]';
    if (url.password) url.password = '[REDACTED]';
    return url.toString();
  } catch {
    return '<invalid-url>';
  }
}

function readNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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

function uniqueStrings(values) {
  return [...new Set(values)];
}

function parseArgs(args) {
  const parsed = {
    allCandidates: process.env.XDT_MOBILE_LOCAL_DESKTOP_ALL_CANDIDATES === '1',
    dryRun: false,
    keepCredentialFile: process.env.XDT_MOBILE_LOCAL_DESKTOP_KEEP_CREDENTIAL_FILE === '1',
    listUserData: false,
    output: process.env.XDT_MOBILE_LOCAL_DESKTOP_VOICE_CREDENTIAL_FILE,
    preflight: false,
    proxyBaseUrl: process.env.XDT_MOBILE_LOCAL_DESKTOP_PROXY_BASE_URL,
    timeoutMs: process.env.XDT_MOBILE_VOICE_PREFLIGHT_TIMEOUT_MS,
    userDataDir: process.env.XDT_MOBILE_LOCAL_DESKTOP_USER_DATA_DIR,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--list-user-data') {
      parsed.listUserData = true;
      continue;
    }
    if (arg === '--preflight') {
      parsed.preflight = true;
      continue;
    }
    if (arg === '--all-candidates') {
      parsed.allCandidates = true;
      continue;
    }
    if (arg === '--keep-credential-file') {
      parsed.keepCredentialFile = true;
      continue;
    }
    if (arg === '--user-data-dir') {
      parsed.userDataDir = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--output') {
      parsed.output = readArgValue(args, index, arg);
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
    throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

function readArgValue(args, index, flag) {
  const value = args[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}
