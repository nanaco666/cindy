import type { AccountRateLimitsResponse } from '@lizi/maker-core';
import { describe, expect, it, vi } from 'vitest';

import { createCodexRateLimitResetService } from '../codexRateLimitReset.js';

const NOW_MS = Date.UTC(2026, 6, 22, 12, 0, 0);
const KEY = '018f4ec7-c6d8-7f10-8d43-9f8791d33000';

function response(over: Partial<AccountRateLimitsResponse> = {}): AccountRateLimitsResponse {
  return {
    rateLimits: {
      planType: 'plus',
      primary: { usedPercent: 100, windowMinutes: 300 },
    },
    rateLimitsByLimitId: null,
    rateLimitResetCredits: {
      availableCount: 2,
      credits: [
        {
          id: 'later',
          status: 'available',
          resetType: 'codexRateLimits',
          grantedAt: 20,
          expiresAt: 300,
          title: 'Later',
          description: null,
        },
        {
          id: 'earlier',
          status: 'available',
          resetType: 'codexRateLimits',
          grantedAt: 10,
          expiresAt: 200,
          title: 'Earlier',
          description: null,
        },
      ],
    },
    ...over,
  };
}

function harness(over: Partial<Parameters<typeof createCodexRateLimitResetService>[0]> = {}) {
  const deps = {
    readRateLimits: vi.fn().mockResolvedValue(response()),
    consumeResetCredit: vi.fn().mockResolvedValue({ outcome: 'reset' as const }),
    readAccountIdentity: vi.fn().mockResolvedValue({
      email: 'person@example.com',
      accountId: 'workspace-123456789',
    }),
    recordRateLimitSnapshot: vi.fn().mockResolvedValue(undefined),
    now: () => NOW_MS,
    createIdempotencyKey: () => KEY,
    ...over,
  };
  return { deps, service: createCodexRateLimitResetService(deps) };
}

describe('Codex rate-limit reset control plane', () => {
  it('selects the earliest eligible credit without exposing its id to mobile', async () => {
    const { deps, service } = harness();
    const snapshot = await service.read();

    expect(snapshot.account).toEqual({
      email: 'pe***@example.com',
      accountId: '…456789',
      planType: 'plus',
    });
    expect(snapshot.resetOffer).toEqual({
      idempotencyKey: KEY,
      expiresAt: 200,
      validUntil: NOW_MS + 10 * 60 * 1000,
    });
    expect(snapshot.rateLimitResetCredits?.credits?.[0]).not.toHaveProperty('id');

    await service.consume(KEY);
    expect(deps.consumeResetCredit).toHaveBeenCalledWith({
      idempotencyKey: KEY,
      creditId: 'earlier',
    });
  });

  it('reuses one offer across reads and omits creditId when detail is unavailable', async () => {
    const createIdempotencyKey = vi.fn(() => KEY);
    const { deps, service } = harness({
      createIdempotencyKey,
      readRateLimits: vi.fn().mockResolvedValue(response({
        rateLimitResetCredits: { availableCount: 1, credits: null },
      })),
    });

    const first = await service.read();
    const second = await service.read();
    expect(second.resetOffer).toEqual(first.resetOffer);
    expect(createIdempotencyKey).toHaveBeenCalledOnce();

    await service.consume(KEY);
    expect(deps.consumeResetCredit).toHaveBeenCalledWith({ idempotencyKey: KEY });
  });

  it('coalesces concurrent consumes and caches the terminal result for retries', async () => {
    let resolveConsume!: (value: { outcome: 'reset' }) => void;
    const consumeResetCredit = vi.fn(() => new Promise<{ outcome: 'reset' }>((resolve) => {
      resolveConsume = resolve;
    }));
    const { service } = harness({ consumeResetCredit });
    await service.read();

    const first = service.consume(KEY);
    const second = service.consume(KEY);
    await vi.waitFor(() => expect(consumeResetCredit).toHaveBeenCalledOnce());
    resolveConsume({ outcome: 'reset' });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(consumeResetCredit).toHaveBeenCalledOnce();
    await expect(service.consume(KEY)).resolves.toEqual(firstResult);
    expect(consumeResetCredit).toHaveBeenCalledOnce();
  });

  it('fails closed when either account or workspace identity changes', async () => {
    const readAccountIdentity = vi.fn()
      .mockResolvedValueOnce({ email: 'person@example.com', accountId: 'workspace-a' })
      .mockResolvedValueOnce({ email: 'person@example.com', accountId: 'workspace-b' });
    const { deps, service } = harness({ readAccountIdentity });
    await service.read();

    await expect(service.consume(KEY)).rejects.toThrow('Codex account changed');
    expect(deps.consumeResetCredit).not.toHaveBeenCalled();
  });

  it('returns the authoritative outcome when the post-consume refresh fails', async () => {
    const readRateLimits = vi.fn()
      .mockResolvedValueOnce(response())
      .mockRejectedValueOnce(new Error('refresh offline'));
    const { deps, service } = harness({ readRateLimits });
    await service.read();

    await expect(service.consume(KEY)).resolves.toEqual({ outcome: 'reset', rateLimits: null });
    await expect(service.consume(KEY)).resolves.toEqual({ outcome: 'reset', rateLimits: null });
    expect(deps.consumeResetCredit).toHaveBeenCalledOnce();
  });

  it('reuses the same backend idempotency key after an ambiguous consume failure', async () => {
    const consumeResetCredit = vi.fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ outcome: 'alreadyRedeemed' as const });
    const { service } = harness({ consumeResetCredit });
    await service.read();

    await expect(service.consume(KEY)).rejects.toThrow('response lost');
    await expect(service.consume(KEY)).resolves.toMatchObject({ outcome: 'alreadyRedeemed' });
    expect(consumeResetCredit).toHaveBeenCalledTimes(2);
    expect(consumeResetCredit.mock.calls[0][0].idempotencyKey).toBe(KEY);
    expect(consumeResetCredit.mock.calls[1][0].idempotencyKey).toBe(KEY);
  });

  it('does not issue a consumable offer unless both email and workspace are known', async () => {
    const missingEmail = harness({
      readAccountIdentity: vi.fn().mockResolvedValue({ email: null, accountId: 'workspace-a' }),
    });
    const missingWorkspace = harness({
      readAccountIdentity: vi.fn().mockResolvedValue({ email: 'person@example.com', accountId: null }),
    });

    await expect(missingEmail.service.read()).resolves.toMatchObject({ resetOffer: null });
    await expect(missingWorkspace.service.read()).resolves.toMatchObject({ resetOffer: null });
  });
});
