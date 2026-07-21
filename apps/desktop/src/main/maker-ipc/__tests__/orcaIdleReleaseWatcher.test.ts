import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createOrcaIdleReleaseWatcher,
  ORCA_IDLE_RELEASE_STATUSES,
  type OrcaIdleReleaseCandidate,
  type OrcaIdleReleaseWatcherDeps,
} from '../orcaIdleReleaseWatcher';

function createCandidate(
  overrides: Partial<OrcaIdleReleaseCandidate> = {},
): OrcaIdleReleaseCandidate {
  return {
    id: 'worker-1',
    sessionId: 'worker-session-1',
    leadSessionId: 'lead-1',
    status: 'done',
    idleSince: null,
    updatedAt: 1,
    ...overrides,
  };
}

function createDeps(overrides: Partial<OrcaIdleReleaseWatcherDeps> = {}) {
  const session = {
    isTurnRunning: vi.fn(() => false),
    abort: vi.fn(async () => undefined),
  };
  const deps: OrcaIdleReleaseWatcherDeps = {
    readIdleReleaseMinutes: vi.fn(() => 1),
    listCandidates: vi.fn(async () => [createCandidate()]),
    getSession: vi.fn(() => session),
    claimRelease: vi.fn(async () => true),
    rollbackRelease: vi.fn(async () => undefined),
    touchWorker: vi.fn(async () => undefined),
    closeSession: vi.fn(async () => undefined),
    broadcastWorkerChanged: vi.fn(),
    now: vi.fn(() => 120_000),
    timer: { setInterval, clearInterval },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
  return { deps, session, watcher: createOrcaIdleReleaseWatcher(deps, 25) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createOrcaIdleReleaseWatcher', () => {
  it('does not scan when idle release is disabled', async () => {
    const { deps, watcher } = createDeps({
      readIdleReleaseMinutes: vi.fn(() => 0),
    });

    await watcher.scanNow();

    expect(deps.listCandidates).not.toHaveBeenCalled();
    expect(deps.claimRelease).not.toHaveBeenCalled();
  });

  it.each(ORCA_IDLE_RELEASE_STATUSES)(
    'releases an inactive %s worker and broadcasts once',
    async (status) => {
      const candidate = createCandidate({ status });
      const { deps, session, watcher } = createDeps({
        listCandidates: vi.fn(async () => [candidate]),
      });

      await watcher.scanNow();

      expect(deps.listCandidates).toHaveBeenCalledWith(60_000);
      expect(deps.claimRelease).toHaveBeenCalledWith(candidate, 120_000);
      expect(session.abort).toHaveBeenCalledOnce();
      expect(deps.closeSession).toHaveBeenCalledWith(candidate.sessionId);
      expect(deps.broadcastWorkerChanged).toHaveBeenCalledOnce();
      expect(deps.broadcastWorkerChanged).toHaveBeenCalledWith(candidate.leadSessionId);
      expect(deps.log.info).toHaveBeenCalledWith(
        'idleWatcher: released worker',
        expect.objectContaining({ workerId: candidate.id }),
      );
    },
  );

  it('delays a worker with a live turn instead of releasing it', async () => {
    const { deps, session, watcher } = createDeps();
    session.isTurnRunning.mockReturnValue(true);

    await watcher.scanNow();

    expect(deps.touchWorker).toHaveBeenCalledWith('worker-1', 120_000);
    expect(deps.claimRelease).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.broadcastWorkerChanged).not.toHaveBeenCalled();
  });

  it('rolls back the claim when a turn starts during release', async () => {
    const { deps, session, watcher } = createDeps();
    session.isTurnRunning
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    await watcher.scanNow();

    expect(deps.claimRelease).toHaveBeenCalledOnce();
    expect(deps.rollbackRelease).toHaveBeenCalledOnce();
    expect(deps.touchWorker).toHaveBeenCalledOnce();
    expect(session.abort).not.toHaveBeenCalled();
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.broadcastWorkerChanged).not.toHaveBeenCalled();
  });

  it('skips workers that already have a release marker', async () => {
    const { deps, session, watcher } = createDeps({
      listCandidates: vi.fn(async () => [createCandidate({ idleSince: 90_000 })]),
    });

    await watcher.scanNow();

    expect(deps.claimRelease).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.broadcastWorkerChanged).not.toHaveBeenCalled();
  });

  it('does not close or broadcast when another scan already claimed the worker', async () => {
    const { deps, session, watcher } = createDeps({
      claimRelease: vi.fn(async () => false),
    });

    await watcher.scanNow();

    expect(session.abort).not.toHaveBeenCalled();
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.broadcastWorkerChanged).not.toHaveBeenCalled();
  });

  it('rolls back a claimed release when closing the runtime fails', async () => {
    const { deps, watcher } = createDeps({
      closeSession: vi.fn(async () => {
        throw new Error('close failed');
      }),
    });

    await watcher.scanNow();

    expect(deps.rollbackRelease).toHaveBeenCalledOnce();
    expect(deps.broadcastWorkerChanged).not.toHaveBeenCalled();
    expect(deps.log.warn).toHaveBeenCalledWith(
      'idleWatcher: release worker failed',
      expect.objectContaining({ workerId: 'worker-1', err: 'close failed' }),
    );
  });

  it('uses the injected interval and stops future scans', async () => {
    vi.useFakeTimers();
    const listCandidates = vi.fn(async () => []);
    const { watcher } = createDeps({ listCandidates });

    watcher.start();
    await vi.advanceTimersByTimeAsync(25);
    expect(listCandidates).toHaveBeenCalledOnce();

    watcher.stop();
    await vi.advanceTimersByTimeAsync(50);
    expect(listCandidates).toHaveBeenCalledOnce();
  });
});
