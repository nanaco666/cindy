import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listMigrationMainDbFiles, probeMigrationLocalDbs } from '../localDbProbe';

let userDataDir: string;

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-local-db-probe-'));
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('listMigrationMainDbFiles', () => {
  it('Cindy 构建同时发现当前前缀与原样复制的 XDMaker 主库', () => {
    for (const file of [
      'cindy-new-user.db',
      'xdt-maker-legacy-user.db',
      'unrelated.db',
      'xdt-maker-legacy-user.db-wal',
    ]) {
      fs.writeFileSync(path.join(userDataDir, file), 'x');
    }

    expect(listMigrationMainDbFiles(userDataDir, 'cindy').sort()).toEqual([
      'cindy-new-user.db',
      'xdt-maker-legacy-user.db',
    ]);
  });

  it('当前前缀仍为 xdt-maker 时稳定去重', () => {
    fs.writeFileSync(path.join(userDataDir, 'xdt-maker-user.db'), 'x');
    expect(listMigrationMainDbFiles(userDataDir, 'xdt-maker')).toEqual(['xdt-maker-user.db']);
  });
});

describe('probeMigrationLocalDbs', () => {
  it('以可写方式恢复复制来的未 checkpoint WAL 后再执行 quick_check', () => {
    const sourceDir = path.join(userDataDir, 'source');
    const targetDir = path.join(userDataDir, 'target');
    fs.mkdirSync(sourceDir);
    fs.mkdirSync(targetDir);
    const fileName = 'xdt-maker-legacy-user.db';
    const sourcePath = path.join(sourceDir, fileName);
    const targetPath = path.join(targetDir, fileName);
    const sourceDb = new Database(sourcePath);

    try {
      sourceDb.pragma('journal_mode = WAL');
      sourceDb.pragma('wal_autocheckpoint = 0');
      sourceDb.exec('CREATE TABLE migrated_items (value TEXT NOT NULL)');
      sourceDb.prepare('INSERT INTO migrated_items (value) VALUES (?)').run('from-wal');

      for (const suffix of ['', '-wal', '-shm']) {
        fs.copyFileSync(`${sourcePath}${suffix}`, `${targetPath}${suffix}`);
      }

      expect(probeMigrationLocalDbs(
        targetDir,
        'cindy',
        (filePath) => new Database(filePath),
      )).toEqual([]);

      const verified = new Database(targetPath, { readonly: true });
      try {
        expect(verified.prepare('SELECT value FROM migrated_items').pluck().get()).toBe('from-wal');
      } finally {
        verified.close();
      }
      expect(fs.statSync(`${targetPath}-wal`).size).toBe(0);
    } finally {
      sourceDb.close();
    }
  });

  it('历史库 quick_check 异常只告警，不阻断其它账号库迁移', () => {
    for (const file of ['xdt-maker-bad.db', 'xdt-maker-good.db']) {
      fs.writeFileSync(path.join(userDataDir, file), 'placeholder');
    }
    const closed: string[] = [];
    const warnings = probeMigrationLocalDbs(userDataDir, 'cindy', (filePath) => ({
      pragma: (source) => source === 'quick_check'
        ? [{ quick_check: filePath.endsWith('bad.db') ? 'database disk image is malformed' : 'ok' }]
        : [{ busy: 0 }],
      close: () => closed.push(path.basename(filePath)),
    }));

    expect(warnings).toEqual([
      'quick_check(xdt-maker-bad.db) = database disk image is malformed',
    ]);
    expect(closed.sort()).toEqual(['xdt-maker-bad.db', 'xdt-maker-good.db']);
  });

  it('单库 open/pragma/close 抛错均隔离为 warning，并继续探测其余库', () => {
    for (const file of [
      'xdt-maker-open-fail.db',
      'xdt-maker-pragma-fail.db',
      'xdt-maker-close-fail.db',
      'xdt-maker-good.db',
    ]) fs.writeFileSync(path.join(userDataDir, file), 'placeholder');

    const opened: string[] = [];
    const warnings = probeMigrationLocalDbs(userDataDir, 'cindy', (filePath) => {
      const file = path.basename(filePath);
      opened.push(file);
      if (file.includes('open-fail')) throw new Error('not a database');
      return {
        pragma: (source) => {
          if (file.includes('pragma-fail')) throw new Error('SQLITE_CORRUPT');
          return source === 'quick_check' ? [{ quick_check: 'ok' }] : [{ busy: 0 }];
        },
        close: () => {
          if (file.includes('close-fail')) throw new Error('close failed');
        },
      };
    });

    expect(opened).toHaveLength(4);
    expect(warnings).toEqual(expect.arrayContaining([
      'probe(xdt-maker-open-fail.db) failed: not a database',
      'probe(xdt-maker-pragma-fail.db) failed: SQLITE_CORRUPT',
      'close(xdt-maker-close-fail.db) failed: close failed',
    ]));
    expect(warnings).toHaveLength(3);
  });
});
