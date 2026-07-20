import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResponseObserverCtx } from '@lizi/anthropic-compat-proxy';
import type { PermissionMode } from '@lizi/maker-core';

import {
  createClaudeAutoClassifierFailureObserver,
  createClaudeAutoPermissionFallbackCoordinator,
  isClaudeAutoClassifierRequest,
  setClaudeAutoClassifierUnavailableListener,
  type ClaudeAutoPermissionFallbackDeps,
} from '../claude-auto-permission-fallback.js';

const CLASSIFIER_PREFIX = 'You are a security monitor for autonomous AI coding agents.';

function requestBody(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 64,
      system: [{ type: 'text', text: `${CLASSIFIER_PREFIX}\nRules` }],
      messages: [],
      ...overrides,
    }),
  );
}

function ctx(overrides: Partial<ResponseObserverCtx> = {}): ResponseObserverCtx {
  return {
    reqId: 1,
    method: 'POST',
    url: '/v1/messages',
    upstreamBase: 'https://relay.example',
    status: 429,
    requestHeaders: { 'x-claude-code-session-id': 'sdk-1' },
    responseHeaders: {},
    requestBody: requestBody(),
    ...overrides,
  };
}

function createDeps(overrides: Partial<ClaudeAutoPermissionFallbackDeps> = {}) {
  const setPermissionMode = vi.fn<(mode: PermissionMode) => Promise<void>>(async () => {});
  const deps: ClaudeAutoPermissionFallbackDeps = {
    getSession: vi.fn(() => ({ agentKind: 'claude-code', setPermissionMode })),
    getSessionMeta: vi.fn(async () => ({ permissionMode: 'auto' as const })),
    persistPermissionMode: vi.fn(async () => {}),
    broadcast: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
  return { deps, setPermissionMode };
}

afterEach(() => {
  setClaudeAutoClassifierUnavailableListener(() => {});
});

describe('Claude Auto classifier request detection', () => {
  it('accepts the observed array and string system prompt shapes', () => {
    expect(isClaudeAutoClassifierRequest(requestBody())).toBe(true);
    expect(
      isClaudeAutoClassifierRequest(requestBody({ system: `${CLASSIFIER_PREFIX}\nRules` })),
    ).toBe(true);
  });

  it('fails closed for malformed or lookalike requests', () => {
    expect(isClaudeAutoClassifierRequest(Buffer.from('{bad json'))).toBe(false);
    expect(isClaudeAutoClassifierRequest(requestBody({ max_tokens: 128 }))).toBe(false);
    expect(isClaudeAutoClassifierRequest(requestBody({ system: 'ordinary assistant' }))).toBe(
      false,
    );
    expect(isClaudeAutoClassifierRequest(requestBody({ system: [] }))).toBe(false);
  });
});

describe('createClaudeAutoClassifierFailureObserver', () => {
  it('reports classifier 429 and 5xx with the resolved business session id', () => {
    const signals: unknown[] = [];
    setClaudeAutoClassifierUnavailableListener((signal) => signals.push(signal));
    const observer = createClaudeAutoClassifierFailureObserver((sdkId) =>
      sdkId === 'sdk-1' ? 'session-1' : null,
    );

    expect(observer(ctx({ status: 429 }))).toBeUndefined();
    expect(
      observer(
        ctx({
          status: 503,
          requestBody: requestBody({ system: `${CLASSIFIER_PREFIX}\nRules` }),
        }),
      ),
    ).toBeUndefined();
    expect(signals).toEqual([
      { sessionId: 'session-1', status: 429 },
      { sessionId: 'session-1', status: 503 },
    ]);
  });

  it('does not parse/report success, 4xx, ordinary errors, or unresolved sessions', () => {
    const listener = vi.fn();
    setClaudeAutoClassifierUnavailableListener(listener);
    const resolved = createClaudeAutoClassifierFailureObserver(() => 'session-1');
    const unresolved = createClaudeAutoClassifierFailureObserver(() => null);

    resolved(ctx({ status: 200, requestBody: Buffer.from('{bad json') }));
    resolved(ctx({ status: 400 }));
    resolved(ctx({ status: 429, requestBody: requestBody({ system: 'ordinary assistant' }) }));
    unresolved(ctx());
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('createClaudeAutoPermissionFallbackCoordinator', () => {
  it('switches runtime, persists ask, and broadcasts only after success', async () => {
    const order: string[] = [];
    const { deps, setPermissionMode } = createDeps({
      getSessionMeta: vi.fn(async () => ({ permissionMode: 'auto' as const })),
      persistPermissionMode: vi.fn(async () => {
        order.push('persist');
      }),
      broadcast: vi.fn(() => {
        order.push('broadcast');
      }),
    });
    setPermissionMode.mockImplementation(async () => {
      order.push('runtime');
    });
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    await expect(fallback({ sessionId: 'session-1', status: 429 })).resolves.toBe(true);
    expect(order).toEqual(['runtime', 'persist', 'broadcast']);
    expect(deps.persistPermissionMode).toHaveBeenCalledWith('session-1', 'ask');
    expect(deps.broadcast).toHaveBeenCalledWith({
      sessionId: 'session-1',
      from: 'auto',
      to: 'ask',
      reason: 'classifier_unavailable',
      status: 429,
    });
  });

  it('deduplicates concurrent failures for the same session', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, setPermissionMode } = createDeps();
    setPermissionMode.mockImplementation(async () => gate);
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    const first = fallback({ sessionId: 'session-1', status: 429 });
    await vi.waitFor(() => expect(setPermissionMode).toHaveBeenCalledTimes(1));
    await expect(fallback({ sessionId: 'session-1', status: 503 })).resolves.toBe(false);
    release();
    await expect(first).resolves.toBe(true);
    expect(deps.persistPermissionMode).toHaveBeenCalledTimes(1);
  });

  it('does not override a user permission change racing with the fallback', async () => {
    const { deps, setPermissionMode } = createDeps({
      getSessionMeta: vi
        .fn()
        .mockResolvedValueOnce({ permissionMode: 'auto' })
        .mockResolvedValueOnce({ permissionMode: 'bypassPermissions' }),
    });
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    await expect(fallback({ sessionId: 'session-1', status: 429 })).resolves.toBe(false);
    expect(setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual([
      'ask',
      'bypassPermissions',
    ]);
    expect(deps.persistPermissionMode).not.toHaveBeenCalled();
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it('skips non-auto or non-Claude sessions', async () => {
    const notAuto = createDeps({
      getSessionMeta: vi.fn(async () => ({ permissionMode: 'ask' as const })),
    });
    const codex = createDeps({
      getSession: vi.fn(() => ({
        agentKind: 'codex',
        setPermissionMode: vi.fn(async () => {}),
      })),
    });

    await expect(
      createClaudeAutoPermissionFallbackCoordinator(notAuto.deps)({
        sessionId: 'session-1',
        status: 429,
      }),
    ).resolves.toBe(false);
    await expect(
      createClaudeAutoPermissionFallbackCoordinator(codex.deps)({
        sessionId: 'session-1',
        status: 429,
      }),
    ).resolves.toBe(false);
    expect(notAuto.setPermissionMode).not.toHaveBeenCalled();
    expect(codex.deps.persistPermissionMode).not.toHaveBeenCalled();
  });

  it('rolls runtime back to persisted mode when persistence fails', async () => {
    const { deps, setPermissionMode } = createDeps({
      getSessionMeta: vi.fn(async () => ({ permissionMode: 'auto' as const })),
      persistPermissionMode: vi.fn(async () => {
        throw new Error('db unavailable');
      }),
    });
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    await expect(fallback({ sessionId: 'session-1', status: 429 })).resolves.toBe(false);
    expect(setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual(['ask', 'auto']);
    expect(deps.broadcast).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'auto permission fallback failed',
      expect.objectContaining({ error: 'db unavailable' }),
    );
  });
});
