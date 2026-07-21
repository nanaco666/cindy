/** BrowserWindow surface needed to leave fullscreen before hiding to the Windows tray. */
export interface WindowsTrayWindow {
  hide(): void;
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  once(event: 'leave-full-screen', listener: () => void): unknown;
  setFullScreen(fullScreen: boolean): void;
}

/** Dependencies for applying the same active-turn protection to tray-menu quit. */
export interface WindowsTrayQuitDependencies {
  hasActiveTurn(): boolean;
  confirmQuit(): boolean;
  quit(): void;
}

/** Hide immediately, or wait for the native fullscreen transition to finish first. */
export function hideWindowToWindowsTray(window: WindowsTrayWindow): void {
  if (!window.isFullScreen()) {
    window.hide();
    return;
  }

  window.once('leave-full-screen', () => {
    if (!window.isDestroyed()) window.hide();
  });
  window.setFullScreen(false);
}

/** Quit directly while idle, but require explicit confirmation during an active turn. */
export function requestWindowsTrayQuit(deps: WindowsTrayQuitDependencies): void {
  if (deps.hasActiveTurn() && !deps.confirmQuit()) return;
  deps.quit();
}
