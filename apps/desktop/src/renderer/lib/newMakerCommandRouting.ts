import type { Session } from '@/lib/ccAgent.types';
import { isOrcaLeadSession } from '@/lib/orcaSessionIdentity';
import { isActiveWorkerStatus, type OrcaWorkerStatus } from '../../shared/orca-worker-status';

export type NewMakerCommandResult = 'create-worker' | 'new-maker' | 'stale';

export interface NewMakerCommandRoutingOptions {
  sessionId: string | null;
  loadSession: (sessionId: string) => Promise<Pick<Session, 'orcaRole'> | null>;
  isCurrentSession: (sessionId: string | null) => boolean;
  /** Returns false when the collaboration sidebar could not accept the create intent. */
  openCreateWorker: (sessionId: string) => Promise<boolean>;
  openNewMaker: () => void;
}

/** Same hard-limit gate used by the visible add button, applied to refreshed data. */
export function canOpenWorkerFromShortcut(
  workers: Array<{ status: OrcaWorkerStatus }>,
  hardLimit: number,
): boolean {
  return workers.filter((worker) => isActiveWorkerStatus(worker.status)).length < hardLimit;
}

/**
 * Route the shared new-maker command according to the current Lead context.
 * The session is revalidated after the async lookup so a route change cannot
 * open a Worker dialog or navigate on behalf of a stale screen.
 */
export async function routeNewMakerCommand({
  sessionId,
  loadSession,
  isCurrentSession,
  openCreateWorker,
  openNewMaker,
}: NewMakerCommandRoutingOptions): Promise<NewMakerCommandResult> {
  if (!sessionId) {
    openNewMaker();
    return 'new-maker';
  }

  const session = await loadSession(sessionId).catch(() => null);
  if (!isCurrentSession(sessionId)) return 'stale';
  if (session && isOrcaLeadSession(session)) {
    if (!(await openCreateWorker(sessionId))) return 'stale';
    return 'create-worker';
  }

  openNewMaker();
  return 'new-maker';
}
