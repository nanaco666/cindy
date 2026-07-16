/**
 * Schema-drift repair (#37) —— 反射 schema.ts vs 物理 PRAGMA,幂等补缺。
 *
 * 适用场景:dev 端在 schemaDriftDetector 报 drift 后调用,自动把缺的列/表/索引补齐。
 *
 * 原则(跟之前 reverted 那版相同,但触发条件严格了):
 *   - 只加不删:对照 schema.ts 声明,补缺列/缺表/缺索引;**绝不**删除多余列。
 *   - 单项 try/catch:某条修复失败不阻断其余修复。
 *   - 顶层 try/catch:整个 repair 崩了也不阻塞启动,只 log.error。
 *   - 修不掉的(改类型、删列、改 NOT NULL 约束、复合 FK)只能丢到 residual 让调用方决策。
 *
 * 返回 `{ repaired, residual }`:
 *   - `repaired`: 实际跑成功的 DDL 列表(给日志看)
 *   - `residual`: 跑完后仍存在的 schema mismatch 列表(留给 ensureReady 决定是否弹 nuke 对话框)
 *
 * 注意:本模块用 drizzle 的内部 column 属性(`.notNull` / `.hasDefault` / `.default`),
 * drizzle 升级时可能需要重新校准。所有 cast 集中在 `asColumnMeta` 一个 helper 里,
 * 升级时只改这一处。
 */

import type Database from 'better-sqlite3';
import { getTableColumns, getTableName, isTable } from 'drizzle-orm';
import type { Column, SQL } from 'drizzle-orm';
import { getTableConfig, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import type { SQLiteTableWithColumns, TableConfig } from 'drizzle-orm/sqlite-core';

import * as schema from './schema';
import { createLogger } from '../logger';

const log = createLogger('schema-drift-repair');

/** drizzle SQL → 文本序列化器,用于把 partial index 的 WHERE 子句还原成 DDL。无状态,单例复用。 */
const sqliteDialect = new SQLiteSyncDialect();

type ManagedSchemaTable = SQLiteTableWithColumns<TableConfig>;

interface ColumnMeta {
  name: string;
  notNull: boolean;
  hasDefault: boolean;
  default: unknown;
  primary: boolean;
  getSQLType(): string;
}

function asColumnMeta(col: Column): ColumnMeta {
  return col as unknown as ColumnMeta;
}

/**
 * 受管理的表清单从 schema.ts 的 drizzle table export 自动派生。
 * 新增 sqliteTable export 会自动进入 drift repair，避免手写清单随多人改动漂移。
 *
 * 不在 schema.ts export 里的虚拟表:`messages_fts`(FTS5)与 `chat_messages_vec_v1`
 * (vec0)不能用反射建表，由对应 migration 自己负责，drift 修复路径不管。
 */
const SCHEMA_TABLES: ManagedSchemaTable[] = (Object.values(schema) as unknown[])
  .filter((value): value is ManagedSchemaTable => isTable(value))
  .sort((a, b) => getTableName(a).localeCompare(getTableName(b)));

export function getManagedSchemaTableNames(): string[] {
  return SCHEMA_TABLES.map((table) => getTableName(table));
}

export interface ResidualMismatch {
  table: string;
  kind:
    | 'missing-index'
    | 'missing-not-null-column'
    | 'missing-partial-index'
    | 'missing-table-fatal'
    | 'unknown';
  detail: string;
}

export interface RepairReport {
  repaired: string[];
  residual: ResidualMismatch[];
}

// ── helpers ────────────────────────────────────────────────────────────────

function tableExists(db: Database.Database, name: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
}

function existingColumnNames(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as {
    name: string;
  }[];
  return new Set(rows.map((r) => r.name));
}

function existingIndexNames(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA index_list('${table}')`).all() as {
    name: string;
  }[];
  return new Set(rows.map((r) => r.name));
}

/**
 * JS default value → SQL literal(用于 ALTER TABLE ADD COLUMN ... DEFAULT xxx)。
 * 返回 null = 无法转换(调用方跳过 DEFAULT 子句)。
 */
function defaultToSQL(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return null;
}

// ── column repair ──────────────────────────────────────────────────────────

function repairColumns(
  db: Database.Database,
  tableName: string,
  drizzleTable: ManagedSchemaTable,
  residual: ResidualMismatch[],
): string[] {
  const existing = existingColumnNames(db, tableName);
  const expected = getTableColumns(drizzleTable);
  const repairs: string[] = [];

  for (const rawCol of Object.values(expected)) {
    const col = asColumnMeta(rawCol as Column);
    if (existing.has(col.name)) continue;

    const sqlType = col.getSQLType();
    const def = col.hasDefault ? defaultToSQL(col.default) : null;

    // SQLite 限制:ALTER TABLE ADD COLUMN ... NOT NULL 必须带 DEFAULT。
    // 这类列只能在 CREATE TABLE 时一次到位 —— 表已存在却缺这列,属于无法用反射修复的情况,
    // 丢到 residual 让 ensureReady 决定弹 nuke 对话框。
    if (col.notNull && def === null) {
      residual.push({
        table: tableName,
        kind: 'missing-not-null-column',
        detail: `${tableName}.${col.name} (${sqlType}, NOT NULL, no default)`,
      });
      log.warn(
        JSON.stringify({
          event: 'schema-drift-repair.skip-not-null-no-default',
          table: tableName,
          column: col.name,
        }),
      );
      continue;
    }

    let ddl = `ALTER TABLE \`${tableName}\` ADD COLUMN \`${col.name}\` ${sqlType}`;
    if (def !== null) ddl += ` DEFAULT ${def}`;
    if (col.notNull) ddl += ' NOT NULL';

    try {
      db.exec(ddl);
      repairs.push(ddl);
    } catch (err) {
      log.error(
        JSON.stringify({
          event: 'schema-drift-repair.column-add-failed',
          table: tableName,
          column: col.name,
          ddl,
          error: String(err),
        }),
      );
      residual.push({
        table: tableName,
        kind: 'unknown',
        detail: `add column ${col.name} failed: ${String(err)}`,
      });
    }
  }

  return repairs;
}

