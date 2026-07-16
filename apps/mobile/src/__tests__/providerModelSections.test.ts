/**
 * providerModelSections 单测:守住手机 provider-aware 下拉的派生口径与桌面/IM 一致——
 * 只列已连接供应商、同 id 多来源各出一行、可见性按被控端 override + 目录 defaultEnabled
 * 过滤(旧被控端无 overrides → 不过滤降级)、activeSourceId 走「显式选中 ∈ connected 否则
 * nativeDefaultSourceId」、effort reconcile 口径、resolveRowSelection 选行落点。
 * 纯逻辑,node env,不 import react-native。
 */
import { describe, expect, it } from 'vitest';
import type { ProviderView } from '@lizi/model-providers/registry';
import type { SectionModel } from '@lizi/model-providers/sections';

import type { MobileModelMemoryAccessors } from '@/session/draftModelMemory';
import {
  buildMobileModelSections,
  flattenProviderSections,
  reconcileEffortForModel,
  resolveRowSelection,
  type ProviderModelRow,
} from '@/session/providerModelSections';

function model(id: string, patch: Partial<{ defaultEnabled: boolean; efforts: string[]; defaultEffort: string | null }> = {}) {
  return {
    id,
    name: id.toUpperCase(),
    contextWindow: 200000,
    efforts: patch.efforts ?? [],
    defaultEffort: patch.defaultEffort ?? null,
    ...(patch.defaultEnabled !== undefined ? { defaultEnabled: patch.defaultEnabled } : {}),
  };
}

function provider(
  id: string,
  opts: { connected?: boolean; agents?: Array<'claude-code' | 'codex'>; codex?: unknown[]; cc?: unknown[] },
): ProviderView {
  return {
    id,
    name: id,
    agents: opts.agents ?? ['codex'],
    connected: opts.connected ?? true,
    models: { codex: opts.codex, 'claude-code': opts.cc },
  } as unknown as ProviderView;
}

