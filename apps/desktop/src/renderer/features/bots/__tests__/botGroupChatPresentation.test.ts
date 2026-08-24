import { describe, expect, it } from 'vitest';

import {
  botGroupRoomState,
  presentBotGroupMessage,
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

  it('prioritizes needs-user over running and keeps terminal states explicit', () => {
    expect(botGroupRoomState({ status: 'active', running: true, needsUser: true }))
      .toBe('needs-user');
    expect(botGroupRoomState({ status: 'active', running: true, needsUser: false }))
      .toBe('running');
    expect(botGroupRoomState({ status: 'error', running: false, needsUser: false }))
      .toBe('error');
  });
});
