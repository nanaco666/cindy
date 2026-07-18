import { describe, expect, it, vi } from 'vitest';

// jsStallWatchdog 顶层 import { AppState } from 'react-native':vitest node 环境
// 解析不了 RN 入口(flow 语法),按仓内惯例 mock 掉(本文件只测纯判定函数)。
vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: () => ({ remove: () => {} }),
  },
}));

import {
  evaluateJsStallTick,
  JS_STALL_REPORT_THRESHOLD_MS,
  JS_STALL_TICK_MS,
} from '@/debug/jsStallWatchdog';

describe('evaluateJsStallTick', () => {
  it('正常心跳间隙(≈周期)不上报', () => {
    expect(evaluateJsStallTick(0, JS_STALL_TICK_MS)).toBeNull();
    expect(evaluateJsStallTick(0, JS_STALL_TICK_MS + 500)).toBeNull();
  });

  it('间隙超出周期达到阈值才上报,返回停摆时长', () => {
    const threshold = JS_STALL_TICK_MS + JS_STALL_REPORT_THRESHOLD_MS;
    expect(evaluateJsStallTick(0, threshold - 1)).toBeNull();
    expect(evaluateJsStallTick(0, threshold)).toBe(JS_STALL_REPORT_THRESHOLD_MS);
    // 5 分钟级长停摆(microtask 风暴实测量级)如实返回时长
    expect(evaluateJsStallTick(0, JS_STALL_TICK_MS + 300_000)).toBe(300_000);
  });
});
