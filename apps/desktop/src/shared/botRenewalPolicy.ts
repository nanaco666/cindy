/**
 * 伙伴主对话的**换代**判定 —— 什么时候该开一段新的对话。
 *
 * ## 为什么需要它
 *
 * 伙伴的主对话是一条永不断的线:它没有「新建任务」这个动作(那会毁掉伙伴的身份
 * 连续性),于是越用越长。在这之前 Cindy 完全没有换代机制,上下文全靠各 harness
 * 自己的压缩顶着,而用户既看不到它在哪,也没有任何主动重开的手段 —— 除非归档
 * 整个伙伴。
 *
 * ## 与压缩的分工(这两件事常被混为一谈)
 *
 *   - **压缩**:上下文满了,把长记录压短,**继续同一段对话**。身份、待办、刚才
 *     说到哪都还在。管的是「装不下了」。
 *   - **换代**:开一段新的对话,旧的归档。上下文清空,**只有灵魂与记忆留下来**。
 *     管的是「该翻篇了」。
 *
 * 所以换代不是压缩的替代品,它更像每天早上重新开始工作 —— 昨天的细节不必带着,
 * 但你还是你、该记得的还记得。
 *
 * ## 默认每天早上 6 点,只看日界不看空闲
 *
 * Hermes 的同款策略同时提供 idle(空闲 N 分钟就换)与 daily(每天某点换)。这里
 * **只默认开 daily**:空闲换代最容易让人意外 —— 吃个饭回来发现上下文没了;而
 * 日界发生在凌晨,用户感知最小。idle 仍然可配,但默认关。
 *
 * 一条来自 Hermes 的教训写在这里:它的默认值曾经是「24 小时空闲 + 每天 4 点」,
 * 2026 年 7 月改成了「永不换代」,源码注释的原因是 "surprised users who expected
 * their conversations to persist"。所以这里的换代**必须通知用户**,而且换代后
 * 那句话要说清「我还记得你,只是这一段重新开始」。
 *
 * 纯函数,不碰时区库:用本地墙钟(用户说「早上 6 点」指的是他所在时区的 6 点)。
 */

/** 换代策略。与 Hermes 的 `session_reset` 同构。 */
export interface BotRenewalPolicy {
  /** `daily` = 每天到点;`idle` = 空闲够久;`both` = 谁先到算谁;`none` = 从不。 */
  mode: 'none' | 'daily' | 'idle' | 'both';
  /** 每天几点换代(0–23,本地时间)。 */
  atHour: number;
  /** 空闲多少分钟换代。 */
  idleMinutes: number;
  /** 换代时是否告诉用户。 */
  notify: boolean;
}

/**
 * 默认:每天早上 6 点,通知用户。
 *
 * 6 点而不是 Hermes 的 4 点 —— 4 点还有人在干活,6 点是绝大多数人一天真正的
 * 起点。空闲换代默认关(理由见文件头)。
 */
export const DEFAULT_BOT_RENEWAL_POLICY: BotRenewalPolicy = {
  mode: 'daily',
  atHour: 6,
  idleMinutes: 1440,
  notify: true,
};

export type BotRenewalReason = 'daily' | 'idle';

export function normalizeBotRenewalPolicy(value: unknown): BotRenewalPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_BOT_RENEWAL_POLICY };
  }
  const raw = value as Record<string, unknown>;
  const mode =
    raw.mode === 'none' || raw.mode === 'daily' || raw.mode === 'idle' || raw.mode === 'both'
      ? raw.mode
      : DEFAULT_BOT_RENEWAL_POLICY.mode;
  const atHour =
    typeof raw.atHour === 'number' && Number.isInteger(raw.atHour) && raw.atHour >= 0 && raw.atHour <= 23
      ? raw.atHour
      : DEFAULT_BOT_RENEWAL_POLICY.atHour;
  // 下限 5 分钟:再短就不是「空闲」而是「说两句话就换一次」了。
  const idleMinutes =
    typeof raw.idleMinutes === 'number' && Number.isFinite(raw.idleMinutes) && raw.idleMinutes >= 5
      ? Math.floor(raw.idleMinutes)
      : DEFAULT_BOT_RENEWAL_POLICY.idleMinutes;
  return {
    mode,
    atHour,
    idleMinutes,
    notify: typeof raw.notify === 'boolean' ? raw.notify : DEFAULT_BOT_RENEWAL_POLICY.notify,
  };
}

/**
 * 上一次换代时刻(本地墙钟)。
 *
 * 现在还没到今天的那个点,就说明这一轮的起点在**昨天**那个点 —— 这一步不做的话,
 * 凌晨 2 点检查会算出「今天 6 点」这个未来时刻,于是任何对话都"早于"它,每次
 * 检查都换代。
 */
export function lastRenewalBoundary(now: Date, atHour: number): Date {
  const boundary = new Date(now.getTime());
  boundary.setHours(atHour, 0, 0, 0);
  if (boundary.getTime() > now.getTime()) boundary.setDate(boundary.getDate() - 1);
  return boundary;
}

export interface BotRenewalCheckInput {
  policy: BotRenewalPolicy;
  /** 主对话最后一次有活动的时间(unix ms)。 */
  lastActivityAt: number;
  now: number;
  /**
   * 这个伙伴还有没有在跑的活儿(后台命令、未完的委派、排队中的自动化)。
   *
   * 有就不换代 —— 换代会把上下文清空,而那些活儿回来时要往这段对话里报结果。
   * Hermes 同款保护。
   */
  hasActiveWork?: boolean;
}

/** 该换代吗?返回原因,或 null(不换)。 */
export function shouldRenewBotSession(input: BotRenewalCheckInput): BotRenewalReason | null {
  const { policy, lastActivityAt, now } = input;
  if (policy.mode === 'none') return null;
  // 还有活儿在跑就不动它。宁可让对话长一点,也不能把正在等结果的上下文清掉。
  if (input.hasActiveWork) return null;
  // 没有活动记录(刚建好还没说过话)不算「该翻篇」。
  if (!Number.isFinite(lastActivityAt) || lastActivityAt <= 0) return null;
  // 时钟回拨或数据异常:活动时间在未来,不据此判断。
  if (lastActivityAt > now) return null;

  if (policy.mode === 'idle' || policy.mode === 'both') {
    if (now - lastActivityAt >= policy.idleMinutes * 60_000) return 'idle';
  }
  if (policy.mode === 'daily' || policy.mode === 'both') {
    if (lastActivityAt < lastRenewalBoundary(new Date(now), policy.atHour).getTime()) {
      return 'daily';
    }
  }
  return null;
}
