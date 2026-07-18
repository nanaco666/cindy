/**
 * voiceCredentialSync.ts — 手机云端语音输入的临时 credential 同步。
 *
 * TEMPORARY MOBILE VOICE KEY SYNC:
 * 用户当前需要手机长期保存被控电脑的 XD Gateway key,用于移动端本地录音后直接调用
 * 云端 ASR/refine。长期方案应改为 AI key 与用户账号绑定,移动端登录后读取自己的账号 key,
 * 到时应删除这个 device-link credential 穿透口。
 */
import type {
  MobileVoiceCredentialSyncAsr,
  MobileVoiceCredentialSyncSettings,
  MobileVoiceCredentialSyncRefiner,
  MobileVoiceCredentialSyncResult,
} from '@lizi/maker-shared/device-link-contract';

import { claudeUpstreamEndpoint } from '../maker-host/runtime-configs.js';
import { readClaudeApiKey } from '../maker-host/auth-adapters.js';
import {
  LITELLM_REALTIME_TRANSCRIPTION_PATH,
  getVoiceInputAsrProfile,
  type VoiceInputAsrProfile,
} from '../voice-input/voiceInputAsrConfig.js';
import { voiceInputDataStore } from '../voice-input/VoiceInputDataStore.js';
import { getVoiceInputModelSelection } from '../voice-input/VoiceInputModelSelection.js';
import {
  getVoiceInputRefinerProfile,
  type VoiceInputRefinerProfile,
} from '../../shared/voiceInputRefinerProfiles.js';

const LITELLM_AUDIO_TRANSCRIPTIONS_PATH = '/v1/audio/transcriptions';
const LITELLM_CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
const REDACTED = '[REDACTED]';

export function syncMobileVoiceCredential(): MobileVoiceCredentialSyncResult {
  const proxyApiKey = readClaudeApiKey()?.trim() ?? '';
  if (!proxyApiKey) {
    throw new Error('Cindy AI key is not configured on this desktop.');
  }
  const proxyBaseUrl = claudeUpstreamEndpoint().trim();
  if (!proxyBaseUrl) {
    throw new Error('Cindy AI base URL is not configured.');
  }

  const selection = getVoiceInputModelSelection();
  const asr = toMobileAsrConfig(getVoiceInputAsrProfile(selection.asrProvider));
  const refiner = toMobileRefinerConfig(toSelectedRefinerProfile(selection.refinerProvider, selection.refinerModel));
  return {
    temporary: true,
    credentialVersion: 1,
    issuedAt: new Date().toISOString(),
    proxyBaseUrl,
    proxyApiKey,
    asr,
    asrProviderChain: uniqueMobileAsrChain([
      asr,
      ...selection.asrProviderChain.map((provider) => toMobileAsrConfig(getVoiceInputAsrProfile(provider))),
    ]),
    refiner,
    refinerProviderChain: uniqueMobileRefinerChain([
      refiner,
      ...selection.refinerProviderChain.map((provider) =>
        toMobileRefinerConfig(toSelectedRefinerProfile(provider, provider === selection.refinerProvider ? selection.refinerModel : undefined)),
      ),
    ]),
    settings: toMobileVoiceSettings(),
  };
}

export function redactMobileVoiceCredentialForLog(
  value: MobileVoiceCredentialSyncResult,
): MobileVoiceCredentialSyncResult {
  return { ...value, proxyApiKey: REDACTED };
}

function toSelectedRefinerProfile(provider: Parameters<typeof getVoiceInputRefinerProfile>[0], selectedModel?: string): VoiceInputRefinerProfile {
  const profile = getVoiceInputRefinerProfile(provider);
  return selectedModel ? { ...profile, model: selectedModel } : profile;
}

function toMobileAsrConfig(profile: VoiceInputAsrProfile): MobileVoiceCredentialSyncAsr {
  const unsupportedReason = mobileRealtimeAsrUnsupportedReason(profile);
  if (unsupportedReason) {
    throw new Error(unsupportedReason);
  }
  // TEMPORARY MOBILE VOICE KEY SYNC:
  // Mobile uses the synced XD Gateway key, not the controlled desktop's Codex
  // OAuth connection. Preserve the desktop-selected ASR model id, but map
  // Codex-only OpenAI realtime profiles to the XD Gateway passthrough transport.
  const mobileOpenAiProxy = profile.auth === 'codex'
    && profile.mode === 'realtime-websocket'
    && profile.realtime?.protocolProfile === 'openai-transcription-manual';
  const endpointPath = profile.mode === 'batch-http'
    ? LITELLM_AUDIO_TRANSCRIPTIONS_PATH
    : profile.realtime?.endpointPath
      ?? (mobileOpenAiProxy ? LITELLM_REALTIME_TRANSCRIPTION_PATH : undefined)
      ?? profile.nativeWebSocket?.endpointPath;
  const config: MobileVoiceCredentialSyncAsr = {
    provider: profile.id,
    model: profile.model,
    auth: mobileOpenAiProxy ? 'api-key' : profile.auth,
    mode: profile.mode,
  };
  if (endpointPath) config.endpointPath = endpointPath;
  const pcmSampleRate = profile.realtime?.pcmSampleRate ?? profile.nativeWebSocket?.pcmSampleRate;
  if (pcmSampleRate) config.pcmSampleRate = pcmSampleRate;
  const protocolProfile = profile.realtime?.protocolProfile ?? profile.nativeWebSocket?.protocolProfile;
  if (protocolProfile) config.protocolProfile = protocolProfile;
  if (profile.nativeWebSocket?.resourceId) config.resourceId = profile.nativeWebSocket.resourceId;
  if (profile.realtime?.litellmHeaderModel) config.litellmHeaderModel = profile.realtime.litellmHeaderModel;
  else if (mobileOpenAiProxy) config.litellmHeaderModel = profile.model;
  return config;
}

