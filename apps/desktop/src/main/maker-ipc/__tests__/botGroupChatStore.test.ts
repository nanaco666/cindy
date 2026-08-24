import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  sqlite: null as Database.Database | null,
  tx: null as null | ((name: string, args: unknown) => Promise<unknown>),
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    drizzle: h.db,
    query: async (sql: string, params: unknown[] = []) => h.sqlite!.prepare(sql).all(...params),
    queryOne: async (sql: string, params: unknown[] = []) => h.sqlite!.prepare(sql).get(...params),
    exec: async (sql: string, params: unknown[] = []) => h.sqlite!.prepare(sql).run(...params),
    tx: h.tx,
  }),
}));
vi.mock('../../localDb/ipc/messages.js', () => ({
  createMessage: vi.fn(async (sessionId: string, body: {
    clientId: string;
    role: string;
    content: unknown;
    agentMeta?: unknown;
    createdAt?: number;
  }) => {
    const id = `message:${body.clientId}`;
    h.sqlite!.prepare(`INSERT OR IGNORE INTO messages
      (id, client_id, session_id, role, content, agent_meta, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, body.clientId, sessionId, body.role, JSON.stringify(body.content),
        body.agentMeta === undefined ? null : JSON.stringify(body.agentMeta), body.createdAt ?? 1000);
    return { id, clientId: body.clientId, sessionId, role: body.role, content: body.content };
  }),
}));

import { createBotGroupChatStore } from '../botGroupChatStore';
import { tx as runWorkerTx } from '../../localDb/worker/opHandlers/tx';

function createDb(): void {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL DEFAULT 'New Maker',
      working_dir TEXT,
      workspace_kind TEXT NOT NULL DEFAULT 'project',
      model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
      effort TEXT NOT NULL DEFAULT 'high',
      permission_mode TEXT NOT NULL DEFAULT 'ask',
      status TEXT NOT NULL DEFAULT 'active',
      sdk_session_id TEXT,
      total_token_usage INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      context_tokens INTEGER NOT NULL DEFAULT 0,
      context_window INTEGER NOT NULL DEFAULT 0,
      fast_mode INTEGER NOT NULL DEFAULT 0,
      plan_mode_enabled INTEGER NOT NULL DEFAULT 0,
      cleared_at INTEGER,
      pinned_at INTEGER,
      user_send_at INTEGER,
      agent_kind TEXT NOT NULL DEFAULT 'cc',
      orca_role TEXT,
      parent_session_id TEXT,
      forked_at_message_id TEXT,
      worktree_path TEXT,
      extra_dirs TEXT NOT NULL DEFAULT '[]',
      remote_host_id TEXT,
      provider_id TEXT,
      source TEXT NOT NULL DEFAULT 'desktop',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY NOT NULL,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      agent_meta TEXT,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    );
    CREATE UNIQUE INDEX uniq_messages_session_client ON messages(session_id, client_id);
    CREATE TABLE bot_profiles (
      id TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      hidden_at INTEGER,
      pinned_at INTEGER,
      attention_reason TEXT,
      attention_at INTEGER,
      current_version INTEGER NOT NULL DEFAULT 1,
      canonical_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE bot_session_links (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      profile_version INTEGER NOT NULL DEFAULT 1,
      role TEXT NOT NULL,
      channel_id TEXT,
      route_key TEXT,
      created_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE UNIQUE INDEX uniq_bot_session_links_session ON bot_session_links(session_id);
    CREATE UNIQUE INDEX uniq_bot_session_links_canonical_per_bot
      ON bot_session_links(bot_id) WHERE role = 'canonical';
    CREATE TABLE bot_group_rooms (
      id TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      avatar TEXT NOT NULL DEFAULT '👥',
      room_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active',
      epoch INTEGER NOT NULL DEFAULT 0,
      running INTEGER NOT NULL DEFAULT 0,
      needs_user INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE bot_group_members (
      id TEXT PRIMARY KEY NOT NULL,
      room_id TEXT NOT NULL REFERENCES bot_group_rooms(id) ON DELETE CASCADE,
      bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      member_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      roster_order INTEGER NOT NULL,
      watermark INTEGER NOT NULL DEFAULT 0,
      hold_at INTEGER,
      hold_message_id TEXT,
      hold_thread_id TEXT,
      hold_noted INTEGER NOT NULL DEFAULT 0,
      stranded_before_sequence INTEGER,
      stranded_thread_id TEXT,
      stranded_started_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(room_id, bot_id),
      UNIQUE(room_id, roster_order)
    );
    CREATE TABLE bot_group_member_watermarks (
      id TEXT PRIMARY KEY NOT NULL,
      room_id TEXT NOT NULL REFERENCES bot_group_rooms(id) ON DELETE CASCADE,
      bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      sequence INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(room_id, bot_id, thread_id)
    );
  `);
  h.sqlite = sqlite;
  h.db = drizzle(sqlite);
  h.tx = async (name, args) => runWorkerTx(sqlite, { name, args });
}

function seedBot(id: string, name: string, sessionId: string): void {
  h.sqlite!.prepare(`INSERT INTO bot_profiles
    (id, display_name, status, current_version, canonical_session_id, created_at, updated_at)
    VALUES (?, ?, 'active', 2, ?, 1, 1)`).run(id, name, sessionId);
  h.sqlite!.prepare(`INSERT INTO sessions
    (id, title, working_dir, workspace_kind, model, effort, permission_mode, status,
     fast_mode, plan_mode_enabled, agent_kind, extra_dirs, remote_host_id, provider_id,
     source, created_at, updated_at)
    VALUES (?, ?, ?, 'project', ?, 'high', 'ask', 'active', 0, 0, 'cc', '[]', NULL,
      'anthropic', 'bot', 1, 1)`)
    .run(sessionId, `${name} Chat`, `/repo/${id}`, 'claude-sonnet-4-6');
  h.sqlite!.prepare(`INSERT INTO bot_session_links
    (id, bot_id, session_id, profile_version, role, created_at)
    VALUES (?, ?, ?, 2, 'canonical', 1)`).run(`link:${id}`, id, sessionId);
}

describe('botGroupChatStore', () => {
  beforeEach(() => {
    h.sqlite?.close();
    createDb();
    seedBot('bot-a', 'Alpha', 'canonical-a');
    seedBot('bot-b', 'Beta', 'canonical-b');
  });

  it('atomically creates one real room task and one real member task per Bot', async () => {
    let n = 0;
    const store = createBotGroupChatStore({
      createId: () => `generated-${++n}`,
      now: () => 100,
      ensureDialogueWorkspaceDir: (sessionId) => `/dialogues/${sessionId}`,
    });

    const room = await store.createRoom({
      id: 'room-1',
      name: 'Release room',
      memberBotIds: ['bot-a', 'bot-b'],
    });

    expect(room.roomSessionId).toBe('generated-1');
    expect(room.members.map((member) => [member.botId, member.sessionId])).toEqual([
      ['bot-a', 'generated-2'],
      ['bot-b', 'generated-4'],
    ]);
    expect(h.sqlite!.prepare(`SELECT id, source, title FROM sessions ORDER BY created_at, id`).all())
      .toEqual(expect.arrayContaining([
        { id: 'generated-1', source: 'bot', title: 'Group: Release room' },
        { id: 'generated-2', source: 'bot', title: 'Group: room-1' },
        { id: 'generated-4', source: 'bot', title: 'Group: room-1' },
      ]));
    expect(h.sqlite!.prepare(`SELECT bot_id AS botId, session_id AS sessionId, role
      FROM bot_session_links WHERE role = 'group' ORDER BY bot_id`).all()).toEqual([
      { botId: 'bot-a', sessionId: 'generated-2', role: 'group' },
      { botId: 'bot-b', sessionId: 'generated-4', role: 'group' },
    ]);
  });

  it('stores room transcript only in Cindy messages and persists watermark/epoch state', async () => {
    let n = 0;
    const store = createBotGroupChatStore({
      createId: () => `id-${++n}`,
      now: () => 200,
      ensureDialogueWorkspaceDir: (sessionId) => `/dialogues/${sessionId}`,
    });
    await store.createRoom({ id: 'room-2', name: 'Ops', memberBotIds: ['bot-a', 'bot-b'] });

    const first = await store.appendMessage(
      'room-2',
      { kind: 'user', name: 'You' },
      'Start',
      'thread-a',
    );
    const second = await store.appendMessage(
      'room-2',
      { kind: 'bot', botId: 'bot-a', name: 'Alpha' },
      'Working on it',
      'thread-a',
    );
    await store.advanceWatermark('room-2', 'bot-a', 'thread-a', second.sequence);
    expect(await store.bumpEpoch('room-2')).toBe(1);
    await store.setNeedsUser('room-2', true);

    expect((await store.listMessagesAfter('room-2', 'thread-a', first.sequence)).map((item) => item.text))
      .toEqual(['Working on it']);
    expect((await store.loadRoom('room-2'))?.members.find((item) => item.botId === 'bot-a')?.watermarks['thread-a'])
      .toBe(second.sequence);
    expect(h.sqlite!.prepare('SELECT epoch, needs_user AS needsUser FROM bot_group_rooms WHERE id = ?')
      .get('room-2')).toEqual({ epoch: 1, needsUser: 1 });
    expect(h.sqlite!.prepare(`SELECT COUNT(*) AS count FROM messages`).get()).toEqual({ count: 2 });
    expect(h.sqlite!.prepare(`PRAGMA table_info('bot_group_rooms')`).all()
      .map((row) => (row as { name: string }).name)).not.toContain('transcript');
  });

  it('persists attachment metadata in the real room message and reads it back without base64', async () => {
    let n = 0;
    const store = createBotGroupChatStore({
      createId: () => `attachment-${++n}`,
      now: () => 250,
      ensureDialogueWorkspaceDir: (sessionId) => `/dialogues/${sessionId}`,
    });
    await store.createRoom({ id: 'room-files', name: 'Files', memberBotIds: ['bot-a', 'bot-b'] });
    const files = [
      { id: 'image-1', name: 'diagram.png', originalName: 'diagram.png', path: '/tmp/diagram.png', ext: 'png', size: 10, category: 'image' as const, mimeType: 'image/png', url: 'file:///tmp/diagram.png', base64: 'must-not-persist' },
      { id: 'pdf-1', name: 'brief.pdf', path: '/tmp/brief.pdf', ext: 'pdf', size: 20, category: 'pdf' as const, mimeType: 'application/pdf' },
      { id: 'text-1', name: 'notes.txt', path: '/tmp/notes.txt', ext: 'txt', size: 30, category: 'text' as const, mimeType: 'text/plain' },
    ];

    const created = await store.appendMessage(
      'room-files',
      { kind: 'user', name: 'You' },
      'Review these',
      'thread-files',
      { files },
    );
    const [readBack] = await store.listMessagesAfter('room-files', 'thread-files', 0);
    const raw = h.sqlite!.prepare('SELECT content FROM messages WHERE id = ?').get(created.id) as { content: string };

    expect(readBack?.files).toEqual(files.map(({ base64: _base64, ...file }) => file));
    expect(raw.content).not.toContain('must-not-persist');
    expect(raw.content).toContain('diagram.png');
    expect(raw.content).toContain('brief.pdf');
    expect(raw.content).toContain('notes.txt');
  });

  it('keeps an attachment-only real room message visible to member Sessions', async () => {
    let n = 0;
    const store = createBotGroupChatStore({
      createId: () => `attachment-only-${++n}`,
      now: () => 275,
      ensureDialogueWorkspaceDir: (sessionId) => `/dialogues/${sessionId}`,
    });
    await store.createRoom({
      id: 'room-attachment-only',
      name: 'Attachment only',
      memberBotIds: ['bot-a', 'bot-b'],
    });
    const files = [{
      id: 'image-only',
      name: 'screen.png',
      path: '/tmp/screen.png',
      ext: 'png',
      size: 10,
      category: 'image' as const,
      mimeType: 'image/png',
    }];

    await store.appendMessage(
      'room-attachment-only',
      { kind: 'user', name: 'You' },
      '',
      'thread-attachment-only',
      { files },
    );

    expect(await store.listMessagesAfter(
      'room-attachment-only',
      'thread-attachment-only',
      0,
    )).toEqual([
      expect.objectContaining({ text: '', files }),
    ]);
  });

  it('fails closed without partial rows when a member has no active canonical link', async () => {
    h.sqlite!.prepare(`DELETE FROM bot_session_links WHERE bot_id = 'bot-b'`).run();
    const store = createBotGroupChatStore({
      createId: () => 'unused',
      now: () => 300,
      ensureDialogueWorkspaceDir: (sessionId) => `/dialogues/${sessionId}`,
    });

    await expect(store.createRoom({
      id: 'room-invalid',
      name: 'Invalid',
      memberBotIds: ['bot-a', 'bot-b'],
    })).rejects.toThrow(/canonical/i);
    expect(h.sqlite!.prepare(`SELECT COUNT(*) AS count FROM bot_group_rooms`).get())
      .toEqual({ count: 0 });
    expect(h.sqlite!.prepare(`SELECT COUNT(*) AS count FROM sessions WHERE title LIKE 'Group:%'`).get())
      .toEqual({ count: 0 });
  });

  it('keeps thread watermarks, holds and stranded recovery metadata independent', async () => {
    let n = 0;
    const store = createBotGroupChatStore({
      createId: () => `state-${++n}`,
      now: () => 400,
      ensureDialogueWorkspaceDir: (sessionId) => `/dialogues/${sessionId}`,
    });
    const room = await store.createRoom({
      id: 'room-state',
      name: 'State',
      memberBotIds: ['bot-a', 'bot-b'],
    });
    await store.advanceWatermark('room-state', 'bot-a', 'thread-a', 11);
    await store.advanceWatermark('room-state', 'bot-a', 'thread-b', 3);
    await store.updateMemberHolds({
      roomId: 'room-state',
      holdBotIds: ['bot-a'],
      releaseBotIds: [],
      threadId: 'thread-b',
      byMessageId: 'message-stop',
    });
    await store.setStranded({
      roomId: 'room-state',
      botId: 'bot-a',
      beforeSequence: 9,
      threadId: 'thread-a',
      startedAt: 399,
    });

    const member = (await store.loadRoom(room.id))?.members[0];
    expect(member?.watermarks).toEqual({ 'thread-a': 11, 'thread-b': 3 });
    expect(member?.hold).toMatchObject({ byMessageId: 'message-stop', threadId: 'thread-b' });
    expect(member?.stranded).toEqual({
      beforeSequence: 9,
      threadId: 'thread-a',
      startedAt: 399,
    });
  });

  it('does not derive watermark primary keys from colon-delimited room coordinates', async () => {
    seedBot('x', 'X', 'canonical-x');
    let n = 0;
    const store = createBotGroupChatStore({
      createId: () => `watermark-${++n}`,
      now: () => 450,
      ensureDialogueWorkspaceDir: (sessionId) => `/dialogues/${sessionId}`,
    });
    await store.createRoom({ id: 'r', name: 'One', memberBotIds: ['bot-a', 'bot-b'] });
    await store.createRoom({ id: 'r:bot-a', name: 'Two', memberBotIds: ['x', 'bot-b'] });

    await store.advanceWatermark('r', 'bot-a', 'x:y', 1);
    await store.advanceWatermark('r:bot-a', 'x', 'y', 2);

    expect(h.sqlite!.prepare(`SELECT room_id AS roomId, bot_id AS botId, thread_id AS threadId
      FROM bot_group_member_watermarks ORDER BY sequence`).all()).toEqual([
      { roomId: 'r', botId: 'bot-a', threadId: 'x:y' },
      { roomId: 'r:bot-a', botId: 'x', threadId: 'y' },
    ]);
  });

  it('updates only the mutable room identity and archives every owned real Session atomically', async () => {
    let n = 0;
    const store = createBotGroupChatStore({
      createId: () => `manage-${++n}`,
      now: () => 500,
      ensureDialogueWorkspaceDir: (sessionId) => `/dialogues/${sessionId}`,
    });
    const created = await store.createRoom({
      id: 'room-managed',
      name: 'Original name',
      memberBotIds: ['bot-a', 'bot-b'],
    });

    const renamed = await store.updateRoomIdentity('room-managed', {
      name: 'Renamed room',
      avatar: '🛰️',
    });
    expect(renamed).toMatchObject({
      id: 'room-managed',
      name: 'Renamed room',
      avatar: '🛰️',
      roomSessionId: created.roomSessionId,
    });

    const archived = await store.archiveRoom('room-managed');
    expect(archived).toMatchObject({ id: 'room-managed', status: 'archived', running: false, needsUser: false });
    expect(h.sqlite!.prepare(`SELECT status FROM sessions WHERE id = ? OR id IN
      (SELECT member_session_id FROM bot_group_members WHERE room_id = ?)
      ORDER BY id`).all(created.roomSessionId, 'room-managed')).toEqual([
      { status: 'archived' },
      { status: 'archived' },
      { status: 'archived' },
    ]);
    expect(h.sqlite!.prepare(`SELECT COUNT(*) AS count FROM bot_session_links
      WHERE route_key = ? AND archived_at = ?`).get('group:room-managed', 500))
      .toEqual({ count: 2 });

    await expect(store.archiveRoom('room-managed')).resolves.toMatchObject({ status: 'archived' });
    await expect(store.updateRoomIdentity('room-managed', { name: 'Too late' }))
      .rejects.toThrow(/archived|unavailable/i);
  });
});
