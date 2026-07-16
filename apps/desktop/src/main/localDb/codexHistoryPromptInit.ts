import type Database from 'better-sqlite3';

import { createLogger } from '../logger';

const log = createLogger('localDb/codex-history-prompt-init');
const INIT_META_KEY = 'codex_history_has_product_prompt_initialized_v1';

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  return rows.some((row) => row.name === column);
}

/**
 * One-time data init after the nullable column is added:
 * legacy rows predate codex-proxy, so their Codex thread history already has
 * the product developer prompt. New NULLs after this guard are intentionally
 * left unknown so resume can fail toward restore.
 */
export function initializeCodexHistoryPromptState(db: Database.Database): void {
  if (!hasColumn(db, 'sessions', 'codex_history_has_product_prompt')) {
    log.warn('codex history prompt state init skipped: column missing');
    return;
  }

  const row = db
    .prepare(`SELECT value FROM migration_meta WHERE key=?`)
    .get(INIT_META_KEY) as { value: string | null } | undefined;
  if (row?.value === 'done') return;

  const updated = db.transaction(() => {
    const result = db
      .prepare(`
        UPDATE sessions
        SET codex_history_has_product_prompt = 1
        WHERE codex_history_has_product_prompt IS NULL
      `)
      .run();
    db
      .prepare(
        `INSERT INTO migration_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(INIT_META_KEY, 'done');
    return result.changes;
  })();

  log.info('codex history prompt state initialized', { updated });
}
