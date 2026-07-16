/**
 * chat-data-localization F4：迁移协调器（main 进程主导）。
 *
 * 流：
 *   start(totals)
 *     → setStatus('in_progress') + 持久化 totals 快照
 *     → loop:
 *         GET /api/sessions/_migration/page?after=&limit=10  (deviceId 由 JWT.device 强制带入)
 *         单页失败 → 1s/2s/4s × 3 次指数退避；全失败 → batchAttempts++
 *         批级累计 ≥ 3 → emit 'failed' 退出 loop
 *         单页成功 → 单事务写 sessions + messages → emit 'running' progress
 *         hasMore=false → break
 *     → POST /api/sessions/_migration/done {deviceName: os.hostname()}
 *     → setStatus('done') + emit 'done'
 *
 * abort()：用户跳过路径触发；loop 检测到 _aborted 立即退出。
 * resume()：等同 start，但不重置 totals/synced 计数（migration_meta 已持有）。
 */

import os from 'node:os';

import { getDbClient } from './client/current';
import { serverApiFetch, ServerApiError } from '../serverApiClient';
import { emitMigrationProgress } from './ipc/migration';

import { createLogger } from '../logger';

const log = createLogger('migrationCoordinator');

const SINGLE_PAGE_DELAYS_MS = [1000, 2000, 4000] as const;
const BATCH_HARD_LIMIT = 3;
const PAGE_LIMIT = 10;

type ProgressPhase =
  | { phase: 'idle' }
  | { phase: 'running'; synced: number; total: number; etaSeconds: number | null }
  | {
      phase: 'retrying';
      synced: number;
      total: number;
      attempt: number;
      nextDelayMs: number;
    }
  | { phase: 'failed'; synced: number; total: number; batchAttempts: number }
  | { phase: 'done'; synced: number; total: number };

interface RawPage {
  sessions: Array<{
    id: string;
    title: string;
    workingDir: string | null;
    model: string;
    effort: string;
    permissionMode: string;
    status: string;
    sdkSessionId: string | null;
    totalTokenUsage: number;
    totalCostUsd: number;
    contextTokens: number;
    contextWindow: number;
    fastMode: boolean;
    clearedAt: string | null;
    pinnedAt: string | null;
    createdAt: string;
    updatedAt: string;
    messages: Array<{
      id: string;
      clientId: string;
      sessionId: string;
      role: string;
      content: unknown;
      toolUseId: string | null;
      createdAt: string;
    }>;
  }>;
  nextAfter: string | null;
  hasMore: boolean;
}

let _aborted = false;
let _running = false;
let _batchAttempts = 0;
let _recentSyncedDeltas: Array<{ ts: number; delta: number }> = [];

export const migrationCoordinator = {
  async start(): Promise<void> {
    if (_running) return;
    _aborted = false;
    _batchAttempts = 0;
    _recentSyncedDeltas = [];
    _running = true;
    try {
      await runLoop();
    } finally {
      _running = false;
    }
  },

  async resume(): Promise<void> {
    if (_running) return;
    _aborted = false;
    _batchAttempts = 0;
    _running = true;
    try {
      await runLoop();
    } finally {
      _running = false;
    }
  },

  abort(): void {
    _aborted = true;
  },

  isRunning(): boolean {
    return _running;
  },

  /**
   * 标记完成：内部调 POST /_migration/done → setStatus('done') → emit 'done'。
   *
   * 服务端按 JWT.device claim 强制按切片软删 + ChatMigrationStatus upsert。
   * 客户端不传 deviceId。
   */
  async markDone(deviceName: string): Promise<{ ok: true; alreadyMigrated?: boolean }> {
    let resp: { ok: true; alreadyMigrated?: boolean };
    try {
      resp = await serverApiFetch<{ ok: true; alreadyMigrated?: boolean }>(
        '/api/sessions/_migration/done',
        { method: 'POST', body: { deviceName } },
      );
    } catch (err) {
      // 409 ALREADY_MIGRATED 等同成功
      if (err instanceof ServerApiError && err.code === 'ALREADY_MIGRATED') {
        resp = { ok: true, alreadyMigrated: true };
      } else {
        throw err;
      }
    }
    await writeMeta('cloud_migration_status', 'done');
    emitMigrationProgress({
      phase: 'done',
      synced: await getSynced(),
      total: await getTotal(),
    });
    return resp;
  },
};