// ── index repair ───────────────────────────────────────────────────────────

function repairIndexes(
  db: Database.Database,
  tableName: string,
  drizzleTable: ManagedSchemaTable,
  residual: ResidualMismatch[],
): string[] {
  const existing = existingIndexNames(db, tableName);
  const { indexes } = getTableConfig(drizzleTable);
  const repairs: string[] = [];

  for (const idx of indexes) {
    const idxName: string = idx.config.name;
    if (existing.has(idxName)) continue;

    const cols = (idx.config.columns as { name: string }[])
      .map((c) => `\`${c.name}\``)
      .join(', ');
    const unique = idx.config.unique ? 'UNIQUE ' : '';

    // partial index 必须带回 WHERE 子句,否则会被错建成全表索引。
    // 反例(F-COLLAB):uniq_orca_workflows_active_lead_session_id 丢了
    // `WHERE status='active'` 就退化成全表 unique,等价于已废弃的
    // uniq_orca_workflows_lead_session_id,会让同一 lead 的协同 toggle 复开失败。
    const where = idx.config.where as SQL | undefined;
    let whereClause = '';
    if (where) {
      const q = sqliteDialect.sqlToQuery(where);
      // db.exec 不能绑定参数;带参 WHERE 无法内联成 DDL。与其建出错误的全表索引,
      // 不如跳过,留给正式 migration 处理(当前 schema 内的 partial index 均无参)。
      if (q.params.length > 0) {
        log.warn(
          JSON.stringify({
            event: 'schema-drift-repair.skip-parametrized-partial-index',
            table: tableName,
            index: idxName,
          }),
        );
        residual.push({
          table: tableName,
          kind: 'missing-partial-index',
          detail: `${idxName} skipped because WHERE contains bound parameters`,
        });
        continue;
      }
      whereClause = ` WHERE ${q.sql}`;
    }
    const ddl = `CREATE ${unique}INDEX IF NOT EXISTS \`${idxName}\` ON \`${tableName}\` (${cols})${whereClause}`;

    try {
      db.exec(ddl);
      repairs.push(ddl);
    } catch (err) {
      log.error(
        JSON.stringify({
          event: 'schema-drift-repair.index-create-failed',
          table: tableName,
          index: idxName,
          ddl,
          error: String(err),
        }),
      );
      residual.push({
        table: tableName,
        kind: where ? 'missing-partial-index' : 'missing-index',
        detail: `${idxName} create failed: ${String(err)}`,
      });
    }
  }

  return repairs;
}

// ── missing table repair ───────────────────────────────────────────────────

/**
 * 整表缺失 → CREATE TABLE IF NOT EXISTS。
 *
 * 处理细节:
 * - 单列 PK 用 `\`col\` ... PRIMARY KEY` 内联
 * - 复合 PK(如 im_bindings 的 (channel, bot_context_id, user_id))在末尾追加
 *   `PRIMARY KEY (col1, col2, col3)` 子句
 * - 不补 FK —— 表都丢了大概率有更深的问题,FK 留给后续 schemaDriftRepair 再跑
 *   (但目前没实现 FK 反射;调用方应该已经走 nuke 路径)
 */
