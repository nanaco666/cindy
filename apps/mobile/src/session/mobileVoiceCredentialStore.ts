import { deleteSecureItem, getSecureItem, setSecureItem } from '@/auth/secureStorage';
import type { MobileVoiceCredentialSyncResult } from '@lizi/maker-shared/device-link-contract';
import { redactMobileVoiceCredentialValue } from '@/session/mobileVoiceCredentialRedaction';

const STORAGE_KEY_PREFIX = 'xdt.mobileVoiceCredential.v1';
const STORAGE_INDEX_KEY = `${STORAGE_KEY_PREFIX}.hosts`;
const STORAGE_VERSION = 1;
const LITELLM_REALTIME_TRANSCRIPTION_PATH = '/openai/passthrough/v1/realtime?intent=transcription';
const LITELLM_CHAT_COMPLETIONS_PATH = '/v1/chat/completions';

export type StoredMobileVoiceCredential = MobileVoiceCredentialSyncResult & {
  hostDeviceId: string;
  storageVersion: typeof STORAGE_VERSION;
  syncedAt: string;
};

export type SyncMobileVoiceCredential = () => Promise<MobileVoiceCredentialSyncResult>;

export interface ResolveMobileVoiceCredentialOptions {
  refreshedHosts?: Set<string>;
  forceRefresh?: boolean;
  allowStoredFallback?: boolean;
}

/**
 * Legacy credential storage helper.
 *
 * Runtime mobile voice input now stores the user's LiteLLM key once in mobile
 * settings, then derives a per-host executable credential from that local key.
 * These helpers remain for old diagnostics and for clearing stale per-host
 * credentials during logout.
 */
export async function saveMobileVoiceCredentialForHost(
  hostDeviceId: string,
  credential: MobileVoiceCredentialSyncResult,
): Promise<StoredMobileVoiceCredential> {
  const normalizedHost = normalizeHostDeviceId(hostDeviceId);
  assertCredentialShape(credential);
  const executableCredential = normalizeMobileVoiceCredentialForStorage(credential);
  assertCredentialShape(executableCredential);
  const stored: StoredMobileVoiceCredential = {
    ...executableCredential,
    hostDeviceId: normalizedHost,
    storageVersion: STORAGE_VERSION,
    syncedAt: new Date().toISOString(),
  };
  await setSecureItem(storageKeyForHostDevice(normalizedHost), JSON.stringify(stored));
  await addHostToCredentialIndex(normalizedHost);
  return stored;
}

export async function getMobileVoiceCredentialForHost(
  hostDeviceId: string,
): Promise<StoredMobileVoiceCredential | null> {
  const normalizedHost = normalizeHostDeviceId(hostDeviceId);
  const parsed = parseStoredCredential(await getSecureItem(storageKeyForHostDevice(normalizedHost)));
  return parsed?.hostDeviceId === normalizedHost ? parsed : null;
}

export async function deleteMobileVoiceCredentialForHost(hostDeviceId: string): Promise<void> {
  const normalizedHost = normalizeHostDeviceId(hostDeviceId);
  await deleteSecureItem(storageKeyForHostDevice(normalizedHost));
  await removeHostFromCredentialIndex(normalizedHost);
}

export async function clearAllMobileVoiceCredentials(): Promise<void> {
  const hosts = await readCredentialHostIndex();
  await Promise.all(
    hosts.map((hostDeviceId) =>
      deleteSecureItem(storageKeyForHostDevice(hostDeviceId)).catch(() => undefined),
    ),
  );
  await deleteSecureItem(STORAGE_INDEX_KEY).catch(() => undefined);
}

export async function resolveMobileVoiceCredentialForHost(
  hostDeviceId: string,
  sync: SyncMobileVoiceCredential,
  options: ResolveMobileVoiceCredentialOptions = {},
): Promise<StoredMobileVoiceCredential> {
  const normalizedHost = normalizeHostDeviceId(hostDeviceId);
  const storedCredential = await getMobileVoiceCredentialForHost(normalizedHost);
  const refreshedHosts = options.refreshedHosts;
  const shouldRefresh = options.forceRefresh
    || !storedCredential
    || !refreshedHosts?.has(normalizedHost);

  if (shouldRefresh) {
    try {
      const synced = await saveMobileVoiceCredentialForHost(normalizedHost, await sync());
      refreshedHosts?.add(normalizedHost);
      return synced;
    } catch (err) {
      if (storedCredential && options.allowStoredFallback !== false) return storedCredential;
      throw err;
    }
  }

  return storedCredential;
}

export function redactMobileVoiceCredentialForLog<T extends { proxyApiKey?: unknown }>(
  credential: T,
): Omit<T, 'proxyApiKey'> & { proxyApiKey: string } {
  return redactMobileVoiceCredentialValue(credential);
}

