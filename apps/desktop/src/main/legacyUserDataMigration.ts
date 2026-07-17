/**
 * legacyUserDataMigration — 首登轻量数据迁移(mToc)。
 *
 * 身份翻转(2026-07-17)后 userData 目录从 `xdt-maker` 变为 `Cindy`,老用户的
 * 主库与媒体总仓留在同级的老目录里。本模块在「用户首次登录成功、db 尚未打开」
 * 时(registerLocalDbIpc 的 beforeEnsureReady 钩子)做一次**只读老目录**的简单
 * 迁移:复制主库(+wal/shm 附属文件)与 `cindy-media` 目录到新 userData,完成后
 * 写 marker 文件 `<userData>/mToc` 防重入。
 *
 * 设计要点:
 *  - 与渠道迁移(migration/ 目录的品牌迁移状态机)完全无关,不复用其状态。
 *  - 全程绝不写/删老目录任何内容;目标已存在的文件一律跳过不覆盖。
 *  - 任一步失败:不写 marker(下次登录重试)、warn 日志、通知 renderer failed,
 *    然后正常返回 —— 不阻塞登录,ensureReady 会照常建新库。
 *  - 老目录不存在(全新用户):静默写 marker 返回,不弹窗打扰。
 *  - 老目录存在:推送 confirm 态给 renderer 弹确认窗,await 用户确认(IPC
 *    `legacy-migration:confirm`)后才开始复制。
 *
 * 可测试性(AGENTS.md 规则 14):核心流程 `runLegacyUserDataMigration` 全部依赖
 * 经 `LegacyUserDataMigrationDeps` 注入(fs / 时钟 / 日志 / UI 桥),单测用内存
 * fs 假体直接驱动;electron 依赖只出现在默认实现的静态 import 里(main 禁运行时
 * 动态 import)。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { BRAND_IDENTITY } from '@lizi/maker-shared/brand-identity';

import { createLogger } from './logger';

/** marker 文件名(userData 根下)。存在 = 本 profile 已做过首登轻量迁移。 */
export const LEGACY_MIGRATION_MARKER_FILENAME = 'mToc';

/** 老目录里媒体总仓的目录名(与新 userData 下同名,原样平移)。 */
const CINDY_MEDIA_DIR_NAME = 'cindy-media';

/** 推送给 renderer 的弹窗阶段。 */
export type LegacyMigrationPhase = 'confirm' | 'running' | 'done' | 'failed';

/** 内存可替身的最小 fs 面;默认实现见 realFsDeps。全部异步,不碰同步 API。 */
export interface LegacyMigrationFsDeps {
  /** 路径存在(文件或目录)。 */
  pathExists(p: string): Promise<boolean>;
  /** 列目录文件名;目录不存在返回 []。 */
  listDir(dir: string): Promise<string[]>;
  /** 列目录条目(区分子目录);目录不存在返回 []。media merge 用。 */
  listDirEntries(dir: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
  /** 文件 mtime(ms);用于「扫最新源库」。 */
  statMtimeMs(p: string): Promise<number>;
  /** 文件字节数;media merge 的"已存在但截断"检测用。 */
  statSize(p: string): Promise<number>;
  /** 复制单文件(允许覆盖——只用于 .mtoc-tmp 临时名,最终名一律经 rename 入位)。 */
  copyFile(src: string, dest: string): Promise<void>;
  /** 原子改名(同卷)。Windows 上目标存在会失败,调用方先 removeIfExists。 */
  rename(src: string, dest: string): Promise<void>;
  /** 删除文件,不存在时静默成功。 */
  removeIfExists(p: string): Promise<void>;
  /** 递归建目录(mkdir -p)。 */
  mkdirp(dir: string): Promise<void>;
  /** 写文本文件(marker)。 */
  writeFile(p: string, content: string): Promise<void>;
}

/** UI 桥:main→renderer 弹窗状态推送 + 等待用户点「确定」。 */
export interface LegacyMigrationUiDeps {
  publish(phase: LegacyMigrationPhase): void;
  waitForConfirm(): Promise<void>;
}

/** runLegacyUserDataMigration 的全量依赖注入面。 */
export interface LegacyUserDataMigrationDeps {
  /** 新 userData 目录(绝对路径)。 */
  userDataDir: string;
  /** 老 userData 目录候选名(同级目录下逐个探测,取第一个存在的)。 */
  legacyDirNames: readonly string[];
  /** 老主库文件名前缀(`<prefix>-<userId>.db`)。 */
  legacyDbPrefixes: readonly string[];
  /** 新主库文件名前缀(目标 `<prefix>-<userId>.db`)。 */
  currentDbPrefix: string;
  fs: LegacyMigrationFsDeps;
  /** 注入时钟(marker 的 migratedAt)。 */
  now(): Date;
  log: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void };
  ui: LegacyMigrationUiDeps;
}

