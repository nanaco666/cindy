import { describe, expect, it } from 'vitest';

import {
  applyImMutualExclusion,
  botChannelDisplayName,
  buildBotChannelChips,
} from '../botChannelChips';
import type { BotChannelConnection } from '../botStore';

function connection(overrides: Partial<BotChannelConnection> = {}): BotChannelConnection {
  return {
    id: 'conn-1',
    kind: 'feishu',
    ownership: 'local-adapter',
    status: 'connected',
    connected: true,
    accountKey: 'acct-1',
    accountName: 'Work Feishu',
    scopeKey: null,
    routable: true,
    features: [],
    ...overrides,
  };
}

describe('capability wall channel chips', () => {
  it('returns no chip when the runtime reports no connection', () => {
    expect(buildBotChannelChips([], () => false)).toEqual([]);
  });

  it('maps a real account to one flippable chip', () => {
    const feishu = connection();
    const chips = buildBotChannelChips([feishu], (item) => item.id === 'conn-1');

    const chip = chips.find((item) => item.kind === 'feishu');
    expect(chip).toMatchObject({
      id: 'conn-1',
      accountLabel: 'Work Feishu',
      mounted: true,
      disabled: false,
    });
    expect(chips).toHaveLength(1);
  });

  it('keeps a non-routable account visible but not flippable', () => {
    const chips = buildBotChannelChips([connection({ routable: false })], () => false);
    expect(chips.find((chip) => chip.kind === 'feishu')?.disabled).toBe(true);
  });

  it('lists several accounts of the same channel, mounted ones first', () => {
    const chips = buildBotChannelChips(
      [
        connection({ id: 'a', accountKey: 'a', accountName: 'Alpha' }),
        connection({ id: 'b', accountKey: 'b', accountName: 'Beta' }),
      ],
      (item) => item.id === 'b',
    );

    expect(chips.slice(0, 2).map((chip) => chip.id)).toEqual(['b', 'a']);
  });

  it('names channels the same way the Channels tab does', () => {
    expect(botChannelDisplayName('feishu')).toBe('Feishu');
    expect(botChannelDisplayName('telegram')).toBe('Telegram');
  });
});

describe('single-IM mutual exclusion', () => {
  it('blocks no chip when nothing is mounted', () => {
    const chips = buildBotChannelChips([], () => false);
    const gated = applyImMutualExclusion(chips);
    expect(gated.every((chip) => chip.blockedByImKind == null)).toBe(true);
  });

  it('greys out every other IM row once one is mounted', () => {
    const feishu = connection({ kind: 'feishu' });
    const chips = buildBotChannelChips([feishu], (item) => item.id === 'conn-1');
    const gated = applyImMutualExclusion(chips);

    const feishuChip = gated.find((chip) => chip.kind === 'feishu');
    expect(feishuChip?.blockedByImKind).toBeNull();
    expect(feishuChip?.mounted).toBe(true);

    for (const chip of gated) {
      if (chip.kind === 'feishu') continue;
      expect(chip.blockedByImKind).toBe('feishu');
    }
  });

  it('never blocks a chip that is itself mounted, even for a pre-existing multi-IM bot', () => {
    const feishu = connection({ id: 'a', kind: 'feishu', accountKey: 'a' });
    const telegram = connection({ id: 'b', kind: 'telegram', accountKey: 'b' });
    const chips = buildBotChannelChips(
      [feishu, telegram],
      (item) => item.id === 'a' || item.id === 'b',
    );
    const gated = applyImMutualExclusion(chips);

    expect(gated.find((chip) => chip.kind === 'feishu')?.blockedByImKind).toBeNull();
    expect(gated.find((chip) => chip.kind === 'telegram')?.blockedByImKind).toBeNull();
    expect(gated).toHaveLength(2);
  });

  it('does not use non-IM channels as blockers or block them behind an IM mount', () => {
    const x = connection({ id: 'x', kind: 'x', accountKey: 'x' });
    const feishu = connection({ id: 'im', kind: 'feishu', accountKey: 'im' });

    const xMounted = applyImMutualExclusion(
      buildBotChannelChips([x, feishu], (item) => item.id === 'x'),
    );
    expect(xMounted.every((chip) => chip.blockedByImKind == null)).toBe(true);

    const imMounted = applyImMutualExclusion(
      buildBotChannelChips([x, feishu], (item) => item.id === 'im'),
    );
    expect(imMounted.find((chip) => chip.kind === 'x')?.blockedByImKind).toBeNull();
  });
});
