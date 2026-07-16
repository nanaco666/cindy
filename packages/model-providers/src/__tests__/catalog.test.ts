/**
 * 目录校验 + 与 maker-core per-agent 模型列表的覆盖对齐（不变量 4）。
 *
 * 目录是 per-agent 模型清单的 SSoT：模型按 agent 分组挂在 `provider.models[agent]` 下。
 * 本测试断言：(a) 目录解析 / 结构合法、(b) host 派生 availableModels 所依赖的覆盖关系
 * （每个 agent 列表里的每个 id 都至少有一个支持该 agent 的供应商提供它）。
 *
 * EXPECTED_*_IDS 来源（迁移前 maker-core 静态列表 ∪ host 注入项，迁移后即目录 per-agent 列表）：
 *   - claude-code = 旧 CLAUDE_MODELS ∪ XD_ADDITION_MODEL
 *   - codex      = 旧 CODEX_MODELS ∪ CODEX_BUDGET_MODELS ∪ xAI Grok 订阅直连
 */

import { describe, it, expect } from 'vitest';

import { BUNDLED_CATALOG, parseCatalog } from '../catalog.js';
import {
  buildRegistry,
  sourcesForModel,
  modelSupportsFastMode,
  sessionModelSupportsFastMode,
} from '../registry.js';
import type { AgentKind, Catalog, CatalogModel } from '../types.js';

// claude-code 会话用户可见模型 id 全集（23）
const EXPECTED_CC_IDS = [
  'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-fable-5',
  'qwen/qwen3.7-max',
  'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'codex/gpt-5.5', 'codex/gpt-5.4', 'codex/gpt-5.6-sol', 'codex/gpt-5.6-terra',
  'moonshotai/kimi-k2.6', 'z-ai/glm-5.1', 'z-ai/glm-5.2',
  'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash',
  'gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview',
];

// codex 会话用户可见模型 id 全集（14）
const EXPECTED_CODEX_IDS = [
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'codex/gpt-5.5', 'codex/gpt-5.4', 'codex/gpt-5.6-sol', 'codex/gpt-5.6-terra',
  'xai/grok-4.5', 'xai/grok-4.3', 'xai/grok-4.20', 'xai/grok-code-fast',
];

function provider(id: string) {
  const p = BUNDLED_CATALOG.providers.find((x) => x.id === id);
  if (!p) throw new Error(`missing provider ${id}`);
  return p;
}

/** 遍历目录里全部 (agent, model) 条目。 */
function* eachModel(): Generator<{ providerId: string; agent: AgentKind; model: CatalogModel }> {
  for (const p of BUNDLED_CATALOG.providers) {
    for (const agent of p.agents) {
      for (const model of p.models[agent] ?? []) yield { providerId: p.id, agent, model };
    }
  }
}

