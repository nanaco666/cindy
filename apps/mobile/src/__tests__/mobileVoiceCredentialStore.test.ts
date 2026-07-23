import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL } from '@/config/env';
import type { MobileVoiceCredentialSyncResult } from '@cindy/maker-shared/device-link-contract';

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

function credential(overrides: Partial<MobileVoiceCredentialSyncResult> = {}): MobileVoiceCredentialSyncResult {
  return {
    temporary: true,
    credentialVersion: 1,
    issuedAt: '2026-06-19T00:00:00.000Z',
    proxyBaseUrl: DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL,
    proxyApiKey: 'sk-xd-proxy-secret',
    asr: {
      provider: 'litellm-volcengine-sauc-asr',
      model: 'volcengine-sauc-asr',
      auth: 'api-key',
      mode: 'provider-native-websocket',
      endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
      pcmSampleRate: 16000,
      protocolProfile: 'volcengine-sauc-duration',
      resourceId: 'volc.seedasr.sauc.duration',
    },
    refiner: {
      provider: 'litellm-gpt-5.4-mini',
      model: 'gpt-5.4-mini',
      auth: 'api-key',
      transport: 'litellm-chat-completions',
      endpointPath: '/v1/chat/completions',
    },
    ...overrides,
  };
}

describe('mobileVoiceCredentialStore', () => {
  beforeEach(() => {
    secureItems.clear();
  });

  it('saves voice credentials per controlled host in secure storage', async () => {
    const {
      __testing,
      getMobileVoiceCredentialForHost,
      saveMobileVoiceCredentialForHost,
    } = await import('@/session/mobileVoiceCredentialStore');

    await saveMobileVoiceCredentialForHost('host-a', credential({ proxyApiKey: 'sk-host-a' }));
    await saveMobileVoiceCredentialForHost('host-b', credential({ proxyApiKey: 'sk-host-b' }));

    await expect(getMobileVoiceCredentialForHost('host-a')).resolves.toMatchObject({
      hostDeviceId: 'host-a',
      storageVersion: 1,
      proxyApiKey: 'sk-host-a',
      asr: { provider: 'litellm-volcengine-sauc-asr' },
      refiner: { provider: 'litellm-gpt-5.4-mini' },
    });
    await expect(getMobileVoiceCredentialForHost('host-b')).resolves.toMatchObject({
      hostDeviceId: 'host-b',
      proxyApiKey: 'sk-host-b',
    });
    await expect(__testing.readCredentialHostIndex()).resolves.toEqual(['host-a', 'host-b']);
  });

  it('deletes only the selected host credential', async () => {
    const {
      __testing,
      deleteMobileVoiceCredentialForHost,
      getMobileVoiceCredentialForHost,
      saveMobileVoiceCredentialForHost,
    } = await import('@/session/mobileVoiceCredentialStore');

    await saveMobileVoiceCredentialForHost('host-a', credential({ proxyApiKey: 'sk-host-a' }));
    await saveMobileVoiceCredentialForHost('host-b', credential({ proxyApiKey: 'sk-host-b' }));
    await deleteMobileVoiceCredentialForHost('host-a');

    await expect(getMobileVoiceCredentialForHost('host-a')).resolves.toBeNull();
    await expect(getMobileVoiceCredentialForHost('host-b')).resolves.toMatchObject({
      proxyApiKey: 'sk-host-b',
    });
    await expect(__testing.readCredentialHostIndex()).resolves.toEqual(['host-b']);
  });

  it('clears all host voice credentials for logout and account switching', async () => {
    const {
      __testing,
      clearAllMobileVoiceCredentials,
      getMobileVoiceCredentialForHost,
      saveMobileVoiceCredentialForHost,
    } = await import('@/session/mobileVoiceCredentialStore');

    await saveMobileVoiceCredentialForHost('host-a', credential({ proxyApiKey: 'sk-host-a' }));
    await saveMobileVoiceCredentialForHost('host-b', credential({ proxyApiKey: 'sk-host-b' }));
    await clearAllMobileVoiceCredentials();

    await expect(getMobileVoiceCredentialForHost('host-a')).resolves.toBeNull();
    await expect(getMobileVoiceCredentialForHost('host-b')).resolves.toBeNull();
    expect(secureItems.has(__testing.storageIndexKey)).toBe(false);
  });

  it('keeps desktop Codex model labels while normalizing stored execution to XD Proxy', async () => {
    const {
      getMobileVoiceCredentialForHost,
      saveMobileVoiceCredentialForHost,
    } = await import('@/session/mobileVoiceCredentialStore');

    await saveMobileVoiceCredentialForHost('host-codex', credential({
      asr: {
        provider: 'openai-realtime-whisper',
        model: 'gpt-realtime-whisper',
        auth: 'codex',
        mode: 'realtime-websocket',
        pcmSampleRate: 24000,
        protocolProfile: 'openai-transcription-manual',
      },
      refiner: {
        provider: 'codex-gpt-5.4-mini',
        model: 'gpt-5.4-mini',
        auth: 'codex',
        transport: 'codex-responses',
      },
      asrProviderChain: [
        {
          provider: 'openai-realtime-whisper',
          model: 'gpt-realtime-whisper',
          auth: 'codex',
          mode: 'realtime-websocket',
          pcmSampleRate: 24000,
          protocolProfile: 'openai-transcription-manual',
        },
        {
          provider: 'litellm-qwen3-asr-flash-realtime',
          model: 'qwen3-asr-flash-realtime',
          auth: 'api-key',
          mode: 'realtime-websocket',
          endpointPath: '/dashscope/api-ws/v1/realtime?model=qwen3-asr-flash-realtime',
          pcmSampleRate: 16000,
          protocolProfile: 'qwen-asr-server-vad',
        },
      ],
      refinerProviderChain: [
        {
          provider: 'codex-gpt-5.4-mini',
          model: 'gpt-5.4-mini',
          auth: 'codex',
          transport: 'codex-responses',
        },
        {
          provider: 'litellm-deepseek-v4-flash',
          model: 'deepseek/deepseek-v4-flash',
          auth: 'api-key',
          transport: 'litellm-chat-completions',
        },
      ],
    }));

    await expect(getMobileVoiceCredentialForHost('host-codex')).resolves.toMatchObject({
      asr: {
        provider: 'openai-realtime-whisper',
        model: 'gpt-realtime-whisper',
        auth: 'api-key',
        endpointPath: '/openai/passthrough/v1/realtime?intent=transcription',
        litellmHeaderModel: 'gpt-realtime-whisper',
      },
      refiner: {
        provider: 'codex-gpt-5.4-mini',
        model: 'gpt-5.4-mini',
        auth: 'api-key',
        transport: 'litellm-chat-completions',
        endpointPath: '/v1/chat/completions',
      },
      asrProviderChain: [
        {
          provider: 'openai-realtime-whisper',
          auth: 'api-key',
          endpointPath: '/openai/passthrough/v1/realtime?intent=transcription',
          litellmHeaderModel: 'gpt-realtime-whisper',
        },
        { provider: 'litellm-qwen3-asr-flash-realtime', auth: 'api-key' },
      ],
      refinerProviderChain: [
        {
          provider: 'codex-gpt-5.4-mini',
          auth: 'api-key',
          transport: 'litellm-chat-completions',
          endpointPath: '/v1/chat/completions',
        },
        {
          provider: 'litellm-deepseek-v4-flash',
          auth: 'api-key',
          transport: 'litellm-chat-completions',
          endpointPath: '/v1/chat/completions',
        },
      ],
    });
  });

  it('preserves the desktop-selected ASR and refiner provider chain order and models', async () => {
    const {
      getMobileVoiceCredentialForHost,
      saveMobileVoiceCredentialForHost,
    } = await import('@/session/mobileVoiceCredentialStore');

    await saveMobileVoiceCredentialForHost('host-chain', credential({
      asr: {
        provider: 'litellm-qwen3-asr-flash-realtime',
        model: 'qwen3-asr-flash-realtime',
        auth: 'api-key',
        mode: 'realtime-websocket',
        endpointPath: '/dashscope/api-ws/v1/realtime?model=qwen3-asr-flash-realtime',
        pcmSampleRate: 16000,
        protocolProfile: 'qwen-asr-server-vad',
      },
      asrProviderChain: [
        {
          provider: 'litellm-qwen3-asr-flash-realtime',
          model: 'qwen3-asr-flash-realtime',
          auth: 'api-key',
          mode: 'realtime-websocket',
          endpointPath: '/dashscope/api-ws/v1/realtime?model=qwen3-asr-flash-realtime',
          pcmSampleRate: 16000,
          protocolProfile: 'qwen-asr-server-vad',
        },
        {
          provider: 'litellm-volcengine-sauc-asr',
          model: 'volcengine-sauc-asr',
          auth: 'api-key',
          mode: 'provider-native-websocket',
          endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
          pcmSampleRate: 16000,
          protocolProfile: 'volcengine-sauc-duration',
          resourceId: 'volc.seedasr.sauc.duration',
        },
        {
          provider: 'openai-realtime-whisper',
          model: 'gpt-realtime-whisper',
          auth: 'codex',
          mode: 'realtime-websocket',
          pcmSampleRate: 24000,
          protocolProfile: 'openai-transcription-manual',
        },
      ],
      refiner: {
        provider: 'litellm-qwen3.7-max',
        model: 'qwen/custom-mobile-refiner',
        auth: 'api-key',
        transport: 'litellm-chat-completions',
      },
      refinerProviderChain: [
        {
          provider: 'litellm-qwen3.7-max',
          model: 'qwen/custom-mobile-refiner',
          auth: 'api-key',
          transport: 'litellm-chat-completions',
        },
        {
          provider: 'codex-gpt-5.4-nano',
          model: 'gpt-5.4-nano',
          auth: 'codex',
          transport: 'codex-responses',
        },
        {
          provider: 'litellm-deepseek-v4-flash',
          model: 'deepseek/deepseek-v4-flash',
          auth: 'api-key',
          transport: 'litellm-chat-completions',
        },
      ],
    }));

    const stored = await getMobileVoiceCredentialForHost('host-chain');

    expect(stored?.asrProviderChain?.map(({ provider, model }) => ({ provider, model }))).toEqual([
      { provider: 'litellm-qwen3-asr-flash-realtime', model: 'qwen3-asr-flash-realtime' },
      { provider: 'litellm-volcengine-sauc-asr', model: 'volcengine-sauc-asr' },
      { provider: 'openai-realtime-whisper', model: 'gpt-realtime-whisper' },
    ]);
    expect(stored?.asrProviderChain?.[2]).toMatchObject({
      auth: 'api-key',
      endpointPath: '/openai/passthrough/v1/realtime?intent=transcription',
      litellmHeaderModel: 'gpt-realtime-whisper',
    });
    expect(stored?.refinerProviderChain?.map(({ provider, model }) => ({ provider, model }))).toEqual([
      { provider: 'litellm-qwen3.7-max', model: 'qwen/custom-mobile-refiner' },
      { provider: 'codex-gpt-5.4-nano', model: 'gpt-5.4-nano' },
      { provider: 'litellm-deepseek-v4-flash', model: 'deepseek/deepseek-v4-flash' },
    ]);
    expect(stored?.refinerProviderChain?.map(({ auth, transport, endpointPath }) => ({
      auth,
      transport,
      endpointPath,
    }))).toEqual([
      {
        auth: 'api-key',
        transport: 'litellm-chat-completions',
        endpointPath: '/v1/chat/completions',
      },
      {
        auth: 'api-key',
        transport: 'litellm-chat-completions',
        endpointPath: '/v1/chat/completions',
      },
      {
        auth: 'api-key',
        transport: 'litellm-chat-completions',
        endpointPath: '/v1/chat/completions',
      },
    ]);
  });

  it('normalizes legacy stored Codex credentials when reading from secure storage', async () => {
    const {
      __testing,
      getMobileVoiceCredentialForHost,
    } = await import('@/session/mobileVoiceCredentialStore');
    const legacyStored = {
      ...credential({
        asr: {
          provider: 'openai-realtime-whisper',
          model: 'gpt-realtime-whisper',
          auth: 'codex',
          mode: 'realtime-websocket',
          pcmSampleRate: 24000,
          protocolProfile: 'openai-transcription-manual',
        },
        refiner: {
          provider: 'codex-gpt-5.4-mini',
          model: 'gpt-5.4-mini',
          auth: 'codex',
          transport: 'codex-responses',
        },
      }),
      hostDeviceId: 'host-codex',
      storageVersion: 1,
      syncedAt: '2026-06-19T00:01:00.000Z',
    };
    secureItems.set(__testing.storageKeyForHostDevice('host-codex'), JSON.stringify(legacyStored));

    await expect(getMobileVoiceCredentialForHost('host-codex')).resolves.toMatchObject({
      asr: {
        auth: 'api-key',
        endpointPath: '/openai/passthrough/v1/realtime?intent=transcription',
      },
      refiner: {
        auth: 'api-key',
        transport: 'litellm-chat-completions',
        endpointPath: '/v1/chat/completions',
      },
    });
  });

  it('syncs and stores a credential when no host credential exists yet', async () => {
    const {
      getMobileVoiceCredentialForHost,
      resolveMobileVoiceCredentialForHost,
    } = await import('@/session/mobileVoiceCredentialStore');
    const sync = vi.fn(async () => credential({ proxyApiKey: 'sk-synced' }));
    const refreshedHosts = new Set<string>();

    const resolved = await resolveMobileVoiceCredentialForHost('host-a', sync, { refreshedHosts });

    expect(sync).toHaveBeenCalledTimes(1);
    expect(refreshedHosts.has('host-a')).toBe(true);
    expect(resolved).toMatchObject({ hostDeviceId: 'host-a', proxyApiKey: 'sk-synced' });
    await expect(getMobileVoiceCredentialForHost('host-a')).resolves.toMatchObject({
      proxyApiKey: 'sk-synced',
    });
  });

  it('refreshes a stored credential once per host so desktop model changes are picked up', async () => {
    const {
      resolveMobileVoiceCredentialForHost,
      saveMobileVoiceCredentialForHost,
    } = await import('@/session/mobileVoiceCredentialStore');
    await saveMobileVoiceCredentialForHost('host-a', credential({
      proxyApiKey: 'sk-old',
      asr: {
        provider: 'old-asr',
        model: 'old-model',
        auth: 'api-key',
        mode: 'realtime-websocket',
        endpointPath: '/old',
      },
    }));
    const refreshedHosts = new Set<string>();
    const sync = vi.fn(async () => credential({
      proxyApiKey: 'sk-new',
      asr: {
        provider: 'new-asr',
        model: 'new-model',
        auth: 'api-key',
        mode: 'realtime-websocket',
        endpointPath: '/new',
      },
    }));

    const first = await resolveMobileVoiceCredentialForHost('host-a', sync, { refreshedHosts });
    const second = await resolveMobileVoiceCredentialForHost('host-a', sync, { refreshedHosts });

    expect(sync).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ proxyApiKey: 'sk-new', asr: { model: 'new-model' } });
    expect(second).toMatchObject({ proxyApiKey: 'sk-new', asr: { model: 'new-model' } });
  });

  it('falls back to a stored credential when refresh fails, but does not mark the host refreshed', async () => {
    const {
      resolveMobileVoiceCredentialForHost,
      saveMobileVoiceCredentialForHost,
    } = await import('@/session/mobileVoiceCredentialStore');
    await saveMobileVoiceCredentialForHost('host-a', credential({ proxyApiKey: 'sk-cached' }));
    const refreshedHosts = new Set<string>();
    const sync = vi.fn(async () => {
      throw new Error('desktop offline');
    });

    const resolved = await resolveMobileVoiceCredentialForHost('host-a', sync, { refreshedHosts });

    expect(sync).toHaveBeenCalledTimes(1);
    expect(refreshedHosts.has('host-a')).toBe(false);
    expect(resolved).toMatchObject({ proxyApiKey: 'sk-cached' });
  });

  it('can require a fresh credential during recovery retry instead of using the stale cache', async () => {
    const {
      resolveMobileVoiceCredentialForHost,
      saveMobileVoiceCredentialForHost,
    } = await import('@/session/mobileVoiceCredentialStore');
    await saveMobileVoiceCredentialForHost('host-a', credential({ proxyApiKey: 'sk-stale' }));
    const refreshedHosts = new Set<string>(['host-a']);
    const sync = vi.fn(async () => {
      throw new Error('desktop offline');
    });

    await expect(resolveMobileVoiceCredentialForHost('host-a', sync, {
      refreshedHosts,
      forceRefresh: true,
      allowStoredFallback: false,
    })).rejects.toThrow('desktop offline');

    expect(sync).toHaveBeenCalledTimes(1);
    expect(refreshedHosts.has('host-a')).toBe(true);
  });

  it('rejects malformed credentials and ignores malformed stored values', async () => {
    const {
      getMobileVoiceCredentialForHost,
      saveMobileVoiceCredentialForHost,
      __testing,
    } = await import('@/session/mobileVoiceCredentialStore');

    await expect(saveMobileVoiceCredentialForHost('host-a', credential({ proxyApiKey: '' })))
      .rejects.toThrow('proxyApiKey');
    secureItems.set(__testing.storageKeyForHostDevice('host-a'), '{broken-json');
    await expect(getMobileVoiceCredentialForHost('host-a')).resolves.toBeNull();
  });

  it('redacts proxyApiKey for diagnostics without mutating the credential', async () => {
    const { redactMobileVoiceCredentialForLog } = await import('@/session/mobileVoiceCredentialStore');
    const { redactMobileVoiceCredentialText } = await import('@/session/mobileVoiceCredentialRedaction');
    const original = credential({ proxyApiKey: 'sk-xd/proxy secret' });

    const redacted = redactMobileVoiceCredentialForLog(original);

    expect(redacted.proxyApiKey).toBe('[REDACTED]');
    expect(JSON.stringify(redacted)).not.toContain('sk-xd/proxy secret');
    expect(original.proxyApiKey).toBe('sk-xd/proxy secret');
    expect(redactMobileVoiceCredentialText(
      'Authorization: Bearer sk-xd/proxy secret rejected',
      original,
    )).toBe('Authorization: Bearer [REDACTED] rejected');
    expect(redactMobileVoiceCredentialText(
      'upstream url contained sk-xd%2Fproxy%20secret',
      original,
    )).toBe('upstream url contained [REDACTED]');
  });
});
