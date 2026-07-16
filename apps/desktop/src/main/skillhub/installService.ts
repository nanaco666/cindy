/**
 * skillhub/installService.ts — Market install / uninstall 链路（Hub + registry 版）。
 *
 * 流程：
 *   install:  Hub broker download info → fetch signed zip → sha256 校验
 *             → JSZip 解压到 staging → final switch 到目标位置
 *             → registry.addInstall → best-effort Claude symlink → emit done
 *   uninstall: 路径白名单校验 → rm 目标目录 → registry.removeInstall
 *
 * 安装目标：
 *   - 未传 installPath → 默认 `~/.agents/skills/<name>/`（双引擎共享）
 *     + 额外创建 `~/.claude/skills/<name>` symlink
 *   - 传入 installPath（完整路径）→ 直接使用，main 不做语义拼接
 *
 * 同名冲突（finalDir 已存在）的两个分支：
 *   1. finalDir 存在 + !force → 返回 errorCode='CONFLICT_USER_OWNED'（UI 弹二次确认）
 *   2. finalDir 存在 +  force → staging 完整解压后再替换旧目录
 *      - skipBackup=false → 旧目录临时移开,新版落地后移到 userData/skillhub/backups
 *      - skipBackup=true  → 旧目录临时移开,新版落地后删除旧目录
 *
 * v0.6 重构：废弃 xdt-manifest.json 目录内 manifest，改用集中 registry。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, net } from 'electron';
import JSZip from 'jszip';
import { serverApiFetch } from '../serverApiClient';
import { getCurrentUserId } from '../authManager';
import { registryService } from './registry';
import type { StoredInstall } from './registry/types';
import { computeFolderHash } from './folderHash';
import { getSkillInstallLockOwner, tryAcquireSkillInstallLock } from './installLock';
import { prepareSharedGlobalSkillLinks } from '../maker-host/shared-global-skills.js';
import { clearIgnoredAutoSyncSkill, ignoreAutoSyncSkill, isKnownAutoSyncCandidateSkill } from './autoSyncPreferences';

import { createLogger } from '../logger';

const log = createLogger('skillhub:installService');
const MAX_SKILL_ZIP = 200 * 1024 * 1024; // 200 MB
const MAX_SKILL_UNCOMPRESSED = 500 * 1024 * 1024; // 500 MB
const MAX_SKILL_ZIP_ENTRIES = 10_000;
const FALLBACK_LEGACY_AUTO_SYNC_SKILLS = new Set(['xdoa-skill']);

// ── 类型 ─────────────────────────────────────────────────────────────────────

export interface InstallParams {
  name: string;
  version?: string;
  /** 由产品自动同步服务发起的安装 / 更新。 */
  autoSync?: boolean;
  /**
   * 安装目标路径（完整 installPath）。
   *   - 不传 → 默认 `~/.agents/skills/<name>/`（global scope）
   *   - 传入 → 直接使用（basename 必须等于 name，否则返回 INTERNAL 错）
   *
   * 约定：UI 传 baseDir + name，由 UI 拼成 `${baseDir}/.agents/skills/${name}` 传入；
   *       或 UI 直接传完整 installPath。main 不再做语义拼接，降低耦合。
   */
  installPath?: string;
  force?: boolean;
  /**
   * force 覆盖时是否跳过持久备份。
   *   - false / 缺省 → 旧目录移到 userData/skillhub/backups 留作安全网
   *   - true        → 直接 rmrf 旧目录,完整替换(用于 detail "更新到 vN" 场景)
   */
  skipBackup?: boolean;
}

export type InstallErrorCode =
  | 'AUTH_REQUIRED'
  | 'NOT_FOUND'
  | 'DOWNLOAD_FAILED'
  | 'CHECKSUM_MISMATCH'
  | 'EXTRACT_FAILED'
  | 'CONFLICT_USER_OWNED'
  | 'WRITE_FAILED'
  | 'CANCELLED'
  | 'INTERNAL';

