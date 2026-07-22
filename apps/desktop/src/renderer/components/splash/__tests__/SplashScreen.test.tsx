// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isDarkMode: true,
  phase: 'checking_env',
  tipsText: 'Loading Cindy',
  tipsClickable: false,
  tipsDestructive: false,
  skipSplash: vi.fn(),
  onTransitionEnd: vi.fn(),
  onTipsClick: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useSplash', () => ({
  useSplash: () => ({
    phase: mocks.phase,
    isDownloading: false,
    downloadProgress: 0,
    downloadInfo: {},
    resetSignal: 0,
    tipsText: mocks.tipsText,
    tipsClickable: mocks.tipsClickable,
    tipsDestructive: mocks.tipsDestructive,
    showManifestFailedDialog: false,
    showDownloadFailedDialog: false,
    showSpawnFailedDialog: false,
    onRetryManifest: vi.fn(),
    onRetryDownload: vi.fn(),
    onSpawnFailedDownload: vi.fn(),
    onTipsClick: mocks.onTipsClick,
    onTransitionEnd: mocks.onTransitionEnd,
    skipSplash: mocks.skipSplash,
  }),
}));

vi.mock('@/components/markdown/useIsDarkMode', () => ({
  useIsDarkMode: () => mocks.isDarkMode,
}));

vi.mock('@/components/title-bar/WindowControls', () => ({
  WindowControls: () => <div data-testid="window-controls" />,
}));

vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: () => null,
}));

import { SplashScreen } from '../SplashScreen';

describe('SplashScreen v2 layout', () => {
  beforeEach(() => {
    mocks.isDarkMode = true;
    mocks.phase = 'checking_env';
    mocks.tipsText = 'Loading Cindy';
    mocks.tipsClickable = false;
    mocks.tipsDestructive = false;
    document.documentElement.removeAttribute('data-splash-active');
    (window as unknown as { electronAPI: { platform: string } }).electronAPI = {
      platform: 'darwin',
    };
  });

  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute('data-splash-active');
    vi.clearAllMocks();
  });

  it('uses the opaque surface token without CSS backdrop-filter', () => {
    const { container } = render(<SplashScreen />);
    const root = container.firstElementChild as HTMLElement;

    expect(root.getAttribute('style')).toContain('var(--surface)');
    expect(root.getAttribute('style')).not.toContain('backdrop-filter');
    expect(root.className).not.toContain('backdrop');
  });

  it('marks the document as splash-active only before fade out', () => {
    const view = render(<SplashScreen />);

    expect(document.documentElement.getAttribute('data-splash-active')).toBe('1');

    mocks.phase = 'fading_out';
    view.rerender(<SplashScreen />);

    expect(document.documentElement.hasAttribute('data-splash-active')).toBe(false);
  });

  it('removes the splash-active marker on unmount', () => {
    const view = render(<SplashScreen />);

    expect(document.documentElement.getAttribute('data-splash-active')).toBe('1');

    view.unmount();

    expect(document.documentElement.hasAttribute('data-splash-active')).toBe(false);
  });

  it('pins the brand assets to the v2 composition instead of stretching the illustration', () => {
    render(<SplashScreen />);

    const brand = screen.getByTestId('splash-brand');
    const illustration = screen.getByTestId('splash-illustration');
    const wordmark = screen.getByTestId('splash-wordmark');
    const script = screen.getByTestId('splash-script');

    expect(brand.className).toContain('left-1/2 top-[19.3%]');
    expect(brand.className).toContain('h-[424.5px] w-[457px]');
    expect(brand.getAttribute('style')).toContain(
      'translateX(-50%) scale(min(1, calc(100vh / 700px)))',
    );

    expect(illustration.className).toContain('top-0 h-[457px] w-[457px]');
    expect(illustration.className).not.toMatch(/\bh-full\b|\bw-full\b|object-cover/);

    expect(wordmark.className).toContain('top-[352.5px] h-[78px] w-[229.5px]');
    // 2026-07-22 用户拍板:字标去投影(DARK/LIGHT 均不带 drop-shadow)。
    expect(wordmark.className).not.toContain('drop-shadow');

    expect(script.className).toContain('left-[352.25px] top-[410px]');
    expect(script.className).toContain('h-[89.5px] w-[225.5px]');
  });

  it('removes the legacy version row', () => {
    render(<SplashScreen />);

    expect(screen.queryByText('CINDY')).toBeNull();
    expect(screen.queryByText(/XD\.Inc/)).toBeNull();
  });

  it('keeps the failure retry tip clickable inside the draggable splash', () => {
    mocks.tipsText = 'Environment initialization failed, click to retry';
    mocks.tipsClickable = true;
    mocks.tipsDestructive = true;

    render(<SplashScreen />);

    const retryTip = screen.getByText('Environment initialization failed, click to retry');
    const retryStyle = (retryTip as HTMLElement).style as CSSStyleDeclaration & {
      WebkitAppRegion?: string;
    };
    expect(retryStyle.WebkitAppRegion).toBe('no-drag');

    fireEvent.click(retryTip);
    expect(mocks.onTipsClick).toHaveBeenCalledTimes(1);
  });
});
