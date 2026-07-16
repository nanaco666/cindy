import type { Maker } from '@lizi/maker-core';
import { describe, expect, it, vi } from 'vitest';
import { registerMakerAuthHandlers } from '../authHandlers';
import { MAKER_INVOKE, MAKER_PUSH } from '../channels';
import { registerMakerStatusHandlers } from '../statusHandlers';
import { registerMakerUsageHandlers } from '../usageHandlers';
import { IpcHarness } from './helpers/ipcHarness';

function createMakerStub(methods: Partial<Maker>): Maker {
  return methods as Maker;
}

describe('maker auth IPC handlers', () => {
  it('delegates auth state lookup to Maker', async () => {
    const harness = new IpcHarness();
    const getAgentAuthState = vi.fn().mockResolvedValue({ authenticated: true });

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ getAgentAuthState }),
      vi.fn(),
      () => null,
    );

    await expect(harness.invoke(MAKER_INVOKE.AUTH_GET_STATE, 'codex')).resolves.toEqual({
      authenticated: true,
    });
    expect(getAgentAuthState).toHaveBeenCalledWith('codex');
  });

  it('normalizes login progress and broadcasts final auth state', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    const onCodexAuthChange = vi.fn().mockResolvedValue(undefined);
    const triggerAgentLogin = vi
      .fn()
      .mockImplementation(async (_agentKind, options: { onProgress: (msg: string) => void }) => {
        options.onProgress('stdout:https://example.test/oauth');
        options.onProgress('stderr:waiting');
        options.onProgress('done');
        return {
          authenticated: true,
          authSource: 'oauth',
          identity: { email: 'dev@example.test' },
        };
      });

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin }),
      broadcast,
      () => null,
      onCodexAuthChange,
    );

    await expect(harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex')).resolves.toEqual({
      authenticated: true,
      authSource: 'oauth',
      identity: { email: 'dev@example.test' },
    });
    expect(onCodexAuthChange).toHaveBeenCalledOnce();
    expect(onCodexAuthChange).toHaveBeenCalledWith(true);
    expect(broadcast).toHaveBeenNthCalledWith(1, MAKER_PUSH.AUTH_LOGIN_PROGRESS, {
      agentKind: 'codex',
      phase: 'login-pending',
      detail: 'https://example.test/oauth',
    });
    expect(broadcast).toHaveBeenNthCalledWith(2, MAKER_PUSH.AUTH_LOGIN_PROGRESS, {
      agentKind: 'codex',
      phase: 'login-pending',
      detail: 'waiting',
    });
    expect(broadcast).toHaveBeenNthCalledWith(3, MAKER_PUSH.AUTH_LOGIN_PROGRESS, {
      agentKind: 'codex',
      phase: 'done',
    });
    expect(broadcast).toHaveBeenNthCalledWith(4, MAKER_PUSH.AUTH_STATE_CHANGED, {
      agentKind: 'codex',
      authenticated: true,
      authSource: 'oauth',
      identity: { email: 'dev@example.test' },
    });
  });

  it('does not refresh Codex models when login fails', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    const onCodexAuthChange = vi.fn();
    const triggerAgentLogin = vi.fn().mockResolvedValue({
      authenticated: false,
      errorReason: 'login_cancelled',
    });

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin }),
      broadcast,
      () => null,
      onCodexAuthChange,
    );

    await expect(harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex')).resolves.toEqual({
      authenticated: false,
      errorReason: 'login_cancelled',
    });
    expect(onCodexAuthChange).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.AUTH_STATE_CHANGED, {
      agentKind: 'codex',
      authenticated: false,
      errorReason: 'login_cancelled',
    });
  });

  it('does not refresh Codex models for an authenticated gateway fallback', async () => {
    const harness = new IpcHarness();
    const onCodexAuthChange = vi.fn();
    const triggerAgentLogin = vi.fn().mockResolvedValue({
      authenticated: true,
      authSource: 'api-key',
      identity: 'API Key · AI Gateway',
    });

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin }),
      vi.fn(),
      () => 'sk-gateway',
      onCodexAuthChange,
    );

    await harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex');
    expect(onCodexAuthChange).not.toHaveBeenCalled();
  });

  it('broadcasts logged-out state after logout', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    const logoutAgent = vi.fn().mockResolvedValue(undefined);

    registerMakerAuthHandlers(harness, createMakerStub({ logoutAgent }), broadcast, () => null);

    await expect(harness.invoke(MAKER_INVOKE.AUTH_LOGOUT, 'claude-code')).resolves.toBeUndefined();
    expect(logoutAgent).toHaveBeenCalledWith('claude-code');
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.AUTH_STATE_CHANGED, {
      agentKind: 'claude-code',
      authenticated: false,
    });
  });

  it('finalizes Codex auth changes before broadcasting logged-out state', async () => {
    const harness = new IpcHarness();
    const calls: string[] = [];
    const logoutAgent = vi.fn().mockImplementation(async () => {
      calls.push('logout');
    });
    const onCodexAuthChange = vi.fn().mockImplementation(async () => {
      calls.push('finalize');
    });
    const broadcast = vi.fn().mockImplementation(() => {
      calls.push('broadcast');
    });

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ logoutAgent }),
      broadcast,
      () => null,
      onCodexAuthChange,
    );

    await expect(harness.invoke(MAKER_INVOKE.AUTH_LOGOUT, 'codex')).resolves.toBeUndefined();
    expect(calls).toEqual(['logout', 'finalize', 'broadcast']);
    expect(onCodexAuthChange).toHaveBeenCalledWith(false);
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.AUTH_STATE_CHANGED, {
      agentKind: 'codex',
      authenticated: false,
    });
  });

  it('encodes logout persistence failures as an IPC INTERNAL error without broadcasting success', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    const logoutAgent = vi.fn().mockRejectedValue(new Error('disconnect marker write failed'));
    registerMakerAuthHandlers(harness, createMakerStub({ logoutAgent }), broadcast, () => null);

    await expect(harness.invoke(MAKER_INVOKE.AUTH_LOGOUT, 'codex')).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('rejects missing agentKind with IPC error code', async () => {
    const harness = new IpcHarness();
    registerMakerAuthHandlers(harness, createMakerStub({}), vi.fn(), () => null);

    await expect(harness.invoke(MAKER_INVOKE.AUTH_GET_STATE)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });

  it.each([
    MAKER_INVOKE.AUTH_GET_STATE,
    MAKER_INVOKE.AUTH_TRIGGER_LOGIN,
    MAKER_INVOKE.AUTH_CANCEL_LOGIN,
    MAKER_INVOKE.AUTH_LOGOUT,
  ])('rejects an unknown agentKind for %s before calling Maker', async (channel) => {
    const harness = new IpcHarness();
    const getAgentAuthState = vi.fn();
    const triggerAgentLogin = vi.fn();
    const cancelAgentLogin = vi.fn();
    const logoutAgent = vi.fn();
    registerMakerAuthHandlers(
      harness,
      createMakerStub({
        getAgentAuthState,
        triggerAgentLogin,
        cancelAgentLogin,
        logoutAgent,
      }),
      vi.fn(),
      () => null,
    );

    await expect(harness.invoke(channel, 'not-an-agent')).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    expect(getAgentAuthState).not.toHaveBeenCalled();
    expect(triggerAgentLogin).not.toHaveBeenCalled();
    expect(cancelAgentLogin).not.toHaveBeenCalled();
    expect(logoutAgent).not.toHaveBeenCalled();
  });

  it('reports api key presence without exposing the key material', async () => {
    const harness = new IpcHarness();
    registerMakerAuthHandlers(harness, createMakerStub({}), vi.fn(), () => 'sk-secret');

    await expect(harness.invoke(MAKER_INVOKE.API_KEY_PRESENT)).resolves.toEqual({ present: true });

    const absent = new IpcHarness();
    registerMakerAuthHandlers(absent, createMakerStub({}), vi.fn(), () => null);
    await expect(absent.invoke(MAKER_INVOKE.API_KEY_PRESENT)).resolves.toEqual({ present: false });
  });
});

