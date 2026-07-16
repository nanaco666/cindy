import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { convertSkills } from '../converters/skills.js';
import type { MigrationItem } from '../types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xagent-skills-'));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeItem(direction: 'to-codex' | 'to-claude', subItems: { name: string; sourcePath: string; targetPath: string }[]): MigrationItem {
  return {
    id: 'skills:0',
    kind: 'skills',
    direction,
    label: 'skills',
    source: '/dummy',
    target: '/dummy',
    subItems,
  };
}

describe('convertSkills', () => {
  it('copies a skill subdirectory recursively, rewrites SKILL.md, preserves binaries', async () => {
    const src = path.join(tmpDir, 'src', 'mySkill');
    const dst = path.join(tmpDir, 'dst', 'mySkill');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, 'SKILL.md'), '# skill for Claude Code');
    await fs.writeFile(path.join(src, 'data.bin'), Buffer.from([0x00, 0x01, 0x02]));
    await fs.mkdir(path.join(src, 'sub'), { recursive: true });
    await fs.writeFile(path.join(src, 'sub', 'note.md'), 'using claude');

    const item = makeItem('to-codex', [{ name: 'mySkill', sourcePath: src, targetPath: dst }]);
    const r = await convertSkills(item);
    expect(r.status).toBe('success');

    expect(await fs.readFile(path.join(dst, 'SKILL.md'), 'utf8')).toBe('# skill for Codex');
    expect(await fs.readFile(path.join(dst, 'sub', 'note.md'), 'utf8')).toBe('using codex');
    const bin = await fs.readFile(path.join(dst, 'data.bin'));
    expect(bin.equals(Buffer.from([0x00, 0x01, 0x02]))).toBe(true);
  });

  it('skips sub-items whose target already exists (does NOT touch user content)', async () => {
    const src = path.join(tmpDir, 'src', 'a');
    const dst = path.join(tmpDir, 'dst', 'a');
    await fs.mkdir(src, { recursive: true });
    await fs.mkdir(dst, { recursive: true });
    await fs.writeFile(path.join(src, 'SKILL.md'), '# new');
    await fs.writeFile(path.join(dst, 'SKILL.md'), '# user content');

    const item = makeItem('to-codex', [{ name: 'a', sourcePath: src, targetPath: dst }]);
    const r = await convertSkills(item);
    expect(r.status).toBe('skipped');
    expect(await fs.readFile(path.join(dst, 'SKILL.md'), 'utf8')).toBe('# user content');
  });

  it('multi sub-item: one fails, others still succeed', async () => {
    const goodSrc = path.join(tmpDir, 'src', 'good');
    const goodDst = path.join(tmpDir, 'dst', 'good');
    await fs.mkdir(goodSrc, { recursive: true });
    await fs.writeFile(path.join(goodSrc, 'SKILL.md'), '# claude');
    const badSrc = path.join(tmpDir, 'src', 'missing'); // doesn't exist
    const badDst = path.join(tmpDir, 'dst', 'missing');

    const item = makeItem('to-codex', [
      { name: 'good', sourcePath: goodSrc, targetPath: goodDst },
      { name: 'missing', sourcePath: badSrc, targetPath: badDst },
    ]);
    const r = await convertSkills(item);
    expect(r.status).toBe('failed');
    expect(await fs.readFile(path.join(goodDst, 'SKILL.md'), 'utf8')).toBe('# codex');
  });
});
