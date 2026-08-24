/**
 * 旧版到点换代入口的兼容壳。
 *
 * canonical Bot Chat 已对齐 Hermes 的永久 Chat：旧客户端仍可调用并拿到当前 Session，
 * 但这里永远不替换它。新客户端的 `/new`、`/reset` 与手动操作统一走原地 compact。
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
