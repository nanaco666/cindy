// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerInfo } from '../useWorkers';

const mocks = vi.hoisted(() => ({
  workers: [] as WorkerInfo[],
  refresh: vi.fn(),
  switchFocus: vi.fn(async () => undefined),
}));

vi.mock('../useWorkers', () => ({
  useWorkers: () => ({
    workers: mocks.workers,
    focusedWorker: mocks.workers.find((worker) => worker.focused) ?? mocks.workers[0] ?? null,
    activeWorkerCount: mocks.workers.length,
    softLimit: 5,
    hardLimit: 8,
    refresh: mocks.refresh,
  }),
}));

vi.mock('@/lib/makerTransport', () => ({
  orcaWorkflowsFor: () => ({
    createWorker: vi.fn(async () => undefined),
    switchFocus: mocks.switchFocus,
    archiveWorker: vi.fn(async () => undefined),
  }),
}));

vi.mock('@/lib/toast', () => ({
  toast: {
    error: vi.fn(),
  },
}));

import { useOrcaWorkerSelection } from '../useOrcaWorkerSelection';

function makeWorker(workerId: string, sessionId: string, focused = false): WorkerInfo {
  return {
    workerId,
    sessionId,
    role: workerId,
    agent: 'codex',
    model: 'gpt-5.4',
    effort: null,
    label: null,
    status: 'idle',
    focused,
    idleSince: null,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={['/cc-agent/lead-1']}>{children}</MemoryRouter>;
}

describe('useOrcaWorkerSelection', () => {
  beforeEach(() => {
    mocks.workers = [
      makeWorker('worker-a', 'session-a', true),
      makeWorker('worker-b', 'session-b'),
    ];
    mocks.refresh.mockClear();
    mocks.refresh.mockResolvedValue({
      leadSessionId: 'lead-1',
      requestId: 1,
      status: 'applied',
      workers: mocks.workers,
    });
    mocks.switchFocus.mockClear();
  });

  it('pins an explicit focusWorkerSessionId ahead of the current focused worker until the user switches', async () => {
    const consumed = vi.fn();
    const { result, rerender } = renderHook(
      ({ focusWorkerSessionId, focusWorkerHintRevision }) =>
        useOrcaWorkerSelection({
          leadSessionId: 'lead-1',
          focusWorkerSessionId,
          focusWorkerHintRevision,
          onFocusWorkerSessionIdConsumed: consumed,
        }),
      {
        initialProps: {
          focusWorkerSessionId: 'session-b' as string | null,
          focusWorkerHintRevision: 1,
        },
        wrapper,
      },
    );

    expect(result.current.workerSessionId).toBe('session-b');

    await waitFor(() => {
      expect(consumed).toHaveBeenCalledTimes(1);
    });

    rerender({ focusWorkerSessionId: null, focusWorkerHintRevision: 1 });

    expect(result.current.workerSessionId).toBe('session-b');

    act(() => {
      result.current.handleSwitchFocus('worker-a');
    });

    expect(result.current.workerSessionId).toBe('session-a');
    expect(mocks.switchFocus).toHaveBeenCalledWith({
      leadSessionId: 'lead-1',
      workerIdOrLabel: 'worker-a',
    });
  });

  it('keeps a missing focusWorkerSessionId pending until the worker list refreshes', async () => {
    mocks.workers = [makeWorker('worker-a', 'session-a', true)];
    let resolveRefresh!: (value: unknown) => void;
    mocks.refresh.mockReset().mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const consumed = vi.fn();
    const { result, rerender } = renderHook(
      ({ focusWorkerSessionId, focusWorkerHintRevision }) =>
        useOrcaWorkerSelection({
          leadSessionId: 'lead-1',
          focusWorkerSessionId,
          focusWorkerHintRevision,
          onFocusWorkerSessionIdConsumed: consumed,
        }),
      {
        initialProps: {
          focusWorkerSessionId: 'session-b' as string | null,
          focusWorkerHintRevision: 1,
        },
        wrapper,
      },
    );

    expect(result.current.workerSessionId).toBeNull();

    await waitFor(() => {
      expect(consumed).toHaveBeenCalledTimes(1);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);

    rerender({ focusWorkerSessionId: null, focusWorkerHintRevision: 1 });
    expect(result.current.workerSessionId).toBeNull();

    mocks.workers = [makeWorker('worker-a', 'session-a', true)];
    rerender({ focusWorkerSessionId: null, focusWorkerHintRevision: 1 });

    expect(result.current.workerSessionId).toBeNull();

    await act(async () => {
      resolveRefresh({
        leadSessionId: 'lead-1',
        requestId: 2,
        status: 'applied',
        workers: mocks.workers,
      });
    });

    expect(result.current.workerSessionId).toBe('session-a');

    mocks.workers = [
      makeWorker('worker-a', 'session-a', true),
      makeWorker('worker-b', 'session-b'),
    ];
    rerender({ focusWorkerSessionId: null, focusWorkerHintRevision: 1 });
    expect(result.current.workerSessionId).toBe('session-a');
  });

  it('distinguishes consumed clear from a newer external null clear', async () => {
    const consumed = vi.fn();
    const { result, rerender } = renderHook(
      ({ focusWorkerSessionId, focusWorkerHintRevision }) =>
        useOrcaWorkerSelection({
          leadSessionId: 'lead-1',
          focusWorkerSessionId,
          focusWorkerHintRevision,
          onFocusWorkerSessionIdConsumed: consumed,
        }),
      {
        initialProps: {
          focusWorkerSessionId: 'session-b' as string | null,
          focusWorkerHintRevision: 4,
        },
        wrapper,
      },
    );

    expect(result.current.workerSessionId).toBe('session-b');
    rerender({ focusWorkerSessionId: null, focusWorkerHintRevision: 4 });
    expect(result.current.workerSessionId).toBe('session-b');

    rerender({ focusWorkerSessionId: null, focusWorkerHintRevision: 5 });
    expect(result.current.workerSessionId).toBe('session-a');
  });

  it('keeps the explicit target pending until it appears in a refreshed worker list', async () => {
    mocks.workers = [makeWorker('worker-a', 'session-a', true)];
    let resolveRefresh!: (value: unknown) => void;
    mocks.refresh.mockReset().mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const { result, rerender } = renderHook(
      ({ revision }) =>
        useOrcaWorkerSelection({
          leadSessionId: 'lead-1',
          focusWorkerSessionId: 'session-b',
          focusWorkerHintRevision: revision,
        }),
      { initialProps: { revision: 1 }, wrapper },
    );
    expect(result.current.workerSessionId).toBeNull();

    mocks.workers = [
      makeWorker('worker-a', 'session-a', true),
      makeWorker('worker-b', 'session-b'),
    ];
    rerender({ revision: 1 });
    expect(result.current.workerSessionId).toBe('session-b');

    await act(async () => {
      resolveRefresh({
        leadSessionId: 'lead-1',
        requestId: 2,
        status: 'applied',
        workers: mocks.workers,
      });
    });
    expect(result.current.workerSessionId).toBe('session-b');
  });

  it('invalidates a deferred hint refresh when the user switches workers', async () => {
    mocks.workers = [makeWorker('worker-a', 'session-a', true)];
    let resolveRefresh!: (value: unknown) => void;
    mocks.refresh.mockReset().mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const consumed = vi.fn();
    const cleared = vi.fn();
    const { result, rerender } = renderHook(
      ({ focusWorkerSessionId }) =>
        useOrcaWorkerSelection({
          leadSessionId: 'lead-1',
          focusWorkerSessionId,
          focusWorkerHintRevision: 7,
          onFocusWorkerSessionIdConsumed: consumed,
          onSelectionIntentCleared: cleared,
        }),
      {
        initialProps: { focusWorkerSessionId: 'session-b' as string | null },
        wrapper,
      },
    );
    await waitFor(() => expect(consumed).toHaveBeenCalledWith(7));
    rerender({ focusWorkerSessionId: null });

    act(() => result.current.handleSwitchFocus('worker-a'));
    expect(cleared).toHaveBeenCalledWith(7);
    expect(result.current.workerSessionId).toBe('session-a');

    mocks.workers = [
      makeWorker('worker-a', 'session-a', true),
      makeWorker('worker-b', 'session-b'),
    ];
    rerender({ focusWorkerSessionId: null });
    await act(async () => {
      resolveRefresh({
        leadSessionId: 'lead-1',
        requestId: 2,
        status: 'applied',
        workers: mocks.workers,
      });
    });

    expect(result.current.workerSessionId).toBe('session-a');
  });

  it('invalidates a deferred hint refresh when the Lead changes', async () => {
    mocks.workers = [makeWorker('worker-a', 'session-a', true)];
    let resolveRefresh!: (value: unknown) => void;
    mocks.refresh.mockReset().mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const { result, rerender } = renderHook(
      ({ leadSessionId, focusWorkerSessionId }) =>
        useOrcaWorkerSelection({
          leadSessionId,
          focusWorkerSessionId,
          focusWorkerHintRevision: 1,
        }),
      {
        initialProps: { leadSessionId: 'lead-1', focusWorkerSessionId: 'session-b' },
        wrapper,
      },
    );
    expect(result.current.workerSessionId).toBeNull();

    mocks.workers = [makeWorker('worker-c', 'session-c', true)];
    rerender({ leadSessionId: 'lead-2', focusWorkerSessionId: 'session-c' });
    expect(result.current.workerSessionId).toBe('session-c');

    await act(async () => {
      resolveRefresh({
        leadSessionId: 'lead-1',
        requestId: 2,
        status: 'applied',
        workers: [makeWorker('worker-b', 'session-b', true)],
      });
    });
    expect(result.current.workerSessionId).toBe('session-c');
  });

  it('does not start a pending timeout when the hinted worker is already cached', () => {
    vi.useFakeTimers();
    mocks.refresh.mockReset().mockReturnValue(new Promise(() => undefined));
    const { result, unmount } = renderHook(
      () =>
        useOrcaWorkerSelection({
          leadSessionId: 'lead-1',
          focusWorkerSessionId: 'session-b',
          focusWorkerHintRevision: 1,
        }),
      { wrapper },
    );

    expect(result.current.workerSessionId).toBe('session-b');
    expect(mocks.refresh).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.workerSessionId).toBe('session-b');
    unmount();
    vi.useRealTimers();
  });

  it('cancels the fallback timeout as soon as a pending worker appears', () => {
    vi.useFakeTimers();
    mocks.workers = [makeWorker('worker-a', 'session-a', true)];
    mocks.refresh.mockReset().mockReturnValue(new Promise(() => undefined));
    const { rerender, unmount } = renderHook(
      ({ revision }) =>
        useOrcaWorkerSelection({
          leadSessionId: 'lead-1',
          focusWorkerSessionId: 'session-b',
          focusWorkerHintRevision: revision,
        }),
      { initialProps: { revision: 1 }, wrapper },
    );
    expect(vi.getTimerCount()).toBe(1);

    mocks.workers = [
      makeWorker('worker-a', 'session-a', true),
      makeWorker('worker-b', 'session-b'),
    ];
    rerender({ revision: 1 });
    expect(vi.getTimerCount()).toBe(0);

    unmount();
    vi.useRealTimers();
  });

  it('clears a slow search jump when the user leaves its worker', async () => {
    const cleared = vi.fn();
    const jump = {
      kind: 'conversation-search' as const,
      sessionId: 'session-b',
      messageId: 'message-b',
      messageIdKind: 'clientId' as const,
      messageClientId: 'message-b',
    };
    const { result, rerender } = renderHook(
      ({ focusWorkerSessionId, searchJump }) =>
        useOrcaWorkerSelection({
          leadSessionId: 'lead-1',
          focusWorkerSessionId,
          focusWorkerHintRevision: 3,
          searchJump,
          onSelectionIntentCleared: cleared,
        }),
      {
        initialProps: {
          focusWorkerSessionId: 'session-b' as string | null,
          searchJump: jump as typeof jump | null,
        },
        wrapper,
      },
    );

    expect(result.current.workerSessionId).toBe('session-b');
    rerender({ focusWorkerSessionId: null, searchJump: jump });
    expect(result.current.workerSessionId).toBe('session-b');

    act(() => result.current.handleSwitchFocus('worker-a'));
    expect(cleared).toHaveBeenCalledWith(3);
    rerender({ focusWorkerSessionId: null, searchJump: null });
    expect(result.current.workerSessionId).toBe('session-a');

    act(() => result.current.handleSwitchFocus('worker-b'));
    expect(cleared).toHaveBeenCalledTimes(2);
    mocks.workers = [
      makeWorker('worker-a', 'session-a'),
      makeWorker('worker-b', 'session-b', true),
    ];
    rerender({ focusWorkerSessionId: null, searchJump: null });
    expect(result.current.workerSessionId).toBe('session-b');
  });

  it('falls back after a bounded wait when the latest refresh never settles', () => {
    vi.useFakeTimers();
    mocks.workers = [makeWorker('worker-a', 'session-a', true)];
    mocks.refresh.mockReset().mockReturnValue(new Promise(() => undefined));
    const { result, unmount } = renderHook(
      () =>
        useOrcaWorkerSelection({
          leadSessionId: 'lead-1',
          focusWorkerSessionId: 'session-b',
          focusWorkerHintRevision: 1,
        }),
      { wrapper },
    );
    expect(result.current.workerSessionId).toBeNull();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.workerSessionId).toBe('session-a');
    unmount();
    vi.useRealTimers();
  });
});
