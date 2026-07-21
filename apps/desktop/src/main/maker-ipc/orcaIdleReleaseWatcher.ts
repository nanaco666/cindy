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
  abort(): Promise<void>;
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
  claimRelease(candidate: OrcaIdleReleaseCandidate, releasedAt: number): Promise<boolean>;
  rollbackRelease(candidate: OrcaIdleReleaseCandidate, releasedAt: number): Promise<void>;
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
 * candidate is atomically claimed before its runtime is closed so duplicate scans
 * cannot close or broadcast the same release twice.
 */
export function createOrcaIdleReleaseWatcher(
  deps: OrcaIdleReleaseWatcherDeps,
  scanIntervalMs = DEFAULT_SCAN_INTERVAL_MS,
): OrcaIdleReleaseWatcher {
  let timerHandle: ReturnType<typeof setInterval> | null = null;
  let scanInFlight = false;

  const scanNow = async (): Promise<void> => {
    if (scanInFlight) return;
    scanInFlight = true;
    try {
      const idleReleaseMinutes = deps.readIdleReleaseMinutes();
      if (idleReleaseMinutes <= 0) return;

      const threshold = deps.now() - idleReleaseMinutes * 60_000;
      const candidates = await deps.listCandidates(threshold);
      for (const candidate of candidates) {
        if (candidate.idleSince !== null || !isReleaseStatus(candidate.status)) continue;

        const session = deps.getSession(candidate.sessionId);
        if (session?.isTurnRunning()) {
          await deps.touchWorker(candidate.id, deps.now());
          continue;
        }

        const releasedAt = deps.now();
        let claimed = false;
        try {
          claimed = await deps.claimRelease(candidate, releasedAt);
          if (!claimed) continue;

          // A turn can start while the DB claim is awaiting; never close that live runtime.
          if (session?.isTurnRunning()) {
            await deps.rollbackRelease(candidate, releasedAt);
            await deps.touchWorker(candidate.id, deps.now());
            continue;
          }

          if (session) {
            await session.abort();
            await deps.closeSession(candidate.sessionId);
          }

          deps.log.info('idleWatcher: released worker', {
            workerId: candidate.id,
            sessionId: candidate.sessionId,
            idleThresholdMin: idleReleaseMinutes,
          });
          deps.broadcastWorkerChanged(candidate.leadSessionId);
        } catch (err) {
          if (claimed) {
            await deps.rollbackRelease(candidate, releasedAt).catch(() => undefined);
          }
          deps.log.warn('idleWatcher: release worker failed', {
            workerId: candidate.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
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
