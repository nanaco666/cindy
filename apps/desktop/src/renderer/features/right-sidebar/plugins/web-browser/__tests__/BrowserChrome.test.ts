// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, createRef } from 'react';

import { BrowserChrome, type BrowserChromeHandle } from '../BrowserChrome';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

function renderChrome(
  url = 'https://www.taptap.cn/',
  extra: { commentSupported?: boolean } = {},
) {
  const onNavigate = vi.fn();
  const ref = createRef<BrowserChromeHandle>();
  render(
    createElement(BrowserChrome, {
      ref,
      url,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      onNavigate,
      onReload: vi.fn(),
      onStop: vi.fn(),
      onGoBack: vi.fn(),
      onGoForward: vi.fn(),
      onCaptureScreenshot: vi.fn(),
      commentActive: false,
      onToggleComment: vi.fn(),
      ...extra,
    }),
  );
  return { onNavigate, ref };
}

describe('BrowserChrome', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('submits Ctrl+Enter once and suppresses the following blur submit', () => {
    const { onNavigate } = renderChrome();

    fireEvent.click(screen.getByRole('button', { name: 'https://www.taptap.cn/' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'google' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    fireEvent.blur(input);

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith('https://www.google.com');
  });

  it('renders the page-comment button by default (commentSupported defaults to true)', () => {
    renderChrome();
    expect(
      screen.getByRole('button', { name: 'rightSidebar.browser.comment' }),
    ).toBeTruthy();
  });

  it('hides the page-comment button when commentSupported is false (detached sidebar window has no composer)', () => {
    renderChrome('https://www.taptap.cn/', { commentSupported: false });
    expect(
      screen.queryByRole('button', { name: 'rightSidebar.browser.comment' }),
    ).toBeNull();
  });
});
