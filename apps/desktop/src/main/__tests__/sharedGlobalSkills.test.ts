import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  prepareSharedGlobalSkillLinks,
  sharedGlobalSkillsPaths,
} from '../maker-host/shared-global-skills';

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-global-skills-'));
  tmpDirs.push(dir);
  return dir;
}

async function writeSkill(skillsDir: string, name: string): Promise<string> {
  const skillDir = path.join(skillsDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test skill\n---\n\nbody\n`,
    'utf8',
  );
  return skillDir;
}

async function sameRealPath(a: string, b: string): Promise<boolean> {
  const [ra, rb] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
  const normalize = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(ra) === normalize(rb);
}

afterEach(async () => {
  const dirs = tmpDirs;
  tmpDirs = [];
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('prepareSharedGlobalSkillLinks', () => {
  it('links existing Claude skills into the shared skills root for Codex visibility', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const claudeSkill = await writeSkill(paths.claudeSkillsDir, 'claude-only');

    const result = await prepareSharedGlobalSkillLinks({ homeDir });

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(await sameRealPath(path.join(paths.sharedSkillsDir, 'claude-only'), claudeSkill)).toBe(true);
  });

  it('links shared skills into Claude skills so Claude Code can load them', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'shared-only');

    const result = await prepareSharedGlobalSkillLinks({ homeDir });

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(await sameRealPath(path.join(paths.claudeSkillsDir, 'shared-only'), sharedSkill)).toBe(true);
  });

  it('links existing Codex skills into Claude without creating a shared duplicate', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const codexSkill = await writeSkill(paths.codexSkillsDir, 'codex-only');

    await prepareSharedGlobalSkillLinks({ homeDir });
    const secondResult = await prepareSharedGlobalSkillLinks({ homeDir });

    expect(secondResult.changed).toBe(false);
    expect(secondResult.warnings).toEqual([]);
    expect(await sameRealPath(path.join(paths.claudeSkillsDir, 'codex-only'), codexSkill)).toBe(true);
    await expect(fs.lstat(path.join(paths.sharedSkillsDir, 'codex-only'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not overwrite conflicting real skill directories', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'duplicate');
    const claudeSkill = await writeSkill(paths.claudeSkillsDir, 'duplicate');

    const result = await prepareSharedGlobalSkillLinks({ homeDir });

    expect(result.warnings.some((warning) => warning.includes('duplicate'))).toBe(true);
    expect(await sameRealPath(path.join(paths.sharedSkillsDir, 'duplicate'), sharedSkill)).toBe(true);
    expect(await sameRealPath(path.join(paths.claudeSkillsDir, 'duplicate'), claudeSkill)).toBe(true);
    expect(await sameRealPath(path.join(paths.sharedSkillsDir, 'duplicate'), path.join(paths.claudeSkillsDir, 'duplicate'))).toBe(false);
  });

  it('does not overwrite user-owned symlinks that point elsewhere', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'user-link');
    const externalSkill = await writeSkill(path.join(root, 'external-skills'), 'user-link');
    const claudeLink = path.join(paths.claudeSkillsDir, 'user-link');
    await fs.mkdir(paths.claudeSkillsDir, { recursive: true });
    await fs.symlink(externalSkill, claudeLink, process.platform === 'win32' ? 'junction' : 'dir');

    const result = await prepareSharedGlobalSkillLinks({ homeDir });

    expect(result.warnings.some((warning) => warning.includes('user-link'))).toBe(true);
    expect(await sameRealPath(claudeLink, externalSkill)).toBe(true);
    expect(await sameRealPath(claudeLink, sharedSkill)).toBe(false);
  });

  it('cleans up broken managed links after the source skill is removed', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const claudeSkill = await writeSkill(paths.claudeSkillsDir, 'removed-later');

    await prepareSharedGlobalSkillLinks({ homeDir });
    expect(await sameRealPath(path.join(paths.sharedSkillsDir, 'removed-later'), claudeSkill)).toBe(true);

    await fs.rm(claudeSkill, { recursive: true, force: true });
    const result = await prepareSharedGlobalSkillLinks({ homeDir });

    expect(result.changed).toBe(true);
    await expect(fs.lstat(path.join(paths.sharedSkillsDir, 'removed-later'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