function assertCredentialShape(credential: MobileVoiceCredentialSyncResult): void {
  if (!credential || typeof credential !== 'object') throw new Error('voice credential is required');
  if (credential.temporary !== true || credential.credentialVersion !== 1) {
    throw new Error('unsupported voice credential version');
  }
  if (!readNonEmptyString(credential.proxyBaseUrl)) throw new Error('voice credential missing proxyBaseUrl');
  if (!readNonEmptyString(credential.proxyApiKey)) throw new Error('voice credential missing proxyApiKey');
  if (!credential.asr || typeof credential.asr !== 'object') throw new Error('voice credential missing ASR config');
  if (!readNonEmptyString(credential.asr.provider) || !readNonEmptyString(credential.asr.model)) {
    throw new Error('voice credential missing ASR provider');
  }
  if (credential.asr.auth !== 'api-key' && credential.asr.auth !== 'codex') {
    throw new Error('voice credential ASR auth must be api-key or codex');
  }
  if (credential.asrProviderChain !== undefined) {
    if (!Array.isArray(credential.asrProviderChain)) {
      throw new Error('voice credential ASR provider chain must be an array');
    }
    for (const item of credential.asrProviderChain) {
      if (!item || typeof item !== 'object') throw new Error('voice credential ASR provider chain contains invalid config');
      if (!readNonEmptyString(item.provider) || !readNonEmptyString(item.model)) {
        throw new Error('voice credential ASR provider chain contains invalid provider');
      }
      if (item.auth !== 'api-key' && item.auth !== 'codex') {
        throw new Error('voice credential ASR provider chain auth must be api-key or codex');
      }
    }
  }
  if (!credential.refiner || typeof credential.refiner !== 'object') {
    throw new Error('voice credential missing refiner config');
  }
  if (!readNonEmptyString(credential.refiner.provider) || !readNonEmptyString(credential.refiner.model)) {
    throw new Error('voice credential missing refiner provider');
  }
  if (credential.refiner.auth !== 'api-key' && credential.refiner.auth !== 'codex') {
    throw new Error('voice credential refiner auth must be api-key or codex');
  }
  if (credential.refiner.transport !== 'litellm-chat-completions' && credential.refiner.transport !== 'codex-responses') {
    throw new Error('voice credential refiner transport is unsupported');
  }
  if (credential.refinerProviderChain !== undefined) {
    if (!Array.isArray(credential.refinerProviderChain)) {
      throw new Error('voice credential refiner provider chain must be an array');
    }
    for (const item of credential.refinerProviderChain) {
      if (!item || typeof item !== 'object') throw new Error('voice credential refiner provider chain contains invalid config');
      if (!readNonEmptyString(item.provider) || !readNonEmptyString(item.model)) {
        throw new Error('voice credential refiner provider chain contains invalid provider');
      }
      if (item.auth !== 'api-key' && item.auth !== 'codex') {
        throw new Error('voice credential refiner provider chain auth must be api-key or codex');
      }
      if (item.transport !== 'litellm-chat-completions' && item.transport !== 'codex-responses') {
        throw new Error('voice credential refiner provider chain transport is unsupported');
      }
    }
  }
  if (credential.settings !== undefined) {
    if (!credential.settings || typeof credential.settings !== 'object') {
      throw new Error('voice credential settings must be an object');
    }
    if (!readNonEmptyString(credential.settings.language)) {
      throw new Error('voice credential settings missing language');
    }
    if (typeof credential.settings.refinementEnabled !== 'boolean') {
      throw new Error('voice credential settings missing refinementEnabled');
    }
    if (typeof credential.settings.playInteractionSound !== 'boolean') {
      throw new Error('voice credential settings missing playInteractionSound');
    }
  }
}

function parseStoredCredential(raw: string | null): StoredMobileVoiceCredential | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredMobileVoiceCredential>;
    if (parsed.storageVersion !== STORAGE_VERSION) return null;
    if (!readNonEmptyString(parsed.hostDeviceId) || !readNonEmptyString(parsed.syncedAt)) return null;
    assertCredentialShape(parsed as MobileVoiceCredentialSyncResult);
    const executableCredential = normalizeMobileVoiceCredentialForStorage(parsed as MobileVoiceCredentialSyncResult);
    assertCredentialShape(executableCredential);
    return {
      ...parsed,
      ...executableCredential,
    } as StoredMobileVoiceCredential;
  } catch {
    return null;
  }
}

function normalizeMobileVoiceCredentialForStorage(
  credential: MobileVoiceCredentialSyncResult,
): MobileVoiceCredentialSyncResult {
  return {
    ...credential,
    asr: normalizeMobileAsrCredential(credential),
    asrProviderChain: normalizeMobileAsrCredentialChain(credential),
    refiner: normalizeMobileRefinerCredential(credential),
    refinerProviderChain: normalizeMobileRefinerCredentialChain(credential),
  };
}

