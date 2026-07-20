/**
 * TodaySpendChip — 与 ContextCapacityRing 同行的极简用量指示器。
 *
 * 设计意图（用户拍板的方向）：
 *   - 不在 desktop 重做完整看板（Claude 走 web 看板 console.tapsvc.com/nova/#/ai-gateway）
 *   - 仅在右下角与 Context 同行显示"今日 $X/$Y · 本会话 $Z"
 *   - 点击 → 在系统默认浏览器打开对应 vendor 的用量看板
 *
 * Claude / gateway 形态: 主 chip 固定显示 daily + session, monthly 进 tooltip。
 *   - daily: 今日跨客户端已用 / 软日限额 (maxBudget/30*4.5, 与 web 看板同公式)
 *   - monthly: 本月度周期已用 / 月度上限 (LiteLLM /v2/user/info 原值)
 *   - session: 当前会话终身累计 (跨 resume 持久化, 有 sessionId 才显示)
 *
 * Codex 订阅形态主 chip 显示服务端下发的各限额窗口剩余 / 当前会话 USD 折算金额。
 * 窗口构成不做任何假设,完全以上游接口返回为准 —— OpenAI 会调整窗口策略
 * (典型:5h + 周双窗;2026-07 曾一度取消 5h 窗口,且可能随时恢复)。
 * 订阅模式下 USD 是 token 价值,API / codex/ 骨折 GPT 下是 gateway API 单价折算 cost。
 * credits / token 明细只放 tooltip,不占主 chip。
 *
 * Codex tooltip 按当前会话实际 runtime route + 当前模型分两种:
 *   - oauth 模式 + 当前 app-server 以 OAuth bearer 启动 + 普通模型: 显示各限额窗口
 *     剩余额度、当前会话 token 累计、credits 明细。订阅没有单一 per-token 余额。
 *   - api 模式、app-server 以 gateway key 启动、或当前模型是 codex/ 骨折 GPT:
 *     与 cc 同一把 XD key、同一套 LiteLLM 计费,直接复用 cc 的 daily/monthly/key
 *     cost 形态 (session 仍显示 USD 折算累计)。
 *
 * 数据可用性:
 *   - daily / monthly 依赖 claudeQuota (LiteLLM 在线): 拉不到时这俩 metric 都隐藏,
 *     tooltip 顶部加 ⚠️ 提示降级
 *   - session 需 sessionCostUsd > 0 (没跑过 turn 时隐藏)
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { cn } from '@/lib/utils';
import { DAILY_SOFT_LIMIT_FACTOR, formatCompactTokens, formatCompactUsd } from '@/lib/usageFormat';
import { Tip } from '@/components/ui/tooltip';
import { useApiKey } from '@/hooks/useApiKey';
import { useClaudeOAuthConnected } from '@/hooks/useClaudeOAuthConnected';
import { useClaudeSessionRoute } from '@/hooks/useClaudeSessionRoute';
import { useSessionSpend } from '@/hooks/useSessionSpend';
import { useSessionEstimatedValue } from '@/hooks/useSessionEstimatedValue';
import { useSessionTokens } from '@/hooks/useSessionTokens';
import { useChatDisplaySnapshot } from '@/components/chat/ChatDisplaySnapshotContext';
import { useAccountUsage, type RateLimitSnapshot } from '@/hooks/useAccountUsage';
import {
  useClaudeAccountUsage,
  type ClaudeAccountUsageSnapshot,
} from '@/hooks/useClaudeAccountUsage';
import {
  useClaudeSubscriptionUsage,
  type ClaudeSubscriptionUsageSnapshot,
} from '@/hooks/useClaudeSubscriptionUsage';
import {
  matchScopedWindowForModel,
  type ClaudeUsageWindow,
} from '../../../shared/claudeSubscriptionUsage';
import { useCodexRuntimeRoute } from '@/hooks/useCodexRuntimeRoute';
import { useXaiRateLimit, type XaiRateLimitSnapshot } from '@/hooks/useXaiRateLimit';
import { makerChatStore, type ChatMessage } from '@/lib/makerChatStore';
import { buildTurnUsageTooltipLines } from '@/lib/turnUsageTooltip';
import type { TurnUsageDetails } from '../../../shared/turnUsageDetails';
import { CHATGPT_MODEL_PREFIX, XAI_MODEL_PREFIX } from '../../../shared/subscriptionModels';

const PROXY_USAGE_DASHBOARD_URL = 'https://console.tapsvc.com/nova/#/ai-gateway?tab=overview';
const CODEX_USAGE_DASHBOARD_URL = 'https://chatgpt.com/codex/settings/usage';
const XAI_ACCOUNT_URL = 'https://accounts.x.ai';
const CLAUDE_USAGE_DASHBOARD_URL = 'https://claude.ai/settings/usage';

const METRIC_KEYS = ['daily', 'monthly', 'session'] as const;
type MetricKey = (typeof METRIC_KEYS)[number];
const PRIMARY_GATEWAY_METRICS: readonly MetricKey[] = ['daily', 'session'];
const DAY_MS = 24 * 60 * 60 * 1000;

const PLAN_TYPE_LABELS: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  team: 'Team',
  self_serve_business_usage_based: 'Self Serve Business Usage Based',
  business: 'Business',
  enterprise_cbp_usage_based: 'Enterprise CBP Usage Based',
  enterprise: 'Enterprise',
  edu: 'Edu',
  unknown: 'Unknown',
};

// 软日限额系数 + 紧凑金额格式化已抽到 lib/usageFormat.ts (与首页仪表盘共用同口径)。

/** chip / tooltip 共用: 一个 metric 的最终展示形态。 */
interface MetricSlot {
  /** "今日 $47/$300" / "本会话 $3.03" 这种成品字符串, 可用直接 render。 */
  label: string;
  /** tooltip 里使用的解释文案;不填则复用 label。 */
  tooltipLabel?: string;
  /** 是否有数据 — false 时不参与渲染 (无论 chip 还是 tooltip), 由调用方过滤。 */
  available: boolean;
}

/**
 * 把 4 个候选 metric 一次性算好 (label + 是否可用)。
 *   - daily / monthly: 需 claudeQuota 在线; 否则 available=false (整段隐藏)
 *   - session: 需 sessionCostUsd > 0; 否则 available=false
 *
 * chip 段 / tooltip 段都从这里拿, 主显指标固定, 其它可用指标进 tooltip。
 */
