import { describe, expect, it } from 'vitest';

import {
  BOT_GROUP_MAX_MEMBERS,
  BOT_GROUP_MAX_MESSAGES,
  BOT_GROUP_MAX_ROUNDS,
  BOT_GROUP_TURN_HARD_TIMEOUT_MS,
  BOT_GROUP_TURN_TIMEOUT_MS,
  botGroupHoldDirective,
  buildBotGroupTurnPrompt,
  isBotGroupPassText,
  parseBotGroupInteractionDecision,
  parseBotGroupMentions,
  resolveBotGroupResponders,
  rotateBotGroupResponders,
  validateBotGroupMembers,
  type BotGroupMember,
  type BotGroupRoomMessage,
} from '../botGroupChat';

const MEMBERS: BotGroupMember[] = [
  { botId: 'research', name: 'Research' },
  { botId: 'builder', name: 'Builder' },
  { botId: 'ops', name: 'Ops', title: 'The Ops' },
];

function message(
  sequence: number,
  text: string,
  sender: BotGroupRoomMessage['sender'] = { kind: 'user', name: 'You' },
  threadId = 'thread-1',
): BotGroupRoomMessage {
  return { id: `m-${sequence}`, sequence, threadId, sender, text, createdAt: sequence };
}

describe('Hermes-compatible Bot group chat policy', () => {
  it('keeps the exact bounded execution limits', () => {
    expect(BOT_GROUP_MAX_MEMBERS).toBe(6);
    expect(BOT_GROUP_MAX_ROUNDS).toBe(3);
    expect(BOT_GROUP_MAX_MESSAGES).toBe(10);
    expect(BOT_GROUP_TURN_TIMEOUT_MS).toBe(180_000);
    expect(BOT_GROUP_TURN_HARD_TIMEOUT_MS).toBe(20 * 60_000);
  });

  it('accepts 2-6 unique members and rejects invalid rosters', () => {
    expect(validateBotGroupMembers(MEMBERS)).toEqual({ ok: true });
    expect(validateBotGroupMembers([MEMBERS[0]])).toMatchObject({ ok: false });
    expect(
      validateBotGroupMembers(
        Array.from({ length: BOT_GROUP_MAX_MEMBERS + 1 }, (_, index) => ({
          botId: `bot-${index}`,
          name: `Bot ${index}`,
        })),
      ),
    ).toMatchObject({ ok: false });
    expect(validateBotGroupMembers([MEMBERS[0], MEMBERS[0]])).toMatchObject({ ok: false });
  });

  it('treats empty/pass variants as silence without hiding real sentences', () => {
    expect(isBotGroupPassText('')).toBe(true);
    expect(isBotGroupPassText('(pass)')).toBe(true);
    expect(isBotGroupPassText(' Pass. ')).toBe(true);
    expect(isBotGroupPassText('I will pass this to Ops')).toBe(false);
  });

  it('routes by stable bot id, name, display title and collapsed forms', () => {
    const parsed = parseBotGroupMentions(
      '@builder please pair with @theops; ask @user only if blocked',
      MEMBERS,
    );
    expect([...parsed.botIds]).toEqual(['builder', 'ops']);
    expect(parsed.everyone).toBe(false);
    expect(parsed.needsUser).toBe(true);
  });

  it('uses all members when there is no mention or @everyone, otherwise only mentions', () => {
    expect(resolveBotGroupResponders([message(1, 'hello team')], MEMBERS)).toEqual(MEMBERS);
    expect(resolveBotGroupResponders([message(1, '@everyone standup')], MEMBERS)).toEqual(MEMBERS);
    expect(resolveBotGroupResponders([message(1, '@builder take this')], MEMBERS)).toEqual([
      MEMBERS[1],
    ]);
  });

  it('lets a bot mention pull another member into the next round', () => {
    const log = [
      message(1, '@research thoughts?'),
      message(2, 'I found the cause. @builder can implement it.', {
        kind: 'bot',
        botId: 'research',
        name: 'Research',
      }),
    ];
    expect(resolveBotGroupResponders(log, MEMBERS).map((member) => member.botId)).toEqual([
      'research',
      'builder',
    ]);
  });

  it('rotates the speaker that leads each round without changing membership', () => {
    expect(rotateBotGroupResponders(MEMBERS, 0).map((member) => member.botId)).toEqual([
      'research',
      'builder',
      'ops',
    ]);
    expect(rotateBotGroupResponders(MEMBERS, 1).map((member) => member.botId)).toEqual([
      'builder',
      'ops',
      'research',
    ]);
  });

  it('keeps stop holds room-wide and releases them on resume or a direct mention', () => {
    expect([...botGroupHoldDirective('stop @builder', MEMBERS).holdBotIds]).toEqual(['builder']);
    expect([...botGroupHoldDirective('@builder resume', MEMBERS).releaseBotIds]).toEqual(['builder']);
    expect([...botGroupHoldDirective('@builder any update?', MEMBERS).releaseBotIds]).toEqual(['builder']);
    expect([...botGroupHoldDirective('@everyone stop', MEMBERS).holdBotIds]).toEqual([
      'research',
      'builder',
      'ops',
    ]);
  });

  it('builds a delta-only turn payload and keeps room rules outside SOUL', () => {
    const prompt = buildBotGroupTurnPrompt({
      roomName: 'Release room',
      members: MEMBERS,
      viewer: MEMBERS[1],
      messages: [
        message(4, 'new question'),
        message(5, 'Research result', { kind: 'bot', botId: 'research', name: 'Research' }),
      ],
    });
    expect(prompt).toContain('[Group chat: "Release room"]');
    expect(prompt).toContain('You (user): new question');
    expect(prompt).toContain('Research: Research result');
    expect(prompt).toContain('reply with exactly "(pass)"');
    expect(prompt).toContain('give it at full quality and length');
    expect(prompt).not.toContain('ONE short conversational message (1-3 sentences)');
    expect(prompt).not.toContain('old message');
  });

  it('names image, PDF and ordinary file attachments in the turn payload', () => {
    const withFiles = message(1, '', { kind: 'user', name: 'You' });
    withFiles.files = [
      { id: 'image', name: 'screen.png', path: '/tmp/screen.png', ext: 'png', size: 1, category: 'image', mimeType: 'image/png' },
      { id: 'pdf', name: 'spec.pdf', path: '/tmp/spec.pdf', ext: 'pdf', size: 2, category: 'pdf', mimeType: 'application/pdf' },
      { id: 'file', name: 'notes.txt', path: '/tmp/notes.txt', ext: 'txt', size: 3, category: 'text', mimeType: 'text/plain' },
    ];
    const prompt = buildBotGroupTurnPrompt({
      roomName: 'Files',
      members: MEMBERS,
      viewer: MEMBERS[0],
      messages: [withFiles],
    });
    expect(prompt).toContain('[attached image: screen.png]');
    expect(prompt).toContain('[attached PDF: spec.pdf]');
    expect(prompt).toContain('[attached file: notes.txt]');
  });

  it('accepts only the three existing Session interaction decision shapes', () => {
    expect(parseBotGroupInteractionDecision({
      kind: 'permission',
      behavior: 'allow',
      permissionUpdates: [],
    })).toEqual({ kind: 'permission', behavior: 'allow', permissionUpdates: [] });
    expect(parseBotGroupInteractionDecision({
      kind: 'ask_user_question',
      answers: { Region: 'Global' },
    })).toEqual({ kind: 'ask_user_question', answers: { Region: 'Global' } });
    expect(parseBotGroupInteractionDecision({
      kind: 'plan_review',
      behavior: 'deny',
      reason: 'Please revise step 2',
    })).toEqual({ kind: 'plan_review', behavior: 'deny', reason: 'Please revise step 2' });
  });

  it('fails closed for malformed, mismatched or unknown interaction decisions', () => {
    expect(parseBotGroupInteractionDecision(null)).toBeNull();
    expect(parseBotGroupInteractionDecision({ kind: 'permission', behavior: 'always' })).toBeNull();
    expect(parseBotGroupInteractionDecision({ kind: 'ask_user_question', answers: [] })).toBeNull();
    expect(parseBotGroupInteractionDecision({ kind: 'ask_user_question', answers: { Region: 1 } })).toBeNull();
    expect(parseBotGroupInteractionDecision({ kind: 'plan_review', behavior: 'allow', dismissed: 'yes' })).toBeNull();
    expect(parseBotGroupInteractionDecision({ kind: 'plugin_setup', behavior: 'allow' })).toBeNull();
  });
});
