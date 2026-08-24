import { randomUUID } from 'node:crypto';

import {
  BOT_GROUP_TURN_HARD_TIMEOUT_MS,
  isBotGroupPassText,
  parseBotGroupMentions,
  type BotGroupRoomMessage,
  type BotGroupRoomSendOptions,
} from '../../shared/botGroupChat.js';
import {
  createBotGroupChatCoordinator,
  type BotGroupMemberTurnResult,
  type BotGroupRoomMemberRuntime,
  type BotGroupRoomRuntime,
} from './botGroupChatCoordinator.js';
import {
  createBotGroupChatStore,
  type BotGroupChatStore,
} from './botGroupChatStore.js';
import type {
  BotGroupChangedPayload,
  BotGroupInteractionDecision,
  BotGroupPendingInteraction,
  BotGroupRoomProjection,
  BotGroupRoomSendReceipt,
} from '../../shared/botGroupChat.js';
import { clearBotAttention, noteBotAttention } from './botAttentionService.js';

type DispatchResult =
  | {
      ok: true;
      targetSessionId: string;
      wakeKind: 'resumed' | 'already-active' | 'created' | 'queued';
    }
  | { ok: false; errorCode: string; message: string };

export interface BotGroupChatServiceStore {
  createRoom: BotGroupChatStore['createRoom'];
  updateRoomIdentity: BotGroupChatStore['updateRoomIdentity'];
  archiveRoom: BotGroupChatStore['archiveRoom'];
  listRooms: BotGroupChatStore['listRooms'];
  loadRoom: BotGroupChatStore['loadRoom'];
  appendMessage: BotGroupChatStore['appendMessage'];
  listRecentMessages: BotGroupChatStore['listRecentMessages'];
  listMessagesAfter: BotGroupChatStore['listMessagesAfter'];
  bumpEpoch: BotGroupChatStore['bumpEpoch'];
  readEpoch: BotGroupChatStore['readEpoch'];
  setRunning: BotGroupChatStore['setRunning'];
  setNeedsUser: BotGroupChatStore['setNeedsUser'];
  advanceWatermark: BotGroupChatStore['advanceWatermark'];
  updateMemberHolds: BotGroupChatStore['updateMemberHolds'];
  markHoldNoted: BotGroupChatStore['markHoldNoted'];
  setStranded: BotGroupChatStore['setStranded'];
  clearStranded: BotGroupChatStore['clearStranded'];
  readSessionMessageBoundary: BotGroupChatStore['readSessionMessageBoundary'];
  readLatestAssistantAfter: BotGroupChatStore['readLatestAssistantAfter'];
  resetRuntimeState: BotGroupChatStore['resetRuntimeState'];
}

export interface BotGroupChatServiceDeps {
  store?: BotGroupChatServiceStore;
  dispatch: (input: {
    targetSessionId: string;
    message: string;
    persistedContent: string;
    clientId: string;
    files?: BotGroupRoomMessage['files'];
  }) => Promise<DispatchResult>;
  createId?: () => string;
  turnTimeoutMs?: number;
  turnHardTimeoutMs?: number;
  getPendingInteractions?: (sessionId: string) => Array<{
    request: BotGroupPendingInteraction['request'];
    persistId?: string;
  }>;
  resolveInteraction?: (
    sessionId: string,
    requestId: string,
    decision: BotGroupInteractionDecision,
  ) => boolean;
  onChanged?: (payload: BotGroupChangedPayload) => void;
  noteAttention?: typeof noteBotAttention;
  clearAttention?: typeof clearBotAttention;
}

interface PendingMemberTurn {
  room: BotGroupRoomRuntime;
  member: BotGroupRoomMemberRuntime;
  seenBoundary: number;
  memberMessageBoundary: number;
  threadId: string;
  resolve: (value: BotGroupMemberTurnResult) => void;
  timedOut: boolean;
  settled: boolean;
  startedAt: number;
  softTimeoutMs: number;
  hardDeadlineAt: number;
  timeout: ReturnType<typeof setTimeout>;
  cleanupTimeout: ReturnType<typeof setTimeout> | null;
}

const LATE_REPLY_RETENTION_MS = 15 * 60_000;