describe('maker status IPC handlers', () => {
  it('delegates agent status lookup to Maker', async () => {
    const harness = new IpcHarness();
    const getAgentStatus = vi.fn().mockResolvedValue({ binaryReady: true, authReady: false });

    registerMakerStatusHandlers(harness, createMakerStub({ getAgentStatus }));

    await expect(harness.invoke(MAKER_INVOKE.AGENT_STATUS, 'codex')).resolves.toEqual({
      binaryReady: true,
      authReady: false,
    });
    expect(getAgentStatus).toHaveBeenCalledWith('codex');
  });
});

describe('maker usage IPC handlers', () => {
  const emptyHistory = {
    generatedAt: 0,
    todayKey: '2026-06-11',
    estimatesPending: false,
    days: [],
    modelDaily: [],
    models: [],
    streak: { current: 0, longest: 0 },
    totals: {
      today: 0,
      last30Days: 0,
      last30DaysWithEstimatedValue: 0,
      last30DaysEstimatedValue: 0,
      todayTokens: 0,
      last30DaysTokens: 0,
    },
    anomaly: { isAnomalous: false, trailing7DayAvg: null },
  };

  function makeUsageDeps(over: Record<string, unknown> = {}) {
    return {
      readAgentTodayUsage: vi.fn(),
      readCodexAccountUsageSnapshot: vi.fn(),
      readClaudeSubscriptionUsageSnapshot: vi.fn().mockResolvedValue(null),
      readClaudeAccountUsageSnapshot: vi.fn(),
      triggerClaudeAccountUsageRefresh: vi.fn(),
      readModelPricing: vi.fn(),
      readUsageHistory: vi.fn().mockResolvedValue(emptyHistory),
      emptyUsageHistory: vi.fn(() => emptyHistory),
      ...over,
    };
  }

  it('reads today usage through injected host dependency', async () => {
    const harness = new IpcHarness();
    const readAgentTodayUsage = vi.fn().mockResolvedValue({ day: '2026-06-10', totalTokens: 42 });

    registerMakerUsageHandlers(harness, makeUsageDeps({ readAgentTodayUsage }));

    await expect(harness.invoke(MAKER_INVOKE.USAGE_TODAY, 'codex')).resolves.toEqual({
      day: '2026-06-10',
      totalTokens: 42,
    });
    expect(readAgentTodayUsage).toHaveBeenCalledWith('codex');
  });

  it('warm-starts Claude account usage refresh when snapshot is empty', async () => {
    const harness = new IpcHarness();
    const triggerClaudeAccountUsageRefresh = vi.fn().mockResolvedValue(undefined);

    registerMakerUsageHandlers(
      harness,
      makeUsageDeps({
        readClaudeAccountUsageSnapshot: vi.fn(() => null),
        triggerClaudeAccountUsageRefresh,
      }),
    );

    await expect(harness.invoke(MAKER_INVOKE.USAGE_ACCOUNT, 'claude-code')).resolves.toBeNull();
    expect(triggerClaudeAccountUsageRefresh).toHaveBeenCalledWith(true);
  });

  it('reads model pricing through injected host dependency', async () => {
    const harness = new IpcHarness();
    const pricing = {
      'claude-sonnet-4-6': { inputUsdPerMtok: 3, outputUsdPerMtok: 15 },
    };
    const readModelPricing = vi.fn().mockResolvedValue(pricing);

    registerMakerUsageHandlers(harness, makeUsageDeps({ readModelPricing }));

    await expect(harness.invoke(MAKER_INVOKE.USAGE_MODEL_PRICING)).resolves.toEqual(pricing);
    expect(readModelPricing).toHaveBeenCalledTimes(1);
  });

  it('passes numeric days through to readUsageHistory and drops invalid values', async () => {
    const harness = new IpcHarness();
    const readUsageHistory = vi.fn().mockResolvedValue(emptyHistory);

    registerMakerUsageHandlers(harness, makeUsageDeps({ readUsageHistory }));

    await harness.invoke(MAKER_INVOKE.USAGE_HISTORY, { days: 140 });
    expect(readUsageHistory).toHaveBeenLastCalledWith({ days: 140 });

    await harness.invoke(MAKER_INVOKE.USAGE_HISTORY, { days: 'lots' });
    expect(readUsageHistory).toHaveBeenLastCalledWith(undefined);

    await harness.invoke(MAKER_INVOKE.USAGE_HISTORY, { days: 140, forceRefresh: true });
    expect(readUsageHistory).toHaveBeenLastCalledWith({ days: 140, forceRefresh: true });

    await harness.invoke(MAKER_INVOKE.USAGE_HISTORY, { forceRefresh: true });
    expect(readUsageHistory).toHaveBeenLastCalledWith({ forceRefresh: true });

    await harness.invoke(MAKER_INVOKE.USAGE_HISTORY);
    expect(readUsageHistory).toHaveBeenLastCalledWith(undefined);
  });

  it('falls back to empty history payload when the read throws', async () => {
    const harness = new IpcHarness();
    const readUsageHistory = vi.fn().mockRejectedValue(new Error('db gone'));

    registerMakerUsageHandlers(harness, makeUsageDeps({ readUsageHistory }));

    await expect(harness.invoke(MAKER_INVOKE.USAGE_HISTORY)).resolves.toEqual(emptyHistory);
  });
});