export type LegacyUserDataMigrationResult =
  | { status: 'marker-exists' }
  | { status: 'no-legacy-dir' }
  | { status: 'migrated'; sourceDb: string | null; mediaCopied: boolean }
  | { status: 'failed'; error: string };

/** wal / shm 附属文件后缀(SQLite sidecar 命名:`<db 文件全名><后缀>`)。 */
const DB_SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;

/**
 * 复制暂存临时名后缀。所有复制先落 tmp、就绪后 rename 入位——中途崩溃只会
 * 残留 tmp 文件(重试时清理重拷),**最终名一旦存在即是完整文件**,"目标已
 * 存在跳过"才不会把截断半成品转正(review P1)。
 */
export const COPY_TMP_SUFFIX = '.mtoc-tmp';

/**
 * db + sidecar 原子入位:全部先拷到 tmp,再按「sidecar 先、db 最后」rename。
 * db 最终名是"完成信号"——它 rename 成功前,重试路径永远走整体重拷。
 */
async function copyDbAtomic(
  fs: LegacyMigrationFsDeps,
  sourceDbPath: string,
  targetDbPath: string,
): Promise<void> {
  const dbTmp = `${targetDbPath}${COPY_TMP_SUFFIX}`;
  await fs.removeIfExists(dbTmp);
  await fs.copyFile(sourceDbPath, dbTmp);
  const sidecarRenames: Array<{ tmp: string; final: string }> = [];
  for (const suffix of DB_SIDECAR_SUFFIXES) {
    const sidecarSrc = `${sourceDbPath}${suffix}`;
    if (!(await fs.pathExists(sidecarSrc))) continue;
    const final = `${targetDbPath}${suffix}`;
    const tmp = `${final}${COPY_TMP_SUFFIX}`;
    await fs.removeIfExists(tmp);
    await fs.copyFile(sidecarSrc, tmp);
    sidecarRenames.push({ tmp, final });
  }
  // 目标 db 不存在(调用前提),最终名上的任何 sidecar 都是上次 attempt 的孤儿
  // ——无条件清掉,防止「本次源侧无 wal」时旧 attempt 的 stale wal 与新 db 错配
  // (SQLite 打开时按 wal 自身校验链回放,不与 db 交叉校验,错配可致损坏)。
  for (const suffix of DB_SIDECAR_SUFFIXES) {
    await fs.removeIfExists(`${targetDbPath}${suffix}`);
  }
  for (const { tmp, final } of sidecarRenames) {
    await fs.rename(tmp, final);
  }
  await fs.rename(dbTmp, targetDbPath);
}

/** 清理上次崩溃可能残留的 db/sidecar tmp 文件(目标库已存在的跳过分支用)。 */
async function cleanupDbTmp(fs: LegacyMigrationFsDeps, targetDbPath: string): Promise<void> {
  await fs.removeIfExists(`${targetDbPath}${COPY_TMP_SUFFIX}`);
  for (const suffix of DB_SIDECAR_SUFFIXES) {
    await fs.removeIfExists(`${targetDbPath}${suffix}${COPY_TMP_SUFFIX}`);
  }
}

