/**
 * 定时任务「前置检查跳过」留痕:hook exit 2 拦截本轮时,不 spawn 任何 agent,
 * 直接向 localDb 写一条合成的 assistant 消息,让用户在会话消息流里看到
 * 「本轮已跳过」——零模型调用、零 token。
 *
 * 承载会话的选择(避免高频任务每次跳过都新建会话刷屏侧边栏):
 *   1. schedule.targetSessionId(heartbeat / persistentSession 已绑定)且行仍
 *      active → 直接追加进绑定会话,跳过记录与真实运行穿插在同一时间线。
 *   2. schedule.skipLogSessionId(上次跳过创建的专属留痕会话)且行仍 active → 复用。
 *   3. 都没有 → 新建一个 source='scheduler' 的会话行(纯 DB 行,无 agent 进程),
 *      并把 id 回写到 schedule.skipLogSessionId 供后续复用。
 *
 * 全程 fail-soft:留痕失败只记日志,绝不让 skip 流程升级成 failed run。
 */

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import type { Schedule, Logger } from '@lizi/maker-scheduler';

import { sessions } from '../localDb/schema';
import { sessionCreateToRow } from '../localDb/mapper';
import { createMessage } from '../localDb/ipc/messages.js';
import { getSessionRowSnapshot } from '../localDb/ipc/sessions.js';
import type { SchedulerDrizzleDb } from './storage';
import type { PreRunHookResult } from './pre-run-hook';

export interface SkipTraceDeps {
  getDb: () => SchedulerDrizzleDb;
  logger: Logger;
  /** 新建留痕会话后回写 schedule.skipLogSessionId(经 scheduler.update)。 */
  bindSkipLogSession: (scheduleId: string, sessionId: string) => Promise<void>;
  /**
   * 会话当前正在跑 turn(用户远程控制 / 上轮心跳未完)。busy 的候选不写合成
   * 消息——把「已跳过」插进一场正在直播的对话既打扰用户,也会与流式消息穿插
   * 错乱;回落到专属留痕会话(skipLogSessionId)。未注入时不做该判定。
   */
  isSessionBusy?: (sessionId: string) => boolean;
}

/** run 记录 resultText 用的一行摘要(运行历史列表展示)。 */
export function buildSkipResultText(hook: PreRunHookResult): string {
  const head = `pre-run hook exit ${hook.exitCode ?? '?'} · ${hook.durationMs}ms`;
  const out = hook.stdout.trim();
  return out ? `${head} — ${firstLine(out)}` : head;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * 会话消息流里的合成消息正文(markdown;存储数据而非 UI chrome,不走 i18n——
 * 消息一旦落库无法随语言切换重译,headline 采用中英双语让非中文用户也能读懂)。
 */
function buildSkipMessageContent(schedule: Schedule, hook: PreRunHookResult): string {
  const lines = [
    `⏭️ 前置检查未放行，本轮已跳过 / Pre-run check blocked this round（exit ${hook.exitCode ?? '?'} · ${hook.durationMs}ms）`,
  ];
  const out = hook.stdout.trim() || hook.stderr.trim();
  if (out) {
    const capped = out.length > 2000 ? `${out.slice(0, 2000)}…` : out;
    lines.push('', '```', `$ ${schedule.preRunHook?.command ?? ''}`, capped, '```');
  }
  return lines.join('\n');
}

/**
 * 解析 / 创建承载会话并写入跳过消息。返回承载会话 id;完全失败返回 undefined
 * (调用方照常返回 skipped FireResult,只是没有可打开的会话)。
 */
export async function recordScheduleSkip(
  deps: SkipTraceDeps,
  schedule: Schedule,
  ctx: { runId: string; firedAt: number },
  hook: PreRunHookResult,
): Promise<string | undefined> {
  try {
    const sessionId = await resolveTraceSession(deps, schedule);
    if (!sessionId) return undefined;
    await createMessage(sessionId, {
      clientId: randomUUID(),
      role: 'assistant',
      content: buildSkipMessageContent(schedule, hook),
      agentMeta: {
        origin: {
          kind: 'scheduler',
          scheduleId: schedule.id,
          scheduleName: schedule.name,
        },
        scheduleSkip: {
          scheduleId: schedule.id,
          runId: ctx.runId,
          exitCode: hook.exitCode,
          durationMs: hook.durationMs,
        },
      },
    });
    // bump updatedAt 让侧边栏时间轴前移(createMessage 不动 sessions 行)。
    const now = Date.now();
    await deps
      .getDb()
      .update(sessions)
      .set({ updatedAt: now })
      .where(eq(sessions.id, sessionId));
    return sessionId;
  } catch (err) {
    deps.logger.warn?.('[skip-trace] record skip failed (non-fatal)', err);
    return undefined;
  }
}

async function resolveTraceSession(
  deps: SkipTraceDeps,
  schedule: Schedule,
): Promise<string | undefined> {
  // 1/2. 已有承载会话仍可用 → 复用(正在 turn 中的跳过:留痕会话是纯 DB 行
  //      永不跑 turn,busy 判定实际只拦 targetSessionId,统一判无副作用)
  for (const candidate of [schedule.targetSessionId, schedule.skipLogSessionId]) {
    if (!candidate) continue;
    if (deps.isSessionBusy?.(candidate)) continue;
    const row = await getSessionRowSnapshot(candidate).catch(() => null);
    if (row && row.status === 'active') return candidate;
  }
  // 3. 新建纯 DB 会话行(无 agent 进程)。标题沿用 runner 的 `[Schedule] name`
  //    约定,侧边栏归入自动化分组(source='scheduler')。
  const id = randomUUID();
  const now = Date.now();
  const baseRow = sessionCreateToRow(
    id,
    {
      workingDir: schedule.workingDir,
      workspaceKind: schedule.workspaceKind,
      agentKind: schedule.agentKind === 'codex' ? 'codex' : 'cc',
      model: schedule.model,
      effort: schedule.effort,
      permissionMode: 'bypassPermissions',
    },
    now,
  );
  await deps.getDb().insert(sessions).values({
    ...baseRow,
    title: `[Schedule] ${schedule.name}`,
    source: 'scheduler',
  });
  try {
    await deps.bindSkipLogSession(schedule.id, id);
  } catch (err) {
    // 绑定失败只影响复用(下次跳过会再建一个),不影响本次留痕
    deps.logger.warn?.('[skip-trace] bind skipLogSessionId failed (non-fatal)', err);
  }
  return id;
}
