/**
 * effortResolution 单测 —— 用例与 apps/desktop 的 sourceSwitch.test.ts 同源(实现从那里下沉,
 * 桌面侧继续经 re-export 覆盖同一实现;这里保证共享包独立可测、手机端消费口径有据可依)。
 */
import { describe, it, expect } from 'vitest';

import { resolveEffort, resolveProviderSwitchEffort } from '../effortResolution.js';
import type { Effort } from '../types.js';

describe('resolveEffort —— 选中模型后 effort 落档优先级', () => {
  const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

  it('无 effort 档(efforts 为空)→ 始终 low(占位,UI 不显示)', () => {
    expect(
      resolveEffort({ efforts: [], defaultEffort: null, activeEffort: 'high', preferred: 'max' }),
    ).toBe('low');
  });

  it('preferred 最高优先(仍受支持时)', () => {
    expect(
      resolveEffort({
        efforts: EFFORTS,
        defaultEffort: 'high',
        activeEffort: 'low',
        preferred: 'max',
        providerEffort: 'medium',
        rememberedEffort: 'xhigh',
      }),
    ).toBe('max');
  });

  it('preferred 不受支持 → 跳过,落到 providerEffort((agent,provider,model) 精确记忆)', () => {
    expect(
      resolveEffort({
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
        activeEffort: 'low',
        preferred: 'max', // 不在 efforts
        providerEffort: 'medium',
        rememberedEffort: 'high',
      }),
    ).toBe('medium');
  });

  it('providerEffort > rememberedEffort:同模型跨来源记忆精确恢复', () => {
    expect(
      resolveEffort({
        efforts: EFFORTS,
        defaultEffort: 'high',
        activeEffort: 'low',
        providerEffort: 'xhigh',
        rememberedEffort: 'medium',
      }),
    ).toBe('xhigh');
  });

  it('无 provider 记忆 → 落到 per-model rememberedEffort', () => {
    expect(
      resolveEffort({
        efforts: EFFORTS,
        defaultEffort: 'high',
        activeEffort: 'low',
        rememberedEffort: 'medium',
      }),
    ).toBe('medium');
  });

  it('记忆都不受支持 → 沿用当前 activeEffort(仍受支持时)', () => {
    expect(
      resolveEffort({
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
        activeEffort: 'medium',
        providerEffort: 'max', // 不在 efforts
        rememberedEffort: 'xhigh', // 不在 efforts
      }),
    ).toBe('medium');
  });

  it('全无可用 → 模型默认 defaultEffort', () => {
    expect(
      resolveEffort({
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'high',
        activeEffort: 'max', // 不在 efforts
      }),
    ).toBe('high');
  });

  it('defaultEffort 为 null → 落 efforts 首档', () => {
    expect(
      resolveEffort({
        efforts: ['low', 'high'],
        defaultEffort: null,
        activeEffort: 'medium', // 不在 efforts
      }),
    ).toBe('low');
  });
});

describe('resolveEffort —— defaultEffort 兜底校验(catalog 病态数据防御)', () => {
  it('defaultEffort 不在 efforts 内 → 落 efforts 首档,不返回非法档', () => {
    expect(
      resolveEffort({ efforts: ['minimal', 'low', 'medium'], defaultEffort: 'high', activeEffort: 'xhigh' }),
    ).toBe('minimal');
  });
  it('defaultEffort 缺失 → 落 efforts 首档,不落幽灵 high', () => {
    expect(
      resolveEffort({ efforts: ['minimal', 'low'], defaultEffort: null, activeEffort: 'xhigh' }),
    ).toBe('minimal');
  });
});

describe('resolveProviderSwitchEffort —— 同模型只切来源(严格 per-供应商,不沿用 activeEffort)', () => {
  const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

  it('preferred 最高优先(仍受支持时)', () => {
    expect(
      resolveProviderSwitchEffort({
        efforts: EFFORTS,
        defaultEffort: 'high',
        providerEffort: 'medium',
        preferred: 'max',
        fallbackEffort: 'low',
      }),
    ).toBe('max');
  });

  it('新来源有该模型记忆 → 恢复 providerEffort', () => {
    expect(
      resolveProviderSwitchEffort({
        efforts: EFFORTS,
        defaultEffort: 'high',
        providerEffort: 'xhigh',
        fallbackEffort: 'low',
      }),
    ).toBe('xhigh');
  });

  it('【bug 回归】新来源无记忆 → 落模型默认,绝不沿用 fallback(=当前来源 activeEffort)', () => {
    expect(
      resolveProviderSwitchEffort({
        efforts: EFFORTS,
        defaultEffort: 'high',
        providerEffort: undefined,
        fallbackEffort: 'max', // = A 来源当前档,绝不能被选中
      }),
    ).toBe('high');
  });

  it('providerEffort 不受目标模型支持 → 跳过,落模型默认', () => {
    expect(
      resolveProviderSwitchEffort({
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
        providerEffort: 'max', // 不在 efforts
        fallbackEffort: 'low',
      }),
    ).toBe('high');
  });

  it('无记忆、defaultEffort 为 null → efforts 首档(仍不取 fallback)', () => {
    expect(
      resolveProviderSwitchEffort({
        efforts: ['medium', 'high'],
        defaultEffort: null,
        fallbackEffort: 'max',
      }),
    ).toBe('medium');
  });

  it('模型无 effort 档(efforts 为空)→ fallbackEffort(占位,UI 不显示 effort)', () => {
    expect(
      resolveProviderSwitchEffort({
        efforts: [],
        defaultEffort: null,
        fallbackEffort: 'high',
      }),
    ).toBe('high');
  });
});
