import { fetch as undiciFetch } from 'undici';

import type { AgentKind, Maker } from '@cindy/maker-core';

import { createLogger } from '../logger.js';
import { readClaudeApiKey } from '../maker-host/auth-adapters.js';
import { claudeUpstreamEndpoint } from '../maker-host/runtime-configs.js';
import { getUtilityModelChainProfiles } from './UtilityModelSelection.js';
import type { UtilityModelProfile, UtilityModelTransport } from '../../shared/utilityModelProfiles.js';
import type {
  UtilityTextAttempt,
  UtilityTextAttemptReason,
  UtilityTextFailureReason,
  UtilityTextResult,
} from '../../shared/utilityTextResult.js';

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

/** Internal resolution result keeps skipped candidates visible to diagnostics. */
type UtilityTextCandidateResolution =
  | { candidate: UtilityTextCandidate }
  | { attempt: UtilityTextAttempt };

/** Credential-safe failure raised by a concrete utility transport. */
type UtilityTextExecutionFailure =
  | { reason: 'http_error'; httpStatus: number }
  | {
    reason: Extract<UtilityTextAttemptReason, 'timeout' | 'empty_response' | 'request_failed'>;
    httpStatus?: never;
  };

/** Credential-safe error raised by a concrete utility transport. */
class UtilityTextExecutionError extends Error {
  constructor(readonly failure: UtilityTextExecutionFailure) {
    super(failure.reason);
    this.name = 'UtilityTextExecutionError';
  }
}

/**
 * Resolves text-capable utility models in configured priority order, skipping
 * entries that are unsupported by the caller or not currently credential-ready.
 * Callers still own fallback semantics: try one, try several, or ignore this.
 */
export async function getUtilityTextCandidates(
  maker: Maker,
  capability: UtilityTextCapability = { transports: ['codex-responses', 'litellm-chat-completions'] },
): Promise<UtilityTextCandidate[]> {
  return (await resolveUtilityTextCandidates(maker, capability)).candidates;
}

/** Resolve candidates and retain safe reasons for every skipped profile. */
async function resolveUtilityTextCandidates(
  maker: Maker,
  capability: UtilityTextCapability,
): Promise<{ candidates: UtilityTextCandidate[]; attempts: UtilityTextAttempt[] }> {
  const profiles = getUtilityModelChainProfiles();
  const candidates: UtilityTextCandidate[] = [];
  const attempts: UtilityTextAttempt[] = [];
  for (const profile of profiles) {
    if (!capability.transports.includes(profile.transport)) {
      log.debug('utility text candidate skipped: unsupported transport', {
        providerId: profile.id,
        transport: profile.transport,
      });
      attempts.push(skippedAttempt(profile, 'unsupported_transport'));
      continue;
    }

    if (profile.transport === 'codex-responses') {
      const codex = await resolveCodexCandidate(maker, profile);
      if ('candidate' in codex) candidates.push(codex.candidate);
      else attempts.push(codex.attempt);
      continue;
    }

    if (profile.transport === 'litellm-chat-completions') {
      const litellm = resolveLiteLlmCandidate(profile);
      if ('candidate' in litellm) candidates.push(litellm.candidate);
      else attempts.push(litellm.attempt);
    }
  }
  return { candidates, attempts };
}

export async function requestUtilityText(
  maker: Maker,
  prompt: string,
  opts?: UtilityTextRequestOptions & {
    capability?: UtilityTextCapability;
  },
): Promise<UtilityTextResult> {
  const { candidates, attempts } = await resolveUtilityTextCandidates(
    maker,
    opts?.capability ?? { transports: ['codex-responses', 'litellm-chat-completions'] },
  );
  if (candidates.length === 0) {
    return { ok: false, reason: 'no_candidate', attempts };
  }

  for (const candidate of candidates) {
    try {
      const text = (await candidate.execute(prompt, opts)).trim();
      if (!text) throw new UtilityTextExecutionError({ reason: 'empty_response' });
      return {
        ok: true,
        text,
        providerId: candidate.providerId,
        model: candidate.model,
        transport: candidate.transport,
      };
    } catch (error) {
      const failure = classifyExecutionFailure(error);
      attempts.push(failedAttempt(candidate, failure));
      log.warn('utility text candidate failed, trying next', {
        providerId: candidate.providerId,
        model: candidate.model,
        transport: candidate.transport,
        reason: failure.reason,
        httpStatus: failure.httpStatus,
      });
    }
  }
  const reason = aggregateFailureReason(attempts.filter((attempt) => attempt.status === 'failed'));
  log.warn('all utility text candidates failed', { reason, attempts: attempts.length });
  return { ok: false, reason, attempts };
}

