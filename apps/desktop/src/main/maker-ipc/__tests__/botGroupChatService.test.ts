import { describe, expect, it, vi } from 'vitest';

import { createBotGroupChatService } from '../botGroupChatService';
import type {
  BotGroupInteractionDecision,
  BotGroupRoomMessage,
  BotGroupRoomProjection,
} from '../../../shared/botGroupChat';

function harness(
  turnTimeoutMs = 1000,
  turnHardTimeoutMs = 20 * 60_000,
  getPendingInteractions?: Parameters<typeof createBotGroupChatService>[0]['getPendingInteractions'],
  resolveInteraction?: Parameters<typeof createBotGroupChatService>[0]['resolveInteraction'],
) {
  let sequence = 0;
  let epoch = 0;
  let running = false;
  let needsUser = false;
  let roomStatus: BotGroupRoomProjection['status'] = 'active';
  const watermarks = new Map<string, number>();
  const messages: BotGroupRoomMessage[] = [];
  const recoveredReplies = new Map<string, string>();
  const dispatch = vi.fn(async (_input: {
    targetSessionId: string;
    message: string;
    persistedContent: string;
    clientId: string;
    files?: BotGroupRoomMessage['files'];
  }) => ({
    ok: true as const,
    targetSessionId: 'member-a',
    wakeKind: 'already-active' as const,
  }));
  const onChanged = vi.fn();
  const noteAttention = vi.fn(async () => ({ reason: 'unknown' as const, changed: false }));
  const clearAttention = vi.fn(async () => ({ reason: null, changed: true }));
  const roomProjection = (): BotGroupRoomProjection => ({
    id: 'room-1',
    name: 'Core',
    avatar: '👥',
    roomSessionId: 'room-session',
    status: roomStatus,
    epoch,
    running,
    needsUser,
    createdAt: 1,
    updatedAt: 1,
    members: [
      { botId: 'bot-a', name: 'Alpha', sessionId: 'member-a', watermark: watermarks.get('bot-a') ?? 0, watermarks: { 'thread-1': watermarks.get('bot-a') ?? 0 }, hold: null, stranded: null },
      { botId: 'bot-b', name: 'Beta', sessionId: 'member-b', watermark: watermarks.get('bot-b') ?? 0, watermarks: { 'thread-1': watermarks.get('bot-b') ?? 0 }, hold: null, stranded: null },
    ],
  });
  const loadRoom = vi.fn(async (_roomId: string): Promise<BotGroupRoomProjection | null> =>
    roomProjection());
  const listRooms = vi.fn(async (_botId?: string): Promise<BotGroupRoomProjection[]> => []);
  const store = {
    createRoom: vi.fn(),
    updateRoomIdentity: vi.fn(async (_roomId: string, patch: { name?: string; avatar?: string }) => ({
      ...roomProjection(),
      name: patch.name ?? 'Core',
      avatar: patch.avatar ?? '👥',
    })),
    archiveRoom: vi.fn(async () => {
      roomStatus = 'archived';
      running = false;
      needsUser = false;
      return roomProjection();
    }),
    listRooms,
    loadRoom,
    appendMessage: vi.fn(async (_roomId: string, sender: BotGroupRoomMessage['sender'], text: string, threadId: string, options?: { files?: BotGroupRoomMessage['files'] }) => {
      const message = { id: `m-${++sequence}`, sequence, threadId, sender, text, ...(options?.files?.length ? { files: options.files } : {}), createdAt: sequence };
      messages.push(message);
      return message;
    }),
    listRecentMessages: vi.fn(async (_roomId: string, threadId: string) =>
      messages.filter((message) => message.threadId === threadId)),
    listMessagesAfter: vi.fn(async (_roomId: string, threadId: string, after: number) =>
      messages.filter((message) => message.threadId === threadId && message.sequence > after)),
    bumpEpoch: vi.fn(async () => {
      running = true;
      return ++epoch;
    }),
    readEpoch: vi.fn(async () => epoch),
    setRunning: vi.fn(async (_roomId: string, expectedEpoch: number, value: boolean) => {
      if (epoch === expectedEpoch) running = value;
    }),
    setNeedsUser: vi.fn(async (_roomId: string, value: boolean) => {
      needsUser = value;
    }),
    advanceWatermark: vi.fn(async (_roomId: string, botId: string, _threadId: string, value: number) => {
      watermarks.set(botId, Math.max(watermarks.get(botId) ?? 0, value));
    }),
    updateMemberHolds: vi.fn(async () => undefined),
    markHoldNoted: vi.fn(async () => undefined),
    setStranded: vi.fn(async () => undefined),
    clearStranded: vi.fn(async () => undefined),
    readSessionMessageBoundary: vi.fn(async () => 7),
    readLatestAssistantAfter: vi.fn(async (sessionId: string) => recoveredReplies.get(sessionId) ?? null),
    resetRuntimeState: vi.fn(async () => undefined),
  };
  const service = createBotGroupChatService({
    store,
    dispatch,
    turnTimeoutMs,
    turnHardTimeoutMs,
    getPendingInteractions,
    resolveInteraction,
    createId: () => 'turn-1',
    onChanged,
    noteAttention,
    clearAttention,
  });
  return {
    service,
    dispatch,
    messages,
    onChanged,
    store,
    loadRoom,
    listRooms,
    recoveredReplies,
    noteAttention,
    clearAttention,
  };
}

