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

import type { Maker } from '@lizi/maker-core';
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

  it('returns null when every configured candidate is unavailable', async () => {
    const result = await requestUtilityText(makerMock(false), 'hello');

    expect(result).toBeNull();
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
      text: 'lite text',
      providerId: 'litellm-gpt-5.4-mini',
      model: 'gpt-5.4-mini',
      transport: 'litellm-chat-completions',
    });
  });
});