function strandedFingerprint(input: {
  roomId: string;
  botId: string;
  threadId: string;
  beforeSequence: number;
}): string {
  return [input.roomId, input.botId, input.threadId, input.beforeSequence].join(':');
}

export function createBotGroupChatService(deps: BotGroupChatServiceDeps) {
  const store = deps.store ?? createBotGroupChatStore();
  const createId = deps.createId ?? randomUUID;
  const pendingBySession = new Map<string, PendingMemberTurn>();
  const recoveredStrandedFingerprints = new Set<string>();
  const noteAttention = deps.noteAttention ?? noteBotAttention;
  const clearAttention = deps.clearAttention ?? clearBotAttention;

  const projectInteractions = (room: BotGroupRoomProjection): BotGroupRoomProjection => ({
    ...room,
    interactions: room.members.flatMap((member) =>
      (deps.getPendingInteractions?.(member.sessionId) ?? []).map((entry) => ({
        sessionId: member.sessionId,
        botId: member.botId,
        botName: member.name,
        request: entry.request,
        ...(entry.persistId ? { persistId: entry.persistId } : {}),
      }))),
  });

  const loadRoom = async (roomId: string): Promise<BotGroupRoomProjection | null> => {
    const room = await store.loadRoom(roomId);
    return room ? projectInteractions(room) : null;
  };

  const listRooms = async (botId?: string): Promise<BotGroupRoomProjection[]> =>
    Promise.all((await store.listRooms(botId)).map((room) => projectInteractions(room)));

  const resolveInteraction = async (
    roomId: string,
    requestId: string,
    decision: BotGroupInteractionDecision,
  ): Promise<boolean> => {
    const room = await store.loadRoom(roomId);
    if (!room || room.status !== 'active') return false;
    for (const member of room.members) {
      const pending = deps.getPendingInteractions?.(member.sessionId) ?? [];
      const match = pending.find((entry) => entry.request.requestId === requestId);
      if (!match || match.request.kind !== decision.kind) continue;
      const resolved = deps.resolveInteraction?.(member.sessionId, requestId, decision) === true;
      if (resolved) deps.onChanged?.({ roomId });
      return resolved;
    }
    return false;
  };

  const expirePending = async (sessionId: string, pending: PendingMemberTurn): Promise<void> => {
    if (pendingBySession.get(sessionId) !== pending || pending.settled) return;
    pending.timedOut = true;
    pending.settled = true;
    pending.resolve({ status: 'completed', reply: null });
    pending.cleanupTimeout = setTimeout(() => {
      if (pendingBySession.get(sessionId) === pending) pendingBySession.delete(sessionId);
    }, LATE_REPLY_RETENTION_MS);
    pending.cleanupTimeout.unref?.();
  };

  const armPendingTimeout = (sessionId: string, pending: PendingMemberTurn): void => {
    clearTimeout(pending.timeout);
    const deadline = Math.min(pending.hardDeadlineAt, Date.now() + pending.softTimeoutMs);
    pending.timeout = setTimeout(
      () => void expirePending(sessionId, pending),
      Math.max(1, deadline - Date.now()),
    );
    pending.timeout.unref?.();
  };

  const runMemberTurn = async (input: {
    room: BotGroupRoomRuntime;
    member: BotGroupRoomMemberRuntime;
    prompt: string;
    seenBoundary: number;
    threadId: string;
    timeoutMs: number;
    files?: BotGroupRoomMessage['files'];
  }): Promise<BotGroupMemberTurnResult> => {
    // Group member Sessions are single-purpose. If their previous provider
    // turn is still late, do not queue another prompt behind it and accidentally
    // associate the first terminal event with the second room turn.
    if (input.member.stranded || pendingBySession.has(input.member.sessionId)) {
      return { status: 'deferred' };
    }

    const effectiveTimeout = Math.max(
      1,
      Math.min(input.timeoutMs, deps.turnTimeoutMs ?? input.timeoutMs),
    );
    const startedAt = Date.now();
    const memberMessageBoundary = await store.readSessionMessageBoundary(input.member.sessionId);
    const hardTimeout = Math.max(
      effectiveTimeout,
      deps.turnHardTimeoutMs ?? BOT_GROUP_TURN_HARD_TIMEOUT_MS,
    );
    let resolveTurn!: (value: BotGroupMemberTurnResult) => void;
    const completion = new Promise<BotGroupMemberTurnResult>((resolve) => {
      resolveTurn = resolve;
    });
    const pending: PendingMemberTurn = {
      room: input.room,
      member: input.member,
      seenBoundary: input.seenBoundary,
      memberMessageBoundary,
      threadId: input.threadId,
      resolve: resolveTurn,
      timedOut: false,
      settled: false,
      startedAt,
      softTimeoutMs: effectiveTimeout,
      hardDeadlineAt: startedAt + hardTimeout,
      timeout: setTimeout(() => undefined, effectiveTimeout),
      cleanupTimeout: null,
    };
    pendingBySession.set(input.member.sessionId, pending);
    armPendingTimeout(input.member.sessionId, pending);

    try {
      await store.setStranded({
        roomId: input.room.id,
        botId: input.member.botId,
        beforeSequence: memberMessageBoundary,
        threadId: input.threadId,
        startedAt,
      });
    } catch {
      clearTimeout(pending.timeout);
      pendingBySession.delete(input.member.sessionId);
      pending.settled = true;
      pending.resolve({ status: 'completed', reply: null });
      return completion;
    }

    const clientId = `bot-group-turn:${input.room.id}:${input.member.botId}:${createId()}`;
    let dispatched: DispatchResult;
    try {
      dispatched = await deps.dispatch({
        targetSessionId: input.member.sessionId,
        message: input.prompt,
        persistedContent: input.prompt,
        clientId,
        ...(input.files?.length ? { files: input.files } : {}),
      });
    } catch {
      dispatched = { ok: false, errorCode: 'DISPATCH_FAILED', message: 'dispatch failed' };
    }
    if (!dispatched.ok && input.files?.length) {
      const fallbackPrompt = [
        input.prompt,
        '',
        '[Attachment degradation] The attached files could not be staged in this member Session. Continue from the text transcript only, and tell the room if the files are required to answer safely.',
      ].join('\n');
      try {
        dispatched = await deps.dispatch({
          targetSessionId: input.member.sessionId,
          message: fallbackPrompt,
          persistedContent: fallbackPrompt,
          clientId,
        });
      } catch {
        dispatched = { ok: false, errorCode: 'DISPATCH_FAILED', message: 'dispatch failed' };
      }
    }
    if (!dispatched.ok) {
      clearTimeout(pending.timeout);
      pendingBySession.delete(input.member.sessionId);
      pending.settled = true;
      pending.resolve({ status: 'completed', reply: null });
      await store.clearStranded(input.room.id, input.member.botId);
      await noteAttention({
        botId: input.member.botId,
        failure: { errorCode: dispatched.errorCode, message: dispatched.message },
      });
    }
    return completion;
  };

  const coordinator = createBotGroupChatCoordinator({
    loadRoom: store.loadRoom,
    appendMessage: store.appendMessage,
    listRecentMessages: store.listRecentMessages,
    listMessagesAfter: store.listMessagesAfter,
    bumpEpoch: store.bumpEpoch,
    readEpoch: store.readEpoch,
    setRunning: store.setRunning,
    setNeedsUser: store.setNeedsUser,
    advanceWatermark: store.advanceWatermark,
    updateMemberHolds: store.updateMemberHolds,
    markHoldNoted: store.markHoldNoted,
    clearStranded: store.clearStranded,
    runMemberTurn,
  });

  const recoverStrandedTerminal = async (input: {
    sessionId: string;
    result?: string | null;
    failed?: boolean;
  }): Promise<boolean> => {
    for (const room of await store.listRooms()) {
      if (room.status !== 'active') continue;
      const member = room.members.find((item) =>
        item.sessionId === input.sessionId && item.stranded !== null);
      if (!member?.stranded) continue;
      const stranded = member.stranded;
      const fingerprint = strandedFingerprint({
        roomId: room.id,
        botId: member.botId,
        threadId: stranded.threadId,
        beforeSequence: stranded.beforeSequence,
      });
      if (recoveredStrandedFingerprints.has(fingerprint)) return true;
      recoveredStrandedFingerprints.add(fingerprint);
      try {
        const result = input.failed === true
          ? null
          : input.result?.trim()
            || await store.readLatestAssistantAfter(input.sessionId, stranded.beforeSequence);
        if (result && !isBotGroupPassText(result)) {
          const appended = await store.appendMessage(
            room.id,
            { kind: 'bot', botId: member.botId, name: member.name },
            result,
            stranded.threadId,
            { clientId: `bot-group-stranded:${fingerprint}` },
          );
          await store.advanceWatermark(
            room.id,
            member.botId,
            stranded.threadId,
            appended.sequence,
          );
          if (parseBotGroupMentions(result, room.members).needsUser) {
            await store.setNeedsUser(room.id, true);
          }
        }
        if (input.failed === true) {
          await noteAttention({ botId: member.botId, failure: { reason: 'unknown' } });
          await store.setNeedsUser(room.id, true);
        } else {
          await clearAttention({ botId: member.botId });
        }
        // Clear the persisted gate last. If any durable write above fails, the
        // marker remains available and the same terminal can be retried.
        await store.clearStranded(room.id, member.botId);
        deps.onChanged?.({ roomId: room.id });
        if (input.failed !== true) {
          void coordinator.resumeRoom(room.id, stranded.threadId).catch(() => undefined);
        }
        return true;
      } catch (error) {
        // The set also serializes concurrent duplicate terminals. Releasing it
        // on failure preserves that protection without permanently swallowing
        // a recovery whose first persistence attempt failed.
        recoveredStrandedFingerprints.delete(fingerprint);
        throw error;
      }
    }
    return false;
  };

  const handleMemberTerminal = async (input: {
    sessionId: string;
    result?: string | null;
    failed?: boolean;
  }): Promise<boolean> => {
    const pending = pendingBySession.get(input.sessionId);
    if (!pending) return recoverStrandedTerminal(input);
    clearTimeout(pending.timeout);
    if (pending.cleanupTimeout) clearTimeout(pending.cleanupTimeout);
    pendingBySession.delete(input.sessionId);
    const currentRoom = await store.loadRoom(pending.room.id);
    if (!currentRoom || currentRoom.status !== 'active') {
      if (!pending.settled) {
        pending.settled = true;
        pending.resolve({ status: 'completed', reply: null });
      }
      return true;
    }
    const result = input.failed === true ? null : input.result?.trim() || null;
    try {
      if (input.failed === true) {
        await noteAttention({
          botId: pending.member.botId,
          failure: { reason: 'unknown' },
        });
      } else {
        await clearAttention({ botId: pending.member.botId });
      }
    } catch {
      // Attention is a secondary projection. A transient failure must not
      // suppress a real provider terminal or strand the room drive forever.
    }

    if (!pending.timedOut) {
      pending.settled = true;
      pending.resolve({
        status: 'completed',
        reply: result,
        strandedBeforeSequence: pending.memberMessageBoundary,
      });
      deps.onChanged?.({ roomId: pending.room.id });
      return true;
    }

    // Hermes keeps a useful reply that finishes after the member timeout. It
    // joins the real room transcript, but cannot resume the superseded drive.
    if (result && !isBotGroupPassText(result)) {
      const appended = await store.appendMessage(
        pending.room.id,
        { kind: 'bot', botId: pending.member.botId, name: pending.member.name },
        result,
        pending.threadId,
        {
          clientId: `bot-group-stranded:${strandedFingerprint({
            roomId: pending.room.id,
            botId: pending.member.botId,
            threadId: pending.threadId,
            beforeSequence: pending.memberMessageBoundary,
          })}`,
        },
      );
      await store.advanceWatermark(
        pending.room.id,
        pending.member.botId,
        pending.threadId,
        appended.sequence === pending.seenBoundary + 1
          ? appended.sequence
          : pending.seenBoundary,
      );
      if (parseBotGroupMentions(result, pending.room.members).needsUser) {
        await store.setNeedsUser(pending.room.id, true);
      }
      deps.onChanged?.({ roomId: pending.room.id });
      // The late terminal belongs to the old provider turn. Re-drive the
      // current epoch asynchronously: waiting here would deadlock the terminal
      // observer until the newly dispatched member turn itself finishes.
      void coordinator.resumeRoom(pending.room.id, pending.threadId).catch(() => undefined);
    }
    // A timed-out reply is projected here rather than by the superseded drive;
    // keep its recovery marker until every durable write above has succeeded.
    await store.clearStranded(pending.room.id, pending.member.botId);
    return true;
  };

  const dispose = (): void => {
    for (const pending of pendingBySession.values()) {
      clearTimeout(pending.timeout);
      if (pending.cleanupTimeout) clearTimeout(pending.cleanupTimeout);
      if (!pending.settled) pending.resolve({ status: 'completed', reply: null });
    }
    pendingBySession.clear();
  };

  const noteMemberActivity = (sessionId: string): boolean => {
    const pending = pendingBySession.get(sessionId);
    if (!pending || pending.settled || pending.timedOut) return false;
    armPendingTimeout(sessionId, pending);
    deps.onChanged?.({ roomId: pending.room.id });
    return true;
  };

  const postUserMessage = async (
    roomId: string,
    text: string,
    options: BotGroupRoomSendOptions = {},
  ): Promise<BotGroupRoomSendReceipt> => {
    const sent = await coordinator.sendUserMessage(roomId, text, options);
    deps.onChanged?.({ roomId });
    void sent.completion
      .catch(() => undefined)
      .finally(() => deps.onChanged?.({ roomId }));
    return { message: sent.message, epoch: sent.epoch, threadId: sent.threadId };
  };

  const createRoom = async (input: Parameters<BotGroupChatServiceStore['createRoom']>[0]) => {
    const room = await store.createRoom(input);
    deps.onChanged?.({ roomId: room.id });
    return room;
  };

  const updateRoomIdentity = async (
    roomId: string,
    patch: Parameters<BotGroupChatServiceStore['updateRoomIdentity']>[1],
  ) => {
    const room = await store.updateRoomIdentity(roomId, patch);
    deps.onChanged?.({ roomId });
    return projectInteractions(room);
  };

  const archiveRoom = async (roomId: string) => {
    const room = await store.archiveRoom(roomId);
    deps.onChanged?.({ roomId });
    return projectInteractions(room);
  };

  const restore = async (): Promise<void> => {
    await store.resetRuntimeState();
    for (const room of await store.listRooms()) {
      if (room.status !== 'active') continue;
      for (const member of room.members) {
        const stranded = member.stranded;
        if (!stranded) continue;
        const fingerprint = strandedFingerprint({
          roomId: room.id,
          botId: member.botId,
          threadId: stranded.threadId,
          beforeSequence: stranded.beforeSequence,
        });
        if (recoveredStrandedFingerprints.has(fingerprint)) continue;
        const reply = await store.readLatestAssistantAfter(
          member.sessionId,
          stranded.beforeSequence,
        );
        if (!reply) {
          // 进程重启不等于远端/恢复中的真实 Session 已终止。没有终态证据时保留
          // stranded 闸门，避免第二条群聊消息叠到旧 turn 后面；稍后的真实 terminal
          // 会走 recoverStrandedTerminal 收口。needsUser 让这条失联状态不再静默。
          await store.setNeedsUser(room.id, true);
          deps.onChanged?.({ roomId: room.id });
          continue;
        }
        recoveredStrandedFingerprints.add(fingerprint);
        try {
          if (!isBotGroupPassText(reply)) {
            const appended = await store.appendMessage(
              room.id,
              { kind: 'bot', botId: member.botId, name: member.name },
              reply,
              stranded.threadId,
              { clientId: `bot-group-stranded:${fingerprint}` },
            );
            await store.advanceWatermark(
              room.id,
              member.botId,
              stranded.threadId,
              appended.sequence,
            );
            if (parseBotGroupMentions(reply, room.members).needsUser) {
              await store.setNeedsUser(room.id, true);
            }
          }
          await store.clearStranded(room.id, member.botId);
          deps.onChanged?.({ roomId: room.id });
        } catch (error) {
          recoveredStrandedFingerprints.delete(fingerprint);
          throw error;
        }
      }
    }
  };

  return {
    createRoom,
    updateRoomIdentity,
    archiveRoom,
    listRooms,
    loadRoom,
    resolveInteraction,
    sendUserMessage: coordinator.sendUserMessage,
    postUserMessage,
    isRunning: coordinator.isRunning,
    handleMemberTerminal,
    noteMemberActivity,
    restore,
    dispose,
  };
}

export type BotGroupChatService = ReturnType<typeof createBotGroupChatService>;
export type { BotGroupRoomMessage, BotGroupRoomProjection };