describe('buildMobileModelSections', () => {
  it('只列已连接供应商;同 id 多来源各出一行', () => {
    const providers = [
      provider('openai', { codex: [model('gpt-5.5'), model('gpt-5.4')] }),
      provider('xd', { codex: [model('gpt-5.5')] }),
      provider('offline', { connected: false, codex: [model('gpt-5.5')] }),
    ];
    const { sections, connected } = buildMobileModelSections({ providers, agentKind: 'codex' });
    expect(connected.map((p) => p.id)).toEqual(['openai', 'xd']);
    const rows = flattenProviderSections(sections);
    expect(rows.map((r) => `${r.provider.id}:${r.model.id}`)).toEqual([
      'openai:gpt-5.5',
      'openai:gpt-5.4',
      'xd:gpt-5.5',
    ]);
  });

  it('旧被控端(无 visibilityOverrides)→ 不过滤:defaultEnabled=false 的模型也显示', () => {
    const providers = [
      provider('openai', { codex: [model('gpt-5.5'), model('longtail', { defaultEnabled: false })] }),
    ];
    const visible = flattenProviderSections(
      buildMobileModelSections({ providers, agentKind: 'codex' }).sections,
    );
    expect(visible.map((r) => r.model.id)).toEqual(['gpt-5.5', 'longtail']);
  });

  it('有 visibilityOverrides → 按被控端开关过滤:override 优先,缺省跟 defaultEnabled', () => {
    const providers = [
      provider('openai', {
        codex: [
          model('gpt-5.5'),                                  // 无 override,defaultEnabled 缺省 → 显示
          model('gpt-5.4'),                                  // override=false → 隐藏
          model('longtail', { defaultEnabled: false }),      // 无 override,defaultEnabled=false → 隐藏
          model('revived', { defaultEnabled: false }),       // override=true 压过 defaultEnabled=false → 显示
        ],
      }),
    ];
    const visible = flattenProviderSections(
      buildMobileModelSections({
        providers,
        agentKind: 'codex',
        visibilityOverrides: {
          'codex:openai:gpt-5.4': false,
          'codex:openai:revived': true,
        },
      }).sections,
    );
    expect(visible.map((r) => r.model.id)).toEqual(['gpt-5.5', 'revived']);
  });

  it('当前选中行即使被隐藏也保留(buildProviderSections 内建豁免,与桌面一致)', () => {
    const providers = [
      provider('openai', { codex: [model('gpt-5.5'), model('gpt-5.4')] }),
    ];
    const visible = flattenProviderSections(
      buildMobileModelSections({
        providers,
        agentKind: 'codex',
        selectedModelId: 'gpt-5.4',
        selectedProviderId: 'openai',
        visibilityOverrides: { 'codex:openai:gpt-5.4': false },
      }).sections,
    );
    expect(visible.map((r) => r.model.id)).toEqual(['gpt-5.5', 'gpt-5.4']);
  });

  it('搜索 query 过滤 name / id(大小写不敏感,共享 buildProviderSections 口径)', () => {
    const providers = [
      provider('openai', { codex: [model('gpt-5.5'), model('gpt-5.4')] }),
    ];
    const rows = flattenProviderSections(
      buildMobileModelSections({ providers, agentKind: 'codex', query: '5.4' }).sections,
    );
    expect(rows.map((r) => r.model.id)).toEqual(['gpt-5.4']);
  });

  it('activeSourceId:显式选中 ∈ connected 用它,否则 nativeDefaultSourceId(codex→openai)', () => {
    const providers = [
      provider('xd', { codex: [model('gpt-5.5')] }),
      provider('openai', { codex: [model('gpt-5.5')] }),
    ];
    expect(buildMobileModelSections({ providers, agentKind: 'codex' }).activeSourceId).toBe('openai');
    expect(
      buildMobileModelSections({ providers, agentKind: 'codex', selectedProviderId: 'xd' }).activeSourceId,
    ).toBe('xd');
    // 选了未连接/不存在的来源 → 回退 nativeDefault。
    expect(
      buildMobileModelSections({ providers, agentKind: 'codex', selectedProviderId: 'ghost' }).activeSourceId,
    ).toBe('openai');
  });

  it('cc agent 的 nativeDefault 优先 xd', () => {
    const providers = [
      provider('anthropic', { agents: ['claude-code'], cc: [model('claude-opus-4-8')] }),
      provider('xd', { agents: ['claude-code'], cc: [model('claude-opus-4-8')] }),
    ];
    expect(buildMobileModelSections({ providers, agentKind: 'claude-code' }).activeSourceId).toBe('xd');
  });
});