function normalizeMobileAsrCredential(
  credential: MobileVoiceCredentialSyncResult,
): MobileVoiceCredentialSyncResult['asr'] {
  const asr = credential.asr;
  if (
    asr.auth === 'codex'
    && asr.mode === 'realtime-websocket'
    && asr.protocolProfile === 'openai-transcription-manual'
  ) {
    return {
      ...asr,
      auth: 'api-key',
      endpointPath: asr.endpointPath ?? LITELLM_REALTIME_TRANSCRIPTION_PATH,
      litellmHeaderModel: asr.litellmHeaderModel ?? asr.model,
    };
  }
  return asr;
}

function normalizeMobileAsrCredentialChain(
  credential: MobileVoiceCredentialSyncResult,
): MobileVoiceCredentialSyncResult['asrProviderChain'] {
  const chain = credential.asrProviderChain?.length ? credential.asrProviderChain : [credential.asr];
  const seen = new Set<string>();
  const normalized: NonNullable<MobileVoiceCredentialSyncResult['asrProviderChain']> = [];
  for (const asr of chain) {
    const item = normalizeMobileAsrCredential({ ...credential, asr });
    if (seen.has(item.provider)) continue;
    seen.add(item.provider);
    normalized.push(item);
  }
  return normalized;
}

function normalizeMobileRefinerCredential(
  credential: MobileVoiceCredentialSyncResult,
): MobileVoiceCredentialSyncResult['refiner'] {
  const refiner = credential.refiner;
  if (refiner.transport === 'codex-responses') {
    return {
      ...refiner,
      auth: 'api-key',
      transport: 'litellm-chat-completions',
      endpointPath: refiner.endpointPath ?? LITELLM_CHAT_COMPLETIONS_PATH,
    };
  }
  if (refiner.transport === 'litellm-chat-completions' && !refiner.endpointPath) {
    return {
      ...refiner,
      endpointPath: LITELLM_CHAT_COMPLETIONS_PATH,
    };
  }
  return refiner;
}

function normalizeMobileRefinerCredentialChain(
  credential: MobileVoiceCredentialSyncResult,
): MobileVoiceCredentialSyncResult['refinerProviderChain'] {
  const chain = credential.refinerProviderChain?.length ? credential.refinerProviderChain : [credential.refiner];
  const seen = new Set<string>();
  const normalized: NonNullable<MobileVoiceCredentialSyncResult['refinerProviderChain']> = [];
  for (const refiner of chain) {
    const item = normalizeMobileRefinerCredential({ ...credential, refiner });
    if (seen.has(item.provider)) continue;
    seen.add(item.provider);
    normalized.push(item);
  }
  return normalized;
}

function normalizeHostDeviceId(hostDeviceId: string): string {
  const normalized = hostDeviceId.trim();
  if (!normalized) throw new Error('host device id is required');
  return normalized;
}

function storageKeyForHostDevice(hostDeviceId: string): string {
  const safePrefix = hostDeviceId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'host';
  return `${STORAGE_KEY_PREFIX}.${safePrefix}.${fnv1a(hostDeviceId)}`;
}

async function addHostToCredentialIndex(hostDeviceId: string): Promise<void> {
  const hosts = await readCredentialHostIndex();
  if (hosts.includes(hostDeviceId)) return;
  await writeCredentialHostIndex([...hosts, hostDeviceId]);
}

async function removeHostFromCredentialIndex(hostDeviceId: string): Promise<void> {
  const hosts = await readCredentialHostIndex();
  const next = hosts.filter((item) => item !== hostDeviceId);
  if (next.length === hosts.length) return;
  await writeCredentialHostIndex(next);
}

async function readCredentialHostIndex(): Promise<string[]> {
  const raw = await getSecureItem(STORAGE_INDEX_KEY).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const hosts: string[] = [];
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const normalized = item.trim();
      if (normalized && !hosts.includes(normalized)) hosts.push(normalized);
    }
    return hosts;
  } catch {
    return [];
  }
}

async function writeCredentialHostIndex(hosts: string[]): Promise<void> {
  const normalizedHosts = hosts
    .map((host) => host.trim())
    .filter((host, index, list) => host && list.indexOf(host) === index);
  if (normalizedHosts.length === 0) {
    await deleteSecureItem(STORAGE_INDEX_KEY);
    return;
  }
  await setSecureItem(STORAGE_INDEX_KEY, JSON.stringify(normalizedHosts));
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export const __testing = {
  normalizeMobileVoiceCredentialForStorage,
  parseStoredCredential,
  readCredentialHostIndex,
  storageIndexKey: STORAGE_INDEX_KEY,
  storageKeyForHostDevice,
};
