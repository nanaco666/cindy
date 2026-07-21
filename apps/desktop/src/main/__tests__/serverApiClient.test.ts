/**
 * serverApiClient retry contract: auth refresh may switch memberships, so
 * dynamic request bodies must be rebuilt together with the refreshed token.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  netFetch: vi.fn(),
  getAccessToken: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('electron', () => ({ net: { fetch: mocks.netFetch } }));
vi.mock('../authManager', () => ({
  getAccessToken: mocks.getAccessToken,
  refresh: mocks.refresh,
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn() }),
}));

import { serverApiFetch } from '../serverApiClient';

describe('serverApiFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('TOKEN_EXPIRED refresh 后用新 token 和重新生成的 body 重试', async () => {
    mocks.getAccessToken.mockReturnValueOnce('token-a').mockReturnValueOnce('token-b');
    mocks.refresh.mockResolvedValue(true);
    mocks.netFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'TOKEN_EXPIRED' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });
    const bodyFactory = vi
      .fn<() => { userName: string }>()
      .mockReturnValueOnce({ userName: 'Account A' })
      .mockReturnValueOnce({ userName: 'Account B' });

    await expect(
      serverApiFetch('/api/github/issues', {
        method: 'POST',
        bodyFactory,
        baseUrl: 'https://github-api.example.com',
      }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(bodyFactory).toHaveBeenCalledTimes(2);
    expect(mocks.netFetch).toHaveBeenNthCalledWith(
      1,
      'https://github-api.example.com/api/github/issues',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-a' }),
        body: JSON.stringify({ userName: 'Account A' }),
      }),
    );
    expect(mocks.netFetch).toHaveBeenNthCalledWith(
      2,
      'https://github-api.example.com/api/github/issues',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-b' }),
        body: JSON.stringify({ userName: 'Account B' }),
      }),
    );
  });
});
