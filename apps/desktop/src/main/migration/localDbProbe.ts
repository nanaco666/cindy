/** Cindy 首启对当前/历史品牌主数据库文件的发现规则。 */

import fs from 'node:fs';
import path from 'node:path';

/** 本次 XDMaker → Cindy 迁移源数据库的稳定文件名前缀。 */
export const XDT_MAKER_LEGACY_DB_FILE_PREFIX = 'xdt-maker';

/**
 * 列出需要 quick_check 的主库。同时匹配当前构建前缀和迁移源前缀，避免
 * Cindy 改品牌配置后漏掉原样复制过来的 `xdt-maker-*.db`。
 */
export function listMigrationMainDbFiles(
  userDataDir: string,
  currentDbFilePrefix: string,
): string[] {
  const prefixes = new Set([currentDbFilePrefix, XDT_MAKER_LEGACY_DB_FILE_PREFIX]);
  return fs.readdirSync(userDataDir).filter((file) => (
    file.endsWith('.db')
    && [...prefixes].some((prefix) => file.startsWith(`${prefix}-`))
  ));
}

/** SQLite 探针所需的最小连接契约，便于注入真实 better-sqlite3 或测试替身。 */
export interface MigrationDbProbeHandle {
  pragma: (source: string) => unknown;
  close: () => void;
}

/**
 * 在新 userData 副本上恢复并诊断主库。复制可能保留尚未 checkpoint 的 WAL，
 * 因此必须以可写方式打开副本，先把 WAL 截断合并进主库，再执行 quick_check。
 * 每个库的 open / checkpoint / quick_check / close 异常都只返回 warning：非活跃账号的
 * 历史损坏不应阻断整台机器迁移，真正登录/认领时由 ensureReady 的恢复路径处理。
 */
export function probeMigrationLocalDbs(
  userDataDir: string,
  currentDbFilePrefix: string,
  openDatabase: (filePath: string) => MigrationDbProbeHandle,
): string[] {
  const dbFiles = listMigrationMainDbFiles(userDataDir, currentDbFilePrefix);
  const warnings: string[] = [];
  for (const file of dbFiles) {
    let db: MigrationDbProbeHandle | null = null;
    try {
      db = openDatabase(path.join(userDataDir, file));
      const checkpointRows = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy?: number }>;
      if ((checkpointRows[0]?.busy ?? 0) !== 0) {
        throw new Error(`wal_checkpoint(${file}) remained busy`);
      }
      const rows = db.pragma('quick_check') as Array<{ quick_check: string }>;
      const verdict = rows[0]?.quick_check ?? 'unknown';
      if (verdict !== 'ok') warnings.push(`quick_check(${file}) = ${verdict}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`probe(${file}) failed: ${message}`);
    } finally {
      try {
        db?.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`close(${file}) failed: ${message}`);
      }
    }
  }
  return warnings;
}
