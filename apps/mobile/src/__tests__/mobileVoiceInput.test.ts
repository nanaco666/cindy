import { describe, expect, it, vi } from 'vitest';
import { apiFetchRaw } from '@/api/client';
import { DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL, DEVICE_LINK_API_BASE_URL } from '@/config/env';

const GW_PROXY = `${DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL}/proxy`;
import {
  appendVoiceTranscriptDraft,
  appendVoiceTranscriptDraftWithRange,
  buildMobileRefinerAttempts,
  buildMobileVoiceRefinementContext,
  canCancelMobileVoiceRecording,
  formatMobileVoiceStartupError,
  MOBILE_VOICE_CREDENTIAL_SYNC_UNSUPPORTED_ERROR,
  MOBILE_VOICE_MIC_PERMISSION_ERROR,
  MOBILE_VOICE_REALTIME_AUDIO_UNAVAILABLE_ERROR,
  MOBILE_MAX_VOICE_AUDIO_BYTES,
  isMobileVoiceMicPermissionError,
  mobileVoiceStateLabel,
  MobileLiteLlmTextModelClient,
  normalizeMobileVoiceTranscriptResult,
  presignMobileVoiceUpload,
  putMobileVoiceUpload,
  replaceVoiceTranscriptDraftRange,
  resolveVoiceRecordingMeta,
  transcribeMobileVoiceRecordingWithCredential,
  uploadMobileVoiceRecording,
} from '@/session/mobileVoiceInput';
import type { StoredMobileVoiceCredential } from '@/session/mobileVoiceCredentialStore';

