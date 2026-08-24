import type { AgentInputSerializedFile } from './agentInputQueue';

/**
 * Hermes-compatible Cindy Bot group-chat policy.
 *
 * This module contains no room transcript or runtime state. Main persists room
 * messages in Cindy's real `messages` table and stores only membership,
 * watermark and epoch metadata beside it.
 */

export const BOT_GROUP_MIN_MEMBERS = 2;
export const BOT_GROUP_MAX_MEMBERS = 6;
export const BOT_GROUP_MAX_ROUNDS = 3;
export const BOT_GROUP_MAX_MESSAGES = 10;
export const BOT_GROUP_HISTORY_LIMIT = 24;
export const BOT_GROUP_TURN_TIMEOUT_MS = 180_000;
export const BOT_GROUP_TURN_HARD_TIMEOUT_MS = 20 * 60_000;

export interface BotGroupMember {
  botId: string;
  name: string;
  title?: string;
}

export interface BotGroupRoomMessage {
  id: string;
  sequence: number;
  threadId: string;
  sender:
    | { kind: 'user'; name: string }
    | { kind: 'bot'; botId: string; name: string };
  text: string;
  files?: AgentInputSerializedFile[];
  createdAt: number;
}

export interface BotGroupMemberHold {
  at: number;
  byMessageId: string | null;
  threadId: string;
  noted: boolean;
}

export interface BotGroupMemberStrandedTurn {
  beforeSequence: number;
  threadId: string;
  startedAt: number;
}

export interface BotGroupRoomMemberProjection extends BotGroupMember {
  sessionId: string;
  /** Legacy scalar mirror. Runtime delivery uses the thread-scoped map. */
  watermark: number;
  watermarks: Record<string, number>;
  hold: BotGroupMemberHold | null;
  stranded: BotGroupMemberStrandedTurn | null;
}

export interface BotGroupPendingInteraction {
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

export type BotGroupInteractionDecision =
  | {
      kind: 'permission';
      behavior: 'allow' | 'deny';
      updatedInput?: Record<string, unknown>;
      reason?: string;
      permissionUpdates?: unknown[];
    }
  | {
      kind: 'ask_user_question';
      answers: Record<string, string>;
    }
  | {
      kind: 'plan_review';
      behavior: 'allow' | 'deny';
      editedPlan?: string;
      reason?: string;
      dismissed?: boolean;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Runtime validation for the room-specific interaction bridge. */
export function parseBotGroupInteractionDecision(
  value: unknown,
): BotGroupInteractionDecision | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'permission') {
    if (value.behavior !== 'allow' && value.behavior !== 'deny') return null;
    if (value.updatedInput !== undefined && !isRecord(value.updatedInput)) return null;
    if (value.reason !== undefined && typeof value.reason !== 'string') return null;
    if (value.permissionUpdates !== undefined && !Array.isArray(value.permissionUpdates)) return null;
    return {
      kind: 'permission',
      behavior: value.behavior,
      ...(value.updatedInput ? { updatedInput: value.updatedInput } : {}),
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
      ...(Array.isArray(value.permissionUpdates)
        ? { permissionUpdates: value.permissionUpdates }
        : {}),
    };
  }
  if (value.kind === 'ask_user_question') {
    if (!isRecord(value.answers)) return null;
    const answers: Record<string, string> = {};
    for (const [question, answer] of Object.entries(value.answers)) {
      if (!question || typeof answer !== 'string') return null;
      answers[question] = answer;
    }
    return { kind: 'ask_user_question', answers };
  }
  if (value.kind === 'plan_review') {
    if (value.behavior !== 'allow' && value.behavior !== 'deny') return null;
    if (value.editedPlan !== undefined && typeof value.editedPlan !== 'string') return null;
    if (value.reason !== undefined && typeof value.reason !== 'string') return null;
    if (value.dismissed !== undefined && typeof value.dismissed !== 'boolean') return null;
    return {
      kind: 'plan_review',
      behavior: value.behavior,
      ...(typeof value.editedPlan === 'string' ? { editedPlan: value.editedPlan } : {}),
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
      ...(typeof value.dismissed === 'boolean' ? { dismissed: value.dismissed } : {}),
    };
  }
  return null;
}

