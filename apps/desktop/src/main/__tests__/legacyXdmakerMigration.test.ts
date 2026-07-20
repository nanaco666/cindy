import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import {
  migrateLegacyXdmakerDir,
  resetLegacyXdmakerMigrationCacheForTest,
} from '../utils/legacyXdmakerMigration';

describe('migrateLegacyXdmakerDir', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdmaker-migration-'));
    resetLegacyXdmakerMigrationCacheForTest();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, content = 'x') {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }

  it('no-op 当 .xdmaker 不存在', async () => {
    await migrateLegacyXdmakerDir(root);
    expect(fs.existsSync(path.join(root, '.cindy'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.xdmaker'))).toBe(false);
  });

  it('.cindy 不存在时整目录 rename', async () => {
    write('.xdmaker/automations/schedules.json', '{"version":1,"schedules":[]}');
    write('.xdmaker/project-knowledge/TOC.md', '# toc');

    await migrateLegacyXdmakerDir(root);

    expect(fs.existsSync(path.join(root, '.xdmaker'))).toBe(false);
    expect(
      fs.readFileSync(path.join(root, '.cindy', 'automations', 'schedules.json'), 'utf8'),
    ).toContain('"version"');
    expect(fs.readFileSync(path.join(root, '.cindy', 'project-knowledge', 'TOC.md'), 'utf8')).toBe(
      '# toc',
    );
  });

  it('.cindy 已存在时只搬缺失子项并删掉空壳', async () => {
    write('.xdmaker/automations/schedules.json', 'old-automations');
    write('.cindy/project-knowledge/TOC.md', 'new-toc');

    await migrateLegacyXdmakerDir(root);

    expect(fs.existsSync(path.join(root, '.xdmaker'))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.cindy', 'automations', 'schedules.json'), 'utf8')).toBe(
      'old-automations',
    );
    expect(fs.readFileSync(path.join(root, '.cindy', 'project-knowledge', 'TOC.md'), 'utf8')).toBe(
      'new-toc',
    );
  });

  it('同名子项冲突时保留旧目录且绝不覆盖 .cindy 侧', async () => {
    write('.xdmaker/automations/schedules.json', 'legacy');
    write('.cindy/automations/schedules.json', 'current');

    await migrateLegacyXdmakerDir(root);

    expect(fs.readFileSync(path.join(root, '.cindy', 'automations', 'schedules.json'), 'utf8')).toBe(
      'current',
    );
    expect(
      fs.readFileSync(path.join(root, '.xdmaker', 'automations', 'schedules.json'), 'utf8'),
    ).toBe('legacy');
  });

  it('幂等：同一 root 重复调用不报错、结果不变', async () => {
    write('.xdmaker/project-knowledge/TOC.md', '# toc');

    await migrateLegacyXdmakerDir(root);
    await migrateLegacyXdmakerDir(root);
    resetLegacyXdmakerMigrationCacheForTest();
    await migrateLegacyXdmakerDir(root);

    expect(fs.existsSync(path.join(root, '.xdmaker'))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.cindy', 'project-knowledge', 'TOC.md'), 'utf8')).toBe(
      '# toc',
    );
  });

  it('.xdmaker 是普通文件（非目录）时不动它', async () => {
    write('.xdmaker', 'not-a-dir');

    await migrateLegacyXdmakerDir(root);

    expect(fs.readFileSync(path.join(root, '.xdmaker'), 'utf8')).toBe('not-a-dir');
    expect(fs.existsSync(path.join(root, '.cindy'))).toBe(false);
  });

  it('rootDir 为空时静默返回', async () => {
    await expect(migrateLegacyXdmakerDir('')).resolves.toBeUndefined();
  });
});
