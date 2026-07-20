// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { Session } from '@/lib/ccAgent.types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock('@/lib/sessionService', () => ({
  list: mocks.list,
  create: vi.fn(),
}));

import { useCCSessions } from '@/hooks/useCCSessions';
import { sessionsStore } from '@/lib/sessionsStore';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function session(id: string): Session {
  return { id } as Session;
}

describe('sessionsStore account boundaries', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    sessionsStore.reset();
  });

  afterEach(() => {
    cleanup();
    sessionsStore.reset();
  });

  it('does not let a request started before reset repopulate the cache', async () => {
    const oldRequest = deferred<Session[]>();
    const newRequest = deferred<Session[]>();
    mocks.list
      .mockImplementationOnce(() => oldRequest.promise)
      .mockImplementationOnce(() => newRequest.promise);

    const oldLoad = sessionsStore.ensureByFilter('active');
    sessionsStore.reset();
    const newLoad = sessionsStore.ensureByFilter('active');

    newRequest.resolve([session('new-account')]);
    await newLoad;
    oldRequest.resolve([session('old-account')]);
    await oldLoad;

    expect(sessionsStore.getByFilter('active')?.map(({ id }) => id)).toEqual([
      'new-account',
    ]);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('clears an already mounted hook snapshot and reloads after reset', async () => {
    mocks.list.mockResolvedValueOnce([session('old-account')]);
    await sessionsStore.ensureByFilter('active');

    const newRequest = deferred<Session[]>();
    mocks.list.mockImplementationOnce(() => newRequest.promise);
    const view = renderHook(() => useCCSessions());
    expect(view.result.current.sessions.map(({ id }) => id)).toEqual(['old-account']);

    act(() => sessionsStore.reset());
    expect(view.result.current.sessions).toEqual([]);
    expect(view.result.current.isLoading).toBe(true);

    newRequest.resolve([session('new-account')]);
    await waitFor(() => {
      expect(view.result.current.sessions.map(({ id }) => id)).toEqual(['new-account']);
    });
    expect(view.result.current.isLoading).toBe(false);
  });

  it('removes a deleted session from every loaded filter without refetching', async () => {
    mocks.list
      .mockResolvedValueOnce([session('deleted'), session('keep-active')])
      .mockResolvedValueOnce([session('deleted'), session('keep-all')]);
    await sessionsStore.ensureByFilter('active');
    await sessionsStore.ensureByFilter('all');
    mocks.list.mockReset();

    act(() => sessionsStore.patchLocal('deleted', { status: 'deleted' }));

    expect(sessionsStore.getByFilter('active')?.map(({ id }) => id)).toEqual(['keep-active']);
    expect(sessionsStore.getByFilter('all')?.map(({ id }) => id)).toEqual(['keep-all']);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
