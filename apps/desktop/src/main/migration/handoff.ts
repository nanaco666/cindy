/**
 * migration/handoff — macOS safeStorage 重封装的交接文件导出 / 导入(§6)。
 *
 * 为什么存在:Electron safeStorage 在 mac 上的加密密钥存于钥匙串条目
 * `"<appName> Safe Storage"`,品牌改名后新 app 解不开老 `.enc`;唯一无感路径
 * 是老 app(能解密)导出明文交接文件 → 随 userData 拷贝到新侧 → 新 app 用
 * 自己的 safeStorage 重加密落盘后删除交接文件。Windows 走 DPAPI(按 OS 用户
 * 加密,与应用名无关),不需要本模块——平台门禁由编排层负责,模块自身平台
 * 无关,便于在任意平台上跑单测。
 *
 * 范围(2026-07-09 审计结论):`<userData>/safe-storage/` 目录**动态枚举全部
 * `.enc`**;伴随明文 json(`*_connection.json` 等)随普通拷贝走,不进交接。
 * mac 系统钥匙串的 "Claude Code-credentials" 条目绑定 Claude Code 自己的名字,
 * 改名零影响,**不要**当作导出项。
 *
 * 安全约束(规则 23 / §6):
 *  - 交接文件 0600、落在 userData 内(绝不进仓库工作区 / cwd);
 *  - 每次进入 handoff_ready 前无条件重新导出(不复用旧文件);
 *  - 删除三兜底:confirmed 删两侧、健康检查失败自杀前删新侧、老 app 启动时
 *    对 failed/fallback_active/confirmed 或超期(7 天)的老侧文件兜底删。
 *
 * `.enc` 编码与 providerSecretStore / bootstrap-electron 的 safe-storage IPC
 * 字节级一致:文件内容 = base64(encryptString bytes),utf-8 文本。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './markerStore';
import type { MigrationHandoffInfo, MigrationState } from './types';

/** 加密后端抽象:老 app 侧只用 decrypt,新 app 侧只用 encrypt;注入便于测试。 */
export interface HandoffCrypto {
  isAvailable(): boolean;
  /** 输入 .enc 文件内容(base64 文本),返回明文;解不开时抛错。 */
  decryptFromBase64(encB64: string): string;
  /** 输入明文,返回 .enc 文件内容(base64 文本)。 */
  encryptToBase64(plaintext: string): string;
}

export interface HandoffEntry {
  /** safeStorage 存储键名(.enc 文件名去后缀),如 `api_key` / `github_token`。 */
  store: string;
  /** 相对 userData 的原文件路径(导入端按此写回)。 */
  relPath: string;
  contentType: 'text';
  plaintextB64: string;
  /** 导出时源 .enc 文件内容的 sha256;导入端不一致仅记 warning(§6)。 */
  encryptedSha256: string;
}

export interface HandoffFile {
  schemaVersion: 1;
  createdAt: string;
  platform: string;
  sourceApp: string;
  sourceVersion: string;
  entries: HandoffEntry[];
}

export const HANDOFF_REL_PATH = path.join('migration', 'handoff.json');
/** 老侧兜底删除的超期阈值(§6 删除规则 3)。 */
export const HANDOFF_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const SAFE_STORAGE_DIR = 'safe-storage';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface ExportHandoffResult {
  ok: boolean;
  handoffPath: string;
  entryCount: number;
  /** 解密失败被跳过的存储键(这些数据在新侧无论如何都救不回,记日志即可)。 */
  skippedStores: string[];
  error?: string;
}

/**
 * 导出:枚举 `<userDataDir>/safe-storage/*.enc` → 逐个解密 → 写交接文件(0600)。
 * safe-storage 目录不存在 / 为空是合法情况(用户没配任何凭证),导出空 entries。
 */