/**
 * media 目录递归 merge:目标缺失 → tmp+rename 复制;目标存在且字节数一致 →
 * 跳过;字节数不一致(上次截断残留)→ 重拷修复。cindy-media 是内容寻址 blob
 * 仓,"文件名在 = 内容对"必须由字节数兜底,否则截断 blob 永久坏(review P1)。
 */
async function mergeCopyDir(
  fs: LegacyMigrationFsDeps,
  srcDir: string,
  destDir: string,
): Promise<void> {
  await fs.mkdirp(destDir);
  for (const entry of await fs.listDirEntries(srcDir)) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory) {
      await mergeCopyDir(fs, src, dest);
      continue;
    }
    if (entry.name.endsWith(COPY_TMP_SUFFIX)) continue; // 防御:源侧不应有
    if (await fs.pathExists(dest)) {
      const srcSize = await fs.statSize(src);
      const destSize = await fs.statSize(dest);
      if (srcSize === destSize) continue;
    }
    const tmp = `${dest}${COPY_TMP_SUFFIX}`;
    await fs.removeIfExists(tmp);
    await fs.copyFile(src, tmp);
    await fs.removeIfExists(dest);
    await fs.rename(tmp, dest);
  }
}

/**
 * 选源库:优先精确命中 `<prefix>-<userId>.db`;否则扫 `<prefix>-*.db` 里 mtime
 * 最新的一个;一个都没有返回 null(跳过 db 步骤)。
 */
async function pickSourceDb(
  legacyDir: string,
  userId: string,
  legacyDbPrefixes: readonly string[],
  fs: LegacyMigrationFsDeps,
): Promise<string | null> {
  for (const prefix of legacyDbPrefixes) {
    const exact = path.join(legacyDir, `${prefix}-${userId}.db`);
    if (await fs.pathExists(exact)) return exact;
  }
  const entries = await fs.listDir(legacyDir);
  const candidates = entries.filter(
    (name) =>
      name.endsWith('.db') &&
      legacyDbPrefixes.some((prefix) => name.startsWith(`${prefix}-`)),
  );
  if (candidates.length === 0) return null;
  let newest: { name: string; mtimeMs: number } | null = null;
  for (const name of candidates) {
    const mtimeMs = await fs.statMtimeMs(path.join(legacyDir, name));
    if (newest == null || mtimeMs > newest.mtimeMs) newest = { name, mtimeMs };
  }
  return newest == null ? null : path.join(legacyDir, newest.name);
}

/** 写 mToc marker(JSON;schemaVersion 固定 1)。 */
async function writeMarker(
  deps: LegacyUserDataMigrationDeps,
  userId: string,
  sourceDb: string | null,
  mediaCopied: boolean,
): Promise<void> {
  await deps.fs.writeFile(
    path.join(deps.userDataDir, LEGACY_MIGRATION_MARKER_FILENAME),
    JSON.stringify(
      {
        schemaVersion: 1,
        migratedAt: deps.now().toISOString(),
        userId,
        sourceDb,
        mediaCopied,
      },
      null,
      2,
    ),
  );
}

/**
 * 首登轻量数据迁移核心流程。纯 DI,不 import electron;绝不 throw
 * (所有失败都收敛成 failed 结果),调用方(beforeEnsureReady)无需 try/catch。
 */
