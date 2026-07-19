/**
 * passiveDevLock.ts — passive dev 实例的跨进程互斥锁。
 *
 * Electron single-instance lock 在 passive 模式下必须让位给正式版，因此这里用
 * userData 内的独占文件补回「passive dev 之间只能有一个」的约束。创建走 `wx`
 * 原子排他；锁记录带 PID + owner token，异常退出后可安全接管，释放时也不会删除
 * 已经易主的新锁。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_INVALID_LOCK_GRACE_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_ACQUIRE_ATTEMPTS = 8;

interface PassiveDevLockRecord {
  pid: number;
  startedAtMs: number;
  ownerToken: string;
}

interface LockSnapshot {
  raw: string;
  record: PassiveDevLockRecord | null;
  mtimeMs: number;
  ino: number | bigint;
}

/** 锁被本进程释放后的结果；not-owner 表示文件已被替换，绝不能删除。 */
export type PassiveDevLockReleaseResult =
  | { released: true }
  | {
      released: false;
      reason: 'already-released' | 'missing' | 'not-owner' | 'error';
      error?: string;
    };

/** 成功持锁后的句柄。调用 release 会停掉 heartbeat 并按 owner token 原子释放。 */
export interface PassiveDevLockHandle {
  readonly ownerToken: string;
  release(): PassiveDevLockReleaseResult;
}

/** acquire 的判别联合；任何意外 IO 错误都 fail-closed 返回 error。 */
export type PassiveDevLockAcquireResult =
  | { acquired: true; lock: PassiveDevLockHandle }
  | { acquired: false; reason: 'occupied'; ownerPid?: number }
  | { acquired: false; reason: 'error'; error: string };

/** 依赖可注入，便于不碰真实进程的单元测试覆盖 stale / 权限错误分支。 */
export interface AcquirePassiveDevLockOptions {
  lockPath: string;
  pid?: number;
  startedAtMs?: number;
  ownerToken?: string;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
  invalidLockGraceMs?: number;
  heartbeatIntervalMs?: number;
  onCompromised?: (reason: string) => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function parseRecord(raw: string): PassiveDevLockRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<PassiveDevLockRecord>;
    if (
      !Number.isInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      !Number.isFinite(value.startedAtMs) ||
      (value.startedAtMs ?? 0) <= 0 ||
      typeof value.ownerToken !== 'string' ||
      value.ownerToken.length === 0
    ) {
      return null;
    }
    return {
      pid: value.pid as number,
      startedAtMs: value.startedAtMs as number,
      ownerToken: value.ownerToken,
    };
  } catch {
    return null;
  }
}

function readSnapshot(
  lockPath: string,
): { ok: true; snapshot: LockSnapshot } | { ok: false; missing: boolean; error?: string } {
  let fd: number | null = null;
  try {
    fd = fs.openSync(lockPath, 'r');
    const raw = fs.readFileSync(fd, 'utf8');
    const stat = fs.fstatSync(fd, { bigint: true });
    return {
      ok: true,
      snapshot: {
        raw,
        record: parseRecord(raw),
        mtimeMs: Number(stat.mtimeMs),
        ino: stat.ino,
      },
    };
  } catch (error) {
    return {
      ok: false,
      missing: errorCode(error) === 'ENOENT',
      ...(errorCode(error) === 'ENOENT' ? {} : { error: errorText(error) }),
    };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // 关闭只读快照失败不改变锁判定；后续 IO 仍会 fail-closed。
      }
    }
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // 只有 ESRCH 能证明进程不存在；EPERM / 未知错误必须按仍存活处理。
    return errorCode(error) !== 'ESRCH';
  }
}

type ClaimResult = { kind: 'removed' } | { kind: 'retry' } | { kind: 'error'; error: string };

/**
 * 把待回收文件先原子 rename 到唯一 tomb，再在独占对象上比较快照。这样两个接管者
 * 不会用「读旧锁 → unlink 新 owner」的 TOCTOU 窗口误删刚创建的健康锁。
 */
function claimAndRemove(lockPath: string, observed: LockSnapshot): ClaimResult {
  const tombPath = path.join(
    path.dirname(lockPath),
    `.${path.basename(lockPath)}.stale-${process.pid}-${randomUUID()}`,
  );
  try {
    fs.renameSync(lockPath, tombPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'retry' };
    return { kind: 'error', error: errorText(error) };
  }

  const claimed = readSnapshot(tombPath);
  const sameObject =
    claimed.ok &&
    claimed.snapshot.raw === observed.raw &&
    claimed.snapshot.mtimeMs === observed.mtimeMs &&
    claimed.snapshot.ino === observed.ino;
  if (!sameObject) {
    try {
      // link 的目标创建具有 O_EXCL 语义：canonical 已被新 owner 创建时只会
      // EEXIST，绝不能像 POSIX rename 那样无声覆盖竞争者的新锁。
      fs.linkSync(tombPath, lockPath);
      fs.unlinkSync(tombPath);
      return { kind: 'retry' };
    } catch (error) {
      return {
        kind: 'error',
        error: `lock changed during stale claim and rollback failed: ${errorText(error)}`,
      };
    }
  }

  try {
    fs.unlinkSync(tombPath);
    return { kind: 'removed' };
  } catch (error) {
    return { kind: 'error', error: errorText(error) };
  }
}

