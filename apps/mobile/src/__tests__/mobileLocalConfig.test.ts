import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureMobileLocalRegionConfig,
  parseGitWorktreeEntries,
} from '../../scripts/lib/mobile-local-config.mjs';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('mobile local config bootstrap', () => {
  it('prefers a configured personal client and copies no values to output', () => {
    const parent = mkdtempSync(join(tmpdir(), 'cindy-mobile-config-'));
    roots.push(parent);
    const targetRoot = join(parent, 'cindy-feature');
    const personalRoot = join(parent, 'cindy-personal-client');
    const mainRoot = join(parent, 'cindy');
    const targetMobile = join(targetRoot, 'apps', 'mobile');
    for (const root of [targetRoot, personalRoot, mainRoot]) {
      mkdirSync(join(root, 'apps', 'mobile', 'scripts'), { recursive: true });
    }
    writeFileSync(join(mainRoot, 'apps/mobile/scripts/self-host-regions.json'), '{"source":"main"}\n');
    writeFileSync(join(personalRoot, 'apps/mobile/scripts/self-host-regions.json'), '{"source":"personal"}\n');

    const result = ensureMobileLocalRegionConfig({
      mobileDir: targetMobile,
      validateConfig: () => undefined,
      worktreeEntries: [
        { path: mainRoot, branch: 'refs/heads/main' },
        { path: personalRoot, branch: 'refs/heads/dash/personal-client-1' },
        { path: targetRoot, branch: 'refs/heads/dash/feature' },
      ],
    });

    expect(result.copiedFrom).toBe(join(personalRoot, 'apps/mobile/scripts/self-host-regions.json'));
    expect(readFileSync(result.configPath, 'utf8')).toContain('personal');
  });

  it('keeps an existing valid config untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'cindy-mobile-config-'));
    roots.push(root);
    const mobileDir = join(root, 'apps/mobile');
    const configPath = join(mobileDir, 'scripts/self-host-regions.json');
    mkdirSync(join(mobileDir, 'scripts'), { recursive: true });
    writeFileSync(configPath, '{"existing":true}\n');

    const result = ensureMobileLocalRegionConfig({
      mobileDir,
      validateConfig: () => undefined,
      worktreeEntries: [],
    });

    expect(result).toEqual({ configPath, copiedFrom: null });
    expect(existsSync(configPath)).toBe(true);
  });

  it('accepts the valid config published by a concurrent bootstrap', () => {
    const parent = mkdtempSync(join(tmpdir(), 'cindy-mobile-config-'));
    roots.push(parent);
    const targetRoot = join(parent, 'cindy-feature');
    const sourceRoot = join(parent, 'cindy-personal-client');
    const mobileDir = join(targetRoot, 'apps/mobile');
    const configPath = join(mobileDir, 'scripts/self-host-regions.json');
    const sourcePath = join(sourceRoot, 'apps/mobile/scripts/self-host-regions.json');
    mkdirSync(join(mobileDir, 'scripts'), { recursive: true });
    mkdirSync(join(sourceRoot, 'apps/mobile/scripts'), { recursive: true });
    writeFileSync(sourcePath, '{"source":"candidate"}\n');

    const result = ensureMobileLocalRegionConfig({
      mobileDir,
      worktreeEntries: [{ path: sourceRoot, branch: 'refs/heads/dash/personal-client-1' }],
      validateConfig(candidate: string) {
        if (candidate === sourcePath && !existsSync(configPath)) {
          writeFileSync(configPath, '{"source":"concurrent-winner"}\n');
        }
      },
    });

    expect(result).toEqual({ configPath, copiedFrom: null });
    expect(readFileSync(configPath, 'utf8')).toContain('concurrent-winner');
  });

  it('parses worktree branch ownership', () => {
    expect(parseGitWorktreeEntries([
      'worktree /repo/cindy',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /repo/cindy-personal-client',
      'HEAD def',
      'branch refs/heads/dash/personal-client-1',
    ].join('\n'))).toEqual([
      { path: '/repo/cindy', branch: 'refs/heads/main' },
      { path: '/repo/cindy-personal-client', branch: 'refs/heads/dash/personal-client-1' },
    ]);
  });
});
