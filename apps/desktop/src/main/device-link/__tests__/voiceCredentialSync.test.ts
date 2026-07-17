import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_XD_GATEWAY_BASE_URL as XD_GATEWAY_BASE_URL } from '../../../test/vitest/clientEndpointsFixture';

const apiKey = vi.hoisted(() => ({ value: 'sk-xd-proxy-secret' as string | null }));
const selection = vi.hoisted(() => ({
  value: {
    asrProvider: 'litellm-volcengine-sauc-asr',
    asrProviderChain: ['litellm-volcengine-sauc-asr', 'litellm-qwen3-asr-flash-realtime'],
    refinerProvider: 'codex-gpt-5.4-mini',
    refinerProviderChain: ['codex-gpt-5.4-mini', 'litellm-gpt-5.4-mini'],
    refinerModel: undefined as string | undefined,
    configPath: '/tmp/voice-input-models.json',
  },
}));

vi.mock('../../maker-host/auth-adapters.js', () => ({
  readClaudeApiKey: () => apiKey.value,
}));

vi.mock('../../maker-host/runtime-configs.js', async () => {
  // 动态 import 避开 vi.mock 工厂提升导致的 TDZ;值即测试 fixture 的网关地址
  const { TEST_XD_GATEWAY_BASE_URL: gateway } = await import(
    '../../../test/vitest/clientEndpointsFixture'
  );
  return { claudeUpstreamEndpoint: () => gateway };
});

vi.mock('../../voice-input/VoiceInputModelSelection.js', () => ({
  getVoiceInputModelSelection: () => selection.value,
}));

vi.mock('../../voice-input/VoiceInputDataStore.js', () => ({
  voiceInputDataStore: {
    getSnapshot: () => ({
      settings: {
        language: 'zh-CN',
        refinementEnabled: true,
        playInteractionSound: true,
        refinementInstructions: '保留技术词。',
        dictionaryEntries: [
          {
            text: 'XDMaker',
            frequency: 3,
            aliases: [{ text: 'xd maker', count: 2 }],
          },
        ],
      },
      history: [],
    }),
    getHistoryForRefinement: () => [
      { id: 'history-1', text: '之前的语音输入', createdAt: 1 },
    ],
  },
}));

