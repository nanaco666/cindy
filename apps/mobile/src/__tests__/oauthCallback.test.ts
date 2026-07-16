import { describe, expect, it } from 'vitest';
import { DEFAULT_API_BASE_URL } from '@/config/env';
import { isFeishuAppLink } from '@/auth/feishuAppLink';
import { parseOAuthCallbackUrl } from '@/auth/oauthCallback';

describe('parseOAuthCallbackUrl', () => {
  it('extracts code and state from callback URL', () => {
    expect(parseOAuthCallbackUrl(`${DEFAULT_API_BASE_URL}/api/auth/callback?code=c1&state=s1`)).toEqual({
      code: 'c1',
      state: 's1',
    });
  });

  it('extracts code and state from app deep link', () => {
    expect(parseOAuthCallbackUrl('lizcn://auth?code=c1&state=lizcn.s1')).toEqual({
      code: 'c1',
      state: 'lizcn.s1',
    });
  });

  it('rejects OAuth error callbacks', () => {
    expect(() =>
      parseOAuthCallbackUrl(`${DEFAULT_API_BASE_URL}/api/auth/callback?error=access_denied&state=s1`),
    ).toThrow('飞书登录失败');
  });

  it('requires both code and state', () => {
    expect(() => parseOAuthCallbackUrl(`${DEFAULT_API_BASE_URL}/api/auth/callback?state=s1`)).toThrow('缺少 code');
    expect(() => parseOAuthCallbackUrl(`${DEFAULT_API_BASE_URL}/api/auth/callback?code=c1`)).toThrow('缺少 state');
  });

  it('recognizes Feishu app links separately from OAuth callbacks', () => {
    expect(isFeishuAppLink('feishu://client/web_url/open?url=https%3A%2F%2Faccounts.example.com')).toBe(true);
    expect(isFeishuAppLink('lark://client/web_url/open?url=https%3A%2F%2Faccounts.larksuite.com')).toBe(true);
    expect(isFeishuAppLink('https://accounts.example.com/authen/v1/authorize')).toBe(false);
    expect(isFeishuAppLink('not a url')).toBe(false);
  });
});