export function exportHandoff(args: {
  userDataDir: string;
  crypto: HandoffCrypto;
  sourceApp: string;
  sourceVersion: string;
  platform?: string;
  nowIso?: string;
}): ExportHandoffResult {
  const handoffPath = path.join(args.userDataDir, HANDOFF_REL_PATH);
  if (!args.crypto.isAvailable()) {
    return { ok: false, handoffPath, entryCount: 0, skippedStores: [], error: 'safeStorage unavailable' };
  }

  const dir = path.join(args.userDataDir, SAFE_STORAGE_DIR);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.enc'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        ok: false,
        handoffPath,
        entryCount: 0,
        skippedStores: [],
        error: (err as Error).message,
      };
    }
    files = []; // 目录不存在 = 无凭证,合法
  }

  const entries: HandoffEntry[] = [];
  const skippedStores: string[] = [];
  for (const file of files.sort()) {
    const store = file.slice(0, -'.enc'.length);
    try {
      const encB64 = fs.readFileSync(path.join(dir, file), 'utf8');
      const plaintext = args.crypto.decryptFromBase64(encB64);
      entries.push({
        store,
        relPath: `${SAFE_STORAGE_DIR}/${file}`,
        contentType: 'text',
        plaintextB64: Buffer.from(plaintext, 'utf8').toString('base64'),
        encryptedSha256: sha256Hex(encB64),
      });
    } catch {
      // 老密钥本来就解不开(历史损坏/换过机器)——新侧无论如何救不回,跳过。
      skippedStores.push(store);
    }
  }

  const handoff: HandoffFile = {
    schemaVersion: 1,
    createdAt: args.nowIso ?? new Date().toISOString(),
    platform: args.platform ?? process.platform,
    sourceApp: args.sourceApp,
    sourceVersion: args.sourceVersion,
    entries,
  };
  writeJsonAtomic(handoffPath, handoff, { mode: 0o600 });
  return { ok: true, handoffPath, entryCount: entries.length, skippedStores };
}

/**
 * 导出 handoff 并生成可原子登记进 marker 的内容摘要。执行窗口与 stage
 * 共用这条路径，确保“刷新凭证”和“刷新 marker 元数据”不会漂移。
 */
export function exportHandoffSnapshot(args: {
  userDataDir: string;
  crypto: HandoffCrypto;
  sourceApp: string;
  sourceVersion: string;
  platform?: string;
  nowIso?: string;
  readHandoffContent?: (filePath: string) => string;
}): ExportHandoffSnapshotResult {
  const createdAt = args.nowIso ?? new Date().toISOString();
  const exported = exportHandoff({ ...args, nowIso: createdAt });
  if (!exported.ok) return { ...exported, ok: false, info: null };
  try {
    const content = (args.readHandoffContent
      ?? ((filePath: string) => fs.readFileSync(filePath, 'utf8')))(exported.handoffPath);
    return {
      ...exported,
      ok: true,
      info: {
        path: exported.handoffPath,
        createdAt,
        sha256: sha256Hex(content),
      },
    };
  } catch (err) {
    deleteHandoff(exported.handoffPath);
    return {
      ...exported,
      ok: false,
      info: null,
      error: (err as Error).message,
    };
  }
}

/** 读交接文件;不存在 / 损坏 / schema 不符返回 null。 */
export function readHandoff(handoffPath: string): HandoffFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(handoffPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as HandoffFile;
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface ImportHandoffResult {
  ok: boolean;
  importedCount: number;
  /** encryptedSha256 与拷贝到新侧的 .enc 不一致的键(以 handoff 为准导入,仅告警)。 */
  driftWarnings: string[];
  /** relPath 不在新 userData/safe-storage 内的条目；跳过且告警。 */
  pathWarnings: string[];
  error?: string;
}

export type ExportHandoffSnapshotResult =
  | (ExportHandoffResult & { ok: true; info: MigrationHandoffInfo })
  | (ExportHandoffResult & { ok: false; info: null });

function resolveSafeStorageDestination(newUserDataDir: string, relPath: unknown): string | null {
  if (typeof relPath !== 'string' || relPath.length === 0) return null;
  const safeStorageRoot = path.resolve(newUserDataDir, SAFE_STORAGE_DIR);
  const destination = path.resolve(newUserDataDir, relPath);
  const relative = path.relative(safeStorageRoot, destination);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) return null;
  return destination;
}

/**
 * 导入(新 app 首启健康检查第 2 步):逐条用新 safeStorage 重加密写回
 * `<newUserDataDir>/<relPath>`,全部成功后删除新侧交接文件。
 * 任何一条写失败即整体失败(健康检查会走 failed 路径,新侧交接文件由
 * 调用方在自杀前删除——见 deleteHandoff)。
 */
