import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanMigrationPayloadFiles,
  cleanOldUpdateFiles,
  migrationPayloadTargetPath,
} from '../updateArtifacts';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-update-artifacts-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('update artifact isolation', () => {
  it('migration payload 固定落入 updates/migration 子目录', () => {
    expect(migrationPayloadTargetPath(root, 'releases/Cindy.zip')).toBe(
      path.join(root, 'updates', 'migration', 'Cindy.zip'),
    );
  });

  it('普通 hotfix 清理保留 migration 子目录及当前包 sidecar', () => {
    const migrationDir = path.join(root, 'migration');
    fs.mkdirSync(migrationDir, { recursive: true });
    fs.writeFileSync(path.join(migrationDir, 'Cindy.zip'), 'payload');
    for (const file of ['old.zip', 'current.zip', 'current.zip.meta.json', 'patch-info.json']) {
      fs.writeFileSync(path.join(root, file), file);
    }

    cleanOldUpdateFiles(root, 'current.zip', ['patch-info.json']);

    expect(fs.existsSync(path.join(root, 'old.zip'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'current.zip'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'current.zip.meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(migrationDir, 'Cindy.zip'))).toBe(true);
  });

  it('迁移 payload 清理可保留当前包及 sidecar，并在终态清空目录', () => {
    const current = migrationPayloadTargetPath(root, 'Cindy-1.0.1.zip');
    const migrationDir = path.dirname(current);
    fs.mkdirSync(migrationDir, { recursive: true });
    for (const file of [
      'Cindy-1.0.0.zip',
      'Cindy-1.0.0.zip.part',
      'Cindy-1.0.1.zip',
      'Cindy-1.0.1.zip.part',
      'Cindy-1.0.1.zip.meta.json',
    ]) {
      fs.writeFileSync(path.join(migrationDir, file), file);
    }

    cleanMigrationPayloadFiles(root, current);

    expect(fs.existsSync(path.join(migrationDir, 'Cindy-1.0.0.zip'))).toBe(false);
    expect(fs.existsSync(path.join(migrationDir, 'Cindy-1.0.0.zip.part'))).toBe(false);
    expect(fs.existsSync(current)).toBe(true);
    expect(fs.existsSync(`${current}.part`)).toBe(true);
    expect(fs.existsSync(`${current}.meta.json`)).toBe(true);

    cleanMigrationPayloadFiles(root);
    expect(fs.existsSync(migrationDir)).toBe(false);
  });
});