function repairMissingTable(
  db: Database.Database,
  tableName: string,
  drizzleTable: ManagedSchemaTable,
  residual: ResidualMismatch[],
): string | null {
  const expected = getTableColumns(drizzleTable);
  const config = getTableConfig(drizzleTable);
  const compositePks = config.primaryKeys;

  const hasCompositePk = compositePks.length > 0;
  const colDefs: string[] = [];

  for (const rawCol of Object.values(expected)) {
    const col = asColumnMeta(rawCol as Column);
    const sqlType = col.getSQLType();
    let def = `\`${col.name}\` ${sqlType}`;
    // 复合 PK 时不要在列上写 PRIMARY KEY,会跟末尾的 PRIMARY KEY (...) 子句冲突
    if (col.primary && !hasCompositePk) def += ' PRIMARY KEY';
    if (col.notNull && !(col.primary && !hasCompositePk)) def += ' NOT NULL';
    if (col.hasDefault) {
      const sqlDefault = defaultToSQL(col.default);
      if (sqlDefault !== null) def += ` DEFAULT ${sqlDefault}`;
    }
    colDefs.push(def);
  }

  if (hasCompositePk) {
    const pkCols = compositePks
      .flatMap((pk) => pk.columns.map((c) => `\`${(c as unknown as { name: string }).name}\``))
      .join(', ');
    colDefs.push(`PRIMARY KEY (${pkCols})`);
  }

  const ddl = `CREATE TABLE IF NOT EXISTS \`${tableName}\` (\n  ${colDefs.join(',\n  ')}\n)`;

  try {
    db.exec(ddl);
    return ddl;
  } catch (err) {
    log.error(
      JSON.stringify({
        event: 'schema-drift-repair.table-create-failed',
        table: tableName,
        ddl,
        error: String(err),
      }),
    );
    residual.push({
      table: tableName,
      kind: 'missing-table-fatal',
      detail: `create table failed: ${String(err)}`,
    });
    return null;
  }
}

// ── entry point ────────────────────────────────────────────────────────────

export function repairSchemaDrift(db: Database.Database): RepairReport {
  const repaired: string[] = [];
  const residual: ResidualMismatch[] = [];

  // 防御:db 为空或连接已关闭时直接返回空报告(绝不产出 residual)。
  // residual 被上层 handleSchemaDrift 用来决定是否弹 nuke 对话框,而"连接没开 / 句柄为 null"
  // 属于基础设施错误,不是 schema 结构不一致 —— 决不能让它升级成"删库重建"提示。
  // (2026-06-22 事故根因之一:并发 ensureReady 在 await backupDb 期间把 _db 置空,
  //  旧路径仍把 null 传进来,每张表 db.prepare 抛错被误判成 21 个 residual → 触发 nuke。)
  const handle = db as Database.Database | null | undefined;
  if (!handle || !handle.open) {
    log.error(
      JSON.stringify({
        event: 'schema-drift-repair.skip-no-open-db',
        hasDb: !!handle,
        open: handle ? handle.open : false,
      }),
    );
    return { repaired, residual };
  }

  try {
    for (const drizzleTable of SCHEMA_TABLES) {
      const tableName = getTableName(drizzleTable);
      try {
        if (!tableExists(db, tableName)) {
          const ddl = repairMissingTable(db, tableName, drizzleTable, residual);
          if (ddl) repaired.push(ddl);
          if (!tableExists(db, tableName)) continue; // 建表都失败 → 跳过后续补列
        }
        repaired.push(...repairColumns(db, tableName, drizzleTable, residual));
        repaired.push(...repairIndexes(db, tableName, drizzleTable, residual));
      } catch (err) {
        log.error(
          JSON.stringify({
            event: 'schema-drift-repair.per-table-failed',
            table: tableName,
            error: String(err),
          }),
        );
        residual.push({
          table: tableName,
          kind: 'unknown',
          detail: `per-table repair threw: ${String(err)}`,
        });
      }
    }

    if (repaired.length > 0) {
      log.warn(
        JSON.stringify({
          event: 'schema-drift-repair.applied',
          repairedCount: repaired.length,
          residualCount: residual.length,
          repaired,
        }),
      );
    } else {
      log.info(
        JSON.stringify({
          event: 'schema-drift-repair.no-op',
          residualCount: residual.length,
        }),
      );
    }
  } catch (err) {
    // 顶层兜底:repair 自己崩了也不能阻塞启动
    log.error(
      JSON.stringify({
        event: 'schema-drift-repair.fatal',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return { repaired, residual };
}
