import { describe, expect, it } from 'vitest';

import { buildBotReferenceHref } from '@cindy/maker-shared/agent-input-projection';

import {
  botGroupRoomState,
  normalizeBotGroupReferences,
  presentBotGroupMessage,
  presentedRoomMessages,
} from '../botGroupChatPresentation';

describe('Bot group chat presentation', () => {
  it('reads the durable sender identity from message agent metadata', () => {
    expect(
      presentBotGroupMessage({
        role: 'assistant',
        content: '我来查日志。',
        agentMeta: {
          botGroup: { roomId: 'room-1', threadId: 'thread-1', senderKind: 'bot', botId: 'bot-a', name: '小柴' },
        },
      }),
    ).toEqual({ kind: 'bot', botId: 'bot-a', name: '小柴', text: '我来查日志。', threadId: 'thread-1', attachments: [] });
  });

  it('keeps user messages distinct and drops unrelated Session rows', () => {
    expect(
      presentBotGroupMessage({
        role: 'user',
        content: '你们一起看看。',
        agentMeta: { botGroup: { roomId: 'room-1', threadId: 'thread-2', senderKind: 'user', name: 'You' } },
      }),
    ).toEqual({ kind: 'user', name: 'You', text: '你们一起看看。', threadId: 'thread-2', attachments: [] });
    expect(presentBotGroupMessage({ role: 'assistant', content: '普通消息', agentMeta: null }))
      .toBeNull();
  });

  it('keeps attachment-only room messages visible with their file names', () => {
    expect(presentBotGroupMessage({
      role: 'user',
      content: {
        text: '',
        botGroupFiles: [
          { id: 'image', name: 'screen.png', path: '/tmp/screen.png', category: 'image', mimeType: 'image/png' },
          { id: 'pdf', name: 'spec.pdf', path: '/tmp/spec.pdf', category: 'pdf', mimeType: 'application/pdf' },
        ],
      },
      agentMeta: { botGroup: { roomId: 'room-1', threadId: 'thread-files', senderKind: 'user', name: 'You' } },
    })).toEqual({
      kind: 'user',
      name: 'You',
      text: '',
      threadId: 'thread-files',
      attachments: ['screen.png', 'spec.pdf'],
    });
  });

  it('restores oldest-first order when local message listing is newest-first', () => {
    const message = (id: string, rowid: number, text: string) => ({
      id,
      rowid,
      clientId: id,
      sessionId: 'room-session',
      role: 'user',
      content: text,
      toolUseId: null,
      agentMeta: { botGroup: { senderKind: 'user', name: 'You', threadId: 'thread-1' } },
      createdAt: `2026-01-01T00:00:0${rowid}.000Z`,
    });
    expect(presentedRoomMessages([
      message('new', 2, 'second'),
      message('old', 1, 'first'),
    ] as never).map((item) => item.value.text)).toEqual(['first', 'second']);
  });

  it('turns selected Bot chips into group-recognizable @mentions', () => {
    const href = buildBotReferenceHref('bot-b');
    expect(normalizeBotGroupReferences(
      `[Beta](${href}) please check`,
      [{ kind: 'bot', start: 0, end: `[Beta](${href})`.length, href, botId: 'bot-b', name: 'Beta' }],
      [{ id: 'bot-b', name: 'Beta' }],
    )).toBe('@Beta please check');
    expect(normalizeBotGroupReferences(
      'hello',
      [{ kind: 'session', start: 0, end: 5, href: 'cindy://session/x', sessionId: 'x', title: 'x' }],
      [{ id: 'bot-b', name: 'Beta' }],
    )).toBeNull();
  });

  it('prioritizes needs-user over running and keeps terminal states explicit', () => {
    expect(botGroupRoomState({ status: 'active', running: true, needsUser: true }))
      .toBe('needs-user');
    expect(botGroupRoomState({ status: 'active', running: true, needsUser: false }))
      .toBe('running');
    expect(botGroupRoomState({ status: 'error', running: false, needsUser: false }))
      .toBe('error');
  });
});
