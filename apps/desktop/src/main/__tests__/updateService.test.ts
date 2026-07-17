import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_CDN_BASE_URL as CDN_EXTERNAL_BASE_URL } from '../../test/vitest/clientEndpointsFixture';

const originalPlatform = process.platform;
const TEST_ROOT = path.join(os.tmpdir(), 'xdt-maker-update-service-test');
const TEST_USER_DATA = path.join(TEST_ROOT, 'user-data');
const TEST_EXE = path.join(TEST_ROOT, 'app', 'xdt-maker.exe');

const browserWindowGetAllWindows = vi.fn(() => []);
const ipcMainHandle = vi.fn();
const ipcMainOn = vi.fn();
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const ipcListeners = new Map<string, (...args: unknown[]) => unknown>();
const powerMonitorGetSystemIdleState = vi.fn(() => 'idle');
const powerMonitorGetSystemIdleTime = vi.fn(() => 600);
const powerMonitorOn = vi.fn();
const powerMonitorRemoveListener = vi.fn();
const appGetVersion = vi.fn(() => '0.0.64');
const appIsInApplicationsFolder = vi.fn(() => true);
const appGetPath = vi.fn((name: string) => {
  if (name === 'userData') return TEST_USER_DATA;
  if (name === 'exe') return TEST_EXE;
  return TEST_ROOT;
});

const fetchManifest = vi.fn();
const getBaseUrl = vi.fn(() => CDN_EXTERNAL_BASE_URL);
const isDev = vi.fn(() => false);
const download = vi.fn();
const readAutoUpdateSettings = vi.fn(() => ({ autoRelaunchOnIdle: true }));
const initMigrationRuntime = vi.fn();
const handleMigrationBlock = vi.fn(async () => {});
const isHotUpdateSuppressedNow = vi.fn(() => false);
const isMigrationRelaunchReady = vi.fn(() => false);
const executeMigrationRelaunch = vi.fn(async () => false);

const logInfo = vi.fn();
const logWarn = vi.fn();
const logError = vi.fn();
const logDebug = vi.fn();

vi.mock('electron', () => ({
  app: {
    getVersion: appGetVersion,
    getPath: appGetPath,
    isPackaged: true,
    isInApplicationsFolder: appIsInApplicationsFolder,
    moveToApplicationsFolder: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: browserWindowGetAllWindows,
  },
  ipcMain: {
    handle: ipcMainHandle,
    on: ipcMainOn,
  },
  powerMonitor: {
    getSystemIdleState: powerMonitorGetSystemIdleState,
    getSystemIdleTime: powerMonitorGetSystemIdleTime,
    on: powerMonitorOn,
    removeListener: powerMonitorRemoveListener,
  },
}));

vi.mock('../auto-update-settings-store', () => ({
  readAutoUpdateSettings,
  readAutoUpdateSettingsState: () => ({
    value: readAutoUpdateSettings(),
    isCustomized: true,
    defaults: { autoRelaunchOnIdle: false },
  }),
  resetAutoUpdateSettings: () => ({ autoRelaunchOnIdle: false }),
  writeAutoRelaunchOnIdle: vi.fn(),
}));

vi.mock('../migration/electronRuntime', () => ({
  initMigrationRuntime,
  handleMigrationBlock,
  isHotUpdateSuppressedNow,
  isMigrationRelaunchReady,
  executeMigrationRelaunch,
}));

vi.mock('../manifestService', () => ({
  fetchManifest,
  getBaseUrl,
  isDev,
}));

vi.mock('../downloader/index', () => ({
  download,
  DownloadError: class DownloadError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: logInfo,
    warn: logWarn,
    error: logError,
    debug: logDebug,
  }),
  maskPath: (value: string) => value,
}));

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

async function freshUpdateService(platform: NodeJS.Platform) {
  vi.resetModules();
  setPlatform(platform);
  return import('../updateService');
}

