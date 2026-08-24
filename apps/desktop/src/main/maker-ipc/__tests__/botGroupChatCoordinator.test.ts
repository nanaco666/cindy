import { describe, expect, it, vi } from 'vitest';

import {
  createBotGroupChatCoordinator,
  type BotGroupChatCoordinatorDeps,
  type BotGroupRoomRuntime,
} from '../botGroupChatCoordinator';
import type { BotGroupRoomMessage } from '../../../shared/botGroupChat';

function createHarness(
  replies: (input: { botId: string; prompt: string; call: number; files: BotGroupRoomMessage['files'] }) => Promise<string | null> | string | null,
) {
  let sequence = 0;
  let epoch = 0;
  let running = false;
  let needsUser = false;
  const watermarks = new Map<string, number>();
  const messages: BotGroupRoomMessage[] = [];
  const calls: Array<{ botId: string; prompt: string }> = [];
  const room = (): BotGroupRoomRuntime => ({
    id: 'room-1',
    name: 'Core',
    status: 'active',
    epoch,
    running,
    members: [
      { botId: 'research', name: 'Research', sessionId: 'group-research', watermark: watermarks.get('research') ?? 0 },
      { botId: 'builder', name: 'Builder', sessionId: 'group-builder', watermark: watermarks.get('builder') ?? 0 },
      { botId: 'ops', name: 'Ops', sessionId: 'group-ops', watermark: watermarks.get('ops') ?? 0 },
    ].map((member) => ({ ...member, watermarks: { 'thread-1': member.watermark }, hold: null, stranded: null })),
  });

  const deps: BotGroupChatCoordinatorDeps = {
    loadRoom: vi.fn(async () => room()),
    appendMessage: vi.fn(async (_roomId, sender, text, threadId, options) => {
      sequence += 1;
      const value: BotGroupRoomMessage = {
        id: `m-${sequence}`,
        sequence,
        threadId,
        sender,
        text,
        ...(options?.files?.length ? { files: options.files } : {}),
        createdAt: sequence,
      };
      messages.push(value);
      return value;
    }),
    listRecentMessages: vi.fn(async (_roomId, threadId) =>
      messages.filter((item) => item.threadId === threadId)),
    listMessagesAfter: vi.fn(async (_roomId, threadId, after) =>
      messages.filter((item) => item.threadId === threadId && item.sequence > after)),
    bumpEpoch: vi.fn(async () => {
      epoch += 1;
      running = true;
      return epoch;
    }),
    readEpoch: vi.fn(async () => epoch),
    setRunning: vi.fn(async (_roomId, expectedEpoch, value) => {
      if (epoch === expectedEpoch) running = value;
    }),
    setNeedsUser: vi.fn(async (_roomId, value) => {
      needsUser = value;
    }),
    advanceWatermark: vi.fn(async (_roomId, botId, _threadId, value) => {
      watermarks.set(botId, Math.max(watermarks.get(botId) ?? 0, value));
    }),
    updateMemberHolds: vi.fn(async () => undefined),
    markHoldNoted: vi.fn(async () => undefined),
    clearStranded: vi.fn(async () => undefined),
    runMemberTurn: vi.fn(async ({ member, prompt, files }) => {
      calls.push({ botId: member.botId, prompt });
      return {
        status: 'completed' as const,
        reply: await replies({ botId: member.botId, prompt, call: calls.length, files }),
      };
    }),
  };

  return {
    coordinator: createBotGroupChatCoordinator(deps),
    calls,
    messages,
    watermarks,
    get epoch() { return epoch; },
    get needsUser() { return needsUser; },
  };
}