export async function runLegacyUserDataMigration(
  userId: string,
  deps: LegacyUserDataMigrationDeps,
): Promise<LegacyUserDataMigrationResult> {
  try {
    // 1. marker 已存在 → 零开销返回,绝不弹窗。
    const markerPath = path.join(deps.userDataDir, LEGACY_MIGRATION_MARKER_FILENAME);
    if (await deps.fs.pathExists(markerPath)) return { status: 'marker-exists' };

    // 2. 探测同级老目录(取候选名里第一个存在的)。
    const parentDir = path.dirname(deps.userDataDir);
    let legacyDir: string | null = null;
    for (const name of deps.legacyDirNames) {
      const candidate = path.join(parentDir, name);
      if (await deps.fs.pathExists(candidate)) {
        legacyDir = candidate;
        break;
      }
    }
    if (legacyDir == null) {
      // 全新用户:无可迁,静默写 marker,不打扰。
      await writeMarker(deps, userId, null, false);
      deps.log.info('legacy userData migration: no legacy dir, marker written silently');
      return { status: 'no-legacy-dir' };
    }

    // 3. 有老数据 → 弹确认窗并等待用户点「确定」(唯一按钮,不可取消)。
    deps.ui.publish('confirm');
    await deps.ui.waitForConfirm();
    deps.ui.publish('running');

    try {
      // 3a/3b. 主库 + wal/shm 附属文件。
      let copiedSourceDb: string | null = null;
      const sourceDbPath = await pickSourceDb(legacyDir, userId, deps.legacyDbPrefixes, deps.fs);
      if (sourceDbPath == null) {
        deps.log.info('legacy userData migration: no legacy db found, skipping db step');
      } else {
        const targetDbPath = path.join(
          deps.userDataDir,
          `${deps.currentDbPrefix}-${userId}.db`,
        );
        if (await deps.fs.pathExists(targetDbPath)) {
          // 最终名只经 rename 产生,存在即完整成品(半成品只会以 .mtoc-tmp 残留),
          // 跳过是安全的;顺手清理上次崩溃可能留下的 tmp。
          await cleanupDbTmp(deps.fs, targetDbPath);
          deps.log.info(
            'legacy userData migration: target db already exists, skipping db copy (%s)',
            path.basename(targetDbPath),
          );
        } else {
          await copyDbAtomic(deps.fs, sourceDbPath, targetDbPath);
          copiedSourceDb = path.basename(sourceDbPath);
          deps.log.info(
            'legacy userData migration: db copied %s -> %s',
            copiedSourceDb,
            path.basename(targetDbPath),
          );
        }
      }

      // 3c. cindy-media 递归 merge(逐文件 tmp+rename;同名同字节跳过,字节不一致
      // 视为截断残留重拷修复);老目录没有则跳过。
      let mediaCopied = false;
      const legacyMediaDir = path.join(legacyDir, CINDY_MEDIA_DIR_NAME);
      if (await deps.fs.pathExists(legacyMediaDir)) {
        await mergeCopyDir(
          deps.fs,
          legacyMediaDir,
          path.join(deps.userDataDir, CINDY_MEDIA_DIR_NAME),
        );
        mediaCopied = true;
      }

      // 3d. 全部成功 → 写 marker → done。
      await writeMarker(deps, userId, copiedSourceDb, mediaCopied);
      deps.ui.publish('done');
      return { status: 'migrated', sourceDb: copiedSourceDb, mediaCopied };
    } catch (err) {
      // 3e. 复制阶段失败:不写 marker(下次登录重试),failed 弹窗,不阻塞登录。
      const message = err instanceof Error ? err.message : String(err);
      deps.log.warn('legacy userData migration failed (will retry next login): %s', message);
      deps.ui.publish('failed');
      return { status: 'failed', error: message };
    }
  } catch (err) {
    // marker / 探测阶段的意外失败:同样不阻塞登录;不弹窗(此时还没进确认流程,
    // 或 marker 写失败——下次登录自然重来)。
    const message = err instanceof Error ? err.message : String(err);
    deps.log.warn('legacy userData migration aborted: %s', message);
    return { status: 'failed', error: message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Electron 默认实现(IPC 桥 + 真实 fs)。
// ─────────────────────────────────────────────────────────────────────────────

const log = createLogger('legacyUserDataMigration');

/** 当前推送给 renderer 的阶段(renderer 挂载晚于推送时经 get-state 补拉)。 */
let currentPhase: LegacyMigrationPhase | null = null;
/** confirm 弹窗的 pending resolver(同一时刻至多一个迁移在等确认)。 */
let pendingConfirmResolver: (() => void) | null = null;
/** 并发防重入:beforeEnsureReady 可能被重复触发,共享同一个 in-flight promise。 */
let inFlight: Promise<LegacyUserDataMigrationResult> | null = null;

function broadcastPhase(phase: LegacyMigrationPhase): void {
  currentPhase = phase;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('legacy-migration:state', { phase });
    }
  }
}

const realFsDeps: LegacyMigrationFsDeps = {
  pathExists: async (p) => {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  },
  listDir: async (dir) => {
    try {
      return await fsp.readdir(dir);
    } catch {
      return [];
    }
  },
  listDirEntries: async (dir) => {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    } catch {
      return [];
    }
  },
  statMtimeMs: async (p) => (await fsp.stat(p)).mtimeMs,
  statSize: async (p) => (await fsp.stat(p)).size,
  copyFile: (src, dest) => fsp.copyFile(src, dest),
  rename: (src, dest) => fsp.rename(src, dest),
  removeIfExists: (p) => fsp.rm(p, { force: true }),
  mkdirp: async (dir) => {
    await fsp.mkdir(dir, { recursive: true });
  },
  writeFile: (p, content) => fsp.writeFile(p, content, 'utf8'),
};

