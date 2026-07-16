/**
 * providerModelMemory.test.ts
 * ---------------------------------------------------------------------------
 * 回归 state/providerModelMemory.ts 的核心约定:
 *   1. 默认无记录 → getProviderModelChoice 返回 undefined
 *   2. set/get 往返 + localStorage 持久化(模拟 app 重启后恢复)
 *   3. 按 (agent, providerId) 分槽:同一来源 'xd' 在 cc / codex 下互不覆盖
 *   4. 同值写入短路(不抛,值保持)
 *   5. 空 providerId / model / effort 入参被静默忽略
 *   6. schema 损坏的 localStorage → 静默回退空表,不抛
 *
 * 项目 vitest env=node,无 window。沿用 newMakerDraft.test.ts 的最小 localStorage stub。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

class MemLocalStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, v);
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}

let memStorage: MemLocalStorage;

beforeEach(() => {
  memStorage = new MemLocalStorage();
  vi.stubGlobal('window', { localStorage: memStorage });
  vi.stubGlobal('localStorage', memStorage);
  vi.resetModules();
});

async function loadModule() {
  return await import('@/state/providerModelMemory');
}

describe('providerModelMemory store', () => {
  it('默认无记录:getProviderModelChoice 返回 undefined', async () => {
    const { getProviderModelChoice } = await loadModule();
    expect(getProviderModelChoice('claude-code', 'xd')).toBeUndefined();
    expect(getProviderModelChoice('codex', 'openai')).toBeUndefined();
  });

  it('set/get 往返 + 跨重启持久化', async () => {
    const m1 = await loadModule();
    m1.setProviderModelChoice('claude-code', 'anthropic', 'claude-opus-4-8', 'high');
    expect(m1.getProviderModelChoice('claude-code', 'anthropic')).toEqual({
      model: 'claude-opus-4-8',
      effort: 'high',
    });

    // 模拟 app 重启(重置模块缓存后重新从 localStorage 加载)
    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.getProviderModelChoice('claude-code', 'anthropic')).toEqual({
      model: 'claude-opus-4-8',
      effort: 'high',
    });
  });

  it('按 (agent, providerId) 分槽:xd 在 cc / codex 下互不覆盖', async () => {
    const m = await loadModule();
    m.setProviderModelChoice('claude-code', 'xd', 'claude-sonnet-4-6', 'medium');
    m.setProviderModelChoice('codex', 'xd', 'gpt-5.4', 'high');
    expect(m.getProviderModelChoice('claude-code', 'xd')).toEqual({
      model: 'claude-sonnet-4-6',
      effort: 'medium',
    });
    expect(m.getProviderModelChoice('codex', 'xd')).toEqual({
      model: 'gpt-5.4',
      effort: 'high',
    });
  });

  it('覆盖写:同一槽再次写入用新值', async () => {
    const m = await loadModule();
    m.setProviderModelChoice('claude-code', 'xd', 'claude-opus-4-8', 'high');
    m.setProviderModelChoice('claude-code', 'xd', 'claude-haiku-4-5', 'low');
    expect(m.getProviderModelChoice('claude-code', 'xd')).toEqual({
      model: 'claude-haiku-4-5',
      effort: 'low',
    });
  });

  it('同值写入短路:值保持不变,不抛', async () => {
    const m = await loadModule();
    m.setProviderModelChoice('codex', 'openai', 'gpt-5.4', 'high');
    expect(() => m.setProviderModelChoice('codex', 'openai', 'gpt-5.4', 'high')).not.toThrow();
    expect(m.getProviderModelChoice('codex', 'openai')).toEqual({ model: 'gpt-5.4', effort: 'high' });
  });

  it('空 providerId / model / effort 入参被忽略', async () => {
    const m = await loadModule();
    m.setProviderModelChoice('claude-code', '', 'claude-opus-4-8', 'high');
    m.setProviderModelChoice('claude-code', 'anthropic', '', 'high');
    m.setProviderModelChoice('claude-code', 'anthropic', 'claude-opus-4-8', '');
    expect(m.getProviderModelChoice('claude-code', '')).toBeUndefined();
    expect(m.getProviderModelChoice('claude-code', 'anthropic')).toBeUndefined();
  });

  it('schema 损坏的 localStorage → 静默回退空表,不抛', async () => {
    memStorage.setItem('xdt:providerModelMemory:v2', '{ not valid json');
    vi.resetModules();
    const { getProviderModelChoice } = await loadModule();
    expect(getProviderModelChoice('claude-code', 'anthropic')).toBeUndefined();
  });
});

describe('providerModelMemory v2 —— (agent, provider, model) 多槽 effort', () => {
  it('同一来源不同模型各记各的 effort,lastModel 切换不覆盖旧模型 effort', async () => {
    const m = await loadModule();
    m.setProviderModelChoice('claude-code', 'anthropic', 'claude-opus-4-8', 'high');
    m.setProviderModelChoice('claude-code', 'anthropic', 'claude-haiku-4-5', 'low');
    // opus 的 high 不因后写 haiku 而丢失
    expect(m.getProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8')).toBe('high');
    expect(m.getProviderModelEffort('claude-code', 'anthropic', 'claude-haiku-4-5')).toBe('low');
    // getProviderModelChoice 返回该来源 lastModel + 其 effort
    expect(m.getProviderModelChoice('claude-code', 'anthropic')).toEqual({
      model: 'claude-haiku-4-5',
      effort: 'low',
    });
  });

  it('同一 model id 跨来源各记各的 effort(opus 在 anthropic=high / xd=medium)', async () => {
    const m = await loadModule();
    m.setProviderModelChoice('claude-code', 'anthropic', 'claude-opus-4-8', 'high');
    m.setProviderModelChoice('claude-code', 'xd', 'claude-opus-4-8', 'medium');
    expect(m.getProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8')).toBe('high');
    expect(m.getProviderModelEffort('claude-code', 'xd', 'claude-opus-4-8')).toBe('medium');
  });

  it('getProviderModelEffort:未记录模型 / 未记录来源 / 空参 → undefined', async () => {
    const m = await loadModule();
    m.setProviderModelChoice('codex', 'openai', 'gpt-5.5', 'high');
    expect(m.getProviderModelEffort('codex', 'openai', 'gpt-5.5')).toBe('high');
    expect(m.getProviderModelEffort('codex', 'openai', 'unknown-model')).toBeUndefined();
    expect(m.getProviderModelEffort('codex', 'xd', 'gpt-5.5')).toBeUndefined();
    expect(m.getProviderModelEffort('codex', '', 'gpt-5.5')).toBeUndefined();
    expect(m.getProviderModelEffort('codex', 'openai', '')).toBeUndefined();
  });

  it('多模型 effort 跨重启持久化(v2)', async () => {
    const m1 = await loadModule();
    m1.setProviderModelChoice('claude-code', 'anthropic', 'claude-opus-4-8', 'high');
    m1.setProviderModelChoice('claude-code', 'anthropic', 'claude-haiku-4-5', 'low');
    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.getProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8')).toBe('high');
    expect(m2.getProviderModelEffort('claude-code', 'anthropic', 'claude-haiku-4-5')).toBe('low');
  });

  it('迁移历史 v1 单槽 → v2(lastModel + 该模型 effort 都可恢复)', async () => {
    memStorage.setItem(
      'xdt:providerModelMemory:v1',
      JSON.stringify({
        'claude-code:anthropic': { model: 'claude-opus-4-8', effort: 'xhigh' },
        'codex:openai': { model: 'gpt-5.5', effort: 'medium' },
      }),
    );
    vi.resetModules();
    const m = await loadModule();
    expect(m.getProviderModelChoice('claude-code', 'anthropic')).toEqual({
      model: 'claude-opus-4-8',
      effort: 'xhigh',
    });
    expect(m.getProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8')).toBe('xhigh');
    expect(m.getProviderModelEffort('codex', 'openai', 'gpt-5.5')).toBe('medium');
  });

  it('v2 在场时忽略 v1(不回退迁移)', async () => {
    memStorage.setItem(
      'xdt:providerModelMemory:v2',
      JSON.stringify({
        'claude-code:anthropic': {
          lastModel: 'claude-opus-4-8',
          effortByModel: { 'claude-opus-4-8': 'high' },
        },
      }),
    );
    memStorage.setItem(
      'xdt:providerModelMemory:v1',
      JSON.stringify({ 'claude-code:anthropic': { model: 'claude-haiku-4-5', effort: 'low' } }),
    );
    vi.resetModules();
    const m = await loadModule();
    expect(m.getProviderModelChoice('claude-code', 'anthropic')).toEqual({
      model: 'claude-opus-4-8',
      effort: 'high',
    });
  });

  it('v2 脏数据:非法 effort 条目过滤 / effortByModel 空槽丢弃 / 缺 lastModel 仍可查 effort', async () => {
    memStorage.setItem(
      'xdt:providerModelMemory:v2',
      JSON.stringify({
        'claude-code:anthropic': {
          lastModel: 'claude-opus-4-8',
          effortByModel: { 'claude-opus-4-8': 'high', bad: 42 }, // bad 非 string → 过滤
        },
        'claude-code:xd': { lastModel: 'x', effortByModel: {} }, // 空 effortByModel → 整槽丢弃
        'codex:openai': { effortByModel: { 'gpt-5.5': 'medium' } }, // 无 lastModel:effort 可查,choice undefined
      }),
    );
    vi.resetModules();
    const m = await loadModule();
    expect(m.getProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8')).toBe('high');
    expect(m.getProviderModelEffort('claude-code', 'anthropic', 'bad')).toBeUndefined();
    expect(m.getProviderModelChoice('claude-code', 'xd')).toBeUndefined();
    expect(m.getProviderModelEffort('codex', 'openai', 'gpt-5.5')).toBe('medium');
    expect(m.getProviderModelChoice('codex', 'openai')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fast 与 effort 同维度:per-(agent, provider, model)。回归本次 bug —— 「选中后 Fast ⚡ 掉档」
// 的根因是消费侧读了 provider-agnostic 的旧库;存储侧本就严格按 (agent, provider, model) 记 fast,
// 这里固化该不变量,确保多供应商同名模型(Anthropic 与 XD 网关都有 Opus)的 fast 互不串。
// ---------------------------------------------------------------------------
describe('providerModelMemory —— (agent, provider, model) fast 隔离', () => {
  it('同一 model id 跨来源各记各的 fast(opus 在 anthropic=on / xd=off)', async () => {
    const m = await loadModule();
    m.setProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8', true);
    m.setProviderModelFast('claude-code', 'xd', 'claude-opus-4-8', false);
    expect(m.getProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8')).toBe(true);
    expect(m.getProviderModelFast('claude-code', 'xd', 'claude-opus-4-8')).toBe(false);
  });

  it('fast 写入不动同槽 effort / lastModel;effort 写入不动 fast', async () => {
    const m = await loadModule();
    m.setProviderModelChoice('claude-code', 'anthropic', 'claude-opus-4-8', 'high');
    m.setProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8', true);
    // 两者并存,互不覆盖
    expect(m.getProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8')).toBe('high');
    expect(m.getProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8')).toBe(true);
    // 再写 effort,fast 保持
    m.setProviderModelChoice('claude-code', 'anthropic', 'claude-opus-4-8', 'low');
    expect(m.getProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8')).toBe(true);
  });

  it('getProviderModelFast:未记录模型 / 未记录来源 / 空参 → undefined(可与 false 区分,供 ?? 兜底)', async () => {
    const m = await loadModule();
    m.setProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8', false);
    expect(m.getProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8')).toBe(false);
    expect(m.getProviderModelFast('claude-code', 'anthropic', 'unknown-model')).toBeUndefined();
    expect(m.getProviderModelFast('claude-code', 'xd', 'claude-opus-4-8')).toBeUndefined();
    expect(m.getProviderModelFast('claude-code', '', 'claude-opus-4-8')).toBeUndefined();
    expect(m.getProviderModelFast('claude-code', 'anthropic', '')).toBeUndefined();
  });

  it('fast 跨重启持久化(v2)', async () => {
    const m1 = await loadModule();
    m1.setProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8', true);
    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.getProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8')).toBe(true);
  });
});
