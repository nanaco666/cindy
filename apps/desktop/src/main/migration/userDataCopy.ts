/**
 * migration/userDataCopy — Cindy 首启自拷:老 userData → 新 userData(B′ §4)。
 *
 * B′ 方案下 userData 拷贝由新 app(Cindy)首启单进程完成:老 app 在拉起
 * Cindy 前已退出,新目录在 sentinel 落盘前只有 Cindy 一个写入者——无跨进程
 * 协调。崩溃恢复模型是**整体重拷**(journal 标记 + 源目录冻结 = 幂等),
 * 不做断点续传。
 *
 * glob 语义(锚定于拷贝根,与 copyExcludes.ts 头注释一致):
 *  - `*` 单段内通配,`**` 任意深度(尾部 `**` 至少吞一段);
 *  - Windows 下大小写不敏感,分隔符统一按 `/` 匹配;
 *  - 不做任意深度模糊匹配(嵌套目录用完整相对路径写出)。
 *
 * 崩溃/失败语义:
 *  - journal(<new-userData>/migration/copy-journal.json)copying → done;
 *  - 首启看到 journal=copying(上次拷到一半崩了)→ 按 copiedPaths 清掉上轮
 *    目标文件后从头重拷，源侧已删除/轮换的文件不会残留;
 *  - journal=done → 默认跳过；Cindy 未确认的首启路径传 `trustCompletedJournal=false`,
 *    即使上次恰好在 done 后被强杀，也会清掉上轮 payload 后整体重拷最新老侧数据。
 *
 * 零 Electron 依赖,探测与磁盘余量全部可注入,vitest 直测。
 */

import fs from 'node:fs';
import path from 'node:path';
import { HANDOFF_REL_PATH } from './handoff';
import { writeJsonAtomic } from './markerStore';

export const COPY_JOURNAL_REL_PATH = path.join('migration', 'copy-journal.json');

/** 磁盘余量安全系数(目标卷可用空间 ≥ 待拷字节 × 此系数)。 */
export const COPY_MIN_FREE_BYTES_FACTOR = 1.2;

// ── 锚定 glob 匹配 ─────────────────────────────────────────────────────────

function segmentToRegex(seg: string): RegExp {
  const escaped = seg.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function matchSegments(pathSegs: readonly string[], patSegs: readonly string[]): boolean {
  if (patSegs.length === 0) return pathSegs.length === 0;
  if (patSegs[0] === '**') {
    // 尾部 `**` 至少吞一段(`updates` 不匹配 `updates/**`,`updates/a` 匹配)。
    if (patSegs.length === 1) return pathSegs.length > 0;
    for (let i = 0; i <= pathSegs.length; i++) {
      if (matchSegments(pathSegs.slice(i), patSegs.slice(1))) return true;
    }
    return false;
  }
  if (pathSegs.length === 0) return false;
  if (!segmentToRegex(patSegs[0]).test(pathSegs[0])) return false;
  return matchSegments(pathSegs.slice(1), patSegs.slice(1));
}

function normalize(rel: string, caseInsensitive: boolean): string[] {
  const unified = rel.replace(/\\/g, '/');
  const lowered = caseInsensitive ? unified.toLowerCase() : unified;
  return lowered.split('/').filter(Boolean);
}

/** 相对路径(文件)是否命中任一排除 glob。 */
export function isExcluded(
  relPath: string,
  patterns: readonly string[],
  caseInsensitive: boolean,
): boolean {
  const pathSegs = normalize(relPath, caseInsensitive);
  return patterns.some((p) => matchSegments(pathSegs, normalize(p, caseInsensitive)));
}

/**
 * 目录是否可整体剪枝:存在形如 `<dir>/**` 的排除项且 `<dir>` 前缀精确匹配
 * 该目录(前缀段可含 `*`)。剪枝纯属性能优化——被剪目录下所有文件本就会被
 * isExcluded 逐个排除。
 */
export function shouldPruneDir(
  relDir: string,
  patterns: readonly string[],
  caseInsensitive: boolean,
): boolean {
  const dirSegs = normalize(relDir, caseInsensitive);
  return patterns.some((p) => {
    const patSegs = normalize(p, caseInsensitive);
    if (patSegs.length < 2 || patSegs[patSegs.length - 1] !== '**') return false;
    return matchSegments(dirSegs, patSegs.slice(0, -1));
  });
}

// ── journal ───────────────────────────────────────────────────────────────

interface CopyJournal {
  schemaVersion: 1;
  state: 'copying' | 'done';
  startedAt: string;
  finishedAt?: string;
  copiedFiles?: number;
  totalBytes?: number;
  /** 本轮计划复制的精确相对路径；重试前只清理这些文件，不碰 Cindy 自有数据。 */
  copiedPaths?: string[];
}

function readJournal(newUserDataDir: string): CopyJournal | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(newUserDataDir, COPY_JOURNAL_REL_PATH), 'utf8'),
    ) as CopyJournal;
    if (parsed?.schemaVersion !== 1) return null;
    if (parsed.copiedPaths != null && (
      !Array.isArray(parsed.copiedPaths)
      || parsed.copiedPaths.some((entry) => typeof entry !== 'string')
    )) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 健康检查失败退出前调用:保留路径清单并置 copying,下次首启先清理再重拷。 */
