import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureItems = vi.hoisted(() => new Map<string, string>());

vi.mock('@/auth/secureStorage', () => ({
  getSecureItem: vi.fn(async (key: string) => secureItems.get(key) ?? null),
  setSecureItem: vi.fn(async (key: string, value: string) => {
    secureItems.set(key, value);
  }),
  deleteSecureItem: vi.fn(async (key: string) => {
    secureItems.delete(key);
  }),
}));

import {
  __testing,
  getMobileVoiceServiceMode,
  setMobileVoiceServiceMode,
} from '@/session/mobileVoiceServiceMode';

describe('mobileVoiceServiceMode', () => {
  beforeEach(() => {
    secureItems.clear();
  });

  it('defaults to the managed cindy mode when nothing is stored', async () => {
    await expect(getMobileVoiceServiceMode()).resolves.toBe('cindy');
  });

  it('round-trips an explicit byok override', async () => {
    await setMobileVoiceServiceMode('byok');
    await expect(getMobileVoiceServiceMode()).resolves.toBe('byok');
    expect(secureItems.get(__testing.storageKey)).toBe('byok');
  });

  it('selecting the default clears the override instead of snapshotting it', async () => {
    await setMobileVoiceServiceMode('byok');
    await setMobileVoiceServiceMode('cindy');
    expect(secureItems.has(__testing.storageKey)).toBe(false);
    await expect(getMobileVoiceServiceMode()).resolves.toBe('cindy');
  });

  it('falls back to cindy for unknown stored values', async () => {
    secureItems.set(__testing.storageKey, 'mystery');
    await expect(getMobileVoiceServiceMode()).resolves.toBe('cindy');
  });
});
