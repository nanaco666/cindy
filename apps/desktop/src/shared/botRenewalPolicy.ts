/**
 * 旧版伙伴换代策略的兼容解析。
 *
 * canonical Bot Chat 已采用 Hermes 的永久 Chat 语义，生产入口不会再用这里替换
 * Session；`/new`、`/reset` 与手动操作统一原地 compact。保留纯函数只为稳定读取旧
 * Profile 配置，并确保旧调用方默认也不会重新打开每日换代。
 */

/** 旧配置形状；新 canonical Chat 只接受默认 `none` 语义。 */
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

/** 永久 canonical Chat 的兼容默认；其它字段只为旧配置解析保留。 */
export const DEFAULT_BOT_RENEWAL_POLICY: BotRenewalPolicy = {
  mode: 'none',
  atHour: 6,
  idleMinutes: 1440,
  notify: false,
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
