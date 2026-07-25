/**
 * locateSwitchResult.test.ts
 * ---------------------------------------------------------------------------
 * 验证 applyLocateSwitchResult 对 not-found / unavailable 的处理：
 *
 *   not-found  — AX 可用但行不存在 → 清除对应权限的拖拽标记；
 *                标记写回持久化文件，表示 updateGuide 将收到 draggedAccessibility=false。
 *
 *   unavailable — AX 本身不可用 → 标记保留不变。
 *
 * 使用真实 fs（写入 electron stub 的 tmpdir）避免复杂 fs mock，
 * 用 _resetPermissionDragStateCacheForTest + 文件操作确保测试间隔离。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── mocks：隔离 window.ts 的重量级传递依赖 ───────────────────────────────────

vi.mock('../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

vi.mock('../../appPresence', () => ({
  scheduleMainAppPresenceRestore: vi.fn(),
}));

vi.mock('../../maker-ipc/channels', () => ({
  MAKER_PUSH: {
    COMPUTER_PERMISSION_GUIDE_STATUS_CHANGED: 'cpu:guide:status',
    COMPUTER_PERMISSION_GUIDE_CANCELLED: 'cpu:guide:cancelled',
  },
}));

vi.mock('../../computer-use-companion/CompanionHost', () => ({}));

vi.mock('../../mcp-integrations/computer', () => ({
  cancelComputerDriverPermissionGrant: vi.fn(),
  getComputerDriverAppBundlePath: vi.fn(() => '/fake/CuaDriver.app'),
  getComputerDriverStatus: vi.fn(),
  getSharedCompanionHost: vi.fn(() => null),
  isComputerDriverPermissionProbePaused: vi.fn(() => false),
  resumeComputerDriverPermissionProbe: vi.fn(),
}));

vi.mock('../placement', () => ({
  computeComputerPermissionGuideBounds: vi.fn(() => ({ x: 0, y: 0, width: 480, height: 272 })),
}));

// ── 被测函数 ──────────────────────────────────────────────────────────────────

import {
  applyLocateSwitchResult,
  readPermissionDragState,
  _resetPermissionDragStateCacheForTest,
} from '../window.js';

// electron stub(src/test/vitest/electron-stub.ts)将 app.getPath() 映射到
// <os.tmpdir()>/xdt-maker-vitest-electron/<name>，与生产路径完全隔离。
const ELECTRON_STUB_USER_DATA = path.join(os.tmpdir(), 'xdt-maker-vitest-electron', 'userData');
const DRAG_STATE_DIR = path.join(ELECTRON_STUB_USER_DATA, 'computer-permission-guide');
const DRAG_STATE_FILE = path.join(DRAG_STATE_DIR, 'cua-driver-drag-state-v2.json');

/** 将指定状态写入磁盘并刷新内存缓存，供每个测试设定初始条件。 */
function seedDragState(state: { accessibility: boolean; screenRecording: boolean }): void {
  fs.mkdirSync(DRAG_STATE_DIR, { recursive: true });
  fs.writeFileSync(DRAG_STATE_FILE, `${JSON.stringify(state)}\n`, 'utf8');
  // 清除内存缓存，使下次 readPermissionDragState() 重新从磁盘加载
  _resetPermissionDragStateCacheForTest();
}

beforeEach(() => {
  vi.clearAllMocks();
  // 写入过期标记状态：accessibility=true（模拟 TCC 被外部重置后遗留的过期标记）
  seedDragState({ accessibility: true, screenRecording: false });
});

afterEach(() => {
  try { fs.unlinkSync(DRAG_STATE_FILE); } catch { /* 文件不存在时忽略 */ }
  _resetPermissionDragStateCacheForTest();
});

describe('applyLocateSwitchResult', () => {
  it('not-found: 清除 accessibility 拖拽标记', () => {
    // 确认初始状态：标记为 true（TCC 重置后遗留）
    expect(readPermissionDragState().accessibility).toBe(true);

    // AX 可用但行不存在 → 标记应被清除
    applyLocateSwitchResult({ status: 'not-found' });

    // 内存缓存已更新
    expect(readPermissionDragState().accessibility).toBe(false);

    // 持久化文件也已写回 false
    const onDisk = JSON.parse(fs.readFileSync(DRAG_STATE_FILE, 'utf8'));
    expect(onDisk.accessibility).toBe(false);
  });

  it('not-found: 不影响 screenRecording 标记', () => {
    seedDragState({ accessibility: true, screenRecording: true });

    applyLocateSwitchResult({ status: 'not-found' });

    // accessibility 被清，screenRecording 保留
    const state = readPermissionDragState();
    expect(state.accessibility).toBe(false);
    expect(state.screenRecording).toBe(true);
  });

  it('unavailable: 保留 drag 标记不变', () => {
    expect(readPermissionDragState().accessibility).toBe(true);

    // AX 本身不可用，无法判断行是否存在 → 标记保留
    applyLocateSwitchResult({ status: 'unavailable' });

    expect(readPermissionDragState().accessibility).toBe(true);

    // 磁盘文件未被改动
    const onDisk = JSON.parse(fs.readFileSync(DRAG_STATE_FILE, 'utf8'));
    expect(onDisk.accessibility).toBe(true);
  });
});
