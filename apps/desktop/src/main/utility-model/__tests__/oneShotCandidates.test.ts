import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/xdt-maker-test'),
    getAppPath: vi.fn(() => '/tmp/xdt-maker-test/app'),
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
  },
}));

vi.mock('../UtilityModelSelection.js', () => ({
  getUtilityModelChainProfiles: vi.fn(),
}));

vi.mock('../../maker-host/auth-adapters.js', () => ({
  readClaudeApiKey: vi.fn(),
}));

vi.mock('undici', () => ({
  fetch: vi.fn(),
}));

// SUT 链(maker-host/runtime-configs → effectiveXdGatewayBaseUrl)运行期读
// model-access 下发的 endpoint;mock 成 fixture 值。
vi.mock('../../model-access/effectiveEndpoint.js', async () => {
  const { TEST_XD_GATEWAY_BASE_URL } = await import('../../../test/vitest/clientEndpointsFixture');
  return { effectiveXdGatewayBaseUrl: () => TEST_XD_GATEWAY_BASE_URL };
});

import type { Maker } from '@cindy/maker-core';
import { fetch as undiciFetch } from 'undici';

import { readClaudeApiKey } from '../../maker-host/auth-adapters.js';
import { getUtilityModelChainProfiles } from '../UtilityModelSelection.js';
import { getUtilityTextCandidates, requestUtilityText } from '../oneShotCandidates.js';

const getProfiles = vi.mocked(getUtilityModelChainProfiles);
const readKey = vi.mocked(readClaudeApiKey);
const fetchMock = vi.mocked(undiciFetch);

function makerMock(authenticated: boolean): Maker {
  return {
    listAvailableAgents: () => ['codex'],
    getAgentAuthState: vi.fn(async () => authenticated ? { authenticated: true } : { authenticated: false, errorReason: 'no_key' }),
    oneShot: vi.fn(async () => 'codex text'),
  } as unknown as Maker;
}

describe('utility one-shot candidates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readKey.mockReturnValue(null);
    getProfiles.mockReturnValue([
      {
        id: 'codex-gpt-5.4-mini',
        model: 'gpt-5.4-mini',
        transport: 'codex-responses',
        auth: 'codex',
        settingsTab: 'connections',
        missingCredentialMessage: 'codex missing',
      },
      {
        id: 'litellm-gpt-5.4-mini',
        model: 'gpt-5.4-mini',
        transport: 'litellm-chat-completions',
        auth: 'api-key',
        settingsTab: 'api-keys',
        missingCredentialMessage: 'api key missing',
      },
    ]);
  });

  it('skips unauthenticated codex and keeps configured LiteLLM when API key exists', async () => {
    readKey.mockReturnValue('proxy-key');

    const candidates = await getUtilityTextCandidates(makerMock(false));

    expect(candidates.map((candidate) => candidate.providerId)).toEqual(['litellm-gpt-5.4-mini']);
  });

  it('returns credential-safe diagnostics when every configured candidate is unavailable', async () => {
    const result = await requestUtilityText(makerMock(false), 'hello');

    expect(result).toEqual({
      ok: false,
      reason: 'no_candidate',
      attempts: [
        expect.objectContaining({ providerId: 'codex-gpt-5.4-mini', reason: 'not_authenticated' }),
        expect.objectContaining({ providerId: 'litellm-gpt-5.4-mini', reason: 'api_key_missing' }),
      ],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls through failed codex execution and succeeds on LiteLLM', async () => {
    readKey.mockReturnValue('proxy-key');
    const maker = makerMock(true);
    vi.mocked(maker.oneShot).mockRejectedValueOnce(new Error('codex down'));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'lite text' } }] }),
    } as never);

    const result = await requestUtilityText(maker, 'hello', { maxTokens: 10 });

    expect(result).toMatchObject({
      ok: true,
      text: 'lite text',
      providerId: 'litellm-gpt-5.4-mini',
      model: 'gpt-5.4-mini',
      transport: 'litellm-chat-completions',
    });
  });

  it('preserves failed candidate and HTTP status diagnostics without response bodies', async () => {
    readKey.mockReturnValue('proxy-key');
    const maker = makerMock(true);
    vi.mocked(maker.oneShot).mockRejectedValueOnce(new Error('upstream included sensitive details'));
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      body: { cancel: vi.fn(async () => undefined) },
    } as never);

    const result = await requestUtilityText(maker, 'hello');

    expect(result).toMatchObject({
      ok: false,
      reason: 'all_candidates_failed',
      attempts: [
        expect.objectContaining({ providerId: 'codex-gpt-5.4-mini', reason: 'request_failed' }),
        expect.objectContaining({ providerId: 'litellm-gpt-5.4-mini', reason: 'http_error', httpStatus: 403 }),
      ],
    });
    expect(JSON.stringify(result)).not.toContain('sensitive details');
  });

  it('distinguishes an empty response from generic request failures', async () => {
    getProfiles.mockReturnValue([{
      id: 'codex-gpt-5.4-mini',
      model: 'gpt-5.4-mini',
      transport: 'codex-responses',
      auth: 'codex',
      settingsTab: 'providers',
      missingCredentialMessage: 'codex missing',
    }]);
    const maker = makerMock(true);
    vi.mocked(maker.oneShot).mockResolvedValueOnce('   ');

    const result = await requestUtilityText(maker, 'hello');

    expect(result).toMatchObject({
      ok: false,
      reason: 'empty_response',
      attempts: [expect.objectContaining({ reason: 'empty_response' })],
    });
  });

  it('distinguishes a timeout when every executable candidate times out', async () => {
    const maker = makerMock(true);
    vi.mocked(maker.oneShot).mockRejectedValueOnce(new Error('request timed out'));

    const result = await requestUtilityText(maker, 'hello');

    expect(result).toMatchObject({
      ok: false,
      reason: 'timeout',
      attempts: [
        expect.objectContaining({ providerId: 'litellm-gpt-5.4-mini', status: 'skipped' }),
        expect.objectContaining({ providerId: 'codex-gpt-5.4-mini', reason: 'timeout' }),
      ],
    });
  });
});
