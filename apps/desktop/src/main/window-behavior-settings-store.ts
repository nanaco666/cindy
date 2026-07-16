/**
 * window-behavior-settings-store —— main 进程对窗口交互行为开关的持久化。
 *
 * File: <userData>/window-behavior-settings.json
 *
 * Defaults:
 *  - swallowActivationClick: false (首次点击直接透传,双屏用户默认更顺手;
 *    这是相对 PR #446 / macOS 原生 acceptFirstMouse:false 的行为变更,想要
 *    防误触的用户需在设置里显式打开)
 *
 * 只承载 macOS 侧需要的"启动前读一次"的场景——renderer 的 localStorage 是 UI
 * 及 Windows 侧 JS swallow 的运行时事实标准,main 侧这份文件只是为了让下次启
 * 动创建 BrowserWindow 时能拿到最新值,填 `acceptFirstMouse: !swallow`。
 * 因此:renderer 每次写 localStorage 时通过 IPC 通知 main 落盘;main 不主动
 * 广播状态回 renderer。
 */

import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('window-behavior-settings-store');

export interface WindowBehaviorSettings {
  swallowActivationClick: boolean;
}

const DEFAULTS: WindowBehaviorSettings = {
  swallowActivationClick: false,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'window-behavior-settings.json');
}

function normalize(raw: unknown): WindowBehaviorSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    swallowActivationClick:
      typeof r.swallowActivationClick === 'boolean'
        ? r.swallowActivationClick
        : DEFAULTS.swallowActivationClick,
  };
}

const store = createOverrideSettingsFile<WindowBehaviorSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'window-behavior',
});

export function readWindowBehaviorSettings(): WindowBehaviorSettings {
  return store.read();
}

export function writeSwallowActivationClick(swallowActivationClick: boolean): void {
  store.writePatch({ swallowActivationClick });
  log.info('window-behavior setting written', { swallowActivationClick });
}
