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

import { registerMessageIpc } from '../messages';

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
});
