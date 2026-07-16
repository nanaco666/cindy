import { deleteSecureItem, getSecureItem, setSecureItem } from '@/auth/secureStorage';
import type {
  MobileVoiceCredentialSyncAsr,
  MobileVoiceCredentialSyncRefiner,
  MobileVoiceCredentialSyncResult,
} from '@lizi/maker-shared/device-link-contract';
import { MOBILE_VOICE_LITELLM_BASE_URL } from '@/config/env';
import type { StoredMobileVoiceCredential } from '@/session/mobileVoiceCredentialStore';

const STORAGE_KEY = 'xdt.mobileVoiceLiteLlmSettings.v1';
const STORAGE_VERSION = 1;

// 惰性函数而非模块级常量:MOBILE_VOICE_LITELLM_BASE_URL 是 env.ts 的 live binding
// (启动闸门拉远程端点清单后重赋值),顶层 const 拷贝会把默认 proxy base 钉死在烘焙值。
export function mobileVoiceLiteLlmDefaultProxyBaseUrl(): string {
  return MOBILE_VOICE_LITELLM_BASE_URL;
}
export const MOBILE_VOICE_LITELLM_KEY_MISSING_ERROR =
  '请先在设置里填写 LiteLLM Key，再使用语音输入。';

export interface MobileVoiceLiteLlmSettings {
  proxyApiKey: string;
  proxyBaseUrl: string;
  storageVersion: typeof STORAGE_VERSION;
  updatedAt: string;
}

export async function getMobileVoiceLiteLlmSettings(): Promise<MobileVoiceLiteLlmSettings | null> {
  return parseStoredSettings(await getSecureItem(STORAGE_KEY));
}

export async function hasMobileVoiceLiteLlmSettings(): Promise<boolean> {
  return (await getMobileVoiceLiteLlmSettings()) !== null;
}

export async function saveMobileVoiceLiteLlmSettings(input: {
  proxyApiKey: string;
  proxyBaseUrl?: string;
}): Promise<MobileVoiceLiteLlmSettings> {
  const proxyApiKey = input.proxyApiKey.trim();
  if (!proxyApiKey) throw new Error('LiteLLM Key 不能为空。');
  const proxyBaseUrl = normalizeProxyBaseUrl(input.proxyBaseUrl);
  const settings: MobileVoiceLiteLlmSettings = {
    proxyApiKey,
    proxyBaseUrl,
    storageVersion: STORAGE_VERSION,
    updatedAt: new Date().toISOString(),
  };
  await setSecureItem(STORAGE_KEY, JSON.stringify(settings));
  return settings;
}

export async function clearMobileVoiceLiteLlmSettings(): Promise<void> {
  await deleteSecureItem(STORAGE_KEY);
}

export async function resolveMobileVoiceCredentialFromLiteLlmSettings(
  hostDeviceId: string,
): Promise<StoredMobileVoiceCredential> {
  const settings = await getMobileVoiceLiteLlmSettings();
  if (!settings) throw new Error(MOBILE_VOICE_LITELLM_KEY_MISSING_ERROR);
  return createMobileVoiceCredentialFromLiteLlmSettings(hostDeviceId, settings);
}

export function createMobileVoiceCredentialFromLiteLlmSettings(
  hostDeviceId: string,
  settings: MobileVoiceLiteLlmSettings,
): StoredMobileVoiceCredential {
  const normalizedHostDeviceId = hostDeviceId.trim();
  if (!normalizedHostDeviceId) throw new Error('host device id is required');
  const issuedAt = settings.updatedAt || new Date().toISOString();
  const credential: MobileVoiceCredentialSyncResult = {
    temporary: true,
    credentialVersion: 1,
    issuedAt,
    proxyBaseUrl: settings.proxyBaseUrl,
    proxyApiKey: settings.proxyApiKey,
    asr: { ...MOBILE_VOICE_LITELLM_ASR_CHAIN[0] },
    asrProviderChain: MOBILE_VOICE_LITELLM_ASR_CHAIN.map((item) => ({ ...item })),
    refiner: { ...MOBILE_VOICE_LITELLM_REFINER_CHAIN[0] },
    refinerProviderChain: MOBILE_VOICE_LITELLM_REFINER_CHAIN.map((item) => ({ ...item })),
    settings: {
      language: 'zh-CN',
      refinementEnabled: true,
      playInteractionSound: true,
    },
  };
  return {
    ...credential,
    hostDeviceId: normalizedHostDeviceId,
    storageVersion: STORAGE_VERSION,
    syncedAt: issuedAt,
  };
}