function mobileRealtimeAsrUnsupportedReason(profile: VoiceInputAsrProfile): string | null {
  if (profile.mode === 'batch-http') {
    return [
      `Mobile realtime voice input cannot use desktop ASR provider ${profile.id}:`,
      'the profile is batch-http and cannot stream partial ASR text while recording.',
      'Select a realtime ASR provider on desktop, then sync mobile voice credentials again.',
    ].join(' ');
  }
  if (profile.mode === 'elevenlabs-realtime') {
    return [
      `Mobile realtime voice input cannot use desktop ASR provider ${profile.id}:`,
      'the temporary mobile credential sync only tunnels the Cindy AI key,',
      'but this desktop profile requires a direct ElevenLabs API key.',
    ].join(' ');
  }
  if (profile.mode === 'realtime-websocket') {
    const protocol = profile.realtime?.protocolProfile;
    if (protocol === 'openai-transcription-manual' || protocol === 'qwen-asr-server-vad') return null;
    return `Mobile realtime voice input does not support realtime ASR protocol ${protocol ?? 'unknown'} for ${profile.id}.`;
  }
  if (profile.mode === 'provider-native-websocket') {
    const protocol = profile.nativeWebSocket?.protocolProfile;
    if (protocol === 'volcengine-sauc-duration') return null;
    return `Mobile realtime voice input does not support native ASR protocol ${protocol ?? 'unknown'} for ${profile.id}.`;
  }
  return `Mobile realtime voice input does not support desktop ASR mode ${profile.mode} for ${profile.id}.`;
}

function toMobileRefinerConfig(profile: VoiceInputRefinerProfile): MobileVoiceCredentialSyncRefiner {
  // TEMPORARY MOBILE VOICE KEY SYNC:
  // Codex refiner profiles are kept as desktop-selected provider/model labels,
  // but the phone executes them through the synced XD Gateway key.
  const mobileProxyTransport = profile.transport === 'codex-responses';
  const config: MobileVoiceCredentialSyncRefiner = {
    provider: profile.id,
    model: profile.model,
    auth: mobileProxyTransport ? 'api-key' : profile.auth,
    transport: mobileProxyTransport ? 'litellm-chat-completions' : profile.transport,
  };
  if (config.transport === 'litellm-chat-completions') {
    config.endpointPath = LITELLM_CHAT_COMPLETIONS_PATH;
  }
  return config;
}

function toMobileVoiceSettings(): MobileVoiceCredentialSyncSettings {
  const snapshot = voiceInputDataStore.getSnapshot();
  return {
    language: snapshot.settings.language,
    refinementEnabled: snapshot.settings.refinementEnabled,
    playInteractionSound: snapshot.settings.playInteractionSound,
    refinementInstructions: snapshot.settings.refinementInstructions.trim() || undefined,
    dictionaryEntries: snapshot.settings.dictionaryEntries.map((entry) => ({
      text: entry.text,
      frequency: entry.frequency,
      aliases: entry.aliases.map((alias) => ({
        text: alias.text,
        count: alias.count,
      })),
    })),
    voiceInputHistory: voiceInputDataStore.getHistoryForRefinement().map((entry) => entry.text),
  };
}

function uniqueMobileAsrChain(chain: MobileVoiceCredentialSyncAsr[]): MobileVoiceCredentialSyncAsr[] {
  const seen = new Set<string>();
  const result: MobileVoiceCredentialSyncAsr[] = [];
  for (const item of chain) {
    if (seen.has(item.provider)) continue;
    seen.add(item.provider);
    result.push(item);
  }
  return result;
}

function uniqueMobileRefinerChain(chain: MobileVoiceCredentialSyncRefiner[]): MobileVoiceCredentialSyncRefiner[] {
  const seen = new Set<string>();
  const result: MobileVoiceCredentialSyncRefiner[] = [];
  for (const item of chain) {
    if (seen.has(item.provider)) continue;
    seen.add(item.provider);
    result.push(item);
  }
  return result;
}

export const __testing = {
  mobileRealtimeAsrUnsupportedReason,
  toMobileAsrConfig,
  toMobileRefinerConfig,
  toMobileVoiceSettings,
};
