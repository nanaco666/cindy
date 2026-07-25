// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loginHook = vi.hoisted(() => ({
  dispatch: vi.fn(),
  value: {
    isLoading: false,
    errorCode: null,
    loginState: { step: 'browser-redirect' as const, label: 'Google' },
    dispatch: vi.fn(),
    clearError: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useBrandLogo', () => ({
  useBrandLogo: () => 'brand-logo.svg',
}));

vi.mock('@/hooks/useLogin', () => ({
  useLogin: () => loginHook.value,
}));

vi.mock('@/components/title-bar/WindowControls', () => ({
  WindowControls: () => null,
}));

import { LoginPage } from '../LoginPage';

describe('LoginPage browser redirect waiting state', () => {
  beforeEach(() => {
    loginHook.dispatch = vi.fn().mockResolvedValue(true);
    loginHook.value = {
      isLoading: false,
      errorCode: null,
      loginState: { step: 'browser-redirect', label: 'Google' },
      dispatch: loginHook.dispatch,
      clearError: vi.fn(),
    };
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { platform: 'darwin' },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('keeps an animated progress indicator visible until browser authentication settles', () => {
    render(<LoginPage />);

    const progress = screen.getByRole('status', { name: 'login.working' });
    expect(progress.className).toContain('animate-spin');
    expect(screen.getByText('login.browserWaiting')).toBeTruthy();
    expect(screen.getByText('Google')).toBeTruthy();
  });

  it('still lets the user cancel the pending browser login', () => {
    render(<LoginPage />);

    fireEvent.click(screen.getByRole('button', { name: 'login.cancel' }));
    expect(loginHook.dispatch).toHaveBeenCalledWith({ type: 'cancel-browser' });
  });
});
