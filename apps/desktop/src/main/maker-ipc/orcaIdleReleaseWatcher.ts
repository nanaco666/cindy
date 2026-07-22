/** Worker statuses that may release their runtime after the configured idle threshold. */
export const ORCA_IDLE_RELEASE_STATUSES = ['idle', 'running', 'done', 'error'] as const;

export type OrcaIdleReleaseStatus = (typeof ORCA_IDLE_RELEASE_STATUSES)[number];

/** Minimal persisted worker state needed by the idle-release policy. */
export interface OrcaIdleReleaseCandidate {
  id: string;
  sessionId: string;
  leadSessionId: string;
  status: OrcaIdleReleaseStatus;
  idleSince: number | null;
  updatedAt: number;
}

/** Runtime session surface used to protect a live turn from background release. */
export interface OrcaIdleReleaseSession {
  isTurnRunning(): boolean;
}

/** Timer handle abstraction keeps the watcher deterministic under fake timers. */
export interface OrcaIdleReleaseTimer {
  setInterval(callback: () => void, intervalMs: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

/** Host dependencies for persistence, runtime teardown, broadcasts, and diagnostics. */
export interface OrcaIdleReleaseWatcherDeps {
  readIdleReleaseMinutes(): number;
  listCandidates(updatedBefore: number): Promise<readonly OrcaIdleReleaseCandidate[]>;
  getSession(sessionId: string): OrcaIdleReleaseSession | null;
  withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
  hasPendingInput(sessionId: string): Promise<boolean>;
  markReleased(candidate: OrcaIdleReleaseCandidate, releasedAt: number): Promise<boolean>;
  clearReleased(candidate: OrcaIdleReleaseCandidate, restoredAt: number): Promise<boolean>;
  touchWorker(workerId: string, updatedAt: number): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  broadcastWorkerChanged(leadSessionId: string): void;
  now(): number;
  timer: OrcaIdleReleaseTimer;
  log: {
    info(message: string, details?: Record<string, unknown>): void;
    warn(message: string, details?: Record<string, unknown>): void;
  };
}

export interface OrcaIdleReleaseWatcher {
  start(): void;
  stop(): void;
  scanNow(): Promise<void>;
}

const DEFAULT_SCAN_INTERVAL_MS = 60_000;

function isReleaseStatus(status: string): status is OrcaIdleReleaseStatus {
  return ORCA_IDLE_RELEASE_STATUSES.some((candidate) => candidate === status);
}

/**
 * Creates the process-level Worker idle watcher. A scan is single-flight, and each
 * release marker is written atomically after the local runtime closes. Persisted
 * orphan candidates are observed for a full scan interval before being marked, and
 * every process reconciles marked rows with any runtime that it still owns.
 */
export function createOrcaIdleReleaseWatcher(
  deps: OrcaIdleReleaseWatcherDeps,
  scanIntervalMs = DEFAULT_SCAN_INTERVAL_MS,
): OrcaIdleReleaseWatcher {
  let timerHandle: ReturnType<typeof setInterval> | null = null;
  let scanInFlight = false;
  const missingRuntimeObservations = new Map<string, {
    candidateVersion: string;
    firstSeenAt: number;
  }>();

  const publishReleased = async (
    candidate: OrcaIdleReleaseCandidate,
    releasedAt: number,
    runtimeOwner: 'local' | 'missing',
    idleReleaseMinutes: number,
  ): Promise<void> => {
    const marked = await deps.markReleased(candidate, releasedAt);
    if (!marked) return;

    deps.log.info('idleWatcher: released worker', {
      workerId: candidate.id,
      sessionId: candidate.sessionId,
      idleThresholdMin: idleReleaseMinutes,
      runtimeOwner,
    });
    deps.broadcastWorkerChanged(candidate.leadSessionId);
  };

  const scanNow = async (): Promise<void> => {
    if (scanInFlight) return;
    scanInFlight = true;
    try {
      const idleReleaseMinutes = deps.readIdleReleaseMinutes();
      if (idleReleaseMinutes <= 0) return;

      const threshold = deps.now() - idleReleaseMinutes * 60_000;
      const candidates = await deps.listCandidates(threshold);
      const candidateIds = new Set(candidates.map((candidate) => candidate.id));
      for (const candidate of candidates) {
        if (!isReleaseStatus(candidate.status)) {
          missingRuntimeObservations.delete(candidate.id);
          continue;
        }

        try {
          await deps.withSessionLock(candidate.sessionId, async () => {
            const session = deps.getSession(candidate.sessionId);

            // A live turn is stronger evidence than queued input. If another process
            // wrote a release marker, restore the running state before considering
            // the queue so the active Worker is not persisted as idle.
            if (candidate.idleSince !== null && session?.isTurnRunning()) {
              missingRuntimeObservations.delete(candidate.id);
              const restored = await deps.clearReleased(candidate, deps.now());
              if (restored) deps.broadcastWorkerChanged(candidate.leadSessionId);
              return;
            }

            // A terminal DB status can coexist with a follow-up that has already
            // entered the durable input queue. Keep that Worker counted until the
            // queued turn is accepted instead of tearing down its runtime.
            if (await deps.hasPendingInput(candidate.sessionId)) {
              missingRuntimeObservations.delete(candidate.id);
              await deps.touchWorker(candidate.id, deps.now());
              if (candidate.idleSince !== null) {
                deps.broadcastWorkerChanged(candidate.leadSessionId);
              }
              return;
            }

            // A different process can mark a stale persisted Worker. If this process
            // still owns its runtime, finish the teardown here; a concurrently started
            // turn wins by clearing the marker instead.
            if (candidate.idleSince !== null) {
              missingRuntimeObservations.delete(candidate.id);
              if (!session) return;
              await deps.closeSession(candidate.sessionId);
              deps.log.info('idleWatcher: closed released worker runtime', {
                workerId: candidate.id,
                sessionId: candidate.sessionId,
              });
              return;
            }

            // Maker sessions are process-local. Observe an unchanged missing runtime
            // for one full scan interval before treating it as left over by a restart.
            // Other processes also scan marked rows, so a real owner will either close
            // its dormant runtime or clear the marker if a turn has started meanwhile.
            if (!session) {
              const observedAt = deps.now();
              const candidateVersion = `${candidate.status}:${candidate.updatedAt}`;
              const observation = missingRuntimeObservations.get(candidate.id);
              if (!observation || observation.candidateVersion !== candidateVersion) {
                missingRuntimeObservations.set(candidate.id, {
                  candidateVersion,
                  firstSeenAt: observedAt,
                });
                return;
              }
              if (observedAt - observation.firstSeenAt < scanIntervalMs) return;

              missingRuntimeObservations.delete(candidate.id);
              await publishReleased(candidate, observedAt, 'missing', idleReleaseMinutes);
              return;
            }

            missingRuntimeObservations.delete(candidate.id);

            // Sends and releases share this lock. Re-read the live session only after
            // acquiring it so a newly accepted turn cannot be closed by this scan.
            if (session.isTurnRunning()) {
              await deps.touchWorker(candidate.id, deps.now());
              return;
            }

            await deps.closeSession(candidate.sessionId);
            await publishReleased(candidate, deps.now(), 'local', idleReleaseMinutes);
          });
        } catch (err) {
          deps.log.warn('idleWatcher: release worker failed', {
            workerId: candidate.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      for (const workerId of missingRuntimeObservations.keys()) {
        if (!candidateIds.has(workerId)) missingRuntimeObservations.delete(workerId);
      }
    } catch (err) {
      deps.log.warn('idleWatcher: scan failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      scanInFlight = false;
    }
  };

  return {
    start() {
      if (timerHandle !== null) deps.timer.clearInterval(timerHandle);
      timerHandle = deps.timer.setInterval(() => {
        void scanNow();
      }, scanIntervalMs);
      deps.log.info('idleWatcher started');
    },
    stop() {
      if (timerHandle === null) return;
      deps.timer.clearInterval(timerHandle);
      timerHandle = null;
      deps.log.info('idleWatcher stopped');
    },
    scanNow,
  };
}
