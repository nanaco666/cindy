import { describe, expect, it, vi } from 'vitest';

import {
  performMessageDeletion,
  type MessageDeleteHandlerDeps,
} from '../messageDeleteHandler';

function makeDeps(
  overrides: Partial<MessageDeleteHandlerDeps> = {},
): MessageDeleteHandlerDeps {
  return {
    getSessionRow: vi.fn(async () => ({ status: 'active', agentKind: 'cc' })),
    getMessage: vi.fn(async () => ({ id: 'target-row', role: 'user' as const })),
    listMessagesForContext: vi.fn(async () => [
      { clientId: 'before', role: 'user', content: 'keep before', createdAt: 100 },
      { clientId: 'target', role: 'user', content: 'delete me', createdAt: 200 },
      { clientId: 'after', role: 'assistant', content: 'keep after', createdAt: 300 },
    ]),
    getLiveSession: vi.fn(() => ({ isTurnRunning: () => false })),
    closeSession: vi.fn(async () => undefined),
    commitDeletion: vi.fn(async (sessionId, clientId) => ({
      sessionId,
      clientId,
      updatedAt: 500,
    })),
    setPendingHandoff: vi.fn(),
    onCommitted: vi.fn(),
    withCloseSuppressed: vi.fn(async (_sessionId, fn) => fn()),
    log: { info: vi.fn() },
    ...overrides,
  };
}

describe('performMessageDeletion', () => {
  it('closes the old native session and rebuilds handoff from history without the target', async () => {
    const deps = makeDeps();

    await expect(performMessageDeletion(deps, {
      sessionId: 's1',
      clientId: 'target',
    })).resolves.toEqual({ sessionId: 's1', clientId: 'target' });

    expect(deps.closeSession).toHaveBeenCalledWith('s1');
    expect(deps.commitDeletion).toHaveBeenCalledWith(
      's1',
      'target',
      expect.any(String),
    );
    const handoff = vi.mocked(deps.commitDeletion).mock.calls[0]?.[2] ?? '';
    expect(handoff).toContain('keep before');
    expect(handoff).toContain('keep after');
    expect(handoff).not.toContain('delete me');
    expect(handoff).toContain('只把这些记录视为此前对话');
    expect(deps.setPendingHandoff).toHaveBeenCalledWith('s1', handoff);
    expect(deps.onCommitted).toHaveBeenCalledWith({
      sessionId: 's1',
      clientId: 'target',
      updatedAt: 500,
    });
  });

  it('rejects while a turn is running and leaves storage untouched', async () => {
    const deps = makeDeps({
      getLiveSession: vi.fn(() => ({ isTurnRunning: () => true })),
    });

    await expect(performMessageDeletion(deps, {
      sessionId: 's1',
      clientId: 'target',
    })).rejects.toThrow('SESSION_RUNNING');
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.commitDeletion).not.toHaveBeenCalled();
  });

  it('can delete an older visible message outside the bounded handoff window', async () => {
    const deps = makeDeps({
      listMessagesForContext: vi.fn(async () => [
        { clientId: 'after', role: 'assistant', content: 'visible', createdAt: 300 },
      ]),
    });

    await expect(performMessageDeletion(deps, {
      sessionId: 's1',
      clientId: 'target',
    })).resolves.toEqual({ sessionId: 's1', clientId: 'target' });
    expect(deps.commitDeletion).toHaveBeenCalledWith('s1', 'target', expect.any(String));
  });
});