describe('bundled catalog validity', () => {
  it('parses & passes schema validation', () => {
    expect(() => parseCatalog(BUNDLED_CATALOG)).not.toThrow();
  });

  it('provides routing + a models[agent] array for every agent the provider declares', () => {
    for (const p of BUNDLED_CATALOG.providers) {
      for (const a of p.agents) {
        expect(p.routing[a], `${p.id} routing[${a}]`).toBeTruthy();
        expect(Array.isArray(p.models[a]), `${p.id} models[${a}]`).toBe(true);
      }
    }
  });

  it('has exactly the built-in providers', () => {
    expect(BUNDLED_CATALOG.providers.map((p) => p.id).sort()).toEqual(['anthropic', 'openai', 'xai', 'xd']);
    expect(BUNDLED_CATALOG.providers.every((p) => p.source === 'builtin')).toBe(true);
  });

  it('declares access separately from model names', () => {
    expect(provider('anthropic').access).toEqual({ kind: 'subscription', product: 'Claude.ai' });
    expect(provider('openai').access).toEqual({ kind: 'subscription', product: 'ChatGPT' });
    expect(provider('xai').access).toEqual({ kind: 'subscription', product: 'SuperGrok' });
    expect(provider('xd').access).toEqual({ kind: 'managed' });

    const openai = provider('openai');
    expect((openai.models['claude-code'] ?? []).map((m) => m.name)).toEqual([
      'GPT-5.5',
      'GPT-5.4',
      'GPT-5.4-Mini',
    ]);
    expect((openai.models.codex ?? []).slice(0, 3).map((m) => m.name)).toEqual([
      'GPT-5.6-Sol',
      'GPT-5.6-Terra',
      'GPT-5.6-Luna',
    ]);
    for (const p of BUNDLED_CATALOG.providers) {
      if (p.access?.kind !== 'subscription') continue;
      const product = p.access.product;
      for (const models of Object.values(p.models)) {
        expect(models?.every((m) => !m.name.includes(product) && !m.name.includes('订阅'))).toBe(true);
      }
    }
  });

  it('rejects malformed provider access metadata', () => {
    for (const access of [null, { kind: 'metered' }, { kind: 'subscription' }, { kind: 'subscription', product: ' ' }]) {
      const bad = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
      (bad.providers[0] as unknown as Record<string, unknown>).access = access;
      expect(() => parseCatalog(bad)).toThrow(/access/);
    }
  });

  // 标题 oneShot 用的最经济模型(host title-one-shot 消费)。锁定三家配置 + 校验指向真实模型 id。
  it('configures titleModel (most economical) for each builtin provider', () => {
    expect(provider('anthropic').titleModel).toBe('claude-haiku-4-5');
    expect(provider('openai').titleModel).toBe('gpt-5.4-mini');
    expect(provider('xd').titleModel).toBe('gpt-5.4-mini');
    for (const p of BUNDLED_CATALOG.providers) {
      if (!p.titleModel) continue;
      const known = p.agents.some((a) => (p.models[a] ?? []).some((m) => m.id === p.titleModel));
      expect(known, `${p.id} titleModel '${p.titleModel}' must exist in its models`).toBe(true);
    }
  });

  it('models are grouped per-agent (no flat array, no rogue agent keys)', () => {
    for (const p of BUNDLED_CATALOG.providers) {
      expect(Array.isArray(p.models), `${p.id} models must be a per-agent map`).toBe(false);
      // 不应出现该 provider 不支持的 agent 键。
      for (const key of Object.keys(p.models)) {
        expect(p.agents, `${p.id} stray models[${key}]`).toContain(key);
      }
    }
  });
});

/**
 * 路由服务范围(modelPrefixes)契约 —— issue #886 的长期防线。
 *
 * agent CLI 除主模型请求外还会发内部辅助调用(cc 权限 auto 模式的安全分类器、标题等,
 * wire model 为 claude-* 小模型)。若某供应商的模型清单**整体**活在 `<ns>/` 命名空间
 * (桥接型订阅直连,如 xai/ / chatgpt/),它的上游只认自家模型 —— per-session 路由把
 * 辅助请求也拽过去必然 4xx,分类器 fail-closed 后该会话所有工具调用被拦。
 *
 * 因此强制:这类供应商的路由必须声明 modelPrefixes(路由层据此把范围外请求放回默认
 * 路由)。**新增订阅直连型供应商时忘声明,本测试直接失败** —— 运营动作(往目录加
 * 厂商/模型)不需要理解路由器内部,数据不完整由测试兜住。
 */
