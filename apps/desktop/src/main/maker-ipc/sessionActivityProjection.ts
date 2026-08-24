import { createHash } from 'node:crypto';

import {
  projectSessionActivity,
  type SessionActivitySnapshot,
  type SessionActivityTransition,
  type SessionRecordStatus,
} from '@cindy/maker-shared/session-activity';
import { eq } from 'drizzle-orm';

import type {
  BotObservedSessionState,
  BotSessionStateTransitionSource,
} from '../../shared/botSessionEvents.js';
import { getAgentIslandService } from '../agent-island/service.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { createLogger } from '../logger.js';
import {
  readLatestSessionTerminal,
  type SessionTerminalHint,
} from '../localDb/sessionTerminal.js';

const log = createLogger('maker-ipc:session-activity-projection');

export interface PersistedSessionActivityFacts {
  status: SessionRecordStatus;
  title: string | null;
  startedAt: number | null;
  endedAt: number | null;
  clearedAt: number | null;
}

export interface SessionActivityReaderDeps {
  getLiveSnapshot(sessionId: string): SessionActivitySnapshot | null;
  getPersistedFacts(sessionId: string): Promise<PersistedSessionActivityFacts | null>;
  getLatestTerminal(
    sessionId: string,
    clearedAt: number | null,
  ): Promise<SessionTerminalHint | undefined>;
}

/**
 * Build a canonical reader from the existing live and durable authorities.
 * This is a projection only: it never persists or owns another status copy.
 */
export function createSessionActivityReader(deps: SessionActivityReaderDeps) {
  return async (sessionId: string): Promise<SessionActivitySnapshot> => {
    const live = deps.getLiveSnapshot(sessionId);
    if (live) return live;

    const row = await deps.getPersistedFacts(sessionId);
    if (!row) return projectSessionActivity({ sessionId, source: 'fallback' });

    const terminal = await deps.getLatestTerminal(sessionId, row.clearedAt);
    const visibilityBoundary = Math.max(row.endedAt ?? 0, row.clearedAt ?? 0);
    const interrupted = row.startedAt !== null && row.startedAt > visibilityBoundary;
    const completed =
      row.endedAt !== null
      && row.endedAt > (row.clearedAt ?? 0)
      && (row.startedAt === null || row.endedAt >= row.startedAt);
    const failed = terminal !== undefined || interrupted;

    return projectSessionActivity({
      sessionId,
      recordStatus: row.status,
      title: row.title,
      source: 'persisted',
      terminal: failed ? 'error' : completed ? 'completed' : null,
      startedAtMs: row.startedAt,
      lastActivityAtMs: terminal?.createdAt ?? (interrupted ? row.startedAt : row.endedAt ?? row.startedAt),
      currentActionSummary: terminal
        ? '上次运行出错'
        : interrupted
          ? '上次运行未正常结束'
          : completed
            ? '上次运行已正常结束'
            : null,
      attention: failed,
    });
  };
}

