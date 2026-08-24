import { describe, expect, it, vi } from 'vitest';

import {
  projectSessionActivity,
  type SessionActivityTransition,
} from '@cindy/maker-shared/session-activity';
import {
  createBotSessionStateTransitionSource,
  createSessionActivityReader,
  type PersistedSessionActivityFacts,
} from '../sessionActivityProjection.js';

function facts(
  patch: Partial<PersistedSessionActivityFacts> = {},
): PersistedSessionActivityFacts {
  return {
    status: 'active',
    title: '任务',
    startedAt: null,
    endedAt: null,
    clearedAt: null,
    ...patch,
  };
}

function setup(opts?: {
  live?: ReturnType<typeof projectSessionActivity> | null;
  persisted?: PersistedSessionActivityFacts | null;
  terminal?: { status: 'error'; createdAt?: number };
}) {
  const deps = {
    getLiveSnapshot: vi.fn(() => opts?.live ?? null),
    getPersistedFacts: vi.fn(async () =>
      opts && 'persisted' in opts ? (opts.persisted ?? null) : facts(),
    ),
    getLatestTerminal: vi.fn(async () => opts?.terminal),
  };
  return { deps, read: createSessionActivityReader(deps) };
}

describe('canonical session activity reader', () => {
  it('uses the live Agent Island snapshot without consulting cold storage', async () => {
    const live = projectSessionActivity({
      sessionId: 'live',
      recordStatus: 'active',
      source: 'live',
      livePhase: 'needs-interaction',
      startedAtMs: 10,
      lastActivityAtMs: 20,
      currentActionSummary: '等待用户确认',
      attention: true,
    });
    const { deps, read } = setup({ live });

    await expect(read('live')).resolves.toBe(live);
    expect(deps.getPersistedFacts).not.toHaveBeenCalled();
    expect(deps.getLatestTerminal).not.toHaveBeenCalled();
  });

  it('projects a durable normal completion, record lifecycle and title workflow', async () => {
    const { read } = setup({
      persisted: facts({
        status: 'archived',
        title: '🚧#2804 会话控制面 · 待bot',
        startedAt: 100,
        endedAt: 200,
      }),
    });

    await expect(read('completed')).resolves.toMatchObject({
      sessionId: 'completed',
      recordStatus: 'archived',
      phase: 'completed',
      source: 'persisted',
      startedAtMs: 100,
      lastActivityAtMs: 200,
      currentActionSummary: '上次运行已正常结束',
      attention: false,
      workflow: {
        key: 'awaiting-bot',
        label: '待bot',
        waitingOn: 'automation',
      },
    });
  });

  it('projects an error terminal without exposing its persisted body', async () => {
    const { deps, read } = setup({
      persisted: facts({ startedAt: 100, endedAt: 150, clearedAt: 80 }),
      terminal: { status: 'error', createdAt: 175 },
    });

    await expect(read('failed')).resolves.toMatchObject({
      phase: 'error',
      lastActivityAtMs: 175,
      currentActionSummary: '上次运行出错',
      attention: true,
    });
    expect(deps.getLatestTerminal).toHaveBeenCalledWith('failed', 80);
  });

  it('marks a started turn beyond every durable close boundary as interrupted', async () => {
    const { read } = setup({
      persisted: facts({ startedAt: 300, endedAt: 200, clearedAt: 250 }),
    });

    await expect(read('interrupted')).resolves.toMatchObject({
      phase: 'error',
      startedAtMs: 300,
      lastActivityAtMs: 300,
      currentActionSummary: '上次运行未正常结束',
      attention: true,
    });
  });

  it('does not resurrect terminal state from before the clear boundary', async () => {
    const { deps, read } = setup({
      persisted: facts({
        status: 'deleted',
        title: '任务 · 等待外部系统',
        startedAt: 100,
        endedAt: 150,
        clearedAt: 200,
      }),
    });

    await expect(read('cleared')).resolves.toMatchObject({
      recordStatus: 'deleted',
      phase: 'idle',
      attention: false,
      currentActionSummary: null,
      workflow: { key: 'title:等待外部系统' },
    });
    expect(deps.getLatestTerminal).toHaveBeenCalledWith('cleared', 200);
  });

  it('fails closed to an idle fallback when the session row disappears', async () => {
    const { read } = setup({ persisted: null });
    await expect(read('missing')).resolves.toMatchObject({
      sessionId: 'missing',
      phase: 'idle',
      source: 'fallback',
    });
  });
});

