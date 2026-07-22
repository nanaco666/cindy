import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const migration0079 =
  require('../../../../drizzle/scripts/0079_futuristic_hercules.ts') as {
    run(db: Database.Database): void;
  };

describe('0079 legacy scheduler session fallback boundary', () => {
  it('marks existing schedules compatible while new schedules keep the isolated default', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE schedules (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL
        );
        INSERT INTO schedules (id, name) VALUES ('existing', 'Weekly summary');
      `);

      migration0079.run(db);
      expect(
        db
          .prepare('SELECT legacy_session_fallback FROM schedules WHERE id = ?')
          .pluck()
          .get('existing'),
      ).toBe(1);

      db.prepare('INSERT INTO schedules (id, name) VALUES (?, ?)').run('new', 'Weekly summary');
      // Companion scripts may be invoked directly while diagnosing migration state; reruns must
      // not grant legacy compatibility to schedules created after the original migration.
      migration0079.run(db);
      expect(
        db
          .prepare('SELECT legacy_session_fallback FROM schedules WHERE id = ?')
          .pluck()
          .get('new'),
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it('is a no-op for partial legacy replay databases without schedules', () => {
    const db = new Database(':memory:');
    try {
      expect(() => migration0079.run(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
