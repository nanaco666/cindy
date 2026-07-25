import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import type { WebContents } from 'electron';

const originalPlatform = process.platform;

const harness = vi.hoisted(() => {
  const windows: FakeWindow[] = [];
  const cancelComputerDriverPermissionGrant = vi.fn();
  const computerStatus = (permissionState: Partial<{
    status: 'missing' | 'granted';
    accessibility: 'missing' | 'granted';
    screenRecording: 'missing' | 'granted';
    screenRecordingCapturable: 'missing' | 'granted';
  }> = {}) => ({
    installed: true,
    executablePath: '/tmp/cua-driver',
    version: 'test',
    daemonRunning: true,
    installCommand: 'test',
    docsUrl: 'https://cua.ai/docs/cua-driver',
    permissionState: {
      platform: 'macos' as const,
      required: true,
      status: 'missing' as const,
      accessibility: 'missing' as const,
      screenRecording: 'missing' as const,
      screenRecordingCapturable: 'missing' as const,
      canGrant: true,
      ...permissionState,
    },
  });
  const getComputerDriverStatus = vi.fn(async (
    options?: { bypassPermissionProbeCache?: boolean },
  ) => {
    void options;
    return computerStatus();
  });
  const resumeComputerDriverPermissionProbe = vi.fn();
  const broadcastSend = vi.fn();
  const openExternal = vi.fn(async () => undefined);
  let deferWindowClosedEvents = false;
  let nextId = 100;
  const broadcastRecipient = {
    isDestroyed: () => false,
    webContents: { send: broadcastSend },
  };

  // companion host mock（guide-event / permission-state 事件发射）
  const companionListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const companionOn = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
    const set = companionListeners.get(event) ?? new Set();
    set.add(listener);
    companionListeners.set(event, set);
  });
  const companionRemoveListener = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
    companionListeners.get(event)?.delete(listener);
  });
  const companionEmit = (event: string, ...args: unknown[]): void => {
    companionListeners.get(event)?.forEach((l) => l(...args));
  };
  const companionShowGuide = vi.fn(async () => ({ ok: true as const }));
  const companionUpdateGuide = vi.fn(async () => ({ ok: true as const }));
  const companionDismissGuide = vi.fn(async () => undefined);
  const companionWatchPermissions = vi.fn(async () => ({ ok: true as const }));
  const companionLocateSwitch = vi.fn(async () => ({ status: 'unavailable' as const, id: 0 }));
  const fakeCompanionHost = {
    on: companionOn,
    removeListener: companionRemoveListener,
    showGuide: companionShowGuide,
    updateGuide: companionUpdateGuide,
    dismissGuide: companionDismissGuide,
    watchPermissions: companionWatchPermissions,
    locateSwitch: companionLocateSwitch,
  };

  class FakeWindow {
    readonly webContents = {
      id: nextId++,
      once: vi.fn((event: string, callback: () => void) => {
        this.listeners.set(event, callback);
      }),
      on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
        this.listeners.set(event, callback);
      }),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      startDrag: vi.fn(),
    };
    readonly listeners = new Map<string, (...args: unknown[]) => void>();
    readonly loadURL = vi.fn(async () => {
      this.listeners.get('did-finish-load')?.();
    });
    readonly loadFile = vi.fn(async () => {
      this.listeners.get('did-finish-load')?.();
    });
    readonly setIgnoreMouseEvents = vi.fn();
    readonly setAlwaysOnTop = vi.fn();
    readonly setVisibleOnAllWorkspaces = vi.fn();
    readonly showInactive = vi.fn();
    readonly setBounds = vi.fn();
    readonly getBounds = vi.fn(() => ({ x: 0, y: 0, width: 900, height: 700 }));
    readonly close = vi.fn(() => {
      this.destroyed = true;
      if (!deferWindowClosedEvents) this.listeners.get('closed')?.();
    });
    destroyed = false;

    constructor() {
      windows.push(this);
    }

    once(event: string, callback: (...args: unknown[]) => void): void {
      this.listeners.set(event, callback);
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    static getAllWindows(): Array<FakeWindow | typeof broadcastRecipient> {
      return [...windows, broadcastRecipient];
    }
  }

  return {
    FakeWindow,
    windows,
    cancelComputerDriverPermissionGrant,
    computerStatus,
    getComputerDriverStatus,
    resumeComputerDriverPermissionProbe,
    broadcastSend,
    openExternal,
    setDeferWindowClosedEvents: (defer: boolean) => {
      deferWindowClosedEvents = defer;
    },
    app: { getPath: () => '/tmp/cindy-computer-permission-guide-test' },
    nativeImage: {
      createFromDataURL: vi.fn(() => ({ isEmpty: () => false })),
    },
    isComputerDriverPermissionProbePaused: vi.fn(() => false),
    screen: {
      getDisplayMatching: vi.fn(() => ({
        workArea: { x: 0, y: 0, width: 1440, height: 900 },
      })),
      getDisplayNearestPoint: vi.fn(() => ({
        workArea: { x: 0, y: 0, width: 1440, height: 900 },
      })),
      getCursorScreenPoint: vi.fn(() => ({ x: 10, y: 10 })),
    },
    fakeCompanionHost,
    companionShowGuide,
    companionUpdateGuide,
    companionDismissGuide,
    companionWatchPermissions,
    companionLocateSwitch,
    companionEmit,
    companionOn,
    companionRemoveListener,
  };
});

