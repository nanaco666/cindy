#!/usr/bin/env node
// prepare.mjs — review-pr「环境与上下文准备」(只读 + 锁获取)
//
// 输出 repo 坐标 / gh 登录态 / working tree 是否干净 / 当前分支 / 默认分支 / 锁状态。
// 不做任何决策:LLM 读这些字段后自己判断(未登录 → 让用户 gh auth login;
// 脏 working tree → 提示用户处理,不自动 stash;locked → 退出)。
//
// 互斥锁:防止多个 review-pr 实例(scheduler 定时 + 手动)同时跑。
// 锁文件位于 scripts/review-pr/.lock,内容为 JSON `{startedAt}`;获取用 flag:'wx'
// 原子独占创建,同一 checkout 内两个实例同毫秒启动也只有一个能拿到。
// 注意锁是 per-checkout 的:另一个 checkout / worktree / 机器上的实例看不到这把锁。
// stale 判定:**纯 TTL**——超过 60 分钟未释放判 stale,强制清除后重新获取。
// 不做 PID 存活判定:本脚本自身秒退,写自己的 PID 进锁文件毫无意义(下一轮
// `kill(pid, 0)` 永远 ESRCH → 永远判 stale → 锁形同虚设,2026-07 实锤);
// 而长命的持有者是上层 agent 进程,脚本拿不到它的 PID(父 shell 同样秒退)。
// TTL 60 分钟按 auto 批处理单轮上限(约 40 分钟)留了余量;代价是异常崩溃后
// 最多阻塞下一轮一小时,scheduler 会自动重试,可接受。
// 释放路径:cleanup.mjs(走完整清理) 或 release-lock.mjs(早退/异常路径)。
//
// 兼容旧格式:历史锁文件可能是 `{pid, startedAt}` JSON 或裸 ISO 时间戳,
// 一律只取 startedAt 做 TTL 判定;完全解析不出时间的直接判 stale(防死锁)。
//
// 跑:node scripts/review-pr/prepare.mjs

import { parseRepo, git, gh, print, fail } from './lib.mjs';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOCK_FILE = join(SCRIPT_DIR, '.lock');
const LOCK_TTL_MS = 60 * 60 * 1000; // 60 minutes

/** 取锁文件里的 startedAt(ms);兼容 {startedAt}/{pid,startedAt} JSON 与裸 ISO,解析失败返回 null。 */
function parseLockStartedAt(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const t = new Date(JSON.parse(trimmed).startedAt).getTime();
      return isNaN(t) ? null : t;
    } catch {
      return null;
    }
  }
  const t = new Date(trimmed).getTime();
  return isNaN(t) ? null : t;
}

const TAKEOVER_FILE = LOCK_FILE + '.takeover';
const TAKEOVER_TTL_MS = 60 * 1000; // 接管锁正常只持有毫秒级,60s 足够覆盖进程死在中间的自愈

/** 删除文件,不存在时静默(并发下别人可能已抢先删)。 */
function tryUnlink(file) {
  try {
    unlinkSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

/** 读主锁当前内容;不存在返回 {present:false}。 */
function readLock() {
  let raw;
  try {
    raw = readFileSync(LOCK_FILE, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return { present: false, raw: null, startedAt: null };
  }
  return { present: true, raw, startedAt: parseLockStartedAt(raw) };
}

/** 以 flag:'wx' 原子独占创建主锁;成功返回 true,已存在返回 false。 */
function tryCreateLock(payload) {
  try {
    writeFileSync(LOCK_FILE, payload, { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return false;
  }
}

function acquireLock() {
  const payload = JSON.stringify({ startedAt: new Date().toISOString() });

  // 快路径:原子独占创建。内核保证并发下只有一个实例 create 成功,
  // 消除旧实现 existsSync→write 的检查-写入竞态。
  if (tryCreateLock(payload)) return { acquired: true, stale: false, holder: null };

  const cur = readLock();
  if (!cur.present) {
    // 读的瞬间刚被持有者释放 → 再试一次;仍失败说明有人同时抢到,让锁
    if (tryCreateLock(payload)) return { acquired: true, stale: false, holder: null };
    return { acquired: false, stale: false, holder: null };
  }
  // 解析不出时间(损坏/未知格式)→ 判 stale,防止永久死锁
  const isStale = cur.startedAt == null || Date.now() - cur.startedAt >= LOCK_TTL_MS;
  if (!isStale) {
    return {
      acquired: false,
      stale: false,
      holder: cur.raw.trim(),
      holderStartedAt: new Date(cur.startedAt).toISOString(),
    };
  }

  // stale 接管走两段式:先独占"接管锁",再复核主锁、清除、重建。
  // 不能直接 unlink+create——两个实例同时判 stale 时,后动手的会把先动手的
  // 刚写入的新锁误删掉,变成双持有(并发实测踩过)。
  const takeover = (() => {
    try {
      const raw = readFileSync(TAKEOVER_FILE, 'utf8');
      const startedAt = parseLockStartedAt(raw);
      if (startedAt != null && Date.now() - startedAt < TAKEOVER_TTL_MS) return false; // 别人正在接管
      tryUnlink(TAKEOVER_FILE); // 接管锁本身 stale(进程死在中间)→ 清掉再抢
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    try {
      writeFileSync(TAKEOVER_FILE, payload, { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      return false;
    }
  })();
  if (!takeover) return { acquired: false, stale: true, holder: cur.raw.trim() };

  try {
    // 持有接管锁后复核:主锁可能已被别的实例接管重建(变新),那就不是我们的了
    const again = readLock();
    if (again.present) {
      const stillStale = again.startedAt == null || Date.now() - again.startedAt >= LOCK_TTL_MS;
      if (!stillStale) {
        return {
          acquired: false,
          stale: false,
          holder: again.raw.trim(),
          holderStartedAt: new Date(again.startedAt).toISOString(),
        };
      }
      tryUnlink(LOCK_FILE);
    }
    // 空档期可能被快路径的新实例抢先 create,抢不到就让锁
    if (tryCreateLock(payload)) return { acquired: true, stale: true, holder: null };
    return { acquired: false, stale: false, holder: null };
  } finally {
    tryUnlink(TAKEOVER_FILE);
  }
}

try {
  const lock = acquireLock();

  const repo = parseRepo();
  const ghAuth = gh(['auth', 'status'], { allowFail: true }).ok;
  const porcelain = git(['status', '--porcelain']).stdout.trim();
  const worktreeClean = porcelain === '';
  const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();

  // 默认分支:origin/HEAD → refs/remotes/origin/<branch>;解析不到兜底 main
  let defaultBranch = 'main';
  const sym = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (sym.ok && sym.stdout.trim()) {
    defaultBranch = sym.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
  }

  print({
    ok: true,
    lock,
    repo,
    ghAuth,
    worktreeClean,
    dirtyFiles: worktreeClean ? [] : porcelain.split('\n'),
    currentBranch,
    defaultBranch,
  });
} catch (e) {
  fail(e);
}