export type InstallProgressEvent =
  | { phase: 'fetching-info'; name: string }
  | { phase: 'downloading'; name: string }
  | { phase: 'verifying'; name: string }
  | { phase: 'extracting'; name: string }
  | { phase: 'registering'; name: string }
  | { phase: 'done'; name: string; version: string; absolutePath: string }
  | { phase: 'failed'; name: string; errorCode: InstallErrorCode; message: string };

type ProgressCb = (e: InstallProgressEvent) => void;

interface DownloadInfoResponse {
  url: string;
  expiresAt: string;
  fileHash: string;
  fileSize: number;
  zipSha256: string;
}

interface FinalSwitchRollbackState {
  backupDir: string | null;
  finalDirCreated: boolean;
}

type RegistryInstallEntry = Awaited<ReturnType<typeof registryService.getInstall>>;

// ── 内部状态：记录每个 name 当前正在跑的 AbortController ────────────────────────

const inflight = new Map<string, AbortController>();

export function isInstalling(name: string): boolean {
  return inflight.has(name);
}

export function cancelInstall(name: string): boolean {
  const ac = inflight.get(name);
  if (!ac) return false;
  ac.abort();
  return true;
}

// ── 工具 ─────────────────────────────────────────────────────────────────────

function sha256Hex(buf: ArrayBuffer | Uint8Array): string {
  const h = crypto.createHash('sha256');
  h.update(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  return h.digest('hex');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

function rand(): string {
  return crypto.randomBytes(4).toString('hex');
}

function backupsRoot(): string {
  return path.join(app.getPath('userData'), 'skillhub', 'backups');
}

async function movePersistentBackup(tempDir: string, skillName: string): Promise<string> {
  const root = path.join(backupsRoot(), skillName);
  await fs.promises.mkdir(root, { recursive: true });
  const dest = path.join(root, `${Date.now()}-${rand()}`);
  try {
    await fs.promises.rename(tempDir, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fs.promises.cp(tempDir, dest, { recursive: true, verbatimSymlinks: true });
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
  return dest;
}

async function rollbackFinalSwitch(finalDir: string, state: FinalSwitchRollbackState): Promise<void> {
  if (!state.finalDirCreated && !state.backupDir) return;

  if (state.finalDirCreated || state.backupDir) {
    await fs.promises.rm(finalDir, { recursive: true, force: true });
  }
  if (state.backupDir) {
    await fs.promises.rename(state.backupDir, finalDir);
  }
}

async function restoreRegistryAfterFinalSwitchRollback(
  skillName: string,
  finalDir: string,
  previousEntry: RegistryInstallEntry,
): Promise<void> {
  try {
    await registryService.removeInstall(skillName, finalDir);
  } catch (err) {
    try {
      const quarantinePath = await quarantineRolledBackInstall(finalDir, skillName);
      log.warn('[skillInstall] quarantined rolled back install after registry removal failed:', quarantinePath);
    } catch (quarantineErr) {
      log.error('[skillInstall] quarantine after registry removal failed:', quarantineErr);
    }
    throw err;
  }
  if (previousEntry) {
    try {
      await registryService.addInstall(skillName, finalDir, previousEntry);
    } catch (err) {
      try {
        const quarantinePath = await quarantineRolledBackInstall(finalDir, skillName);
        log.warn('[skillInstall] quarantined rolled back install after registry restore failed:', quarantinePath);
      } catch (quarantineErr) {
        log.error('[skillInstall] quarantine after registry restore failed:', quarantineErr);
      }
      throw err;
    }
  }
}

async function quarantineRolledBackInstall(finalDir: string, skillName: string): Promise<string> {
  if (!(await pathExists(finalDir))) return finalDir;
  const dest = path.join(path.dirname(finalDir), `.xdt-rollback-registry-failed-${skillName}-${Date.now()}-${rand()}`);
  await fs.promises.rename(finalDir, dest);
  return dest;
}

function isSubPathOrSame(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 安装目标目录：`~/.agents/skills/`，双引擎共享。 */
function globalSkillsDir(): string {
  return path.join(os.homedir(), '.agents', 'skills');
}

/** 共享安装锁被占时的用户可读文案（按持有方区分）。 */
function skillLockBusyMessage(skillName: string): string {
  const owner = getSkillInstallLockOwner(skillName);
  if (owner === 'learn-apply') return `${skillName} 正在被 learn 提案应用，请等待当前任务完成`;
  if (owner === 'market-uninstall') return `${skillName} 正在卸载中，请等待当前任务完成`;
  return `${skillName} 正在安装中，请等待当前任务完成`;
}

/**
 * 推导安装目标目录。
 * - installPath 提供 → finalDir = normalize(installPath)，验证 basename === name
 * - 未提供 → 走 globalSkillsDir() + name
 */
function resolveTargetDir(
  p: InstallParams,
): { finalDir: string; stagingParent: string } | { error: InstallErrorCode; message: string } {
  if (p.installPath) {
    const finalDir = path.normalize(p.installPath);
    if (path.basename(finalDir) !== p.name) {
      return {
        error: 'INTERNAL',
        message: `installPath 的 basename "${path.basename(finalDir)}" 与 name "${p.name}" 不符`,
      };
    }
    return { finalDir, stagingParent: path.dirname(finalDir) };
  }
  const finalDir = path.join(globalSkillsDir(), p.name);
  return { finalDir, stagingParent: globalSkillsDir() };
}

/**
 * 确保 linkPath 是指向 target 的 symlink（Claude 侧发现用）。
 * - 已是正确 symlink → skip
 * - 是实体目录 → skip（不覆盖用户手写的同名 skill）
 * - 是指向别处的 symlink → 重建
 * - 不存在 → 新建
 *
 * export 给 learn-host/apply.ts 复用(蒸馏产物落盘后同样要建 Claude 侧 link)。
 */
export async function ensureSymlinkToShared(linkPath: string, target: string): Promise<void> {
  try {
    const stat = await fs.promises.lstat(linkPath);
    if (stat.isSymbolicLink()) {
      const existing = path.resolve(path.dirname(linkPath), await fs.promises.readlink(linkPath));
      if (path.normalize(existing) === path.normalize(target)) return;
      await fs.promises.unlink(linkPath);
    } else {
      return;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  await fs.promises.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.promises.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

// 防 zip-slip：解压时拒绝跳出 dest 的相对路径
function safeJoin(dest: string, relPath: string): string | null {
  // JSZip entry name 是 POSIX 分隔符，先归一化
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const resolved = path.resolve(dest, normalized);
  return isSubPathOrSame(dest, resolved) ? resolved : null;
}

// ── 主入口：install ─────────────────────────────────────────────────────────

export async function install(
  p: InstallParams,
  onProgress: ProgressCb,
): Promise<{ success: true; name: string; version: string; absolutePath: string; replacedBackupPath?: string } | { success: false; errorCode: InstallErrorCode; message: string }> {
  const userId = getCurrentUserId();
  if (!userId) {
    onProgress({ phase: 'failed', name: p.name, errorCode: 'AUTH_REQUIRED', message: '未登录' });
    return { success: false, errorCode: 'AUTH_REQUIRED', message: '未登录' };
  }

  // 推导目标目录
  const resolved = resolveTargetDir(p);
  if ('error' in resolved) {
    onProgress({ phase: 'failed', name: p.name, errorCode: resolved.error, message: resolved.message });
    return { success: false, errorCode: resolved.error, message: resolved.message };
  }
  const { finalDir, stagingParent } = resolved;

  // 共享安装锁（与 learn apply / uninstall 互斥,按 name 串行,fail-fast 不排队）
  const releaseLock = tryAcquireSkillInstallLock(p.name, 'market-install');
  if (!releaseLock) {
    const msg = skillLockBusyMessage(p.name);
    onProgress({ phase: 'failed', name: p.name, errorCode: 'INTERNAL', message: msg });
    return { success: false, errorCode: 'INTERNAL', message: msg };
  }

  const ac = new AbortController();
  const signal = ac.signal;
  inflight.set(p.name, ac);

  const stagingDir = path.join(stagingParent, `.xdt-installing-${p.name}-${rand()}`);

  const checkAbort = (): boolean => {
    if (signal.aborted) {
      onProgress({ phase: 'failed', name: p.name, errorCode: 'CANCELLED', message: '已取消' });
      return true;
    }
    return false;
  };

  try {
    // 1) 取下载信息（走 hub broker）
    onProgress({ phase: 'fetching-info', name: p.name });
    if (checkAbort()) return { success: false, errorCode: 'CANCELLED', message: '已取消' };

    let info: DownloadInfoResponse;
    let downloadVersion: string = p.version ?? '';
    try {
      // 如果没传版本号，先查 hub 拿最新版本
      if (!downloadVersion) {
        const detail = await serverApiFetch<{ version: string }>(
          `/api/skills-hub/skills/${encodeURIComponent(p.name)}`,
        );
        downloadVersion = detail.version;
      }
      const versionQs = downloadVersion ? `?version=${encodeURIComponent(downloadVersion)}` : '';
      info = await serverApiFetch<DownloadInfoResponse>(
        `/api/skills-hub/skills/${encodeURIComponent(p.name)}/download${versionQs}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code: InstallErrorCode = (err as { statusCode?: number }).statusCode === 404 ? 'NOT_FOUND' : 'DOWNLOAD_FAILED';
      onProgress({ phase: 'failed', name: p.name, errorCode: code, message });
      return { success: false, errorCode: code, message };
    }

    if (checkAbort()) return { success: false, errorCode: 'CANCELLED', message: '已取消' };

    // 2) 下载 zip（流式 + 字节上限，防 OOM）
    if (info.fileSize > MAX_SKILL_ZIP) {
      const msg = `文件过大：${info.fileSize} bytes（上限 ${MAX_SKILL_ZIP}）`;
      onProgress({ phase: 'failed', name: p.name, errorCode: 'DOWNLOAD_FAILED', message: msg });
      return { success: false, errorCode: 'DOWNLOAD_FAILED', message: msg };
    }

    onProgress({ phase: 'downloading', name: p.name });
    let zipBuf: Uint8Array;
    try {
      const resp = await net.fetch(info.url, { method: 'GET', signal });
      if (!resp.ok) {
        throw new Error(`下载失败：HTTP ${resp.status}`);
      }

      const cl = resp.headers.get('Content-Length');
      if (cl !== null && Number(cl) > MAX_SKILL_ZIP) {
        throw new Error(`Content-Length 过大：${cl} bytes`);
      }

      const reader = resp.body!.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      const hardLimit = Math.max(info.fileSize * 1.1, info.fileSize + 4096);

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > hardLimit || received > MAX_SKILL_ZIP) {
          await reader.cancel();
          throw new Error(`下载超出大小限制：已接收 ${received} bytes`);
        }
        chunks.push(value);
      }

      zipBuf = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        zipBuf.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const safeUrl = (() => { try { const u = new URL(info.url); return `${u.origin}${u.pathname}`; } catch { return '(invalid url)'; } })();
      log.error('[skillInstall] download failed url=%s err=%s', safeUrl, message);
      onProgress({ phase: 'failed', name: p.name, errorCode: 'DOWNLOAD_FAILED', message });
      return { success: false, errorCode: 'DOWNLOAD_FAILED', message };
    }

    if (checkAbort()) return { success: false, errorCode: 'CANCELLED', message: '已取消' };

    // 3) 校验阶段保留给 UI 进度；下载后在本函数内校验 size/sha。
    onProgress({ phase: 'verifying', name: p.name });
    if (zipBuf.byteLength !== info.fileSize) {
      const msg = `下载大小不符：期望 ${info.fileSize}，实际 ${zipBuf.byteLength}`;
      onProgress({ phase: 'failed', name: p.name, errorCode: 'CHECKSUM_MISMATCH', message: msg });
      return { success: false, errorCode: 'CHECKSUM_MISMATCH', message: msg };
    }
    const actualSha = sha256Hex(zipBuf);
    if (actualSha !== info.zipSha256) {
      const msg = `下载校验失败：sha256 不匹配`;
      onProgress({ phase: 'failed', name: p.name, errorCode: 'CHECKSUM_MISMATCH', message: msg });
      return { success: false, errorCode: 'CHECKSUM_MISMATCH', message: msg };
    }

    if (checkAbort()) return { success: false, errorCode: 'CANCELLED', message: '已取消' };

    // 4) 同名冲突判定（F-DATA-4）:
    //    - finalDir 不存在                       → 直接装
    //    - finalDir 存在 + !force                → 返回 CONFLICT_USER_OWNED（UI 弹二次确认）
    if (await pathExists(finalDir)) {
      if (!p.force) {
        const msg = `目标位置已存在 ${p.name}/`;
        onProgress({ phase: 'failed', name: p.name, errorCode: 'CONFLICT_USER_OWNED', message: msg });
        return { success: false, errorCode: 'CONFLICT_USER_OWNED', message: msg };
      }
    }

    // 5) 解压到 staging 目录。先完整解压/校验,再触碰 finalDir,避免失败时破坏旧版本。
    onProgress({ phase: 'extracting', name: p.name });
    try {
      await fs.promises.mkdir(stagingDir, { recursive: true });
      const zip = await JSZip.loadAsync(zipBuf);
      const entries = Object.values(zip.files);
      if (entries.length > MAX_SKILL_ZIP_ENTRIES) {
        throw new Error(`zip entry 数量超过上限：${entries.length}/${MAX_SKILL_ZIP_ENTRIES}`);
      }
      let totalUncompressedBytes = 0;
      for (const entry of entries) {
        if (signal.aborted) throw new Error('CANCELLED');
        if (entry.name.startsWith('__MACOSX/')) continue;
        const dest = safeJoin(stagingDir, entry.name);
        if (!dest) {
          throw new Error(`非法 zip entry 路径：${entry.name}`);
        }
        if (entry.dir) {
          await fs.promises.mkdir(dest, { recursive: true });
          continue;
        }
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        const buf = await entry.async('nodebuffer');
        totalUncompressedBytes += buf.byteLength;
        if (totalUncompressedBytes > MAX_SKILL_UNCOMPRESSED) {
          throw new Error(`zip 解压后大小超过上限：${MAX_SKILL_UNCOMPRESSED} bytes`);
        }
        await fs.promises.writeFile(dest, buf);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 尝试清理 staging
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      const code: InstallErrorCode = message === 'CANCELLED' ? 'CANCELLED' : 'EXTRACT_FAILED';
      onProgress({ phase: 'failed', name: p.name, errorCode: code, message });
      return { success: false, errorCode: code, message };
    }

    if (checkAbort()) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      return { success: false, errorCode: 'CANCELLED', message: '已取消' };
    }

    // 6) final switch: staging → final。只有此时才移动/删除旧目录。
    const rollbackState: FinalSwitchRollbackState = {
      backupDir: null,
      finalDirCreated: false,
    };
    try {
      if (await pathExists(finalDir)) {
        const replaceDir = path.join(path.dirname(finalDir), `.xdt-replacing-${p.name}-${rand()}`);
        await fs.promises.rename(finalDir, replaceDir);
        rollbackState.backupDir = replaceDir;
        try {
          await fs.promises.rename(stagingDir, finalDir);
          rollbackState.finalDirCreated = true;
        } catch (err) {
          await rollbackFinalSwitch(finalDir, rollbackState).catch((restoreErr) => {
            log.error('[skillInstall] restore replaced dir failed:', restoreErr);
          });
          throw err;
        }
      } else {
        await fs.promises.rename(stagingDir, finalDir);
        rollbackState.finalDirCreated = true;
      }
    } catch (err) {
      const prefix = rollbackState.backupDir ? '安装失败，已尝试恢复旧目录' : '安装失败';
      const message = `${prefix}：${err instanceof Error ? err.message : String(err)}`;
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      onProgress({ phase: 'failed', name: p.name, errorCode: 'WRITE_FAILED', message });
      return { success: false, errorCode: 'WRITE_FAILED', message };
    }

    // 7) 同步 registry
    onProgress({ phase: 'registering', name: p.name });

    // 拉 hub 元数据 — 落盘 authorId 给渲染层兜底用（离线 fallback）。
    // isMine=true 时存当前 userId（与 renderer 的 currentUserId 同命名空间），
    // 否则存 slug（不会与 currentUserId 匹配 → 正确识别为 foreign）。
    let authorId = '';
    try {
      const resp = await serverApiFetch<{
        items: Array<{ slug: string; owner: { slug: string }; isMine: boolean }>;
        availableCount?: number;
      }>('/api/skills-hub/skills/batch-detail', {
        method: 'POST',
        body: { slugs: [p.name] },
      });
      const matched = resp.items?.find((i) => i.slug === p.name);
      authorId = matched?.isMine ? userId : (matched?.owner.slug ?? '');
    } catch (err) {
      log.warn('[skillInstall] batch-detail after install warn:', err);
    }

    const folderHash = (await computeFolderHash(finalDir).catch(() => null)) ?? '';
    const nowSec = Math.floor(Date.now() / 1000);
    const versionStr = downloadVersion || info.fileHash.slice(0, 8);
    const existingRegistryEntry = await Promise.resolve(registryService.getInstall(p.name, finalDir)).catch(() => null);
    const previousRegistryEntry = rollbackState.backupDir ? existingRegistryEntry : null;
    const nextAutoSynced = p.autoSync === true
      ? true
      : existingRegistryEntry
        ? existingRegistryEntry.autoSynced
        : false;

    try {
      await registryService.addInstall(p.name, finalDir, {
        version: versionStr,
        authorId,
        folderHash,
        installedAt: nowSec,
        updatedAt: nowSec,
        origin: 'installed',
        autoSynced: nextAutoSynced,
      });
    } catch (err) {
      log.error('[skillInstall] registry.addInstall failed:', err);
      const registryMessage = err instanceof Error ? err.message : String(err);
      let message = `注册失败，已回滚安装文件：${registryMessage}`;
      try {
        await rollbackFinalSwitch(finalDir, rollbackState);
      } catch (restoreErr) {
        message = `注册失败，且安装文件回滚失败：${registryMessage}；回滚错误：${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`;
        log.error('[skillInstall] rollback after registry.addInstall failed:', restoreErr);
      }
      onProgress({ phase: 'failed', name: p.name, errorCode: 'WRITE_FAILED', message });
      return { success: false, errorCode: 'WRITE_FAILED', message };
    }

    let replacedBackupPath: string | undefined;
    if (rollbackState.backupDir) {
      if (p.skipBackup) {
        await fs.promises.rm(rollbackState.backupDir, { recursive: true, force: true }).catch((cleanupErr) => {
          log.warn('[skillInstall] cleanup replaced dir failed:', cleanupErr);
        });
      } else {
        try {
          replacedBackupPath = await movePersistentBackup(rollbackState.backupDir, p.name);
        } catch (backupErr) {
          log.warn('[skillInstall] move persistent backup failed:', backupErr);
          const backupMessage = backupErr instanceof Error ? backupErr.message : String(backupErr);
          let message = `备份旧目录失败，已回滚安装文件：${backupMessage}`;
          let fileRollbackFailed = false;
          try {
            await rollbackFinalSwitch(finalDir, rollbackState);
          } catch (restoreErr) {
            fileRollbackFailed = true;
            message = `备份旧目录失败，且安装文件回滚失败：${backupMessage}；回滚错误：${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`;
            log.error('[skillInstall] rollback after backup move failed:', restoreErr);
          }
          try {
            await restoreRegistryAfterFinalSwitchRollback(p.name, finalDir, previousRegistryEntry);
          } catch (restoreErr) {
            message = fileRollbackFailed
              ? `备份旧目录失败，且安装文件 / registry 回滚失败：${backupMessage}；registry 错误：${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`
              : `备份旧目录失败，已回滚安装文件，但 registry 回滚失败：${backupMessage}；registry 错误：${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`;
            log.error('[skillInstall] registry rollback after backup move failed:', restoreErr);
          }
          onProgress({ phase: 'failed', name: p.name, errorCode: 'WRITE_FAILED', message });
          return { success: false, errorCode: 'WRITE_FAILED', message };
        }
      }
      rollbackState.backupDir = null;
    }

    if (p.autoSync !== true) {
      await clearIgnoredAutoSyncSkill(p.name, userId).catch((err) => {
        log.warn('[skillInstall] clear auto-sync ignore failed:', err);
      });
    }

    // best-effort: 创建 Claude 侧 symlink（Claude Code 只扫 .claude/skills/）
    // 自定义 installPath 场景不建 link — 无法可靠推导对应的 .claude/skills/ 位置
    if (!p.installPath) {
      const claudeLink = path.join(os.homedir(), '.claude', 'skills', p.name);
      try {
        await ensureSymlinkToShared(claudeLink, finalDir);
      } catch (err) {
        log.warn('[skillInstall] claude symlink failed (non-fatal):', claudeLink, err);
      }
    }
    try {
      const linkResult = await prepareSharedGlobalSkillLinks();
      for (const warning of linkResult.warnings) {
        log.warn('[skillInstall] shared global skill link warning:', warning);
      }
    } catch (err) {
      log.warn('[skillInstall] prepare shared global skill links failed:', err);
    }

    onProgress({ phase: 'done', name: p.name, version: versionStr, absolutePath: finalDir });
    return {
      success: true,
      name: p.name,
      version: versionStr,
      absolutePath: finalDir,
      ...(replacedBackupPath ? { replacedBackupPath } : {}),
    };
  } finally {
    inflight.delete(p.name);
    releaseLock();
  }
}

// ── uninstall ───────────────────────────────────────────────────────────────

/**
 * 卸载一个 skill。
 *
 * 防御：absolutePath 必须落在 `/.claude/skills/<name>` 格式下 —— 拒绝删除任意路径。
 * UI 层（F-UI-4）在按钮分流时已确保"未注册的本地技能"不显示卸载按钮，这层是双保险。
 */
export async function uninstall(
  absolutePath: string,
): Promise<{ success: true } | { success: false; errorCode: InstallErrorCode; message: string }> {
  const userId = getCurrentUserId();
  if (!userId) {
    return { success: false, errorCode: 'AUTH_REQUIRED', message: '未登录' };
  }

  // 防御：resolve 后验证路径是精确的 skill 根目录（只允许一层 slug，防 traversal）
  let resolved: string;
  try {
    resolved = fs.realpathSync(absolutePath);
  } catch {
    resolved = path.resolve(absolutePath);
  }
  const normResolved = resolved.replace(/\\/g, '/');
  // 必须匹配 <prefix>/.{claude,agents,codex}/skills/<slug> 形式，slug 不含 /
  if (!/\/(\.(claude|agents|codex)\/skills|codex-home\/skills(\/\.system)?)\/[^/]+$/.test(normResolved)) {
    return { success: false, errorCode: 'INTERNAL', message: 'absolutePath 不在合法 skill 目录下' };
  }

  // 推导 skillName（目录最后一段）
  const skillName = path.basename(resolved);

  // 共享安装锁:同名 install / learn apply 的 final-switch 进行中时拒绝删除,
  // 避免 rm 掉对方刚切入的目录、registry 写入交错。
  const releaseLock = tryAcquireSkillInstallLock(skillName, 'market-uninstall');
  if (!releaseLock) {
    return { success: false, errorCode: 'INTERNAL', message: skillLockBusyMessage(skillName) };
  }
  try {
    return await uninstallLocked(absolutePath, resolved, skillName, userId);
  } finally {
    releaseLock();
  }
}

/** uninstall 的持锁主体（锁获取/释放在 uninstall 外壳完成）。 */
async function uninstallLocked(
  absolutePath: string,
  resolved: string,
  skillName: string,
  userId: string,
): Promise<{ success: true } | { success: false; errorCode: InstallErrorCode; message: string }> {
  // 额外校验：registry 中必须有匹配记录，防止删除未注册的用户手写目录
  let registryEntry = await registryService.getInstall(skillName, resolved).catch(() => null);
  if (!registryEntry) {
    // 尝试用原始路径兜底（registry 可能存的是 symlink 路径而非 realpath）
    const fallback = await registryService.getInstall(skillName, absolutePath).catch(() => null);
    if (!fallback) {
      return { success: false, errorCode: 'INTERNAL', message: '该 skill 无安装记录，拒绝删除' };
    }
    registryEntry = fallback;
  }

  if (!(await pathExists(resolved))) {
    // 目录已经不在 → 静默成功，顺便清 registry 残留
    await registryService.removeInstall(skillName, absolutePath).catch(() => {});
    if (await shouldRecordAutoSyncIgnore(skillName, registryEntry, userId)) {
      await ignoreAutoSyncSkill(skillName, userId).catch((err) => {
        log.warn('[skillInstall] record auto-sync ignore failed:', err);
      });
    }
    return { success: true };
  }

  try {
    await fs.promises.rm(resolved, { recursive: true, force: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, errorCode: 'WRITE_FAILED', message };
  }

  // 如果原始路径是 symlink 指向已删目录，也一并清掉
  if (resolved !== path.resolve(absolutePath)) {
    await fs.promises.unlink(absolutePath).catch(() => {});
  }

  // 删 registry 条目。失败仅 warn，因为文件已删，scanner 会孤儿清理。
  try {
    await registryService.removeInstall(skillName, absolutePath);
  } catch (err) {
    log.warn('[skillInstall] uninstall registry.removeInstall failed:', err);
  }

  if (await shouldRecordAutoSyncIgnore(skillName, registryEntry, userId)) {
    await ignoreAutoSyncSkill(skillName, userId).catch((err) => {
      log.warn('[skillInstall] record auto-sync ignore failed:', err);
    });
  }

  // best-effort: 清理指向已删目录的 symlink（canonical + agent-link 场景）
  const candidates = [
    path.join(os.homedir(), '.claude', 'skills', skillName),
    path.join(os.homedir(), '.codex', 'skills', skillName),
    path.join(os.homedir(), '.agents', 'skills', skillName),
  ].filter((c) => c !== path.normalize(absolutePath) && c !== resolved);
  for (const c of candidates) {
    try {
      const st = await fs.promises.lstat(c);
      if (st.isSymbolicLink()) {
        const linkTarget = path.resolve(path.dirname(c), await fs.promises.readlink(c));
        if (!(await pathExists(linkTarget))) {
          await fs.promises.unlink(c);
        }
      }
    } catch { /* ignore */ }
  }

  return { success: true };
}

async function shouldRecordAutoSyncIgnore(skillName: string, registryEntry: StoredInstall, userId: string): Promise<boolean> {
  if (registryEntry.autoSynced === true) return true;
  if (registryEntry.origin !== 'installed' || registryEntry.autoSynced !== undefined) return false;
  // 兼容 auto-sync 首版：当时 registry 没有 autoSynced 字段，候选集合来自最近一次 auto-sync 配置。
  if (await isKnownAutoSyncCandidateSkill(skillName, userId).catch(() => false)) return true;
  return FALLBACK_LEGACY_AUTO_SYNC_SKILLS.has(skillName);
}
