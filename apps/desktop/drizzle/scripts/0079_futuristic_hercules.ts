import type Database from 'better-sqlite3';

interface TableInfoRow {
  name: string;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName) !== undefined
  );
}

function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  return (db.prepare(`PRAGMA table_info('${tableName}')`).all() as TableInfoRow[]).some(
    (row) => row.name === columnName,
  );
}

/**
 * 存量 schedule 可能依赖按名称/目录匹配旧会话的兼容路径，因此升级时标记为 true；
 * 新 schedule 走列默认 false，以 scheduleId 作为唯一身份，删除后同名重建不会继承旧数据。
 */
function run(db: Database.Database): void {
  if (!tableExists(db, 'schedules')) return;
  db.transaction(() => {
    if (columnExists(db, 'schedules', 'legacy_session_fallback')) return;
    db.exec(
      'ALTER TABLE schedules ADD COLUMN legacy_session_fallback integer DEFAULT 0 NOT NULL',
    );
    db.exec('UPDATE schedules SET legacy_session_fallback = 1');
  })();
}

module.exports = { run };