beforeEach(() => {
  browserWindowGetAllWindows.mockReset();
  browserWindowGetAllWindows.mockReturnValue([]);
  ipcHandlers.clear();
  ipcListeners.clear();
  ipcMainHandle.mockReset();
  ipcMainHandle.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
    ipcHandlers.set(channel, handler);
  });
  ipcMainOn.mockReset();
  ipcMainOn.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
    ipcListeners.set(channel, handler);
  });
  powerMonitorGetSystemIdleState.mockReset();
  powerMonitorGetSystemIdleState.mockReturnValue('idle');
  powerMonitorGetSystemIdleTime.mockReset();
  powerMonitorGetSystemIdleTime.mockReturnValue(600);
  powerMonitorOn.mockReset();
  powerMonitorRemoveListener.mockReset();
  appGetVersion.mockReset();
  appGetVersion.mockReturnValue('0.0.64');
  appIsInApplicationsFolder.mockReset();
  appIsInApplicationsFolder.mockReturnValue(true);
  appGetPath.mockReset();
  appGetPath.mockImplementation((name: string) => {
    if (name === 'userData') return TEST_USER_DATA;
    if (name === 'exe') return TEST_EXE;
    return TEST_ROOT;
  });
  fetchManifest.mockReset();
  getBaseUrl.mockReset();
  getBaseUrl.mockReturnValue(CDN_EXTERNAL_BASE_URL);
  isDev.mockReset();
  isDev.mockReturnValue(false);
  download.mockReset();
  readAutoUpdateSettings.mockReset();
  readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: true });
  initMigrationRuntime.mockReset();
  handleMigrationBlock.mockReset();
  handleMigrationBlock.mockResolvedValue(undefined);
  isHotUpdateSuppressedNow.mockReset();
  isHotUpdateSuppressedNow.mockReturnValue(false);
  isMigrationRelaunchReady.mockReset();
  isMigrationRelaunchReady.mockReturnValue(false);
  executeMigrationRelaunch.mockReset();
  executeMigrationRelaunch.mockResolvedValue(false);
  logInfo.mockReset();
  logWarn.mockReset();
  logError.mockReset();
  logDebug.mockReset();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  setPlatform(originalPlatform);
});

function updateManifest(version = '0.0.65') {
  return {
    app: {
      version,
      hotfix: {
        file: `app/darwin-arm64/xdt-maker-${version}.zip`,
        sha256: 'abc',
        size: 123,
      },
    },
    claudeCode: {
      version: '1.0.0',
      file: 'claude-code/1.0.0/darwin-arm64/claude.gz',
      sha256: 'def',
      size: 456,
    },
  };
}

async function runStartupUpdate(
  options: {
    idleState?: 'active' | 'idle' | 'locked' | 'unknown';
    enabled?: boolean;
    busy?: boolean;
    platform?: NodeJS.Platform;
  } = {},
) {
  vi.useFakeTimers();
  powerMonitorGetSystemIdleState.mockReturnValue(options.idleState ?? 'idle');
  readAutoUpdateSettings.mockReturnValue({
    autoRelaunchOnIdle: options.enabled ?? true,
  });
  fetchManifest.mockResolvedValue(updateManifest());
  download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
    fs.mkdirSync(path.join(TEST_USER_DATA, 'updates'), { recursive: true });
    fs.writeFileSync(targetPath, 'update');
    return { path: targetPath, size: 123 };
  });

  const service = await freshUpdateService(options.platform ?? 'darwin');
  if (options.busy) service.setUpdateAutoRelaunchBusyProbe(() => true);
  service.initUpdateService();
  const handler = ipcHandlers.get('update-check-startup');
  if (!handler) throw new Error('update-check-startup handler not registered');
  try {
    return await handler();
  } finally {
    service.stopUpdateService();
  }
}