function computeMetricSlots(
  claudeQuota: ClaudeAccountUsageSnapshot | null,
  sessionCostUsd: number | null,
  t: TFunction,
): Record<MetricKey, MetricSlot> {
  const slots: Record<MetricKey, MetricSlot> = {
    daily: { label: t('todaySpend.dailyLimitLabel', { spend: '$—', limit: '$—' }), available: false },
    monthly: { label: t('todaySpend.monthlyLimitLabel', { spend: '$—', limit: '$—' }), available: false },
    session: { label: t('todaySpend.sessionCostLabel', { cost: '$—' }), available: false },
  };

  if (claudeQuota && claudeQuota.maxBudget > 0) {
    // monthly 永远跟 cycle 一起拿到; daily 走单独 endpoint 可能拉不到 (todaySpend=null) → 隐藏
    slots.monthly = {
      label: t('todaySpend.monthlyLimitLabel', {
        spend: formatCompactUsd(claudeQuota.spend),
        limit: formatCompactUsd(claudeQuota.maxBudget),
      }),
      available: true,
    };
    if (typeof claudeQuota.todaySpend === 'number') {
      const softLimit = (claudeQuota.maxBudget / 30) * DAILY_SOFT_LIMIT_FACTOR;
      slots.daily = {
        label: t('todaySpend.dailyLimitLabel', {
          spend: formatCompactUsd(claudeQuota.todaySpend),
          limit: formatCompactUsd(softLimit),
        }),
        available: true,
      };
    }
  }

  if (typeof sessionCostUsd === 'number' && sessionCostUsd > 0) {
    slots.session = {
      label: t('todaySpend.sessionCostLabel', { cost: `$${sessionCostUsd.toFixed(2)}` }),
      tooltipLabel: t('todaySpend.tooltip.sessionUsed', { cost: `$${sessionCostUsd.toFixed(2)}` }),
      available: true,
    };
  }

  return slots;
}

function parseCreditBalance(balance: string | null | undefined): {
  formatted: string;
} | null {
  const trimmed = balance?.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed.replace(/,/g, ''));
  if (!Number.isFinite(numeric)) return null;
  const formatted = numeric.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return { formatted };
}

function formatPlanType(planType: string | null | undefined): string | null {
  const trimmed = planType?.trim();
  if (!trimmed) return null;
  const knownLabel = PLAN_TYPE_LABELS[trimmed];
  if (knownLabel) return knownLabel;
  return trimmed
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function formatPercent(value: number): string {
  const clamped = clampPercent(value);
  if (Math.abs(clamped - Math.round(clamped)) < 0.05) return `${Math.round(clamped)}%`;
  return `${clamped.toFixed(1).replace(/\.0$/, '')}%`;
}

/** tooltip 用的精确 reset 时间点(当天只显时分, 跨天带月日)。 */
function formatResetAt(epochSeconds: number | null | undefined): string | null {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds) || epochSeconds <= 0) {
    return null;
  }
  const date = new Date(epochSeconds * 1000);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(
    undefined,
    sameDay
      ? { hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  ).format(date);
}

/**
 * chip 主体用的紧凑剩余时长(距 reset 还有多久): 单级精度 + 向上取整 ——
 * 「7天」/「3小时」/「45分钟」。Codex 与 Claude 订阅两种形态统一用它当窗口
 * label(所有限额窗口都算给用户);无数据 / 已过期 → null, 调用方回退窗口名。
 * 天级向上取整与 Codex 既有 getDaysUntilReset 口径一致(剩 6天10小时 → 7天)。
 */
function formatCompactTimeUntilReset(
  epochSeconds: number | null | undefined,
  nowMs: number,
  t: TFunction,
): string | null {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds) || epochSeconds <= 0) {
    return null;
  }
  const remainMs = epochSeconds * 1000 - nowMs;
  if (remainMs <= 0) return null;
  if (remainMs >= DAY_MS) {
    return `${Math.ceil(remainMs / DAY_MS)}${t('todaySpend.unit.day')}`;
  }
  if (remainMs >= 60 * 60 * 1000) {
    return `${Math.ceil(remainMs / (60 * 60 * 1000))}${t('todaySpend.unit.hour')}`;
  }
  return `${Math.max(1, Math.ceil(remainMs / 60_000))}${t('todaySpend.unit.minute')}`;
}

function formatWindowLabel(
  window: RateLimitSnapshot['primary'],
  fallback: string,
  t: TFunction,
  nowMs: number,
  options?: { preferResetCountdown?: boolean },
): string {
  // chip 模式: label 直接用距 reset 的剩余时长(所有限额窗口都算给用户);
  // 无 reset 数据时回退下面的窗口名派生链。tooltip 模式不进这个分支(窗口名 + 精确时间)。
  if (options?.preferResetCountdown) {
    const countdown = formatCompactTimeUntilReset(window?.resetsAt, nowMs, t);
    if (countdown !== null) return countdown;
  }

  const minutes = window?.windowMinutes;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
    return fallback;
  }
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    if (options?.preferResetCountdown || days < 7) {
      return t('todaySpend.codex.daysWindow', { days });
    }
  }
  if (minutes >= 7 * 24 * 60) return t('todaySpend.codex.weekWindow');
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

interface CodexWindowUsage {
  label: string;
  used: string;
  remaining: string;
  /** tooltip 用的精确 reset 时间点;无数据 → null。 */
  resetAt: string | null;
}

function toCodexWindowUsage(
  label: string,
  window: RateLimitSnapshot['primary'],
): CodexWindowUsage | null {
  if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) {
    return null;
  }
  const usedPercent = clampPercent(window.usedPercent);
  return {
    label,
    used: formatPercent(usedPercent),
    remaining: formatPercent(100 - usedPercent),
    resetAt: formatResetAt(window.resetsAt),
  };
}

