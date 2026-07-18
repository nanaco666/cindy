import { apiFetchRaw } from '@/api/client';
import { DEVICE_LINK_API_BASE_URL } from '@/config/env';
import {
  DictationRefiner,
  extractJsonStringFieldSnapshot,
  type DictationRefinementContext,
  type TextModelClient,
} from '@lizi/voice-input-core';
import type { StoredMobileVoiceCredential } from '@/session/mobileVoiceCredentialStore';
import { redactMobileVoiceCredentialText } from '@/session/mobileVoiceCredentialRedaction';
import {
  composerVoiceStateLabel,
  type ComposerVoiceState,
} from '@lizi/maker-shared/session-operation';
import { formatRemoteError } from '@lizi/maker-shared/device-link-contract';

export const MOBILE_MAX_VOICE_AUDIO_BYTES = 64 * 1024 * 1024;
export const MOBILE_VOICE_MIC_PERMISSION_ERROR = '麦克风权限未开启，请在系统设置里允许 Cindy 使用麦克风。';
export const MOBILE_VOICE_REALTIME_AUDIO_UNAVAILABLE_ERROR = '当前安装包不支持实时语音输入，请安装包含原生录音模块的测试版。';
export const MOBILE_VOICE_CREDENTIAL_SYNC_UNSUPPORTED_ERROR =
  '当前被控电脑端版本还不支持手机实时语音输入，请更新或重启桌面端后再试。';

export type MobileVoiceState = ComposerVoiceState;

export interface MobileVoiceRecording {
  uri: string;
  size: number;
  mimeType?: string;
  fileName?: string;
  durationMs?: number;
}

export interface MobileVoiceUploadResult {
  ossKey: string;
  mimeType: string;
  fileName: string;
  size: number;
}

export interface MobileVoiceDraftInsertion {
  start: number;
  end: number;
  text: string;
}

interface VoicePresignResult {
  putUrl: string;
  key: string;
  expiresAt: string;
}

interface UploadDeps {
  apiFetch?: typeof apiFetchRaw;
  fetch?: typeof fetch;
}

interface CloudVoiceDeps {
  fetch?: typeof fetch;
}

const MOBILE_VOICE_INPUT_HISTORY_HEADER = '语音输入历史（旧到新，仅作术语、别名和用词风格参考）：';
const MAX_MOBILE_VOICE_HISTORY_ENTRIES_FOR_REFINEMENT = 100;
const MAX_MOBILE_VOICE_HISTORY_ITEM_CHARS = 360;
const MAX_REFINER_RESPONSE_CHARS = 64_000;
const MAX_ERROR_DETAIL_CHARS = 1_000;

export interface MobileVoiceCloudTranscribeResult {
  text: string;
  provider: string;
  model: string;
  rawText: string;
  refined: boolean;
  refinerProvider?: string;
  refinerModel?: string;
  refineError?: string;
}

export type MobileRefinerAttempt = {
  provider: string;
  model: string;
  client: TextModelClient;
  promptCacheScope?: string;
};

export function appendVoiceTranscriptDraft(current: string, transcript: string): string {
  return appendVoiceTranscriptDraftWithRange(current, transcript).draft;
}

export function appendVoiceTranscriptDraftWithRange(
  current: string,
  transcript: string,
): { draft: string; insertion: MobileVoiceDraftInsertion | null } {
  const text = transcript.trim();
  if (!text) return { draft: current, insertion: null };
  const base = current.trimEnd();
  if (!base) {
    return {
      draft: text,
      insertion: { start: 0, end: text.length, text },
    };
  }
  if (/[\s\n]$/.test(current)) {
    const start = current.length;
    return {
      draft: `${current}${text}`,
      insertion: { start, end: start + text.length, text },
    };
  }
  const start = base.length + 1;
  return {
    draft: `${base}\n${text}`,
    insertion: { start, end: start + text.length, text },
  };
}

export function replaceVoiceTranscriptDraftRange(
  current: string,
  insertion: MobileVoiceDraftInsertion | null,
  transcript: string,
): string {
  const text = transcript.trim();
  if (!text) return current;
  if (!insertion) return appendVoiceTranscriptDraft(current, text);
  if (current.slice(insertion.start, insertion.end) !== insertion.text) {
    return appendVoiceTranscriptDraft(current, text);
  }
  return `${current.slice(0, insertion.start)}${text}${current.slice(insertion.end)}`;
}

