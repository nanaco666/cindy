#!/usr/bin/env node
// pre-check.mjs — review-maker-pr 定时任务的前置检查(scheduler pre-run hook,只读)
//
// 被 scheduler 的 preRunHook 引用(command: `node scripts/review-pr/pre-check.mjs`),
// 在 agent 会话创建**之前**由桌面端主进程执行,不属于 skill 流程本身;放在本目录是
// 为了和 pick.mjs / prepare.mjs / lib.mjs 同源共存(复用 gh 封装与锁文件路径)。
//
// 协议(apps/desktop/src/main/scheduler-host/pre-run-hook.ts):
//   exit 2 = 跳过本轮(不创建会话,零 token);exit 0 = 放行;
//   其它退出码 / 超时 → 宿主 fail-open 放行。
//
// 只在「确定没活」时 exit 2:
//   1. review-pr 互斥锁被占(上一轮 auto 还在跑,TTL 60min 内)——对齐 skill auto
//      模式「锁被占 → 静默结束」的既定行为;只读探测,绝不获取 / 释放;
//   2. 仓库完全没有 open PR(连 draft 都没有)——判定与 pick.mjs 同源。⚠️ 只剩 draft 时
//      **不能**直接 skip:被产品/架构门 hold 的 PR 就是 draft,白名单在讨论 issue 里同意后
//      要靠 auto 轮自动放行(product-release.mjs),此时必须走下面的指纹判据而不是一票跳过;
//   3. 空转指纹一致:上轮 auto 扫描结论是「全 skip」(context.mjs --scan-all 落盘的
//      .last-scan.json),且当前 open PR 集合的状态指纹与落盘时逐字节一致(指纹算法与
//      落盘方共用 lib.mjs 的 fetchOpenPrSnapshot/computePrSetFingerprint,单一来源),
//      且落盘的 heldIssues(被 hold PR 的讨论 issue)逐条 updatedAt 未变——白名单同意
//      发生在 issue 上、不改 PR 自身状态,不显式比对 issue 会把「同意 → 自动放行」饿死。
//      即「上轮就没活干,之后又没有任何变化」。本脚本**只比对指纹、绝不重演 auto 分流
//      判定**:判定逻辑双份维护漂移的后果是漏审(不可接受),指纹误敏感的后果只是多跑
//      一轮(方向安全)。
//      强制心跳:state 落盘超过 HEARTBEAT_MS(6h)一律放行——停滞催办(≥24h 阈值)、
//      产品 issue sweep 这些**时间驱动**的动作恰恰在「PR 状态不变」时才触发,纯指纹
//      skip 会把它们饿死;它同时兜底「会话在扫描落盘后、放行动作前挂掉」的极端窗口。
//      ⚠️ 心跳基准只能用 state.savedAt(真 session 内落盘),不能用
//      宿主 stdin 的 lastFinishedAt——skip 轮次也会刷新它(见 pre-run-hook.ts 注释),
//      用它会永久自锁。
// 其余一切情况(有候选且指纹变了 / 无 state、gh 缺失 / 未登录、网络失败、lib.mjs 异常…)
// 一律 exit 0 放行:「查不了」≠「没活」,让会话内 prepare.mjs / pick.mjs 兜底,gh 掉登录
// 等异常仍走 skill 的飞书异常汇总,不能在这里吞成静默 skip。
//
// 会话内的 pick.mjs / prepare.mjs 照旧执行(hook 输出到不了会话,且 hook 通过到会话
// 启动之间 PR 集合可能变化);本脚本只省掉「起一个 agent 会话才发现没活」的空转成本。
// 建议 schedule 配置显式 preRunHook.timeoutMs(如 60000)双保险——宿主协议「未配置 =
// 不限时」,本脚本虽自带 gh 超时,宿主侧超时兜底可防任何意外挂死阻塞该轮 fire
// (超时 = fail-open 放行,不会造成漏审)。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, delimiter } from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..', '..'); // <repo>/scripts/review-pr → <repo>

// Electron 主进程 spawn 出来的环境可能没有 shell profile 的 PATH(Finder 启动的 app),
// gh 常在 Homebrew 路径下;补齐后再跑,补了仍找不到就走 fail-open。
if (process.platform !== 'win32') {
  process.env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin']
    .filter(Boolean)
    .join(delimiter);
}

const LOCK_FILE = join(SCRIPT_DIR, '.lock'); // 与 prepare.mjs 同一把锁
const LOCK_TTL_MS = 60 * 60 * 1000; // 与 prepare.mjs 的 TTL 一致
const HEARTBEAT_MS = 6 * 60 * 60 * 1000; // 指纹 skip 的强制心跳:state 超龄一律放行(见文件头)