describe('voiceCredentialSync', () => {
  beforeEach(() => {
    apiKey.value = 'sk-xd-proxy-secret';
    selection.value = {
      asrProvider: 'litellm-volcengine-sauc-asr',
      asrProviderChain: ['litellm-volcengine-sauc-asr', 'litellm-qwen3-asr-flash-realtime'],
      refinerProvider: 'codex-gpt-5.4-mini',
      refinerProviderChain: ['codex-gpt-5.4-mini', 'litellm-gpt-5.4-mini'],
      refinerModel: undefined,
      configPath: '/tmp/voice-input-models.json',
    };
  });

  it('exports the XD Gateway key plus exact desktop-selected voice profiles', async () => {
    const { syncMobileVoiceCredential } = await import('../voiceCredentialSync');

    const result = syncMobileVoiceCredential();

    expect(result).toMatchObject({
      temporary: true,
      credentialVersion: 1,
      proxyBaseUrl: XD_GATEWAY_BASE_URL,
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
      asrProviderChain: [
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
          provider: 'litellm-qwen3-asr-flash-realtime',
          model: 'qwen3-asr-flash-realtime',
          auth: 'api-key',
          mode: 'realtime-websocket',
          endpointPath: '/dashscope/api-ws/v1/realtime?model=qwen3-asr-flash-realtime',
          pcmSampleRate: 16000,
          protocolProfile: 'qwen-asr-server-vad',
        },
      ],
      refiner: {
        provider: 'codex-gpt-5.4-mini',
        model: 'gpt-5.4-mini',
        auth: 'api-key',
        transport: 'litellm-chat-completions',
        endpointPath: '/v1/chat/completions',
      },
      refinerProviderChain: [
        {
          provider: 'codex-gpt-5.4-mini',
          model: 'gpt-5.4-mini',
          auth: 'api-key',
          transport: 'litellm-chat-completions',
          endpointPath: '/v1/chat/completions',
        },
        {
          provider: 'litellm-gpt-5.4-mini',
          model: 'gpt-5.4-mini',
          auth: 'api-key',
          transport: 'litellm-chat-completions',
          endpointPath: '/v1/chat/completions',
        },
      ],
      settings: {
        language: 'zh-CN',
        refinementEnabled: true,
        playInteractionSound: true,
        refinementInstructions: '保留技术词。',
        dictionaryEntries: [
          {
            text: 'XDMaker',
            frequency: 3,
            aliases: [{ text: 'xd maker', count: 2 }],
          },
        ],
        voiceInputHistory: ['之前的语音输入'],
      },
    });
  });

  it('keeps Codex-selected models while mapping mobile execution to XD Proxy transport', async () => {
    selection.value = {
      ...selection.value,
      asrProvider: 'openai-realtime-whisper',
      asrProviderChain: ['openai-realtime-whisper', 'litellm-gpt-realtime-whisper'],
      refinerProvider: 'codex-gpt-5.4-mini',
      refinerProviderChain: ['codex-gpt-5.4-mini', 'litellm-deepseek-v4-flash'],
      refinerModel: 'custom-primary-model',
    };
    const { syncMobileVoiceCredential } = await import('../voiceCredentialSync');

    const result = syncMobileVoiceCredential();

    expect(result.asr).toMatchObject({
      provider: 'openai-realtime-whisper',
      model: 'gpt-realtime-whisper',
      auth: 'api-key',
      mode: 'realtime-websocket',
      endpointPath: '/openai/passthrough/v1/realtime?intent=transcription',
      pcmSampleRate: 24000,
      protocolProfile: 'openai-transcription-manual',
      litellmHeaderModel: 'gpt-realtime-whisper',
    });
    expect(result.asrProviderChain?.map((item) => item.provider)).toEqual([
      'openai-realtime-whisper',
      'litellm-gpt-realtime-whisper',
    ]);
    expect(result.refiner).toMatchObject({
      provider: 'codex-gpt-5.4-mini',
      model: 'custom-primary-model',
      auth: 'api-key',
      transport: 'litellm-chat-completions',
      endpointPath: '/v1/chat/completions',
    });
    expect(result.refinerProviderChain?.map((item) => item.provider)).toEqual([
      'codex-gpt-5.4-mini',
      'litellm-deepseek-v4-flash',
    ]);
    expect(result.refinerProviderChain?.[0]).toMatchObject({
      provider: 'codex-gpt-5.4-mini',
      model: 'custom-primary-model',
    });
  });

  it('preserves custom refiner model on the desktop-selected refiner', async () => {
    selection.value = {
      ...selection.value,
      refinerProvider: 'litellm-qwen3.7-max',
      refinerProviderChain: ['litellm-qwen3.7-max'],
      refinerModel: 'qwen/custom-mobile-refiner',
    };
    const { syncMobileVoiceCredential } = await import('../voiceCredentialSync');

    const result = syncMobileVoiceCredential();

    expect(result.refiner).toMatchObject({
      provider: 'litellm-qwen3.7-max',
      model: 'qwen/custom-mobile-refiner',
    });
  });

  it('fails fast when the desktop-selected ASR provider cannot stream realtime text on mobile', async () => {
    selection.value = {
      ...selection.value,
      asrProvider: 'litellm-batch',
      asrProviderChain: ['litellm-batch'],
    };
    const { syncMobileVoiceCredential } = await import('../voiceCredentialSync');

    expect(() => syncMobileVoiceCredential()).toThrow('batch-http and cannot stream partial ASR text');
  });

  it('fails fast when the desktop-selected ASR provider needs a direct non-XD-Proxy key', async () => {
    selection.value = {
      ...selection.value,
      asrProvider: 'elevenlabs-scribe-realtime',
      asrProviderChain: ['elevenlabs-scribe-realtime'],
    };
    const { syncMobileVoiceCredential } = await import('../voiceCredentialSync');

    expect(() => syncMobileVoiceCredential()).toThrow('requires a direct ElevenLabs API key');
  });

  it('fails fast when any desktop ASR fallback provider cannot stream realtime text on mobile', async () => {
    selection.value = {
      ...selection.value,
      asrProvider: 'litellm-volcengine-sauc-asr',
      asrProviderChain: ['litellm-volcengine-sauc-asr', 'litellm-batch'],
    };
    const { syncMobileVoiceCredential } = await import('../voiceCredentialSync');

    expect(() => syncMobileVoiceCredential()).toThrow('batch-http and cannot stream partial ASR text');
  });

  it('documents the mobile realtime support boundary for every desktop ASR profile', async () => {
    const { getVoiceInputAsrProfiles } = await import('../../voice-input/voiceInputAsrConfig.js');
    const { __testing } = await import('../voiceCredentialSync');

    const matrix = getVoiceInputAsrProfiles().map((profile) => ({
      provider: profile.id,
      reason: __testing.mobileRealtimeAsrUnsupportedReason(profile),
    }));

    expect(matrix).toEqual([
      {
        provider: 'elevenlabs-scribe-realtime',
        reason: expect.stringContaining('direct ElevenLabs API key'),
      },
      { provider: 'openai-realtime-whisper', reason: null },
      { provider: 'litellm-gpt-realtime-whisper', reason: null },
      { provider: 'litellm-qwen3-asr-flash-realtime', reason: null },
      { provider: 'litellm-volcengine-sauc-asr', reason: null },
      {
        provider: 'litellm-batch',
        reason: expect.stringContaining('batch-http'),
      },
    ]);
  });

  it('maps every desktop refiner profile to the mobile XD Proxy chat-completions transport', async () => {
    const { getVoiceInputRefinerProfiles } = await import('../../../shared/voiceInputRefinerProfiles.js');
    const { __testing } = await import('../voiceCredentialSync');

    const matrix = getVoiceInputRefinerProfiles().map((profile) => ({
      provider: profile.id,
      desktopTransport: profile.transport,
      mobile: __testing.toMobileRefinerConfig(profile),
    }));

    expect(matrix).toEqual([
      {
        provider: 'codex-gpt-5.4-mini',
        desktopTransport: 'codex-responses',
        mobile: expect.objectContaining({
          provider: 'codex-gpt-5.4-mini',
          model: 'gpt-5.4-mini',
          auth: 'api-key',
          transport: 'litellm-chat-completions',
          endpointPath: '/v1/chat/completions',
        }),
      },
      {
        provider: 'codex-gpt-5.4-nano',
        desktopTransport: 'codex-responses',
        mobile: expect.objectContaining({
          provider: 'codex-gpt-5.4-nano',
          model: 'gpt-5.4-nano',
          auth: 'api-key',
          transport: 'litellm-chat-completions',
          endpointPath: '/v1/chat/completions',
        }),
      },
      ...[
        ['litellm-gpt-5.4-mini', 'gpt-5.4-mini'],
        ['litellm-gpt-5.4-nano', 'gpt-5.4-nano'],
        ['litellm-deepseek-v4-flash', 'deepseek/deepseek-v4-flash'],
        ['litellm-qwen3.6-plus', 'qwen/qwen3.6-plus'],
        ['litellm-qwen3.7-max', 'qwen/qwen3.7-max'],
        ['litellm-glm-5.1', 'z-ai/glm-5.1'],
        ['litellm-kimi-k2.6', 'moonshotai/kimi-k2.6'],
      ].map(([provider, model]) => ({
        provider,
        desktopTransport: 'litellm-chat-completions',
        mobile: expect.objectContaining({
          provider,
          model,
          auth: 'api-key',
          transport: 'litellm-chat-completions',
          endpointPath: '/v1/chat/completions',
        }),
      })),
    ]);
  });

  it('throws when the desktop has no Cindy AI key to sync', async () => {
    apiKey.value = null;
    const { syncMobileVoiceCredential } = await import('../voiceCredentialSync');

    expect(() => syncMobileVoiceCredential()).toThrow('Cindy AI key is not configured');
  });

  it('redacts proxyApiKey for logs without mutating the result', async () => {
    const {
      redactMobileVoiceCredentialForLog,
      syncMobileVoiceCredential,
    } = await import('../voiceCredentialSync');
    const result = syncMobileVoiceCredential();

    const redacted = redactMobileVoiceCredentialForLog(result);

    expect(redacted.proxyApiKey).toBe('[REDACTED]');
    expect(JSON.stringify(redacted)).not.toContain('sk-xd-proxy-secret');
    expect(result.proxyApiKey).toBe('sk-xd-proxy-secret');
  });
});