describe('resolveRowSelection —— 选行落点(effort 优先级与桌面共享实现同源)', () => {
  const providerView = (id: string): ProviderView =>
    provider(id, {
      codex: [
        model('gpt-5.5', { efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' }),
      ],
    });
  const rowOf = (providerId: string): ProviderModelRow => {
    const p = providerView(providerId);
    return {
      provider: p,
      model: {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        efforts: ['low', 'medium', 'high', 'xhigh'] as never,
        defaultEffort: 'medium' as never,
        contextWindow: 272000,
      },
    };
  };
  const memoryWith = (effort?: string, fast?: boolean): MobileModelMemoryAccessors => ({
    getEffort: () => effort,
    setEffort: () => undefined,
    getFast: () => fast,
    setFast: () => undefined,
  });

  it('换模型:有 (来源, 模型) 记忆 → 精确恢复', () => {
    const next = resolveRowSelection({
      row: rowOf('openai'),
      agentKind: 'codex',
      currentModelId: 'gpt-5.4',
      currentProviderId: 'openai',
      currentEffort: 'low',
      hasFastModeCap: true,
      memory: memoryWith('xhigh'),
    });
    expect(next).toMatchObject({ model: 'gpt-5.5', providerId: 'openai', effort: 'xhigh' });
  });

  it('换模型:无记忆 → 沿用当前档(仍受支持时)', () => {
    const next = resolveRowSelection({
      row: rowOf('openai'),
      agentKind: 'codex',
      currentModelId: 'gpt-5.4',
      currentProviderId: 'openai',
      currentEffort: 'high',
      hasFastModeCap: true,
      memory: memoryWith(undefined),
    });
    expect(next.effort).toBe('high');
  });

  it('【串档回归】同模型换来源:新来源无记忆 → 落模型默认,绝不沿用当前档', () => {
    const next = resolveRowSelection({
      row: rowOf('xd'),
      agentKind: 'codex',
      currentModelId: 'gpt-5.5',
      currentProviderId: 'openai',
      currentEffort: 'xhigh', // openai 侧当前档,不能被 xd 行继承
      hasFastModeCap: true,
      memory: memoryWith(undefined),
    });
    expect(next).toMatchObject({ model: 'gpt-5.5', providerId: 'xd', effort: 'medium' });
  });

  it('fast:fastEditable(hasFastModeCap × supportsFastMode)门控,恢复记忆,缺省 false', () => {
    const p = provider('openai', {
      codex: [model('gpt-5.5', { efforts: ['medium'], defaultEffort: 'medium' })],
    });
    (p.models.codex![0] as { supportsFastMode?: boolean }).supportsFastMode = true;
    const row: ProviderModelRow = {
      provider: p,
      model: {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        efforts: ['medium'] as never,
        defaultEffort: 'medium' as never,
        supportsFastMode: true,
        contextWindow: 272000,
      },
    };
    const base = {
      row,
      agentKind: 'codex' as const,
      currentModelId: 'gpt-5.4',
      currentProviderId: 'openai',
      currentEffort: 'medium',
    };
    expect(resolveRowSelection({ ...base, hasFastModeCap: true, memory: memoryWith(undefined, true) }).fastMode).toBe(true);
    expect(resolveRowSelection({ ...base, hasFastModeCap: true, memory: memoryWith(undefined) }).fastMode).toBe(false);
    // agent 级 gate 关掉 → 即便记忆为 true 也不带 fast。
    expect(resolveRowSelection({ ...base, hasFastModeCap: false, memory: memoryWith(undefined, true) }).fastMode).toBe(false);
  });

  it('模型无 effort 档 → 空串(手机语义:创建/切换时省略该字段)', () => {
    const p = provider('openai', { codex: [model('gpt-mini')] });
    const row: ProviderModelRow = {
      provider: p,
      model: { id: 'gpt-mini', displayName: 'Mini', efforts: [] as never, defaultEffort: null, contextWindow: 1 },
    };
    const next = resolveRowSelection({
      row,
      agentKind: 'codex',
      currentModelId: 'gpt-5.5',
      currentProviderId: 'openai',
      currentEffort: 'medium',
      hasFastModeCap: false,
    });
    expect(next.effort).toBe('');
  });
});

describe('reconcileEffortForModel', () => {
  const m = (efforts: string[], defaultEffort: string | null): SectionModel =>
    ({ id: 'm', displayName: 'M', efforts: efforts as never, defaultEffort: defaultEffort as never, contextWindow: 1 });

  it('当前 effort 受支持 → 保留', () => {
    expect(reconcileEffortForModel(m(['low', 'medium', 'high'], 'high'), 'medium')).toBe('medium');
  });
  it('当前不支持 → 取默认 effort', () => {
    expect(reconcileEffortForModel(m(['low', 'high'], 'high'), 'medium')).toBe('high');
  });
  it('默认也不在支持集 → 取首个支持档', () => {
    expect(reconcileEffortForModel(m(['low', 'high'], 'xhigh'), 'medium')).toBe('low');
  });
  it('模型不支持 effort → 空串', () => {
    expect(reconcileEffortForModel(m([], null), 'medium')).toBe('');
  });
});