/** 把锁文件里的 startedAt 解成 ms。实际写入格式是 JSON {startedAt: ISO 字符串}
 *  (prepare.mjs 写入);兼容 number(ms)与历史裸 ISO。解析不出返 null。 */
function parseStartedAt(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const v = JSON.parse(trimmed).startedAt;
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        const ms = Date.parse(v);
        return Number.isNaN(ms) ? null : ms;
      }
    } catch {
      /* 解析失败 → null */
    }
    return null;
  }
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

/** 锁是否被有效持有。解析不出时间 / 超 TTL = stale = 视为未持有
 *  (放行,由会话内 prepare 清理重取)。 */
function lockHeld() {
  let raw;
  try {
    raw = readFileSync(LOCK_FILE, 'utf8');
  } catch {
    return false; // 锁文件不存在 = 没人在跑
  }
  const startedAt = parseStartedAt(raw);
  if (startedAt == null) return false;
  return Date.now() - startedAt < LOCK_TTL_MS;
}

/** 输出 skip 决策并 exit 2。 */
function skip(reason, extra = {}) {
  process.stdout.write(JSON.stringify({ decision: 'skip', reason, ...extra }) + '\n');
  process.exit(2);
}

try {
  if (lockHeld()) skip('lock-held');

  // 候选判定与 pick.mjs 同源:复用 lib.mjs 的 gh / parseRepo。动态 import——
  // lib.mjs 异常时进 catch 走 fail-open,而不是模块加载期炸成 exit 1。
  process.chdir(REPO_ROOT); // parseRepo 从 cwd 的 git remote 解析 slug
  const { gh, parseRepo, fetchOpenPrSnapshot, computePrSetFingerprint, SCAN_STATE_FILE } =
    await import(new URL('./lib.mjs', import.meta.url));
  const { owner, repo } = parseRepo();
  const raw = JSON.parse(
    gh(
      ['pr', 'list', '--repo', `${owner}/${repo}`, '--state', 'open', '--limit', '100', '--json', 'number,isDraft'],
      { timeoutMs: 30_000 }, // 网络卡死时自己超时进 fail-open,不等宿主树杀
    ).stdout || '[]',
  );
  const candidateCount = raw.filter((p) => !p.isDraft).length;
  // 只有「一个 open PR 都没有」才算确定没活;只剩 draft 时可能有被 hold 待放行的 PR,
  // 交给下面的指纹判据(含 heldIssues 比对)决定 skip 还是 run(文件头第 2 条)。
  if (raw.length === 0) skip('no-candidates');

  // 空转指纹比对(文件头第 3 条):内层独立 try——state 缺失 / 损坏 / 快照拉取失败都只是
  // 放弃这条判据继续放行,不影响外层「有候选 → run」的既有行为。
  try {
    const state = JSON.parse(readFileSync(SCAN_STATE_FILE, 'utf8'));
    if (
      state?.version === 1 && state.allSkip === true && typeof state.fingerprint === 'string' &&
      Array.isArray(state.heldIssues) // 旧格式 state 没有 heldIssues → 无法证明 issue 未变 → 放行
    ) {
      const savedAtMs = Date.parse(state.savedAt);
      if (!Number.isNaN(savedAtMs) && Date.now() - savedAtMs < HEARTBEAT_MS) {
        const fp = computePrSetFingerprint(fetchOpenPrSnapshot({ owner, repo, timeoutMs: 30_000 }));
        // heldIssues 逐条比对 updatedAt:白名单同意留言只动 issue、不动 PR 指纹,必须显式查。
        // 任何一条读不到 / 落盘值缺失 / 时间不一致 → 视为「有变化」放行(fail-open)。
        const heldIssuesUnchanged = state.heldIssues.every((h) => {
          if (!h || typeof h.number !== 'number' || typeof h.updatedAt !== 'string') return false;
          const r = gh(['api', `repos/${owner}/${repo}/issues/${h.number}`], { allowFail: true, timeoutMs: 30_000 });
          if (!r.ok) return false;
          try {
            const cur = Date.parse(JSON.parse(r.stdout || '{}').updated_at ?? '');
            const saved = Date.parse(h.updatedAt);
            return !Number.isNaN(cur) && !Number.isNaN(saved) && cur === saved;
          } catch {
            return false;
          }
        });
        if (fp === state.fingerprint && heldIssuesUnchanged) {
          skip('unchanged-since-last-scan', { savedAt: state.savedAt, candidateCount, heldIssueCount: state.heldIssues.length });
        }
      }
    }
  } catch {
    /* 指纹判据不可用 → 放行(fail-open) */
  }

  process.stdout.write(JSON.stringify({ decision: 'run', candidateCount }) + '\n');
  process.exit(0);
} catch (e) {
  // 任何异常都放行(fail-open):「查不了」≠「没活」。
  console.error(`[pre-check] fail-open: ${e && e.message ? e.message : e}`);
  process.exit(0);
}
