// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isDarkMode: true,
  skipSplash: vi.fn(),
  onTransitionEnd: vi.fn(),
  onTipsClick: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useSplash', () => ({
  useSplash: () => ({
    phase: 'checking_env',
    isDownloading: false,
    downloadProgress: 0,
    downloadInfo: {},
    resetSignal: 0,
    tipsText: 'Loading Cindy',
    tipsClickable: false,
    tipsDestructive: false,
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
    (window as unknown as { electronAPI: { platform: string } }).electronAPI = {
      platform: 'darwin',
    };
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('uses the dark translucent window wash without CSS backdrop-filter', () => {
    const { container } = render(<SplashScreen />);
    const root = container.firstElementChild as HTMLElement;

    expect(root.style.backgroundColor).toBe('rgba(18, 15, 15, 0.85)');
    expect(root.getAttribute('style')).not.toContain('backdrop-filter');
    expect(root.className).not.toContain('backdrop');
  });

  it('uses the light translucent window wash', () => {
    mocks.isDarkMode = false;

    const { container } = render(<SplashScreen />);
    const root = container.firstElementChild as HTMLElement;

    expect(root.style.backgroundColor).toBe('rgba(255, 255, 255, 0.93)');
  });

  it('pins the brand assets to the v2 composition instead of stretching the illustration', () => {
    render(<SplashScreen />);

    const brand = screen.getByTestId('splash-brand');
    const illustration = screen.getByTestId('splash-illustration');
    const wordmark = screen.getByTestId('splash-wordmark');
    const script = screen.getByTestId('splash-script');

    expect(brand.className).toContain('left-1/2 top-[26.5%]');
    expect(brand.className).toContain('h-[424.5px] w-[457px]');
    expect(brand.getAttribute('style')).toContain(
      'translateX(-50%) scale(min(1, calc(100vh / 700px)))',
    );

    expect(illustration.className).toContain('top-0 h-[457px] w-[457px]');
    expect(illustration.className).not.toMatch(/\bh-full\b|\bw-full\b|object-cover/);

    expect(wordmark.className).toContain('top-[277.5px] h-[78px] w-[229.5px]');
    expect(wordmark.className).toContain('drop-shadow-[0_2px_6.5px_rgba(0,0,0,0.25)]');

    expect(script.className).toContain('left-[352.25px] top-[335px]');
    expect(script.className).toContain('h-[89.5px] w-[225.5px]');
  });

  it('removes the legacy version row', () => {
    render(<SplashScreen />);

    expect(screen.queryByText('CINDY')).toBeNull();
    expect(screen.queryByText(/XD\.Inc/)).toBeNull();
  });
});