describe('botGroupChatService', () => {
  it('runs a member through its real persistent Session and mirrors the terminal reply to the room', async () => {
    const h = harness();
    const sent = await h.service.sendUserMessage('room-1', '@bot-a status?', { threadId: 'thread-1' });
    await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalledTimes(1));
    expect(h.dispatch.mock.calls[0]?.[0]).toMatchObject({
      targetSessionId: 'member-a',
      clientId: 'bot-group-turn:room-1:bot-a:turn-1',
    });

    await h.service.handleMemberTerminal({ sessionId: 'member-a', result: 'Ready.' });
    await sent.completion;
    expect(h.messages.map((message) => message.text)).toEqual(['@bot-a status?', 'Ready.']);
    expect(h.onChanged).toHaveBeenCalledWith({ roomId: 'room-1' });
    expect(h.clearAttention).toHaveBeenCalledWith({ botId: 'bot-a' });
  });

  it('keeps the stranded recovery marker until the room reply is durably projected', async () => {
    const h = harness();
    const sent = await h.service.sendUserMessage('room-1', '@bot-a status?', {
      threadId: 'thread-1',
    });
    await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalledTimes(1));
    const append = h.store.appendMessage.getMockImplementation()!;
    let releaseRoomWrite!: () => void;
    const roomWriteGate = new Promise<void>((resolve) => {
      releaseRoomWrite = resolve;
    });
    h.store.appendMessage.mockImplementationOnce(async (...args) => {
      await roomWriteGate;
      return append(...args);
    });

    await h.service.handleMemberTerminal({ sessionId: 'member-a', result: 'Ready.' });
    expect(h.store.clearStranded).not.toHaveBeenCalled();

    releaseRoomWrite();
    await sent.completion;
    expect(h.messages.map((message) => message.text)).toEqual(['@bot-a status?', 'Ready.']);
    expect(h.store.clearStranded).toHaveBeenCalledWith('room-1', 'bot-a');
  });

  it('keeps a timed-out member reply as a late room message without reopening the old drive', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(10);
      const sent = await h.service.sendUserMessage('room-1', '@bot-a investigate', { threadId: 'thread-1' });
      await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(11);
      await sent.completion;
      expect(h.messages.map((message) => message.text)).toEqual(['@bot-a investigate']);

      await h.service.handleMemberTerminal({
        sessionId: 'member-a',
        result: 'Late result; @user please choose.',
      });
      expect(h.messages.map((message) => message.text)).toEqual([
        '@bot-a investigate',
        'Late result; @user please choose.',
      ]);
      expect(h.store.setNeedsUser).toHaveBeenLastCalledWith('room-1', true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not consume a fresh room delta while the member Session still owns a late turn', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(10);
      const first = await h.service.sendUserMessage('room-1', '@bot-a first', { threadId: 'thread-1' });
      await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(11);
      await first.completion;

      const second = await h.service.sendUserMessage('room-1', '@bot-a second', { threadId: 'thread-1' });
      await second.completion;
      expect(h.dispatch).toHaveBeenCalledTimes(1);

      await h.service.handleMemberTerminal({ sessionId: 'member-a', result: 'Late first result.' });
      await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalledTimes(2));
      expect(h.dispatch.mock.calls[1]?.[0].message).toContain('@bot-a second');
    } finally {
      hCleanupTimers();
    }
  });

  it('does not redispatch a member whose persisted stranded marker survived a runtime restart', async () => {
    const h = harness();
    h.loadRoom.mockResolvedValue({
      ...roomProjectionForTest(),
      members: roomProjectionForTest().members.map((member) => member.botId === 'bot-a'
        ? {
            ...member,
            stranded: { beforeSequence: 7, threadId: 'thread-old', startedAt: 100 },
          }
        : member),
    });

    const sent = await h.service.sendUserMessage('room-1', '@bot-a second', {
      threadId: 'thread-1',
    });
    await sent.completion;

    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.store.advanceWatermark).not.toHaveBeenCalled();
  });

  it('clears a pending member when dispatch throws so a later room turn can retry', async () => {
    const h = harness();
    h.dispatch.mockRejectedValueOnce(new Error('transport down'));

    const first = await h.service.sendUserMessage('room-1', '@bot-a first', { threadId: 'thread-1' });
    await first.completion;
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.store.setStranded).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'room-1',
      botId: 'bot-a',
      beforeSequence: 7,
      threadId: 'thread-1',
    }));
    expect(h.store.setStranded.mock.invocationCallOrder[0])
      .toBeLessThan(h.dispatch.mock.invocationCallOrder[0]!);
    expect(h.store.clearStranded).toHaveBeenCalledWith('room-1', 'bot-a');

    const second = await h.service.sendUserMessage('room-1', '@bot-a second', { threadId: 'thread-1' });
    await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalledTimes(2));
    await h.service.handleMemberTerminal({ sessionId: 'member-a', result: '(pass)' });
    await second.completion;
  });

  it('retries a member text-only when attachment staging fails without failing the room', async () => {
    const h = harness();
    h.dispatch.mockRejectedValueOnce(new Error('attachment staging failed'));
    const files = [{
      id: 'pdf-1', name: 'brief.pdf', path: '/tmp/brief.pdf', ext: 'pdf', size: 20,
      category: 'pdf' as const, mimeType: 'application/pdf',
    }];

    const sent = await h.service.sendUserMessage('room-1', '@bot-a review', {
      threadId: 'thread-1',
      files,
    });
    await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalledTimes(2));
    expect(h.dispatch.mock.calls[0]?.[0].files).toEqual(files);
    expect(h.dispatch.mock.calls[1]?.[0].files).toBeUndefined();
    expect(h.dispatch.mock.calls[1]?.[0].message).toContain('could not be staged');
    await h.service.handleMemberTerminal({ sessionId: 'member-a', result: 'I can still review the text.' });
    await expect(sent.completion).resolves.toBeUndefined();
  });

  it('accepts an attachment-only user message and persists it in the real room task', async () => {
    const h = harness();
    const files = [{
      id: 'image-1', name: 'screen.png', path: '/tmp/screen.png', ext: 'png', size: 10,
      category: 'image' as const, mimeType: 'image/png',
    }];
    const sent = await h.service.sendUserMessage('room-1', '', { threadId: 'thread-1', files });
    await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalled());
    expect(h.messages[0]).toMatchObject({ text: '', files });
    await h.service.handleMemberTerminal({ sessionId: 'member-a', result: '(pass)' });
    await sent.completion;
  });

  it('accepts one terminal only and dispose releases every pending member turn', async () => {
    const h = harness();
    const sent = await h.service.sendUserMessage('room-1', '@bot-a first', { threadId: 'thread-1' });
    await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalledTimes(1));

    expect(await h.service.handleMemberTerminal({ sessionId: 'member-a', result: 'Done.' }))
      .toBe(true);
    expect(await h.service.handleMemberTerminal({ sessionId: 'member-a', result: 'Duplicate.' }))
      .toBe(false);
    await sent.completion;

    const next = await h.service.sendUserMessage('room-1', '@bot-b second', { threadId: 'thread-1' });
    await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalledTimes(2));
    h.service.dispose();
    await next.completion;
    expect(await h.service.handleMemberTerminal({ sessionId: 'member-b', result: 'Late.' }))
      .toBe(false);
  });

  it('does not append a late terminal after the room was archived', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(10);
      const sent = await h.service.sendUserMessage('room-1', '@bot-a investigate', { threadId: 'thread-1' });
      await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(11);
      await sent.completion;
      h.loadRoom.mockResolvedValueOnce({
        ...(await h.loadRoom('room-1'))!,
        status: 'archived' as const,
      });

      expect(await h.service.handleMemberTerminal({ sessionId: 'member-a', result: 'Too late.' }))
        .toBe(true);
      expect(h.messages.map((message) => message.text)).toEqual(['@bot-a investigate']);
    } finally {
      hCleanupTimers();
    }
  });

  it('archives the room through the service and rejects future sends without reviving late terminals', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(10);
      const sent = await h.service.sendUserMessage('room-1', '@bot-a investigate', { threadId: 'thread-1' });
      await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalledTimes(1));

      await expect(h.service.archiveRoom('room-1')).resolves.toMatchObject({
        id: 'room-1',
        status: 'archived',
      });
      expect(h.store.archiveRoom).toHaveBeenCalledWith('room-1');
      await vi.advanceTimersByTimeAsync(11);
      await sent.completion;
      await h.service.handleMemberTerminal({ sessionId: 'member-a', result: 'Late result.' });
      expect(h.messages.map((message) => message.text)).toEqual(['@bot-a investigate']);

      await expect(h.service.postUserMessage('room-1', 'new work'))
        .rejects.toThrow(/unavailable/i);
    } finally {
      hCleanupTimers();
    }
  });

  it('extends a visibly active member turn but never beyond the hard cap', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(100, 350);
      const sent = await h.service.sendUserMessage('room-1', '@bot-a investigate', { threadId: 'thread-1' });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.dispatch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(90);
      expect(h.service.noteMemberActivity('member-a')).toBe(true);
      await vi.advanceTimersByTimeAsync(90);
      expect(h.service.noteMemberActivity('member-a')).toBe(true);
      await vi.advanceTimersByTimeAsync(90);
      expect(h.service.noteMemberActivity('member-a')).toBe(true);
      await vi.advanceTimersByTimeAsync(90);
      await sent.completion;

      expect(await h.service.handleMemberTerminal({ sessionId: 'member-a', result: 'Late.' }))
        .toBe(true);
      expect(h.messages.map((message) => message.text)).toEqual([
        '@bot-a investigate',
        'Late.',
      ]);
    } finally {
      hCleanupTimers();
    }
  });

  it('projects the existing member Session interaction without creating a room-specific resolver', async () => {
    const h = harness(1000, 20 * 60_000, (sessionId) => sessionId === 'member-a'
      ? [{
          request: {
            kind: 'ask_user_question' as const,
            requestId: 'ask-1',
            questions: [{ question: 'Which region?' }],
          },
          persistId: 'message-1',
        }]
      : []);

    await expect(h.service.loadRoom('room-1')).resolves.toMatchObject({
      interactions: [{
        sessionId: 'member-a',
        botId: 'bot-a',
        botName: 'Alpha',
        request: { kind: 'ask_user_question', requestId: 'ask-1' },
        persistId: 'message-1',
      }],
    });
  });

  it('resolves only a still-pending interaction owned by a room member with the same kind', async () => {
    const pending = vi.fn((sessionId: string) => sessionId === 'member-a'
      ? [{ request: { kind: 'permission' as const, requestId: 'permission-1', toolName: 'Bash' } }]
      : []);
    const resolve = vi.fn((
      sessionId: string,
      requestId: string,
      decision: BotGroupInteractionDecision,
    ) => sessionId === 'member-a' && requestId === 'permission-1' && decision.kind === 'permission');
    const h = harness(1000, 20 * 60_000, pending, resolve);

    await expect(h.service.resolveInteraction('room-1', 'permission-1', {
      kind: 'permission',
      behavior: 'allow',
    })).resolves.toBe(true);
    expect(resolve).toHaveBeenCalledWith('member-a', 'permission-1', {
      kind: 'permission',
      behavior: 'allow',
    });

    await expect(h.service.resolveInteraction('room-1', 'permission-1', {
      kind: 'plan_review',
      behavior: 'allow',
    })).resolves.toBe(false);
    await expect(h.service.resolveInteraction('room-1', 'outside-request', {
      kind: 'permission',
      behavior: 'deny',
    })).resolves.toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the room is archived or the Session resolver is already stale', async () => {
    const pending = () => [{
      request: { kind: 'ask_user_question' as const, requestId: 'ask-1', questions: [] },
    }];
    const resolve = vi.fn(() => false);
    const h = harness(1000, 20 * 60_000, pending, resolve);

    await expect(h.service.resolveInteraction('room-1', 'ask-1', {
      kind: 'ask_user_question',
      answers: { Region: 'Global' },
    })).resolves.toBe(false);

    h.loadRoom.mockResolvedValueOnce({ ...roomProjectionForTest(), status: 'archived' });
    await expect(h.service.resolveInteraction('room-1', 'ask-1', {
      kind: 'ask_user_question',
      answers: { Region: 'Global' },
    })).resolves.toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('harvests a persisted stranded reply after restart exactly once', async () => {
    const h = harness();
    h.loadRoom.mockResolvedValue({
      ...(await h.loadRoom('room-1'))!,
      members: [
        {
          botId: 'bot-a',
          name: 'Alpha',
          sessionId: 'member-a',
          watermark: 0,
          watermarks: { 'thread-old': 1 },
          hold: null,
          stranded: { beforeSequence: 7, threadId: 'thread-old', startedAt: 100 },
        },
        {
          botId: 'bot-b',
          name: 'Beta',
          sessionId: 'member-b',
          watermark: 0,
          watermarks: {},
          hold: null,
          stranded: null,
        },
      ],
    });
    h.listRooms.mockResolvedValue([(await h.loadRoom('room-1'))!]);
    h.recoveredReplies.set('member-a', 'Recovered result.');

    await h.service.restore();
    await h.service.restore();

    expect(h.messages.filter((message) => message.text === 'Recovered result.')).toHaveLength(1);
    expect(h.store.clearStranded).toHaveBeenCalledWith('room-1', 'bot-a');
    expect(h.store.resetRuntimeState).toHaveBeenCalledTimes(2);
  });

  it('keeps a stranded marker after restart until a real terminal proves the turn ended', async () => {
    const h = harness();
    h.loadRoom.mockResolvedValue({
      ...(await h.loadRoom('room-1'))!,
      members: [
        {
          botId: 'bot-a',
          name: 'Alpha',
          sessionId: 'member-a',
          watermark: 0,
          watermarks: { 'thread-old': 1 },
          hold: null,
          stranded: { beforeSequence: 7, threadId: 'thread-old', startedAt: 100 },
        },
        {
          botId: 'bot-b',
          name: 'Beta',
          sessionId: 'member-b',
          watermark: 0,
          watermarks: {},
          hold: null,
          stranded: null,
        },
      ],
    });
    h.listRooms.mockResolvedValue([(await h.loadRoom('room-1'))!]);

    await h.service.restore();

    expect(h.store.clearStranded).not.toHaveBeenCalled();
    expect(h.store.setNeedsUser).toHaveBeenCalledWith('room-1', true);
    expect(h.messages).toHaveLength(0);
  });

  it('harvests a late terminal for a stranded member after runtime restart', async () => {
    const h = harness();
    const strandedRoom: BotGroupRoomProjection = {
      ...(await h.loadRoom('room-1'))!,
      members: [
        {
          botId: 'bot-a',
          name: 'Alpha',
          sessionId: 'member-a',
          watermark: 0,
          watermarks: { 'thread-old': 1 },
          hold: null,
          stranded: { beforeSequence: 7, threadId: 'thread-old', startedAt: 100 },
        },
        {
          botId: 'bot-b',
          name: 'Beta',
          sessionId: 'member-b',
          watermark: 0,
          watermarks: {},
          hold: null,
          stranded: null,
        },
      ],
    };
    h.listRooms.mockResolvedValue([strandedRoom]);

    await expect(h.service.handleMemberTerminal({
      sessionId: 'member-a',
      result: 'Recovered after restart.',
    })).resolves.toBe(true);
    await expect(h.service.handleMemberTerminal({
      sessionId: 'member-a',
      result: 'Duplicate terminal.',
    })).resolves.toBe(true);

    expect(h.messages.filter((message) => message.text === 'Recovered after restart.'))
      .toHaveLength(1);
    expect(h.store.clearStranded).toHaveBeenCalledWith('room-1', 'bot-a');
    expect(h.clearAttention).toHaveBeenCalledWith({ botId: 'bot-a' });
  });

  it('retries stranded terminal recovery when the first persistence attempt fails', async () => {
    const h = harness();
    const strandedRoom: BotGroupRoomProjection = {
      ...(await h.loadRoom('room-1'))!,
      members: [
        {
          botId: 'bot-a',
          name: 'Alpha',
          sessionId: 'member-a',
          watermark: 0,
          watermarks: { 'thread-old': 1 },
          hold: null,
          stranded: { beforeSequence: 7, threadId: 'thread-old', startedAt: 100 },
        },
        {
          botId: 'bot-b',
          name: 'Beta',
          sessionId: 'member-b',
          watermark: 0,
          watermarks: {},
          hold: null,
          stranded: null,
        },
      ],
    };
    h.listRooms.mockResolvedValue([strandedRoom]);
    h.store.appendMessage.mockRejectedValueOnce(new Error('database busy'));

    await expect(h.service.handleMemberTerminal({
      sessionId: 'member-a',
      result: 'Recovered after retry.',
    })).rejects.toThrow('database busy');
    await expect(h.service.handleMemberTerminal({
      sessionId: 'member-a',
      result: 'Recovered after retry.',
    })).resolves.toBe(true);

    expect(h.messages.filter((message) => message.text === 'Recovered after retry.'))
      .toHaveLength(1);
    expect(h.store.clearStranded).toHaveBeenCalledTimes(1);
  });
});

function hCleanupTimers(): void {
  vi.clearAllTimers();
  vi.useRealTimers();
}

function roomProjectionForTest(): BotGroupRoomProjection {
  return {
    id: 'room-1',
    name: 'Core',
    avatar: '👥',
    roomSessionId: 'room-session',
    status: 'active',
    epoch: 0,
    running: false,
    needsUser: false,
    createdAt: 1,
    updatedAt: 1,
    members: [
      { botId: 'bot-a', name: 'Alpha', sessionId: 'member-a', watermark: 0, watermarks: {}, hold: null, stranded: null },
      { botId: 'bot-b', name: 'Beta', sessionId: 'member-b', watermark: 0, watermarks: {}, hold: null, stranded: null },
    ],
  };
}
