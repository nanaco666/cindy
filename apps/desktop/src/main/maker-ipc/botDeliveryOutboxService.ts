import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, isNull, lte, or } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import { botChannels, botDeliveryOutbox, botProfiles, botRoutes } from '../localDb/schema.js';
import type { BotDeliveryView } from '../../shared/botDelivery.js';
import { parseBotDeliveryDiagnostic } from '../../shared/botDeliveryDiagnostic.js';
import { resolveBotCanonicalSession } from './botCanonicalSessionRegistry.js';
import { clearBotAttention, noteBotAttention } from './botAttentionService.js';
import { createLogger } from '../logger.js';

const log = createLogger('maker-ipc:bot-delivery-outbox');

const RETRYABLE_STATUSES = ['pending', 'failed'] as const;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_SENDING_LEASE_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const MAX_PAYLOAD_BYTES = 256 * 1024;

export interface BotDeliveryEnvelope {
  version: 1;
  kind: string;
  [key: string]: unknown;
}

export interface BotDeliveryRow {
  id: string;
  botId: string;
  channelId: string | null;
  routeId: string | null;
  sessionId: string | null;
  idempotencyKey: string;
  ownerGeneration: number;
  attempts: number;
}

export type BotDeliveryAttemptResult =
  | { ok: true; receipt?: Record<string, unknown> }
  | { ok: false; retryable: boolean; errorCode: string; message: string };

export interface BotDeliveryOutboxServiceDeps {
  deliver: (
    row: BotDeliveryRow,
    payload: BotDeliveryEnvelope,
    attempt: {
      /**
       * Persist the exact point at which an adapter call may have crossed the
       * process boundary.  A provider-idempotent transport can be replayed
       * after a crash; a local adapter cannot be retried automatically because
       * the provider may have accepted the message before the process died.
       */
      recordExternalDispatch(input: {
        retrySafe: boolean;
        transport: string;
      }): Promise<void>;
      /** Persist provider acknowledgements as a multipart send advances. */
      recordProgress(receipt: Record<string, unknown>): Promise<void>;
    },
  ) => Promise<BotDeliveryAttemptResult>;
  now?: () => number;
  createId?: () => string;
  maxAttempts?: number;
  sendingLeaseMs?: number;
  /**
   * Watchdog budget for one `deliver` call. An adapter that never settles
   * must not pin the serial drain loop (and with it every Bot's queue), so a
   * timed-out attempt is failed like any retryable error and retried with the
   * normal backoff. Idempotent transports stay safe: the existing
   * `recordExternalDispatch({ retrySafe: false })` marker still converts a
   * timeout into a dead-letter `DELIVERY_OUTCOME_UNKNOWN` instead of a retry.
   * Defaults to `sendingLeaseMs`.
   */
  deliverTimeoutMs?: number;
  onChanged?: (payload: { botId: string; deliveryId?: string }) => void;
  /** Release payload-owned resources after the row becomes non-retryable. */
  releaseResources?: (
    row: Pick<BotDeliveryRow, 'id' | 'botId' | 'idempotencyKey'>,
    payload: BotDeliveryEnvelope,
  ) => Promise<void>;
  noteAttention?: typeof noteBotAttention;
  clearAttention?: typeof clearBotAttention;
}

export interface EnqueueBotDeliveryInput {
  botId: string;
  channelId?: string | null;
  routeId?: string | null;
  sessionId?: string | null;
  idempotencyKey: string;
  ownerGeneration?: number;
  payload: BotDeliveryEnvelope;
}

export interface RecordUnknownBotDeliveryInput extends EnqueueBotDeliveryInput {
  errorCode: string;
  message: string;
  transport: string;
  progress?: Record<string, unknown>;
}

function parseEnvelope(value: string): BotDeliveryEnvelope | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || typeof record.kind !== 'string' || !record.kind.trim()) return null;
    return record as BotDeliveryEnvelope;
  } catch {
    return null;
  }
}