function formatRateLimitReason(reason: string): string {
  return reason
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getCodexWindowUsages(
  snapshot: RateLimitSnapshot | null,
  t: TFunction,
  nowMs: number,
  options?: { labelMode?: 'countdown' | 'windowName' },
): CodexWindowUsage[] {
  if (!snapshot) return [];
  // countdown = chip 模式: 各窗口的 label 都换成距 reset 的剩余时长;
  // windowName = tooltip 模式: 窗口名 + resetAt 精确时间, 保持既有形态。
  const countdown = options?.labelMode === 'countdown';
  // 窗口名一律由服务端下发的 windowMinutes / resetsAt 动态派生,不对窗口构成做
  // 任何假设(OpenAI 会调整策略:2026-07 曾一度取消 5h 窗口,且可能随时恢复)。
  // 两项数据都缺时兜底中性「限额」,不猜具体窗口名。
  return [
    toCodexWindowUsage(
      formatWindowLabel(snapshot.primary, t('todaySpend.codex.limitWindow'), t, nowMs, {
        preferResetCountdown: countdown,
      }),
      snapshot.primary,
    ),
    toCodexWindowUsage(
      formatWindowLabel(snapshot.secondary, t('todaySpend.codex.limitWindow'), t, nowMs, {
        preferResetCountdown: countdown,
      }),
      snapshot.secondary,
    ),
  ].filter((v): v is CodexWindowUsage => Boolean(v));
}

function isCodexWindowExhausted(window: RateLimitSnapshot['primary']): boolean {
  return Boolean(window && clampPercent(window.usedPercent) >= 99.95);
}

function shouldShowCodexLimitReachedReason(snapshot: RateLimitSnapshot): boolean {
  if (!snapshot.rateLimitReachedType) return false;
  if (snapshot.rateLimitReachedType.includes('credits_depleted')) return false;
  return isCodexWindowExhausted(snapshot.primary) || isCodexWindowExhausted(snapshot.secondary);
}

function getCodexChipSegments(
  snapshot: RateLimitSnapshot | null,
  t: TFunction,
  nowMs: number,
): string[] {
  return getCodexWindowUsages(snapshot, t, nowMs, { labelMode: 'countdown' }).map((window) =>
    t('todaySpend.codex.windowSegment', {
      label: window.label,
      remaining: window.remaining,
    }),
  );
}

function getGatewayChipSegments(slots: Record<MetricKey, MetricSlot>): string[] {
  return PRIMARY_GATEWAY_METRICS
    .filter((key) => slots[key].available)
    .map((key) => slots[key].label);
}

function buildCodexTooltipNode(
  snapshot: RateLimitSnapshot | null,
  sessionTokens: number | null,
  sessionValueUsd: number | null,
  t: TFunction,
  usageDashboardLabel: string,
  nowMs: number,
  latestTurnUsage: LatestTurnUsageSummary | null,
): React.ReactNode {
  const lines: string[] = [];
  if (!snapshot) {
    lines.push(t('todaySpend.codex.waitingDetail'));
    appendLatestTurnUsageLines(lines, latestTurnUsage, t);
    lines.push('');
    lines.push(usageDashboardLabel);
    return buildTooltipNode(lines);
  }

  const planLabel = formatPlanType(snapshot.planType);
  const credits = snapshot.credits;
  const parsedCredits = parseCreditBalance(credits?.balance);

  if (planLabel && parsedCredits) {
    lines.push(t('todaySpend.codex.planCreditsLine', {
      plan: planLabel,
      credits: parsedCredits.formatted,
    }));
  } else if (planLabel) {
    lines.push(t('todaySpend.codex.planLine', { plan: planLabel }));
  } else if (parsedCredits) {
    lines.push(t('todaySpend.codex.creditsLine', {
      credits: parsedCredits.formatted,
    }));
  }

  if (credits?.unlimited) {
    lines.push(t('todaySpend.codex.balanceUnlimited'));
  } else if (credits && !credits.hasCredits) {
    lines.push(t('todaySpend.codex.balanceDepleted'));
  } else if (credits?.hasCredits && !parsedCredits) {
    lines.push(t('todaySpend.codex.balanceAvailable'));
  }
  pushSessionValueLines(lines, sessionValueUsd, sessionTokens, t);

  for (const window of getCodexWindowUsages(snapshot, t, nowMs, { labelMode: 'windowName' })) {
    const base = t('todaySpend.codex.windowLine', {
      label: window.label,
      remaining: window.remaining,
      used: window.used,
    });
    lines.push(window.resetAt
      ? `${base} · ${t('todaySpend.codex.resetAt', { at: window.resetAt })}`
      : base,
    );
  }

  const limitReachedReason = shouldShowCodexLimitReachedReason(snapshot)
    ? snapshot.rateLimitReachedType
    : null;
  if (limitReachedReason) {
    lines.push(t('todaySpend.codex.limitReached', {
      reason: formatRateLimitReason(limitReachedReason),
    }));
  }

  if (lines.length === 0) {
    lines.push(t('todaySpend.codex.waitingDetail'));
  }
  appendLatestTurnUsageLines(lines, latestTurnUsage, t);
  if (lines.length > 0) lines.push('');
  lines.push(usageDashboardLabel);
  return buildTooltipNode(lines);
}

// ── Claude 订阅 (Anthropic OAuth) 形态 ───────────────────────────────────────
// 主 chip 方案 B: 5h 剩余% · 当前模型周限剩余% (weekly_scoped 按模型家族匹配, 匹配
// 不到回退总周限并标注口径) · 本会话价值 $。tooltip 列全量窗口 (含非当前模型的
// scoped 条目) + 套餐 + extra usage。utilization 语义 = 已用百分比 (0-100)。

/** Claude 窗口 → 展示行素材;窗口缺失 / 数据不可解析 → null (调用方过滤)。 */
interface ClaudeWindowUsage {
  label: string;
  used: string;
  remaining: string;
  /** tooltip 用的精确 reset 时间点;无数据 → null。 */
  resetAt: string | null;
  /** 服务端 severity 非 normal, 或已打满 —— tooltip 高亮 / chip 变警示色的依据。 */
  alerting: boolean;
}

function isClaudeWindowAlerting(window: ClaudeUsageWindow | null | undefined): boolean {
  if (!window) return false;
  if (clampPercent(window.utilization) >= 99.95) return true;
  const severity = window.severity?.trim().toLowerCase();
  return Boolean(severity && severity !== 'normal');
}

function toClaudeWindowUsage(
  label: string,
  window: ClaudeUsageWindow | null | undefined,
): ClaudeWindowUsage | null {
  if (!window || typeof window.utilization !== 'number' || !Number.isFinite(window.utilization)) {
    return null;
  }
  const usedPercent = clampPercent(window.utilization);
  return {
    label,
    used: formatPercent(usedPercent),
    remaining: formatPercent(100 - usedPercent),
    resetAt: formatResetAt(window.resetsAt),
    alerting: isClaudeWindowAlerting(window),
  };
}

/**
 * 当前会话生效的周限窗口: 命中当前模型的 weekly_scoped 条目优先 (label 带模型名,
 * 如 "Fable 周限"), 否则回退总周限 —— 两种 label 口径可区分, 绝不臆造数字。
 * modelDisplayName 仅 scoped 命中时有, chip 倒计时 label 用它拼「Fable 7天」。
 */
function resolveClaudeWeeklyWindow(
  snapshot: ClaudeSubscriptionUsageSnapshot,
  modelId: string | null | undefined,
  t: TFunction,
): { label: string; window: ClaudeUsageWindow; modelDisplayName?: string } | null {
  const scoped = matchScopedWindowForModel(snapshot.scoped, modelId);
  if (scoped) {
    return {
      label: t('todaySpend.claude.modelWeeklyLabel', { model: scoped.modelDisplayName }),
      window: scoped,
      modelDisplayName: scoped.modelDisplayName,
    };
  }
  if (snapshot.sevenDay) {
    return { label: t('todaySpend.claude.weeklyLabel'), window: snapshot.sevenDay };
  }
  return null;
}

/**
 * chip 段 (方案 B + 倒计时 label): 窗口 label 直接用距 reset 的剩余时长 ——
 * 「3小时 剩余 45% · Fable 7天 剩余 78%」;scoped 命中时时长前带模型名标注口径。
 * 无 reset 数据回退窗口名 (5h / Fable 周限 / 周限), 绝不显示算不出的时间。
 */
function getClaudeChipSegments(
  snapshot: ClaudeSubscriptionUsageSnapshot | null,
  modelId: string | null | undefined,
  t: TFunction,
  nowMs: number,
): string[] {
  if (!snapshot) return [];
  const segments: string[] = [];
  const fiveHour = toClaudeWindowUsage('5h', snapshot.fiveHour);
  if (fiveHour) {
    const countdown = formatCompactTimeUntilReset(snapshot.fiveHour?.resetsAt, nowMs, t);
    segments.push(t('todaySpend.claude.windowSegment', {
      label: countdown ?? fiveHour.label,
      remaining: fiveHour.remaining,
    }));
  }
  const weekly = resolveClaudeWeeklyWindow(snapshot, modelId, t);
  const weeklyUsage = weekly ? toClaudeWindowUsage(weekly.label, weekly.window) : null;
  if (weekly && weeklyUsage) {
    const countdown = formatCompactTimeUntilReset(weekly.window.resetsAt, nowMs, t);
    const label = countdown
      ? (weekly.modelDisplayName ? `${weekly.modelDisplayName} ${countdown}` : countdown)
      : weeklyUsage.label;
    segments.push(t('todaySpend.claude.windowSegment', {
      label,
      remaining: weeklyUsage.remaining,
    }));
  }
  return segments;
}

/**
 * chip 警示态: 只看影响当前会话的窗口 (5h / 总周限 / 当前模型 scoped) 与 headers
 * 的整体 status —— 其它模型的窗口打满不限流当前会话, 只在 tooltip 里可见。
 * headers 源的窗口不带 severity, turn 内实时阶段「接近限额」只由整体 status 的
 * allowed_warning 表达, 因此 warning / rejected 都纳入告警 (rejected 在 tooltip
 * 文案分流里优先)。
 */
function isClaudeSubscriptionAlerting(
  snapshot: ClaudeSubscriptionUsageSnapshot | null,
  modelId: string | null | undefined,
): boolean {
  if (!snapshot) return false;
  const status = snapshot.rateLimitStatus?.trim().toLowerCase();
  if (status === 'rejected' || status === 'allowed_warning') return true;
  return (
    isClaudeWindowAlerting(snapshot.fiveHour)
    || isClaudeWindowAlerting(snapshot.sevenDay)
    || isClaudeWindowAlerting(matchScopedWindowForModel(snapshot.scoped, modelId))
  );
}

function buildClaudeSubscriptionTooltipNode(
  snapshot: ClaudeSubscriptionUsageSnapshot | null,
  modelId: string | null | undefined,
  sessionValueUsd: number | null,
  t: TFunction,
  usageDashboardLabel: string,
  latestTurnUsage: LatestTurnUsageSummary | null,
): React.ReactNode {
  const lines: string[] = [];
  if (!snapshot) {
    lines.push(t('todaySpend.claude.waitingDetail'));
    appendLatestTurnUsageLines(lines, latestTurnUsage, t);
    lines.push('');
    lines.push(usageDashboardLabel);
    return buildTooltipNode(lines);
  }

  const planLabel = formatPlanType(snapshot.subscriptionType);
  if (planLabel) {
    lines.push(t('todaySpend.claude.planLine', { plan: planLabel }));
  }
  if (typeof sessionValueUsd === 'number' && Number.isFinite(sessionValueUsd) && sessionValueUsd > 0) {
    lines.push(t('todaySpend.claude.sessionValueLabel', {
      cost: `$${sessionValueUsd.toFixed(2)}`,
    }));
  }

  // 窗口明细: 5h → 总周限 → 全部分模型周限 (含非当前模型, 用户能看到谁先见底)。
  // tooltip 保留精确 reset 时间点 (chip 上是倒计时, 两层信息互补)。
  const windows: ClaudeWindowUsage[] = [];
  const fiveHour = toClaudeWindowUsage('5h', snapshot.fiveHour);
  if (fiveHour) windows.push(fiveHour);
  const sevenDay = toClaudeWindowUsage(t('todaySpend.claude.weeklyLabel'), snapshot.sevenDay);
  if (sevenDay) windows.push(sevenDay);
  for (const scoped of snapshot.scoped ?? []) {
    const usage = toClaudeWindowUsage(
      t('todaySpend.claude.modelWeeklyLabel', { model: scoped.modelDisplayName }),
      scoped,
    );
    if (usage) windows.push(usage);
  }
  for (const window of windows) {
    const base = t('todaySpend.claude.windowLine', {
      label: window.label,
      remaining: window.remaining,
      used: window.used,
    });
    lines.push(window.resetAt
      ? `${base} · ${t('todaySpend.claude.resetAt', { at: window.resetAt })}`
      : base,
    );
  }

  const status = snapshot.rateLimitStatus?.trim().toLowerCase();
  if (status === 'rejected') {
    lines.push(t('todaySpend.claude.limitRejected'));
  } else if (isClaudeSubscriptionAlerting(snapshot, modelId)) {
    lines.push(t('todaySpend.claude.limitWarning'));
  }

  if (snapshot.extraUsage?.isEnabled) {
    // extra_usage 的 used_credits / monthly_limit 单位未文档化且本地暂无实样账号,
    // 不能假设 cents 并渲染美元金额。这里只展示启用状态;数值原样保留在 snapshot,
    // 等拿到 live response 后再补准确单位展示。
    lines.push(t('todaySpend.claude.extraUsageEnabledLine'));
  }

  if (lines.length === 0) {
    lines.push(t('todaySpend.claude.waitingDetail'));
  }
  appendLatestTurnUsageLines(lines, latestTurnUsage, t);
  if (lines.length > 0) lines.push('');
  lines.push(usageDashboardLabel);
  return buildTooltipNode(lines);
}

/** 最近一轮 tooltip 使用的 assistant 消息明细。 */
interface LatestTurnUsageSummary {
  costUsd?: number;
  isEstimate?: boolean;
  isUserTurnTotal: boolean;
  details: TurnUsageDetails;
}

function findLatestTurnUsageSummary(messages: ChatMessage[]): LatestTurnUsageSummary | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant' || !message.turnUsageDetails) continue;
    const userTurnCostUsd = typeof message.userTurnCostUsd === 'number' && message.userTurnCostUsd > 0
      ? message.userTurnCostUsd
      : undefined;
    return {
      ...(userTurnCostUsd != null
        ? { costUsd: userTurnCostUsd }
        : typeof message.turnCostUsd === 'number' && message.turnCostUsd > 0
          ? { costUsd: message.turnCostUsd }
        : {}),
      ...((userTurnCostUsd != null
        ? message.userTurnCostIsEstimate
        : message.turnCostIsEstimate) === true ? { isEstimate: true } : {}),
      isUserTurnTotal: userTurnCostUsd != null,
      details: message.turnUsageDetails,
    };
  }
  return null;
}