export interface BotGroupRoomProjection {
  id: string;
  name: string;
  avatar: string;
  roomSessionId: string;
  status: 'active' | 'archived' | 'error';
  epoch: number;
  running: boolean;
  needsUser: boolean;
  createdAt: number;
  updatedAt: number;
  members: BotGroupRoomMemberProjection[];
  /** Live projection of Cindy's existing Session interaction resolvers. */
  interactions?: BotGroupPendingInteraction[];
}

export interface BotGroupRoomIdentityPatch {
  name?: string;
  avatar?: string;
}

export interface BotGroupRoomSendReceipt {
  message: BotGroupRoomMessage;
  epoch: number;
  threadId: string;
}

export interface BotGroupRoomSendOptions {
  threadId?: string;
  files?: AgentInputSerializedFile[];
}

export interface BotGroupChangedPayload {
  roomId: string;
}

export type BotGroupMemberValidation =
  | { ok: true }
  | { ok: false; reason: 'member-count' | 'duplicate-bot' | 'invalid-member' };

export type BotGroupHoldDirective = {
  holdBotIds: Set<string>;
  releaseBotIds: Set<string>;
};

function normalizedHandle(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

function collapsedHandle(value: string): string {
  return normalizedHandle(value).replace(/[\s._-]+/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsMention(source: string, handle: string): boolean {
  if (!handle) return false;
  const escaped = escapeRegExp(handle);
  const quoted = new RegExp(`@(?:"${escaped}"|'${escaped}')(?=$|[\\s,，。.!！?？;；:：])`, 'iu');
  const plain = new RegExp(`@${escaped}(?=$|[\\s,，。.!！?？;；:：])`, 'iu');
  return quoted.test(source) || plain.test(source);
}

export function validateBotGroupMembers(members: readonly BotGroupMember[]): BotGroupMemberValidation {
  if (members.length < BOT_GROUP_MIN_MEMBERS || members.length > BOT_GROUP_MAX_MEMBERS) {
    return { ok: false, reason: 'member-count' };
  }
  const ids = new Set<string>();
  for (const member of members) {
    if (!member.botId.trim() || !member.name.trim()) {
      return { ok: false, reason: 'invalid-member' };
    }
    if (ids.has(member.botId)) {
      return { ok: false, reason: 'duplicate-bot' };
    }
    ids.add(member.botId);
  }
  return { ok: true };
}

/** Empty text and Hermes' loose pass spellings are silent turns. */
export function isBotGroupPassText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || /^\(?\s*pass\s*\)?\.?$/iu.test(trimmed);
}

export function parseBotGroupMentions(
  text: string,
  members: readonly BotGroupMember[],
): { everyone: boolean; needsUser: boolean; botIds: Set<string> } {
  const source = text.normalize('NFKC');
  const everyone = containsMention(source, 'everyone') || containsMention(source, 'all');
  const needsUser = containsMention(source, 'user');
  const botIds = new Set<string>();

  for (const member of members) {
    const title = member.title?.trim() ?? '';
    const firstTitleWord = title.split(/\s+/u)[0] ?? '';
    const handles = new Set([
      normalizedHandle(member.botId),
      collapsedHandle(member.botId),
      normalizedHandle(member.name),
      collapsedHandle(member.name),
      normalizedHandle(title),
      collapsedHandle(title),
      normalizedHandle(firstTitleWord),
    ]);
    if ([...handles].some((handle) => containsMention(source, handle))) {
      botIds.add(member.botId);
    }
  }

  return { everyone, needsUser, botIds };
}

/**
 * Hermes room-level hold semantics. Only user messages call this helper:
 * stop/halt/pause holds mentioned members, resume/continue/go/proceed releases
 * them, and any ordinary direct mention releases that member too.
 */
export function botGroupHoldDirective(
  text: string,
  members: readonly BotGroupMember[],
): BotGroupHoldDirective {
  const mentions = parseBotGroupMentions(text, members);
  const mentioned = mentions.everyone
    ? members.map((member) => member.botId)
    : [...mentions.botIds];
  const hold = /\b(stop|halt|pause)\b/iu.test(text);
  const release = /\b(resume|continue|go|proceed)\b/iu.test(text);
  return {
    holdBotIds: new Set(hold ? mentioned : []),
    releaseBotIds: new Set(!hold && (release || mentioned.length > 0) ? mentioned : []),
  };
}

/** Recomputed each round so a Bot mentioned by another member joins next. */
export function resolveBotGroupResponders(
  messages: readonly BotGroupRoomMessage[],
  members: readonly BotGroupMember[],
): BotGroupMember[] {
  let sinceLastUser: readonly BotGroupRoomMessage[] = messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.sender.kind === 'user') {
      sinceLastUser = messages.slice(index);
      break;
    }
  }

  let everyone = false;
  const mentioned = new Set<string>();
  for (const entry of sinceLastUser) {
    const parsed = parseBotGroupMentions(entry.text, members);
    everyone ||= parsed.everyone;
    for (const botId of parsed.botIds) mentioned.add(botId);
  }
  if (everyone || mentioned.size === 0) return [...members];
  return members.filter((member) => mentioned.has(member.botId));
}

