import { describe, expect, it } from 'vitest';

import {
  createAuthBrowserAuthorizationSlot,
  parseAuthLoopbackCallback,
} from '../authLoopbackCallback';

describe('auth loopback callback', () => {
  it('accepts an authorization code only for the expected state', () => {
    expect(
      parseAuthLoopbackCallback('/auth/callback?code=auth-code&state=expected', 'expected'),
    ).toEqual({ code: 'auth-code' });

    expect(
      parseAuthLoopbackCallback('/auth/callback?code=auth-code&state=unexpected', 'expected'),
    ).toEqual({ error: 'STATE_MISMATCH' });
  });

  it('propagates provider errors after state validation', () => {
    expect(
      parseAuthLoopbackCallback('/auth/callback?error=access_denied&state=expected', 'expected'),
    ).toEqual({ error: 'access_denied' });
  });

  it('rejects incomplete callbacks and ignores unrelated paths', () => {
    expect(parseAuthLoopbackCallback('/auth/callback?state=expected', 'expected')).toEqual({
      error: 'INVALID_AUTH_CODE',
    });
    expect(parseAuthLoopbackCallback('/health', 'expected')).toBeNull();
    expect(parseAuthLoopbackCallback(undefined, 'expected')).toBeNull();
  });
});

describe('auth browser authorization cancellation slot', () => {
  it('cancels the active attempt once', () => {
    const slot = createAuthBrowserAuthorizationSlot();
    let cancellations = 0;
    slot.activate(() => {
      cancellations += 1;
    });

    expect(slot.cancelActive()).toBe(true);
    expect(slot.cancelActive()).toBe(false);
    expect(cancellations).toBe(1);
  });

  it('does not let an older cleanup clear a newer attempt', () => {
    const slot = createAuthBrowserAuthorizationSlot();
    const deactivateOlder = slot.activate(() => undefined);
    let newerCancelled = false;
    slot.activate(() => {
      newerCancelled = true;
    });

    deactivateOlder();
    expect(slot.cancelActive()).toBe(true);
    expect(newerCancelled).toBe(true);
  });
});