describe('botGroupChatCoordinator', () => {
  it('settles after one all-pass round and persists only the real room user message', async () => {
    const h = createHarness(() => '(pass)');
    const sent = await h.coordinator.sendUserMessage('room-1', 'FYI, deploy is done', { threadId: 'thread-1' });
    await sent.completion;
    expect(h.calls.map((call) => call.botId)).toEqual(['research', 'builder', 'ops']);
    expect(h.messages.map((item) => item.text)).toEqual(['FYI, deploy is done']);
  });

  it('lets a member mention pull another Bot into the next round', async () => {
    const h = createHarness(({ botId, prompt }) => {
      if (botId === 'research' && !prompt.includes('Research (you)')) {
        return 'I found the cause. @builder can implement it.';
      }
      if (botId === 'builder') return 'On it.';
      return '(pass)';
    });
    const sent = await h.coordinator.sendUserMessage('room-1', '@research thoughts?', { threadId: 'thread-1' });
    await sent.completion;
    expect(h.messages.some((item) => item.sender.kind === 'bot' && item.sender.botId === 'research')).toBe(true);
    expect(h.messages.some((item) => item.sender.kind === 'bot' && item.sender.botId === 'builder')).toBe(true);
  });

  it('caps chatty rooms at ten Bot messages across three rounds', async () => {
    const h = createHarness(({ call }) => `message ${call} @everyone`);
    const sent = await h.coordinator.sendUserMessage('room-1', 'go', { threadId: 'thread-1' });
    await sent.completion;
    expect(h.messages.filter((item) => item.sender.kind === 'bot')).toHaveLength(9);
    expect(h.calls).toHaveLength(9);
  });

  it('treats a failed or timed-out member turn as pass instead of a room error', async () => {
    const h = createHarness(({ botId }) => {
      if (botId === 'builder') throw new Error('gateway unavailable');
      return null;
    });
    const sent = await h.coordinator.sendUserMessage('room-1', 'anyone around?', { threadId: 'thread-1' });
    await expect(sent.completion).resolves.toBeUndefined();
    expect(h.messages).toHaveLength(1);
  });

  it('delivers the same real attachment delta independently to every responding member', async () => {
    const received = new Map<string, BotGroupRoomMessage['files']>();
    const h = createHarness(({ botId, files }) => {
      received.set(botId, files);
      return '(pass)';
    });
    const files = [
      { id: 'image-1', name: 'diagram.png', originalName: 'diagram.png', path: '/tmp/diagram.png', ext: 'png', size: 10, category: 'image' as const, mimeType: 'image/png', url: 'file:///tmp/diagram.png' },
      { id: 'pdf-1', name: 'brief.pdf', path: '/tmp/brief.pdf', ext: 'pdf', size: 20, category: 'pdf' as const, mimeType: 'application/pdf' },
      { id: 'text-1', name: 'notes.txt', path: '/tmp/notes.txt', ext: 'txt', size: 30, category: 'text' as const, mimeType: 'text/plain' },
    ];

    await (await h.coordinator.sendUserMessage('room-1', 'review these', { threadId: 'thread-1', files })).completion;

    expect(received.get('research')).toEqual(files);
    expect(received.get('builder')).toEqual(files);
    expect(received.get('ops')).toEqual(files);
    expect(received.get('research')).not.toBe(received.get('builder'));
  });

  it('keeps the room progressing when one member fails while another consumes the attachment', async () => {
    const h = createHarness(({ botId, files }) => {
      if (botId === 'builder') throw new Error('member unavailable');
      return botId === 'research' && files?.[0]?.name === 'brief.pdf' ? 'Reviewed.' : '(pass)';
    });
    const sent = await h.coordinator.sendUserMessage('room-1', 'review', {
      threadId: 'thread-1',
      files: [{ id: 'pdf-1', name: 'brief.pdf', path: '/tmp/brief.pdf', ext: 'pdf', size: 20, category: 'pdf', mimeType: 'application/pdf' }],
    });

    await expect(sent.completion).resolves.toBeUndefined();
    expect(h.messages.map((message) => message.text)).toEqual(['review', 'Reviewed.']);
  });

  it('advances per-member watermarks so a later send injects only unseen room messages', async () => {
    const prompts: string[] = [];
    const h = createHarness(({ botId, prompt }) => {
      if (botId === 'research') prompts.push(prompt);
      return '(pass)';
    });
    await (await h.coordinator.sendUserMessage('room-1', 'first', { threadId: 'thread-1' })).completion;
    await (await h.coordinator.sendUserMessage('room-1', 'second', { threadId: 'thread-1' })).completion;
    expect(prompts[1]).toContain('second');
    expect(prompts[1]).not.toContain('(user): first');
  });

  it('marks needs-you when a real Bot reply mentions @user', async () => {
    const h = createHarness(({ botId }) => botId === 'research' ? 'Blocked — @user choose an account.' : '(pass)');
    const sent = await h.coordinator.sendUserMessage('room-1', '@research handle invoices', { threadId: 'thread-1' });
    await sent.completion;
    expect(h.messages.find((item) => item.sender.kind === 'bot')?.text).toContain('@user');
    expect(sent.needsUser()).toBe(true);
    expect(h.needsUser).toBe(true);
  });

  it('supersedes an old epoch at the next member boundary while retaining its late reply', async () => {
    let release!: (value: string) => void;
    const firstReply = new Promise<string>((resolve) => { release = resolve; });
    const h = createHarness(({ call }) => call === 1 ? firstReply : '(pass)');
    const first = await h.coordinator.sendUserMessage('room-1', 'first', { threadId: 'thread-1' });
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    const second = await h.coordinator.sendUserMessage('room-1', 'second', { threadId: 'thread-1' });
    release('late but useful');
    await Promise.all([first.completion, second.completion]);
    expect(h.messages.map((item) => item.text)).toContain('late but useful');
    expect(h.calls.filter((call) => call.prompt.includes('(user): second')).length).toBeGreaterThan(0);
  });
});