export function resetCopyJournal(newUserDataDir: string): void {
  const journalPath = path.join(newUserDataDir, COPY_JOURNAL_REL_PATH);
  try {
    const existing = readJournal(newUserDataDir);
    if (existing == null) {
      fs.rmSync(journalPath, { force: true });
      return;
    }
    writeJsonAtomic(journalPath, {
      ...existing,
      state: 'copying',
      finishedAt: undefined,
    } satisfies CopyJournal);
  } catch { /* best-effort */ }
}

// ── 扫描 + preflight + 拷贝 ───────────────────────────────────────────────

export interface DataCopyProgress {
  copiedFiles: number;
  totalFiles: number;
}

export interface RunDataCopyArgs {
  legacyUserDataDir: string;
  newUserDataDir: string;
  /** 目标品牌主库前缀(`<prefix>-<userId>.db`)，用于拒绝合并既有目标 profile。 */
  targetDbFilePrefix: string;
  /** 锚定 glob 排除清单(唯一来源 copyExcludes.ts,调用方传入)。 */
  excludes: readonly string[];
  platform?: NodeJS.Platform;
  /** 目标卷可用字节;探测失败返回 null(降级为跳过 preflight,仅告警)。 */
  freeBytesFor?: (dir: string) => number | null;
  minFreeBytesFactor?: number;
  onProgress?: (p: DataCopyProgress) => void;
  /**
   * 是否信任既有 journal=done。默认 true 供通用幂等调用；未落 first-run sentinel 的
   * Cindy 首启必须传 false，覆盖“拷完后、确认前崩溃，用户回老 app 继续写入”的窗口。
   */
  trustCompletedJournal?: boolean;
  log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  nowIso?: () => string;
}

export type RunDataCopyResult =
  | { ok: true; copiedFiles: number; totalBytes: number; skipped: boolean }
  | {
      ok: false;
      code: 'COPY_FAILED' | 'INSUFFICIENT_DISK' | 'TARGET_PROFILE_EXISTS';
      error: string;
    };

interface ScanEntry {
  rel: string;
  size: number;
}

