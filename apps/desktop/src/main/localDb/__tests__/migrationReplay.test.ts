import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { listMigrations, runMigrationReplay } from '../migrationRunner';

const canRunMigrationReplay = process.platform === 'win32' || process.platform === 'darwin';
const describeMigrationReplay = canRunMigrationReplay ? describe : describe.skip;

function desktopRoot(): string {
  return path.resolve(__dirname, '../../../..');
}

function drizzleDir(): string {
  return path.join(desktopRoot(), 'drizzle');
}

function sqliteVecFilename(): string {
  if (process.platform === 'win32') return 'vec0.dll';
  if (process.platform === 'darwin') return 'vec0.dylib';
  throw new Error(`migration replay tests only support bundled sqlite-vec on macOS/Windows`);
}

function loadSqliteVec(db: Database.Database): void {
  const extPath = path.join(
    desktopRoot(),
    'native',
    'sqlite-vec',
    `${process.platform}-${process.arch}`,
    sqliteVecFilename(),
  );
  db.loadExtension(extPath);
}

function createTempDb(): { db: Database.Database; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'xdmaker-migration-replay-'));
  const dbPath = path.join(dir, 'replay.db');
  const db = createBetterSqliteDatabase(dbPath);
  loadSqliteVec(db);
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function createTempDrizzleDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'xdmaker-drizzle-replay-'));
  writeFileSync(
    path.join(dir, '0000_create_marker.sql'),
    'CREATE TABLE migrated_marker (id TEXT PRIMARY KEY);\n',
    'utf-8',
  );
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function maxMigrationSeq(): number {
  return Math.max(...listMigrations(drizzleDir()).map((migration) => migration.seq));
}

function seedFixture(db: Database.Database, name: string): void {
  db.exec(readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8'));
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName) !==
    undefined
  );
}

function indexExists(db: Database.Database, indexName: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(indexName) !==
    undefined
  );
}

function columnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

