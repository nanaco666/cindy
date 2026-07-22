import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { appMock, downloadMock } = vi.hoisted(() => ({
  appMock: { isPackaged: true, getPath: vi.fn<(name: string) => string>() },
  downloadMock: vi.fn(),
}));

vi.mock('electron', () => ({
  app: appMock,
  net: { request: vi.fn() },
}));
vi.mock('../../downloader/index.js', () => ({ download: downloadMock }));

let fallback: typeof import('../linux-runtime-fallback');
let tempDir = '';

describe.skipIf(process.platform !== 'linux')('legacy managed binary migration', () => {
  beforeAll(async () => {
    fallback = await import('../linux-runtime-fallback');
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-linux-runtime-migration-'));
    appMock.getPath.mockReturnValue(tempDir);
    downloadMock.mockRejectedValue(new Error('network download must not run during migration'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reuses and atomically migrates the exact pinned Claude cache without network access', async () => {
    const legacyPath = fallback.legacyManagedBinaryPath(tempDir, 'claude-code');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, '#!/bin/sh\necho "2.1.215 (Claude Code)"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(path.dirname(legacyPath), '.verified'), '');

    const result = await fallback.prepareLinuxRuntimeFallback('claude-code');

    expect(result).toMatchObject({ ready: true, installed: false, source: 'legacy' });
    expect(result.binaryPath).toBe(fallback.privateBinaryPath(tempDir, 'claude-code'));
    expect(fs.readFileSync(result.binaryPath, 'utf8')).toContain('2.1.215');
    expect(downloadMock).not.toHaveBeenCalled();
  });
});
