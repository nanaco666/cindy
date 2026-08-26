import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { botDeliveryOutbox } from '../../localDb/schema';
import {
  createBotDeliveryOutboxService,
  type BotDeliveryAttemptResult,
} from '../botDeliveryOutboxService';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  sqlite: null as Database.Database | null,
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({ drizzle: h.db }),
}));
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }),
}));
vi.mock('../botCanonicalSessionRegistry.js', () => ({
  resolveBotCanonicalSession: vi.fn(async () => ({ status: 'missing', sessionId: null })),
}));
vi.mock('../botAttentionService.js', () => ({
  noteBotAttention: vi.fn(async () => undefined),
  clearBotAttention: vi.fn(async () => undefined),
}));

function readRow(id: string): { status: string; attempts: number; lastError: string | null } {
  const row = h.sqlite!
    .prepare(
      'SELECT status, attempts, last_error AS lastError FROM bot_delivery_outbox WHERE id = ?',
    )
    .get(id) as { status: string; attempts: number; lastError: string | null } | undefined;
  if (!row) throw new Error(`delivery row ${id} not found`);
  return row;
}

const sessionPayload = (n: number): { version: 1; kind: string; targetSessionId: string } => ({
  version: 1,
  kind: 'session-message',
  targetSessionId: `target-${n}`,
});

describe('botDeliveryOutboxService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE bot_delivery_outbox (
        id TEXT PRIMARY KEY NOT NULL,
        bot_id TEXT NOT NULL,
        channel_id TEXT,
        route_id TEXT,
        session_id TEXT,
        idempotency_key TEXT NOT NULL,
        payload_ref_json TEXT DEFAULT '{}' NOT NULL,
        owner_generation INTEGER DEFAULT 0 NOT NULL,
        status TEXT DEFAULT 'pending' NOT NULL,
        attempts INTEGER DEFAULT 0 NOT NULL,
        next_attempt_at INTEGER,
        last_error TEXT,
        delivery_receipt_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER
      );
      CREATE UNIQUE INDEX uniq_bot_delivery_outbox_idempotency
        ON bot_delivery_outbox(idempotency_key);
    `);
    h.sqlite = sqlite;
    h.db = drizzle(sqlite, { schema: { botDeliveryOutbox } });
  });

  afterEach(() => {
    vi.useRealTimers();
    h.sqlite?.close();
    h.sqlite = null;
    h.db = null;
  });

  const baseDeps = {
    noteAttention: async () => ({ reason: null, changed: false }),
    clearAttention: async () => ({ reason: null, changed: false }),
  };

  it('fails a timed-out deliver and keeps draining later rows', async () => {
    let clock = 10_000;
    let seq = 0;
    // 第一棒的适配器永不 settle:修复前它会把串行 drain 循环整个钉死,
    // 后续投递(包括其它 Bot 的)一起被饿死 —— PR #2829 QA 缺陷 A 的形状。
    const deliver = vi.fn(async (): Promise<BotDeliveryAttemptResult> => ({ ok: true }));
    deliver.mockImplementationOnce(() => new Promise<BotDeliveryAttemptResult>(() => {}));
    const service = createBotDeliveryOutboxService({
      ...baseDeps,
      deliver,
      now: () => clock,
      createId: () => `id-${++seq}`,
      deliverTimeoutMs: 1_000,
    });
    try {
      const first = await service.enqueue({
        botId: 'bot-1',
        idempotencyKey: 'k1',
        sessionId: 's1',
        payload: sessionPayload(1),
      });
      clock += 10;
      const second = await service.enqueue({
        botId: 'bot-2',
        idempotencyKey: 'k2',
        sessionId: 's2',
        payload: sessionPayload(2),
      });
      clock += 1_000;
      // enqueue 的 scheduleDrain(0) 与 1s watchdog 都在窗口内触发;
      // 重试 backoff(attempt 1 → +1s)落在窗口外,attempts 保持 1。
      await vi.advanceTimersByTimeAsync(1_010);

      expect(readRow(first.id)).toMatchObject({
        status: 'failed',
        attempts: 1,
      });
      expect(readRow(first.id).lastError).toContain('DELIVERY_TIMEOUT');
      expect(readRow(second.id)).toMatchObject({ status: 'delivered', attempts: 1 });
      expect(deliver).toHaveBeenCalledTimes(2);
    } finally {
      service.dispose();
    }
  });

  it('reclaims an expired sending lease even while the drain loop is stuck', async () => {
    let clock = 10_000;
    let seq = 0;
    const deliver = vi.fn(
      async () => new Promise<BotDeliveryAttemptResult>(() => {}),
    );
    // deliverTimeoutMs 远大于 lease:适配器挂起时 drain 循环本身卡死,
    // 只有独立的 lease sweeper 还能回收 —— 验证回收与 drain 活性解耦。
    const service = createBotDeliveryOutboxService({
      ...baseDeps,
      deliver,
      now: () => clock,
      createId: () => `id-${++seq}`,
      sendingLeaseMs: 2_000,
      deliverTimeoutMs: 600_000,
    });
    try {
      const { id } = await service.enqueue({
        botId: 'bot-1',
        idempotencyKey: 'k1',
        sessionId: 's1',
        payload: sessionPayload(1),
      });
      // 触发 drain(claim → sending),但绝不推进 600s watchdog。
      await vi.advanceTimersByTimeAsync(1);
      expect(readRow(id)).toMatchObject({ status: 'sending', attempts: 1 });
      expect(deliver).toHaveBeenCalledTimes(1);

      clock += 2_100;
      // sweeper 间隔 = max(1s, sendingLeaseMs/2 = 1s),在窗口内触发。
      await vi.advanceTimersByTimeAsync(2_100);

      // drain 循环仍挂在 deliver 上,但 2s lease 已被独立 sweeper 回收。
      expect(readRow(id)).toMatchObject({ status: 'failed', attempts: 1 });
      expect(deliver).toHaveBeenCalledTimes(1);
    } finally {
      service.dispose();
    }
  });

  it('converts a timed-out local-adapter dispatch into a dead letter', async () => {
    let clock = 10_000;
    let seq = 0;
    const deliver = vi.fn(
      async (
        _row: unknown,
        _payload: unknown,
        attempt: {
          recordExternalDispatch(input: { retrySafe: boolean; transport: string }): Promise<void>;
        },
      ) => {
        // 本地适配器已跨进程边界,重投可能产生用户可见的重复消息:
        // 超时后必须落 dead-letter 而不是自动重试。
        await attempt.recordExternalDispatch({ retrySafe: false, transport: 'local-adapter' });
        return new Promise<BotDeliveryAttemptResult>(() => {});
      },
    );
    const service = createBotDeliveryOutboxService({
      ...baseDeps,
      deliver,
      now: () => clock,
      createId: () => `id-${++seq}`,
      deliverTimeoutMs: 1_000,
    });
    try {
      const { id } = await service.enqueue({
        botId: 'bot-1',
        idempotencyKey: 'k1',
        sessionId: 's1',
        payload: sessionPayload(1),
      });
      clock += 1_000;
      await vi.advanceTimersByTimeAsync(1_010);

      expect(readRow(id)).toMatchObject({ status: 'dead-letter', attempts: 1 });
      expect(readRow(id).lastError).toContain('DELIVERY_OUTCOME_UNKNOWN');
      expect(deliver).toHaveBeenCalledTimes(1);
    } finally {
      service.dispose();
    }
  });
});