function parseReceipt(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function retryDelayMs(attempts: number): number {
  const schedule = [1_000, 5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000];
  return schedule[Math.min(Math.max(0, attempts - 1), schedule.length - 1)]!;
}

export function createBotDeliveryOutboxService(deps: BotDeliveryOutboxServiceDeps) {
  const now = deps.now ?? Date.now;
  const createId = deps.createId ?? randomUUID;
  const maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const sendingLeaseMs = Math.max(1_000, deps.sendingLeaseMs ?? DEFAULT_SENDING_LEASE_MS);
  const deliverTimeoutMs = Math.max(1_000, deps.deliverTimeoutMs ?? sendingLeaseMs);
  const noteAttention = deps.noteAttention ?? noteBotAttention;
  const clearAttention = deps.clearAttention ?? clearBotAttention;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let requeueTimer: ReturnType<typeof setInterval> | null = null;
  let requeueSweepRunning = false;
  let drainPromise: Promise<void> | null = null;
  let disposed = false;

  const emitChanged = (botId: string, deliveryId?: string): void => {
    deps.onChanged?.({ botId, ...(deliveryId ? { deliveryId } : {}) });
  };

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const clearRequeueTimer = (): void => {
    if (requeueTimer) clearInterval(requeueTimer);
    requeueTimer = null;
  };

  const scheduleDrain = (delayMs = 0): void => {
    if (disposed) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, delayMs)));
    timer.unref?.();
  };

  const markTerminal = async (
    id: string,
    status: 'delivered' | 'dead-letter' | 'cancelled',
    lastError: string | null,
    receipt?: Record<string, unknown>,
  ): Promise<void> => {
    const at = now();
    const [current] = await getDbClient()
      .drizzle.select({
        botId: botDeliveryOutbox.botId,
        idempotencyKey: botDeliveryOutbox.idempotencyKey,
        payloadRefJson: botDeliveryOutbox.payloadRefJson,
        deliveryReceiptJson: botDeliveryOutbox.deliveryReceiptJson,
      })
      .from(botDeliveryOutbox)
      .where(and(eq(botDeliveryOutbox.id, id), eq(botDeliveryOutbox.status, 'sending')))
      .limit(1);
    const existingReceipt = parseReceipt(current?.deliveryReceiptJson);
    const [updated] = await getDbClient()
      .drizzle.update(botDeliveryOutbox)
      .set({
        status,
        lastError,
        deliveryReceiptJson: status === 'delivered'
          ? JSON.stringify({ ...existingReceipt, ...(receipt ?? {}) })
          : current?.deliveryReceiptJson ?? null,
        nextAttemptAt: null,
        updatedAt: at,
        deliveredAt: status === 'delivered' ? at : null,
      })
      .where(and(eq(botDeliveryOutbox.id, id), eq(botDeliveryOutbox.status, 'sending')))
      .returning({ botId: botDeliveryOutbox.botId });
    if (updated) {
      emitChanged(updated.botId, id);
      if (status === 'delivered') {
        await clearAttention({ botId: updated.botId, successfulAt: at }).catch((error) => {
          log.warn('Bot delivery attention clear failed', {
            botId: updated.botId,
            deliveryId: id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      if ((status === 'delivered' || status === 'cancelled') && current) {
        const payload = parseEnvelope(current.payloadRefJson);
        if (payload) {
          try {
            await deps.releaseResources?.(
              { id, botId: current.botId, idempotencyKey: current.idempotencyKey },
              payload,
            );
          } catch {
            // A retained managed-media reference is safer than rolling back a
            // provider delivery that already reached a terminal state.
          }
        }
      }
    }
  };

  const markFailure = async (
    row: BotDeliveryRow,
    result: Extract<BotDeliveryAttemptResult, { ok: false }>,
  ): Promise<void> => {
    const at = now();
    const exhausted = row.attempts >= maxAttempts;
    const terminal = !result.retryable || exhausted;
    const [updated] = await getDbClient()
      .drizzle.update(botDeliveryOutbox)
      .set({
        status: terminal ? 'dead-letter' : 'failed',
        lastError: `${result.errorCode}: ${result.message}`.slice(0, 4_000),
        nextAttemptAt: terminal ? null : at + retryDelayMs(row.attempts),
        updatedAt: at,
        deliveredAt: null,
      })
      .where(and(eq(botDeliveryOutbox.id, row.id), eq(botDeliveryOutbox.status, 'sending')))
      .returning({ botId: botDeliveryOutbox.botId });
    if (updated) {
      emitChanged(updated.botId, row.id);
      log.warn('Bot delivery attempt failed', {
        deliveryId: row.id,
        botId: updated.botId,
        attempt: row.attempts,
        errorCode: result.errorCode,
        retryable: result.retryable,
        terminal,
      });
      await noteAttention({
        botId: updated.botId,
        failure: { errorCode: result.errorCode, message: result.message },
        observedAt: at,
      }).catch((error) => {
        log.warn('Bot delivery attention update failed', {
          botId: updated.botId,
          deliveryId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };

  const validateRouteOwnership = async (row: BotDeliveryRow): Promise<boolean> => {
    if (!row.routeId) return true;
    const [route] = await getDbClient()
      .drizzle.select({
        ownerGeneration: botRoutes.ownerGeneration,
        status: botRoutes.status,
      })
      .from(botRoutes)
      .where(eq(botRoutes.id, row.routeId))
      .limit(1);
    if (!route) {
      await markTerminal(row.id, 'cancelled', 'ROUTE_NOT_FOUND: delivery route no longer exists');
      return false;
    }
    if (route.ownerGeneration !== row.ownerGeneration) {
      await markTerminal(
        row.id,
        'cancelled',
        `STALE_ROUTE_OWNER: expected generation ${row.ownerGeneration}, current ${route.ownerGeneration}`,
      );
      return false;
    }
    if (route.status === 'active') return true;
    if (route.status === 'archived') {
      await markTerminal(row.id, 'cancelled', 'ROUTE_ARCHIVED: delivery route is archived');
      return false;
    }
    await markFailure(row, {
      ok: false,
      retryable: true,
      errorCode: 'ROUTE_UNAVAILABLE',
      message: `delivery route is ${route.status}`,
    });
    return false;
  };

  const requeueExpiredSending = async (): Promise<number> => {
    const at = now();
    const db = getDbClient().drizzle;
    const stale = await db
      .select({
        id: botDeliveryOutbox.id,
        botId: botDeliveryOutbox.botId,
        deliveryReceiptJson: botDeliveryOutbox.deliveryReceiptJson,
      })
      .from(botDeliveryOutbox)
      .where(
        and(
          eq(botDeliveryOutbox.status, 'sending'),
          lte(botDeliveryOutbox.updatedAt, at - sendingLeaseMs),
        ),
      );
    let requeued = 0;
    for (const row of stale) {
      let retrySafe = true;
      try {
        const marker = row.deliveryReceiptJson
          ? JSON.parse(row.deliveryReceiptJson) as Record<string, unknown>
          : null;
        const dispatch = marker?.externalDispatch;
        if (dispatch && typeof dispatch === 'object' && !Array.isArray(dispatch)) {
          retrySafe = (dispatch as Record<string, unknown>).retrySafe !== false;
        }
      } catch {
        // A malformed diagnostic marker must not turn an otherwise recoverable
        // pre-dispatch lease into permanent message loss.
      }
      const write = await db
        .update(botDeliveryOutbox)
        .set(
          retrySafe
            ? { status: 'failed', nextAttemptAt: at, updatedAt: at }
            : {
                status: 'dead-letter',
                nextAttemptAt: null,
                lastError:
                  'DELIVERY_OUTCOME_UNKNOWN: local adapter may have delivered before the host stopped; automatic retry was suppressed to prevent a duplicate',
                updatedAt: at,
              },
        )
        .where(
          and(
            eq(botDeliveryOutbox.id, row.id),
            eq(botDeliveryOutbox.status, 'sending'),
            lte(botDeliveryOutbox.updatedAt, at - sendingLeaseMs),
          ),
        )
        .returning({ id: botDeliveryOutbox.id });
      if (write.length > 0) {
        log.warn('Bot delivery sending lease expired; requeued for retry', {
          deliveryId: row.id,
          botId: row.botId,
          retrySafe,
        });
        requeued += 1;
      }
    }
    if (requeued > 0) scheduleDrain(0);
    return requeued;
  };

  /**
   * Reclaim expired `sending` leases on a dedicated interval, decoupled from
   * drain liveness. The drain loop used to be the only driver of
   * `requeueExpiredSending`, so one adapter call that never settled starved
   * the lease reclaim with it (PR #2829 QA: the queue was dead for 64 minutes
   * while the 60s lease was never enforced). Overlapping a live drain is
   * harmless: the reclaim CAS still requires the row to be `sending` with an
   * expired `updatedAt`.
   */
  const startRequeueSweeper = (): void => {
    if (disposed || requeueTimer) return;
    const intervalMs = Math.max(1_000, Math.floor(sendingLeaseMs / 2));
    requeueTimer = setInterval(() => {
      if (requeueSweepRunning) return;
      requeueSweepRunning = true;
      void requeueExpiredSending()
        .catch((error) => {
          log.warn('Bot delivery lease sweep failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          requeueSweepRunning = false;
        });
    }, intervalMs);
    requeueTimer.unref?.();
  };

  const claimNext = async (): Promise<{
    row: BotDeliveryRow;
    payloadRefJson: string;
  } | null> => {
    const db = getDbClient().drizzle;
    const at = now();
    const [candidate] = await db
      .select({
        id: botDeliveryOutbox.id,
        botId: botDeliveryOutbox.botId,
        channelId: botDeliveryOutbox.channelId,
        routeId: botDeliveryOutbox.routeId,
        sessionId: botDeliveryOutbox.sessionId,
        idempotencyKey: botDeliveryOutbox.idempotencyKey,
        ownerGeneration: botDeliveryOutbox.ownerGeneration,
        attempts: botDeliveryOutbox.attempts,
        payloadRefJson: botDeliveryOutbox.payloadRefJson,
      })
      .from(botDeliveryOutbox)
      .where(
        and(
          inArray(botDeliveryOutbox.status, [...RETRYABLE_STATUSES]),
          or(isNull(botDeliveryOutbox.nextAttemptAt), lte(botDeliveryOutbox.nextAttemptAt, at)),
        ),
      )
      .orderBy(asc(botDeliveryOutbox.createdAt))
      .limit(1);
    if (!candidate) return null;
    const [claimed] = await db
      .update(botDeliveryOutbox)
      .set({ status: 'sending', attempts: candidate.attempts + 1, updatedAt: at })
      .where(
        and(
          eq(botDeliveryOutbox.id, candidate.id),
          inArray(botDeliveryOutbox.status, [...RETRYABLE_STATUSES]),
          eq(botDeliveryOutbox.attempts, candidate.attempts),
        ),
      )
      .returning({ id: botDeliveryOutbox.id });
    if (!claimed) return null;
    return {
      row: {
        id: candidate.id,
        botId: candidate.botId,
        channelId: candidate.channelId,
        routeId: candidate.routeId,
        sessionId: candidate.sessionId,
        idempotencyKey: candidate.idempotencyKey,
        ownerGeneration: candidate.ownerGeneration,
        attempts: candidate.attempts + 1,
      },
      payloadRefJson: candidate.payloadRefJson,
    };
  };

  const scheduleNextDue = async (): Promise<void> => {
    if (disposed) return;
    const [next] = await getDbClient()
      .drizzle.select({ nextAttemptAt: botDeliveryOutbox.nextAttemptAt })
      .from(botDeliveryOutbox)
      .where(inArray(botDeliveryOutbox.status, [...RETRYABLE_STATUSES]))
      .orderBy(asc(botDeliveryOutbox.nextAttemptAt), asc(botDeliveryOutbox.createdAt))
      .limit(1);
    if (!next) return;
    scheduleDrain(Math.max(0, (next.nextAttemptAt ?? now()) - now()));
  };

  const runDrain = async (): Promise<void> => {
    await requeueExpiredSending();
    let processed = 0;
    while (!disposed && processed < 100) {
      const claimed = await claimNext();
      if (!claimed) break;
      processed += 1;
      const payload = parseEnvelope(claimed.payloadRefJson);
      if (!payload) {
        await markTerminal(claimed.row.id, 'dead-letter', 'INVALID_PAYLOAD: malformed envelope');
        continue;
      }
      if (!(await validateRouteOwnership(claimed.row))) continue;
      log.info('Bot delivery attempt started', {
        deliveryId: claimed.row.id,
        botId: claimed.row.botId,
        kind: payload.kind,
        attempt: claimed.row.attempts,
      });
      const attemptStartedAt = now();
      let result: BotDeliveryAttemptResult;
      const attemptState: {
        externalDispatch: { retrySafe: boolean; transport: string; startedAt: number } | null;
        progress: Record<string, unknown>;
      } = { externalDispatch: null, progress: {} };
      const persistAttemptReceipt = async (): Promise<void> => {
        const [updated] = await getDbClient()
          .drizzle.update(botDeliveryOutbox)
          .set({
            deliveryReceiptJson: JSON.stringify({
              ...(attemptState.externalDispatch
                ? {
                    externalDispatch: {
                      ...attemptState.externalDispatch,
                    },
                  }
                : {}),
              progress: attemptState.progress,
            }),
            updatedAt: now(),
          })
          .where(
            and(
              eq(botDeliveryOutbox.id, claimed.row.id),
              eq(botDeliveryOutbox.status, 'sending'),
            ),
          )
          .returning({ id: botDeliveryOutbox.id });
        if (!updated) throw new Error('Bot delivery claim was lost during external dispatch');
      };
      // Promise.resolve().then(...) also captures an adapter that throws before
      // returning its Promise, so one synchronous transport bug is handled by
      // the same retry/timeout path instead of rejecting the whole drain.
      const deliverPromise = Promise.resolve().then(() =>
        deps.deliver(claimed.row, payload, {
          recordExternalDispatch: async (input) => {
            attemptState.externalDispatch = {
              retrySafe: input.retrySafe,
              transport: input.transport.trim() || 'unknown',
              startedAt: now(),
            };
            await persistAttemptReceipt();
          },
          recordProgress: async (receipt) => {
            attemptState.progress = { ...attemptState.progress, ...receipt };
            await persistAttemptReceipt();
          },
        }),
      );
      try {
        if (deliverTimeoutMs > 0) {
          let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
          const timeout = new Promise<null>((resolve) => {
            timeoutHandle = setTimeout(() => resolve(null), deliverTimeoutMs);
            timeoutHandle.unref?.();
          });
          const settled = await Promise.race([
            deliverPromise.then((value) => {
              if (timeoutHandle) clearTimeout(timeoutHandle);
              return value;
            }),
            timeout,
          ]);
          if (settled === null) {
            log.warn('Bot delivery attempt timed out', {
              deliveryId: claimed.row.id,
              botId: claimed.row.botId,
              kind: payload.kind,
              attempt: claimed.row.attempts,
              deliverTimeoutMs,
            });
            // The abandoned adapter call may still settle later. Its own state
            // writes CAS on `status = 'sending'`, which no longer matches after
            // the failure below, so it cannot resurrect or duplicate the row;
            // observe the late settlement purely for diagnostics.
            void deliverPromise.then(
              (lateResult) => log.warn('Bot delivery attempt settled after timeout', {
                deliveryId: claimed.row.id,
                ok: lateResult.ok,
                errorCode: lateResult.ok ? null : lateResult.errorCode,
              }),
              (lateError) => log.warn('Bot delivery attempt failed after timeout', {
                deliveryId: claimed.row.id,
                error: lateError instanceof Error ? lateError.message : String(lateError),
              }),
            ).catch(() => undefined);
            result = {
              ok: false,
              retryable: true,
              errorCode: 'DELIVERY_TIMEOUT',
              message: `deliver did not settle within ${deliverTimeoutMs}ms`,
            };
          } else {
            result = settled;
          }
        } else {
          result = await deliverPromise;
        }
      } catch (error) {
        result = {
          ok: false,
          retryable: true,
          errorCode: 'DELIVERY_EXCEPTION',
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (
        !result.ok
        && attemptState.externalDispatch?.retrySafe === false
        && result.retryable
      ) {
        result = {
          ok: false,
          retryable: false,
          errorCode: 'DELIVERY_OUTCOME_UNKNOWN',
          message:
            `${result.errorCode}: ${result.message}; local adapter may already have delivered, so automatic retry was suppressed`,
        };
      }
      if (result.ok) {
        log.info('Bot delivery attempt delivered', {
          deliveryId: claimed.row.id,
          botId: claimed.row.botId,
          kind: payload.kind,
          attempt: claimed.row.attempts,
          elapsedMs: now() - attemptStartedAt,
        });
        await markTerminal(claimed.row.id, 'delivered', null, result.receipt);
      } else {
        await markFailure(claimed.row, result);
      }
    }
    await scheduleNextDue();
    if (processed >= 100) scheduleDrain(0);
  };

  function drain(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (drainPromise) return drainPromise;
    drainPromise = runDrain().finally(() => {
      drainPromise = null;
    });
    return drainPromise;
  }

  const enqueue = async (input: EnqueueBotDeliveryInput): Promise<{ id: string }> => {
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) throw new Error('Bot delivery idempotencyKey is required');
    const payloadRefJson = JSON.stringify(input.payload);
    if (Buffer.byteLength(payloadRefJson, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new Error(`Bot delivery payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    }
    const db = getDbClient().drizzle;
    const at = now();
    const id = createId();
    await db
      .insert(botDeliveryOutbox)
      .values({
        id,
        botId: input.botId,
        channelId: input.channelId ?? null,
        routeId: input.routeId ?? null,
        sessionId: input.sessionId ?? null,
        idempotencyKey,
        payloadRefJson,
        ownerGeneration: input.ownerGeneration ?? 0,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: at,
        lastError: null,
        deliveryReceiptJson: null,
        createdAt: at,
        updatedAt: at,
        deliveredAt: null,
      })
      .onConflictDoNothing({ target: botDeliveryOutbox.idempotencyKey });
    const [row] = await db
      .select({
        id: botDeliveryOutbox.id,
        botId: botDeliveryOutbox.botId,
        channelId: botDeliveryOutbox.channelId,
        routeId: botDeliveryOutbox.routeId,
        sessionId: botDeliveryOutbox.sessionId,
        ownerGeneration: botDeliveryOutbox.ownerGeneration,
        payloadRefJson: botDeliveryOutbox.payloadRefJson,
      })
      .from(botDeliveryOutbox)
      .where(eq(botDeliveryOutbox.idempotencyKey, idempotencyKey))
      .limit(1);
    if (!row) throw new Error('Bot delivery enqueue failed');
    if (
      row.botId !== input.botId
      || row.channelId !== (input.channelId ?? null)
      || row.routeId !== (input.routeId ?? null)
      || row.sessionId !== (input.sessionId ?? null)
      || row.ownerGeneration !== (input.ownerGeneration ?? 0)
      || row.payloadRefJson !== payloadRefJson
    ) {
      throw new Error(`Bot delivery idempotency conflict for ${idempotencyKey}`);
    }
    scheduleDrain(0);
    emitChanged(row.botId, row.id);
    return { id: row.id };
  };

  const recordUnknown = async (
    input: RecordUnknownBotDeliveryInput,
  ): Promise<{ id: string }> => {
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) throw new Error('Bot delivery idempotencyKey is required');
    const payloadRefJson = JSON.stringify(input.payload);
    if (Buffer.byteLength(payloadRefJson, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new Error(`Bot delivery payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    }
    const at = now();
    const id = createId();
    const deliveryReceiptJson = JSON.stringify({
      externalDispatch: {
        retrySafe: false,
        transport: input.transport.trim() || 'unknown',
        startedAt: at,
      },
      progress: input.progress ?? {},
    });
    const db = getDbClient().drizzle;
    await db
      .insert(botDeliveryOutbox)
      .values({
        id,
        botId: input.botId,
        channelId: input.channelId ?? null,
        routeId: input.routeId ?? null,
        sessionId: input.sessionId ?? null,
        idempotencyKey,
        payloadRefJson,
        ownerGeneration: input.ownerGeneration ?? 0,
        status: 'dead-letter',
        attempts: 1,
        nextAttemptAt: null,
        lastError: `${input.errorCode}: ${input.message}`.slice(0, 4_000),
        deliveryReceiptJson,
        createdAt: at,
        updatedAt: at,
        deliveredAt: null,
      })
      .onConflictDoNothing({ target: botDeliveryOutbox.idempotencyKey });
    const [row] = await db
      .select({
        id: botDeliveryOutbox.id,
        botId: botDeliveryOutbox.botId,
        channelId: botDeliveryOutbox.channelId,
        routeId: botDeliveryOutbox.routeId,
        sessionId: botDeliveryOutbox.sessionId,
        ownerGeneration: botDeliveryOutbox.ownerGeneration,
        payloadRefJson: botDeliveryOutbox.payloadRefJson,
      })
      .from(botDeliveryOutbox)
      .where(eq(botDeliveryOutbox.idempotencyKey, idempotencyKey))
      .limit(1);
    if (!row) throw new Error('Bot delivery recovery record failed');
    if (
      row.botId !== input.botId
      || row.channelId !== (input.channelId ?? null)
      || row.routeId !== (input.routeId ?? null)
      || row.sessionId !== (input.sessionId ?? null)
      || row.ownerGeneration !== (input.ownerGeneration ?? 0)
      || row.payloadRefJson !== payloadRefJson
    ) {
      throw new Error(`Bot delivery idempotency conflict for ${idempotencyKey}`);
    }
    emitChanged(row.botId, row.id);
    return { id: row.id };
  };

  const retry = async (
    id: string,
    botId: string,
    opts: { allowDuplicateRisk?: boolean } = {},
  ): Promise<{ id: string }> => {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select({
        id: botDeliveryOutbox.id,
        botId: botDeliveryOutbox.botId,
        routeId: botDeliveryOutbox.routeId,
        sessionId: botDeliveryOutbox.sessionId,
        ownerGeneration: botDeliveryOutbox.ownerGeneration,
        status: botDeliveryOutbox.status,
        deliveryReceiptJson: botDeliveryOutbox.deliveryReceiptJson,
      })
      .from(botDeliveryOutbox)
      .where(eq(botDeliveryOutbox.id, id))
      .limit(1);
    if (!row || row.botId !== botId) throw new Error('Bot delivery is unavailable');
    if (row.status === 'pending' || row.status === 'sending' || row.status === 'delivered') {
      return { id: row.id };
    }
    if (row.status !== 'failed' && row.status !== 'dead-letter') {
      throw new Error(`Bot delivery in status ${row.status} cannot be retried`);
    }
    const [profile] = await db
      .select({
        status: botProfiles.status,
      })
      .from(botProfiles)
      .where(eq(botProfiles.id, botId))
      .limit(1);
    if (!profile || profile.status !== 'active') {
      throw new Error('Restore the Bot before retrying this delivery');
    }
    const canonical = await resolveBotCanonicalSession(botId);
    const priorReceipt = parseReceipt(row.deliveryReceiptJson);
    const priorDispatch = priorReceipt.externalDispatch;
    const duplicateRisk = priorDispatch
      && typeof priorDispatch === 'object'
      && !Array.isArray(priorDispatch)
      && (priorDispatch as Record<string, unknown>).retrySafe === false;
    if (duplicateRisk && opts.allowDuplicateRisk !== true) {
      throw new Error(
        'Bot delivery may already be partially visible; explicit duplicate-risk confirmation is required',
      );
    }
    if (row.routeId) {
      const [route] = await db
        .select({
          botId: botRoutes.botId,
          currentSessionId: botRoutes.currentSessionId,
          ownerGeneration: botRoutes.ownerGeneration,
          status: botRoutes.status,
        })
        .from(botRoutes)
        .where(eq(botRoutes.id, row.routeId))
        .limit(1);
      if (!route || route.botId !== botId) throw new Error('Bot delivery route is unavailable');
      if (route.status !== 'active') {
        throw new Error(`Bot delivery route is ${route.status}`);
      }
      if (row.sessionId && route.currentSessionId !== row.sessionId) {
        throw new Error('Bot delivery route now points to a different task');
      }
      if (route.ownerGeneration !== row.ownerGeneration) {
        throw new Error('Bot delivery route ownership changed; create a new delivery instead');
      }
    } else if (
      row.sessionId
      && (canonical.status !== 'resolved' || canonical.sessionId !== row.sessionId)
    ) {
      throw new Error('Bot canonical task changed; create a new delivery instead');
    }
    const at = now();
    const [updated] = await db
      .update(botDeliveryOutbox)
      .set({
        status: 'pending',
        attempts: 0,
        nextAttemptAt: at,
        lastError: null,
        deliveryReceiptJson: null,
        deliveredAt: null,
        updatedAt: at,
      })
      .where(
        and(
          eq(botDeliveryOutbox.id, id),
          eq(botDeliveryOutbox.botId, botId),
          inArray(botDeliveryOutbox.status, ['failed', 'dead-letter']),
        ),
      )
      .returning({ id: botDeliveryOutbox.id });
    if (!updated) return retry(id, botId);
    scheduleDrain(0);
    emitChanged(botId, id);
    return updated;
  };

  const listForBot = async (botId: string, limit = 100): Promise<BotDeliveryView[]> => {
    const rows = await getDbClient()
      .drizzle.select({
        id: botDeliveryOutbox.id,
        botId: botDeliveryOutbox.botId,
        channelId: botDeliveryOutbox.channelId,
        channelKind: botChannels.kind,
        routeId: botDeliveryOutbox.routeId,
        routeKey: botRoutes.routeKey,
        routeStatus: botRoutes.status,
        sessionId: botDeliveryOutbox.sessionId,
        payloadRefJson: botDeliveryOutbox.payloadRefJson,
        ownerGeneration: botDeliveryOutbox.ownerGeneration,
        attempts: botDeliveryOutbox.attempts,
        status: botDeliveryOutbox.status,
        lastError: botDeliveryOutbox.lastError,
        deliveryReceiptJson: botDeliveryOutbox.deliveryReceiptJson,
        createdAt: botDeliveryOutbox.createdAt,
        updatedAt: botDeliveryOutbox.updatedAt,
        deliveredAt: botDeliveryOutbox.deliveredAt,
      })
      .from(botDeliveryOutbox)
      .leftJoin(botChannels, eq(botDeliveryOutbox.channelId, botChannels.id))
      .leftJoin(botRoutes, eq(botDeliveryOutbox.routeId, botRoutes.id))
      .where(eq(botDeliveryOutbox.botId, botId))
      .orderBy(desc(botDeliveryOutbox.updatedAt), desc(botDeliveryOutbox.createdAt))
      .limit(Math.min(500, Math.max(1, Math.floor(limit))));
    return rows.map((row) => ({
      id: row.id,
      botId: row.botId,
      channelId: row.channelId,
      channelKind: row.channelKind,
      routeId: row.routeId,
      routeKey: row.routeKey,
      routeStatus: row.routeStatus,
      sessionId: row.sessionId,
      payloadKind: parseEnvelope(row.payloadRefJson)?.kind ?? 'invalid',
      ownerGeneration: row.ownerGeneration,
      attempts: row.attempts,
      status: row.status,
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deliveredAt: row.deliveredAt,
      diagnostic: parseBotDeliveryDiagnostic(row.deliveryReceiptJson),
    }));
  };

  /**
   * Stop every non-terminal delivery owned by a paused Bot. A row that was
   * already claimed as `sending` may finish its adapter call, but its later
   * CAS write no longer matches and therefore cannot resurrect the row.
   */
  const suspendForBot = async (botId: string): Promise<number> => {
    const at = now();
    const rows = await getDbClient()
      .drizzle.update(botDeliveryOutbox)
      .set({
        status: 'suspended',
        nextAttemptAt: null,
        lastError: 'BOT_PAUSED: delivery is suspended until the Bot resumes',
        updatedAt: at,
      })
      .where(
        and(
          eq(botDeliveryOutbox.botId, botId),
          inArray(botDeliveryOutbox.status, ['pending', 'sending', 'failed']),
        ),
      )
      .returning({ id: botDeliveryOutbox.id });
    if (rows.length > 0) emitChanged(botId);
    return rows.length;
  };

  const resumeForBot = async (botId: string): Promise<number> => {
    const at = now();
    const db = getDbClient().drizzle;
    const suspended = await db
      .select({ id: botDeliveryOutbox.id, deliveryReceiptJson: botDeliveryOutbox.deliveryReceiptJson })
      .from(botDeliveryOutbox)
      .where(and(eq(botDeliveryOutbox.botId, botId), eq(botDeliveryOutbox.status, 'suspended')));
    const rows = [] as Array<{ id: string }>;
    for (const row of suspended) {
      const receipt = parseReceipt(row.deliveryReceiptJson);
      const dispatch = receipt.externalDispatch;
      const duplicateRisk = dispatch
        && typeof dispatch === 'object'
        && !Array.isArray(dispatch)
        && (dispatch as Record<string, unknown>).retrySafe === false;
      const [updated] = await db
        .update(botDeliveryOutbox)
        .set(duplicateRisk
          ? {
              status: 'dead-letter',
              nextAttemptAt: null,
              lastError:
                'DELIVERY_OUTCOME_UNKNOWN: Bot was paused after external dispatch; automatic retry was suppressed to prevent a duplicate',
              updatedAt: at,
            }
          : {
              status: 'pending',
              nextAttemptAt: at,
              lastError: null,
              updatedAt: at,
            })
        .where(and(eq(botDeliveryOutbox.id, row.id), eq(botDeliveryOutbox.status, 'suspended')))
        .returning({ id: botDeliveryOutbox.id });
      if (updated) rows.push(updated);
    }
    if (rows.length > 0) {
      scheduleDrain(0);
      emitChanged(botId);
    }
    return rows.length;
  };

  const cancelForBot = async (botId: string, reason: string): Promise<number> => {
    const at = now();
    const rows = await getDbClient()
      .drizzle.update(botDeliveryOutbox)
      .set({
        status: 'cancelled',
        nextAttemptAt: null,
        lastError: reason.slice(0, 4_000),
        deliveryReceiptJson: null,
        updatedAt: at,
        deliveredAt: null,
      })
      .where(
        and(
          eq(botDeliveryOutbox.botId, botId),
          inArray(botDeliveryOutbox.status, ['pending', 'sending', 'suspended', 'failed']),
        ),
      )
      .returning({ id: botDeliveryOutbox.id });
    return rows.length;
  };

  const restore = async (): Promise<void> => {
    const db = getDbClient().drizzle;
    const at = now();
    await requeueExpiredSending();
    const [leased] = await db
      .select({ updatedAt: botDeliveryOutbox.updatedAt })
      .from(botDeliveryOutbox)
      .where(eq(botDeliveryOutbox.status, 'sending'))
      .orderBy(asc(botDeliveryOutbox.updatedAt))
      .limit(1);
    if (leased) scheduleDrain(Math.max(0, leased.updatedAt + sendingLeaseMs - at));
    await drain();
  };

  const dispose = (): void => {
    disposed = true;
    clearTimer();
    clearRequeueTimer();
  };

  startRequeueSweeper();

  return {
    enqueue,
    recordUnknown,
    listForBot,
    retry,
    drain,
    restore,
    suspendForBot,
    resumeForBot,
    cancelForBot,
    dispose,
  };
}

export type BotDeliveryOutboxService = ReturnType<typeof createBotDeliveryOutboxService>;
