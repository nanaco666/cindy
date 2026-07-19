import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquirePassiveDevLock } from '../passiveDevLock.js';

describe('passiveDevLock', () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-passive-lock-'));
    lockPath = path.join(tempDir, '.passive-dev.lock');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('同一作用域只有第一个实例能原子获取', () => {
    const first = acquirePassiveDevLock({ lockPath, heartbeatIntervalMs: 0 });
    const second = acquirePassiveDevLock({ lockPath, heartbeatIntervalMs: 0 });

    expect(first.acquired).toBe(true);
    expect(second).toMatchObject({ acquired: false, reason: 'occupied' });
    if (first.acquired) expect(first.lock.release()).toEqual({ released: true });
  });

  it('release 后新实例可重新获取', () => {
    const first = acquirePassiveDevLock({ lockPath, heartbeatIntervalMs: 0 });
    if (!first.acquired) throw new Error('first lock should be acquired');
    expect(first.lock.release()).toEqual({ released: true });

    const second = acquirePassiveDevLock({ lockPath, heartbeatIntervalMs: 0 });
    expect(second.acquired).toBe(true);
    if (second.acquired) expect(second.lock.release()).toEqual({ released: true });
  });

  it('死亡 PID 的 stale 锁可回收', () => {
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 424242, startedAtMs: 1, ownerToken: 'dead-owner' })}\n`,
    );

    const result = acquirePassiveDevLock({
      lockPath,
      isProcessAlive: () => false,
      heartbeatIntervalMs: 0,
    });
    expect(result.acquired).toBe(true);
    if (result.acquired) expect(result.lock.release()).toEqual({ released: true });
  });

  it('近期空白或非法锁 fail-closed，避免删除正在写 owner 的文件', () => {
    fs.writeFileSync(lockPath, '');
    expect(
      acquirePassiveDevLock({ lockPath, now: Date.now, heartbeatIntervalMs: 0 }),
    ).toMatchObject({ acquired: false, reason: 'occupied' });

    fs.writeFileSync(lockPath, '{invalid-json');
    expect(
      acquirePassiveDevLock({ lockPath, now: Date.now, heartbeatIntervalMs: 0 }),
    ).toMatchObject({ acquired: false, reason: 'occupied' });
  });

  it('进程存活探测遇到 EPERM 等未知错误时按仍存活处理', () => {
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 88, startedAtMs: 1, ownerToken: 'protected-owner' })}\n`,
    );
    const result = acquirePassiveDevLock({
      lockPath,
      isProcessAlive: () => {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      },
      heartbeatIntervalMs: 0,
    });

    expect(result).toMatchObject({ acquired: false, reason: 'occupied', ownerPid: 88 });
  });

  it('超过 grace 的非法残锁可回收', () => {
    fs.writeFileSync(lockPath, '{old-invalid-json');
    const result = acquirePassiveDevLock({
      lockPath,
      now: () => Date.now() + 10_000,
      invalidLockGraceMs: 5_000,
      heartbeatIntervalMs: 0,
    });

    expect(result.acquired).toBe(true);
    if (result.acquired) expect(result.lock.release()).toEqual({ released: true });
  });

  it('heartbeat 过期但 PID 仍存活时 fail-closed，不把暂停或休眠误判成死亡', () => {
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 99, startedAtMs: 1, ownerToken: 'reused-pid' })}\n`,
    );
    const result = acquirePassiveDevLock({
      lockPath,
      now: () => Date.now() + 120_000,
      isProcessAlive: () => true,
      heartbeatIntervalMs: 0,
    });

    expect(result).toMatchObject({ acquired: false, reason: 'occupied', ownerPid: 99 });
  });

  it('release 只删除自己的 owner token，不会删掉新 owner', () => {
    const result = acquirePassiveDevLock({ lockPath, heartbeatIntervalMs: 0 });
    if (!result.acquired) throw new Error('lock should be acquired');
    const replacement = { pid: 7, startedAtMs: 2, ownerToken: 'replacement' };
    fs.writeFileSync(lockPath, `${JSON.stringify(replacement)}\n`);

    expect(result.lock.release()).toEqual({ released: false, reason: 'not-owner' });
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toEqual(replacement);
  });
});
