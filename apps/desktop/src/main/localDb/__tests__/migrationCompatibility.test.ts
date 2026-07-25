import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  checkMigrationCompatibility,
  hashMigrationFile,
  prepareMigrationRuntimeManifest,
} from '../migrationRunner';

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createDrizzleDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cindy-passive-migrations-'));
  cleanupDirs.push(dir);
  writeFileSync(path.join(dir, '0000_init.sql'), 'CREATE TABLE first (id TEXT);\n', 'utf8');
  writeFileSync(path.join(dir, '0001_second.sql'), 'CREATE TABLE second (id TEXT);\n', 'utf8');
  return dir;
}

function createDb(schemaVersion: number, withHistory = true): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE migration_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
    INSERT INTO migration_meta (key, value) VALUES ('schema_version', '${schemaVersion}');
  `);
  if (withHistory) {
    db.exec(`
      CREATE TABLE migration_history (
        seq INTEGER PRIMARY KEY NOT NULL,
        file_name TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
  }
  return db;
}

function seedExactHistory(db: Database.Database, drizzleDir: string): void {
  const insert = db.prepare(
    `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
     VALUES (?, ?, ?, ?)`,
  );
  for (const fileName of ['0000_init.sql', '0001_second.sql']) {
    insert.run(
      Number(fileName.slice(0, 4)),
      fileName,
      hashMigrationFile(path.join(drizzleDir, fileName)),
      123,
    );
  }
}

describe('checkMigrationCompatibility', () => {
  it('accepts an exact schema version and migration history match', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(1);
    try {
      seedExactHistory(db, drizzleDir);

      expect(checkMigrationCompatibility(db, drizzleDir)).toEqual({
        compatible: true,
        databaseVersion: 1,
        checkoutVersion: 1,
        issues: [],
      });
    } finally {
      db.close();
    }
  });

  it('rejects a database with pending checkout migrations', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(0);
    try {
      const first = '0000_init.sql';
      db.prepare(
        `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
         VALUES (?, ?, ?, ?)`,
      ).run(0, first, hashMigrationFile(path.join(drizzleDir, first)), 123);

      const report = checkMigrationCompatibility(db, drizzleDir);
      expect(report.compatible).toBe(false);
      expect(report.issues.map((issue) => issue.kind)).toEqual([
        'schema-version-behind',
        'history-entry-missing',
      ]);
    } finally {
      db.close();
    }
  });

  it('rejects a database newer than the checkout', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(2);
    try {
      seedExactHistory(db, drizzleDir);

      const report = checkMigrationCompatibility(db, drizzleDir);
      expect(report.compatible).toBe(false);
      expect(report.issues).toEqual([
        { kind: 'schema-version-ahead', databaseVersion: 2, checkoutVersion: 1 },
      ]);
    } finally {
      db.close();
    }
  });

  it('rejects drifted, missing, or unexpected migration history entries', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(1);
    try {
      db.prepare(
        `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
         VALUES (?, ?, ?, ?)`,
      ).run(0, '0000_renamed.sql', 'wrong-hash', 123);
      db.prepare(
        `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
         VALUES (?, ?, ?, ?)`,
      ).run(99, '0099_future.sql', 'future-hash', 123);

      const report = checkMigrationCompatibility(db, drizzleDir);
      expect(report.compatible).toBe(false);
      expect(report.issues.map((issue) => issue.kind)).toEqual([
        'history-entry-mismatch',
        'history-entry-missing',
        'history-entry-unexpected',
      ]);
    } finally {
      db.close();
    }
  });

  it('fails closed when migration_history is unavailable', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(1, false);
    try {
      const report = checkMigrationCompatibility(db, drizzleDir);
      expect(report.compatible).toBe(false);
      expect(report.issues[0]?.kind).toBe('history-unavailable');
    } finally {
      db.close();
    }
  });

  it.each(['abc', '1junk', '9007199254740992', '-1', '01'])(
    'fails closed for an invalid schema_version value: %s',
    (value) => {
      const drizzleDir = createDrizzleDir();
      const db = createDb(1);
      try {
        seedExactHistory(db, drizzleDir);
        db.prepare(`UPDATE migration_meta SET value=? WHERE key='schema_version'`).run(value);

        const report = checkMigrationCompatibility(db, drizzleDir);
        expect(report.compatible).toBe(false);
        expect(report.databaseVersion).toBe(-1);
        expect(report.issues.map((issue) => issue.kind)).toContain('history-unavailable');
      } finally {
        db.close();
      }
    },
  );

  it('includes companion TS scripts in the persisted runtime identity', () => {
    const drizzleDir = createDrizzleDir();
    const scriptsDir = path.join(drizzleDir, 'scripts');
    mkdirSync(scriptsDir);
    const scriptPath = path.join(scriptsDir, '0001_second.ts');
    writeFileSync(scriptPath, 'export function run() { return "first"; }\n', 'utf8');
    const dbFilePath = path.join(drizzleDir, 'shared.db');
    const db = createDb(1);
    try {
      seedExactHistory(db, drizzleDir);
      prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 1);
      expect(checkMigrationCompatibility(db, drizzleDir, dbFilePath).compatible).toBe(true);

      writeFileSync(scriptPath, 'export function run() { return "changed"; }\n', 'utf8');
      const report = checkMigrationCompatibility(db, drizzleDir, dbFilePath);
      expect(report.compatible).toBe(false);
      expect(report.issues.map((issue) => issue.kind)).toContain('runtime-manifest-mismatch');
    } finally {
      db.close();
    }
  });

  it('never overwrites the identity of an already applied companion TS migration', () => {
    const drizzleDir = createDrizzleDir();
    const scriptsDir = path.join(drizzleDir, 'scripts');
    mkdirSync(scriptsDir);
    const scriptPath = path.join(scriptsDir, '0001_second.ts');
    writeFileSync(scriptPath, 'export function run() { return "applied-a"; }\n', 'utf8');
    const dbFilePath = path.join(drizzleDir, 'shared.db');

    prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 1);
    writeFileSync(scriptPath, 'export function run() { return "checkout-b"; }\n', 'utf8');

    expect(() => prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 1)).toThrow(
      /applied migration runtime identity changed at seq 1/,
    );
  });

  it('fails closed when the runtime identity has not been published by a primary', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(1);
    try {
      seedExactHistory(db, drizzleDir);
      const report = checkMigrationCompatibility(
        db,
        drizzleDir,
        path.join(drizzleDir, 'missing.db'),
      );
      expect(report.compatible).toBe(false);
      expect(report.issues.map((issue) => issue.kind)).toContain('runtime-manifest-unavailable');
    } finally {
      db.close();
    }
  });
});
