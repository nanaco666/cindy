import Constants from 'expo-constants';

import type { ApiFetchOptions } from '@/api/client';
import { VOICE_API_BASE_URL } from '@/config/env';
import type { StoredMobileVoiceCredential } from '@/session/mobileVoiceCredentialStore';
import { createMobileVoiceCredentialFromLiteLlmSettings } from '@/session/mobileVoiceLiteLlmSettings';

const VOICE_SESSION_REQUEST_TIMEOUT_MS = 10_000;

type AccessTokenProvider = () => Promise<string | null>;
type AuthenticatedApiFetch = <T>(
  path: string,
  options: Omit<ApiFetchOptions, 'token'>,
) => Promise<T>;

type VoiceSessionResponse = {
  sessionId: string;
  ticket: string;
  expiresAt: string;
  asr: {
    provider: string;
    websocketUrl: string;
    protocolProfile: string;
    sampleRate: number;
  };
};

/** Per-dictation holder for one-shot ASR tickets and the owning refine session. */
export class MobileCindyVoiceRunContext {
  private latestSessionId: string | null = null;

  constructor(
    private readonly getAccessToken: AccessTokenProvider,
    private readonly apiFetch: AuthenticatedApiFetch,
    private readonly sourceLanguage: string | undefined,
    private readonly refinerProvider: string | undefined,
  ) {}

  async createAsrConnection(asrProvider: string): Promise<{
    websocketUrl: string;
    authorizationToken: string;
  }> {
    const session = await this.apiFetch<VoiceSessionResponse>('/api/voice/sessions', {
      baseUrl: requireVoiceBaseUrl(),
      method: 'POST',
      body: {
        mode: 'dictation',
        language: this.sourceLanguage,
        client: 'mobile',
        clientVersion: Constants.nativeAppVersion ?? Constants.expoConfig?.version,
        asrProvider,
        refinerProvider: this.refinerProvider,
      },
      timeoutMs: VOICE_SESSION_REQUEST_TIMEOUT_MS,
    });
    if (
      !session.sessionId
      || !session.ticket
      || session.asr?.provider !== asrProvider
      || !/^wss?:\/\//.test(session.asr.websocketUrl)
    ) {
      throw new Error('语音服务返回了无效会话。');
    }
    this.latestSessionId = session.sessionId;
    return { websocketUrl: session.asr.websocketUrl, authorizationToken: session.ticket };
  }

  async createRefinerTarget(refinerProvider: string): Promise<{
    url: string;
    authorization: string;
  }> {
    if (!this.latestSessionId) throw new Error('语音识别会话尚未连接。');
    const token = await this.requireAccessToken();
    return {
      url: `${requireVoiceBaseUrl()}/api/voice/sessions/${encodeURIComponent(this.latestSessionId)}/refine?provider=${encodeURIComponent(refinerProvider)}`,
      authorization: `Bearer ${token}`,
    };
  }

  private async requireAccessToken(): Promise<string> {
    const token = await this.getAccessToken();
    if (!token) throw new Error('请先登录 Cindy 后再使用语音输入。');
    return token;
  }
}

/** Builds the existing provider-neutral profile graph without persisting any inference key. */
export function createMobileCindyVoiceCredential(hostDeviceId: string): StoredMobileVoiceCredential {
  const baseUrl = requireVoiceBaseUrl();
  return createMobileVoiceCredentialFromLiteLlmSettings(hostDeviceId, {
    storageVersion: 1,
    proxyApiKey: 'cindy-voice-session-ticket',
    proxyBaseUrl: baseUrl,
    updatedAt: new Date().toISOString(),
  });
}

function requireVoiceBaseUrl(): string {
  if (!VOICE_API_BASE_URL) throw new Error('当前区域未配置 Cindy 语音服务。');
  return VOICE_API_BASE_URL.replace(/\/+$/, '');
}
