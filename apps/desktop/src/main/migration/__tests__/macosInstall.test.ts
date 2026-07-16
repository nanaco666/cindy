import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installMacPayloadAtomic,
  macInstallBackupPath,
  recoverInterruptedMacInstall,
} from '../macosInstall';

let root: string;
let destApp: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-mac-install-'));
  destApp = path.join(root, 'Cindy.app');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeBundle(bundlePath: string, content: string): void {
  const executable = path.join(bundlePath, 'Contents', 'MacOS', 'cindy');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, content);
}

describe('installMacPayloadAtomic', () => {
  it('下次启动可从确定性备份恢复两次 rename 之间的中断', () => {
    writeBundle(destApp, 'existing');
    const backupApp = macInstallBackupPath(destApp);
    fs.renameSync(destApp, backupApp);

    expect(recoverInterruptedMacInstall(destApp)).toBe('restored-backup');
    expect(fs.readFileSync(path.join(destApp, 'Contents', 'MacOS', 'cindy'), 'utf8'))
      .toBe('existing');
    expect(fs.existsSync(backupApp)).toBe(false);
  });

  it('正式路径已落位时清理上次残留的确定性备份', () => {
    writeBundle(destApp, 'new');
    const backupApp = macInstallBackupPath(destApp);
    writeBundle(backupApp, 'old');

    expect(recoverInterruptedMacInstall(destApp)).toBe('removed-stale-backup');
    expect(fs.existsSync(backupApp)).toBe(false);
    expect(fs.readFileSync(path.join(destApp, 'Contents', 'MacOS', 'cindy'), 'utf8')).toBe('new');
  });

  it('ditto 解压失败时保留已有 Cindy.app', async () => {
    writeBundle(destApp, 'existing');

    await expect(installMacPayloadAtomic({
      payloadPath: path.join(root, 'cindy.zip'),
      destApp,
      expectedExecutableName: 'cindy',
      extractArchive: vi.fn(async () => { throw new Error('ditto failed'); }),
    })).rejects.toThrow('ditto failed');

    expect(fs.readFileSync(path.join(destApp, 'Contents', 'MacOS', 'cindy'), 'utf8')).toBe('existing');
  });

  it('解压产物缺少预期可执行文件时保留已有安装', async () => {
    writeBundle(destApp, 'existing');

    await expect(installMacPayloadAtomic({
      payloadPath: path.join(root, 'cindy.zip'),
      destApp,
      expectedExecutableName: 'cindy',
      extractArchive: vi.fn(async (_payload, stagingDir) => {
        fs.mkdirSync(path.join(stagingDir, 'Cindy.app'), { recursive: true });
      }),
    })).rejects.toThrow();

    expect(fs.readFileSync(path.join(destApp, 'Contents', 'MacOS', 'cindy'), 'utf8')).toBe('existing');
  });

  it('校验通过后替换 bundle 并清理 staging/backup', async () => {
    writeBundle(destApp, 'existing');

    await installMacPayloadAtomic({
      payloadPath: path.join(root, 'cindy.zip'),
      destApp,
      expectedExecutableName: 'cindy',
      extractArchive: async (_payload, stagingDir) => {
        writeBundle(path.join(stagingDir, 'Cindy.app'), 'new');
      },
    });

    expect(fs.readFileSync(path.join(destApp, 'Contents', 'MacOS', 'cindy'), 'utf8')).toBe('new');
    expect(fs.readdirSync(root).filter((name) => name.startsWith('.Cindy.app.'))).toEqual([]);
  });
});