describe('Bot session activity transition adapter', () => {
  function live(
    sessionId: string,
    patch: Partial<ReturnType<typeof projectSessionActivity>> = {},
  ) {
    return {
      ...projectSessionActivity({
        sessionId,
        recordStatus: 'active',
        source: 'live',
        livePhase: 'running',
        startedAtMs: 100,
        lastActivityAtMs: 120,
      }),
      ...patch,
    };
  }

  function setupTransitionSource(options?: {
    readSnapshot?: (sessionId: string) => Promise<ReturnType<typeof projectSessionActivity>>;
    readMetadata?: (sessionId: string) => Promise<{
      title: string;
      source: string;
      workingDir: string | null;
    } | null>;
  }) {
    let sourceListener: ((transition: SessionActivityTransition) => void) | null = null;
    const unsubscribe = vi.fn();
    const onError = vi.fn();
    const source = createBotSessionStateTransitionSource({
      subscribeSessionActivity: (listener) => {
        sourceListener = listener;
        return unsubscribe;
      },
      readSnapshot: options?.readSnapshot ?? (async (sessionId) => live(sessionId)),
      readMetadata: options?.readMetadata ?? (async () => ({
        title: '实现功能 · 待验收',
        source: 'desktop',
        workingDir: '/repo/cindy',
      })),
      onError,
    });
    return {
      source,
      unsubscribe,
      onError,
      emit: (transition: SessionActivityTransition) => sourceListener?.(transition),
    };
  }

  it('maps the authoritative completion edge and task metadata without persisting another state', async () => {
    const harness = setupTransitionSource();
    const listener = vi.fn();
    harness.source.subscribe(listener);

    const previous = live('task-1');
    const current = live('task-1', {
      phase: 'completed',
      currentTurnActive: false,
      lastActivityAtMs: 200,
    });
    harness.emit({ sessionId: 'task-1', previous, current, changedAtMs: 210 });

    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(listener).toHaveBeenCalledWith({
      transitionId: expect.any(String),
      sessionId: 'task-1',
      occurredAt: 210,
      title: '实现功能 · 待验收',
      source: 'desktop',
      workingDir: '/repo/cindy',
      previous: expect.objectContaining({ execution: 'running' }),
      current: expect.objectContaining({ execution: 'normal-ended' }),
      changedFacets: ['execution'],
    });
  });

  it('turns a null entry into an idle baseline so decision states are not missed', async () => {
    const harness = setupTransitionSource();
    const listener = vi.fn();
    harness.source.subscribe(listener);

    harness.emit({
      sessionId: 'task-1',
      previous: null,
      current: live('task-1', {
        phase: 'needs-interaction',
        currentTurnActive: false,
        workflow: {
          key: 'awaiting-user-decision',
          label: '等拍板',
          source: 'title',
          waitingOn: 'user',
        },
      }),
      changedAtMs: 150,
    });

    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      previous: { execution: 'idle', attention: null, workflow: null },
      current: {
        execution: 'needs-interaction',
        attention: 'needs-user',
        workflow: { key: 'awaiting-user-decision', label: '等拍板', waitingOn: 'user' },
      },
      changedFacets: ['execution', 'attention', 'workflow'],
    });
  });

  it('resolves a null exit from the canonical durable reader and keeps ids stable on replay', async () => {
    const durable = live('task-1', {
      phase: 'error',
      currentTurnActive: false,
      source: 'persisted',
      lastActivityAtMs: 300,
    });
    const harness = setupTransitionSource({ readSnapshot: async () => durable });
    const listener = vi.fn();
    harness.source.subscribe(listener);
    const edge = {
      sessionId: 'task-1',
      previous: live('task-1'),
      current: null,
      changedAtMs: 310,
    } satisfies SessionActivityTransition;

    harness.emit(edge);
    harness.emit({ ...edge, previous: null });

    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      previous: { execution: 'running' },
      current: { execution: 'error-ended' },
      changedFacets: ['execution'],
    });
    expect(listener.mock.calls[0]?.[0].transitionId).toBe(
      listener.mock.calls[1]?.[0].transitionId,
    );
  });

  it('does not deduplicate a later occurrence that reaches the same state again', async () => {
    const harness = setupTransitionSource();
    const listener = vi.fn();
    harness.source.subscribe(listener);
    const previous = live('task-1');
    const current = live('task-1', {
      phase: 'completed',
      currentTurnActive: false,
      lastActivityAtMs: 200,
    });

    harness.emit({ sessionId: 'task-1', previous, current, changedAtMs: 210 });
    harness.emit({ sessionId: 'task-1', previous, current, changedAtMs: 410 });

    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    expect(listener.mock.calls[0]?.[0].transitionId).not.toBe(
      listener.mock.calls[1]?.[0].transitionId,
    );
  });

  it('fails closed when metadata cannot be read', async () => {
    const harness = setupTransitionSource({
      readMetadata: async () => {
        throw new Error('database unavailable');
      },
    });
    const listener = vi.fn();
    harness.source.subscribe(listener);
    harness.emit({
      sessionId: 'task-1',
      previous: live('task-1'),
      current: live('task-1', { phase: 'completed', currentTurnActive: false }),
      changedAtMs: 200,
    });

    await vi.waitFor(() => expect(harness.onError).toHaveBeenCalledTimes(1));
    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribes and drops an in-flight transition after disposal', async () => {
    let resolveMetadata!: (value: {
      title: string;
      source: string;
      workingDir: string | null;
    }) => void;
    const metadataPromise = new Promise<{
      title: string;
      source: string;
      workingDir: string | null;
    }>((resolve) => {
      resolveMetadata = resolve;
    });
    const harness = setupTransitionSource({
      readMetadata: () => metadataPromise,
    });
    const listener = vi.fn();
    const dispose = harness.source.subscribe(listener);
    harness.emit({
      sessionId: 'task-1',
      previous: live('task-1'),
      current: live('task-1', { phase: 'completed', currentTurnActive: false }),
      changedAtMs: 200,
    });

    dispose();
    resolveMetadata({ title: '任务', source: 'desktop', workingDir: '/repo/cindy' });
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('maps canonical snapshots for the zero-token guardian and rejects missing fallback rows', async () => {
    const harness = setupTransitionSource({
      readSnapshot: async (sessionId) =>
        sessionId === 'missing'
          ? projectSessionActivity({ sessionId, source: 'fallback' })
          : live(sessionId, {
              phase: 'needs-interaction',
              workflow: {
                key: 'awaiting-user-decision',
                label: '等拍板',
                source: 'title',
                waitingOn: 'user',
              },
            }),
    });

    await expect(harness.source.readSnapshot?.('task-1')).resolves.toMatchObject({
      lifecycle: 'active',
      execution: 'needs-interaction',
      attention: 'needs-user',
      workflow: { key: 'awaiting-user-decision', waitingOn: 'user' },
    });
    await expect(harness.source.readSnapshot?.('missing')).resolves.toBeNull();
  });
});