export function isMobileVoiceLiteLlmKeyMissingError(message: string | null | undefined): boolean {
  return message === MOBILE_VOICE_LITELLM_KEY_MISSING_ERROR;
}

export function isMobileVoiceLiteLlmSettingsError(message: string | null | undefined): boolean {
  if (isMobileVoiceLiteLlmKeyMissingError(message)) return true;
  return typeof message === 'string'
    && /^LiteLLM Key 无效或没有语音识别权限（WebSocket (401|403)）/.test(message);
}

function parseStoredSettings(raw: string | null): MobileVoiceLiteLlmSettings | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MobileVoiceLiteLlmSettings>;
    if (parsed.storageVersion !== STORAGE_VERSION) return null;
    const proxyApiKey = readNonEmptyString(parsed.proxyApiKey);
    if (!proxyApiKey) return null;
    return {
      proxyApiKey,
      proxyBaseUrl: normalizeProxyBaseUrl(parsed.proxyBaseUrl),
      storageVersion: STORAGE_VERSION,
      updatedAt: readNonEmptyString(parsed.updatedAt) ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function normalizeProxyBaseUrl(value: unknown): string {
  const raw = readNonEmptyString(value) ?? mobileVoiceLiteLlmDefaultProxyBaseUrl();
  const withoutTrailingSlash = raw.replace(/\/+$/, '');
  try {
    const url = new URL(withoutTrailingSlash);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return mobileVoiceLiteLlmDefaultProxyBaseUrl();
  }
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

const MOBILE_VOICE_LITELLM_ASR_CHAIN = [
  {
    provider: 'litellm-volcengine-sauc-asr',
    model: 'volcengine-sauc-asr',
    auth: 'api-key',
    mode: 'provider-native-websocket',
    endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
    pcmSampleRate: 16_000,
    protocolProfile: 'volcengine-sauc-duration',
    resourceId: 'volc.seedasr.sauc.duration',
  },
  {
    provider: 'litellm-qwen3-asr-flash-realtime',
    model: 'qwen3-asr-flash-realtime',
    auth: 'api-key',
    mode: 'realtime-websocket',
    endpointPath: '/dashscope/api-ws/v1/realtime?model=qwen3-asr-flash-realtime',
    pcmSampleRate: 16_000,
    protocolProfile: 'qwen-asr-server-vad',
  },
  {
    provider: 'litellm-gpt-realtime-whisper',
    model: 'gpt-realtime-whisper',
    auth: 'api-key',
    mode: 'realtime-websocket',
    endpointPath: '/openai/passthrough/v1/realtime?intent=transcription',
    litellmHeaderModel: 'gpt-realtime-whisper',
    // Keep the whole chain at one capture rate: the mic is opened once at the primary
    // provider's rate, but on fallback the active provider declares its own pcmSampleRate to
    // the server. A 24 kHz declaration over 16 kHz PCM distorts transcription. Whisper handles
    // 16 kHz natively (it resamples to 16 kHz internally), so 16 kHz across the chain is safe.
    pcmSampleRate: 16_000,
    protocolProfile: 'openai-transcription-manual',
  },
] as const satisfies readonly MobileVoiceCredentialSyncAsr[];

const MOBILE_VOICE_LITELLM_REFINER_CHAIN = [
  {
    provider: 'litellm-gpt-5.4-mini',
    model: 'gpt-5.4-mini',
    auth: 'api-key',
    transport: 'litellm-chat-completions',
    endpointPath: '/v1/chat/completions',
  },
  {
    provider: 'litellm-deepseek-v4-flash',
    model: 'deepseek/deepseek-v4-flash',
    auth: 'api-key',
    transport: 'litellm-chat-completions',
    endpointPath: '/v1/chat/completions',
  },
] as const satisfies readonly MobileVoiceCredentialSyncRefiner[];

export const __testing = {
  normalizeProxyBaseUrl,
  storageKey: STORAGE_KEY,
};
