import { createMessage } from '../localDb/ipc/messages.js';
import { getDbClient } from '../localDb/client/current.js';
import type { BotGroupRoomMessage, BotGroupRoomProjection } from '../../shared/botGroupChat.js';

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function textContent(value: unknown): string {
  const parsed = parseJson(value);
  if (typeof parsed === 'string') return parsed;
  if (parsed && typeof parsed === 'object' && 'text' in parsed) {
    const text = (parsed as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

function messageFiles(value: unknown): BotGroupRoomMessage['files'] {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== 'object') return undefined;
  const raw = (parsed as { botGroupFiles?: unknown }).botGroupFiles;
  if (!Array.isArray(raw)) return undefined;
  const files = raw.filter((entry): entry is NonNullable<BotGroupRoomMessage['files']>[number] =>
    Boolean(
      entry
      && typeof entry === 'object'
      && typeof (entry as { id?: unknown }).id === 'string'
      && typeof (entry as { name?: unknown }).name === 'string'
      && typeof (entry as { path?: unknown }).path === 'string'
      && typeof (entry as { category?: unknown }).category === 'string'
      && typeof (entry as { mimeType?: unknown }).mimeType === 'string',
    ));
  return files.length > 0 ? files : undefined;
}

function messageSender(
  role: string,
  rawMeta: unknown,
): BotGroupRoomMessage['sender'] | null {
  const meta = parseJson(rawMeta);
  const group = meta && typeof meta === 'object'
    ? (meta as { botGroup?: unknown }).botGroup
    : null;
  if (!group || typeof group !== 'object') return null;
  const record = group as Record<string, unknown>;
  const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : '';
  if (record.senderKind === 'user' && role === 'user') {
    return { kind: 'user', name: name || 'You' };
  }
  if (
    record.senderKind === 'bot'
    && role === 'assistant'
    && typeof record.botId === 'string'
    && record.botId.trim()
  ) {
    return { kind: 'bot', botId: record.botId, name: name || record.botId };
  }
  return null;
}

interface BotGroupSessionMessageStoreDeps {
  createId: () => string;
  loadRoom: (roomId: string) => Promise<BotGroupRoomProjection | null>;
  now: () => number;
}

/**
 * Bot 群聊正文只读写 Cindy 原生 sessions/messages。这里拆模块只是收拢消息映射，
 * 不拥有表、生命周期或第二份 transcript。
 */
export function createBotGroupSessionMessageStore(deps: BotGroupSessionMessageStoreDeps) {
  const appendMessage = async (
    roomId: string,
    sender: BotGroupRoomMessage['sender'],
    text: string,
    threadId: string,
    options?: { clientId?: string; files?: BotGroupRoomMessage['files'] },
  ): Promise<BotGroupRoomMessage> => {
    const room = await deps.loadRoom(roomId);
    if (!room || room.status !== 'active') throw new Error('Bot group room is unavailable');
    const normalized = text.trim();
    if (!normalized && !options?.files?.length) {
      throw new Error('Bot group message must not be empty');
    }
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) throw new Error('Bot group thread id is required');
    const clientId = options?.clientId ?? `bot-group:${roomId}:${deps.createId()}`;
    const createdAt = deps.now();
    const created = await createMessage(room.roomSessionId, {
      clientId,
      role: sender.kind === 'user' ? 'user' : 'assistant',
      content: options?.files?.length
        ? {
            text: normalized,
            botGroupFiles: options.files.map(({ base64: _base64, ...file }) => file),
            images: options.files.flatMap((file) => file.category === 'image' && file.url
              ? [{ url: file.url, mimeType: file.mimeType, originalName: file.originalName ?? file.name }]
              : []),
            files: options.files.flatMap((file) => file.category !== 'image' && file.path
              ? [{ name: file.name, path: file.path }]
              : []),
          }
        : normalized,
      createdAt,
      agentMeta: {
        botGroup: {
          roomId,
          threadId: normalizedThreadId,
          senderKind: sender.kind,
          ...(sender.kind === 'bot' ? { botId: sender.botId } : {}),
          name: sender.name,
        },
      },
    });
    const row = await getDbClient().queryOne<{ sequence: number }>(
      'SELECT rowid AS sequence FROM messages WHERE session_id = ? AND client_id = ?',
      [room.roomSessionId, clientId],
    );
    if (!row) throw new Error('Bot group message sequence is unavailable');
    await getDbClient().exec(
      'UPDATE bot_group_rooms SET updated_at = MAX(updated_at, ?) WHERE id = ?',
      [createdAt, roomId],
    );
    return {
      id: created.id,
      sequence: row.sequence,
      threadId: normalizedThreadId,
      sender,
      text: normalized,
      ...(options?.files?.length ? { files: options.files } : {}),
      createdAt,
    };
  };

  const listMessagesAfter = async (
    roomId: string,
    threadId: string,
    sequence: number,
  ): Promise<BotGroupRoomMessage[]> => {
    const room = await deps.loadRoom(roomId);
    if (!room) return [];
    const rows = await getDbClient().query<{
      id: string;
      sequence: number;
      role: string;
      content: string;
      agentMeta: string | null;
      createdAt: number;
    }>(`SELECT id, rowid AS sequence, role, content, agent_meta AS agentMeta,
        created_at AS createdAt
      FROM messages
      WHERE session_id = ? AND rowid > ? AND rewind_at IS NULL
      ORDER BY rowid ASC`, [room.roomSessionId, Math.max(0, sequence)]);
    const result: BotGroupRoomMessage[] = [];
    for (const row of rows) {
      const sender = messageSender(row.role, row.agentMeta);
      const text = textContent(row.content);
      const files = messageFiles(row.content);
      const meta = parseJson(row.agentMeta);
      const group = meta && typeof meta === 'object'
        ? (meta as { botGroup?: unknown }).botGroup
        : null;
      const rowThreadId = group && typeof group === 'object'
        && typeof (group as { threadId?: unknown }).threadId === 'string'
        ? (group as { threadId: string }).threadId
        : 'legacy';
      if (!sender || (!text && !files) || rowThreadId !== threadId) continue;
      result.push({
        id: row.id,
        sequence: row.sequence,
        threadId: rowThreadId,
        sender,
        text,
        ...(files ? { files } : {}),
        createdAt: row.createdAt,
      });
    }
    return result;
  };

  const readSessionMessageBoundary = async (sessionId: string): Promise<number> => {
    const row = await getDbClient().queryOne<{ sequence: number }>(
      'SELECT COALESCE(MAX(rowid), 0) AS sequence FROM messages WHERE session_id = ?',
      [sessionId],
    );
    return Math.max(0, row?.sequence ?? 0);
  };

  const readLatestAssistantAfter = async (
    sessionId: string,
    sequence: number,
  ): Promise<string | null> => {
    const row = await getDbClient().queryOne<{ content: string }>(
      `SELECT content FROM messages
       WHERE session_id = ? AND role = 'assistant' AND rowid > ? AND rewind_at IS NULL
       ORDER BY rowid DESC LIMIT 1`,
      [sessionId, Math.max(0, sequence)],
    );
    const text = row ? textContent(row.content).trim() : '';
    return text || null;
  };

  return {
    appendMessage,
    listMessagesAfter,
    listRecentMessages: (roomId: string, threadId: string) =>
      listMessagesAfter(roomId, threadId, 0),
    readSessionMessageBoundary,
    readLatestAssistantAfter,
  };
}
