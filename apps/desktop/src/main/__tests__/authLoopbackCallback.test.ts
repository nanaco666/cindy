import { describe, expect, it } from 'vitest';

import {
  createAuthBrowserAuthorizationSlot,
  parseAuthLoopbackCallback,
  raceAuthBrowserCancellation,
  renderAuthLoopbackPage,
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

describe('auth loopback callback page', () => {
  it('renders the localized copy and lang attribute', () => {
    const html = renderAuthLoopbackPage({
      htmlLang: 'zh-CN',
      variant: 'success',
      title: '登录成功',
      body: '你可以关闭此页面，回到 Cindy 继续。',
    });
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('<h1>登录成功</h1>');
    expect(html).toContain('你可以关闭此页面，回到 Cindy 继续。');
    expect(html).not.toContain('class="detail"');
    expect(html).not.toContain('class="cta"');
  });

  it('renders the return-to-app CTA when an action is provided', () => {
    const html = renderAuthLoopbackPage({
      htmlLang: 'zh-CN',
      variant: 'success',
      title: '登录成功',
      body: '你可以关闭此页面，回到 Cindy 继续。',
      action: { href: 'cindy://focus/desktop-login', label: '回到 Cindy' },
    });
    expect(html).toContain('<a class="cta" href="cindy://focus/desktop-login">回到 Cindy</a>');
  });

  it('shows the raw error code on the error page and escapes injected markup', () => {
    const html = renderAuthLoopbackPage({
      htmlLang: 'en',
      variant: 'error',
      title: 'Sign-in not completed',
      body: 'Please return to Cindy and sign in again.',
      detail: '<script>alert(1)</script>',
    });
    expect(html).toContain('class="detail"');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
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

  it('cancels post-callback work and ignores its late result', async () => {
    const slot = createAuthBrowserAuthorizationSlot();
    const controller = new AbortController();
    slot.activate(() => controller.abort());
    let completeExchange!: (value: string) => void;
    const exchange = new Promise<string>((resolve) => {
      completeExchange = resolve;
    });

    const raced = raceAuthBrowserCancellation(exchange, controller.signal);
    expect(slot.cancelActive()).toBe(true);
    await expect(raced).resolves.toEqual({ cancelled: true });

    completeExchange('late-token');
    await Promise.resolve();
    expect(controller.signal.aborted).toBe(true);
  });
});
