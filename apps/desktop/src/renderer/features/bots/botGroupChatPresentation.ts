import type { AgentInputReference } from '@cindy/maker-shared/agent-input-projection';

import type { Message } from '@/lib/ccAgent.types';
import type { ComposerBotMention } from '@/lib/fileTypes';
import type { BotGroupRoomProjection } from '../../../shared/botGroupChat';

type GroupMessageLike = {
  role: string;
  content: unknown;
  agentMeta: unknown;
};

export type PresentedBotGroupMessage =
  | { kind: 'user'; name: string; text: string; threadId: string; attachments: string[] }
  | { kind: 'bot'; botId: string; name: string; text: string; threadId: string; attachments: string[] };

export function presentedRoomMessages(messages: readonly Message[]): Array<{
  id: string;
  createdAt: string;
  value: PresentedBotGroupMessage;
}> {
  return [...messages]
    .sort((left, right) => {
      if (left.rowid !== undefined && right.rowid !== undefined) {
        return left.rowid - right.rowid;
      }
      const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
      return byCreatedAt || left.id.localeCompare(right.id);
    })
    .flatMap((message) => {
      const value = presentBotGroupMessage(message);
      return value ? [{ id: message.id, createdAt: message.createdAt, value }] : [];
    });
}

export function normalizeBotGroupReferences(
  message: string,
  references: readonly AgentInputReference[] | undefined,
  members: readonly ComposerBotMention[],
): string | null {
  if (!references?.length) return message;
  const botReferences = references.filter((reference) => reference.kind === 'bot');
  if (botReferences.length !== references.length) return null;
  const memberIds = new Set(members.map((member) => member.id));
  let normalized = message;
  for (const reference of [...botReferences].sort((left, right) => right.start - left.start)) {
    if (reference.kind !== 'bot' || !memberIds.has(reference.botId)) return null;
    normalized = `${normalized.slice(0, reference.start)}@${reference.name}${normalized.slice(reference.end)}`;
  }
  return normalized;
}

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

/** Build the durable name used by both the room header and the sidebar row. */
export function formatBotGroupDefaultName(names: readonly string[]): string {
  const normalized = names.map((name) => name.trim()).filter(Boolean);
  if (normalized.length === 0) return '';
  if (normalized.length === 1) return normalized[0];
  if (normalized.length === 2) return `${normalized[0]} & ${normalized[1]}`;
  if (normalized.length === 3) return `${normalized[0]}, ${normalized[1]} & ${normalized[2]}`;
  return `${normalized[0]}, ${normalized[1]} +${normalized.length - 2}`;
}

export function botGroupRoomState(
  room: Pick<BotGroupRoomProjection, 'status' | 'running' | 'needsUser'>,
): BotGroupRoomState {
  if (room.status === 'archived') return 'archived';
  if (room.status === 'error') return 'error';
  if (room.needsUser) return 'needs-user';
  return room.running ? 'running' : 'idle';
}
