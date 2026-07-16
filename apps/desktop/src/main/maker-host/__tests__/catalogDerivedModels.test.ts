/**
 * No-break 守卫(规则 10):模型清单 SSoT 从 maker-core 写死列表迁到目录 providers.json 后,
 * host 派生的 per-agent availableModels 必须**逐字逐序**复现迁移前的有效列表 ——
 *   - cc    = 旧 CLAUDE_MODELS ++ XD_ADDITION_MODEL
 *   - codex = 旧 CODEX_MODELS ++ CODEX_BUDGET_MODELS
 *
 * EXPECTED_* 是当前 host runtime 契约的**冻结快照**。它以迁移前那两段常量为基线,
 * 再叠加后续 catalog 的有意调整(例如 Fast 能力改成 per-provider)。任何对
 * providers.json / catalog-to-descriptors 的改动若改变了顺序、上下文窗口、effort、
 * effortDisplayNames、supportsFastMode 或 description,都会在这里炸出来。
 *
 * 注:`group` / `sortOrder` 是 2026-06-21「厂商分组数据化」新增的**纯展示**字段,迁移前
 * 的快照里没有。本守卫聚焦「原有运行时字段不回退」,故比对前先 strip 掉 group/sortOrder;
 * group/sortOrder 的取值单独在末尾断言。
 */

import { describe, it, expect } from 'vitest';

import { BUNDLED_CATALOG } from '@lizi/model-providers';
import type { ModelDescriptor } from '@lizi/maker-core';

import { deriveAvailableModels, refreshCatalogDerivedModels } from '../catalog-to-descriptors.js';

/** 剥掉新增的纯展示字段,只留迁移前就有的运行时字段做 no-break 比对。 */
function stripDisplayFields(models: ModelDescriptor[]): ModelDescriptor[] {
  return models.map((m) => {
    const copy = { ...m };
    delete copy.group;
    delete copy.sortOrder;
    return copy;
  });
}