function useLatestTurnUsageSummary(sessionId: string | undefined): LatestTurnUsageSummary | null {
  const displaySnapshot = useChatDisplaySnapshot(sessionId);
  const displaySummary = React.useMemo(
    () => displaySnapshot ? findLatestTurnUsageSummary(displaySnapshot.messages) : null,
    [displaySnapshot],
  );
  const [summary, setSummary] = React.useState<LatestTurnUsageSummary | null>(() => {
    if (!sessionId) return null;
    return findLatestTurnUsageSummary(makerChatStore.getSnapshot(sessionId).messages);
  });

  React.useEffect(() => {
    if (displaySnapshot) return undefined;
    if (!sessionId) {
      setSummary(null);
      return undefined;
    }
    const update = () => {
      setSummary(findLatestTurnUsageSummary(makerChatStore.getSnapshot(sessionId).messages));
    };
    update();
    return makerChatStore.subscribe(sessionId, update);
  }, [displaySnapshot, sessionId]);

  return displaySnapshot ? displaySummary : summary;
}

function appendLatestTurnUsageLines(
  lines: string[],
  summary: LatestTurnUsageSummary | null,
  t: TFunction,
): void {
  if (!summary) return;
  if (lines.length > 0) lines.push('');
  lines.push(...buildTurnUsageTooltipLines({
    details: summary.details,
    t,
    costUsd: summary.costUsd,
    isEstimate: summary.isEstimate,
    title: t(summary.isUserTurnTotal
      ? 'todaySpend.tooltip.latestUserTurnTitle'
      : 'todaySpend.tooltip.latestTurnTitle'),
  }));
}

