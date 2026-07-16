import { describe, expect, it } from 'vitest';

import { resolveMicrophonePermissionSnapshot } from '../permissions.js';

describe('resolveMicrophonePermissionSnapshot', () => {
  it('trusts a renderer-side getUserMedia verification while macOS status is still inconclusive', () => {
    expect(resolveMicrophonePermissionSnapshot('not-determined', true)).toEqual({
      ok: true,
      status: 'not-determined',
    });
    expect(resolveMicrophonePermissionSnapshot('unknown', true)).toEqual({
      ok: true,
      status: 'unknown',
    });
  });

  it('does not let a stale renderer verification override an explicit macOS denial', () => {
    expect(resolveMicrophonePermissionSnapshot('denied', true)).toEqual({
      ok: false,
      status: 'denied',
      error: 'Microphone permission is required for voice input. Enable it in macOS System Settings.',
    });
    expect(resolveMicrophonePermissionSnapshot('restricted', true)).toEqual({
      ok: false,
      status: 'restricted',
      error: 'Microphone permission is required for voice input. Enable it in macOS System Settings.',
    });
  });
});
