import type { BotGroupRoomProjection } from '../../../shared/botGroupChat';

type GroupMessageLike = {
  role: string;
  content: unknown;
  agentMeta: unknown;
};

export type PresentedBotGroupMessage =
  | { kind: 'user'; name: string; text: string; threadId: string; attachments: string[] }
  | { kind: 'bot'; botId: string; name: string; text: string; threadId: string; attachments: string[] };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function messageText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  const object = record(value);
  return typeof object?.text === 'string' ? object.text.trim() : '';
}

function attachmentNames(value: unknown): string[] {
  const object = record(value);
  if (!Array.isArray(object?.botGroupFiles)) return [];
  return object.botGroupFiles.flatMap((file) => {
    const item = record(file);
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    return name ? [name] : [];
  });
}

export function presentBotGroupMessage(
  message: GroupMessageLike,
): PresentedBotGroupMessage | null {
  const meta = record(record(message.agentMeta)?.botGroup);
  const text = messageText(message.content);
  const attachments = attachmentNames(message.content);
  const name = typeof meta?.name === 'string' ? meta.name.trim() : '';
  const threadId = typeof meta?.threadId === 'string' && meta.threadId.trim()
    ? meta.threadId.trim()
    : 'legacy';
  if (!meta || (!text && attachments.length === 0) || !name) return null;
  if (meta.senderKind === 'user' && message.role === 'user') {
    return { kind: 'user', name, text, threadId, attachments };
  }
  const botId = typeof meta.botId === 'string' ? meta.botId.trim() : '';
  if (meta.senderKind === 'bot' && message.role === 'assistant' && botId) {
    return { kind: 'bot', botId, name, text, threadId, attachments };
  }
  return null;
}

export type BotGroupRoomState = 'idle' | 'running' | 'needs-user' | 'error' | 'archived';

export function botGroupRoomState(
  room: Pick<BotGroupRoomProjection, 'status' | 'running' | 'needsUser'>,
): BotGroupRoomState {
  if (room.status === 'archived') return 'archived';
  if (room.status === 'error') return 'error';
  if (room.needsUser) return 'needs-user';
  return room.running ? 'running' : 'idle';
}