// 迁移前 packages/maker-core/src/agents/claude-code/index.ts 的 CLAUDE_MODELS + 后续 catalog 有意新增项(8)。
const FROZEN_CLAUDE_MODELS: ModelDescriptor[] = [
  { id: 'claude-opus-4-8', displayName: 'Opus 4.8', description: 'Most capable, supports xhigh effort', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', supportsFastMode: true },
  { id: 'claude-opus-4-7', displayName: 'Opus 4.7', description: 'Most capable, supports xhigh effort', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', supportsFastMode: true },
  { id: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Most capable for ambitious work', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'high', supportsFastMode: true },
  { id: 'claude-sonnet-5', displayName: 'Sonnet 5', description: 'Latest Sonnet — fast and highly capable', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
  { id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'Most efficient for everyday tasks', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
  { id: 'claude-haiku-4-5', displayName: 'Haiku 4.5', description: 'Fastest for quick answers', contextWindow: 200_000, efforts: [], defaultEffort: null },
  { id: 'claude-fable-5', displayName: 'Fable 5', description: 'Most capable, supports xhigh effort', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
  { id: 'qwen/qwen3.7-max', displayName: 'Qwen 3.7 Max', description: 'Qwen 3.7 Max agentic coding model; thinking is provider-managed', contextWindow: 992_000, efforts: [], defaultEffort: null },
];

// 迁移前 apps/desktop/src/main/maker-host/index.ts 的 CODEX_BUDGET_MODELS(2)+ 后续 catalog 有意新增的 gpt-5.6 骨折两条(共 4)。
const FROZEN_CODEX_BUDGET_MODELS: ModelDescriptor[] = [
  { id: 'codex/gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: 'GPT-5.6-Sol (骨折价 codex 路由) for coding tasks', contextWindow: 372_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
  { id: 'codex/gpt-5.6-terra', displayName: 'GPT-5.6-Terra', description: 'GPT-5.6-Terra (骨折价 codex 路由) for coding tasks', contextWindow: 372_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
  { id: 'codex/gpt-5.5', displayName: 'GPT-5.5', description: 'GPT-5.5 (骨折价 codex 路由) for coding tasks', contextWindow: 272_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
  { id: 'codex/gpt-5.4', displayName: 'GPT-5.4', description: 'GPT-5.4 (骨折价 codex 路由) for coding tasks', contextWindow: 272_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
];

// XD 注入到 claude-code 的网关模型不声明 Fast;Codex 原生列表仍可声明。
const FROZEN_XD_BUDGET_MODELS: ModelDescriptor[] = [
  { id: 'codex/gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: 'GPT-5.6-Sol (骨折价 codex 路由) for coding tasks', contextWindow: 372_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
  { id: 'codex/gpt-5.6-terra', displayName: 'GPT-5.6-Terra', description: 'GPT-5.6-Terra (骨折价 codex 路由) for coding tasks', contextWindow: 372_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
  { id: 'codex/gpt-5.5', displayName: 'GPT-5.5', description: 'GPT-5.5 (骨折价 codex 路由) for coding tasks', contextWindow: 272_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
  { id: 'codex/gpt-5.4', displayName: 'GPT-5.4', description: 'GPT-5.4 (骨折价 codex 路由) for coding tasks', contextWindow: 272_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
];

// 迁移前 apps/desktop/src/main/maker-host/index.ts 的 XD_ADDITION_MODEL(注入 cc;含骨折两条)。
// 注:xd 网关 **claude-code 侧**条目的 supportsFastMode 在 6a957559d 中全部摘除(llm-proxy 网关
// 不支持 cc fast;codex 侧保留),该 commit 漏更新本守卫,此处按目录现状对齐 —— 骨折两条因此
// 不能复用 FROZEN_CODEX_BUDGET_MODELS(那是 codex 侧快照,仍带 fast)。
const FROZEN_XD_ADDITION_MODEL: ModelDescriptor[] = [
  { id: 'gpt-5.5', displayName: 'GPT-5.5', description: 'OpenAI Codex (GPT-5.5) for coding tasks', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
  { id: 'gpt-5.4', displayName: 'GPT-5.4', description: 'OpenAI Codex (GPT-5.4) for coding tasks', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
  { id: 'gpt-5.4-mini', displayName: 'GPT-5.4-Mini', description: 'Faster, lighter Codex variant — speed-optimized for quick edits', contextWindow: 272_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
  ...FROZEN_XD_BUDGET_MODELS,
  { id: 'moonshotai/kimi-k2.6', displayName: 'Kimi K2.6', description: 'Moonshot Kimi K2.6 agentic coding model; thinking is provider-managed', contextWindow: 262_144, efforts: [], defaultEffort: null },
  { id: 'z-ai/glm-5.1', displayName: 'GLM-5.1', description: 'Zhipu GLM-5.1 agentic coding model; thinking is provider-managed', contextWindow: 202_752, efforts: [], defaultEffort: null },
  { id: 'z-ai/glm-5.2', displayName: 'GLM-5.2', description: 'Zhipu GLM-5.2 agentic coding model; 1M context', contextWindow: 1_000_000, efforts: ['high', 'max'], defaultEffort: 'high' },
  { id: 'deepseek/deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', description: 'DeepSeek V4 Pro reasoning model; only high/max effective (low/medium→high, xhigh→max)', contextWindow: 1_048_576, efforts: ['high', 'max'], defaultEffort: 'high' },
  { id: 'deepseek/deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', description: 'DeepSeek V4 Flash efficiency-optimized MoE; only high/max effective', contextWindow: 1_048_576, efforts: ['high', 'max'], defaultEffort: 'high' },
  { id: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', description: 'Google Gemini 3.5 Flash — upgraded Flash with stronger reasoning', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
  { id: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro', description: 'Google Gemini 3.1 Pro Preview — deepest reasoning, multimodal', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
  { id: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash', description: 'Google Gemini 3 Flash Preview — fast multimodal reasoning', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
];

// 迁移前 packages/maker-core/src/agents/codex/index.ts 的 CODEX_MODELS(3)+ 后续 catalog 有意
// 新增的 gpt-5.6 订阅三条(Sol/Terra/Luna,官方 models_cache 元数据:372K 上下文、支持 fast)。
// gpt-5.4-mini 的 fast 已按官方口径摘除(models_cache 的 additional_speed_tiers 为空)。
const FROZEN_CODEX_MODELS: ModelDescriptor[] = [
  { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: 'Latest frontier agentic coding model', contextWindow: 372_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
  { id: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', description: 'Balanced agentic coding model for everyday work', contextWindow: 372_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
  { id: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', description: 'Fast and affordable agentic coding model', contextWindow: 372_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
  { id: 'gpt-5.5', displayName: 'GPT-5.5', description: 'OpenAI Codex (GPT-5.5) for coding tasks', contextWindow: 272_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
  { id: 'gpt-5.4', displayName: 'GPT-5.4', description: 'OpenAI Codex (GPT-5.4) for coding tasks', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
  { id: 'gpt-5.4-mini', displayName: 'GPT-5.4-Mini', description: 'Faster, lighter Codex variant — speed-optimized for quick edits', contextWindow: 272_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
];

// 迁移前注入 maker-core 后的有效列表(base ++ host additions,base-agent mergeCapabilityList 顺序)。
const EXPECTED_CC: ModelDescriptor[] = [...FROZEN_CLAUDE_MODELS, ...FROZEN_XD_ADDITION_MODEL];
const EXPECTED_CODEX: ModelDescriptor[] = [...FROZEN_CODEX_MODELS, ...FROZEN_CODEX_BUDGET_MODELS];

/**
 * 本守卫只覆盖**迁移前就有的模型**。「订阅直连」provider(chatgpt/ / xai/ 前缀,经 responses-bridge)
 * 是迁移之后新增的,不属于 pre-migration parity;它们各有专门单测(translate-request / codexModelDiscovery /
 * activeCatalogDiscovery / catalog.test 的 provider membership),此处过滤掉,避免每加一个订阅模型都要改本冻结表。
 */
function excludeSubscriptionModels(models: ModelDescriptor[]): ModelDescriptor[] {
  return models.filter((m) => !m.id.startsWith('chatgpt/') && !m.id.startsWith('xai/'));
}

describe('deriveAvailableModels — no-break parity with pre-migration hardcoded lists', () => {
  it('claude-code derived list (runtime fields) equals frozen CLAUDE_MODELS ++ XD_ADDITION_MODEL (byte + order)', () => {
    expect(stripDisplayFields(excludeSubscriptionModels(deriveAvailableModels(BUNDLED_CATALOG, 'claude-code')))).toEqual(EXPECTED_CC);
  });

  it('codex derived list (runtime fields) equals frozen CODEX_MODELS ++ CODEX_BUDGET_MODELS (byte + order)', () => {
    expect(stripDisplayFields(excludeSubscriptionModels(deriveAvailableModels(BUNDLED_CATALOG, 'codex')))).toEqual(EXPECTED_CODEX);
  });

  it('codex derived list includes xAI Grok subscription models outside the pre-migration parity set', () => {
    const grok = deriveAvailableModels(BUNDLED_CATALOG, 'codex').filter((m) => m.id.startsWith('xai/'));
    expect(stripDisplayFields(grok)).toEqual([
      { id: 'xai/grok-4.5', displayName: 'Grok 4.5', description: 'xAI Grok 4.5 新旗舰,编码/agent 任务最强,500k 上下文(SuperGrok 订阅直连)', contextWindow: 500_000, efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
      { id: 'xai/grok-4.3', displayName: 'Grok 4.3', description: 'xAI Grok 4.3 通用旗舰,1M 上下文(SuperGrok 订阅直连)', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
      { id: 'xai/grok-4.20', displayName: 'Grok 4.20 Reasoning', description: 'xAI Grok 4.20 推理版(SuperGrok 订阅直连)', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
      { id: 'xai/grok-code-fast', displayName: 'Grok Code Fast', description: 'xAI 编码模型 grok-code-fast,不支持思维深度调节(SuperGrok 订阅直连)', contextWindow: 256_000, efforts: [], defaultEffort: null },
    ]);
  });

  it('gpt-5.5 carries the per-agent contextWindow split (cc=1M / codex=272k)', () => {
    const cc = deriveAvailableModels(BUNDLED_CATALOG, 'claude-code').find((m) => m.id === 'gpt-5.5');
    const codex = deriveAvailableModels(BUNDLED_CATALOG, 'codex').find((m) => m.id === 'gpt-5.5');
    expect(cc?.contextWindow).toBe(1_000_000);
    expect(codex?.contextWindow).toBe(272_000);
  });

  it('dedups by id with first-seen (provider order) winning', () => {
    const cc = deriveAvailableModels(BUNDLED_CATALOG, 'claude-code');
    const ids = cc.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries group + sortOrder for grouping; same id → same group/sortOrder across agents', () => {
    const cc = deriveAvailableModels(BUNDLED_CATALOG, 'claude-code');
    const codex = deriveAvailableModels(BUNDLED_CATALOG, 'codex');
    const find = (list: ModelDescriptor[], id: string) => list.find((m) => m.id === id);

    // 每条都带 group + sortOrder(grouping 的数据来源)。
    for (const m of [...cc, ...codex]) {
      expect(typeof m.group, m.id).toBe('string');
      expect(typeof m.sortOrder, m.id).toBe('number');
    }

    // 抽查分组归属 + 跨 agent 一致。
    expect(find(cc, 'claude-opus-4-8')).toMatchObject({ group: 'anthropic', sortOrder: 1 });
    expect(find(cc, 'codex/gpt-5.5')).toMatchObject({ group: 'gpt-budget', sortOrder: 10 });
    expect(find(cc, 'gemini-3.5-flash')).toMatchObject({ group: 'google', sortOrder: 30 });
    expect(find(cc, 'qwen/qwen3.7-max')).toMatchObject({ group: 'china', sortOrder: 40 });
    expect(find(cc, 'gpt-5.5')).toMatchObject({ group: 'gpt', sortOrder: 20 });
    // gpt-5.5 在两个 agent 下 group/sortOrder 相同(只有 contextWindow 分叉)。
    expect(find(codex, 'gpt-5.5')).toMatchObject({ group: 'gpt', sortOrder: 20 });
  });

  it('runtime refresh replaces both agent model lists in place so existing sessions keep the live reference', () => {
    const claudeModels: ModelDescriptor[] = [{ ...FROZEN_CLAUDE_MODELS[0], id: 'stale-claude' }];
    const codexModels: ModelDescriptor[] = [{ ...FROZEN_CODEX_MODELS[0], id: 'stale-codex' }];
    const claudeRef = claudeModels;
    const codexRef = codexModels;
    const target = {
      getCapabilities(agent: 'claude-code' | 'codex') {
        return { availableModels: agent === 'claude-code' ? claudeModels : codexModels };
      },
    };

    refreshCatalogDerivedModels(target, BUNDLED_CATALOG);

    expect(claudeModels).toBe(claudeRef);
    expect(codexModels).toBe(codexRef);
    expect(claudeModels).toEqual(deriveAvailableModels(BUNDLED_CATALOG, 'claude-code'));
    expect(codexModels).toEqual(deriveAvailableModels(BUNDLED_CATALOG, 'codex'));
  });
});
