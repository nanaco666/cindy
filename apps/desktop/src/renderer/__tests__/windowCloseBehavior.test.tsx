// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WindowControls } from '@/components/title-bar/WindowControls';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function installWindowsApi(closeBehavior: 'quit' | 'tray') {
  const chooseWindowsCloseBehavior = vi.fn(async () => closeBehavior);
  const anySessionInTurn = vi.fn(async () => false);
  const windowClose = vi.fn();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'win32',
      windowBehavior: { chooseWindowsCloseBehavior },
      anySessionInTurn,
      windowClose,
      windowMinimize: vi.fn(),
      windowMaximize: vi.fn(),
    } as unknown as Window['electronAPI'],
  });
  return { chooseWindowsCloseBehavior, anySessionInTurn, windowClose };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as Partial<Window>).electronAPI;
});

describe('Windows close behavior', () => {
  it('closes to the tray without showing the quit protection flow', async () => {
    const api = installWindowsApi('tray');
    render(<WindowControls />);

    fireEvent.click(screen.getByRole('button', { name: 'titleBar.close' }));

    await waitFor(() => expect(api.windowClose).toHaveBeenCalledTimes(1));
    expect(api.chooseWindowsCloseBehavior).toHaveBeenCalledTimes(1);
    expect(api.anySessionInTurn).not.toHaveBeenCalled();
  });

  it('keeps the existing quit protection flow when quit is selected', async () => {
    const api = installWindowsApi('quit');
    render(<WindowControls />);

    fireEvent.click(screen.getByRole('button', { name: 'titleBar.close' }));

    await waitFor(() => expect(api.windowClose).toHaveBeenCalledTimes(1));
    expect(api.chooseWindowsCloseBehavior).toHaveBeenCalledTimes(1);
    expect(api.anySessionInTurn).toHaveBeenCalledTimes(1);
  });
});
