/**
 * hook-control store 单测(单配置形态): os.tmpdir 临时文件(规则 23:
 * 测试路径一律走系统临时目录, 收尾清理)。覆盖默认态 / 持久化 / 校验 /
 * urlOverride / 旧多连接文件一次性迁移。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SLACK_HOOK_DEFAULT_URL } from '../../../shared/hookControlIpc';
import {
  createSlackHookStore,
  HookConnectionValidationError,
  validateWorkspaces,
} from '../store';

const noopLog = { info: () => {}, warn: () => {} };

let dir: string;
const filePath = (): string => path.join(dir, 'slack-hook.json');
const legacyPath = (): string => path.join(dir, 'hook-connections.json');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-hook-store-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeStore(cleanup?: (ids: string[]) => void) {
  return createSlackHookStore({
    filePath: filePath(),
    legacyFilePath: legacyPath(),
    cleanupLegacySecrets: cleanup,
    log: noopLog,
  });
}

describe('默认态与持久化', () => {
  it('无文件: 关闭 + 空目录清单 + 内置默认地址', () => {
    const store = makeStore();
    expect(store.get()).toEqual({ enabled: false, urlOverride: null, workspaces: {} });
    expect(store.effectiveUrl()).toBe(SLACK_HOOK_DEFAULT_URL);
  });

  it('setEnabled / setWorkspaces 落盘, 重建实例仍在', () => {
    const abs = path.join(dir, 'repo');
    makeStore().setEnabled(true);
    makeStore().setWorkspaces({ xdmaker: abs });
    const reread = makeStore().get();
    expect(reread.enabled).toBe(true);
    expect(reread.workspaces).toEqual({ xdmaker: abs });
  });

  it('urlOverride(手工写入配置文件的隐藏覆写位)生效; 非法值忽略', () => {
    fs.writeFileSync(
      filePath(),
      JSON.stringify({ enabled: true, urlOverride: 'ws://127.0.0.1:8790', workspaces: {} }),
    );
    expect(makeStore().effectiveUrl()).toBe('ws://127.0.0.1:8790');
    fs.writeFileSync(
      filePath(),
      JSON.stringify({ enabled: true, urlOverride: 'http://not-ws', workspaces: {} }),
    );
    expect(makeStore().effectiveUrl()).toBe(SLACK_HOOK_DEFAULT_URL);
  });
});

describe('workspaces 校验', () => {
  it('非法别名 / 相对路径拒绝', () => {
    expect(() => validateWorkspaces({ '别名': path.join(dir, 'x') })).toThrow(
      HookConnectionValidationError,
    );
    expect(() => validateWorkspaces({ ok: 'relative/path' })).toThrow(
      HookConnectionValidationError,
    );
  });

  it('路径 trim 后保留', () => {
    const abs = path.join(dir, 'repo');
    expect(validateWorkspaces({ ok: `  ${abs}  ` })).toEqual({ ok: abs });
  });

  it('保留别名 chat(内置对话伪目录)不许用作真实目录别名', () => {
    expect(() => validateWorkspaces({ chat: path.join(dir, 'x') })).toThrow(
      HookConnectionValidationError,
    );
  });
});

describe('旧多连接文件迁移', () => {
  it('取最早创建的启用条目, 旧文件删除, 旧 secret 清理钩子拿到全部 id', () => {
    const abs = path.join(dir, 'repo');
    fs.writeFileSync(
      legacyPath(),
      JSON.stringify([
        { id: 'b', name: 'later', url: 'wss://x', enabled: true, workspaces: { blog: abs }, createdAt: 200 },
        { id: 'a', name: 'earlier', url: 'wss://y', enabled: true, workspaces: { xdmaker: abs }, createdAt: 100 },
        { id: 'c', name: 'off', url: 'wss://z', enabled: false, workspaces: {}, createdAt: 50 },
      ]),
    );
    const cleaned: string[][] = [];
    const store = makeStore((ids) => cleaned.push(ids));
    const state = store.get();
    expect(state.enabled).toBe(true);
    expect(state.workspaces).toEqual({ xdmaker: abs }); // 最早创建的启用条目 a
    expect(state.urlOverride).toBeNull(); // 旧自部署地址不迁移
    expect(fs.existsSync(legacyPath())).toBe(false);
    expect(cleaned.flat().sort()).toEqual(['a', 'b', 'c']);
    // 迁移结果已落盘, 二次读不再触发迁移
    expect(makeStore().get().workspaces).toEqual({ xdmaker: abs });
  });

  it('旧文件损坏: 迁移跳过, 回默认态', () => {
    fs.writeFileSync(legacyPath(), 'not-json');
    expect(makeStore().get()).toEqual({ enabled: false, urlOverride: null, workspaces: {} });
  });
});