vi.mock('electron', () => ({
  app: harness.app,
  BrowserWindow: harness.FakeWindow,
  nativeImage: harness.nativeImage,
  shell: { openExternal: harness.openExternal },
  screen: harness.screen,
}));

vi.mock('../../appPresence.js', () => ({
  scheduleMainAppPresenceRestore: vi.fn(),
}));

vi.mock('../../mcp-integrations/computer.js', () => ({
  getComputerDriverAppBundlePath: vi.fn(() => '/Applications/CuaDriver.app'),
  getComputerDriverStatus: harness.getComputerDriverStatus,
  isComputerDriverPermissionProbePaused: harness.isComputerDriverPermissionProbePaused,
  resumeComputerDriverPermissionProbe: harness.resumeComputerDriverPermissionProbe,
  cancelComputerDriverPermissionGrant: harness.cancelComputerDriverPermissionGrant,
  getSharedCompanionHost: vi.fn(() => harness.fakeCompanionHost),
}));

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function finishTestDrag(guide: typeof import('../window')): void {
  const sender = harness.windows[1].webContents as unknown as WebContents;
  guide.startComputerPermissionAppDrag(sender, 'data:image/png;base64,test');
  guide.finishComputerPermissionAppDrag(sender);
}

function writeDragState(state: {
  accessibility: boolean;
  screenRecording: boolean;
}): void {
  const directory = '/tmp/cindy-computer-permission-guide-test/computer-permission-guide';
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    `${directory}/cua-driver-drag-state-v2.json`,
    `${JSON.stringify(state)}\n`,
    'utf8',
  );
}

