import { describe, expect, it } from 'vitest';
import {
  summarizeAccountRateLimits,
  summarizeContextUsage,
  summarizeSessionSpend,
} from '../sessionControls.js';

describe('shared session usage summaries', () => {
  it('summarizes session spend for shared header and controls surfaces', () => {
    expect(summarizeSessionSpend({
      contextTokens: 16000,
      contextWindow: 200000,
      totalCostUsd: 0.024,
      totalTokenUsage: 42000,
    })).toEqual({
      available: true,
      detail: '本会话 $0.02 · 42k tokens · 上下文 16k / 200k · 8%',
      title: 'Session spend',
    });

    expect(summarizeSessionSpend(null)).toEqual({
      available: false,
      detail: '暂无会话用量',
      title: 'Session spend',
    });
  });

  it('summarizes context usage payloads with graceful fallbacks', () => {
    expect(summarizeContextUsage(null)).toEqual({
      title: 'Context usage',
      detail: '暂无上下文数据',
      rows: [],
    });

    expect(summarizeContextUsage({
      totalTokens: 90000,
      rawMaxTokens: 200000,
    })).toMatchObject({
      title: 'Context usage',
      detail: '90,000 / 200,000 tokens · 45%',
    });
  });
});

describe('summarizeAccountRateLimits', () => {
  // 2026-07-12 12:00:00 UTC 固定基准,避免用例受运行时钟影响。
  const NOW_MS = Date.UTC(2026, 6, 12, 12, 0, 0);

  it('renders window rows with labels derived from upstream windowMinutes (5h + weekly)', () => {
    const sameDayReset = Math.floor(NOW_MS / 1000) + 2 * 60 * 60;
    const summary = summarizeAccountRateLimits({
      planType: 'plus',
      primary: { usedPercent: 40, windowMinutes: 300, resetsAt: sameDayReset },
      secondary: { usedPercent: 12.5, windowMinutes: 10080 },
      rateLimitReachedType: null,
    }, NOW_MS);
    expect(summary).not.toBeNull();
    expect(summary!.rows[0]).toEqual({ label: '套餐', value: 'Plus' });
    expect(summary!.rows[1].label).toBe('5h');
    expect(summary!.rows[1].value).toContain('剩余 60%');
    expect(summary!.rows[1].value).toContain('已用 40%');
    expect(summary!.rows[1].value).toContain('重置');
    expect(summary!.rows[2]).toEqual({ label: '周', value: '剩余 87.5% · 已用 12.5%' });
  });

  it('follows upstream window composition instead of assuming 5h exists (weekly-only)', () => {
    const summary = summarizeAccountRateLimits({
      primary: { usedPercent: 30, windowMinutes: 10080 },
      secondary: null,
    }, NOW_MS);
    expect(summary!.rows).toEqual([{ label: '周', value: '剩余 70% · 已用 30%' }]);
  });

  it('falls back to a neutral window label when upstream omits duration and reset', () => {
    const summary = summarizeAccountRateLimits({
      primary: { usedPercent: 99.5 },
    }, NOW_MS);
    expect(summary!.rows).toEqual([{ label: '限额', value: '剩余 0.5% · 已用 99.5%' }]);
  });

  it('derives day-scale labels and flags non-credit limit-reached states', () => {
    const summary = summarizeAccountRateLimits({
      primary: { usedPercent: 100, windowMinutes: 3 * 24 * 60 },
      rateLimitReachedType: 'rate_limit_reached',
    }, NOW_MS);
    expect(summary!.rows[0].label).toBe('3天');
    expect(summary!.rows[1]).toEqual({ label: '状态', value: '已触发账号限额' });

    const creditsOnly = summarizeAccountRateLimits({
      primary: { usedPercent: 10, windowMinutes: 300 },
      rateLimitReachedType: 'workspace_owner_credits_depleted',
    }, NOW_MS);
    expect(creditsOnly!.rows.some((row) => row.label === '状态')).toBe(false);
  });

  it('returns null for unusable payloads so callers can hide the section', () => {
    expect(summarizeAccountRateLimits(null, NOW_MS)).toBeNull();
    expect(summarizeAccountRateLimits('nope', NOW_MS)).toBeNull();
    expect(summarizeAccountRateLimits({}, NOW_MS)).toBeNull();
    expect(summarizeAccountRateLimits({ primary: { windowMinutes: 300 } }, NOW_MS)).toBeNull();
  });
});
