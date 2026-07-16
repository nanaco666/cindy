import { describe, expect, it } from 'vitest';

import { initializeCodexHistoryPromptState } from '../localDb/codexHistoryPromptInit';

function createFakeDb() {
  const meta = new Map<string, string | null>();
  const sessions = new Map<string, boolean | null>();
  return {
    meta,
    sessions,
    db: {
      prepare(sql: string) {
        if (sql.includes('PRAGMA table_info(sessions)')) {
          return {
            all() {
              return [{ name: 'id' }, { name: 'codex_history_has_product_prompt' }];
            },
          };
        }
        if (sql.includes('SELECT value FROM migration_meta')) {
          return {
            get(key: string) {
              return meta.has(key) ? { value: meta.get(key) ?? null } : undefined;
            },
          };
        }
        if (sql.includes('UPDATE sessions')) {
          return {
            run() {
              let changes = 0;
              for (const [id, value] of sessions) {
                if (value === null) {
                  sessions.set(id, true);
                  changes += 1;
                }
              }
              return { changes };
            },
          };
        }
        if (sql.includes('INSERT INTO migration_meta')) {
          return {
            run(key: string, value: string) {
              meta.set(key, value);
            },
          };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
      transaction<T>(fn: () => T) {
        return () => fn();
      },
    },
  };
}

describe('initializeCodexHistoryPromptState', () => {
  it('sets legacy NULL rows to true and records a one-time guard', () => {
    const fake = createFakeDb();
    fake.sessions.set('old', null);
    fake.sessions.set('proxy', false);

    initializeCodexHistoryPromptState(fake.db as never);

    expect(fake.sessions.get('old')).toBe(true);
    expect(fake.sessions.get('proxy')).toBe(false);
    expect(fake.meta.get('codex_history_has_product_prompt_initialized_v1')).toBe('done');
  });

  it('does not touch later NULL rows after the guard is set', () => {
    const fake = createFakeDb();
    initializeCodexHistoryPromptState(fake.db as never);
    fake.sessions.set('later', null);

    initializeCodexHistoryPromptState(fake.db as never);

    expect(fake.sessions.get('later')).toBeNull();
  });

  it('skips initialization when the codex history column is missing', () => {
    const fake = createFakeDb();
    fake.sessions.set('old', null);
    const db = {
      ...fake.db,
      prepare(sql: string) {
        if (sql.includes('PRAGMA table_info(sessions)')) {
          return { all: () => [{ name: 'id' }] };
        }
        return fake.db.prepare(sql);
      },
    };

    initializeCodexHistoryPromptState(db as never);

    expect(fake.sessions.get('old')).toBeNull();
    expect(fake.meta.get('codex_history_has_product_prompt_initialized_v1')).toBeUndefined();
  });
});