describe('routing modelPrefixes 服务范围契约 (issue #886)', () => {
  it('模型清单整体带命名空间前缀的 (provider, agent) 必须声明 modelPrefixes,且覆盖全部模型 id', () => {
    for (const p of BUNDLED_CATALOG.providers) {
      for (const agent of p.agents) {
        const models = p.models[agent] ?? [];
        if (models.length === 0) continue;
        const allNamespaced = models.every((m) => m.id.includes('/'));
        if (!allNamespaced) continue; // 混合/裸 id 供应商(网关等)= universal,不强制
        const prefixes = p.routing[agent]?.modelPrefixes;
        expect(
          prefixes && prefixes.length > 0,
          `${p.id} routing[${agent}] 的模型全部在命名空间下,必须声明 modelPrefixes(否则会话内 claude-* 辅助请求会被误路由,复现 #886)`,
        ).toBe(true);
        for (const m of models) {
          expect(
            (prefixes ?? []).some((prefix) => m.id.startsWith(prefix)),
            `${p.id} routing[${agent}].modelPrefixes 未覆盖模型 '${m.id}'(该模型的请求会被范围门错误放回默认路由)`,
          ).toBe(true);
        }
      }
    }
  });

  it('声明的前缀必须是 `<ns>/` 命名空间形态 —— 结构上保证 claude-* 裸 wire model 永不命中', () => {
    for (const p of BUNDLED_CATALOG.providers) {
      for (const agent of p.agents) {
        for (const prefix of p.routing[agent]?.modelPrefixes ?? []) {
          expect(prefix, `${p.id} routing[${agent}] prefix '${prefix}'`).toMatch(/^[a-zA-Z0-9_-]+\/$/);
        }
      }
    }
  });

  it('parseCatalog 拒绝非命名空间形态的 modelPrefixes(如裸 "claude")', () => {
    const bad = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const xai = bad.providers.find((p) => p.id === 'xai');
    if (!xai) throw new Error('missing xai provider');
    xai.routing['claude-code'] = { ...xai.routing['claude-code']!, modelPrefixes: ['claude'] };
    expect(() => parseCatalog(bad)).toThrow(/modelPrefixes/);
  });

  it('parseCatalog 拒绝空数组 modelPrefixes(声明了就必须有内容)', () => {
    const bad = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const xai = bad.providers.find((p) => p.id === 'xai');
    if (!xai) throw new Error('missing xai provider');
    xai.routing['claude-code'] = { ...xai.routing['claude-code']!, modelPrefixes: [] };
    expect(() => parseCatalog(bad)).toThrow(/modelPrefixes/);
  });
});

describe('coverage of per-agent model lists (invariant 4)', () => {
  // 用「全部 builtin 连上」的视角断言覆盖（连接状态不影响目录覆盖能力）
  const views = buildRegistry(BUNDLED_CATALOG, { anthropic: true, openai: true, xai: true, xd: true });

  it('every claude-code model is offered by some cc-supporting provider', () => {
    for (const id of EXPECTED_CC_IDS) {
      expect(sourcesForModel(views, id, 'claude-code').length, `cc/${id}`).toBeGreaterThan(0);
    }
  });

  it('every codex model is offered by some codex-supporting provider', () => {
    for (const id of EXPECTED_CODEX_IDS) {
      expect(sourcesForModel(views, id, 'codex').length, `codex/${id}`).toBeGreaterThan(0);
    }
  });

  it('claude models have two cc sources (Anthropic + XD); gpt has one cc source (XD)', () => {
    expect(sourcesForModel(views, 'claude-opus-4-8', 'claude-code').map((p) => p.id).sort()).toEqual(['anthropic', 'xd']);
    expect(sourcesForModel(views, 'gpt-5.5', 'claude-code').map((p) => p.id)).toEqual(['xd']);
  });

  it('gpt has two codex sources (OpenAI + XD); budget codex/ only XD', () => {
    expect(sourcesForModel(views, 'gpt-5.5', 'codex').map((p) => p.id).sort()).toEqual(['openai', 'xd']);
    expect(sourcesForModel(views, 'codex/gpt-5.5', 'codex').map((p) => p.id)).toEqual(['xd']);
  });

  it('xai/grok models are available to codex only through xAI', () => {
    expect(sourcesForModel(views, 'xai/grok-4.3', 'codex').map((p) => p.id)).toEqual(['xai']);
  });
});

