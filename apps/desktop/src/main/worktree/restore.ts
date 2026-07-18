/**
 * worktree 恢复（P1，对齐 Codex Desktop 的 snapshot-restore 思路）：
 * 会话的 worktree 被回收后（删除/归档/历史误删），从保留的分支 `xdt/<name>` 重建
 * worktree，并把回收时留下的内容快照（refs/xdt/snapshots/<sessionId>，见 dirty.ts）
 * apply 回去，一键恢复到回收前的状态。
 *
 * 数据来源：sessions.worktree_path（回收时刻意不清，见 worktreeStore.del 注释）。
 * 路径必须能解析为 `<baseRepo>/.cindy-worktrees/<name>` 或历史
 * `<baseRepo>/.xdt-worktrees/<name>` 托管形态，其它一律按 no-worktree
 * 处理——绝不对非托管路径做 git 写操作。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { eq } from 'drizzle-orm';

import {
  clearSnapshotRef,
  getRestorableAutoStashSha,
  getSnapshotSha,
  markSnapshotConsumed,
} from './dirty';
import { gitExec, GitExecError } from './gitExec';
import { applyWorktreeIncludeFile } from './includePatternsEngine';
import { copyClaudeSiviDirs } from './WorktreeManager';
import * as store from './worktreeStore';
import { getDbClient } from '../localDb/client/current';
import { sessions } from '../localDb/schema';
import { createLogger } from '../logger';
import { isManagedWorktreeDirectoryName } from '../../shared/managedWorktreePaths';

import type { WorktreeMeta } from './types';

const log = createLogger('worktreeRestore');

export type WorktreeRestoreStatus =
  /** worktree 目录还在，无需恢复。 */
  | { state: 'present'; worktreePath: string; hasSnapshot?: boolean }
  /** 会话从没有托管 worktree（或路径无法安全解析），无恢复语义。 */
  | { state: 'no-worktree' }
  /** 目录没了但分支还在，可一键重建；hasSnapshot = 回收时是否留了脏内容快照。 */
  | { state: 'restorable'; worktreePath: string; hasSnapshot: boolean }
  /** 分支也没了（或 baseRepo 不存在），产品内无法恢复。 */
  | { state: 'gone'; worktreePath: string };

export interface WorktreeRestoreResult {
  ok: boolean;
  /** ok=true 时：脏内容快照是否成功 apply（无快照时为 true）。 */
  snapshotApplied?: boolean;
  /** ok=false 时的稳定原因；renderer 侧负责 i18n 映射。 */
  reason?: 'gone' | 'no-worktree' | 'git-error';
  /** 诊断细节，不直接展示为用户文案。 */
  detail?: string;
}

interface ParsedManagedPath {
  baseRepo: string;
  name: string;
  branch: string;
}

