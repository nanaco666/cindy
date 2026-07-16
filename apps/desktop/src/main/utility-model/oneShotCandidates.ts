import { fetch as undiciFetch } from 'undici';

import type { AgentKind, Maker } from '@lizi/maker-core';

import { createLogger } from '../logger.js';
import { readClaudeApiKey } from '../maker-host/auth-adapters.js';
import { CLAUDE_UPSTREAM_ENDPOINT } from '../maker-host/runtime-configs.js';
import { getUtilityModelChainProfiles } from './UtilityModelSelection.js';
import type { UtilityModelProfile, UtilityModelTransport } from '../../shared/utilityModelProfiles.js';

const log = createLogger('utility-model:one-shot');

export type UtilityTextCapability = {
  transports: readonly UtilityModelTransport[];
};

export type UtilityTextCandidate = {
  providerId: string;
  model: string;
  transport: UtilityModelTransport;
  profile: UtilityModelProfile;
  execute: (prompt: string, opts?: UtilityTextRequestOptions) => Promise<string>;
};

export type UtilityTextRequestOptions = {
  maxTokens?: number;
  timeoutMs?: number;
};

/**
 * Resolves text-capable utility models in configured priority order, skipping
 * entries that are unsupported by the caller or not currently credential-ready.
 * Callers still own fallback semantics: try one, try several, or ignore this.
 */
export async function getUtilityTextCandidates(
  maker: Maker,
  capability: UtilityTextCapability = { transports: ['codex-responses', 'litellm-chat-completions'] },
): Promise<UtilityTextCandidate[]> {
  const profiles = getUtilityModelChainProfiles();
  const candidates: UtilityTextCandidate[] = [];
  for (const profile of profiles) {
    if (!capability.transports.includes(profile.transport)) {
      log.debug('utility text candidate skipped: unsupported transport', {
        providerId: profile.id,
        transport: profile.transport,
      });
      continue;
    }

    if (profile.transport === 'codex-responses') {
      const codex = await resolveCodexCandidate(maker, profile);
      if (codex) candidates.push(codex);
      continue;
    }

    if (profile.transport === 'litellm-chat-completions') {
      const litellm = resolveLiteLlmCandidate(profile);
      if (litellm) candidates.push(litellm);
    }
  }
  return candidates;
}

export async function requestUtilityText(
  maker: Maker,
  prompt: string,
  opts?: UtilityTextRequestOptions & {
    capability?: UtilityTextCapability;
  },
): Promise<{ text: string; providerId: string; model: string; transport: UtilityModelTransport } | null> {
  const candidates = await getUtilityTextCandidates(maker, opts?.capability);
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const text = await candidate.execute(prompt, opts);
      return {
        text,
        providerId: candidate.providerId,
        model: candidate.model,
        transport: candidate.transport,
      };
    } catch (error) {
      lastError = error;
      log.warn('utility text candidate failed, trying next', {
        providerId: candidate.providerId,
        model: candidate.model,
        transport: candidate.transport,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (lastError) {
    log.warn('all utility text candidates failed', {
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
  }
  return null;
}

async function resolveCodexCandidate(
  maker: Maker,
  profile: UtilityModelProfile,
): Promise<UtilityTextCandidate | null> {
  const agentKind: AgentKind = 'codex';
  if (!maker.listAvailableAgents().includes(agentKind)) {
    log.debug('utility text candidate skipped: codex agent unavailable', { providerId: profile.id });
    return null;
  }
  try {
    const auth = await maker.getAgentAuthState(agentKind);
    if (!auth.authenticated) {
      log.debug('utility text candidate skipped: codex not authenticated', {
        providerId: profile.id,
        reason: auth.errorReason,
      });
      return null;
    }
  } catch (error) {
    log.debug('utility text candidate skipped: codex auth probe failed', {
      providerId: profile.id,
      error: String(error),
    });
    return null;
  }
  return {
    providerId: profile.id,
    model: profile.model,
    transport: profile.transport,
    profile,
    execute: (prompt, opts) => maker.oneShot(agentKind, prompt, {
      model: profile.model,
      maxTokens: opts?.maxTokens,
      timeoutMs: opts?.timeoutMs,
    }),
  };
}

function resolveLiteLlmCandidate(profile: UtilityModelProfile): UtilityTextCandidate | null {
  const apiKey = readClaudeApiKey();
  const baseUrl = CLAUDE_UPSTREAM_ENDPOINT.trim();
  if (!apiKey || !baseUrl) {
    log.debug('utility text candidate skipped: LiteLLM credentials missing', {
      providerId: profile.id,
      apiKeyPresent: Boolean(apiKey),
      baseUrlPresent: Boolean(baseUrl),
    });
    return null;
  }
  return {
    providerId: profile.id,
    model: profile.model,
    transport: profile.transport,
    profile,
    execute: (prompt, opts) => requestLiteLlmText({
      apiKey,
      baseUrl,
      model: profile.model,
      prompt,
      maxTokens: opts?.maxTokens,
      timeoutMs: opts?.timeoutMs,
    }),
  };
}

async function requestLiteLlmText(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<string> {
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? 20_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await undiciFetch(joinProxyPath(input.baseUrl, '/v1/chat/completions'), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: input.model,
        ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
        messages: [{ role: 'user', content: input.prompt }],
      }),
    });
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      throw new Error(textModelErrorMessage(tryParseJsonObject(raw), raw, response.status));
    }
    const parsed = await response.json() as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const text = parsed.choices
      ?.map((choice) => typeof choice.message?.content === 'string' ? choice.message.content : '')
      .join('')
      .trim() ?? '';
    if (!text) throw new Error('Empty response from LiteLLM utility model');
    return text;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`LiteLLM utility model timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function joinProxyPath(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${suffix}`;
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function textModelErrorMessage(parsed: Record<string, unknown> | null, raw: string, status: number): string {
  const error = parsed?.error;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) {
      return `LiteLLM utility model HTTP ${status}: ${message.trim()}`;
    }
  }
  const message = parsed?.message;
  if (typeof message === 'string' && message.trim()) {
    return `LiteLLM utility model HTTP ${status}: ${message.trim()}`;
  }
  const trimmed = raw.trim();
  return trimmed
    ? `LiteLLM utility model HTTP ${status}: ${trimmed.slice(0, 500)}`
    : `LiteLLM utility model HTTP ${status}`;
}
