import {
  BOT_GROUP_MAX_MESSAGES,
  BOT_GROUP_MAX_ROUNDS,
  BOT_GROUP_TURN_TIMEOUT_MS,
  botGroupHoldDirective,
  buildBotGroupTurnPrompt,
  isBotGroupPassText,
  parseBotGroupMentions,
  resolveBotGroupResponders,
  rotateBotGroupResponders,
  validateBotGroupMembers,
  type BotGroupMember,
  type BotGroupRoomMessage,
  type BotGroupRoomSendOptions,
} from '../../shared/botGroupChat.js';

export interface BotGroupRoomMemberRuntime extends BotGroupMember {
  sessionId: string;
  watermark: number;
  watermarks: Record<string, number>;
  hold: { at: number; byMessageId: string | null; threadId: string; noted: boolean } | null;
  stranded: { beforeSequence: number; threadId: string; startedAt: number } | null;
}

export interface BotGroupRoomRuntime {
  id: string;
  name: string;
  status: 'active' | 'archived' | 'error';
  epoch: number;
  running: boolean;
  members: BotGroupRoomMemberRuntime[];
}

export type BotGroupMemberTurnResult =
  | { status: 'completed'; reply: string | null; strandedBeforeSequence?: number }
  | { status: 'deferred' };

export interface BotGroupChatCoordinatorDeps {
  loadRoom: (roomId: string) => Promise<BotGroupRoomRuntime | null>;
  appendMessage: (
    roomId: string,
    sender: BotGroupRoomMessage['sender'],
    text: string,
    threadId: string,
    options?: { clientId?: string; files?: BotGroupRoomMessage['files'] },
  ) => Promise<BotGroupRoomMessage>;
  listRecentMessages: (roomId: string, threadId: string) => Promise<BotGroupRoomMessage[]>;
  listMessagesAfter: (
    roomId: string,
    threadId: string,
    sequence: number,
  ) => Promise<BotGroupRoomMessage[]>;
  bumpEpoch: (roomId: string) => Promise<number>;
  readEpoch: (roomId: string) => Promise<number | null>;
  setRunning: (roomId: string, expectedEpoch: number, running: boolean) => Promise<void>;
  setNeedsUser: (roomId: string, needsUser: boolean) => Promise<void>;
  advanceWatermark: (
    roomId: string,
    botId: string,
    threadId: string,
    sequence: number,
  ) => Promise<void>;
  updateMemberHolds: (input: {
    roomId: string;
    holdBotIds: readonly string[];
    releaseBotIds: readonly string[];
    threadId: string;
    byMessageId: string;
  }) => Promise<void>;
  markHoldNoted: (roomId: string, botId: string) => Promise<void>;
  clearStranded: (roomId: string, botId: string) => Promise<void>;
  runMemberTurn: (input: {
    room: BotGroupRoomRuntime;
    member: BotGroupRoomMemberRuntime;
    prompt: string;
    seenBoundary: number;
    threadId: string;
    timeoutMs: number;
    files?: BotGroupRoomMessage['files'];
  }) => Promise<BotGroupMemberTurnResult>;
}

export interface BotGroupSendResult {
  message: BotGroupRoomMessage;
  epoch: number;
  completion: Promise<void>;
  needsUser: () => boolean;
  threadId: string;
}

function lastSequence(messages: readonly BotGroupRoomMessage[]): number {
  return messages.reduce((latest, item) => Math.max(latest, item.sequence), 0);
}

