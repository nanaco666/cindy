/**
 * Electron 无关的 SQLite migration runner。
 *
 * 生产入口负责解析 drizzle 目录与备份；这里只维护迁移回放语义，
 * 让 main 进程和测试共享同一套执行规则。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

export interface MigrationFile {
  /** 文件名前 4 位转数字。0000 → 0。 */
  seq: number;
  fileName: string;
  sqlPath: string;
  /** drizzle/scripts/{NNNN_xxx}.ts 若存在则在事务内执行。 */
  tsScriptPath?: string;
}

export interface MigrationReplayResult {
  currentVersion: number;
  finalVersion: number;
  applied: MigrationFile[];
}

export interface MigrationHistoryWriteFailure {
  seq: number;
  fileName: string;
  contentHash: string;
  error: unknown;
}

export interface RunMigrationReplayOptions {
  drizzleDir: string;
  currentVersion?: number;
  scriptLoader?: (scriptPath: string) => unknown;
  onMigrationStart?: (migration: MigrationFile) => void;
  onMigrationApplied?: (migration: MigrationFile, durationMs: number) => void;
  onMigrationHistoryWriteFailed?: (failure: MigrationHistoryWriteFailure) => void;
}

/**
 * 计算 migration sql 文件指纹。normalize 行尾消除 Windows CRLF 与 Unix LF 差异。
 */
export function hashMigrationFile(filePath: string): string {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const normalized = raw.replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export function listMigrations(drizzleDir: string): MigrationFile[] {
  const files = fs
    .readdirSync(drizzleDir)
    .filter((fileName) => /^\d{4}_.*\.sql$/.test(fileName))
    .sort();

  return files.map<MigrationFile>((fileName) => {
    const seq = parseInt(fileName.slice(0, 4), 10);
    const sqlPath = path.join(drizzleDir, fileName);
    const tsBaseName = fileName.replace(/\.sql$/, '.ts');
    const tsScriptPath = path.join(drizzleDir, 'scripts', tsBaseName);
    return {
      seq,
      fileName,
      sqlPath,
      tsScriptPath: fs.existsSync(tsScriptPath) ? tsScriptPath : undefined,
    };
  });
}

export function readSchemaVersion(db: Database.Database): number {
  try {
    const row = db.prepare(`SELECT value FROM migration_meta WHERE key='schema_version'`).get() as
      | { value: string }
      | undefined;
    return row ? parseInt(row.value, 10) : -1;
  } catch {
    return -1;
  }
}

export function listPendingMigrations(drizzleDir: string, currentVersion: number): MigrationFile[] {
  return listMigrations(drizzleDir).filter((migration) => migration.seq > currentVersion);
}

export function runMigrationReplay(
  db: Database.Database,
  options: RunMigrationReplayOptions,
): MigrationReplayResult {
  const currentVersion = options.currentVersion ?? readSchemaVersion(db);
  const pending = listPendingMigrations(options.drizzleDir, currentVersion);
  const scriptLoader = options.scriptLoader ?? loadScriptWithRequire;

  for (const migration of pending) {
    options.onMigrationStart?.(migration);
    const startedAt = Date.now();
    const sql = fs.readFileSync(migration.sqlPath, 'utf-8');
    const contentHash = hashMigrationFile(migration.sqlPath);
    const tx = db.transaction(() => {
      db.exec(sql);
      if (migration.tsScriptPath) {
        const script = scriptLoader(migration.tsScriptPath) as {
          run?: (db: Database.Database) => void;
        };
        if (typeof script?.run !== 'function') {
          throw new Error(`${migration.fileName} 同名 TS 脚本未导出 run()`);
        }
        script.run(db);
      }
      writeSchemaVersion(db, migration.seq);
      writeMigrationHistory(
        db,
        migration.seq,
        migration.fileName,
        contentHash,
        options.onMigrationHistoryWriteFailed,
      );
    });
    tx();
    options.onMigrationApplied?.(migration, Date.now() - startedAt);
  }

  return {
    currentVersion,
    finalVersion: pending.at(-1)?.seq ?? currentVersion,
    applied: pending,
  };
}

function loadScriptWithRequire(scriptPath: string): unknown {
  // require 而非 import：生产 Electron 以 CommonJS 加载 raw TS 配套脚本。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(scriptPath);
}

function writeSchemaVersion(db: Database.Database, seq: number): void {
  db.prepare(
    `INSERT INTO migration_meta (key, value)
     VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(String(seq));
}

function writeMigrationHistory(
  db: Database.Database,
  seq: number,
  fileName: string,
  contentHash: string,
  onFailure?: (failure: MigrationHistoryWriteFailure) => void,
): void {
  try {
    db.prepare(
      `INSERT OR REPLACE INTO migration_history (seq, file_name, content_hash, applied_at)
       VALUES (?, ?, ?, ?)`,
    ).run(seq, fileName, contentHash, Date.now());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/no such table/i.test(msg)) {
      onFailure?.({ seq, fileName, contentHash, error: err });
    }
  }
}
