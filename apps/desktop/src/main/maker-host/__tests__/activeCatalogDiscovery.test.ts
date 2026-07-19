/**
 * active-catalog 的 discovered augment 单测 —— 验证同一份 Codex 快照同时投影原生 Codex 与
 * Claude bridge:新 id 被加入、名称/排序同源、legacy 静态 id first-wins、空/清空安全。
 *
 * 2026-07-19 统一重构后 bundled 的 openai 是动态清单供应商(零静态模型):codex 注册表
 * 快照就是清单本身;「静态 first-wins」语义只对 legacy 远端目录(仍带静态条目的 v1
 * OSS 文件)生效,用 fixture 模拟。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { BUNDLED_CATALOG, type Catalog, type CatalogModel } from '@lizi/model-providers';

import { getActiveCatalog, setActiveCatalog, setDiscoveredCodexModels } from '../active-catalog.js';

function openaiIds(agent: 'claude-code' | 'codex'): string[] {
  const openai = getActiveCatalog().providers.find((p) => p.id === 'openai');
  return (openai?.models[agent] ?? []).map((m) => m.id);
}

const fake = (id: string, sortOrder = 16.999): CatalogModel => ({
  id,
  name: `Discovered ${id}`,
  group: 'gpt',
  sortOrder,
  contextWindow: 400000,
  efforts: ['low', 'high', 'xhigh'],
  defaultEffort: 'high',
  status: 'active',
  defaultEnabled: true,
});

/** legacy v1 远端目录形态:openai 仍带静态 codex/bridge 条目(过渡期兼容)。 */
function legacyCatalog(): Catalog {
  const legacy = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
  const openai = legacy.providers.find((p) => p.id === 'openai');
  if (!openai) throw new Error('fixture missing openai');
  openai.models.codex = [
    { id: 'gpt-5.5', name: 'GPT-5.5', group: 'gpt', sortOrder: 20, contextWindow: 272000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', status: 'active' },
  ];
  openai.models['claude-code'] = [
    { id: 'chatgpt/gpt-5.5', name: 'GPT-5.5 (ChatGPT 订阅)', group: 'gpt', sortOrder: 25, contextWindow: 123456, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', status: 'active' },
  ];
  return legacy;
}

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

  it('动态清单契约:注册表快照即清单本身(bundled 零静态,快照全量呈现)', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setDiscoveredCodexModels([fake('gpt-5.7', 17), fake('gpt-5.5', 20)]);
    expect(openaiIds('codex')).toEqual(['gpt-5.7', 'gpt-5.5']);
    expect(openaiIds('claude-code')).toEqual(['chatgpt/gpt-5.7', 'chatgpt/gpt-5.5']);
    // 快照的元数据就是权威(没有静态条目掩盖)。
    const openai = getActiveCatalog().providers.find((p) => p.id === 'openai');
    expect((openai?.models.codex ?? []).find((m) => m.id === 'gpt-5.5')?.contextWindow).toBe(400000);
  });

  it('legacy v1 远端目录的静态段被忽略(清单来源唯一化:注册表快照就是全部)', () => {
    setActiveCatalog(legacyCatalog());
    setDiscoveredCodexModels([fake('gpt-5.5')]);
    const ids = openaiIds('codex');
    expect(ids).toEqual(['gpt-5.5']);
    const openai = getActiveCatalog().providers.find((p) => p.id === 'openai');
    const m55 = (openai?.models.codex ?? []).find((m) => m.id === 'gpt-5.5');
    // 元数据以注册表快照为准(400000),legacy 静态条目(272000)不复活
    expect(m55?.contextWindow).toBe(400000);
  });

  it('paired projection 使用同一纯名称和 sortOrder,且按 sortOrder 稳定排序', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setDiscoveredCodexModels([fake('gpt-5.8', 18), fake('gpt-5.7', 17)]);
    const openai = getActiveCatalog().providers.find((p) => p.id === 'openai');
    const codex = (openai?.models.codex ?? []).find((m) => m.id === 'gpt-5.7');
    const bridge = (openai?.models['claude-code'] ?? []).find((m) => m.id === 'chatgpt/gpt-5.7');
    expect(bridge?.name).toBe(codex?.name);
    expect(bridge?.sortOrder).toBe(codex?.sortOrder);
    expect(bridge?.name).not.toContain('订阅');

    // sortOrder 17 的 5.7 排在 18 的 5.8 之前(与注入顺序无关)。
    expect(openaiIds('codex')).toEqual(['gpt-5.7', 'gpt-5.8']);
    expect(openaiIds('claude-code')).toEqual(['chatgpt/gpt-5.7', 'chatgpt/gpt-5.8']);
  });

  it('legacy v1 远端目录 + 空 discovered → openai 两个 tab 都为空(静态 bridge 不复活)', () => {
    setActiveCatalog(legacyCatalog());
    setDiscoveredCodexModels([]);
    expect(openaiIds('codex')).toEqual([]);
    expect(openaiIds('claude-code')).toEqual([]);
  });

  it('bridge tab 默认隐藏策略:chatgpt/gpt-5.4(-mini)默认收起,其余继承 codex 侧可见性', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setDiscoveredCodexModels([fake('gpt-5.5', 20), fake('gpt-5.4', 21), fake('gpt-5.4-mini', 22)]);
    const openai = getActiveCatalog().providers.find((p) => p.id === 'openai');
    const cc = openai?.models['claude-code'] ?? [];
    expect(cc.find((m) => m.id === 'chatgpt/gpt-5.4')?.defaultEnabled).toBe(false);
    expect(cc.find((m) => m.id === 'chatgpt/gpt-5.4-mini')?.defaultEnabled).toBe(false);
    expect(cc.find((m) => m.id === 'chatgpt/gpt-5.5')?.defaultEnabled).toBe(true);
  });

  it('空 discovered + bundled 零静态 → openai 两个 tab 都为空(不用假数据冒充)', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setDiscoveredCodexModels([]);
    expect(openaiIds('codex')).toEqual([]);
    expect(openaiIds('claude-code')).toEqual([]);
  });
});
