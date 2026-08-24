/**
 * 到点换代 —— 「新的一天,我们从头说起」。
 *
 * 判定在 `shared/botRenewalPolicy.ts`(纯函数,含全部时间边界);这里只负责把判定
 * 接到真实的伙伴数据与既有的换代底座上。
 *
 * ## 触发时机:打开主对话时,不挂后台定时器
 *
 * Hermes 在 IM 消息进来时判定。Cindy 是桌面应用,等价且更自然的时刻是**用户点开
 * 伙伴主对话**的那一下 —— 点开就是要用,正是「新一轮」的起点。
 *
 * 刻意**不**用后台定时器:那会在半夜给每个伙伴凭空建一堆空对话,用户第二天打开
 * 看到的是一排没说过话的新任务。到点了但没人来用,就让它安静待着。
 *
 * ## 换代不是删除
 *
 * 旧对话归档、可读、可搜;新对话继承伙伴的灵魂、记忆与技能,只是不带上一段的
 * 上下文。走的是既有的 `createBotCanonicalSession`,所以 CAS、并发保护、
 * workspace 处置这些一条都不少。
 *
 * ## 一定要说一声
 *
 * Hermes 的默认值曾经是「24 小时空闲 + 每天 4 点」,2026 年 7 月改成了永不换代,
 * 源码注释的原因是用户没料到自己的对话会被清掉。所以换代必须留下痕迹:
 * 写 lifecycle 事件,并让调用方把「我还记得你,只是这一段重新开始」讲给用户听。
 */

import type { BotRenewalReason } from '../../shared/botRenewalPolicy.js';

export interface BotRenewalSnapshot {
  botId: string;
  /** `capabilities_json` 里的 `renewal` 段(可能没有 → 走默认策略)。 */
  renewal: unknown;
  canonicalSessionId: string | null;
  currentVersion: number;
  /** 伙伴状态。只有 active 的才换代 —— 暂停/归档的不该被动起来。 */
  status: string;
}

export interface BotRenewalDeps {
  readSnapshot: (botId: string) => Promise<BotRenewalSnapshot | null>;
  /** 主对话最后一次活动时间(unix ms);没有对话或读不到时给 0。 */
  readLastActivityAt: (sessionId: string) => Promise<number>;
  /** 这个伙伴还有没有在跑的活儿(后台命令、未完委派、排队自动化)。 */
  hasActiveWork: (botId: string) => Promise<boolean>;
  /** 换代:走既有底座,带 CAS。 */
  renew: (input: {
    botId: string;
    expectedCanonicalSessionId: string;
    expectedProfileVersion: number;
  }) => Promise<{ canonicalSessionId: string }>;
  /** 留痕。失败不影响换代结果本身。 */
  recordEvent?: (input: { botId: string; reason: BotRenewalReason; from: string; to: string }) => Promise<void>;
  now?: () => number;
}

export interface BotRenewalOutcome {
  renewed: boolean;
  reason?: BotRenewalReason;
  /** 换代后的主对话;没换时是原来那条。 */
  canonicalSessionId: string | null;
  /** 换代后要不要告诉用户(策略里的 notify)。 */
  notify: boolean;
}

const NOT_RENEWED = (canonicalSessionId: string | null, notify = false): BotRenewalOutcome => ({
  renewed: false,
  canonicalSessionId,
  notify,
});

/**
 * 兼容入口：canonical Bot Chat 永久存在，不再按日换代。
 *
 * 旧版本仍可能调用这个 IPC/服务入口，因此保留返回形状，但不再执行旧的
 * canonical Session replacement。普通 IM route、Automation worker 的生命周期
 * 由各自服务管理；canonical 的 /new、/reset 和手动 Renew 走原地 compact。
 */
export async function renewBotSessionIfDue(
  botId: string,
  deps: BotRenewalDeps,
): Promise<BotRenewalOutcome> {
  const snapshot = await deps.readSnapshot(botId);
  if (!snapshot) return NOT_RENEWED(null);
  // 暂停 / 归档 / 正在删除的伙伴不该被动起来。
  if (snapshot.status !== 'active') return NOT_RENEWED(snapshot.canonicalSessionId);
  // 还没有主对话 —— 那是「首次创建」的事,不是换代。
  if (!snapshot.canonicalSessionId) return NOT_RENEWED(null);
  return NOT_RENEWED(snapshot.canonicalSessionId);
}