async function readPersistedSessionActivityFacts(
  sessionId: string,
): Promise<PersistedSessionActivityFacts | null> {
  const [row] = await getDbClient()
    .drizzle.select({
      status: sessions.status,
      title: sessions.title,
      startedAt: sessions.activeTurnStartedAt,
      endedAt: sessions.lastTurnEndedAt,
      clearedAt: sessions.clearedAt,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

const readDefaultSessionActivity = createSessionActivityReader({
  getLiveSnapshot: (sessionId) =>
    getAgentIslandService()?.getSessionActivitySnapshot(sessionId) ?? null,
  getPersistedFacts: readPersistedSessionActivityFacts,
  getLatestTerminal: readLatestSessionTerminal,
});

/** Main-owned canonical activity read shared by UI-backed state and MCP probes. */
export function readCanonicalSessionActivity(
  sessionId: string,
): Promise<SessionActivitySnapshot> {
  return readDefaultSessionActivity(sessionId);
}

export interface BotSessionTransitionMetadata {
  title: string;
  source: string;
  workingDir: string | null;
}

export interface BotSessionStateTransitionSourceDeps {
  subscribeSessionActivity(
    listener: (transition: SessionActivityTransition) => void,
  ): () => void;
  readSnapshot(sessionId: string): Promise<SessionActivitySnapshot>;
  readMetadata(sessionId: string): Promise<BotSessionTransitionMetadata | null>;
  onError?: (error: unknown, sessionId: string) => void;
}

function botExecutionState(phase: SessionActivitySnapshot['phase']): string {
  if (phase === 'completed') return 'normal-ended';
  if (phase === 'error') return 'error-ended';
  return phase;
}

function botObservedSessionState(snapshot: SessionActivitySnapshot): BotObservedSessionState {
  return {
    lifecycle: snapshot.recordStatus ?? 'active',
    execution: botExecutionState(snapshot.phase),
    attention: snapshot.phase === 'needs-interaction' ? 'needs-user' : null,
    workflow: snapshot.workflow
      ? {
          key: snapshot.workflow.key,
          label: snapshot.workflow.label,
          ...(snapshot.workflow.waitingOn ? { waitingOn: snapshot.workflow.waitingOn } : {}),
        }
      : null,
    startedAtMs: snapshot.startedAtMs,
    lastActivityAtMs: snapshot.lastActivityAtMs,
    turnGeneration: snapshot.turnGeneration,
  };
}

function missingFallbackSnapshot(snapshot: SessionActivitySnapshot): boolean {
  return snapshot.source === 'fallback' && snapshot.recordStatus === undefined;
}

function idleBaseline(snapshot: SessionActivitySnapshot): SessionActivitySnapshot {
  return projectSessionActivity({
    sessionId: snapshot.sessionId,
    recordStatus: snapshot.recordStatus,
    source: snapshot.source,
  });
}

function botChangedFacets(
  previous: BotObservedSessionState,
  current: BotObservedSessionState,
): string[] {
  const changed: string[] = [];
  if (previous.lifecycle !== current.lifecycle) changed.push('lifecycle');
  if (previous.execution !== current.execution) changed.push('execution');
  if (previous.attention !== current.attention) changed.push('attention');
  if (JSON.stringify(previous.workflow) !== JSON.stringify(current.workflow)) {
    changed.push('workflow');
  }
  return changed;
}

function botTransitionId(input: {
  sessionId: string;
  current: BotObservedSessionState;
  occurredAt: number;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/**
 * Adapt the canonical SessionActivity stream for Cindy Bots without owning a
 * second publisher or persisted status model. Metadata is read from the same
 * Session row only after an authoritative edge arrives.
 */
export function createBotSessionStateTransitionSource(
  deps: BotSessionStateTransitionSourceDeps,
): BotSessionStateTransitionSource {
  const readObservedSnapshot = async (
    sessionId: string,
  ): Promise<BotObservedSessionState | null> => {
    const snapshot = await deps.readSnapshot(sessionId);
    return missingFallbackSnapshot(snapshot) ? null : botObservedSessionState(snapshot);
  };

  return {
    subscribe(listener) {
      let active = true;
      const pendingBySession = new Map<string, Promise<void>>();
      const unsubscribe = deps.subscribeSessionActivity((transition) => {
        const previousWork = pendingBySession.get(transition.sessionId) ?? Promise.resolve();
        const work = previousWork
          .then(async () => {
            if (!active) return;
            const [metadata, currentSnapshot] = await Promise.all([
              deps.readMetadata(transition.sessionId),
              transition.current
                ? Promise.resolve(transition.current)
                : deps.readSnapshot(transition.sessionId),
            ]);
            if (!active || !metadata || missingFallbackSnapshot(currentSnapshot)) return;
            const previous = botObservedSessionState(
              transition.previous ?? idleBaseline(currentSnapshot),
            );
            const current = botObservedSessionState(currentSnapshot);
            const changedFacets = botChangedFacets(previous, current);
            if (changedFacets.length === 0) return;
            listener({
              transitionId: botTransitionId({
                sessionId: transition.sessionId,
                current,
                occurredAt: transition.changedAtMs,
              }),
              sessionId: transition.sessionId,
              occurredAt: transition.changedAtMs,
              previous,
              current,
              changedFacets,
              title: metadata.title,
              source: metadata.source,
              workingDir: metadata.workingDir ?? '',
            });
          })
          .catch((error) => {
            if (active) deps.onError?.(error, transition.sessionId);
          });
        pendingBySession.set(transition.sessionId, work);
        void work.finally(() => {
          if (pendingBySession.get(transition.sessionId) === work) {
            pendingBySession.delete(transition.sessionId);
          }
        });
      });
      return () => {
        active = false;
        unsubscribe();
        pendingBySession.clear();
      };
    },
    readSnapshot: readObservedSnapshot,
  };
}

async function readBotSessionTransitionMetadata(
  sessionId: string,
): Promise<BotSessionTransitionMetadata | null> {
  const [row] = await getDbClient()
    .drizzle.select({
      title: sessions.title,
      source: sessions.source,
      workingDir: sessions.workingDir,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

/** Production adapter over the existing Agent Island transition publisher. */
export function createDefaultBotSessionStateTransitionSource(): BotSessionStateTransitionSource {
  return createBotSessionStateTransitionSource({
    subscribeSessionActivity: (listener) =>
      getAgentIslandService()?.subscribeSessionActivity(listener) ?? (() => undefined),
    readSnapshot: readCanonicalSessionActivity,
    readMetadata: readBotSessionTransitionMetadata,
    onError: (error, sessionId) => {
      log.warn('Bot SessionActivity transition adapter failed closed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
}
