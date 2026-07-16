import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { probeSafeStorageDirectory } from '../safeStorageProbe';

let userDataDir: string;

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-safe-storage-probe-'));
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

function writeStore(name: string, content: string): void {
  const dir = path.join(userDataDir, 'safe-storage');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.enc`), content);
}

describe('probeSafeStorageDirectory', () => {
  it('无存量凭证时不要求加密后端可用', () => {
    expect(probeSafeStorageDirectory(userDataDir, {
      isAvailable: () => false,
      decryptFromBase64: vi.fn(),
    })).toEqual({ total: 0, readable: 0, unreadableStores: [] });
  });

  it('有存量凭证但加密后端不可用时阻断迁移', () => {
    writeStore('api_key', 'encrypted');
    expect(() => probeSafeStorageDirectory(userDataDir, {
      isAvailable: () => false,
      decryptFromBase64: vi.fn(),
    })).toThrow('backend unavailable');
  });

  it('逐个验证并容忍历史不可解密孤儿', () => {
    writeStore('good', 'readable');
    writeStore('stale', 'broken');
    const result = probeSafeStorageDirectory(userDataDir, {
      isAvailable: () => true,
      decryptFromBase64: (content) => {
        if (content === 'broken') throw new Error('foreign keychain');
      },
    });
    expect(result).toEqual({ total: 2, readable: 1, unreadableStores: ['stale'] });
  });
});