async function runLoop(): Promise<void> {
  while (!_aborted) {
    const after = (await readMeta('cloud_migration_last_session_id')) ?? '';
    const ok = await pullPageWithRetry(after);
    if (_aborted) return;
    if (!ok) {
      _batchAttempts += 1;
      if (_batchAttempts >= BATCH_HARD_LIMIT) {
        emitMigrationProgress({
          phase: 'failed',
          synced: await getSynced(),
          total: await getTotal(),
          batchAttempts: _batchAttempts,
        });
        return; // 等用户决策（重试 / 跳过）
      }
      // 没退出 → 下一轮 while 直接重试同一 cursor
      continue;
    }

    const hasMore = await readMeta('cloud_migration_has_more');
    if (hasMore !== '1') break;
  }

  if (_aborted) return;

  // 拉完所有页 → markDone
  try {
    await migrationCoordinator.markDone(os.hostname());
  } catch (err) {
    log.error('markDone failed', err);
    emitMigrationProgress({
      phase: 'failed',
      synced: await getSynced(),
      total: await getTotal(),
      batchAttempts: _batchAttempts,
    });
  }
}

async function pullPageWithRetry(after: string): Promise<boolean> {
  const totalAttempts = SINGLE_PAGE_DELAYS_MS.length + 1; // 首次 + 3 次重试
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    if (_aborted) return false;
    try {
      const cursorParam = after ? `&after=${encodeURIComponent(after)}` : '';
      const resp = await serverApiFetch<RawPage>(
        `/api/sessions/_migration/page?limit=${PAGE_LIMIT}${cursorParam}`,
      );
      await writePageToDb(resp);
      _batchAttempts = 0; // 单页成功 → 重置批级计数（防偶发抖动消耗预算）
      await emitProgress();
      return true;
    } catch (err) {
      // 401 已被 serverApiFetch 内部 refresh 一次；如果还失败就走重试逻辑
      const isLastTry = attempt === totalAttempts - 1;
      if (isLastTry) {
        log.error(
          'page pull exhausted retries',
          err,
        );
        return false;
      }
      const delay = SINGLE_PAGE_DELAYS_MS[attempt];
      emitMigrationProgress({
        phase: 'retrying',
        synced: await getSynced(),
        total: await getTotal(),
        attempt: attempt + 1,
        nextDelayMs: delay,
      });
      await sleep(delay);
    }
  }
  return false;
}

async function writePageToDb(resp: RawPage): Promise<void> {
  await getDbClient().tx('migration.writePage', resp);
  recordRecentDelta(resp.sessions.length);
}

async function emitProgress(): Promise<void> {
  const synced = await getSynced();
  const total = await getTotal();
  const eta = estimateEtaSeconds(synced, total);
  emitMigrationProgress({
    phase: 'running',
    synced,
    total,
    etaSeconds: eta,
  });
}

function estimateEtaSeconds(synced: number, total: number): number | null {
  // 基于近 30 秒平均速度
  const cutoff = Date.now() - 30_000;
  const recent = _recentSyncedDeltas.filter((d) => d.ts >= cutoff);
  if (recent.length === 0) return null;
  const totalDelta = recent.reduce((a, b) => a + b.delta, 0);
  const speedPerSec = totalDelta / 30;
  if (speedPerSec <= 0) return null;
  const remaining = Math.max(total - synced, 0);
  return Math.ceil(remaining / speedPerSec);
}

function recordRecentDelta(delta: number): void {
  _recentSyncedDeltas.push({ ts: Date.now(), delta });
  const cutoff = Date.now() - 60_000;
  _recentSyncedDeltas = _recentSyncedDeltas.filter((d) => d.ts >= cutoff);
}

// ===== migration_meta 读写工具 =====

export async function readMeta(key: string): Promise<string | null> {
  const row = await getDbClient().queryOne<{ value: string | null }>(
    `SELECT value FROM migration_meta WHERE key=?`,
    [key],
  );
  return row?.value ?? null;
}

export async function writeMeta(key: string, value: string): Promise<void> {
  await getDbClient().exec(
    `INSERT INTO migration_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    [key, value],
  );
}

async function getSynced(): Promise<number> {
  return parseInt((await readMeta('cloud_migration_synced')) ?? '0', 10) || 0;
}

async function getTotal(): Promise<number> {
  return parseInt((await readMeta('cloud_migration_total_sessions')) ?? '0', 10) || 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type { ProgressPhase };