export function createBotGroupChatCoordinator(deps: BotGroupChatCoordinatorDeps) {
  const roomChains = new Map<string, Promise<void>>();
  const needsUserByRoom = new Map<string, boolean>();

  const isCurrentEpoch = async (roomId: string, epoch: number): Promise<boolean> =>
    (await deps.readEpoch(roomId)) === epoch;

  const drive = async (roomId: string, epoch: number, threadId: string): Promise<void> => {
    let posted = 0;
    try {
      for (let round = 0; round < BOT_GROUP_MAX_ROUNDS; round += 1) {
        if (!(await isCurrentEpoch(roomId, epoch))) return;
        const room = await deps.loadRoom(roomId);
        if (!room || room.status !== 'active') return;
        const validation = validateBotGroupMembers(room.members);
        if (!validation.ok) return;
        const recent = await deps.listRecentMessages(roomId, threadId);
        const responders = rotateBotGroupResponders(
          resolveBotGroupResponders(recent, room.members),
          round,
        );
        let spokeThisRound = 0;

        for (const responder of responders) {
          if (!(await isCurrentEpoch(roomId, epoch)) || posted >= BOT_GROUP_MAX_MESSAGES) return;
          const refreshed = await deps.loadRoom(roomId);
          const member = refreshed?.members.find((item) => item.botId === responder.botId);
          if (!refreshed || refreshed.status !== 'active' || !member) continue;
          const seen = member.watermarks[threadId] ?? 0;
          const delta = await deps.listMessagesAfter(roomId, threadId, seen);
          if (delta.length === 0) continue;
          const seenBoundary = lastSequence(delta);
          if (member.hold) {
            await deps.advanceWatermark(roomId, member.botId, threadId, seenBoundary);
            if (!member.hold.noted) await deps.markHoldNoted(roomId, member.botId);
            continue;
          }
          const prompt = buildBotGroupTurnPrompt({
            roomName: refreshed.name,
            members: refreshed.members,
            viewer: member,
            messages: delta,
          });
          // Every member gets its own immutable attachment projection. A
          // harness adapter may annotate an input item while staging it; that
          // must never leak into the next member's real Session queue.
          const files = delta.flatMap((message) =>
            (message.files ?? []).map((file) => ({ ...file })));

          let outcome: BotGroupMemberTurnResult = { status: 'completed', reply: null };
          try {
            outcome = await deps.runMemberTurn({
              room: refreshed,
              member,
              prompt,
              seenBoundary,
              threadId,
              timeoutMs: BOT_GROUP_TURN_TIMEOUT_MS,
              ...(files.length > 0 ? { files } : {}),
            });
          } catch {
            outcome = { status: 'completed', reply: null };
          }

          // Cindy refuses to queue a second prompt behind a member Session
          // whose prior provider turn is still late: its terminal event cannot
          // be attributed safely. That is not a pass. Keep the watermark where
          // it is so the fresh room delta is retried after the late turn lands.
          if (outcome.status === 'deferred') continue;
          const reply = outcome.reply;
          const recoveryFingerprint = outcome.strandedBeforeSequence === undefined
            ? null
            : [
                roomId,
                member.botId,
                threadId,
                outcome.strandedBeforeSequence,
              ].join(':');

          // Advance only through the pre-turn delta. If a newer user message
          // arrived while the Bot was working, the replacement epoch still
          // delivers that message instead of silently consuming it.
          await deps.advanceWatermark(roomId, member.botId, threadId, seenBoundary);
          if (reply !== null && !isBotGroupPassText(reply)) {
            const appended = await deps.appendMessage(
              roomId,
              { kind: 'bot', botId: member.botId, name: member.name },
              reply.trim(),
              threadId,
              recoveryFingerprint
                ? { clientId: `bot-group-stranded:${recoveryFingerprint}` }
                : undefined,
            );
            // A user message can land while the member Session is working.
            // A scalar watermark may only cross the member's own reply when
            // that reply immediately follows the delta it actually saw.
            // Otherwise keep the pre-turn boundary so the concurrent delta is
            // delivered by the replacement epoch.
            if (appended.sequence === seenBoundary + 1) {
              await deps.advanceWatermark(
                roomId,
                member.botId,
                threadId,
                appended.sequence,
              );
            }
            if (parseBotGroupMentions(appended.text, refreshed.members).needsUser) {
              needsUserByRoom.set(roomId, true);
              await deps.setNeedsUser(roomId, true);
            }
            posted += 1;
            spokeThisRound += 1;
          }
          if (outcome.strandedBeforeSequence !== undefined) {
            // The member Session reply is recoverable until both the room
            // projection and its delivery cursor are durable.
            await deps.clearStranded(roomId, member.botId);
          }
        }

        if (spokeThisRound === 0) return;
      }
    } finally {
      await deps.setRunning(roomId, epoch, false);
    }
  };

  const scheduleDrive = (roomId: string, epoch: number, threadId: string): Promise<void> => {
    const prior = roomChains.get(roomId) ?? Promise.resolve();
    const completion = prior.catch(() => undefined).then(() => drive(roomId, epoch, threadId));
    const tracked = completion.finally(() => {
      if (roomChains.get(roomId) === tracked) roomChains.delete(roomId);
    });
    roomChains.set(roomId, tracked);
    return tracked;
  };

  const sendUserMessage = async (
    roomId: string,
    text: string,
    options: BotGroupRoomSendOptions = {},
  ): Promise<BotGroupSendResult> => {
    const normalized = text.trim();
    if (!normalized && !options.files?.length) throw new Error('Group message must not be empty');
    const room = await deps.loadRoom(roomId);
    if (!room || room.status !== 'active') throw new Error('Bot group room is unavailable');
    const validation = validateBotGroupMembers(room.members);
    if (!validation.ok) throw new Error(`Invalid Bot group roster: ${validation.reason}`);
    needsUserByRoom.set(roomId, false);
    await deps.setNeedsUser(roomId, false);
    const threadId = options.threadId?.trim() || `thread:${crypto.randomUUID()}`;
    const message = await deps.appendMessage(
      roomId,
      { kind: 'user', name: 'You' },
      normalized,
      threadId,
      options.files?.length ? { files: options.files } : undefined,
    );
    const holdDirective = botGroupHoldDirective(normalized, room.members);
    await deps.updateMemberHolds({
      roomId,
      holdBotIds: [...holdDirective.holdBotIds],
      releaseBotIds: [...holdDirective.releaseBotIds],
      threadId,
      byMessageId: message.id,
    });
    const epoch = await deps.bumpEpoch(roomId);
    const completion = scheduleDrive(roomId, epoch, threadId);
    return {
      message,
      epoch,
      completion,
      needsUser: () => needsUserByRoom.get(roomId) === true,
      threadId,
    };
  };

  return {
    sendUserMessage,
    resumeRoom: async (roomId: string, threadId: string): Promise<void> => {
      const epoch = await deps.readEpoch(roomId);
      if (epoch === null) return;
      await scheduleDrive(roomId, epoch, threadId);
    },
    isRunning: (roomId: string) => roomChains.has(roomId),
  };
}

export type BotGroupChatCoordinator = ReturnType<typeof createBotGroupChatCoordinator>;