describe('fast-mode model capability (model-level)', () => {
  // 模型理论支持 fast 的全集（supportsFastMode:true 的 15 个 id）。Anthropic 侧仅 Opus 三代
  // （Fable 5 不支持 fast，已去除 → 满足「仅限 opus」）；其余为 codex GPT 系;chatgpt/ 是
  // ChatGPT 订阅直连(bridge 把 fast 映射为 Responses service_tier:'priority',models_cache
  // 的 service_tiers 声明 gpt-5.6 三个/5.5/5.4 支持、5.4-mini 不支持——openai 订阅侧的
  // mini 已按官方口径去掉 fast;裸 'gpt-5.4-mini' 仍在列表里来自 xd 网关侧条目)。
  // 注：是否真的可用还要叠 agent.hasFastMode（cc/codex 均为 true）；fast 是 per-(provider,agent) 能力。
  const EXPECTED_FAST_IDS = [
    'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
    'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
    'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'codex/gpt-5.5', 'codex/gpt-5.4', 'codex/gpt-5.6-sol', 'codex/gpt-5.6-terra',
    'chatgpt/gpt-5.5', 'chatgpt/gpt-5.4',
  ];

  it('exactly these model ids carry supportsFastMode=true', () => {
    const fastIds = new Set<string>();
    for (const { model } of eachModel()) if (model.supportsFastMode) fastIds.add(model.id);
    expect([...fastIds].sort()).toEqual([...EXPECTED_FAST_IDS].sort());
  });

  it('claude-fable-5 does NOT carry supportsFastMode (opus-only)', () => {
    for (const { model } of eachModel()) {
      if (model.id === 'claude-fable-5') expect(model.supportsFastMode).toBeFalsy();
    }
  });

  it('bundled catalog diverges per-provider for opus (xd gateway lacks fast); parser ALLOWS divergence', () => {
    // fast 是 per-(provider, agent)。opus 在 anthropic（直连 first-party）=true、
    // 在 xd（网关 llm-proxy，不支持 fast）=false —— 有意分叉，校验它确实存在。
    const flag = new Map<string, boolean>();
    for (const { providerId, agent, model } of eachModel()) {
      flag.set(`${providerId} ${agent} ${model.id}`, !!model.supportsFastMode);
    }
    expect(flag.get('anthropic claude-code claude-opus-4-8')).toBe(true);
    expect(flag.get('xd claude-code claude-opus-4-8')).toBe(false);
    // 解析层不因同 id 跨 provider 取不同 supportsFastMode 而报错。
    const divergent: Catalog = {
      version: '1',
      providers: [
        {
          id: 'p-fast', name: 'P-Fast', source: 'builtin', agents: ['claude-code'],
          auth: { method: 'managed' },
          routing: { 'claude-code': { upstream: 'https://a', authStrategy: 'gateway-key' } },
          models: { 'claude-code': [{ id: 'm1', name: 'M1', contextWindow: 1000, efforts: [], defaultEffort: null, supportsFastMode: true }] },
        },
        {
          id: 'p-slow', name: 'P-Slow', source: 'builtin', agents: ['claude-code'],
          auth: { method: 'managed' },
          routing: { 'claude-code': { upstream: 'https://b', authStrategy: 'gateway-key' } },
          models: { 'claude-code': [{ id: 'm1', name: 'M1', contextWindow: 1000, efforts: [], defaultEffort: null, supportsFastMode: false }] },
        },
      ],
    };
    expect(() => parseCatalog(divergent)).not.toThrow();
  });
});

