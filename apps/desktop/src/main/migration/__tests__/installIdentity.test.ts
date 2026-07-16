import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  captureLegacyInstallIdentity,
  matchesLegacyInstallIdentity,
} from '../installIdentity';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-install-identity-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function executablePath(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? path.join(root, 'xdt-maker.exe')
    : path.join(root, 'Contents', 'MacOS', 'xdt-maker');
}

describe.each(['win32', 'darwin'] as const)('legacy install identity (%s)', (platform) => {
  it('同一可执行文件匹配，路径相同但被替换后拒绝', () => {
    const executable = executablePath(platform);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, 'same-version-bytes');
    const identity = captureLegacyInstallIdentity(root, 'xdt-maker', platform);

    expect(identity).not.toBeNull();
    expect(matchesLegacyInstallIdentity(root, identity)).toBe(true);

    // replacement 与 original 同时存在，因此文件对象身份必然不同；即使字节相同、
    // 最终路径相同，也模拟了观察期内重装/覆盖旧应用的场景。
    const replacement = `${executable}.replacement`;
    fs.writeFileSync(replacement, 'same-version-bytes');
    fs.rmSync(executable);
    fs.renameSync(replacement, executable);
    expect(matchesLegacyInstallIdentity(root, identity)).toBe(false);
  });
});

it('缺失身份、缺失文件或越界相对路径一律 fail closed', () => {
  expect(captureLegacyInstallIdentity(root, 'bad/app', 'win32')).toBeNull();
  expect(matchesLegacyInstallIdentity(root, null)).toBe(false);
  expect(matchesLegacyInstallIdentity(root, {
    schemaVersion: 1,
    executableRelativePath: '../outside.exe',
    dev: '0',
    ino: '0',
    size: '0',
    mtimeNs: '0',
    birthtimeNs: '0',
  })).toBe(false);
});
