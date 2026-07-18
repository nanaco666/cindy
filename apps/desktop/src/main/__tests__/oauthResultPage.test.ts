import { describe, expect, it } from 'vitest';

import {
  buildOAuthReturnAction,
  getProviderOAuthResultCopy,
  pickOAuthResultPageLang,
  renderOAuthResultPage,
} from '../oauthResultPage';

describe('OAuth result page language and copy', () => {
  it('uses the first supported browser language and falls back to English', () => {
    expect(pickOAuthResultPageLang('fr-FR,ja;q=0.8,en;q=0.7')).toBe('ja');
    expect(pickOAuthResultPageLang('zh-TW,zh;q=0.9')).toBe('zh');
    expect(pickOAuthResultPageLang('de-DE')).toBe('en');
    expect(pickOAuthResultPageLang(undefined)).toBe('en');
  });

  it('builds a localized return-to-Cindy deep link', () => {
    expect(buildOAuthReturnAction('zh', 'xai oauth', 'Cindy')).toEqual({
      href: 'cindy://focus/xai%20oauth',
      label: '返回 Cindy',
    });
    expect(buildOAuthReturnAction('en', 'generic-oauth', 'Cindy').label).toBe('Return to Cindy');
  });

  it('provides provider-specific localized result copy', () => {
    const copy = getProviderOAuthResultCopy('zh', 'xAI', 'Cindy');
    expect(copy.successBody).toContain('xAI');
    expect(copy.successBody).toContain('Cindy');
    expect(copy.exchangeFailedBody).toContain('连接 xAI');
  });
});

describe('renderOAuthResultPage', () => {
  it.each(['success', 'warning', 'error'] as const)(
    'marks and renders the %s variant',
    (variant) => {
      const html = renderOAuthResultPage({
        htmlLang: 'en',
        variant,
        title: 'Result',
        body: 'Result body',
      });
      expect(html).toContain(`data-cindy-oauth-result="${variant}"`);
      expect(html).toContain('<svg');
    },
  );

  it('supports forced light and dark themes for local visual previews', () => {
    expect(
      renderOAuthResultPage({
        htmlLang: 'en',
        variant: 'success',
        title: 'Done',
        body: 'Done',
        theme: 'light',
      }),
    ).toContain('<html lang="en" data-theme="light">');
    expect(
      renderOAuthResultPage({
        htmlLang: 'en',
        variant: 'success',
        title: 'Done',
        body: 'Done',
        theme: 'dark',
      }),
    ).toContain('<html lang="en" data-theme="dark">');
  });

  it('escapes all caller-controlled text and action fields', () => {
    const html = renderOAuthResultPage({
      htmlLang: 'en"><script>',
      variant: 'error',
      title: '<Title>',
      body: '<Body>',
      detail: '<script>alert(1)</script>',
      action: { href: 'cindy://focus/test" onclick="bad()', label: '<Return>' },
    });
    expect(html).toContain('lang="en&quot;&gt;&lt;script&gt;"');
    expect(html).toContain('&lt;Title&gt;');
    expect(html).toContain('&lt;Body&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('href="cindy://focus/test&quot; onclick=&quot;bad()"');
    expect(html).toContain('&lt;Return&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('renders the return action and responsive card shell', () => {
    const html = renderOAuthResultPage({
      htmlLang: 'zh-CN',
      variant: 'warning',
      title: '需要继续操作',
      body: '请返回 Cindy。',
      action: { href: 'cindy://focus/slack-hook-install', label: '返回 Cindy' },
    });
    expect(html).toContain('<a class="cta" href="cindy://focus/slack-hook-install">返回 Cindy</a>');
    expect(html).toContain('@media(max-width:480px)');
    expect(html).toContain('border-radius:12px');
  });
});