describe('fast-mode per-provider resolution (model-level SSoT)', () => {
  // Fast 能力唯一真相 = 该 (provider, model, agent) 条目的 supportsFastMode（per-provider）。
  it('modelSupportsFastMode reads the specific provider entry (false on missing provider/model)', () => {
    const views = buildRegistry(BUNDLED_CATALOG, {});
    const anthropic = views.find((p) => p.id === 'anthropic');
    const xd = views.find((p) => p.id === 'xd');
    // opus per-provider 分叉：anthropic（直连 first-party）=true，xd（网关 llm-proxy，不支持 fast）=false。
    expect(modelSupportsFastMode(anthropic, 'claude-opus-4-8', 'claude-code')).toBe(true);
    expect(modelSupportsFastMode(xd, 'claude-opus-4-8', 'claude-code')).toBe(false);
    // 该来源不提供此模型 / 无 provider ⇒ false。
    expect(modelSupportsFastMode(anthropic, 'gpt-5.5', 'claude-code')).toBe(false);
    expect(modelSupportsFastMode(undefined, 'claude-opus-4-8', 'claude-code')).toBe(false);
    // 不支持 fast 的模型 ⇒ false。
    expect(modelSupportsFastMode(anthropic, 'claude-sonnet-4-6', 'claude-code')).toBe(false);
  });

  it('sessionModelSupportsFastMode resolves the effective source then reads its entry', () => {
    const both = buildRegistry(BUNDLED_CATALOG, { xd: true, anthropic: true });
    // 未显式选源 → cc 原生默认 xd；xd 的 opus.supportsFastMode=false ⇒ false（网关不支持 fast）。
    expect(sessionModelSupportsFastMode(both, null, 'claude-opus-4-8', 'claude-code')).toBe(false);
    // 显式选官方 Anthropic 源（直连 first-party）⇒ true。
    expect(sessionModelSupportsFastMode(both, 'anthropic', 'claude-opus-4-8', 'claude-code')).toBe(true);
    // 不支持 fast 的模型恒 false。
    expect(sessionModelSupportsFastMode(both, null, 'claude-sonnet-4-6', 'claude-code')).toBe(false);
    // 零已连接来源 → 无生效来源 ⇒ false。
    expect(sessionModelSupportsFastMode(buildRegistry(BUNDLED_CATALOG, {}), null, 'claude-opus-4-8', 'claude-code')).toBe(false);
  });

  it('per-provider divergence flows through session resolution (synthetic)', () => {
    const divergent: Catalog = {
      version: '1',
      providers: [
        {
          id: 'official', name: 'Official', source: 'builtin', agents: ['claude-code'],
          auth: { method: 'oauth' },
          routing: { 'claude-code': { upstream: 'https://a', authStrategy: 'oauth-passthrough' } },
          models: { 'claude-code': [{ id: 'opus', name: 'Opus', contextWindow: 1000, efforts: [], defaultEffort: null, supportsFastMode: true }] },
        },
        {
          id: 'xd', name: 'XD', source: 'builtin', agents: ['claude-code'],
          auth: { method: 'managed' },
          routing: { 'claude-code': { upstream: 'https://b', authStrategy: 'gateway-key' } },
          models: { 'claude-code': [{ id: 'opus', name: 'Opus', contextWindow: 1000, efforts: [], defaultEffort: null, supportsFastMode: false }] },
        },
      ],
    };
    const views = buildRegistry(divergent, { official: true, xd: true });
    // cc 默认源 = xd（nativeDefault），其 opus.supportsFastMode=false ⇒ 默认不显示 fast。
    expect(sessionModelSupportsFastMode(views, null, 'opus', 'claude-code')).toBe(false);
    // 显式选 official 源 ⇒ 该来源 opus 支持 fast ⇒ 显示。
    expect(sessionModelSupportsFastMode(views, 'official', 'opus', 'claude-code')).toBe(true);
  });
});