const electronUiDeps: LegacyMigrationUiDeps = {
  publish: broadcastPhase,
  waitForConfirm: () =>
    new Promise<void>((resolve) => {
      pendingConfirmResolver = resolve;
    }),
};

/**
 * 注册迁移弹窗的 IPC handler(bootstrap 里在 registerLocalDbIpc 前调用一次)。
 *  - `legacy-migration:confirm`:renderer 点「确定」→ 放行等待中的迁移;
 *    「失败 → 继续」也走这条(无 pending resolver 时仅清掉 failed 态)。
 *  - `legacy-migration:get-state`:renderer 弹窗组件挂载时补拉当前阶段,
 *    避免「main 先推送、renderer 后订阅」丢事件。
 * 两个 handler 都没有业务错误路径,无需 throwIpcError(规则 13 的错误编码协议
 * 只约束失败路径)。
 */
export function registerLegacyMigrationIpc(): void {
  ipcMain.handle('legacy-migration:confirm', () => {
    const resolver = pendingConfirmResolver;
    pendingConfirmResolver = null;
    if (resolver != null) {
      resolver();
      return;
    }
    // failed 态下的「继续」:清态,防止 renderer 重挂载后经 get-state 再次弹出。
    if (currentPhase === 'failed' || currentPhase === 'done') currentPhase = null;
  });
  ipcMain.handle('legacy-migration:get-state', () => ({ phase: currentPhase }));
}

/**
 * bootstrap 挂载点:首次登录成功后、ensureReady 打开 db 前调用。
 * 幂等 + 防重入;marker 已写时零开销。绝不 throw。
 */
export async function runLegacyUserDataMigrationForUser(userId: string): Promise<void> {
  if (inFlight != null) {
    await inFlight;
    return;
  }
  inFlight = runLegacyUserDataMigration(userId, {
    userDataDir: app.getPath('userData'),
    legacyDirNames: BRAND_IDENTITY.legacyUserDataDirNames,
    legacyDbPrefixes: BRAND_IDENTITY.legacyDbFilePrefixes,
    currentDbPrefix: BRAND_IDENTITY.dbFilePrefix,
    fs: realFsDeps,
    now: () => new Date(),
    log,
    ui: electronUiDeps,
  });
  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
}
