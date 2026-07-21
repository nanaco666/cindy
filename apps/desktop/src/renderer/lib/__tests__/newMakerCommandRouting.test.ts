import { describe, expect, it, vi } from 'vitest';

import { canOpenWorkerFromShortcut, routeNewMakerCommand } from '../newMakerCommandRouting';

describe('routeNewMakerCommand', () => {
  it('opens the Worker dialog for the current Orca Lead without navigating', async () => {
    const openCreateWorker = vi.fn(async () => undefined);
    const openNewMaker = vi.fn();

    await expect(
      routeNewMakerCommand({
        sessionId: 'lead-1',
        loadSession: async () => ({ orcaRole: 'lead' }),
        isCurrentSession: (sessionId) => sessionId === 'lead-1',
        openCreateWorker,
        openNewMaker,
      }),
    ).resolves.toBe('create-worker');

    expect(openCreateWorker).toHaveBeenCalledOnce();
    expect(openCreateWorker).toHaveBeenCalledWith('lead-1');
    expect(openNewMaker).not.toHaveBeenCalled();
  });

  it.each([null, 'worker'] as const)(
    'keeps the global new-session behavior outside a Lead context (%s)',
    async (orcaRole) => {
      const openCreateWorker = vi.fn(async () => undefined);
      const openNewMaker = vi.fn();

      await expect(
        routeNewMakerCommand({
          sessionId: 'session-1',
          loadSession: async () => ({ orcaRole }),
          isCurrentSession: () => true,
          openCreateWorker,
          openNewMaker,
        }),
      ).resolves.toBe('new-maker');

      expect(openCreateWorker).not.toHaveBeenCalled();
      expect(openNewMaker).toHaveBeenCalledOnce();
    },
  );

  it('drops a command when the route changes during session lookup', async () => {
    const openCreateWorker = vi.fn(async () => undefined);
    const openNewMaker = vi.fn();

    await expect(
      routeNewMakerCommand({
        sessionId: 'lead-1',
        loadSession: async () => ({ orcaRole: 'lead' }),
        isCurrentSession: () => false,
        openCreateWorker,
        openNewMaker,
      }),
    ).resolves.toBe('stale');

    expect(openCreateWorker).not.toHaveBeenCalled();
    expect(openNewMaker).not.toHaveBeenCalled();
  });
});

describe('canOpenWorkerFromShortcut', () => {
  it('counts only active workers and blocks at the hard limit', () => {
    expect(
      canOpenWorkerFromShortcut([{ status: 'running' }, { status: 'idle' }, { status: 'done' }], 2),
    ).toBe(false);
    expect(canOpenWorkerFromShortcut([{ status: 'running' }, { status: 'done' }], 2)).toBe(true);
  });
});