describe('provider membership', () => {
  it('anthropic = claude family, agents [claude-code]', () => {
    const a = provider('anthropic');
    expect(a.agents).toEqual(['claude-code']);
    expect((a.models['claude-code'] ?? []).map((m) => m.id).sort()).toEqual(
      ['claude-fable-5', 'claude-haiku-4-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-sonnet-5'],
    );
  });

  it('openai = gpt family; codex agent + claude-code(ChatGPT 订阅直连 bridge)', () => {
    const o = provider('openai');
    expect(o.agents.sort()).toEqual(['claude-code', 'codex']);
    expect((o.models['codex'] ?? []).map((m) => m.id).sort()).toEqual(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']);
    // claude-code 侧是带 chatgpt/ 前缀的订阅直连模型(经 responses-bridge 翻译),与网关版区分。
    expect((o.models['claude-code'] ?? []).map((m) => m.id).sort()).toEqual([
      'chatgpt/gpt-5.4',
      'chatgpt/gpt-5.4-mini',
      'chatgpt/gpt-5.5',
    ]);
  });

  it('xai = Grok family; claude-code bridge + codex direct Responses routing', () => {
    const xai = provider('xai');
    expect(xai.agents.sort()).toEqual(['claude-code', 'codex']);
    expect(xai.routing.codex).toMatchObject({
      upstream: 'https://api.x.ai/v1',
      authStrategy: 'provider-oauth-header',
      modelIdRewrite: { stripPrefix: 'xai/' },
    });
    expect((xai.models.codex ?? []).map((m) => m.id).sort()).toEqual([
      'xai/grok-4.20',
      'xai/grok-4.3',
      'xai/grok-4.5',
      'xai/grok-code-fast',
    ]);
    expect((xai.models.codex ?? []).find((m) => m.id === 'xai/grok-4.3')?.efforts).toEqual(['low', 'medium', 'high']);
  });

  it('xd = both agents; its own cc list 23 models, codex list 7 models', () => {
    const xd = provider('xd');
    expect(xd.agents.sort()).toEqual(['claude-code', 'codex']);
    expect((xd.models['claude-code'] ?? []).length).toBe(23);
    expect((xd.models['codex'] ?? []).length).toBe(7);
  });

  it('gpt-5.5 contextWindow differs per agent in xd (cc=1M / codex=272k)', () => {
    const xd = provider('xd');
    const cc = (xd.models['claude-code'] ?? []).find((m) => m.id === 'gpt-5.5');
    const codex = (xd.models['codex'] ?? []).find((m) => m.id === 'gpt-5.5');
    expect(cc?.contextWindow).toBe(1_000_000);
    expect(codex?.contextWindow).toBe(272_000);
  });
});

describe('vendor grouping metadata (group + sortOrder)', () => {
  const KNOWN_GROUPS = new Set(['anthropic', 'gpt', 'gpt-budget', 'grok', 'google', 'china']);

  it('every model carries a known group + a numeric sortOrder', () => {
    for (const { providerId, model } of eachModel()) {
      expect(typeof model.sortOrder, `${providerId}/${model.id} sortOrder`).toBe('number');
      expect(KNOWN_GROUPS.has(model.group ?? ''), `${providerId}/${model.id} group=${model.group}`).toBe(true);
    }
  });

  it('group + sortOrder are consistent for the same id across providers/agents', () => {
    const seen = new Map<string, string>();
    for (const { model } of eachModel()) {
      const sig = `${model.group}#${model.sortOrder}`;
      const prev = seen.get(model.id);
      if (prev === undefined) seen.set(model.id, sig);
      else expect(sig, model.id).toBe(prev);
    }
  });

  it('spot-checks: id → (group, sortOrder)', () => {
    const xd = provider('xd');
    const byId = new Map((xd.models['claude-code'] ?? []).map((m) => [m.id, m]));
    expect(byId.get('claude-opus-4-8')).toMatchObject({ group: 'anthropic', sortOrder: 1 });
    expect(byId.get('codex/gpt-5.5')).toMatchObject({ group: 'gpt-budget', sortOrder: 10 });
    expect(byId.get('gpt-5.5')).toMatchObject({ group: 'gpt', sortOrder: 20 });
    expect(byId.get('gemini-3.5-flash')).toMatchObject({ group: 'google', sortOrder: 30 });
    expect(byId.get('qwen/qwen3.7-max')).toMatchObject({ group: 'china', sortOrder: 40 });
  });
});
