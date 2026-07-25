import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { collectLinuxRuntimeAssetProblems, createLinuxFirstReleaseManifest } =
  require('../../../scripts/ci/lib.mjs') as {
    collectLinuxRuntimeAssetProblems: (assetPaths?: string[]) => {
      missing: string[];
      invalid: string[];
    };
    createLinuxFirstReleaseManifest: (
      version: string,
      baseManifest?: Record<string, unknown>,
    ) => {
      app: Record<string, unknown>;
      claudeCode?: Record<string, unknown>;
      codex?: Record<string, unknown>;
    };
  };

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-release-manifest-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('createLinuxFirstReleaseManifest', () => {
  it('removes update-only and stale installer metadata while replacing app.version', () => {
    const manifest = createLinuxFirstReleaseManifest('1.2.4', {
      app: {
        version: '1.2.3',
        releaseNotes: 'hello',
        hotfix: {
          file: 'app/win32-x64/app.hotfix.zip',
          sha256: 'abc',
          size: 123,
        },
        installer: {
          file: 'app/win32-x64/setup.exe',
          sha256: 'def',
          size: 456,
        },
        requireRelogin: true,
      },
      claudeCode: {
        version: '2.0.0',
        file: 'claude-code/2.0.0/win32-x64/claude.exe.gz',
        sha256: 'ghi',
        size: 789,
      },
      codex: {
        version: '3.0.0',
        file: 'codex/3.0.0/win32-x64/codex.exe.gz',
        sha256: 'jkl',
        size: 321,
      },
      installer: {
        platform: 'darwin-arm64',
        file: 'app/darwin-arm64/xdt-maker.dmg',
        sha256: 'mno',
        size: 654,
      },
    });

    expect(manifest.app.version).toBe('1.2.4');
    expect(manifest.app.releaseNotes).toBe('hello');
    expect(manifest.app.hotfix).toBeUndefined();
    expect(manifest.app.requireRelogin).toBeUndefined();
    expect(manifest.app.installer).toBeUndefined();
    expect((manifest as Record<string, unknown>).installer).toBeUndefined();
    expect(manifest.claudeCode).toBeUndefined();
    expect(manifest.codex).toBeUndefined();
  });

  it('creates a baseline manifest when no source manifest exists', () => {
    const manifest = createLinuxFirstReleaseManifest('0.1.0');

    expect(manifest).toEqual({
      app: {
        version: '0.1.0',
      },
    });
  });
});

describe('collectLinuxRuntimeAssetProblems', () => {
  it('flags missing, Git LFS pointer, and implausibly small runtime assets', () => {
    const dir = makeTempDir();
    const ok = path.join(dir, 'ok.bin');
    const pointer = path.join(dir, 'pointer.bin');
    const tiny = path.join(dir, 'tiny.bin');
    const missing = path.join(dir, 'missing.bin');

    fs.writeFileSync(ok, Buffer.alloc(2048, 1));
    fs.writeFileSync(
      pointer,
      `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 123456\n`,
    );
    fs.writeFileSync(tiny, 'tiny');

    expect(collectLinuxRuntimeAssetProblems([ok, pointer, tiny, missing])).toEqual({
      missing: [missing],
      invalid: [pointer, tiny],
    });
  });
});
