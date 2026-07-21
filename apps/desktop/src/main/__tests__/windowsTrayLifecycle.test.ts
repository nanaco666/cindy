import { describe, expect, it, vi } from 'vitest';

import {
  hideWindowToWindowsTray,
  requestWindowsTrayQuit,
  type WindowsTrayWindow,
} from '../windowsTrayLifecycle';

/** Controllable BrowserWindow fake for fullscreen transition tests. */
function makeWindow(fullScreen: boolean): WindowsTrayWindow & {
  destroyed: boolean;
  emitLeaveFullScreen(): void;
} {
  let leaveFullScreenListener: (() => void) | null = null;
  return {
    destroyed: false,
    hide: vi.fn(),
    isDestroyed() {
      return this.destroyed;
    },
    isFullScreen: () => fullScreen,
    once: (_event, listener) => {
      leaveFullScreenListener = listener;
    },
    setFullScreen: vi.fn((next: boolean) => {
      fullScreen = next;
    }),
    emitLeaveFullScreen() {
      leaveFullScreenListener?.();
    },
  };
}

describe('Windows tray lifecycle', () => {
  it('hides a regular window immediately', () => {
    const window = makeWindow(false);

    hideWindowToWindowsTray(window);

    expect(window.hide).toHaveBeenCalledTimes(1);
    expect(window.setFullScreen).not.toHaveBeenCalled();
  });

  it('leaves fullscreen before hiding the window', () => {
    const window = makeWindow(true);

    hideWindowToWindowsTray(window);

    expect(window.setFullScreen).toHaveBeenCalledWith(false);
    expect(window.hide).not.toHaveBeenCalled();

    window.emitLeaveFullScreen();
    expect(window.hide).toHaveBeenCalledTimes(1);
  });

  it('does not hide a window destroyed during the fullscreen transition', () => {
    const window = makeWindow(true);

    hideWindowToWindowsTray(window);
    window.destroyed = true;
    window.emitLeaveFullScreen();

    expect(window.hide).not.toHaveBeenCalled();
  });

  it('quits without confirmation while no turn is active', () => {
    const confirmQuit = vi.fn(() => false);
    const quit = vi.fn();

    requestWindowsTrayQuit({ hasActiveTurn: () => false, confirmQuit, quit });

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('keeps the app open when active-turn confirmation is cancelled', () => {
    const quit = vi.fn();

    requestWindowsTrayQuit({ hasActiveTurn: () => true, confirmQuit: () => false, quit });

    expect(quit).not.toHaveBeenCalled();
  });

  it('quits after active-turn confirmation', () => {
    const quit = vi.fn();

    requestWindowsTrayQuit({ hasActiveTurn: () => true, confirmQuit: () => true, quit });

    expect(quit).toHaveBeenCalledTimes(1);
  });
});