export function rotateBotGroupResponders(
  members: readonly BotGroupMember[],
  round: number,
): BotGroupMember[] {
  if (members.length < 2) return [...members];
  const shift = ((round % members.length) + members.length) % members.length;
  return [...members.slice(shift), ...members.slice(0, shift)];
}

function formatRoomLine(message: BotGroupRoomMessage, viewerBotId: string): string {
  const attachmentLabels = (message.files ?? []).map((file) => {
    const kind = file.category === 'image'
      ? 'image'
      : file.category === 'pdf'
        ? 'PDF'
        : 'file';
    return `[attached ${kind}: ${file.name}]`;
  });
  const body = [message.text, ...attachmentLabels].filter(Boolean).join(' ');
  if (message.sender.kind === 'user') {
    return `${message.sender.name || 'User'} (user): ${body}`;
  }
  const suffix = message.sender.botId === viewerBotId ? ' (you)' : '';
  return `${message.sender.name}${suffix}: ${body}`;
}

/** Turn-scoped protocol; it is deliberately not part of a Bot's SOUL. */
export function buildBotGroupTurnPrompt(input: {
  roomName: string;
  members: readonly BotGroupMember[];
  viewer: BotGroupMember;
  messages: readonly BotGroupRoomMessage[];
}): string {
  const peers = input.members.filter((member) => member.botId !== input.viewer.botId);
  const peerNames = peers
    .map((member) => member.title ? `${member.title} (@${member.botId})` : `@${member.botId}`)
    .join(', ');
  const delta = input.messages.slice(-BOT_GROUP_HISTORY_LIMIT);

  return [
    `[Group chat: "${input.roomName}"] You are @${input.viewer.botId}, one participant in a group chat with ${peerNames || 'no one else yet'} and the user.`,
    '',
    'New messages in the room since your last turn (oldest first):',
    ...delta.map((entry) => `  ${formatRoomLine(entry, input.viewer.botId)}`),
    '',
    'Rules for this room:',
    '- Reply with ONE conversational message ONLY if you have something new worth adding: build on what was just said, claim or hand off work, answer a question aimed at you, or report a real result. Keep chatter short (1-3 sentences), but when you are delivering a result, an answer the user asked for, or substantive work, give it at full quality and length; never thin out real content to fit the room.',
    '- If you have nothing new to add, reply with exactly "(pass)". Passing is good because it lets the conversation settle.',
    '- Mention a teammate as @name to pull them in; mention @user only for a judgment call or a result the user needs. Do not repeat points already made.',
    '- Keep private 1:1 chats private. Your reply text goes to the room verbatim, without a preamble or meta-commentary.',
  ].join('\n');
}
