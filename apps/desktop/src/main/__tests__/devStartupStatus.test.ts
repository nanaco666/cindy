import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  beginDesktopDevInstance,
  markDesktopDevReady,
  markDesktopDevStartupFailed,
} from '../devStartupStatus.js';

describe('devStartupStatus', () => {
  let tempDir: string;
  let statusPath: string;
  let cleanup: (() => void) | null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-dev-status-'));
    statusPath = path.join(tempDir, 'startup.json');
    process.env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE = statusPath;
    cleanup = null;
  });

  afterEach(() => {
    cleanup?.();
    delete process.env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists source metadata and marks both records ready', () => {
    fs.writeFileSync(statusPath, '{"state":"pending"}\n');
    cleanup = beginDesktopDevInstance({
      userDataDir: tempDir,
      rootDir: path.join(tempDir, 'repo'),
      commit: 'abc123',
      mode: 'remote',
      passive: true,
      isolated: false,
      pid: 4242,
      instanceId: 'test-owner',
      startedAtMs: 100,
    });

    markDesktopDevReady();

    const external = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    const persistent = JSON.parse(fs.readFileSync(
      path.join(tempDir, '.dev-instances', '4242.json'),
      'utf8',
    ));
    expect(external).toMatchObject({ state: 'ready', instance: { commit: 'abc123' } });
    expect(persistent).toMatchObject({
      state: 'ready',
      rootDir: path.join(tempDir, 'repo'),
      mode: 'remote',
      passive: true,
    });
  });

  it('preserves a concrete main-process failure for the restart waiter', () => {
    fs.writeFileSync(statusPath, '{"state":"pending"}\n');
    cleanup = beginDesktopDevInstance({
      userDataDir: tempDir,
      rootDir: tempDir,
      mode: 'remote',
      passive: true,
      isolated: false,
      pid: 4243,
    });

    markDesktopDevStartupFailed(
      'SINGLE_INSTANCE_OWNED',
      'Another Cindy instance owns the primary slot.',
      { userDataDir: '/tmp/Cindy' },
    );

    expect(JSON.parse(fs.readFileSync(statusPath, 'utf8'))).toMatchObject({
      state: 'failed',
      code: 'SINGLE_INSTANCE_OWNED',
      detail: { userDataDir: '/tmp/Cindy' },
    });
    expect(JSON.parse(fs.readFileSync(
      path.join(tempDir, '.dev-instances', '4243.json'),
      'utf8',
    ))).toMatchObject({
      state: 'failed',
      failure: { code: 'SINGLE_INSTANCE_OWNED' },
    });
  });

  it('cleanup never deletes a record that has been replaced by another owner', () => {
    cleanup = beginDesktopDevInstance({
      userDataDir: tempDir,
      rootDir: tempDir,
      passive: false,
      isolated: false,
      pid: 4244,
      instanceId: 'first-owner',
    });
    const instancePath = path.join(tempDir, '.dev-instances', '4244.json');
    fs.writeFileSync(instancePath, '{"instanceId":"replacement"}\n');

    cleanup();
    cleanup = null;

    expect(fs.existsSync(instancePath)).toBe(true);
  });
});
