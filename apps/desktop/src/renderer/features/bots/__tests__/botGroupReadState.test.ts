// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getBotGroupLastReadAt,
  markBotGroupRead,
  resetBotGroupReadStateForTests,
  seedMissingBotGroupReadState,
  setBotGroupReadStateOwner,
  subscribeBotGroupReadState,
} from '../botGroupReadState';

describe('Bot group read state', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetBotGroupReadStateForTests();
    setBotGroupReadStateOwner('owner-1');
  });

  it('keeps room read positions monotonic and owner-scoped', () => {
    expect(markBotGroupRead('room-1', 5_000)).toBe(true);
    expect(markBotGroupRead('room-1', 4_000)).toBe(false);
    expect(getBotGroupLastReadAt('room-1')).toBe(5_000);

    setBotGroupReadStateOwner('owner-2');
    expect(getBotGroupLastReadAt('room-1')).toBeNull();
  });

  it('seeds existing rooms without overwriting a prior read position', () => {
    markBotGroupRead('room-1', 1_000);
    expect(seedMissingBotGroupReadState(['room-1', 'room-2'], 2_000)).toBe(true);
    expect(getBotGroupLastReadAt('room-1')).toBe(1_000);
    expect(getBotGroupLastReadAt('room-2')).toBe(2_000);
  });

  it('notifies sidebar subscribers when a room becomes read', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBotGroupReadState(listener);
    markBotGroupRead('room-1', 1_000);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
