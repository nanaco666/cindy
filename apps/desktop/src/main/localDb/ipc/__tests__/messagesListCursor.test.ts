import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { messages, sessions } from '../../schema';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../maker-host/codex-local-sessions', () => ({
  importExternalCodexMessagesForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../maker-host/claude-local-sessions', () => ({
  importExternalClaudeCodeMessagesForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../embedders/chat-history-embedder', () => ({
  onMessageCreated: vi.fn(async () => undefined),
}));
vi.mock('../../client/current', () => ({
  getDbClient: () => ({ drizzle: h.db }),
}));

import { readPriorUserRoundCost, registerMessageIpc } from '../messages';

function createDb(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cleared_at INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_use_id TEXT,
      agent_meta TEXT,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    );
  `);
  h.db = drizzle(sqlite, { schema: { messages, sessions } });
  return sqlite;
}

function insertMessage(sqlite: Database.Database, input: { id: string; createdAt: number; content: string }): void {
  sqlite
    .prepare(`
      INSERT INTO messages (
        id, client_id, session_id, role, content, tool_use_id, agent_meta, created_at, rewind_at
      ) VALUES (
        @id, @clientId, 's1', 'assistant', @content, NULL, NULL, @createdAt, NULL
      )
    `)
    .run({
      id: input.id,
      clientId: input.id,
      content: JSON.stringify(input.content),
      createdAt: input.createdAt,
    });
}

function insertCostMessage(
  sqlite: Database.Database,
  input: {
    id: string;
    role: 'user' | 'assistant';
    createdAt: number;
    agentMeta?: Record<string, unknown>;
    rewindAt?: number | null;
  },
): void {
  sqlite
    .prepare(`
      INSERT INTO messages (
        id, client_id, session_id, role, content, tool_use_id, agent_meta, created_at, rewind_at
      ) VALUES (
        @id, @id, 's1', @role, '""', NULL, @agentMeta, @createdAt, @rewindAt
      )
    `)
    .run({
      ...input,
      agentMeta: input.agentMeta ? JSON.stringify(input.agentMeta) : null,
      rewindAt: input.rewindAt ?? null,
    });
}

describe('local-db:messages:list cursor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.handlers.clear();
  });

  it('continues through rows with the same timestamp using insertion order', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    insertMessage(sqlite, { id: 'row-z', createdAt: 1_000, content: 'same timestamp oldest' });
    insertMessage(sqlite, { id: 'row-a', createdAt: 1_000, content: 'same timestamp cursor' });
    insertMessage(sqlite, { id: 'row-m', createdAt: 1_000, content: 'same timestamp newest' });
    insertMessage(sqlite, { id: 'row-old', createdAt: 999, content: 'older row' });

    registerMessageIpc();
    const listHandler = h.handlers.get('local-db:messages:list');
    expect(listHandler).toBeTypeOf('function');

    const rows = await listHandler?.({}, 's1', { limit: 10, before: 'row-a' });

    expect((rows as Array<{ id: string; content: string }>).map((row) => row.id)).toEqual([
      'row-z',
      'row-old',
    ]);
    expect((rows as Array<{ id: string; rowid: number }>).map((row) => row.rowid)).toEqual([
      1,
      4,
    ]);
  });

  it('keeps around windows stable for same timestamp rows', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    insertMessage(sqlite, { id: 'row-z', createdAt: 1_000, content: 'same timestamp oldest' });
    insertMessage(sqlite, { id: 'row-a', createdAt: 1_000, content: 'same timestamp cursor' });
    insertMessage(sqlite, { id: 'row-m', createdAt: 1_000, content: 'same timestamp newest' });

    registerMessageIpc();
    const aroundHandler = h.handlers.get('local-db:messages:around');
    expect(aroundHandler).toBeTypeOf('function');

    const rows = await aroundHandler?.({}, 's1', 'row-a', { radius: 1 });

    expect((rows as Array<{ id: string; content: string }>).map((row) => row.id)).toEqual([
      'row-z',
      'row-a',
      'row-m',
    ]);
    expect((rows as Array<{ id: string; rowid: number }>).map((row) => row.rowid)).toEqual([
      1,
      2,
      3,
    ]);
  });

  it('keeps around-client-id windows stable for same timestamp rows', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    insertMessage(sqlite, { id: 'row-z', createdAt: 1_000, content: 'same timestamp oldest' });
    insertMessage(sqlite, { id: 'row-a', createdAt: 1_000, content: 'same timestamp cursor' });
    insertMessage(sqlite, { id: 'row-m', createdAt: 1_000, content: 'same timestamp newest' });

    registerMessageIpc();
    const aroundClientIdHandler = h.handlers.get('local-db:messages:around-client-id');
    expect(aroundClientIdHandler).toBeTypeOf('function');

    const rows = await aroundClientIdHandler?.({}, 's1', 'row-a', { radius: 1 });

    expect((rows as Array<{ id: string; content: string }>).map((row) => row.id)).toEqual([
      'row-z',
      'row-a',
      'row-m',
    ]);
    expect((rows as Array<{ id: string; rowid: number }>).map((row) => row.rowid)).toEqual([
      1,
      2,
      3,
    ]);
  });

  it('历史消息读取时投影完整用户轮成本，但不回写原始分段', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    insertCostMessage(sqlite, { id: 'user', role: 'user', createdAt: 1_000 });
    insertCostMessage(sqlite, {
      id: 'segment-1',
      role: 'assistant',
      createdAt: 1_100,
      agentMeta: { turnCostUsd: 14.801987 },
    });
    insertCostMessage(sqlite, {
      id: 'segment-2',
      role: 'assistant',
      createdAt: 1_200,
      agentMeta: { turnCostUsd: 4.132204 },
    });
    insertCostMessage(sqlite, {
      id: 'segment-3',
      role: 'assistant',
      createdAt: 1_300,
      agentMeta: { turnCostUsd: 32.517991 },
    });
    insertCostMessage(sqlite, {
      id: 'final',
      role: 'assistant',
      createdAt: 1_400,
      agentMeta: { turnCostUsd: 0.777042 },
    });

    registerMessageIpc();
    const listHandler = h.handlers.get('local-db:messages:list');
    const rows = await listHandler?.({}, 's1', { limit: 10 }) as Array<{
      id: string;
      agentMeta: Record<string, unknown> | null;
    }>;
    const final = rows.find((row) => row.id === 'final');
    expect(final?.agentMeta).toMatchObject({
      turnCostUsd: 0.777042,
      userTurnCostUsd: 52.229224,
      userTurnCostIsEstimate: false,
    });
    const stored = sqlite.prepare('SELECT agent_meta FROM messages WHERE id = ?').get('final') as { agent_meta: string };
    expect(JSON.parse(stored.agent_meta)).toEqual({
      turnCostUsd: 0.777042,
    });
  });
});

describe('readPriorUserRoundCost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('跨多个 SDK done 累计真实用户轮，跳过 autoResume，并以 rowid 处理同毫秒消息', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    insertCostMessage(sqlite, { id: 'user', role: 'user', createdAt: 1_000 });
    insertCostMessage(sqlite, {
      id: 'segment-1',
      role: 'assistant',
      createdAt: 1_100,
      agentMeta: { turnCostUsd: 14.801987 },
    });
    insertCostMessage(sqlite, {
      id: 'auto-resume',
      role: 'user',
      createdAt: 1_200,
      agentMeta: { autoResume: true },
    });
    insertCostMessage(sqlite, {
      id: 'segment-2',
      role: 'assistant',
      createdAt: 1_300,
      agentMeta: { turnCostUsd: 4.132204, turnCostIsEstimate: true },
    });
    // target 与上一个分段同毫秒，必须靠 rowid 排除 target 本身。
    insertCostMessage(sqlite, { id: 'target', role: 'assistant', createdAt: 1_300 });

    await expect(readPriorUserRoundCost('s1', 'target')).resolves.toEqual({
      costUsd: 18.934191,
      hasEstimatedValue: true,
    });
  });

  it('忽略 /clear 前和 rewind 的分段', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, ?)').run('s1', 1_000);
    insertCostMessage(sqlite, { id: 'old-user', role: 'user', createdAt: 900 });
    insertCostMessage(sqlite, {
      id: 'old-segment',
      role: 'assistant',
      createdAt: 950,
      agentMeta: { turnCostUsd: 99 },
    });
    insertCostMessage(sqlite, { id: 'user', role: 'user', createdAt: 1_100 });
    insertCostMessage(sqlite, {
      id: 'visible-segment',
      role: 'assistant',
      createdAt: 1_200,
      agentMeta: { turnCostUsd: 0.5 },
    });
    insertCostMessage(sqlite, {
      id: 'rewound-segment',
      role: 'assistant',
      createdAt: 1_300,
      agentMeta: { turnCostUsd: 10 },
      rewindAt: 1_400,
    });
    insertCostMessage(sqlite, { id: 'target', role: 'assistant', createdAt: 1_500 });

    await expect(readPriorUserRoundCost('s1', 'target')).resolves.toEqual({
      costUsd: 0.5,
      hasEstimatedValue: false,
    });
  });
});
