/**
 * active-catalog 的 discovered augment 单测 —— 验证同一份 Codex 快照同时投影原生 Codex 与
 * Claude bridge:新 id 被加入、名称/排序同源、已有静态 id first-wins、空/清空安全。
 * 与 mapper 单测(codexModelDiscovery.test)合起来覆盖"下周出 5.6 自动进列表"全链路。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { BUNDLED_CATALOG, type Catalog, type CatalogModel } from '@lizi/model-providers';

import { getActiveCatalog, setActiveCatalog, setDiscoveredCodexModels } from '../active-catalog.js';

function openaiIds(agent: 'claude-code' | 'codex'): string[] {
  const openai = getActiveCatalog().providers.find((p) => p.id === 'openai');
  return (openai?.models[agent] ?? []).map((m) => m.id);
}

const fake = (id: string): CatalogModel => ({
  id,
  name: `Discovered ${id}`,
  group: 'gpt',
  sortOrder: 16.999,
  contextWindow: 400000,
  efforts: ['low', 'high', 'xhigh'],
  defaultEffort: 'high',
  status: 'active',
  defaultEnabled: true,
});

describe('active-catalog discovered augment', () => {
  afterEach(() => {
    // 复位全局状态,避免测试间串扰
    setActiveCatalog(BUNDLED_CATALOG);
    setDiscoveredCodexModels([]);
  });

  it('新 discovered id 同时进入 openai.codex 与 openai.claude-code bridge', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setDiscoveredCodexModels([fake('gpt-5.7')]);
    expect(openaiIds('codex')).toContain('gpt-5.7');
    expect(openaiIds('claude-code')).toContain('chatgpt/gpt-5.7');
  });

  it('additions-only:与静态同 id(gpt-5.5)不重复、不覆盖(first-wins)', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setDiscoveredCodexModels([fake('gpt-5.5')]);
    const ids = openaiIds('codex');
    expect(ids.filter((id) => id === 'gpt-5.5')).toHaveLength(1);
    const openai = getActiveCatalog().providers.find((p) => p.id === 'openai');
    const m55 = (openai?.models.codex ?? []).find((m) => m.id === 'gpt-5.5');
    // 静态元数据保留(contextWindow 272000),不被 discovered 的 400000 覆盖
    expect(m55?.contextWindow).toBe(272000);
  });

  it('paired projection 使用同一纯名称和 sortOrder,且新模型按 sortOrder 插入而非尾部 append', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setDiscoveredCodexModels([fake('gpt-5.7')]);
    const openai = getActiveCatalog().providers.find((p) => p.id === 'openai');
    const codex = (openai?.models.codex ?? []).find((m) => m.id === 'gpt-5.7');
    const bridge = (openai?.models['claude-code'] ?? []).find((m) => m.id === 'chatgpt/gpt-5.7');
    expect(bridge?.name).toBe(codex?.name);
    expect(bridge?.sortOrder).toBe(codex?.sortOrder);
    expect(bridge?.name).not.toContain('订阅');

    const codexIds = openaiIds('codex');
    expect(codexIds.indexOf('gpt-5.7')).toBeLessThan(codexIds.indexOf('gpt-5.6-sol'));
    const bridgeIds = openaiIds('claude-code');
    expect(bridgeIds.indexOf('chatgpt/gpt-5.7')).toBeLessThan(bridgeIds.indexOf('chatgpt/gpt-5.6-sol'));
  });

  it('校正旧远端目录已存在 bridge 的本地化名称和旧排序,但保留 runtime 能力', () => {
    const legacy = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const openai = legacy.providers.find((p) => p.id === 'openai');
    const oldBridge = openai?.models['claude-code']?.find((m) => m.id === 'chatgpt/gpt-5.5');
    if (!oldBridge) throw new Error('fixture missing bridge model');
    oldBridge.name = 'GPT-5.5 (ChatGPT 订阅)';
    oldBridge.sortOrder = 25;
    oldBridge.contextWindow = 123456;

    setActiveCatalog(legacy);
    setDiscoveredCodexModels([]);
    const activeOpenai = getActiveCatalog().providers.find((p) => p.id === 'openai');
    const bridge = activeOpenai?.models['claude-code']?.find((m) => m.id === 'chatgpt/gpt-5.5');
    expect(bridge).toMatchObject({ name: 'GPT-5.5', sortOrder: 20, contextWindow: 123456 });
  });

  it('空 discovered → 不含动态 id,但仍从静态 Codex 列表投影 bridge 兜底', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setDiscoveredCodexModels([]);
    expect(openaiIds('codex')).not.toContain('gpt-5.7');
    expect(openaiIds('claude-code')).toEqual(
      expect.arrayContaining(['chatgpt/gpt-5.6-sol', 'chatgpt/gpt-5.5', 'chatgpt/gpt-5.4']),
    );
  });
});