async function resolveCodexCandidate(
  maker: Maker,
  profile: UtilityModelProfile,
): Promise<UtilityTextCandidateResolution> {
  const agentKind: AgentKind = 'codex';
  if (!maker.listAvailableAgents().includes(agentKind)) {
    log.debug('utility text candidate skipped: codex agent unavailable', { providerId: profile.id });
    return { attempt: skippedAttempt(profile, 'agent_unavailable') };
  }
  try {
    const auth = await maker.getAgentAuthState(agentKind);
    if (!auth.authenticated) {
      log.debug('utility text candidate skipped: codex not authenticated', {
        providerId: profile.id,
        reason: auth.errorReason,
      });
      return { attempt: skippedAttempt(profile, 'not_authenticated') };
    }
  } catch (error) {
    log.debug('utility text candidate skipped: codex auth probe failed', {
      providerId: profile.id,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return { attempt: skippedAttempt(profile, 'auth_probe_failed') };
  }
  return {
    candidate: {
      providerId: profile.id,
      model: profile.model,
      transport: profile.transport,
      profile,
      execute: (prompt, opts) => maker.oneShot(agentKind, prompt, {
        model: profile.model,
        maxTokens: opts?.maxTokens,
        timeoutMs: opts?.timeoutMs,
      }),
    },
  };
}

function resolveLiteLlmCandidate(profile: UtilityModelProfile): UtilityTextCandidateResolution {
  const apiKey = readClaudeApiKey();
  const baseUrl = claudeUpstreamEndpoint().trim();
  if (!apiKey || !baseUrl) {
    log.debug('utility text candidate skipped: LiteLLM credentials missing', {
      providerId: profile.id,
      apiKeyPresent: Boolean(apiKey),
      baseUrlPresent: Boolean(baseUrl),
    });
    return { attempt: skippedAttempt(profile, !apiKey ? 'api_key_missing' : 'endpoint_missing') };
  }
  return {
    candidate: {
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
    },
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
      // Do not retain or log upstream response bodies: gateways may echo request
      // metadata, while the HTTP status is sufficient for user recovery.
      await response.body?.cancel().catch(() => undefined);
      throw new UtilityTextExecutionError({ reason: 'http_error', httpStatus: response.status });
    }
    const parsed = await response.json() as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const text = parsed.choices
      ?.map((choice) => typeof choice.message?.content === 'string' ? choice.message.content : '')
      .join('')
      .trim() ?? '';
    if (!text) throw new UtilityTextExecutionError({ reason: 'empty_response' });
    return text;
  } catch (error) {
    if (error instanceof UtilityTextExecutionError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new UtilityTextExecutionError({ reason: 'timeout' });
    }
    throw new UtilityTextExecutionError({ reason: 'request_failed' });
  } finally {
    clearTimeout(timeout);
  }
}

/** Build a safe diagnostic entry for a profile skipped before execution. */
function skippedAttempt(
  profile: UtilityModelProfile,
  reason: Extract<UtilityTextAttemptReason,
    | 'unsupported_transport'
    | 'agent_unavailable'
    | 'not_authenticated'
    | 'auth_probe_failed'
    | 'api_key_missing'
    | 'endpoint_missing'>,
): UtilityTextAttempt {
  return {
    providerId: profile.id,
    model: profile.model,
    transport: profile.transport,
    status: 'skipped',
    reason,
  };
}

/** Classify candidate failures without exposing arbitrary exception messages. */
function classifyExecutionFailure(error: unknown): UtilityTextExecutionFailure {
  if (error instanceof UtilityTextExecutionError) {
    return error.failure;
  }
  if (error instanceof Error && (error.name === 'AbortError' || /timed?\s*out|timeout/i.test(error.message))) {
    return { reason: 'timeout' };
  }
  return { reason: 'request_failed' };
}

/** Attach HTTP status only to the matching discriminated-union branch. */
function failedAttempt(
  candidate: UtilityTextCandidate,
  failure: UtilityTextExecutionFailure,
): UtilityTextAttempt {
  const base = {
    providerId: candidate.providerId,
    model: candidate.model,
    transport: candidate.transport,
    status: 'failed' as const,
  };
  return failure.reason === 'http_error'
    ? { ...base, reason: failure.reason, httpStatus: failure.httpStatus }
    : { ...base, reason: failure.reason };
}

/** Collapse homogeneous terminal failures while preserving per-candidate attempts. */
function aggregateFailureReason(failedAttempts: UtilityTextAttempt[]): UtilityTextFailureReason {
  if (failedAttempts.length > 0 && failedAttempts.every((attempt) => attempt.reason === 'empty_response')) {
    return 'empty_response';
  }
  if (failedAttempts.length > 0 && failedAttempts.every((attempt) => attempt.reason === 'timeout')) {
    return 'timeout';
  }
  return 'all_candidates_failed';
}

function joinProxyPath(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${suffix}`;
}