describe('checkForUpdate Linux first-release guard', () => {
  it('returns manual_download on Linux without fetching or downloading, even with a hotfix manifest override', async () => {
    const { checkForUpdate, getUpdateStatus } = await freshUpdateService('linux');

    const result = await checkForUpdate({
      app: {
        version: '9.9.9',
        hotfix: {
          file: 'app/linux-x64/app.hotfix.zip',
          sha256: 'abc',
          size: 123,
        },
      },
      claudeCode: {
        version: '1.0.0',
        file: 'claude-code/1.0.0/linux-x64/claude.gz',
        sha256: 'def',
        size: 456,
      },
    });

    expect(result).toBe('manual_download');
    expect(getUpdateStatus()).toBe('idle');
    expect(fetchManifest).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('keeps returning manual_download on repeated Linux checks while remaining idle', async () => {
    const { checkForUpdate, getUpdateStatus } = await freshUpdateService('linux');

    expect(await checkForUpdate()).toBe('manual_download');
    expect(await checkForUpdate()).toBe('manual_download');

    expect(getUpdateStatus()).toBe('idle');
    expect(fetchManifest).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });
});

describe('startup update relaunch safety', () => {
  it('allows a staged startup update only when the unattended policy is satisfied', async () => {
    await expect(runStartupUpdate()).resolves.toMatchObject({
      hasUpdate: true,
      action: 'relaunch',
      version: '0.0.65',
    });
  });

  it.each([
    ['locked', 'screen-locked'],
    ['unknown', 'screen-state-unknown'],
    ['active', 'user-active'],
  ] as const)(
    'keeps the startup patch ready when system state is %s',
    async (idleState, reason) => {
      await expect(runStartupUpdate({ idleState })).resolves.toMatchObject({
        hasUpdate: true,
        action: 'none',
        version: '0.0.65',
      });
      expect(logInfo).toHaveBeenCalledWith(
        'startup update relaunch deferred (%s); patch v%s remains ready',
        reason,
        '0.0.65',
      );
    },
  );

  it('honors the setting and busy-task guard during startup', async () => {
    await expect(runStartupUpdate({ enabled: false })).resolves.toMatchObject({ action: 'none' });
    await expect(runStartupUpdate({ busy: true })).resolves.toMatchObject({ action: 'none' });
  });

  it('preserves locked-idle startup auto apply on Windows', async () => {
    await expect(runStartupUpdate({ idleState: 'locked', platform: 'win32' })).resolves.toMatchObject({
      action: 'relaunch',
    });
  });

  it('rechecks safety at the startup apply boundary while keeping manual apply separate', async () => {
    vi.useFakeTimers();
    fetchManifest.mockResolvedValue(updateManifest());
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.join(TEST_USER_DATA, 'updates'), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });

    const service = await freshUpdateService('darwin');
    let busy = false;
    service.setUpdateAutoRelaunchBusyProbe(() => busy);
    service.initUpdateService();
    try {
      const startupHandler = ipcHandlers.get('update-check-startup');
      const autoApplyHandler = ipcHandlers.get('update-relaunch-auto');
      expect(startupHandler).toBeTypeOf('function');
      expect(autoApplyHandler).toBeTypeOf('function');
      expect(ipcListeners.get('update-relaunch')).toBeTypeOf('function');

      await expect(startupHandler?.()).resolves.toMatchObject({ action: 'relaunch' });
      busy = true;
      await expect(autoApplyHandler?.({}, 'dark')).resolves.toEqual({
        accepted: false,
        blockReason: 'busy',
      });
      expect(service.getUpdateStatus()).toBe('ready');
      expect(logInfo).toHaveBeenCalledWith(
        'startup automatic relaunch deferred at apply boundary (%s)',
        'busy',
      );
    } finally {
      service.stopUpdateService();
    }
  });

  it('honors an auto-update setting change while the final busy probe is in flight', async () => {
    vi.useFakeTimers();
    fetchManifest.mockResolvedValue(updateManifest());
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.join(TEST_USER_DATA, 'updates'), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });

    let probeCalls = 0;
    let resolveFinalProbe: ((busy: boolean) => void) | undefined;
    let markFinalProbeStarted: (() => void) | undefined;
    const finalProbeStarted = new Promise<void>((resolve) => {
      markFinalProbeStarted = resolve;
    });

    const service = await freshUpdateService('darwin');
    service.setUpdateAutoRelaunchBusyProbe(() => {
      probeCalls += 1;
      if (probeCalls === 1) return false;
      markFinalProbeStarted?.();
      return new Promise<boolean>((resolve) => {
        resolveFinalProbe = resolve;
      });
    });
    service.initUpdateService();
    try {
      const startupHandler = ipcHandlers.get('update-check-startup');
      const autoApplyHandler = ipcHandlers.get('update-relaunch-auto');
      await expect(startupHandler?.()).resolves.toMatchObject({ action: 'relaunch' });

      const applyResult = autoApplyHandler?.({}, 'dark');
      await finalProbeStarted;
      readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
      resolveFinalProbe?.(false);

      await expect(applyResult).resolves.toEqual({
        accepted: false,
        blockReason: 'disabled',
      });
      expect(service.getUpdateStatus()).toBe('ready');
    } finally {
      service.stopUpdateService();
    }
  });
});