export function mobileVoiceStateLabel(state: MobileVoiceState): string {
  return composerVoiceStateLabel(state);
}

export function canCancelMobileVoiceRecording(state: MobileVoiceState): boolean {
  return state === 'listening';
}

export function isMobileVoiceMicPermissionError(message: string | null | undefined): boolean {
  return message === MOBILE_VOICE_MIC_PERMISSION_ERROR;
}

export function formatMobileVoiceStartupError(error: unknown): string {
  const formatted = formatRemoteError(error);
  if (
    formatted.includes('device-link:voice:credential-sync')
    && (formatted.includes('CHANNEL_NOT_ALLOWED') || formatted.includes('DEVICE_LINK_CHANNEL_NOT_ALLOWED'))
  ) {
    return MOBILE_VOICE_CREDENTIAL_SYNC_UNSUPPORTED_ERROR;
  }
  return formatted;
}

export function normalizeMobileVoiceTranscriptResult(value: unknown): { text: string; provider?: string; model?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { text: '' };
  const record = value as Record<string, unknown>;
  return {
    text: typeof record.text === 'string' ? record.text.trim() : '',
    provider: typeof record.provider === 'string' ? record.provider : undefined,
    model: typeof record.model === 'string' ? record.model : undefined,
  };
}

export function resolveVoiceRecordingMeta(input: {
  uri: string;
  mimeType?: string | null;
  fileName?: string | null;
}): { mimeType: string; fileName: string; ext: string } {
  const uriExt = extensionFromName(input.fileName || input.uri);
  const mimeType = input.mimeType?.trim()
    || mimeTypeForExtension(uriExt)
    || 'audio/mp4';
  const ext = uriExt || extensionForMimeType(mimeType) || 'm4a';
  return {
    mimeType,
    fileName: input.fileName?.trim() || `mobile-voice.${ext}`,
    ext,
  };
}

export async function presignMobileVoiceUpload(
  recording: Pick<MobileVoiceRecording, 'size' | 'mimeType' | 'fileName' | 'uri'>,
  options: { token: string | null; deps?: UploadDeps },
): Promise<VoicePresignResult> {
  if (!Number.isFinite(recording.size) || recording.size <= 0) {
    throw new Error('录音为空，不能转写。');
  }
  if (recording.size > MOBILE_MAX_VOICE_AUDIO_BYTES) {
    throw new Error(`录音超过上限 ${Math.round(MOBILE_MAX_VOICE_AUDIO_BYTES / 1024 / 1024)}MB。`);
  }
  const apiFetch = options.deps?.apiFetch ?? apiFetchRaw;
  const meta = resolveVoiceRecordingMeta(recording);
  const result = await apiFetch<VoicePresignResult>('/api/device-link/media/presign-put', {
    baseUrl: DEVICE_LINK_API_BASE_URL,
    method: 'POST',
    token: options.token,
    body: {
      size: recording.size,
      contentType: meta.mimeType,
      ext: meta.ext,
    },
  });
  if (!result || typeof result.putUrl !== 'string' || typeof result.key !== 'string') {
    throw new Error('服务端没有返回有效的语音上传地址。');
  }
  return result;
}

export async function putMobileVoiceUpload(
  putUrl: string,
  body: BodyInit,
  mimeType: string,
  deps: UploadDeps = {},
): Promise<void> {
  const fetchImpl = deps.fetch ?? fetch;
  const response = await fetchImpl(putUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType,
      'x-oss-object-acl': 'private',
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`语音上传失败: HTTP ${response.status} ${response.statusText}`);
  }
}

export async function uploadMobileVoiceRecording(
  recording: MobileVoiceRecording,
  body: BodyInit,
  options: { token: string | null; deps?: UploadDeps },
): Promise<MobileVoiceUploadResult> {
  const meta = resolveVoiceRecordingMeta(recording);
  const presigned = await presignMobileVoiceUpload(recording, options);
  await putMobileVoiceUpload(presigned.putUrl, body, meta.mimeType, options.deps);
  return {
    ossKey: presigned.key,
    mimeType: meta.mimeType,
    fileName: meta.fileName,
    size: recording.size,
  };
}

