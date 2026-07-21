import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-constants', () => ({
  default: {
    nativeAppVersion: '1.2.3',
    expoConfig: { version: '1.2.3' },
  },
}));
vi.mock('@/config/env', () => ({
  VOICE_API_BASE_URL: 'https://voice.example.com/',
}));
vi.mock('@/session/mobileVoiceLiteLlmSettings', () => ({
  createMobileVoiceCredentialFromLiteLlmSettings: vi.fn(),
}));

import { MobileCindyVoiceRunContext } from '@/session/mobileCindyVoiceSession';

describe('MobileCindyVoiceRunContext', () => {
  it('creates managed ASR sessions through the authenticated API wrapper', async () => {
    const getAccessToken = vi.fn(async () => 'access-token');
    const apiFetch = vi.fn(async () => ({
      sessionId: 'session-1',
      ticket: 'ticket-1',
      expiresAt: '2026-07-21T14:00:00.000Z',
      asr: {
        provider: 'qwen-asr-flash-realtime',
        websocketUrl: 'wss://voice.example.com/api/voice/asr?ticket=ticket-1',
        protocolProfile: 'qwen-asr-server-vad',
        sampleRate: 16_000,
      },
    }));
    const context = new MobileCindyVoiceRunContext(
      getAccessToken,
      apiFetch as unknown as ConstructorParameters<typeof MobileCindyVoiceRunContext>[1],
      'zh-CN',
      'qwen-plus',
    );

    await expect(context.createAsrConnection('qwen-asr-flash-realtime')).resolves.toEqual({
      websocketUrl: 'wss://voice.example.com/api/voice/asr?ticket=ticket-1',
      authorizationToken: 'ticket-1',
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/voice/sessions', {
      baseUrl: 'https://voice.example.com',
      method: 'POST',
      body: {
        mode: 'dictation',
        language: 'zh-CN',
        client: 'mobile',
        clientVersion: '1.2.3',
        asrProvider: 'qwen-asr-flash-realtime',
        refinerProvider: 'qwen-plus',
      },
      timeoutMs: 10_000,
    });
    expect(getAccessToken).not.toHaveBeenCalled();
  });
});