/** 原子获取 userData 下的 passive dev 锁。 */
export function acquirePassiveDevLock(
  options: AcquirePassiveDevLockOptions,
): PassiveDevLockAcquireResult {
  const pid = options.pid ?? process.pid;
  const startedAtMs = options.startedAtMs ?? Date.now();
  const ownerToken = options.ownerToken ?? randomUUID();
  const now = options.now ?? Date.now;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const invalidLockGraceMs = options.invalidLockGraceMs ?? DEFAULT_INVALID_LOCK_GRACE_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const record: PassiveDevLockRecord = { pid, startedAtMs, ownerToken };
  const encoded = `${JSON.stringify(record)}\n`;

  try {
    fs.mkdirSync(path.dirname(options.lockPath), { recursive: true });
  } catch (error) {
    return { acquired: false, reason: 'error', error: errorText(error) };
  }

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    let fd: number | null = null;
    let created = false;
    let createdIno: bigint | null = null;
    try {
      // O_EXCL / CREATE_NEW 是真正的跨进程互斥点。
      fd = fs.openSync(options.lockPath, 'wx', 0o600);
      created = true;
      createdIno = fs.fstatSync(fd, { bigint: true }).ino;
      fs.writeFileSync(fd, encoded, 'utf8');
      fs.fsyncSync(fd);
    } catch (error) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // 下方清理创建失败的文件。
        }
        fd = null;
      }
      if (errorCode(error) !== 'EEXIST') {
        if (created && createdIno !== null) {
          const failedWrite = readSnapshot(options.lockPath);
          if (failedWrite.ok && failedWrite.snapshot.ino === createdIno) {
            // 不能按路径直接 unlink：写失败后 canonical 理论上可能已经易主。
            // 先 claim + inode/raw compare，只删除本次 create 的那个对象。
            claimAndRemove(options.lockPath, failedWrite.snapshot);
          }
        }
        return { acquired: false, reason: 'error', error: errorText(error) };
      }

      const existing = readSnapshot(options.lockPath);
      if (!existing.ok) {
        if (existing.missing) continue;
        return { acquired: false, reason: 'error', error: existing.error ?? 'lock unreadable' };
      }
      const ageMs = Math.max(0, now() - existing.snapshot.mtimeMs);
      const existingRecord = existing.snapshot.record;
      if (existingRecord === null) {
        // create('wx') 成功但 owner 尚未 write 的极短窗口会看到空文件；近期非法锁
        // 必须 fail-closed，不能当 stale 删除。
        if (ageMs <= invalidLockGraceMs) {
          return { acquired: false, reason: 'occupied' };
        }
      } else {
        let alive = true;
        try {
          alive = isProcessAlive(existingRecord.pid);
        } catch {
          alive = true;
        }
        // 安全优先：只要 PID 存活或状态未知就永不接管。调试器暂停、系统休眠或
        // event loop 卡顿都可能让 heartbeat 任意久不更新；把 lease 到期当死亡会
        // 重新引入两个 SQLite writer。PID reuse 宁可 fail-closed。
        if (alive) {
          return { acquired: false, reason: 'occupied', ownerPid: existingRecord.pid };
        }
      }

      const claim = claimAndRemove(options.lockPath, existing.snapshot);
      if (claim.kind === 'error') {
        return { acquired: false, reason: 'error', error: claim.error };
      }
      continue;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // 已 fsync 的 owner 记录仍可被后续快照验证。
        }
      }
    }

    // 上面的 try 成功时会落到这里；再次读回 owner token，防 stale 接管者在创建
    // 窗口中抢走锁后本进程仍误判自己持有。
    const verify = readSnapshot(options.lockPath);
    if (!verify.ok || verify.snapshot.record?.ownerToken !== ownerToken) {
      return { acquired: false, reason: 'occupied' };
    }

    let released = false;
    let compromised = false;
    let heartbeat: NodeJS.Timeout | null = null;

    const markCompromised = (reason: string): void => {
      if (compromised || released) return;
      compromised = true;
      if (heartbeat !== null) clearInterval(heartbeat);
      heartbeat = null;
      options.onCompromised?.(reason);
    };

    if (heartbeatIntervalMs > 0) {
      heartbeat = setInterval(() => {
        let heartbeatFd: number | null = null;
        try {
          heartbeatFd = fs.openSync(options.lockPath, 'r+');
          const raw = fs.readFileSync(heartbeatFd, 'utf8');
          if (parseRecord(raw)?.ownerToken !== ownerToken) {
            markCompromised('owner token changed');
            return;
          }
          const timestamp = new Date(now());
          fs.futimesSync(heartbeatFd, timestamp, timestamp);
        } catch (error) {
          markCompromised(`heartbeat failed: ${errorText(error)}`);
        } finally {
          if (heartbeatFd !== null) {
            try {
              fs.closeSync(heartbeatFd);
            } catch {
              // 下一次 heartbeat 会重新校验；不单独改变归属。
            }
          }
        }
      }, heartbeatIntervalMs);
      heartbeat.unref?.();
    }

    const lock: PassiveDevLockHandle = {
      ownerToken,
      release(): PassiveDevLockReleaseResult {
        if (released) return { released: false, reason: 'already-released' };
        released = true;
        if (heartbeat !== null) clearInterval(heartbeat);
        heartbeat = null;
        if (compromised) return { released: false, reason: 'not-owner' };

        const current = readSnapshot(options.lockPath);
        if (!current.ok) {
          return current.missing
            ? { released: false, reason: 'missing' }
            : { released: false, reason: 'error', error: current.error ?? 'lock unreadable' };
        }
        if (current.snapshot.record?.ownerToken !== ownerToken) {
          return { released: false, reason: 'not-owner' };
        }
        const claim = claimAndRemove(options.lockPath, current.snapshot);
        if (claim.kind === 'removed') return { released: true };
        if (claim.kind === 'retry') return { released: false, reason: 'not-owner' };
        return { released: false, reason: 'error', error: claim.error };
      },
    };
    return { acquired: true, lock };
  }

  return { acquired: false, reason: 'error', error: 'passive dev lock contention did not settle' };
}