function storedCredential(overrides: Partial<StoredMobileVoiceCredential> = {}): StoredMobileVoiceCredential {
  return {
    temporary: true,
    credentialVersion: 1,
    issuedAt: '2026-06-19T00:00:00.000Z',
    proxyBaseUrl: GW_PROXY,
    proxyApiKey: 'sk-mobile-voice',
    hostDeviceId: 'host-a',
    storageVersion: 1,
    syncedAt: '2026-06-19T00:01:00.000Z',
    asr: {
      provider: 'litellm-batch',
      model: 'elevenlabs/scribe_v2',
      auth: 'api-key',
      mode: 'batch-http',
      endpointPath: '/v1/audio/transcriptions',
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

describe('mobileVoiceInput', () => {
  it('appends transcript into composer draft without losing existing text', () => {
    expect(appendVoiceTranscriptDraft('', '  hello  ')).toBe('hello');
    expect(appendVoiceTranscriptDraft('first line', 'second line')).toBe('first line\nsecond line');
    expect(appendVoiceTranscriptDraft('first line ', 'second line')).toBe('first line second line');
    expect(appendVoiceTranscriptDraft('keep', '   ')).toBe('keep');
  });

  it('tracks the inserted raw transcript range so refinement can replace it in place', () => {
    const first = appendVoiceTranscriptDraftWithRange('first line', ' raw words ');
    expect(first).toEqual({
      draft: 'first line\nraw words',
      insertion: { start: 11, end: 20, text: 'raw words' },
    });
    expect(replaceVoiceTranscriptDraftRange(first.draft, first.insertion, 'refined words')).toBe(
      'first line\nrefined words',
    );
    expect(replaceVoiceTranscriptDraftRange('user edited raw words', first.insertion, 'refined words')).toBe(
      'user edited raw words\nrefined words',
    );
  });

  it('uses compact Chinese labels for the voice button state', () => {
    expect(mobileVoiceStateLabel('idle')).toBe('语音');
    expect(mobileVoiceStateLabel('listening')).toBe('正在听');
    expect(mobileVoiceStateLabel('submitting')).toBe('转写中');
    expect(mobileVoiceStateLabel('refining')).toBe('正在润色');
    expect(mobileVoiceStateLabel('done')).toBe('语音');
    expect(mobileVoiceStateLabel('error')).toBe('语音出错');
  });

  it('maps unsupported desktop voice credential sync to an actionable mobile voice error', () => {
    const error = new Error("channel 'device-link:voice:credential-sync' not allowed remotely") as Error & {
      code: string;
    };
    error.code = 'CHANNEL_NOT_ALLOWED';

    expect(formatMobileVoiceStartupError(error)).toBe(MOBILE_VOICE_CREDENTIAL_SYNC_UNSUPPORTED_ERROR);
  });

  it('keeps unrelated mobile voice startup errors intact', () => {
    expect(formatMobileVoiceStartupError(new Error('microphone failed'))).toBe('microphone failed');
  });

  it('only exposes cancel while a recording is active', () => {
    expect(canCancelMobileVoiceRecording('listening')).toBe(true);
    expect(canCancelMobileVoiceRecording('idle')).toBe(false);
    expect(canCancelMobileVoiceRecording('submitting')).toBe(false);
    expect(canCancelMobileVoiceRecording('refining')).toBe(false);
    expect(canCancelMobileVoiceRecording('error')).toBe(false);
  });

  it('detects microphone permission errors for the settings shortcut', () => {
    expect(isMobileVoiceMicPermissionError(MOBILE_VOICE_MIC_PERMISSION_ERROR)).toBe(true);
    expect(MOBILE_VOICE_REALTIME_AUDIO_UNAVAILABLE_ERROR).toContain('原生录音模块');
    expect(isMobileVoiceMicPermissionError('麦克风权限未开启')).toBe(false);
    expect(isMobileVoiceMicPermissionError(null)).toBe(false);
  });

  it('builds refinement context from synced desktop and local mobile voice settings plus session context', () => {
    const context = buildMobileVoiceRefinementContext(storedCredential({
      settings: {
        language: 'zh-CN',
        refinementEnabled: true,
        playInteractionSound: true,
        refinementInstructions: '保留产品名。',
        dictionaryEntries: [
          {
            text: 'XDMaker',
            frequency: 3,
            aliases: [{ text: 'xd maker', count: 2 }],
          },
        ],
        voiceInputHistory: ['桌面较新的术语', '桌面较早的术语'],
      },
    }), {
      localVoiceInputHistory: ['手机最新术语', '手机较早术语'],
      refinementContext: {
        selectionBefore: '当前输入框前文',
        replyToMessage: '最近的助手回复',
      },
    });

    expect(context).toMatchObject({
      uiLanguage: 'zh-CN',
      sourceLanguage: 'zh-CN',
      userRefinementInstructions: '保留产品名。',
      userDictionary: '- XDMaker',
      dictionaryAliasHints: [
        {
          term: 'XDMaker',
          frequency: 3,
          aliases: [{ text: 'xd maker', count: 2 }],
        },
      ],
      selectionBefore: '当前输入框前文',
      replyToMessage: '最近的助手回复',
    });
    const history = context.voiceInputHistory ?? '';
    expect(history).toContain('语音输入历史');
    expect(history.indexOf('- 桌面较早的术语')).toBeLessThan(history.indexOf('- 桌面较新的术语'));
    expect(history.indexOf('- 桌面较新的术语')).toBeLessThan(history.indexOf('- 手机较早术语'));
    expect(history.indexOf('- 手机较早术语')).toBeLessThan(history.indexOf('- 手机最新术语'));
  });

  it('builds refiner attempts from the desktop-synced provider chain without reselecting models on mobile', () => {
    const attempts = buildMobileRefinerAttempts(storedCredential({
      hostDeviceId: 'desktop-1',
      refiner: {
        provider: 'litellm-qwen3.7-max',
        model: 'qwen/custom-mobile-refiner',
        auth: 'api-key',
        transport: 'litellm-chat-completions',
        endpointPath: '/v1/chat/completions',
      },
      refinerProviderChain: [
        {
          provider: 'litellm-qwen3.7-max',
          model: 'qwen/custom-mobile-refiner',
          auth: 'api-key',
          transport: 'litellm-chat-completions',
          endpointPath: '/v1/chat/completions',
        },
        {
          provider: 'codex-gpt-5.4-nano',
          model: 'gpt-5.4-nano',
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
      ],
    }));

    expect(attempts.map(({ provider, model, promptCacheScope }) => ({
      provider,
      model,
      promptCacheScope,
    }))).toEqual([
      {
        provider: 'litellm-qwen3.7-max',
        model: 'qwen/custom-mobile-refiner',
        promptCacheScope: 'mobile-voice:desktop-1:litellm-qwen3.7-max',
      },
      {
        provider: 'codex-gpt-5.4-nano',
        model: 'gpt-5.4-nano',
        promptCacheScope: 'mobile-voice:desktop-1:codex-gpt-5.4-nano',
      },
      {
        provider: 'litellm-deepseek-v4-flash',
        model: 'deepseek/deepseek-v4-flash',
        promptCacheScope: 'mobile-voice:desktop-1:litellm-deepseek-v4-flash',
      },
    ]);
  });

  it('normalizes the desktop transcribe result before inserting into the draft', () => {
    expect(normalizeMobileVoiceTranscriptResult({
      text: '  识别文本  ',
      provider: 'litellm-batch',
      model: 'elevenlabs/scribe_v2',
    })).toEqual({
      text: '识别文本',
      provider: 'litellm-batch',
      model: 'elevenlabs/scribe_v2',
    });
    expect(normalizeMobileVoiceTranscriptResult(null)).toEqual({ text: '' });
    expect(normalizeMobileVoiceTranscriptResult({ text: 1 })).toEqual({ text: '' });
  });

  it('infers stable upload metadata from recording uri and mime type', () => {
    expect(resolveVoiceRecordingMeta({
      uri: 'file:///tmp/take.webm?cache=1',
    })).toEqual({
      mimeType: 'audio/webm',
      fileName: 'mobile-voice.webm',
      ext: 'webm',
    });
    expect(resolveVoiceRecordingMeta({
      uri: 'file:///tmp/no-extension',
      mimeType: 'audio/wav',
      fileName: 'clip.wav',
    })).toEqual({
      mimeType: 'audio/wav',
      fileName: 'clip.wav',
      ext: 'wav',
    });
  });

  it('requests a device-link media presign-put for the recorded audio', async () => {
    const apiFetch = vi.fn(async () => ({
      putUrl: 'https://oss.example/voice-put',
      key: 'cindy/device-link/user-1/voice.m4a',
      expiresAt: '2026-06-17T00:00:00.000Z',
    }));

    const result = await presignMobileVoiceUpload({
      uri: 'file:///tmp/mobile-voice.m4a',
      size: 4096,
      mimeType: 'audio/mp4',
      fileName: 'mobile-voice.m4a',
    }, { token: 'token-1', deps: { apiFetch: apiFetch as unknown as typeof apiFetchRaw } });

    expect(apiFetch).toHaveBeenCalledWith('/api/device-link/media/presign-put', {
      baseUrl: DEVICE_LINK_API_BASE_URL,
      method: 'POST',
      token: 'token-1',
      body: {
        size: 4096,
        contentType: 'audio/mp4',
        ext: 'm4a',
      },
    });
    expect(result.key).toBe('cindy/device-link/user-1/voice.m4a');
  });

  it('uploads recorded bytes with the signed PUT url', async () => {
    const fetchPut = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
    } as Response));
    const data = new Blob(['voice'], { type: 'audio/mp4' });

    await putMobileVoiceUpload('https://oss.example/voice-put', data, 'audio/mp4', {
      fetch: fetchPut,
    });

    expect(fetchPut).toHaveBeenCalledWith('https://oss.example/voice-put', {
      method: 'PUT',
      headers: {
        'Content-Type': 'audio/mp4',
        'x-oss-object-acl': 'private',
      },
      body: data,
    });
  });

  it('returns the OSS key and desktop-facing audio metadata after upload', async () => {
    const apiFetch = vi.fn(async () => ({
      putUrl: 'https://oss.example/voice-put',
      key: 'cindy/device-link/user-1/mobile-voice.m4a',
      expiresAt: '2026-06-17T00:00:00.000Z',
    }));
    const fetchPut = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
    } as Response));
    const body = new Blob(['voice'], { type: 'audio/mp4' });

    const result = await uploadMobileVoiceRecording({
      uri: 'file:///tmp/rec.m4a',
      size: body.size,
      mimeType: 'audio/mp4',
      durationMs: 1200,
    }, body, {
      token: 'token-1',
      deps: { apiFetch: apiFetch as unknown as typeof apiFetchRaw, fetch: fetchPut },
    });

    expect(result).toEqual({
      ossKey: 'cindy/device-link/user-1/mobile-voice.m4a',
      mimeType: 'audio/mp4',
      fileName: 'mobile-voice.m4a',
      size: body.size,
    });
  });

  it('rejects empty or oversized recordings before presign', async () => {
    const apiFetch = vi.fn();
    await expect(presignMobileVoiceUpload({
      uri: 'file:///tmp/empty.m4a',
      size: 0,
      mimeType: 'audio/mp4',
    }, { token: 'token-1', deps: { apiFetch: apiFetch as unknown as typeof apiFetchRaw } })).rejects.toThrow('录音为空');

    await expect(presignMobileVoiceUpload({
      uri: 'file:///tmp/huge.m4a',
      size: MOBILE_MAX_VOICE_AUDIO_BYTES + 1,
      mimeType: 'audio/mp4',
    }, { token: 'token-1', deps: { apiFetch: apiFetch as unknown as typeof apiFetchRaw } })).rejects.toThrow('录音超过上限');

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('fails when OSS PUT rejects the recorded audio', async () => {
    const fetchPut = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    } as Response));

    await expect(putMobileVoiceUpload('https://oss.example/voice-put', new Blob(['x']), 'audio/mp4', {
      fetch: fetchPut,
    })).rejects.toThrow('语音上传失败: HTTP 403 Forbidden');
  });

  it('transcribes recorded audio on mobile with the stored host credential and refines the result', async () => {
    const fetchCloud = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/audio/transcriptions')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ text: '嗯 我想看一下 litellm' }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ text: '我想看一下 LiteLLM。' }) } }],
        }),
      } as Response;
    });
    const blob = new Blob(['voice'], { type: 'audio/mp4' });
    const submitted: string[] = [];
    const refining: string[] = [];

    const result = await transcribeMobileVoiceRecordingWithCredential({
      uri: 'file:///tmp/mobile-voice.m4a',
      size: blob.size,
      mimeType: 'audio/mp4',
      fileName: 'mobile-voice.m4a',
    }, blob, storedCredential(), {
      deps: { fetch: fetchCloud as unknown as typeof fetch },
      onSubmittedTranscript: (raw) => {
        submitted.push(raw.text);
      },
      onRefinementStarted: (raw) => {
        refining.push(raw.text);
      },
    });

    expect(result).toMatchObject({
      text: '我想看一下 LiteLLM。',
      rawText: '嗯 我想看一下 litellm',
      refined: true,
      provider: 'litellm-batch',
      model: 'elevenlabs/scribe_v2',
      refinerProvider: 'litellm-gpt-5.4-mini',
    });
    expect(fetchCloud).toHaveBeenNthCalledWith(
      1,
      `${GW_PROXY}/v1/audio/transcriptions`,
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer sk-mobile-voice' },
      }),
    );
    const refineBody = JSON.parse((fetchCloud.mock.calls[1][1] as RequestInit).body as string);
    expect(refineBody.model).toBe('gpt-5.4-mini');
    expect(refineBody.response_format).toEqual({ type: 'json_object' });
    expect(refineBody.messages[1].content).toContain('嗯 我想看一下 litellm');
    expect(submitted).toEqual(['嗯 我想看一下 litellm']);
    expect(refining).toEqual(['嗯 我想看一下 litellm']);
  });

  it('falls back through the synced desktop refiner chain before any streamed preview is shown', async () => {
    const fetchCloud = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/audio/transcriptions')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ text: 'raw mobile voice' }),
        } as Response;
      }
      const body = JSON.parse((init?.body as string) ?? '{}') as { model?: string };
      if (body.model === 'gpt-5.4-mini') {
        return {
          ok: false,
          status: 502,
          statusText: 'Bad Gateway',
          text: async () => JSON.stringify({ error: { message: 'primary refiner unavailable' } }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: undefined,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ text: 'refined by fallback' }) } }],
        }),
      } as unknown as Response;
    });
    const blob = new Blob(['voice'], { type: 'audio/mp4' });

    const result = await transcribeMobileVoiceRecordingWithCredential({
      uri: 'file:///tmp/mobile-voice.m4a',
      size: blob.size,
      mimeType: 'audio/mp4',
    }, blob, storedCredential({
      refinerProviderChain: [
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
      ],
    }), {
      deps: { fetch: fetchCloud as unknown as typeof fetch },
    });

    expect(result).toMatchObject({
      text: 'refined by fallback',
      rawText: 'raw mobile voice',
      refined: true,
      refinerProvider: 'litellm-deepseek-v4-flash',
      refinerModel: 'deepseek/deepseek-v4-flash',
    });
    const models = fetchCloud.mock.calls.slice(1).map(([, init]) =>
      JSON.parse((init as RequestInit).body as string).model,
    );
    expect(models).toEqual(['gpt-5.4-mini', 'deepseek/deepseek-v4-flash']);
  });

  it('streams mobile refinement previews from LiteLLM SSE chunks', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          'data: {"choices":[{"delta":{"content":"{\\"text\\":\\"我想"}}]}',
          '',
          'data: {"choices":[{"delta":{"content":"看一下 LiteLLM。\\"}"}}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n')));
        controller.close();
      },
    });
    const fetchCloud = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/audio/transcriptions')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ text: '嗯 我想看一下 litellm' }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: stream,
        json: async () => {
          throw new Error('streaming response should not use json()');
        },
      } as unknown as Response;
    });
    const blob = new Blob(['voice'], { type: 'audio/mp4' });
    const previews: string[] = [];

    const result = await transcribeMobileVoiceRecordingWithCredential({
      uri: 'file:///tmp/mobile-voice.m4a',
      size: blob.size,
      mimeType: 'audio/mp4',
    }, blob, storedCredential(), {
      deps: { fetch: fetchCloud as unknown as typeof fetch },
      onRefinementPreview: (text) => previews.push(text),
    });

    expect(previews).toEqual(['我想', '我想看一下 LiteLLM。']);
    expect(result).toMatchObject({
      text: '我想看一下 LiteLLM。',
      rawText: '嗯 我想看一下 litellm',
      refined: true,
    });
  });

  it('uses the synced refiner endpoint path instead of hardcoding chat completions', async () => {
    const fetchCloud = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: undefined,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ text: 'refined via custom path' }) } }],
      }),
    } as unknown as Response));
    const client = new MobileLiteLlmTextModelClient({
      proxyApiKey: 'sk-mobile-voice',
      baseUrl: GW_PROXY,
      endpointPath: '/custom/chat/completions',
      deps: { fetch: fetchCloud as unknown as typeof fetch },
    });

    await expect(client.requestJson<{ text: string }>({
      model: 'gpt-5.4-mini',
      system: 'Return JSON.',
      user: { text: 'raw' },
      schemaName: 'VoiceRefinement',
    })).resolves.toEqual({ text: 'refined via custom path' });
    expect(fetchCloud).toHaveBeenCalledWith(
      `${GW_PROXY}/custom/chat/completions`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-mobile-voice' }),
      }),
    );
  });

  it('refreshes the managed voice access token once after a 401 refinement response', async () => {
    const fetchCloud = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => '' } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: undefined,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ text: 'refined' }) } }] }),
      } as unknown as Response);
    const requestTargetProvider = vi.fn()
      .mockResolvedValueOnce({ url: 'https://voice.example.com/refine', authorization: 'Bearer stale-token' })
      .mockResolvedValueOnce({ url: 'https://voice.example.com/refine', authorization: 'Bearer fresh-token' });
    const client = new MobileLiteLlmTextModelClient({
      deps: { fetch: fetchCloud as unknown as typeof fetch },
      requestTargetProvider,
    });

    await expect(client.requestJson<{ text: string }>({
      model: 'gpt-5.4-mini',
      system: 'Return JSON.',
      user: { text: 'raw' },
      schemaName: 'VoiceRefinement',
    })).resolves.toEqual({ text: 'refined' });
    expect(requestTargetProvider).toHaveBeenNthCalledWith(1, { refreshAccessToken: false });
    expect(requestTargetProvider).toHaveBeenNthCalledWith(2, { refreshAccessToken: true });
    expect(fetchCloud).toHaveBeenCalledTimes(2);
  });

  it('parses buffered LiteLLM SSE text when React Native fetch has no readable body', async () => {
    const fetchCloud = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/audio/transcriptions')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ text: 'mock realtime voice draft' }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: undefined,
        text: async () => [
          'data: {"choices":[{"delta":{"content":"{\\"text\\":\\"mock refined"}}]}',
          '',
          'data: {"choices":[{"delta":{"content":" voice draft\\"}"}}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
        json: async () => {
          throw new Error('buffered SSE response should not use json()');
        },
      } as unknown as Response;
    });
    const blob = new Blob(['voice'], { type: 'audio/mp4' });
    const previews: string[] = [];

    const result = await transcribeMobileVoiceRecordingWithCredential({
      uri: 'file:///tmp/mobile-voice.m4a',
      size: blob.size,
      mimeType: 'audio/mp4',
    }, blob, storedCredential(), {
      deps: { fetch: fetchCloud as unknown as typeof fetch },
      onRefinementPreview: (text) => previews.push(text),
    });

    expect(previews).toEqual(['mock refined', 'mock refined voice draft']);
    expect(result).toMatchObject({
      text: 'mock refined voice draft',
      rawText: 'mock realtime voice draft',
      refined: true,
    });
  });

  it('can skip refinement and return raw mobile ASR text', async () => {
    const fetchCloud = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ text: 'raw text' }),
    } as Response));
    const blob = new Blob(['voice'], { type: 'audio/mp4' });

    const result = await transcribeMobileVoiceRecordingWithCredential({
      uri: 'file:///tmp/mobile-voice.m4a',
      size: blob.size,
      mimeType: 'audio/mp4',
    }, blob, storedCredential(), {
      refinementEnabled: false,
      deps: { fetch: fetchCloud as unknown as typeof fetch },
    });

    expect(result).toMatchObject({ text: 'raw text', rawText: 'raw text', refined: false });
    expect(fetchCloud).toHaveBeenCalledTimes(1);
  });

  it('keeps raw ASR text when refinement fails', async () => {
    const fetchCloud = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/audio/transcriptions')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ text: 'raw text' }),
        } as Response;
      }
      return {
        ok: false,
        status: 500,
        statusText: 'Server Error',
        json: async () => ({}),
      } as Response;
    });
    const blob = new Blob(['voice'], { type: 'audio/mp4' });

    const result = await transcribeMobileVoiceRecordingWithCredential({
      uri: 'file:///tmp/mobile-voice.m4a',
      size: blob.size,
      mimeType: 'audio/mp4',
    }, blob, storedCredential(), {
      deps: { fetch: fetchCloud as unknown as typeof fetch },
    });

    expect(result).toMatchObject({
      text: 'raw text',
      rawText: 'raw text',
      refined: false,
      refineError: '语音润色失败: HTTP 500 Server Error',
    });
  });

  it('includes redacted cloud ASR error details when transcription fails', async () => {
    const fetchCloud = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({
        error: {
          message: 'invalid bearer sk-mobile-voice for gpt-realtime-whisper',
        },
      }),
    } as unknown as Response));
    const blob = new Blob(['voice'], { type: 'audio/mp4' });

    await expect(transcribeMobileVoiceRecordingWithCredential({
      uri: 'file:///tmp/mobile-voice.m4a',
      size: blob.size,
      mimeType: 'audio/mp4',
    }, blob, storedCredential(), {
      deps: { fetch: fetchCloud as unknown as typeof fetch },
      refinementEnabled: false,
    })).rejects.toThrow(
      '语音识别失败: HTTP 401 Unauthorized · invalid bearer [REDACTED] for gpt-realtime-whisper',
    );
  });

  it('includes redacted cloud refinement error details when the model call fails', async () => {
    const fetchCloud = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/audio/transcriptions')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ text: 'raw text' }),
        } as Response;
      }
      return {
        ok: false,
        status: 500,
        statusText: 'Server Error',
        text: async () => JSON.stringify({
          error: {
            message: 'model gpt-5.4-mini rejected key sk-mobile-voice',
          },
        }),
      } as unknown as Response;
    });
    const blob = new Blob(['voice'], { type: 'audio/mp4' });

    const result = await transcribeMobileVoiceRecordingWithCredential({
      uri: 'file:///tmp/mobile-voice.m4a',
      size: blob.size,
      mimeType: 'audio/mp4',
    }, blob, storedCredential(), {
      deps: { fetch: fetchCloud as unknown as typeof fetch },
    });

    expect(result).toMatchObject({
      text: 'raw text',
      rawText: 'raw text',
      refined: false,
      refineError: '语音润色失败: HTTP 500 Server Error · model gpt-5.4-mini rejected key [REDACTED]',
    });
  });

  it('redacts the synced voice key from refinement errors', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          'data: {"error":{"message":"upstream rejected Authorization Bearer sk-mobile-voice"}}',
          '',
          'data: [DONE]',
          '',
        ].join('\n')));
        controller.close();
      },
    });
    const fetchCloud = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/audio/transcriptions')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ text: 'raw text' }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: stream,
      } as unknown as Response;
    });
    const blob = new Blob(['voice'], { type: 'audio/mp4' });

    const result = await transcribeMobileVoiceRecordingWithCredential({
      uri: 'file:///tmp/mobile-voice.m4a',
      size: blob.size,
      mimeType: 'audio/mp4',
    }, blob, storedCredential(), {
      deps: { fetch: fetchCloud as unknown as typeof fetch },
    });

    expect(result.refineError).toContain('[REDACTED]');
    expect(result.refineError).not.toContain('sk-mobile-voice');
  });

  it('keeps the legacy file-upload transcription helper limited to batch ASR credentials', async () => {
    const blob = new Blob(['voice'], { type: 'audio/mp4' });

    await expect(transcribeMobileVoiceRecordingWithCredential({
      uri: 'file:///tmp/mobile-voice.m4a',
      size: blob.size,
      mimeType: 'audio/mp4',
    }, blob, storedCredential({
      asr: {
        provider: 'litellm-gpt-realtime-whisper',
        model: 'gpt-realtime-whisper',
        auth: 'api-key',
        mode: 'realtime-websocket',
        endpointPath: '/openai/passthrough/v1/realtime?intent=transcription',
      },
    }), {
      deps: { fetch: vi.fn() as unknown as typeof fetch },
    })).rejects.toThrow('暂不支持 realtime-websocket');
  });
});