describe('splash 启动下载 0% 显式广播', () => {
  interface SentIpc {
    channel: string;
    payload: { progress?: number; received?: number; total?: number };
  }

  function makeProgressCollector() {
    const sends: SentIpc[] = [];
    const win = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: SentIpc['payload']) => {
          sends.push({ channel, payload });
        },
      },
    };
    browserWindowGetAllWindows.mockReturnValue([win as never]);
    const progressSends = () => sends.filter((s) => s.channel === 'app-update-progress');
    return { sends, progressSends };
  }

  function mockDownloadSuccess(onInvoke?: () => void) {
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      onInvoke?.();
      fs.mkdirSync(path.join(TEST_USER_DATA, 'updates'), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });
  }

  beforeEach(() => {
    // setStatus('ready') 会触发 evaluateAutoRelaunch;关掉无人值守开关,
    // 避免测试进程里真的走到 executeRelaunch(spawn + process.exit)。
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
  });

  it('启动(非 wasReady)路径:download() 之前恰好广播一次 progress:0', async () => {
    const { progressSends } = makeProgressCollector();
    // ProgressNormalizer 只在进度上升时 emit,首个 ≥1% 事件在大补丁/慢网下
    // 可能要等数秒;没有这条显式 0%,splash 会停留在 'checking'、grace 定时器
    // 也看不到 'updating' 而提前放行进 app —— 这里锁死"下载真正开始前恰好
    // 已广播一次 0%"的契约。
    let progressCountWhenDownloadStarted = -1;
    mockDownloadSuccess(() => {
      progressCountWhenDownloadStarted = progressSends().length;
    });

    const { checkForUpdate } = await freshUpdateService('darwin');
    expect(await checkForUpdate(updateManifest())).toBe('ready');

    expect(progressCountWhenDownloadStarted).toBe(1);
    const payloads = progressSends().map((s) => s.payload);
    expect(payloads[0]).toMatchObject({ progress: 0, received: 0, total: 123 });
    expect(payloads[payloads.length - 1]).toMatchObject({ progress: 100 });
  });

  it('superseding(wasReady)路径:下载前不向 splash 通道广播 0%', async () => {
    const { sends, progressSends } = makeProgressCollector();
    mockDownloadSuccess();

    const service = await freshUpdateService('darwin');
    expect(await service.checkForUpdate(updateManifest('0.0.65'))).toBe('ready');

    // 清空第一轮的广播,只观察 superseding 轮。
    sends.length = 0;
    let progressCountWhenDownloadStarted = -1;
    mockDownloadSuccess(() => {
      progressCountWhenDownloadStarted = progressSends().length;
    });

    // banner 已 ready(a=0.0.65),后台轮询发现更高的 b=0.0.66 → superseding。
    // 此时用户在主界面,启动 splash 早已结束;0% 广播只属于启动态。
    expect(await service.checkForUpdate(updateManifest('0.0.66'))).toBe('ready');
    expect(progressCountWhenDownloadStarted).toBe(0);
  });
});

describe('brand migration update routing', () => {
  const migrationManifest = {
    app: {
      version: '0.0.64',
      migration: {
        targetApp: 'cindy',
        version: '1.0.0',
        file: 'migration/cindy-setup.exe',
        sha256: 'a'.repeat(64),
        size: 123,
      },
    },
    claudeCode: {
      version: '1.0.0',
      file: 'claude-code/1.0.0/darwin-arm64/claude.gz',
      sha256: 'b'.repeat(64),
      size: 456,
    },
  };

  it('macOS App Translocation 下不 stage 品牌迁移', async () => {
    appIsInApplicationsFolder.mockReturnValue(false);
    const { checkForUpdate } = await freshUpdateService('darwin');

    expect(await checkForUpdate(migrationManifest)).toBe('idle');
    expect(handleMigrationBlock).not.toHaveBeenCalled();
  });

  it('macOS 已在 Applications 时正常 stage 品牌迁移', async () => {
    const { checkForUpdate } = await freshUpdateService('darwin');

    expect(await checkForUpdate(migrationManifest)).toBe('idle');
    expect(handleMigrationBlock).toHaveBeenCalledWith(migrationManifest.app.migration);
  });

  it('macOS App Translocation 下拒绝执行品牌迁移 relaunch', async () => {
    vi.useFakeTimers();
    try {
      appIsInApplicationsFolder.mockReturnValue(false);
      isMigrationRelaunchReady.mockReturnValue(true);
      const { getUpdateStatus, initUpdateService, stopUpdateService } =
        await freshUpdateService('darwin');
      initUpdateService();
      const relaunchListener = ipcMainOn.mock.calls.find(([channel]) => channel === 'update-relaunch')?.[1] as
        | ((event: unknown, theme: 'light' | 'dark') => void)
        | undefined;

      relaunchListener?.({}, 'dark');
      expect(getUpdateStatus()).toBe('error');
      expect(executeMigrationRelaunch).not.toHaveBeenCalled();
      stopUpdateService();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('迁移执行 Promise reject 后恢复 relaunch 状态，后续点击可重试', async () => {
    isDev.mockReturnValue(true);
    isMigrationRelaunchReady.mockReturnValue(true);
    executeMigrationRelaunch.mockRejectedValue(new Error('atomic rename failed'));
    const { getUpdateStatus, initUpdateService } = await freshUpdateService('win32');
    initUpdateService();
    const relaunchListener = ipcMainOn.mock.calls.find(([channel]) => channel === 'update-relaunch')?.[1] as
      | ((event: unknown, theme: 'light' | 'dark') => void)
      | undefined;
    expect(relaunchListener).toBeTypeOf('function');

    relaunchListener?.({}, 'dark');
    await vi.waitFor(() => expect(getUpdateStatus()).toBe('error'));
    relaunchListener?.({}, 'dark');
    await vi.waitFor(() => expect(executeMigrationRelaunch).toHaveBeenCalledTimes(2));
  });
});