function buildTooltipNode(lines: string[]): React.ReactNode {
  return <span className="whitespace-pre-line">{lines.join('\n')}</span>;
}

/** 「本会话价值 / token 累计」两行 —— codex 订阅与 xai bridge tooltip 共用(同 i18n key 同格式)。 */
function pushSessionValueLines(
  lines: string[],
  sessionValueUsd: number | null,
  sessionTokens: number | null,
  t: TFunction,
): void {
  if (typeof sessionValueUsd === 'number' && Number.isFinite(sessionValueUsd) && sessionValueUsd > 0) {
    lines.push(t('todaySpend.codex.sessionValueLabel', { cost: `$${sessionValueUsd.toFixed(2)}` }));
  }
  if (typeof sessionTokens === 'number' && Number.isFinite(sessionTokens) && sessionTokens > 0) {
    lines.push(t('todaySpend.codex.sessionTokensLine', {
      tokens: formatCompactTokens(Math.floor(sessionTokens)),
    }));
  }
}

/**
 * xAI(SuperGrok bridge)tooltip —— 尽力档:有限流快照(bridge 抓到 x-ratelimit-* 头)就
 * 显示剩余请求/tokens,拿不到诚实标注「无订阅额度明细」,只显示价值估算 + token 累计。
 */
function buildXaiTooltipNode(
  rateLimit: XaiRateLimitSnapshot | null,
  sessionTokens: number | null,
  sessionValueUsd: number | null,
  t: TFunction,
  usageDashboardLabel: string,
  latestTurnUsage: LatestTurnUsageSummary | null,
): React.ReactNode {
  const lines: string[] = [];
  pushSessionValueLines(lines, sessionValueUsd, sessionTokens, t);
  if (rateLimit && typeof rateLimit.remainingRequests === 'number' && typeof rateLimit.limitRequests === 'number') {
    lines.push(t('todaySpend.xai.requestsLine', {
      remaining: rateLimit.remainingRequests.toLocaleString(),
      limit: rateLimit.limitRequests.toLocaleString(),
    }));
  }
  if (rateLimit && typeof rateLimit.remainingTokens === 'number' && typeof rateLimit.limitTokens === 'number') {
    lines.push(t('todaySpend.xai.tokensLine', {
      remaining: formatCompactTokens(rateLimit.remainingTokens),
      limit: formatCompactTokens(rateLimit.limitTokens),
    }));
  }
  if (!rateLimit) {
    lines.push(t('todaySpend.xai.noQuotaDetail'));
  }
  appendLatestTurnUsageLines(lines, latestTurnUsage, t);
  if (lines.length > 0) lines.push('');
  lines.push(usageDashboardLabel);
  return buildTooltipNode(lines);
}

function renderSegmentedLabel(segments: string[]): React.ReactNode {
  return segments.map((seg, i) => (
    <React.Fragment key={i}>
      {i > 0 && (
        <span
          aria-hidden="true"
          className="mx-2 inline-block h-3 w-px bg-current opacity-30"
        />
      )}
      <span className="tabular-nums">{seg}</span>
    </React.Fragment>
  ));
}