export async function transcribeMobileVoiceRecordingWithCredential(
  recording: MobileVoiceRecording,
  body: Blob,
  credential: StoredMobileVoiceCredential,
  options: {
    sourceLanguage?: string;
    refinementEnabled?: boolean;
    refinementContext?: DictationRefinementContext;
    localVoiceInputHistory?: readonly string[];
    deps?: CloudVoiceDeps;
    onSubmittedTranscript?: (result: MobileVoiceCloudTranscribeResult) => void | Promise<void>;
    onRefinementStarted?: (result: MobileVoiceCloudTranscribeResult) => void | Promise<void>;
    onRefinementPreview?: (text: string) => void;
  } = {},
): Promise<MobileVoiceCloudTranscribeResult> {
  // Legacy file-upload helper kept for protocol/media regression tests. The
  // interactive mobile composer uses createMobileVoiceControllerSession so ASR
  // partials are visible while recording and refinement streams into the draft.
  const raw = await transcribeMobileVoiceAsr(recording, body, credential, options);
  const submitted: MobileVoiceCloudTranscribeResult = {
    ...raw,
    rawText: raw.text,
    refined: false,
  };
  await options.onSubmittedTranscript?.(submitted);
  if (!raw.text || options.refinementEnabled === false) {
    return submitted;
  }

  try {
    await options.onRefinementStarted?.(submitted);
    const refinerAttempts = buildMobileRefinerAttempts(credential, options.deps);
    const refinerClient = createMobileRefinerTextModelClient(refinerAttempts);
    const refiner = new DictationRefiner({
      client: refinerClient,
      model: refinerAttempts[0]?.model ?? credential.refiner.model,
      promptCacheScope: refinerAttempts[0]?.promptCacheScope ?? `mobile-voice:${credential.hostDeviceId}`,
      contextProvider: () => buildMobileVoiceRefinementContext(credential, options),
    });
    const refined = await refiner.refine({
      text: raw.text,
      runId: `mobile-voice-${Date.now()}`,
      segmentIds: ['mobile-voice'],
      onPartial: options.onRefinementPreview,
    });
    if (refined.accepted && refined.refinedText) {
      const usedAttempt = refinerClient instanceof MobileFallbackTextModelClient
        ? refinerClient.lastSuccessfulAttempt
        : refinerAttempts[0];
      return {
        ...raw,
        text: refined.refinedText,
        rawText: raw.text,
        refined: true,
        refinerProvider: usedAttempt?.provider ?? credential.refiner.provider,
        refinerModel: usedAttempt?.model ?? credential.refiner.model,
      };
    }
    return {
      ...raw,
      rawText: raw.text,
      refined: false,
      refinerProvider: credential.refiner.provider,
      refinerModel: credential.refiner.model,
    };
  } catch (err) {
    return {
      ...raw,
      rawText: raw.text,
      refined: false,
      refinerProvider: credential.refiner.provider,
      refinerModel: credential.refiner.model,
      refineError: redactMobileVoiceCredentialText(err, credential),
    };
  }
}

export function buildMobileVoiceRefinementContext(
  credential: StoredMobileVoiceCredential,
  options: {
    sourceLanguage?: string;
    refinementContext?: DictationRefinementContext;
    localVoiceInputHistory?: readonly string[];
  } = {},
): DictationRefinementContext {
  const settings = credential.settings;
  const dictionaryEntries = settings?.dictionaryEntries ?? [];
  const history = mergeMobileVoiceHistories(settings?.voiceInputHistory, options.localVoiceInputHistory);
  const base: DictationRefinementContext = {
    uiLanguage: 'zh-CN',
    sourceLanguage: options.sourceLanguage ?? resolveSyncedSourceLanguage(settings?.language),
    userRefinementInstructions: settings?.refinementInstructions?.trim() || undefined,
    userDictionary: formatMobileVoiceDictionary(dictionaryEntries) || undefined,
    dictionaryAliasHints: dictionaryEntries.map((entry) => ({
      term: entry.text,
      frequency: entry.frequency,
      aliases: entry.aliases ?? [],
    })),
    voiceInputHistory: formatMobileVoiceHistory(history) || undefined,
  };
  return {
    ...base,
    ...options.refinementContext,
    uiLanguage: options.refinementContext?.uiLanguage ?? base.uiLanguage,
    sourceLanguage: options.refinementContext?.sourceLanguage ?? base.sourceLanguage,
  };
}