function scanSource(
  root: string,
  excludes: readonly string[],
  caseInsensitive: boolean,
  log: RunDataCopyArgs['log'],
): { entries: ScanEntry[]; totalBytes: number } {
  const entries: ScanEntry[] = [];
  let totalBytes = 0;
  const walk = (dir: string): void => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, dirent.name);
      const rel = path.relative(root, abs);
      if (dirent.isDirectory()) {
        if (shouldPruneDir(rel, excludes, caseInsensitive)) continue;
        walk(abs);
        continue;
      }
      if (dirent.isSymbolicLink()) {
        // userData 内的关键数据无 symlink 形态(agent 二进制等已整目录排除);
        // 保守跳过,避免拷出跨设备/循环引用问题。
        log.warn(`[migration-copy] skipping symlink: ${rel}`);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (isExcluded(rel, excludes, caseInsensitive)) continue;
      const size = fs.statSync(abs).size;
      entries.push({ rel, size });
      totalBytes += size;
    }
  };
  walk(root);
  return { entries, totalBytes };
}

function defaultFreeBytesFor(dir: string): number | null {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

/** 删除上轮清单中实际复制过的目标文件；journal 路径越界时 fail closed。 */
function removePreviousCopyPayload(
  newUserDataDir: string,
  copiedPaths: readonly string[],
): void {
  const root = path.resolve(newUserDataDir);
  for (const rel of copiedPaths) {
    const dest = path.resolve(root, rel);
    const within = path.relative(root, dest);
    if (!within || within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
      throw new Error(`copy journal path escapes destination: ${rel}`);
    }
    try {
      const stat = fs.lstatSync(dest);
      if (stat.isDirectory()) {
        throw new Error(`copy journal file path became a directory: ${rel}`);
      }
      fs.unlinkSync(dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

/**
 * 找出目标根下未被本次 copy journal 声明拥有的目标品牌主库。
 *
 * Cindy 启动本身会先创建 singleton/log 等瞬态文件，不能据“目录非空”拒绝迁移；
 * 主库则明确代表已存在的用户 profile。SQLite sidecar 与主库采用相同归属规则。
 */
function listUnownedTargetProfileDatabases(
  args: RunDataCopyArgs,
  existing: CopyJournal | null,
  caseInsensitive: boolean,
): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(args.newUserDataDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const normalizeForCompare = (value: string): string => {
    const normalized = path.normalize(value);
    return caseInsensitive ? normalized.toLocaleLowerCase('en-US') : normalized;
  };
  const ownedPaths = new Set(
    (existing?.copiedPaths ?? []).map((rel) => normalizeForCompare(rel)),
  );
  const prefix = caseInsensitive
    ? `${args.targetDbFilePrefix}-`.toLocaleLowerCase('en-US')
    : `${args.targetDbFilePrefix}-`;

  return entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => {
      const comparable = caseInsensitive ? name.toLocaleLowerCase('en-US') : name;
      const isTargetDatabase = comparable.startsWith(prefix) && (
        comparable.endsWith('.db')
        || comparable.endsWith('.db-wal')
        || comparable.endsWith('.db-shm')
        || comparable.endsWith('.db-journal')
      );
      return isTargetDatabase && !ownedPaths.has(normalizeForCompare(name));
    });
}

/**
 * Cindy 首启自拷主流程:journal 判定 → 预扫描 → 磁盘 preflight → 逐文件
 * 覆盖拷贝(带进度)→ journal=done。同一源可安全重跑(整体重拷模型)。
 */
export function runLegacyDataCopy(args: RunDataCopyArgs): RunDataCopyResult {
  const nowIso = args.nowIso ?? (() => new Date().toISOString());
  const caseInsensitive = (args.platform ?? process.platform) === 'win32';
  const journalPath = path.join(args.newUserDataDir, COPY_JOURNAL_REL_PATH);

  const existing = readJournal(args.newUserDataDir);
  try {
    const conflicts = listUnownedTargetProfileDatabases(args, existing, caseInsensitive);
    if (conflicts.length > 0) {
      return {
        ok: false,
        code: 'TARGET_PROFILE_EXISTS',
        error: `target userData contains ${conflicts.length} pre-existing profile database file(s) not owned by the migration journal`,
      };
    }
  } catch (err) {
    return { ok: false, code: 'COPY_FAILED', error: (err as Error).message };
  }
  if (existing?.state === 'done' && args.trustCompletedJournal !== false) {
    args.log.info('[migration-copy] journal=done — copy already complete, skipping');
    return {
      ok: true,
      copiedFiles: existing.copiedFiles ?? 0,
      totalBytes: existing.totalBytes ?? 0,
      skipped: true,
    };
  }
  if (existing?.state === 'done') {
    args.log.warn('[migration-copy] journal=done but first run is unconfirmed — recopying from scratch');
  }
  if (existing?.state === 'copying') {
    args.log.warn('[migration-copy] journal=copying — previous copy interrupted, redoing from scratch');
  }

  try {
    // 1. 预扫描(文件数 + 字节,供 preflight 与进度)
    const scan = scanSource(args.legacyUserDataDir, args.excludes, caseInsensitive, args.log);
    args.log.info(
      `[migration-copy] scan: ${scan.entries.length} files, ${scan.totalBytes} bytes to copy`,
    );

    // 2. 重试先清理上轮精确 payload；释放空间后再做本轮 preflight。
    fs.mkdirSync(args.newUserDataDir, { recursive: true });
    if (existing?.copiedPaths && existing.copiedPaths.length > 0) {
      // 先把盘上事实从 done 降为 copying，再删除它描述的 payload；崩溃后绝不能
      // 留下“journal 宣称完成、文件已被删”的假完成窗口。
      writeJsonAtomic(journalPath, {
        ...existing,
        state: 'copying',
        finishedAt: undefined,
      } satisfies CopyJournal);
      removePreviousCopyPayload(args.newUserDataDir, existing.copiedPaths);
    }

    // 3. preflight:目标卷余量(探测不到就带告警放行,不因探测能力放弃迁移)
    const factor = args.minFreeBytesFactor ?? COPY_MIN_FREE_BYTES_FACTOR;
    const freeBytesFor = args.freeBytesFor ?? defaultFreeBytesFor;
    const free = freeBytesFor(args.newUserDataDir);
    if (free != null && free < scan.totalBytes * factor) {
      return {
        ok: false,
        code: 'INSUFFICIENT_DISK',
        error: `need ${Math.ceil(scan.totalBytes * factor)} bytes free, have ${free}`,
      };
    }
    if (free == null) {
      args.log.warn('[migration-copy] free-space probe unavailable — skipping preflight');
    }

    // 4. journal=copying → 逐文件拷贝(半途崩溃由路径清单整体重拷兜底)
    const copiedPaths = scan.entries.map((entry) => entry.rel);
    writeJsonAtomic(journalPath, {
      schemaVersion: 1, state: 'copying', startedAt: nowIso(), copiedPaths,
    } satisfies CopyJournal);

    let copied = 0;
    for (const entry of scan.entries) {
      const src = path.join(args.legacyUserDataDir, entry.rel);
      const dest = path.join(args.newUserDataDir, entry.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      // copyFile 不复制 mode；明文 handoff 在导入并删除前必须维持最小权限窗口。
      if (path.normalize(entry.rel) === path.normalize(HANDOFF_REL_PATH)) {
        fs.chmodSync(dest, 0o600);
      }
      copied++;
      args.onProgress?.({ copiedFiles: copied, totalFiles: scan.entries.length });
    }

    writeJsonAtomic(journalPath, {
      schemaVersion: 1,
      state: 'done',
      startedAt: existing?.startedAt ?? nowIso(),
      finishedAt: nowIso(),
      copiedFiles: copied,
      totalBytes: scan.totalBytes,
      copiedPaths,
    } satisfies CopyJournal);
    args.log.info(`[migration-copy] done: ${copied} files copied`);
    return { ok: true, copiedFiles: copied, totalBytes: scan.totalBytes, skipped: false };
  } catch (err) {
    return { ok: false, code: 'COPY_FAILED', error: (err as Error).message };
  }
}
