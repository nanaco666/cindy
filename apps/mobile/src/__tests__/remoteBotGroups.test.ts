import { describe, expect, it } from 'vitest';

import {
  normalizeRemoteBotGroupRoom,
  normalizeRemoteBotGroupRooms,
  normalizeRemoteBotGroupMessages,
  resolveRemoteBotGroupInteraction,
  remoteBotGroupsUnsupported,
} from '@/bots/remoteBotGroups';

describe('remote Bot group projection', () => {
  it('keeps only valid room and member fields from the device-link boundary', () => {
    expect(normalizeRemoteBotGroupRooms([{
      id: 'room-1',
      name: 'Release room',
      avatar: '🛰️',
      roomSessionId: 'session-room',
      status: 'active',
      epoch: 4,
      running: true,
      needsUser: false,
      createdAt: 10,
      updatedAt: 20,
      members: [
        { botId: 'bot-a', name: 'Ashu', sessionId: 'member-a', watermark: 3, secret: 'drop' },
        { botId: '', name: 'invalid', sessionId: 'x' },
      ],
      interactions: [
        {
          sessionId: 'member-a',
          botId: 'bot-a',
          botName: 'Ashu',
          request: { kind: 'permission', requestId: 'permission-1', toolName: 'Bash' },
          persistId: 'persist-1',
          secret: 'drop',
        },
        { sessionId: 'member-a', botId: 'bot-a', botName: 'Ashu', request: { kind: 'future', requestId: 'x' } },
      ],
      transcript: ['must not cross'],
    }])).toEqual([{
      id: 'room-1',
      name: 'Release room',
      avatar: '🛰️',
      roomSessionId: 'session-room',
      status: 'active',
      epoch: 4,
      running: true,
      needsUser: false,
      createdAt: 10,
      updatedAt: 20,
      members: [{ botId: 'bot-a', name: 'Ashu', sessionId: 'member-a', watermark: 3 }],
      interactions: [{
        sessionId: 'member-a',
        botId: 'bot-a',
        botName: 'Ashu',
        request: { kind: 'permission', requestId: 'permission-1', toolName: 'Bash' },
        persistId: 'persist-1',
      }],
    }]);
  });

  it('fails closed for malformed rooms and unknown status values', () => {
    expect(normalizeRemoteBotGroupRoom({ id: '', name: 'bad' })).toBeNull();
    expect(normalizeRemoteBotGroupRoom({
      id: 'room', name: 'Room', roomSessionId: 's', status: 'future', members: [],
    })?.status).toBe('error');
  });

  it('reads group messages from normal Cindy message rows and ignores unrelated rows', () => {
    expect(normalizeRemoteBotGroupMessages([
      {
        id: 'm1', role: 'assistant', content: 'I can take it.', createdAt: '2026-08-24T00:00:00Z',
        agentMeta: { botGroup: { roomId: 'room-1', threadId: 'thread-a', senderKind: 'bot', botId: 'bot-a', name: 'Ashu' } },
      },
      {
        id: 'm2', role: 'user', content: { text: 'Please coordinate.' }, createdAt: '2026-08-24T00:00:01Z',
        agentMeta: { botGroup: { roomId: 'room-1', threadId: 'thread-b', senderKind: 'user', name: 'You' } },
      },
      {
        id: 'm-files', role: 'user', content: {
          text: '',
          botGroupFiles: [{ name: 'screen.png' }, { name: '' }, { id: 'missing-name' }],
        }, createdAt: '2026-08-24T00:00:02Z',
        agentMeta: { botGroup: { roomId: 'room-1', threadId: 'thread-c', senderKind: 'user', name: 'You' } },
      },
      { id: 'm3', role: 'assistant', content: 'ordinary', agentMeta: null },
    ], 'room-1')).toEqual([
      { id: 'm1', kind: 'bot', botId: 'bot-a', name: 'Ashu', text: 'I can take it.', attachments: [], threadId: 'thread-a', createdAt: '2026-08-24T00:00:00Z' },
      { id: 'm2', kind: 'user', name: 'You', text: 'Please coordinate.', attachments: [], threadId: 'thread-b', createdAt: '2026-08-24T00:00:01Z' },
      { id: 'm-files', kind: 'user', name: 'You', text: '', attachments: ['screen.png'], threadId: 'thread-c', createdAt: '2026-08-24T00:00:02Z' },
    ]);
  });

  it('uses the same explicit old-device downgrade as the Bot list', () => {
    expect(remoteBotGroupsUnsupported(Object.assign(new Error('old'), { code: 'CHANNEL_NOT_ALLOWED' }))).toBe(true);
    expect(remoteBotGroupsUnsupported(new Error('DEVICE_OFFLINE'))).toBe(false);
  });

  it('treats a void IPC resolution as success and lets stale requests reject', async () => {
    const invoke = async () => undefined;
    await expect(resolveRemoteBotGroupInteraction(
      invoke,
      'device-1',
      'room-1',
      'request-1',
      { kind: 'permission', behavior: 'allow' },
    )).resolves.toBeUndefined();

    const stale = Object.assign(new Error('stale'), { code: 'PRECONDITION_FAILED' });
    await expect(resolveRemoteBotGroupInteraction(
      async () => { throw stale; },
      'device-1',
      'room-1',
      'request-1',
      { kind: 'permission', behavior: 'deny' },
    )).rejects.toBe(stale);
  });
});
