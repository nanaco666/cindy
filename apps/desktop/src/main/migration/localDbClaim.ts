/**
 * migration/localDbClaim — Cindy 新账号首次 ensureReady 前认领旧 UID 主库。
 *
 * 认领只在目标库尚不存在、identity anchor 按 email（零命中时 feishuOpenId）唯一命中、且
 * 磁盘上只找到一个候选旧库时执行。源库只读保留；目标经 SQLite online
 * backup + quick_check 写到临时文件，再用同卷 hard-link 原子落位且拒绝覆盖。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  createBetterSqliteDatabase,
  restrictDbFilePermissions,
} from '../localDb/betterSqliteFactory';
import { findAnchorByIdentity, readIdentityAnchor, IDENTITY_ANCHOR_REL_PATH } from './identityAnchor';
import { writeJsonAtomic } from './markerStore';

export interface ClaimLegacyLocalDbArgs {
  userDataDir: string;
  currentDbPrefix: string;
  dbFilePrefixes: readonly string[];
  newUserId: string;
  email: string | null | undefined;
  feishuOpenId?: string | null;
  /** 测试注入口；默认使用 better-sqlite3 online backup + quick_check。 */
  copyDatabase?: (sourcePath: string, temporaryTargetPath: string) => Promise<void>;
  nowIso?: () => string;
}

export type ClaimLegacyLocalDbResult =
  | { status: 'claimed'; oldUserId: string; sourcePath: string; targetPath: string }
  | {
      status: 'skipped';
      reason: 'target-exists' | 'no-unique-anchor' | 'no-source-db' | 'ambiguous-source-db';
    }
  | { status: 'failed'; error: string };

/** 唯一匹配时复制认领旧库；所有模糊情形都 fail closed，不猜账号/文件。 */
export async function claimLegacyLocalDb(
  args: ClaimLegacyLocalDbArgs,
): Promise<ClaimLegacyLocalDbResult> {
  if (!args.newUserId) return { status: 'failed', error: 'invalid target database identity' };
  const targetPath = dbPath(args.userDataDir, args.currentDbPrefix, args.newUserId);
  if (targetPath == null) return { status: 'failed', error: 'invalid target database identity' };
  if (fs.existsSync(targetPath)) return { status: 'skipped', reason: 'target-exists' };

  const anchor = readIdentityAnchor(path.join(args.userDataDir, IDENTITY_ANCHOR_REL_PATH));
  const oldAccount = findAnchorByIdentity(anchor, {
    email: args.email,
    feishuOpenId: args.feishuOpenId,
  }, { excludeUserId: args.newUserId });
  if (oldAccount == null) return { status: 'skipped', reason: 'no-unique-anchor' };

  const prefixes = Array.from(new Set(args.dbFilePrefixes));
  const candidates = prefixes
    .map((prefix) => dbPath(args.userDataDir, prefix, oldAccount.userId))
    .filter((candidate): candidate is string => candidate != null && fs.existsSync(candidate));
  if (candidates.length === 0) return { status: 'skipped', reason: 'no-source-db' };
  if (candidates.length !== 1) return { status: 'skipped', reason: 'ambiguous-source-db' };

  const sourcePath = candidates[0];
  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    return { status: 'skipped', reason: 'target-exists' };
  }

  const temporaryTargetPath = path.join(
    args.userDataDir,
    `.${path.basename(targetPath)}.claim-${process.pid}-${Date.now()}`,
  );
  try {
    await (args.copyDatabase ?? copyDatabaseVerified)(sourcePath, temporaryTargetPath);
    // hard-link 与目标存在检查是同一个原子操作；不会像 POSIX rename 那样覆盖
    // 并发方刚创建的目标库。unlink 临时名后目标拥有独立的最终目录项。
    fs.linkSync(temporaryTargetPath, targetPath);
    fs.unlinkSync(temporaryTargetPath);
    restrictDbFilePermissions(targetPath);
    try {
      writeJsonAtomic(path.join(args.userDataDir, 'migration', `db-claim-${safeId(args.newUserId)}.json`), {
        schemaVersion: 1,
        oldUserId: oldAccount.userId,
        newUserId: args.newUserId,
        sourceFile: path.basename(sourcePath),
        targetFile: path.basename(targetPath),
        claimedAt: (args.nowIso ?? (() => new Date().toISOString()))(),
      });
    } catch {
      // 目标库已完整原子落位，诊断 sentinel 写失败不应把成功认领反报成失败。
    }
    return { status: 'claimed', oldUserId: oldAccount.userId, sourcePath, targetPath };
  } catch (err) {
    try { fs.rmSync(temporaryTargetPath, { force: true }); } catch { /* best-effort */ }
    if ((err as NodeJS.ErrnoException).code === 'EEXIST' && fs.existsSync(targetPath)) {
      return { status: 'skipped', reason: 'target-exists' };
    }
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

function dbPath(userDataDir: string, prefix: string, userId: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(prefix)) return null;
  const root = path.resolve(userDataDir);
  const candidate = path.resolve(root, `${prefix}-${userId}.db`);
  return path.dirname(candidate) === root ? candidate : null;
}

function safeId(userId: string): string {
  return Buffer.from(userId, 'utf8').toString('base64url').slice(0, 48);
}

async function copyDatabaseVerified(sourcePath: string, targetPath: string): Promise<void> {
  const source = createBetterSqliteDatabase(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(targetPath);
  } finally {
    source.close();
  }
  const probe = createBetterSqliteDatabase(targetPath, { readonly: true, fileMustExist: true });
  try {
    const verdict = (probe.pragma('quick_check') as Array<{ quick_check?: string }>)[0]?.quick_check;
    if (verdict !== 'ok') throw new Error(`claimed database quick_check = ${verdict ?? 'unknown'}`);
  } finally {
    probe.close();
  }
}