interface TodaySpendChipProps {
  vendorKey?: 'cc' | 'codex';
  /** 当前会话模型;codex/ 骨折 GPT 恒走 gateway API, 即使 oauth-bearer spawn 也按 API 形态显示。 */
  modelId?: string | null;
  /**
   * 本会话显式选定的供应商('anthropic' / 'openai' / 'xd' / null=默认路由)。
   * 决定计费形态:cc 选了 'anthropic' = 走订阅(抑制网关 quota);cc 默认路由的形态由
   * 本机有无网关 key 决定(无 key → proxy 直连 Anthropic, 同为订阅);codex 选了 'xd'
   * = 走网关(显 $)。与 register.ts 的 isClaudeSubscriptionSession / isSubscriptionValue 同口径。
   */
  providerId?: string | null;
  /** session 累计需要 sessionId + 初始值。Claude / Codex API 显示真实 USD cost。 */
  sessionId?: string;
  /** 来自 session.totalCostUsd（sessionService.get 拿到）— mount 后由 IPC push 更新。 */
  sessionInitialCostUsd?: number | null;
  /** 来自 session.totalTokenUsage（sessionService.get 拿到）— mount 后由 IPC push 更新。 */
  sessionInitialTokens?: number | null;
  /** 远端 Codex 由远端 daemon 路由,本机不能拿本地 app-server route / 账号快照来归类。 */
  remoteHostId?: string | null;
  /**
   * device-link 远程会话所属被控端 id(与 SSH remoteHostId 互斥)。非空 = turn 实际跑在
   * 被控端、消耗**被控端**账号的额度 —— 本机的 ChatGPT 账户快照 / xAI 限流快照与之无关,
   * 必须抑制本地账号读取(否则 chip 显示的是控制端账号的用量,张冠李戴)。
   */
  deviceLinkDeviceId?: string | null;
}

