import { describe, expect, it } from 'vitest';

import { parseDesktopLoginAction } from '../authIpc';

describe('desktop auth IPC validation', () => {
  it('projects recognized actions onto their typed fields', () => {
    expect(
      parseDesktopLoginAction({
        type: 'start-browser',
        kind: 'sso',
        providerOrConnectionId: 'connection-id',
        label: 'Company SSO',
        ignored: 'renderer-controlled extra field',
      }),
    ).toEqual({
      type: 'start-browser',
      kind: 'sso',
      providerOrConnectionId: 'connection-id',
      label: 'Company SSO',
    });
  });

  it('rejects unknown, incomplete, and oversized actions', () => {
    expect(parseDesktopLoginAction(null)).toBeNull();
    expect(parseDesktopLoginAction({ type: 'unknown' })).toBeNull();
    expect(parseDesktopLoginAction({ type: 'verify-code', kind: 'email' })).toBeNull();
    expect(
      parseDesktopLoginAction({
        type: 'discover',
        email: 'a'.repeat(321),
      }),
    ).toBeNull();
    expect(
      parseDesktopLoginAction({
        type: 'discover-sso-org',
        org: 'a'.repeat(65),
      }),
    ).toBeNull();
    expect(parseDesktopLoginAction({ type: 'discover-sso-org', org: '' })).toBeNull();
  });

  it('accepts each non-browser action shape', () => {
    expect(parseDesktopLoginAction({ type: 'reset' })).toEqual({ type: 'reset' });
    expect(parseDesktopLoginAction({ type: 'cancel-browser' })).toEqual({
      type: 'cancel-browser',
    });
    expect(parseDesktopLoginAction({ type: 'discover', email: 'user@example.com' })).not.toBeNull();
    expect(
      parseDesktopLoginAction({ type: 'discover-sso-org', org: 'acme', extra: 'x' }),
    ).toEqual({ type: 'discover-sso-org', org: 'acme' });
    expect(
      parseDesktopLoginAction({
        type: 'request-code',
        kind: 'phone',
        identifier: '+8613800000000',
      }),
    ).not.toBeNull();
    expect(
      parseDesktopLoginAction({
        type: 'verify-code',
        kind: 'email',
        identifier: 'user@example.com',
        code: '123456',
      }),
    ).not.toBeNull();
    expect(
      parseDesktopLoginAction({ type: 'select-account', accountId: 'account-id' }),
    ).not.toBeNull();
    expect(
      parseDesktopLoginAction({
        type: 'request-binding-code',
        contact: 'user@example.com',
      }),
    ).not.toBeNull();
    expect(
      parseDesktopLoginAction({
        type: 'verify-binding',
        contact: 'user@example.com',
        code: '123456',
      }),
    ).not.toBeNull();
  });
});