export function importHandoff(args: {
  newUserDataDir: string;
  crypto: HandoffCrypto;
  handoffPath?: string;
}): ImportHandoffResult {
  const handoffPath = args.handoffPath ?? path.join(args.newUserDataDir, HANDOFF_REL_PATH);
  const handoff = readHandoff(handoffPath);
  if (handoff == null) {
    return {
      ok: false, importedCount: 0, driftWarnings: [], pathWarnings: [],
      error: 'handoff missing or corrupt',
    };
  }
  if (!args.crypto.isAvailable()) {
    return {
      ok: false, importedCount: 0, driftWarnings: [], pathWarnings: [],
      error: 'safeStorage unavailable',
    };
  }

  const driftWarnings: string[] = [];
  const pathWarnings: string[] = [];
  let importedCount = 0;
  for (const entry of handoff.entries) {
    const destPath = resolveSafeStorageDestination(args.newUserDataDir, entry.relPath);
    if (destPath == null) {
      pathWarnings.push(typeof entry.store === 'string' ? entry.store : '(unknown)');
      continue;
    }
    try {
      const copied = fs.readFileSync(destPath, 'utf8');
      if (sha256Hex(copied) !== entry.encryptedSha256) driftWarnings.push(entry.store);
    } catch {
      // 拷贝阶段排除/丢失了该文件——handoff 是权威来源,照常写回。
      driftWarnings.push(entry.store);
    }
    try {
      const plaintext = Buffer.from(entry.plaintextB64, 'base64').toString('utf8');
      const encB64 = args.crypto.encryptToBase64(plaintext);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, encB64, 'utf-8');
      importedCount += 1;
    } catch (err) {
      return {
        ok: false,
        importedCount,
        driftWarnings,
        pathWarnings,
        error: `re-encrypt failed for "${entry.store}": ${(err as Error).message}`,
      };
    }
  }

  deleteHandoff(handoffPath);
  return { ok: true, importedCount, driftWarnings, pathWarnings };
}

/** 删除原子写遗留的 handoff 临时明文；返回是否删掉至少一个文件。 */
function deleteHandoffTemps(handoffPath: string): boolean {
  const dir = path.dirname(handoffPath);
  const prefix = `.${path.basename(handoffPath)}.tmp-`;
  let removed = false;
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.startsWith(prefix));
  } catch {
    return false;
  }
  for (const name of names) {
    try {
      fs.unlinkSync(path.join(dir, name));
      removed = true;
    } catch {
      // 删除是安全兜底；被占用时留给下次启动重试。
    }
  }
  return removed;
}

/** 幂等删除交接文件及原子写临时明文(文件不存在视为成功)。 */
export function deleteHandoff(handoffPath: string): void {
  try {
    fs.unlinkSync(handoffPath);
  } catch {
    /* ENOENT 等一律忽略——删除是兜底动作,不阻塞任何流程 */
  }
  deleteHandoffTemps(handoffPath);
}

/**
 * 老 app 启动兜底(§6 删除规则 3):marker 处于长驻态或交接文件超期时删老侧。
 * 返回是否执行了删除(进日志)。
 */
export function deleteHandoffIfStale(args: {
  userDataDir: string;
  markerState: MigrationState | null;
  nowMs: number;
}): boolean {
  const handoffPath = path.join(args.userDataDir, HANDOFF_REL_PATH);
  // 进程启动时不存在合法的并发导出者；任何 tmp 都是上次原子写被强杀后
  // 遗留的明文，和 marker 状态无关，必须立即清理。
  const removedTemp = deleteHandoffTemps(handoffPath);
  const longLived = args.markerState === 'failed'
    || args.markerState === 'fallback_active'
    || args.markerState === 'confirmed'
    || args.markerState === null;
  const handoff = readHandoff(handoffPath);
  if (handoff == null) {
    if (!fs.existsSync(handoffPath)) return removedTemp;
    // final 文件可能在导出后损坏，但仍包含 plaintextB64。无法读取 createdAt 时用文件
    // mtime 判 TTL；长驻态则立即删除，进行中的新鲜文件保留给当前迁移显式失败处理。
    let expired = true;
    try {
      expired = args.nowMs - fs.statSync(handoffPath).mtimeMs >= HANDOFF_MAX_AGE_MS;
    } catch {
      // 文件存在但 stat 失败时按 stale 处理，避免明文秘密永久滞留。
    }
    if (!longLived && !expired) return removedTemp;
    deleteHandoff(handoffPath);
    return true;
  }

  const createdMs = Date.parse(handoff.createdAt);
  const expired = !Number.isFinite(createdMs) || args.nowMs - createdMs >= HANDOFF_MAX_AGE_MS;

  if (!longLived && !expired) return removedTemp;
  deleteHandoff(handoffPath);
  return true;
}
