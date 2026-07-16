import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL } from '@/config/env';

const secureItems = vi.hoisted(() => new Map<string, string>());

vi.mock('@/auth/secureStorage', () => ({
  getSecureItem: vi.fn(async (key: string) => secureItems.get(key) ?? null),
  setSecureItem: vi.fn(async (key: string, value: string) => {
    secureItems.set(key, value);
  }),
  deleteSecureItem: vi.fn(async (key: string) => {
    secureItems.delete(key);
  }),
}));

describe('mobileVoiceLiteLlmSettings', () => {
  beforeEach(() => {
    secureItems.clear();
  });

  it('saves and clears the mobile LiteLLM key in secure storage', async () => {
    const {
      __testing,
      clearMobileVoiceLiteLlmSettings,
      getMobileVoiceLiteLlmSettings,
      hasMobileVoiceLiteLlmSettings,
      saveMobileVoiceLiteLlmSettings,
    } = await import('@/session/mobileVoiceLiteLlmSettings');

    await expect(hasMobileVoiceLiteLlmSettings()).resolves.toBe(false);
    await saveMobileVoiceLiteLlmSettings({ proxyApiKey: '  sk-mobile-litellm  ' });

    expect(secureItems.get(__testing.storageKey)).toContain('sk-mobile-litellm');
    await expect(getMobileVoiceLiteLlmSettings()).resolves.toMatchObject({
      proxyApiKey: 'sk-mobile-litellm',
      proxyBaseUrl: DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL,
      storageVersion: 1,
    });
    await expect(hasMobileVoiceLiteLlmSettings()).resolves.toBe(true);

    await clearMobileVoiceLiteLlmSettings();
    await expect(getMobileVoiceLiteLlmSettings()).resolves.toBeNull();
  });

  it('builds mobile voice credentials from the local LiteLLM key without remote sync', async () => {
    const {
      createMobileVoiceCredentialFromLiteLlmSettings,
      saveMobileVoiceLiteLlmSettings,
    } = await import('@/session/mobileVoiceLiteLlmSettings');

    const settings = await saveMobileVoiceLiteLlmSettings({ proxyApiKey: 'sk-local-only' });
    const credential = createMobileVoiceCredentialFromLiteLlmSettings('host-1', settings);

    expect(credential).toMatchObject({
      hostDeviceId: 'host-1',
      proxyBaseUrl: DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL,
      proxyApiKey: 'sk-local-only',
      asr: {
        provider: 'litellm-volcengine-sauc-asr',
        mode: 'provider-native-websocket',
        endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
        resourceId: 'volc.seedasr.sauc.duration',
      },
      refiner: {
        provider: 'litellm-gpt-5.4-mini',
        model: 'gpt-5.4-mini',
        transport: 'litellm-chat-completions',
        endpointPath: '/v1/chat/completions',
      },
      settings: {
        language: 'zh-CN',
        refinementEnabled: true,
        playInteractionSound: true,
      },
    });
    expect(credential.asrProviderChain?.map((item) => item.provider)).toEqual([
      'litellm-volcengine-sauc-asr',
      'litellm-qwen3-asr-flash-realtime',
      'litellm-gpt-realtime-whisper',
    ]);
    expect(credential.refinerProviderChain?.map((item) => item.provider)).toEqual([
      'litellm-gpt-5.4-mini',
      'litellm-deepseek-v4-flash',
    ]);
    expect(credential.refinerProviderChain?.every((item) => item.auth === 'api-key')).toBe(true);
  });

  it('requires the local LiteLLM key before voice input starts', async () => {
    const {
      MOBILE_VOICE_LITELLM_KEY_MISSING_ERROR,
      isMobileVoiceLiteLlmKeyMissingError,
      isMobileVoiceLiteLlmSettingsError,
      resolveMobileVoiceCredentialFromLiteLlmSettings,
    } = await import('@/session/mobileVoiceLiteLlmSettings');

    await expect(resolveMobileVoiceCredentialFromLiteLlmSettings('host-1'))
      .rejects.toThrow(MOBILE_VOICE_LITELLM_KEY_MISSING_ERROR);
    expect(isMobileVoiceLiteLlmKeyMissingError(MOBILE_VOICE_LITELLM_KEY_MISSING_ERROR)).toBe(true);
    expect(isMobileVoiceLiteLlmSettingsError(MOBILE_VOICE_LITELLM_KEY_MISSING_ERROR)).toBe(true);
    expect(isMobileVoiceLiteLlmSettingsError(
      'LiteLLM Key 无效或没有语音识别权限（WebSocket 403）。请在设置里更新 LiteLLM Key 后重试。',
    )).toBe(true);
    expect(isMobileVoiceLiteLlmSettingsError(
      'LiteLLM Key 无效或没有语音识别权限（WebSocket 401）。请在设置里更新 LiteLLM Key 后重试。',
    )).toBe(true);
    expect(isMobileVoiceLiteLlmSettingsError('Realtime ASR connection failed.')).toBe(false);
  });

  it('falls back to the standard gateway when a stored base URL is invalid', async () => {
    const { __testing } = await import('@/session/mobileVoiceLiteLlmSettings');
    expect(__testing.normalizeProxyBaseUrl('ftp://invalid.example.com')).toBe(DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL);
  });
});