/** 只认 Cindy 当前或历史托管 worktree 形态；解析失败返回 null。 */
function parseManagedWorktreePath(worktreePath: string): ParsedManagedPath | null {
  try {
    const resolved = path.resolve(worktreePath);
    const parent = path.dirname(resolved);
    if (!isManagedWorktreeDirectoryName(path.basename(parent))) return null;
    const name = path.basename(resolved);
    if (!name) return null;
    return { baseRepo: path.dirname(parent), name, branch: `xdt/${name}` };
  } catch {
    return null;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readSessionWorktreePath(sessionId: string): Promise<string | null> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({ worktreePath: sessions.worktreePath })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  return rows[0]?.worktreePath ?? null;
}

async function branchExists(baseRepo: string, branch: string): Promise<boolean> {
  try {
    const { stdout } = await gitExec(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      baseRepo,
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function addRestoredWorktree(
  baseRepo: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  const addArgs = [
    '-c',
    'core.longpaths=true',
    'worktree',
    'add',
    worktreePath,
    branch,
  ];
  try {
    await gitExec(addArgs, baseRepo);
  } catch (err) {
    if (!(err instanceof GitExecError) || !/filename too long|core\.longpaths/i.test(err.stderr)) {
      throw err;
    }
    await gitExec(['config', '--global', 'core.longpaths', 'true']);
    await gitExec(addArgs, baseRepo);
  }
}

async function findPendingSnapshot(
  baseRepo: string,
  sessionId: string,
  worktreeName: string,
): Promise<{ sha: string; source: 'snapshot' | 'stash' } | null> {
  const snapshotSha = await getSnapshotSha(baseRepo, sessionId);
  if (snapshotSha) return { sha: snapshotSha, source: 'snapshot' };
  const fallbackStashSha = await getRestorableAutoStashSha(baseRepo, sessionId, worktreeName);
  if (fallbackStashSha) return { sha: fallbackStashSha, source: 'stash' };
  return null;
}

async function applyPendingSnapshot(
  baseRepo: string,
  worktreePath: string,
  sessionId: string,
  worktreeName: string,
): Promise<boolean> {
  const pending = await findPendingSnapshot(baseRepo, sessionId, worktreeName);
  if (!pending) return true;
  try {
    // stash-form commit 可直接 apply，不依赖 stash 栈。ref 在成功 apply 后清理：
    // 内容已回到 worktree，后续再次回收如果仍 dirty 会生成新的 snapshot。
    await gitExec(['stash', 'apply', pending.sha], worktreePath);
    if (pending.source === 'snapshot') {
      await clearSnapshotRef(baseRepo, sessionId);
    }
    await markSnapshotConsumed(baseRepo, sessionId, pending.sha);
    return true;
  } catch (err) {
    log.warn(
      `[restore] snapshot apply failed for ${worktreePath} (${pending.sha.slice(0, 12)}):`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

function restoredWorktreeMeta(
  sessionId: string,
  parsed: ParsedManagedPath,
  worktreePath: string,
): WorktreeMeta {
  return {
    sessionId,
    name: parsed.name,
    path: worktreePath,
    baseRepo: parsed.baseRepo,
    branch: parsed.branch,
    // 原始 sourceBranch 在回收时随 store 条目丢失,恢复后以自身分支占位
    // (仅影响 UI 显示,不参与任何 git 操作)。
    sourceBranch: parsed.branch,
    createdAt: new Date().toISOString(),
  };
}

async function finishRestoredWorktree(
  sessionId: string,
  parsed: ParsedManagedPath,
  worktreePath: string,
): Promise<void> {
  await copyClaudeSiviDirs(parsed.baseRepo, worktreePath, {
    overwriteExisting: false,
  }).catch((err) => {
    log.warn(
      `[restore] copy .claude/.sivi failed for ${worktreePath}:`,
      err instanceof Error ? err.message : String(err),
    );
  });
  await applyWorktreeIncludeFile(parsed.baseRepo, worktreePath, {
    overwriteExisting: false,
  }).catch((err) => {
    log.warn(
      `[restore] apply .xdtworktreeinclude failed for ${worktreePath}:`,
      err instanceof Error ? err.message : String(err),
    );
  });
  await store.set(sessionId, restoredWorktreeMeta(sessionId, parsed, worktreePath));
}

/** 查询会话 worktree 的可恢复状态（restore 横幅数据源）。任何异常都归入 no-worktree/gone 保守分支。 */
export async function getWorktreeRestoreStatus(sessionId: string): Promise<WorktreeRestoreStatus> {
  let worktreePath: string | null = null;
  try {
    worktreePath = await readSessionWorktreePath(sessionId);
  } catch (err) {
    log.warn(`[restore] session lookup failed for ${sessionId}:`, err instanceof Error ? err.message : String(err));
    return { state: 'no-worktree' };
  }
  if (!worktreePath) return { state: 'no-worktree' };
  const parsed = parseManagedWorktreePath(worktreePath);
  if (!parsed) return { state: 'no-worktree' };

  if (await pathExists(worktreePath)) {
    const pending = await findPendingSnapshot(parsed.baseRepo, sessionId, parsed.name);
    return { state: 'present', worktreePath, hasSnapshot: pending !== null };
  }
  if (!(await pathExists(parsed.baseRepo))) return { state: 'gone', worktreePath };
  if (!(await branchExists(parsed.baseRepo, parsed.branch))) {
    return { state: 'gone', worktreePath };
  }
  const hasSnapshot = (await findPendingSnapshot(parsed.baseRepo, sessionId, parsed.name)) !== null;
  return { state: 'restorable', worktreePath, hasSnapshot };
}

/**
 * 一键恢复：`git worktree add <path> xdt/<name>` 重建 + apply 内容快照 + 重新登记 store。
 * 快照 apply 失败时保留目录与快照，但移除 store 登记，避免后续回收把新编辑
 * 覆盖到同一个 snapshot ref；重试成功后才恢复本地配置并重新登记。
 */
export async function restoreWorktreeForSession(sessionId: string): Promise<WorktreeRestoreResult> {
  const status = await getWorktreeRestoreStatus(sessionId);
  if (status.state === 'present') {
    const parsed = parseManagedWorktreePath(status.worktreePath);
    if (!parsed) return { ok: true, snapshotApplied: true };
    const snapshotApplied = await applyPendingSnapshot(
      parsed.baseRepo,
      status.worktreePath,
      sessionId,
      parsed.name,
    );
    if (!snapshotApplied) {
      store.del(sessionId);
      return { ok: true, snapshotApplied: false };
    }
    if (!store.get(sessionId)) {
      await finishRestoredWorktree(sessionId, parsed, status.worktreePath);
    }
    return { ok: true, snapshotApplied };
  }
  if (status.state !== 'restorable') {
    return { ok: false, reason: status.state === 'gone' ? 'gone' : 'no-worktree' };
  }
  const parsed = parseManagedWorktreePath(status.worktreePath)!;
  let snapshotApplied: boolean;

  try {
    // 目录被手动删过时 git 元数据可能残留，先 prune 对账再 add。
    await gitExec(['worktree', 'prune'], parsed.baseRepo).catch(() => undefined);
    await addRestoredWorktree(parsed.baseRepo, status.worktreePath, parsed.branch);
    // 快照必须先于本地配置恢复：未跟踪文件可能同时命中 .claude/.sivi 或
    // .xdtworktreeinclude，提前拷贝会让 git stash apply 因目标已存在而失败。
    snapshotApplied = await applyPendingSnapshot(
      parsed.baseRepo,
      status.worktreePath,
      sessionId,
      parsed.name,
    );
    if (!snapshotApplied) {
      store.del(sessionId);
      return { ok: true, snapshotApplied: false };
    }
    await finishRestoredWorktree(sessionId, parsed, status.worktreePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[restore] worktree add failed for ${status.worktreePath}:`, msg);
    return { ok: false, reason: 'git-error', detail: msg };
  }

  log.info(`[restore] worktree restored at ${status.worktreePath} (session ${sessionId}, snapshotApplied=${snapshotApplied})`);
  return { ok: true, snapshotApplied };
}