export function TodaySpendChip({
  vendorKey = 'cc',
  modelId,
  providerId,
  sessionId,
  sessionInitialCostUsd,
  sessionInitialTokens,
  remoteHostId,
  deviceLinkDeviceId,
}: TodaySpendChipProps) {
  const { t } = useTranslation();
  const { authInjection: codexAuthInjection } = useCodexRuntimeRoute({
    enabled: vendorKey === 'codex',
    refreshKey: sessionId,
  });
  // cc 订阅判定对齐 main 的 isClaudeSubscriptionSession(register.ts)+ proxy 实际路由:
  //   - 显式选 Anthropic 供应商 → 订阅直连(Claude 模型直连 api.anthropic.com,
  //     LiteLLM 看不到, gateway quota 不代表真实花费, 抑制 daily/monthly 展示);
  //   - 默认路由(providerId=null)→ **优先用 proxy 观察到的会话生效路由**
  //     (claude-session-route-registry, 每请求真值):cc 子进程凭证在 spawn 时冻结,
  //     用全局活性凭证状态重算会与实际路由发散(典型:gateway-spawn 会话跑着时
  //     连上 OAuth 并清掉网关 key, child 仍拿冻结的 x-api-key 走网关)。
  //   - 会话尚未发过请求(无观察值)→ 回落活性启发式「无网关 key 且连了 Claude
  //     OAuth = 订阅」:此时下一次 spawn 恰按当前凭证决定, 启发式即正确预测
  //     (main 计费侧不需要观察值: SDK 网关轮自报 costUsd>0, 天然不会误打订阅行)。
  // 网关 key 存在性经 useApiKey 读(与 main readClaudeApiKey 同一 safeStorage key,
  // 自带跨实例广播 + auth-change 刷新)。无观察值且 key reconcile / OAuth 首查未完成
  // 时默认路由形态未定 —— 不判订阅也不放行网关 quota 读, 避免 chip 先按一种形态
  // 渲染再闪切(规则 7)。
  // 远端 Claude 会话恒走网关(runtime-configs 的 remoteEndpoint),本机订阅快照与实际
  // 服务账号无关 —— 排除出订阅形态,回落 gateway quota 展示(与 Codex 远端口径一致)。
  const isRemoteClaudeSession = vendorKey === 'cc' && Boolean(remoteHostId);
  const isDefaultRouteClaudeSession =
    vendorKey === 'cc' && !isRemoteClaudeSession && providerId == null;
  const { hasSavedKey: hasGatewayKey, isReconciling: gatewayKeyReconciling } = useApiKey();
  const claudeOAuthConnected = useClaudeOAuthConnected(isDefaultRouteClaudeSession);
  const observedClaudeRoute = useClaudeSessionRoute(sessionId, isDefaultRouteClaudeSession);
  const ccBillingFormPending = isDefaultRouteClaudeSession && observedClaudeRoute == null
    && (gatewayKeyReconciling || (!hasGatewayKey && claudeOAuthConnected == null));
  const isClaudeSubscription = vendorKey === 'cc' && !isRemoteClaudeSession && (
    providerId === 'anthropic'
    || (providerId == null && (
      observedClaudeRoute != null
        ? observedClaudeRoute === 'subscription'
        : !gatewayKeyReconciling && !hasGatewayKey && claudeOAuthConnected === true
    ))
  );
  // cc 走「订阅直连 bridge」= model 带 chatgpt/ / xai/ 前缀(经本地 responses-bridge 打用户个人
  // 订阅额度,真实计费恒 0,gateway quota 与之无关):
  //   - chatgpt/ → 与 codex 同一 ChatGPT 账户,复用 codex 订阅 chip 形态(限额窗口 + 价值估算);
  //   - xai/    → SuperGrok 无订阅窗口端点,尽力显示 bridge 抓到的限流头,否则仅价值估算。
  // 优先级高于 Claude 订阅形态(model 前缀决定实际消耗的额度)。
  const isChatgptBridge =
    vendorKey === 'cc' && typeof modelId === 'string' && modelId.startsWith(CHATGPT_MODEL_PREFIX);
  const isXaiBridge =
    vendorKey === 'cc' && typeof modelId === 'string' && modelId.startsWith(XAI_MODEL_PREFIX);
  const isSubscriptionBridge = isChatgptBridge || isXaiBridge;
  const isRemoteCodexSession = vendorKey === 'codex' && Boolean(remoteHostId);
  const isCodexBudgetModel = typeof modelId === 'string' && modelId.startsWith('codex/');
  const isCodexXaiProvider =
    vendorKey === 'codex' && typeof modelId === 'string' && modelId.startsWith(XAI_MODEL_PREFIX);
  // codex 走订阅价值估算:ChatGPT 订阅需要 oauth-bearer 且未显式选 XD;xAI 由 proxy 注入
  // SuperGrok OAuth,不依赖 Codex 子进程凭证。env-key fallback、codex/ 骨折、或显式选 XD
  // → 复用 cc 的 cost tooltip 形态。远端 Codex 的事实在远端 daemon 上,本机只记录 token
  // 价值估算,不写本地 gateway cost。
  const isCodexOauth = vendorKey === 'codex' && !isCodexXaiProvider && (
    isRemoteCodexSession ||
    (codexAuthInjection === 'oauth-bearer' && !isCodexBudgetModel && providerId !== 'xd')
  );
  const isCodexSubscription = isCodexOauth || isCodexXaiProvider;
  const isCodexApi = vendorKey === 'codex' && !isCodexSubscription;
  // codex-oauth 与 cc+chatgpt/ bridge 共用同一 ChatGPT 账户 → 同一套限额窗口 chip 渲染。
  const usesCodexQuotaForm = isCodexOauth || isChatgptBridge;
  const usesXaiQuotaForm = isCodexXaiProvider || isXaiBridge;
  // 远程会话不读本机账户快照 —— 额度事实在远端:SSH 用 remoteHostId 判,device-link 用
  // deviceLinkDeviceId 判(两者互斥,任一非空即远程,turn 消耗的是远端账号的额度)。
  const isAnyRemoteSession = Boolean(remoteHostId) || Boolean(deviceLinkDeviceId);
  // Claude 网关/订阅配额的本地读取只对 device-link 加门:SSH 远程 cc 维持既有口径
  // (isRemoteClaudeSession 已排除订阅形态、回落 gateway quota 展示);device-link 的 turn
  // 与凭证都在被控端,控制端本机的 LiteLLM / Claude.ai 配额与之无关。
  const isDeviceLinkRemote = Boolean(deviceLinkDeviceId);
  const shouldReadLocalCodexAccountUsage = usesCodexQuotaForm && !isAnyRemoteSession;
  // 订阅直连 bridge 轮真实计费恒 0(不写 sessions.total_cost_usd),spend hook 无意义 → 关。
  const sessionCostUsd = useSessionSpend(
    (vendorKey === 'cc' && !isSubscriptionBridge) || isCodexApi ? sessionId : undefined,
    (vendorKey === 'cc' && !isSubscriptionBridge) || isCodexApi ? sessionInitialCostUsd : null,
  );
  const sessionTokens = useSessionTokens(
    isCodexSubscription || isSubscriptionBridge ? sessionId : undefined,
    sessionInitialTokens,
  );
  // 订阅会话的"本会话价值"估算 (isEstimate 消息汇总): Codex OAuth / Claude 订阅 / bridge 订阅同管道。
  const sessionEstimatedValueUsd = useSessionEstimatedValue(
    sessionId,
    isCodexSubscription || isClaudeSubscription || isSubscriptionBridge,
  );
  const accountUsage = useAccountUsage(sessionId, shouldReadLocalCodexAccountUsage ? 'codex' : undefined);
  // xAI 限流快照同为本机 main 抓的 —— 远程会话(SSH / device-link)同样抑制,回落价值估算。
  const xaiRateLimit = useXaiRateLimit(usesXaiQuotaForm && !isAnyRemoteSession);
  // cc 与 codex-api 共用同一把 XD gateway key 的 LiteLLM quota; codex-oauth 不订阅。
  // cc 走订阅(Anthropic / bridge 模型)同样不读 gateway quota —— 它不反映用户的订阅花费(见上);
  // 默认路由在 key reconcile 完成前形态未定, 同样先不读(几 ms 后判定落定, 避免形态闪切)。
  const claudeQuota = useClaudeAccountUsage(
    (((vendorKey === 'cc' && !isClaudeSubscription && !isSubscriptionBridge && !ccBillingFormPending) || isCodexApi)
      && !isDeviceLinkRemote),
  );
  // Claude 订阅账号余量 (5h/周/分模型窗口, 端点 + proxy 旁路 headers 双源)。bridge 模型形态
  // 优先(不消耗 Claude 订阅额度),此时不读。
  const claudeSubscriptionUsage = useClaudeSubscriptionUsage(
    isClaudeSubscription && !isSubscriptionBridge && !isDeviceLinkRemote,
  );
  const latestTurnUsage = useLatestTurnUsageSummary(sessionId);
  // codex-oauth / cc+chatgpt bridge → ChatGPT 用量看板; cc+xai bridge → xAI 账户页;
  // cc Claude 订阅 → claude.ai 用量页; 其余(cc 网关 / codex-api)→ XD Proxy (tapsvc) 看板。
  const usageDashboardUrl = usesXaiQuotaForm
    ? XAI_ACCOUNT_URL
    : isCodexOauth || isChatgptBridge
      ? CODEX_USAGE_DASHBOARD_URL
      : isClaudeSubscription
        ? CLAUDE_USAGE_DASHBOARD_URL
        : PROXY_USAGE_DASHBOARD_URL;
  const usageDashboardLabel = t(
    usesXaiQuotaForm
      ? 'todaySpend.openXaiUsage'
      : isCodexOauth || isChatgptBridge
        ? 'todaySpend.openCodexUsage'
        : isClaudeSubscription
          ? 'todaySpend.openClaudeUsage'

        : 'todaySpend.openProxyUsage',
  );
  const [windowLabelNowMs, setWindowLabelNowMs] = React.useState(() => Date.now());

  React.useEffect(() => {
    // 订阅形态 (codex-oauth / cc+chatgpt bridge / claude 订阅) 的 reset 时间文案需要随时间刷新。
    if (!usesCodexQuotaForm && !isClaudeSubscription) return undefined;
    const interval = window.setInterval(() => {
      setWindowLabelNowMs(Date.now());
    }, 60_000);
    return () => window.clearInterval(interval);
  }, [usesCodexQuotaForm, isClaudeSubscription]);

  const handleClick = () => {
    void window.electronAPI.openExternal(usageDashboardUrl);
  };

  let labelNode: React.ReactNode;
  let tooltipNode: React.ReactNode = usageDashboardLabel;
  if (usesCodexQuotaForm) {
    // codex-oauth 与 cc+chatgpt/ bridge 共用同一 ChatGPT 账户,复用同一套限额窗口 + 价值估算渲染。
    const chipSegments = getCodexChipSegments(accountUsage, t, windowLabelNowMs);
    if (typeof sessionEstimatedValueUsd === 'number' && sessionEstimatedValueUsd > 0) {
      chipSegments.push(t('todaySpend.codex.sessionValueLabel', {
        cost: `$${sessionEstimatedValueUsd.toFixed(2)}`,
      }));
    }
    labelNode = chipSegments.length > 0
      ? renderSegmentedLabel(chipSegments)
      : <span className="tabular-nums opacity-60">$</span>;
    tooltipNode = buildCodexTooltipNode(
      accountUsage,
      sessionTokens,
      sessionEstimatedValueUsd,
      t,
      usageDashboardLabel,
      windowLabelNowMs,
      latestTurnUsage,
    );
  } else if (usesXaiQuotaForm) {
    // xAI 无订阅窗口数据源:主 chip 只显示本会话价值估算,限流细节(若 bridge 抓到)进 tooltip。
    const chipSegments: string[] = [];
    if (typeof sessionEstimatedValueUsd === 'number' && sessionEstimatedValueUsd > 0) {
      chipSegments.push(t('todaySpend.codex.sessionValueLabel', {
        cost: `$${sessionEstimatedValueUsd.toFixed(2)}`,
      }));
    }
    labelNode = chipSegments.length > 0
      ? renderSegmentedLabel(chipSegments)
      : <span className="tabular-nums opacity-60">$</span>;
    tooltipNode = buildXaiTooltipNode(
      xaiRateLimit,
      sessionTokens,
      sessionEstimatedValueUsd,
      t,
      usageDashboardLabel,
      latestTurnUsage,
    );
  } else if (isClaudeSubscription) {
    // Claude 订阅形态 (方案 B): chip 显示「剩余时长 剩余%」倒计时段 + 本会话价值,
    // 倒计时由 windowLabelNowMs 驱动 (60s interval 走动); tooltip 保留精确时间。
    const chipSegments = getClaudeChipSegments(claudeSubscriptionUsage, modelId, t, windowLabelNowMs);
    if (typeof sessionEstimatedValueUsd === 'number' && sessionEstimatedValueUsd > 0) {
      chipSegments.push(t('todaySpend.claude.sessionValueLabel', {
        cost: `$${sessionEstimatedValueUsd.toFixed(2)}`,
      }));
    }
    labelNode = chipSegments.length > 0
      ? renderSegmentedLabel(chipSegments)
      : <span className="tabular-nums opacity-60">$</span>;
    tooltipNode = buildClaudeSubscriptionTooltipNode(
      claudeSubscriptionUsage,
      modelId,
      sessionEstimatedValueUsd,
      t,
      usageDashboardLabel,
      latestTurnUsage,
    );
  } else {
    const slots = computeMetricSlots(claudeQuota, sessionCostUsd, t);
    const chipSegments = getGatewayChipSegments(slots);
    // tooltip 主体: 主 chip 未显示且可用的 metric, 同样按固定顺序
    const tooltipMetricLines = METRIC_KEYS.filter(
      (k) => !PRIMARY_GATEWAY_METRICS.includes(k) && slots[k].available,
    ).map((k) => slots[k].tooltipLabel ?? slots[k].label);

    const tooltipLines: string[] = [];
    // server-side endpoint 独立可能失败, 各自挂掉时都加一行 ⚠️ 提示, 让用户知道
    // 那段是端点降级而非数据为 0
    if (!claudeQuota) {
      tooltipLines.push(t('todaySpend.tooltip.monthlyUnavailable'));
    } else if (claudeQuota.todaySpend === null) {
      tooltipLines.push(t('todaySpend.tooltip.dailyUnavailable'));
    }
    if (slots.session.available) {
      tooltipLines.push(slots.session.tooltipLabel ?? slots.session.label);
    }
    tooltipLines.push(...tooltipMetricLines);
    appendLatestTurnUsageLines(tooltipLines, latestTurnUsage, t);
    // 链接行始终在最底, 用空行隔开
    if (tooltipLines.length > 0) tooltipLines.push('');
    tooltipLines.push(usageDashboardLabel);
    tooltipNode = buildTooltipNode(tooltipLines);

    // chip 空 (用户全没选 / 数据全不可用): 显示 "$" 占位符, 保持 hover 区可点
    if (chipSegments.length === 0) {
      labelNode = <span className="tabular-nums opacity-60">$</span>;
    } else {
      // 之前用纯字符串 ".join(' · ')" — middle dot · 落在 x-height, 周围混着 cap-height
      // 大写字母 + 数字 + $/k, 视觉上文字"高低不齐"。改成结构化渲染:
      //   - 段间用 CSS 横线 (border-l h-3) 当分隔符 — 高度与字号绑定, 视觉上像条直线
      //   - 文字段内统一加 tabular-nums + slashed-zero, 数字等宽对齐
      labelNode = renderSegmentedLabel(chipSegments);
    }
  }

  // Claude 订阅告警态: 影响当前会话的窗口 (5h / 总周限 / 当前模型 scoped) 任一逼近 /
  // 打满, 或 headers 报 rejected → chip 变 error 色 (语义豁免色, 跨主题一致)。
  const claudeSubscriptionAlerting = isClaudeSubscription
    && isClaudeSubscriptionAlerting(claudeSubscriptionUsage, modelId);

  // 与 ContextCapacityRing 视觉对齐 (h-5 = 20px) + reset button UA 默认 padding/border。
  // tabular-nums 让 "$306 / $1.2k" 这类数字段的字符宽度等宽, 段间数字落点对齐。
  const buttonClass = cn(
    'inline-flex h-5 shrink-0 items-center',
    'text-[12px] font-medium leading-none tabular-nums',
    claudeSubscriptionAlerting
      ? 'text-[var(--error-fg)] hover:text-[var(--error-fg-strong)]'
      : 'text-[var(--msg-tool-card-chevron)] hover:text-foreground',
    'border-0 bg-transparent p-0 m-0',
    'transition-colors',
    'focus:outline-none',
  );

  return (
    <div className="inline-flex h-5 shrink-0 items-center gap-3">
      <Tip text={tooltipNode}>
        <button
          type="button"
          onClick={handleClick}
          className={buttonClass}
          aria-label={usageDashboardLabel}
        >
          {labelNode}
        </button>
      </Tip>
    </div>
  );
}
