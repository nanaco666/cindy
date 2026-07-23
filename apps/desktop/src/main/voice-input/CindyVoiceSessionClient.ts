import { app } from 'electron';

import * as authManager from '../authManager.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { ServerApiError, serverApiFetch } from '../serverApiClient.js';
import { getAppCapabilities, requireAppCapability } from '../appCapabilities.js';

const VOICE_SESSION_REQUEST_TIMEOUT_MS = 10_000;

export type CindyVoiceAsrSession = {
  sessionId: string;
  ticket: string;
  expiresAt: string;
  asr: {
    provider: string;
    websocketUrl: string;
    protocolProfile:
      | 'volcengine-sauc-duration'
      | 'qwen-asr-server-vad'
      | 'openai-transcription-manual';
    sampleRate: number;
    model?: string;
    resourceId?: string;
  };
  refiner: { enabled: boolean; provider?: string };
};

/** Session-scoped bridge from Cindy identity to one-shot voice data-plane tickets. */
export class CindyVoiceRunContext {
  private latestSessionId: string | null = null;

  constructor(
    private readonly sourceLanguage: string | undefined,
    private readonly refinerProvider: string | undefined,
  ) {}

  async createAsrConnection(asrProvider: string): Promise<{
    websocketUrl: string;
    authorizationToken: string;
  }> {
    const session = await createCindyVoiceSession({
      asrProvider,
      refinerProvider: this.refinerProvider,
      sourceLanguage: this.sourceLanguage,
    });
    this.latestSessionId = session.sessionId;
    return { websocketUrl: session.asr.websocketUrl, authorizationToken: session.ticket };
  }

  async createRefinerTarget(
    refinerProvider: string,
    options?: { forceRefresh?: boolean },
  ): Promise<{
    url: string;
    authorization: string;
  }> {
    const sessionId = this.latestSessionId;
    if (!sessionId) throw new Error('Voice ASR session is not connected yet.');
    let token = authManager.getAccessToken();
    if (!token || options?.forceRefresh) {
      await authManager.refresh();
      token = authManager.getAccessToken();
    }
    if (!token) throw new Error('Cindy login is required for voice refinement.');
    const baseUrl = getClientEndpoint('voiceApiBaseUrl');
    if (!baseUrl) throw new Error('Cindy voice service is unavailable in this region.');
    return {
      url: `${baseUrl}/api/voice/sessions/${encodeURIComponent(sessionId)}/refine?provider=${encodeURIComponent(refinerProvider)}`,
      authorization: `Bearer ${token}`,
    };
  }
}

export function isCindyVoiceServiceReady(): boolean {
  return Boolean(
    getAppCapabilities().canUseCindyAccountServices
    && getClientEndpoint('voiceApiBaseUrl')
    && authManager.getAccessToken(),
  );
}

async function createCindyVoiceSession(input: {
  asrProvider: string;
  refinerProvider?: string;
  sourceLanguage?: string;
}): Promise<CindyVoiceAsrSession> {
  requireAppCapability('canUseCindyAccountServices', 'Cindy voice requires a Cindy account.');
  const baseUrl = getClientEndpoint('voiceApiBaseUrl');
  if (!baseUrl) throw new Error('Cindy voice service is unavailable in this region.');
  const request = {
    baseUrl,
    method: 'POST',
    body: {
      mode: 'dictation',
      language: input.sourceLanguage,
      client: 'desktop',
      clientVersion: app.getVersion(),
      asrProvider: input.asrProvider,
      refinerProvider: input.refinerProvider,
    },
    timeoutMs: VOICE_SESSION_REQUEST_TIMEOUT_MS,
  } as const;
  let session: CindyVoiceAsrSession;
  try {
    session = await serverApiFetch<CindyVoiceAsrSession>('/api/voice/sessions', request);
  } catch (error) {
    // serverApiFetch already handles TOKEN_EXPIRED. A plain 401 can still
    // indicate a revoked cached access token, so refresh once and retry the
    // allocation before surfacing the auth failure.
    if (!(error instanceof ServerApiError) || error.statusCode !== 401 || error.code !== 'UNAUTHORIZED') {
      throw error;
    }
    if (!await authManager.refresh()) throw error;
    session = await serverApiFetch<CindyVoiceAsrSession>('/api/voice/sessions', request);
  }
  if (
    session.asr.provider !== input.asrProvider
    || !session.ticket
    || !session.sessionId
    || !/^wss?:\/\//.test(session.asr.websocketUrl)
  ) {
    throw new Error('Cindy voice service returned an invalid session.');
  }
  return session;
}