describeMigrationReplay('migration replay', () => {
  it('replays every drizzle migration into a fresh database', () => {
    const { db, cleanup } = createTempDb();
    try {
      const result = runMigrationReplay(db, { drizzleDir: drizzleDir() });
      const schemaVersion = db
        .prepare("SELECT value FROM migration_meta WHERE key='schema_version'")
        .pluck()
        .get();
      const historyCount = db.prepare('SELECT COUNT(*) FROM migration_history').pluck().get();
      const partialIndexes = db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type='index'
             AND name IN ('uniq_active_team_per_lead', 'uniq_orca_workers_focused_per_team')
           ORDER BY name`,
        )
        .pluck()
        .all();

      expect(result.applied.map((migration) => migration.seq)).toEqual(
        listMigrations(drizzleDir()).map((migration) => migration.seq),
      );
      expect(schemaVersion).toBe(String(maxMigrationSeq()));
      expect(historyCount).toBe(result.applied.length);
      expect(partialIndexes).toEqual([
        'uniq_active_team_per_lead',
        'uniq_orca_workers_focused_per_team',
      ]);
    } finally {
      cleanup();
    }
  });

  it('upgrades a schema v39 Orca workflow database through the 0040 script', () => {
    const { db, cleanup } = createTempDb();
    try {
      seedFixture(db, 'schema-v39-orca-workflow.sql');

      const result = runMigrationReplay(db, { drizzleDir: drizzleDir() });
      const workerRows = db
        .prepare(
          `SELECT id, team_id, role, focused
           FROM orca_workers
           ORDER BY created_at`,
        )
        .all();
      const expectedSeqs = listMigrations(drizzleDir())
        .filter((migration) => migration.seq > 39)
        .map((migration) => migration.seq);

      expect(result.applied.map((migration) => migration.seq)).toEqual(expectedSeqs);
      expect(tableExists(db, 'orca_workflows')).toBe(false);
      expect(tableExists(db, 'orca_teams')).toBe(true);
      expect(columnNames(db, 'orca_workers')).toEqual(
        expect.arrayContaining(['team_id', 'role', 'focused', 'idle_since']),
      );
      expect(columnNames(db, 'orca_workers')).not.toContain('workflow_id');
      expect(workerRows).toEqual([
        { id: 'worker-1', team_id: 'team-1', role: 'developer', focused: 1 },
        { id: 'worker-2', team_id: 'team-1', role: 'developer', focused: 0 },
      ]);
      expect(indexExists(db, 'uniq_active_team_per_lead')).toBe(true);
      expect(indexExists(db, 'uniq_orca_workers_focused_per_team')).toBe(true);
      expect(indexExists(db, 'idx_orca_workers_workflow_id')).toBe(false);
      expect(columnNames(db, 'schedules')).toContain('fast_mode');
    } finally {
      cleanup();
    }
  });

  it('converts legacy permission_mode=plan sessions into plan_mode_enabled via 0060', () => {
    const { db, cleanup } = createTempDb();
    // 复刻 0060 之前的库:拷贝 drizzle 目录并剔除 0060,重放到 0059 后再 seed。
    const stagedDir = mkdtempSync(path.join(tmpdir(), 'xdmaker-drizzle-pre0060-'));
    try {
      for (const migration of listMigrations(drizzleDir())) {
        if (migration.seq >= 60) continue;
        copyFileSync(migration.sqlPath, path.join(stagedDir, migration.fileName));
        if (migration.tsScriptPath) {
          mkdirSync(path.join(stagedDir, 'scripts'), { recursive: true });
          copyFileSync(
            migration.tsScriptPath,
            path.join(stagedDir, 'scripts', path.basename(migration.tsScriptPath)),
          );
        }
      }
      runMigrationReplay(db, { drizzleDir: stagedDir });
      const now = Date.now();
      db.prepare(
        `INSERT INTO sessions (id, permission_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).run('legacy-plan-session', 'plan', now, now);
      db.prepare(
        `INSERT INTO sessions (id, permission_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).run('plain-session', 'acceptEdits', now, now);

      const result = runMigrationReplay(db, { drizzleDir: drizzleDir() });

      expect(result.applied.map((migration) => migration.seq)).toContain(60);
      expect(columnNames(db, 'sessions')).toContain('plan_mode_enabled');
      const rows = db
        .prepare(
          `SELECT id, permission_mode, plan_mode_enabled FROM sessions ORDER BY id`,
        )
        .all();
      expect(rows).toEqual([
        { id: 'legacy-plan-session', permission_mode: 'ask', plan_mode_enabled: 1 },
        { id: 'plain-session', permission_mode: 'acceptEdits', plan_mode_enabled: 0 },
      ]);

      const replayResult = runMigrationReplay(db, {
        drizzleDir: drizzleDir(),
        currentVersion: 59,
      });
      // 59 之后的迁移全部重放(0060 及以后陆续新增的都在内),不写死具体序号
      const expectedReplaySeqs = listMigrations(drizzleDir())
        .filter((migration) => migration.seq > 59)
        .map((migration) => migration.seq);
      expect(replayResult.applied.map((migration) => migration.seq)).toEqual(expectedReplaySeqs);
      const replayRows = db
        .prepare(
          `SELECT id, permission_mode, plan_mode_enabled FROM sessions ORDER BY id`,
        )
        .all();
      expect(replayRows).toEqual(rows);
    } finally {
      rmSync(stagedDir, { recursive: true, force: true });
      cleanup();
    }
  });

  it('keeps migration committed when the history side-write fails', () => {
    const { db, cleanup: cleanupDb } = createTempDb();
    const { dir, cleanup: cleanupDrizzle } = createTempDrizzleDir();
    try {
      db.exec(`
        CREATE TABLE migration_meta (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        CREATE TABLE migration_history (
          seq INTEGER PRIMARY KEY NOT NULL
        );
      `);

      const historyFailures: Array<{ seq: number; fileName: string; error: unknown }> = [];
      const result = runMigrationReplay(db, {
        drizzleDir: dir,
        onMigrationHistoryWriteFailed: (failure) => {
          historyFailures.push(failure);
        },
      });
      const schemaVersion = db
        .prepare("SELECT value FROM migration_meta WHERE key='schema_version'")
        .pluck()
        .get();

      expect(result.applied.map((migration) => migration.seq)).toEqual([0]);
      expect(tableExists(db, 'migrated_marker')).toBe(true);
      expect(schemaVersion).toBe('0');
      expect(historyFailures).toHaveLength(1);
      expect(historyFailures[0]).toMatchObject({
        seq: 0,
        fileName: '0000_create_marker.sql',
      });
      expect(historyFailures[0]?.error).toBeInstanceOf(Error);
    } finally {
      cleanupDb();
      cleanupDrizzle();
    }
  });
});