async function transcribeMobileVoiceAsr(
  recording: MobileVoiceRecording,
  body: Blob,
  credential: StoredMobileVoiceCredential,
  options: { sourceLanguage?: string; deps?: CloudVoiceDeps },
): Promise<Omit<MobileVoiceCloudTranscribeResult, 'rawText' | 'refined' | 'refineError'>> {
  if (!Number.isFinite(recording.size) || recording.size <= 0) {
    throw new Error('录音为空，不能转写。');
  }
  if (recording.size > MOBILE_MAX_VOICE_AUDIO_BYTES) {
    throw new Error(`录音超过上限 ${Math.round(MOBILE_MAX_VOICE_AUDIO_BYTES / 1024 / 1024)}MB。`);
  }
  if (credential.asr.mode !== 'batch-http') {
    throw new Error(`手机版暂不支持 ${credential.asr.mode} 语音识别，请重新同步 batch ASR 配置。`);
  }
  if (!credential.asr.endpointPath) {
    throw new Error('语音识别配置缺少 endpointPath。');
  }

  const meta = resolveVoiceRecordingMeta(recording);
  const form = new FormData();
  form.append('model', credential.asr.model);
  if (options.sourceLanguage) form.append('language', options.sourceLanguage);
  form.append('file', body, meta.fileName);

  const fetchImpl = options.deps?.fetch ?? fetch;
  const response = await fetchImpl(joinProxyPath(credential.proxyBaseUrl, credential.asr.endpointPath), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credential.proxyApiKey}`,
    },
    body: form,
  });
  if (!response.ok) {
    throw new Error(await cloudVoiceHttpErrorMessage('语音识别失败', response, credential));
  }
  const payload = await response.json().catch(() => null);
  const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  if (!text) throw new Error('语音识别没有返回文本。');
  return {
    text,
    provider: credential.asr.provider,
    model: credential.asr.model,
    refinerProvider: credential.refiner.provider,
    refinerModel: credential.refiner.model,
  };
}

export class MobileLiteLlmTextModelClient implements TextModelClient {
  private readonly proxyApiKey: string;
  private readonly baseUrl: string;
  private readonly endpointPath: string;
  private readonly deps?: CloudVoiceDeps;

  constructor(options: { proxyApiKey: string; baseUrl: string; endpointPath?: string; deps?: CloudVoiceDeps }) {
    this.proxyApiKey = options.proxyApiKey;
    this.baseUrl = options.baseUrl;
    this.endpointPath = options.endpointPath ?? '/v1/chat/completions';
    this.deps = options.deps;
  }

  async requestJson<T>(input: {
    model: string;
    system: string;
    user: unknown;
    schemaName: string;
    promptCacheScope?: string;
    onTextSnapshot?: (text: string) => void;
  }): Promise<T> {
    const fetchImpl = this.deps?.fetch ?? fetch;
    const response = await fetchImpl(joinProxyPath(this.baseUrl, this.endpointPath), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.proxyApiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: input.model,
        response_format: { type: 'json_object' },
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: 'system', content: input.system },
          {
            role: 'user',
            content: JSON.stringify({
              schemaName: input.schemaName,
              input: input.user,
            }),
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(await cloudVoiceHttpErrorMessage('语音润色失败', response, this.proxyApiKey));
    }
    try {
      if (hasReadableStreamBody(response.body)) {
        const content = await readStreamingChatCompletion(response.body, input.onTextSnapshot);
        return parseJsonObject(content) as T;
      }
      const buffered = await readBufferedResponseText(response);
      if (buffered.trim()) {
        if (buffered.length > MAX_REFINER_RESPONSE_CHARS) {
          throw new Error(`语音润色返回内容超过上限 ${MAX_REFINER_RESPONSE_CHARS} 字符。`);
        }
        const streamedContent = readBufferedChatCompletion(buffered, input.onTextSnapshot);
        if (streamedContent) return parseJsonObject(streamedContent) as T;
        const payload = parseJsonObject(buffered);
        const content = extractChatCompletionContent(payload);
        return parseJsonObject(content) as T;
      }
      const payload = await response.json().catch(() => null);
      const content = extractChatCompletionContent(payload);
      return parseJsonObject(content) as T;
    } catch (err) {
      throw new Error(redactMobileVoiceCredentialText(err, this.proxyApiKey));
    }
  }
}

export class MobileFallbackTextModelClient implements TextModelClient {
  private readonly attempts: MobileRefinerAttempt[];
  private successfulAttempt: MobileRefinerAttempt | null = null;

  constructor(attempts: MobileRefinerAttempt[]) {
    if (attempts.length === 0) throw new Error('Mobile refiner fallback requires at least one attempt.');
    this.attempts = attempts;
  }

  get lastSuccessfulAttempt(): MobileRefinerAttempt | null {
    return this.successfulAttempt;
  }

  async requestJson<T>(input: {
    model: string;
    system: string;
    user: unknown;
    schemaName: string;
    promptCacheScope?: string;
    onTextSnapshot?: (text: string) => void;
  }): Promise<T> {
    let lastError: unknown = null;
    for (const attempt of this.attempts) {
      let partialEmitted = false;
      try {
        const result = await attempt.client.requestJson<T>({
          ...input,
          model: attempt.model,
          promptCacheScope: attempt.promptCacheScope ?? input.promptCacheScope,
          onTextSnapshot: input.onTextSnapshot
            ? (text) => {
              partialEmitted = true;
              input.onTextSnapshot?.(text);
            }
            : undefined,
        });
        this.successfulAttempt = attempt;
        return result;
      } catch (err) {
        lastError = err;
        if (partialEmitted) throw err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('All mobile voice refiner providers failed.');
  }
}

export function buildMobileRefinerAttempts(
  credential: StoredMobileVoiceCredential,
  deps?: CloudVoiceDeps,
): MobileRefinerAttempt[] {
  const chain = mobileRefinerCredentialChain(credential);
  return chain.map((refiner) => ({
    provider: refiner.provider,
    model: refiner.model,
    promptCacheScope: `mobile-voice:${credential.hostDeviceId}:${refiner.provider}`,
    client: new MobileLiteLlmTextModelClient({
      proxyApiKey: credential.proxyApiKey,
      baseUrl: credential.proxyBaseUrl,
      endpointPath: refiner.endpointPath,
      deps,
    }),
  }));
}

export function createMobileRefinerTextModelClient(attempts: MobileRefinerAttempt[]): TextModelClient {
  if (attempts.length === 1) return attempts[0].client;
  return new MobileFallbackTextModelClient(attempts);
}

async function readStreamingChatCompletion(
  body: ReadableStream<Uint8Array>,
  onTextSnapshot?: (text: string) => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let rawChars = 0;
  let lastSnapshot = '';
  let streamError: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      rawChars += chunk.length;
      if (rawChars > MAX_REFINER_RESPONSE_CHARS) {
        throw new Error(`语音润色返回内容超过上限 ${MAX_REFINER_RESPONSE_CHARS} 字符。`);
      }
      buffer += normalizeSseLineEndings(chunk);
      let splitAt = buffer.indexOf('\n\n');
      while (splitAt >= 0) {
        const block = buffer.slice(0, splitAt);
        buffer = buffer.slice(splitAt + 2);
        const event = parseSseBlock(block);
        if (event) {
          if (isRecord(event.data) && isRecord(event.data.error)) {
            streamError = typeof event.data.error.message === 'string'
              ? event.data.error.message
              : '语音润色流式返回失败。';
          }
          const delta = extractDeltaContent(event.data);
          if (delta) {
            content += delta;
            const snapshot = extractJsonStringFieldSnapshot(content, 'text');
            if (snapshot && snapshot !== lastSnapshot) {
              lastSnapshot = snapshot;
              onTextSnapshot?.(snapshot);
            }
          }
        }
        splitAt = buffer.indexOf('\n\n');
      }
    }

    if (buffer.trim()) {
      const event = parseSseBlock(buffer);
      const delta = event ? extractDeltaContent(event.data) : '';
      if (delta) {
        content += delta;
        const snapshot = extractJsonStringFieldSnapshot(content, 'text');
        if (snapshot && snapshot !== lastSnapshot) onTextSnapshot?.(snapshot);
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (streamError) throw new Error(streamError);
  return content.trim();
}

async function readBufferedResponseText(response: Response): Promise<string> {
  const textReader = (response as { text?: unknown }).text;
  if (typeof textReader !== 'function') return '';
  try {
    return await textReader.call(response);
  } catch {
    return '';
  }
}

async function cloudVoiceHttpErrorMessage(
  prefix: string,
  response: Response,
  credential: { proxyApiKey?: unknown } | string,
): Promise<string> {
  const status = `HTTP ${response.status} ${response.statusText}`.trim();
  const raw = await readBufferedResponseText(response);
  const detail = extractCloudVoiceErrorDetail(raw);
  const message = detail ? `${prefix}: ${status} · ${detail}` : `${prefix}: ${status}`;
  return redactMobileVoiceCredentialText(message, credential);
}

function extractCloudVoiceErrorDetail(raw: string): string {
  const text = raw.trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text) as unknown;
    return truncateErrorDetail(readCloudVoiceErrorMessage(parsed) ?? text);
  } catch {
    return truncateErrorDetail(text);
  }
}

function readCloudVoiceErrorMessage(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const detail = value.detail;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  const message = value.message;
  if (typeof message === 'string' && message.trim()) return message.trim();
  const error = value.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (isRecord(error)) {
    const errorMessage = error.message;
    if (typeof errorMessage === 'string' && errorMessage.trim()) return errorMessage.trim();
    const errorDetail = error.detail;
    if (typeof errorDetail === 'string' && errorDetail.trim()) return errorDetail.trim();
  }
  return null;
}

function truncateErrorDetail(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_ERROR_DETAIL_CHARS) return normalized;
  return `${normalized.slice(0, MAX_ERROR_DETAIL_CHARS)}...`;
}

function readBufferedChatCompletion(raw: string, onTextSnapshot?: (text: string) => void): string {
  const state = createChatCompletionStreamState();
  const normalized = normalizeSseLineEndings(raw);
  for (const block of normalized.split(/\n\n+/)) {
    if (!block.trim()) continue;
    const event = parseSseBlock(block);
    if (event) applyChatCompletionEvent(event, state, onTextSnapshot);
  }
  if (state.streamError) throw new Error(state.streamError);
  return state.content.trim();
}

type ParsedSseBlock = { data: unknown };

type ChatCompletionStreamState = {
  content: string;
  lastSnapshot: string;
  streamError: string | null;
};

function createChatCompletionStreamState(): ChatCompletionStreamState {
  return {
    content: '',
    lastSnapshot: '',
    streamError: null,
  };
}

function applyChatCompletionEvent(
  event: ParsedSseBlock,
  state: ChatCompletionStreamState,
  onTextSnapshot?: (text: string) => void,
): void {
  if (isRecord(event.data) && isRecord(event.data.error)) {
    state.streamError = typeof event.data.error.message === 'string'
      ? event.data.error.message
      : '语音润色流式返回失败。';
  }
  const delta = extractDeltaContent(event.data);
  if (!delta) return;
  state.content += delta;
  const snapshot = extractJsonStringFieldSnapshot(state.content, 'text');
  if (snapshot && snapshot !== state.lastSnapshot) {
    state.lastSnapshot = snapshot;
    onTextSnapshot?.(snapshot);
  }
}

function parseSseBlock(block: string): ParsedSseBlock | null {
  const dataLines: string[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  }
  if (dataLines.length === 0) return null;
  const dataStr = dataLines.join('\n');
  if (dataStr === '[DONE]') return { data: {} };
  try {
    return { data: JSON.parse(dataStr) };
  } catch {
    return null;
  }
}

function normalizeSseLineEndings(chunk: string): string {
  return chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function extractDeltaContent(chunk: unknown): string {
  if (!isRecord(chunk) || !Array.isArray(chunk.choices)) return '';
  return chunk.choices
    .map((choice) => {
      if (!isRecord(choice)) return '';
      const delta = isRecord(choice.delta) ? choice.delta : null;
      const content = delta?.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .map((part) => {
            if (typeof part === 'string') return part;
            if (isRecord(part) && typeof part.text === 'string') return part.text;
            return '';
          })
          .join('');
      }
      return '';
    })
    .join('');
}

function extractChatCompletionContent(value: unknown): string {
  if (!value || typeof value !== 'object') throw new Error('语音润色没有返回有效内容。');
  const choice = (value as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === 'string' && content.trim()) return content;
  if (content && typeof content === 'object') return JSON.stringify(content);
  throw new Error('语音润色没有返回有效内容。');
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('语音润色没有返回有效内容。');
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`语音润色返回了无效 JSON: ${trimmed.slice(0, 80)}`);
    return JSON.parse(match[0]);
  }
}

function joinProxyPath(baseUrl: string, endpointPath: string): string {
  const base = new URL(baseUrl);
  const endpoint = new URL(endpointPath, 'https://placeholder.invalid');
  const basePath = base.pathname.replace(/\/+$/, '');
  base.pathname = `${basePath}${endpoint.pathname}`;
  base.search = endpoint.search;
  return base.toString();
}

function hasReadableStreamBody(value: unknown): value is ReadableStream<Uint8Array> {
  return !!value && typeof (value as { getReader?: unknown }).getReader === 'function';
}

function resolveSyncedSourceLanguage(language: string | undefined): string | undefined {
  const value = language?.trim();
  if (!value || value.toLowerCase() === 'auto') return undefined;
  return value;
}

function formatMobileVoiceDictionary(
  entries: NonNullable<StoredMobileVoiceCredential['settings']>['dictionaryEntries'] | undefined,
): string {
  return (entries ?? [])
    .map((entry) => entry.text.trim())
    .filter(Boolean)
    .map((text) => `- ${text}`)
    .join('\n');
}

function formatMobileVoiceHistory(history: readonly string[]): string {
  const entries = normalizeMobileVoiceHistoryNewestFirst(history).reverse();
  if (entries.length === 0) return '';
  return [
    MOBILE_VOICE_INPUT_HISTORY_HEADER,
    ...entries.map((entry) => `- ${entry}`),
  ].join('\n');
}

function mergeMobileVoiceHistories(
  syncedDesktopHistory: readonly string[] | undefined,
  localMobileHistory: readonly string[] | undefined,
): string[] {
  return normalizeMobileVoiceHistoryNewestFirst([
    ...(localMobileHistory ?? []),
    ...(syncedDesktopHistory ?? []),
  ]);
}

function mobileRefinerCredentialChain(
  credential: StoredMobileVoiceCredential,
): Array<StoredMobileVoiceCredential['refiner']> {
  const chain = credential.refinerProviderChain?.length ? credential.refinerProviderChain : [credential.refiner];
  const seen = new Set<string>();
  const result: Array<StoredMobileVoiceCredential['refiner']> = [];
  for (const item of chain) {
    if (seen.has(item.provider)) continue;
    seen.add(item.provider);
    result.push(item);
  }
  return result;
}

function normalizeMobileVoiceHistoryNewestFirst(history: readonly string[]): string[] {
  const entries: string[] = [];
  for (const item of history) {
    const text = item
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_MOBILE_VOICE_HISTORY_ITEM_CHARS)
      .trim();
    if (!text || entries.includes(text)) continue;
    entries.push(text);
    if (entries.length >= MAX_MOBILE_VOICE_HISTORY_ENTRIES_FOR_REFINEMENT) break;
  }
  return entries;
}

function extensionFromName(name: string): string {
  const match = /\.([a-zA-Z0-9]{1,12})(?:[?#].*)?$/.exec(name);
  return match ? match[1].toLowerCase() : '';
}

function extensionForMimeType(mimeType: string): string | null {
  if (mimeType === 'audio/wav' || mimeType === 'audio/wave' || mimeType === 'audio/x-wav') return 'wav';
  if (mimeType === 'audio/mp4' || mimeType === 'audio/m4a' || mimeType === 'audio/x-m4a') return 'm4a';
  if (mimeType === 'audio/mpeg') return 'mp3';
  if (mimeType === 'audio/webm') return 'webm';
  if (mimeType === 'audio/ogg') return 'ogg';
  return null;
}

function mimeTypeForExtension(ext: string): string | null {
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'm4a' || ext === 'mp4') return 'audio/mp4';
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'webm') return 'audio/webm';
  if (ext === 'ogg') return 'audio/ogg';
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