describe('Electron Computer Use permission guide window', () => {
  beforeEach(() => {
    vi.resetModules();
    harness.windows.splice(0);
    harness.setDeferWindowClosedEvents(false);
    harness.cancelComputerDriverPermissionGrant.mockReset();
    harness.getComputerDriverStatus.mockReset();
    harness.getComputerDriverStatus.mockResolvedValue(harness.computerStatus());
    harness.resumeComputerDriverPermissionProbe.mockReset();
    harness.broadcastSend.mockReset();
    harness.openExternal.mockReset();
    harness.openExternal.mockResolvedValue(undefined);
    harness.isComputerDriverPermissionProbePaused.mockReturnValue(false);
    harness.companionShowGuide.mockReset();
    harness.companionShowGuide.mockResolvedValue({ ok: true });
    harness.companionUpdateGuide.mockReset();
    harness.companionUpdateGuide.mockResolvedValue({ ok: true });
    harness.companionDismissGuide.mockReset();
    harness.companionWatchPermissions.mockReset();
    harness.companionWatchPermissions.mockResolvedValue({ ok: true });
    harness.companionLocateSwitch.mockReset();
    harness.companionLocateSwitch.mockResolvedValue({ status: 'unavailable', id: 0 });
    harness.companionOn.mockReset();
    harness.companionRemoveListener.mockReset();
    fs.rmSync(
      '/tmp/cindy-computer-permission-guide-test/computer-permission-guide',
      { recursive: true, force: true },
    );
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://127.0.0.1:5173');
    vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    });
  });

  afterEach(async () => {
    const guide = await import('../window');
    guide.closeComputerPermissionGuideWindow();
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform,
    });
  });

  it('creates the guide and mouse-transparent backdrop routes', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);

    // companion showGuide 成功时不展示 Electron fallback（面板由 companion 管理）
    expect(harness.companionShowGuide).toHaveBeenCalledOnce();
    expect(harness.windows).toHaveLength(2); // backdrop + guide 窗口已创建但未 show
    expect(harness.windows[0].loadURL).toHaveBeenCalledWith(
      expect.stringContaining('view=computer-permission-backdrop'),
    );
    expect(harness.windows[1].loadURL).toHaveBeenCalledWith(
      expect.stringContaining('view=computer-permission-guide'),
    );
    expect(guide.isComputerPermissionGuideWebContents(
      harness.windows[1].webContents as unknown as WebContents,
    )).toBe(true);
    expect(guide.isComputerPermissionGuideWebContents(
      harness.windows[0].webContents as unknown as WebContents,
    )).toBe(false);
  });

  it('selects and deduplicates the System Settings permission pane URL', async () => {
    const guide = await import('../window');
    const status = (permissionState: Record<string, string>) =>
      ({ permissionState } as unknown as Parameters<typeof guide.getComputerPermissionPaneUrl>[0]);

    expect(guide.getComputerPermissionPaneUrl(status({
      accessibility: 'missing',
      screenRecording: 'missing',
    }))).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    );
    expect(guide.getComputerPermissionPaneUrl(status({
      accessibility: 'granted',
      screenRecording: 'missing',
    }))).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
    expect(guide.getComputerPermissionPaneUrl(status({
      accessibility: 'granted',
      screenRecording: 'granted',
      screenRecordingCapturable: 'granted',
    }))).toBeNull();

    await guide.openComputerPermissionPaneForStatus(status({
      accessibility: 'missing',
      screenRecording: 'missing',
    }));
    await guide.openComputerPermissionPaneForStatus(status({
      accessibility: 'missing',
      screenRecording: 'missing',
    }));
    expect(harness.openExternal).toHaveBeenCalledOnce();
  });

  it('calls companion showGuide with correct initial state', async () => {
    vi.useFakeTimers();
    const guide = await import('../window');
    const initialStatus = harness.computerStatus({ accessibility: 'granted' });

    await guide.showComputerPermissionGuideWindow(null, initialStatus);

    expect(harness.companionShowGuide).toHaveBeenCalledWith(
      expect.objectContaining({
        accessibilityGranted: true,
        screenRecordingGranted: false,
        appBundlePath: '/Applications/CuaDriver.app',
      }),
    );
    // Electron fallback 窗口不应展示（companion 成功）
    expect(harness.windows[0].showInactive).not.toHaveBeenCalled();
    expect(harness.windows[1].showInactive).not.toHaveBeenCalled();
  });

  it('registers guide-event and permission-state listeners after showGuide succeeds', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);

    expect(harness.companionOn).toHaveBeenCalledWith('guide-event', expect.any(Function));
    expect(harness.companionOn).toHaveBeenCalledWith('permission-state', expect.any(Function));
    expect(harness.companionWatchPermissions).toHaveBeenCalledWith(true);
  });

  it('cancels guide and broadcasts CANCELLED on guide-close-requested', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);

    // 模拟 companion 发出 guide-close-requested
    harness.companionEmit('guide-event', { type: 'guide-close-requested' });

    expect(harness.cancelComputerDriverPermissionGrant).toHaveBeenCalledOnce();
    expect(harness.broadcastSend).toHaveBeenCalledWith(
      'maker:computer:permission-guide-cancelled',
    );
  });

  it('closes guide on guide-completed', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);

    harness.companionEmit('guide-event', { type: 'guide-completed' });

    // lifecycle 已终止，watchPermissions(false) 应被调用
    expect(harness.companionWatchPermissions).toHaveBeenCalledWith(false);
  });

  it('cancels an unattached companion guide after the 30s safety timeout', async () => {
    vi.useFakeTimers();
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(harness.companionDismissGuide).toHaveBeenCalledOnce();
    expect(harness.broadcastSend).toHaveBeenCalledWith(
      'maker:computer:permission-guide-cancelled',
    );
  });

  it('shows the Electron fallback when companion showGuide fails', async () => {
    // 返回类型覆写为更宽的联合（vi.fn 默认推断为 { ok: true } 窄类型）
    const showGuideMock = harness.companionShowGuide as unknown as ReturnType<typeof vi.fn>;
    showGuideMock.mockResolvedValueOnce({ ok: false, error: 'companion unavailable' });
    const guide = await import('../window');

    await guide.showComputerPermissionGuideWindow(null);

    await vi.waitFor(() => {
      expect(harness.windows[0].showInactive).toHaveBeenCalledOnce();
      expect(harness.windows[1].showInactive).toHaveBeenCalledOnce();
    });
  });

  it('dismisses companion guide and calls watchPermissions(false) on close', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);

    guide.closeComputerPermissionGuideWindow();

    expect(harness.companionDismissGuide).toHaveBeenCalledOnce();
    expect(harness.companionWatchPermissions).toHaveBeenCalledWith(false);
  });

  it('triggers daemon probe on permission-state event', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);
    harness.getComputerDriverStatus.mockClear();

    harness.companionEmit('permission-state', { accessibility: true, screenRecording: false });

    await vi.waitFor(() => {
      expect(harness.getComputerDriverStatus).toHaveBeenCalledOnce();
    });
  });

  it('ignores callbacks from a guide-event of an older lifecycle generation', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null, harness.computerStatus());

    // 保存当前 lifecycle 的 guide-event 监听
    const onGuideEvent = harness.companionOn.mock.calls.find(
      ([event]) => event === 'guide-event',
    )?.[1] as ((...args: unknown[]) => void) | undefined;

    guide.closeComputerPermissionGuideWindow();
    harness.cancelComputerDriverPermissionGrant.mockClear();

    // 旧 lifecycle 的事件回调（通过直接调用模拟残留调用）
    onGuideEvent?.({ type: 'guide-close-requested' });
    await Promise.resolve();

    expect(harness.cancelComputerDriverPermissionGrant).not.toHaveBeenCalled();
  });

  it('ignores a delayed closed event from the previous Electron lifecycle', async () => {
    harness.setDeferWindowClosedEvents(true);
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null, harness.computerStatus());
    const staleGuide = harness.windows[1];

    guide.closeComputerPermissionGuideWindow();
    await guide.showComputerPermissionGuideWindow(null, harness.computerStatus());
    const reopenedBackdrop = harness.windows[2];
    const reopenedGuide = harness.windows[3];
    staleGuide.listeners.get('closed')?.();

    expect(reopenedBackdrop.close).not.toHaveBeenCalled();
    expect(reopenedGuide.setIgnoreMouseEvents).not.toHaveBeenCalledWith(false);
  });

  it('starts the real app drag only for the guide renderer and restores it on drag end', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);
    const guideWindow = harness.windows[1];

    const sender = guideWindow.webContents as unknown as WebContents;
    guide.startComputerPermissionAppDrag(sender, 'data:image/png;base64,test');
    expect(guideWindow.webContents.startDrag).toHaveBeenCalledWith({
      file: '/Applications/CuaDriver.app',
      icon: expect.anything(),
    });
    expect(guideWindow.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });

    guide.finishComputerPermissionAppDrag(sender);
    expect(guideWindow.setIgnoreMouseEvents).toHaveBeenCalledWith(false);
  });

  it('persists drag state and triggers daemon probe after drag ends', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);
    harness.getComputerDriverStatus.mockClear();

    finishTestDrag(guide);

    await vi.waitFor(() => {
      expect(harness.getComputerDriverStatus).toHaveBeenCalledOnce();
    });
    const state = guide.readPermissionDragState();
    expect(state.accessibility).toBe(true);
  });

  it('clears a historical drag hint when drag-ended has no companion row (operation=0)', async () => {
    writeDragState({ accessibility: true, screenRecording: false });
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);

    // 拖拽结束但操作为 0（未成功 drop），accessibility 标记不应被置 true
    harness.companionEmit('guide-event', {
      type: 'guide-drag-ended',
      permission: 'accessibility',
      operation: 0,
    });
    await vi.waitFor(() => {
      expect(harness.getComputerDriverStatus).toHaveBeenCalled();
    });
  });

  it('does not continue an old show after its preflight settles following close and reopen', async () => {
    const oldStatus = createDeferred<Awaited<ReturnType<
      typeof harness.getComputerDriverStatus
    >>>();
    harness.getComputerDriverStatus.mockImplementationOnce(() => oldStatus.promise);
    const guide = await import('../window');
    const oldShow = guide.showComputerPermissionGuideWindow(null);
    await vi.waitFor(() => {
      expect(harness.getComputerDriverStatus).toHaveBeenCalledOnce();
    });

    guide.closeComputerPermissionGuideWindow();
    await guide.showComputerPermissionGuideWindow(null, harness.computerStatus());
    await vi.waitFor(() => {
      expect(harness.companionShowGuide).toHaveBeenCalledOnce();
    });

    oldStatus.resolve(harness.computerStatus());
    await oldShow;
    await Promise.resolve();

    // 旧 lifecycle 的 preflight 结果不应触发额外的 showGuide
    expect(harness.companionShowGuide).toHaveBeenCalledOnce();
  });

  it('after guide-attached, guide-close-requested still cancels and broadcasts CANCELLED', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);
    harness.cancelComputerDriverPermissionGrant.mockClear();
    harness.broadcastSend.mockClear();

    // companion 面板吸附到 System Settings，关闭 Electron fallback 窗口
    harness.companionEmit('guide-event', { type: 'guide-attached',
      systemX: 0, systemY: 0, systemWidth: 800, systemHeight: 600,
      panelX: 0, panelY: 0 });

    // 此时 guideWindow 已置 null，但 lifecycle 仍须活跃
    harness.companionEmit('guide-event', { type: 'guide-close-requested' });
    await Promise.resolve();

    expect(harness.cancelComputerDriverPermissionGrant).toHaveBeenCalledOnce();
    expect(harness.broadcastSend).toHaveBeenCalledWith(
      'maker:computer:permission-guide-cancelled',
    );
    // 完整关闭流程：companion dismissGuide 和 watchPermissions(false) 均被调用
    expect(harness.companionDismissGuide).toHaveBeenCalled();
    expect(harness.companionWatchPermissions).toHaveBeenCalledWith(false);
  });

  it('after guide-attached, guide-completed still triggers full close', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);
    harness.companionWatchPermissions.mockClear();
    harness.companionDismissGuide.mockClear();

    harness.companionEmit('guide-event', { type: 'guide-attached',
      systemX: 0, systemY: 0, systemWidth: 800, systemHeight: 600,
      panelX: 0, panelY: 0 });

    harness.companionEmit('guide-event', { type: 'guide-completed' });
    await Promise.resolve();

    expect(harness.companionWatchPermissions).toHaveBeenCalledWith(false);
    expect(harness.companionDismissGuide).toHaveBeenCalled();
  });

  it('after guide-attached, permission-state event still triggers daemon probe', async () => {
    const guide = await import('../window');
    await guide.showComputerPermissionGuideWindow(null);
    harness.getComputerDriverStatus.mockClear();

    harness.companionEmit('guide-event', { type: 'guide-attached',
      systemX: 0, systemY: 0, systemWidth: 800, systemHeight: 600,
      panelX: 0, panelY: 0 });

    harness.companionEmit('permission-state', { accessibility: true, screenRecording: false });

    await vi.waitFor(() => {
      expect(harness.getComputerDriverStatus).toHaveBeenCalledOnce();
    });
  });

  it('ignores an old lifecycle refresh result after close and reopen', async () => {
    const oldStatus = createDeferred<Awaited<ReturnType<
      typeof harness.getComputerDriverStatus
    >>>();
    const guide = await import('../window');
    const initialStatus = harness.computerStatus();
    await guide.showComputerPermissionGuideWindow(null, initialStatus);
    await vi.waitFor(() => {
      expect(harness.companionShowGuide).toHaveBeenCalledOnce();
    });

    harness.getComputerDriverStatus.mockImplementationOnce(() => oldStatus.promise);
    guide.refreshComputerPermissionGuideWindow();
    await vi.waitFor(() => {
      expect(harness.getComputerDriverStatus).toHaveBeenCalledOnce();
    });
    guide.closeComputerPermissionGuideWindow();

    await guide.showComputerPermissionGuideWindow(null, initialStatus);
    harness.companionUpdateGuide.mockClear();
    harness.broadcastSend.mockClear();
    oldStatus.resolve(harness.computerStatus({
      status: 'granted',
      accessibility: 'granted',
      screenRecording: 'granted',
      screenRecordingCapturable: 'granted',
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.broadcastSend).not.toHaveBeenCalledWith(
      'maker:computer:permission-guide-status-changed',
      expect.objectContaining({
        permissionState: expect.objectContaining({ status: 'granted' }),
      }),
    );
  });
});
