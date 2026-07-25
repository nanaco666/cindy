import { describe, expect, it, vi } from 'vitest';

const { refresh, serverApiFetch, ServerApiError } = vi.hoisted(() => {
  class TestServerApiError extends Error {
    constructor(
      public readonly code: string,
      public readonly statusCode: number,
      message: string,
    ) {
      super(message);
      this.name = 'ServerApiError';
    }
  }
  return {
    refresh: vi.fn<() => Promise<boolean>>(),
    serverApiFetch: vi.fn(),
    ServerApiError: TestServerApiError,
  };
});

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '1.2.3') },
}));
vi.mock('../../authManager.js', () => ({
  getAccessToken: vi.fn(() => 'stale-token'),
  refresh,
}));
vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpoint: vi.fn(() => 'https://voice.example.com'),
}));
vi.mock('../../serverApiClient.js', () => ({
  ServerApiError,
  serverApiFetch,
}));

import { CindyVoiceRunContext } from '../CindyVoiceSessionClient.js';

const SESSION = {
  sessionId: 'session-1',
  ticket: 'ticket-1',
  expiresAt: '2026-07-22T00:00:00.000Z',
  asr: {
    provider: 'qwen-asr-flash-realtime',
    websocketUrl: 'wss://voice.example.com/api/voice/asr',
    protocolProfile: 'qwen-asr-server-vad' as const,
    sampleRate: 16_000,
  },
  refiner: { enabled: true, provider: 'qwen-plus' },
};

describe('CindyVoiceRunContext', () => {
  it('refreshes once and retries managed session allocation after a plain 401', async () => {
    refresh.mockResolvedValueOnce(true);
    serverApiFetch
      .mockRejectedValueOnce(new ServerApiError('UNAUTHORIZED', 401, 'Unauthorized'))
      .mockResolvedValueOnce(SESSION);
    const context = new CindyVoiceRunContext('zh-CN', 'qwen-plus');

    await expect(context.createAsrConnection('qwen-asr-flash-realtime')).resolves.toEqual({
      websocketUrl: SESSION.asr.websocketUrl,
      authorizationToken: SESSION.ticket,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(serverApiFetch).toHaveBeenCalledTimes(2);
    expect(serverApiFetch.mock.calls[0]).toEqual(serverApiFetch.mock.calls[1]);
  });
});
