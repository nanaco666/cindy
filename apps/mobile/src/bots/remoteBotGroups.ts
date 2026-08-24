import { isRemoteBotsUnsupported } from './remoteBots';

export type RemoteBotGroupStatus = 'active' | 'archived' | 'error';

export interface RemoteBotGroupMember {
  botId: string;
  name: string;
  sessionId: string;
  watermark: number;
}

export interface RemoteBotGroupRoom {
  id: string;
  name: string;
  avatar: string;
  roomSessionId: string;
  status: RemoteBotGroupStatus;
  epoch: number;
  running: boolean;
  needsUser: boolean;
  createdAt: number;
  updatedAt: number;
  members: RemoteBotGroupMember[];
  interactions: RemoteBotGroupPendingInteraction[];
}

export interface RemoteBotGroupPendingInteraction {
  sessionId: string;
  botId: string;
  botName: string;
  request: {
    kind: 'permission' | 'ask_user_question' | 'plan_review';
    requestId: string;
    [key: string]: unknown;
  };
  persistId?: string;
}

export type RemoteBotGroupMessage =
  | { id: string; kind: 'user'; name: string; text: string; attachments: string[]; threadId: string; createdAt: string }
  | { id: string; kind: 'bot'; botId: string; name: string; text: string; attachments: string[]; threadId: string; createdAt: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function roomStatus(value: unknown): RemoteBotGroupStatus {
  return value === 'active' || value === 'archived' || value === 'error' ? value : 'error';
}

function normalizeInteraction(value: unknown): RemoteBotGroupPendingInteraction | null {
  const interaction = record(value);
  const request = record(interaction?.request);
  if (!interaction || !request) return null;
  const sessionId = text(interaction.sessionId);
  const botId = text(interaction.botId);
  const botName = text(interaction.botName);
  const requestId = text(request.requestId);
  const kind = request.kind;
  if (
    !sessionId
    || !botId
    || !botName
    || !requestId
    || (kind !== 'permission' && kind !== 'ask_user_question' && kind !== 'plan_review')
  ) return null;
  const persistId = text(interaction.persistId);
  return {
    sessionId,
    botId,
    botName,
    request: { ...request, kind, requestId },
    ...(persistId ? { persistId } : {}),
  };
}

export function normalizeRemoteBotGroupRoom(value: unknown): RemoteBotGroupRoom | null {
  const room = record(value);
  if (!room) return null;
  const id = text(room.id);
  const name = text(room.name);
  const roomSessionId = text(room.roomSessionId);
  if (!id || !name || !roomSessionId) return null;
  const members = Array.isArray(room.members)
    ? room.members.flatMap((raw) => {
        const member = record(raw);
        if (!member) return [];
        const botId = text(member.botId);
        const memberName = text(member.name);
        const sessionId = text(member.sessionId);
        if (!botId || !memberName || !sessionId) return [];
        return [{
          botId,
          name: memberName,
          sessionId,
          watermark: Math.max(0, number(member.watermark)),
        }];
      })
    : [];
  return {
    id,
    name,
    avatar: text(room.avatar) || '👥',
    roomSessionId,
    status: roomStatus(room.status),
    epoch: Math.max(0, number(room.epoch)),
    running: room.running === true,
    needsUser: room.needsUser === true,
    createdAt: Math.max(0, number(room.createdAt)),
    updatedAt: Math.max(0, number(room.updatedAt)),
    members,
    interactions: Array.isArray(room.interactions)
      ? room.interactions.flatMap((interaction) => {
          const normalized = normalizeInteraction(interaction);
          return normalized ? [normalized] : [];
        })
      : [],
  };
}

export function normalizeRemoteBotGroupRooms(value: unknown): RemoteBotGroupRoom[] {
  return Array.isArray(value)
    ? value.flatMap((room) => {
        const normalized = normalizeRemoteBotGroupRoom(room);
        return normalized ? [normalized] : [];
      })
    : [];
}

function messageText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  const object = record(value);
  return text(object?.text);
}

function attachmentNames(value: unknown): string[] {
  const object = record(value);
  if (!Array.isArray(object?.botGroupFiles)) return [];
  return object.botGroupFiles.flatMap((raw) => {
    const file = record(raw);
    const name = text(file?.name);
    return name ? [name] : [];
  });
}

export function normalizeRemoteBotGroupMessages(
  value: unknown,
  roomId: string,
): RemoteBotGroupMessage[] {
  if (!Array.isArray(value)) return [];
  const result: RemoteBotGroupMessage[] = [];
  for (const raw of value) {
    const message = record(raw);
    const meta = record(record(message?.agentMeta)?.botGroup);
    const id = text(message?.id);
    const content = messageText(message?.content);
    const attachments = attachmentNames(message?.content);
    const name = text(meta?.name);
    const createdAt = text(message?.createdAt);
    const threadId = text(meta?.threadId) || `legacy:${id}`;
    if (
      !message
      || !meta
      || !id
      || (!content && attachments.length === 0)
      || !name
      || text(meta.roomId) !== roomId
    ) continue;
    if (message.role === 'user' && meta.senderKind === 'user') {
      result.push({ id, kind: 'user', name, text: content, attachments, threadId, createdAt });
      continue;
    }
    const botId = text(meta.botId);
    if (message.role === 'assistant' && meta.senderKind === 'bot' && botId) {
      result.push({ id, kind: 'bot', botId, name, text: content, attachments, threadId, createdAt });
    }
  }
  return result;
}

/**
 * The desktop handler signals success by resolving with no payload and signals
 * a stale interaction by rejecting. Do not reinterpret the void payload as a
 * false boolean on mobile.
 */
export async function resolveRemoteBotGroupInteraction(
  invoke: (deviceId: string, channel: string, args?: unknown[]) => Promise<unknown>,
  deviceId: string,
  roomId: string,
  requestId: string,
  decision: Record<string, unknown>,
): Promise<void> {
  await invoke(deviceId, 'maker:bots:group-resolve-interaction', [
    roomId,
    requestId,
    decision,
  ]);
}

export const remoteBotGroupsUnsupported = isRemoteBotsUnsupported;
