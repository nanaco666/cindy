import { describe, expect, it } from 'vitest';
import { DEFAULT_API_BASE_URL } from '@/config/env';
import {
  matchesOAuthCallbackUrl,
  parseOAuthCallbackUrl,
} from '@/auth/oauthCallback';

describe('parseOAuthCallbackUrl', () => {
  it('extracts code and state from callback URL', () => {
    expect(parseOAuthCallbackUrl(`${DEFAULT_API_BASE_URL}/api/auth/callback?code=c1&state=s1`)).toEqual({
      code: 'c1',
      state: 's1',
    });
  });

  it('extracts code and state from app deep link', () => {
    expect(parseOAuthCallbackUrl('cindycn://auth?code=c1&state=cn.s1')).toEqual(
      {
        code: 'c1',
        state: 'cn.s1',
      },
    );
  });

  it('rejects OAuth error callbacks', () => {
    expect(() =>
      parseOAuthCallbackUrl(
        `${DEFAULT_API_BASE_URL}/api/auth/callback?error=access_denied&state=s1`,
      ),
    ).toThrow('access_denied');
  });

  it('requires both code and state', () => {
    expect(() =>
      parseOAuthCallbackUrl(
        `${DEFAULT_API_BASE_URL}/api/auth/callback?state=s1`,
      ),
    ).toThrow('INVALID_AUTH_CODE');
    expect(() =>
      parseOAuthCallbackUrl(
        `${DEFAULT_API_BASE_URL}/api/auth/callback?code=c1`,
      ),
    ).toThrow('STATE_MISMATCH');
  });
});

describe('matchesOAuthCallbackUrl', () => {
  it('accepts the configured callback with variable query parameters', () => {
    expect(
      matchesOAuthCallbackUrl(
        'cindycn://auth/?code=abc&state=xyz',
        'cindycn://auth',
      ),
    ).toBe(true);
  });

  it('rejects lookalike hosts and paths', () => {
    expect(
      matchesOAuthCallbackUrl(
        'cindycn://auth.evil/?code=abc',
        'cindycn://auth',
      ),
    ).toBe(false);
    expect(
      matchesOAuthCallbackUrl(
        'cindycn://auth/extra?code=abc',
        'cindycn://auth',
      ),
    ).toBe(false);
    expect(
      matchesOAuthCallbackUrl('cindy://auth?code=abc', 'cindycn://auth'),
    ).toBe(false);
  });
});
