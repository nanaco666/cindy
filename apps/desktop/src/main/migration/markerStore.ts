/**
 * migration/markerStore — marker 文件的原子读写与受控转移。
 *
 * 设计要点(§3.1/§3.3):
 *  - 写入一律原子:同目录临时文件 + rename(marker 与 receipt 同卷,rename
 *    在 Win/mac 上均为原子替换;Windows 下 rename 覆盖已存在目标用 fs.renameSync
 *    语义即可,Node 内部走 MoveFileEx(REPLACE_EXISTING))。
 *  - 读损坏容忍:JSON 解析失败 / 形状不对按"marker 不存在"处理(流程幂等,
 *    从头再来是安全的)。
 *  - 状态转移必须经 transitionMarker(内部走 isLegalTransition)。
 *
 * 零 Electron 依赖(纯 node:fs),路径由调用方传入,vitest 直测。
 */

import fs from 'node:fs';
import path from 'node:path';
import { isLegalTransition } from './transitions';
import type {
  MigrationMarker,
  MigrationReceipt,
  MigrationState,
  MigrationWriter,
} from './types';

/** 原子写 JSON:同目录 tmp + rename;目录不存在时自动创建。mode 供交接文件收紧到 0600。 */
export function writeJsonAtomic(filePath: string, value: unknown, opts?: { mode?: number }): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: opts?.mode });
  try {
    fs.renameSync(tmp, filePath);
    // POSIX rename 保留 tmp 的 mode;目标已存在被替换时再 chmod 一次兜底
    // (Windows 上 chmod 基本 no-op,无害)。
    if (opts?.mode != null) fs.chmodSync(filePath, opts.mode);
  } catch (err) {
    // rename 失败(如 AV 瞬时句柄)不留垃圾 tmp。
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/** 读 marker;不存在 / 损坏 / 形状非法一律返回 null(按无 marker 处理)。 */
export function readMarker(filePath: string): MigrationMarker | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isMigrationMarker(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const MIGRATION_STATES = new Set<MigrationState>([
  'staged', 'handoff_ready', 'installed', 'launched',
  'confirmed', 'failed', 'fallback_active',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasStringFields(value: unknown, fields: readonly string[]): value is Record<string, string> {
  return isRecord(value) && fields.every((field) => typeof value[field] === 'string');
}

/** schema v1 完整运行时校验；任一消费方会读取的嵌套字段缺失都按无 marker 处理。 */
function isMigrationMarker(value: unknown): value is MigrationMarker {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== 1) return false;
  if (typeof value.migrationId !== 'string' || value.migrationId.length === 0) return false;
  if (typeof value.state !== 'string' || !MIGRATION_STATES.has(value.state as MigrationState)) return false;
  if (typeof value.attempt !== 'number' || !Number.isFinite(value.attempt)) return false;
  if (typeof value.maxAttempts !== 'number' || !Number.isFinite(value.maxAttempts)) return false;
  if (typeof value.updatedAt !== 'string') return false;
  if (value.updatedBy !== 'old-app' && value.updatedBy !== 'new-app') return false;
  if (!hasStringFields(value.source, [
    'app', 'version', 'installDir', 'userDataDir', 'uninstallDisplayNamePrefix',
  ])) return false;
  if (!hasStringFields(value.target, [
    'app', 'version', 'payloadPath', 'payloadSha256', 'installDir', 'userDataDir', 'exeName',
  ])) return false;
  if (value.handoff !== null && !hasStringFields(value.handoff, ['path', 'createdAt', 'sha256'])) {
    return false;
  }
  if (value.lastError !== null && !hasStringFields(value.lastError, ['code', 'message', 'at'])) {
    return false;
  }
  return true;
}

/** 读 receipt(新侧);容错语义同 readMarker。 */
export function readReceipt(filePath: string): MigrationReceipt | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as MigrationReceipt;
    if (parsed?.schemaVersion !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeReceipt(filePath: string, receipt: MigrationReceipt): void {
  writeJsonAtomic(filePath, receipt);
}

export interface TransitionResult {
  ok: boolean;
  reason?: string;
  marker?: MigrationMarker;
}

/**
 * 受控状态转移:读当前 marker → 矩阵校验 → 应用变更 → 原子写回。
 *
 * 非法转移返回 { ok:false, reason } 且不落盘——调用方记日志后放弃即可,
 * 不要重试(非法说明有并发方已推进,以盘上事实为准)。
 *
 * @param mutate 在状态切换之外需要一并更新的字段(attempt、lastError、
 *   handoff、target 等);updatedAt/updatedBy/state 由本函数统一写。
 */
export function transitionMarker(
  filePath: string,
  args: {
    to: MigrationState;
    by: MigrationWriter;
    nowIso?: string;
    sentinelOverride?: boolean;
    mutate?: (current: MigrationMarker | null) => Partial<MigrationMarker>;
    /** 首次创建(from=null)时的完整初始档案,由调用方提供。 */
    create?: () => MigrationMarker;
  },
): TransitionResult {
  const current = readMarker(filePath);
  const check = isLegalTransition(current?.state ?? null, args.to, args.by, {
    sentinelOverride: args.sentinelOverride,
  });
  if (!check.ok) return { ok: false, reason: check.reason };

  const nowIso = args.nowIso ?? new Date().toISOString();
  let next: MigrationMarker;
  if (current == null) {
    if (!args.create) {
      return { ok: false, reason: 'marker absent and no create() factory supplied' };
    }
    next = { ...args.create(), state: args.to, updatedAt: nowIso, updatedBy: args.by };
  } else {
    next = {
      ...current,
      ...(args.mutate?.(current) ?? {}),
      state: args.to,
      updatedAt: nowIso,
      updatedBy: args.by,
    };
  }
  writeJsonAtomic(filePath, next);
  return { ok: true, marker: next };
}
