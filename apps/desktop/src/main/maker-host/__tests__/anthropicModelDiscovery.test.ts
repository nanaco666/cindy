/**
 * model-discovery/anthropic 纯映射函数单测。
 *
 * 覆盖:SDK ModelInfo 映射(别名过滤 / dated id 归一 / effort 权威 / fast 缺省 false)、
 * HTTP /v1/models 映射(能力字段容错 / haiku 例外 / max_input_tokens 优先 / dated 去重)、
 * contextWindow 规则(默认 1M,haiku 200k)。
 * 磁盘缓存 / HTTP 拉取的 IO 路径不在此测(依赖 electron app 路径与登录态,行为由
 * 代码注释契约 + 集成验证覆盖)。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/xdt-maker-test'),
    getAppPath: vi.fn(() => '/tmp/xdt-maker-test/app'),
    isPackaged: false,
  },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}));

import { mapAnthropicSdkModels, mapAnthropicHttpModels } from '../model-discovery/anthropic.js';

describe('mapAnthropicSdkModels', () => {
  it('映射 value/displayName/efforts/fastMode;SDK 是能力权威', () => {
    const out = mapAnthropicSdkModels([
      {
        value: 'claude-opus-4-8',
        displayName: 'Opus 4.8',
        description: 'Most capable',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        supportsFastMode: true,
      },
      {
        value: 'claude-haiku-4-5',
        displayName: 'Haiku 4.5',
        description: 'Fastest',
        supportsEffort: false,
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: 'claude-opus-4-8',
      name: 'Opus 4.8',
      group: 'anthropic',
      sortOrder: 0,
      contextWindow: 1_000_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      supportsFastMode: true,
    });
    // supportsEffort=false → 不可调;fast 缺省 false;haiku → 200k。
    expect(out[1]).toMatchObject({
      id: 'claude-haiku-4-5',
      contextWindow: 200_000,
      efforts: [],
      defaultEffort: null,
      supportsFastMode: false,
    });
  });

  it('过滤别名与非 claude id(规则 10:禁止裸别名进目录);dated id 归一去重', () => {
    const out = mapAnthropicSdkModels([
      { value: 'opus', displayName: 'Opus' },
      { value: 'opusplan', displayName: 'Opus Plan' },
      { value: 'claude-sonnet-5-20260301', displayName: 'Sonnet 5' },
      { value: 'claude-sonnet-5', displayName: 'Sonnet 5 dup' },
    ]);
    expect(out.map((m) => m.id)).toEqual(['claude-sonnet-5']);
    expect(out[0].name).toBe('Sonnet 5'); // dated 先出现,first-wins
  });

  it('坏输入安全:非数组 / 空条目 / 缺 value 全部跳过', () => {
    expect(mapAnthropicSdkModels(null)).toEqual([]);
    expect(mapAnthropicSdkModels([null, {}, { value: '' }, 42])).toEqual([]);
  });

  it('defaultEffort:含 high 取 high,否则取最后一档', () => {
    const out = mapAnthropicSdkModels([
      { value: 'claude-x', displayName: 'X', supportedEffortLevels: ['low', 'medium'] },
    ]);
    expect(out[0].defaultEffort).toBe('medium');
  });
});

describe('mapAnthropicHttpModels', () => {
  it('无能力信息 → 合成 3 档(hasCapabilityInfo=false);haiku 例外 0 档', () => {
    const out = mapAnthropicHttpModels([
      { id: 'claude-opus-4-8-20260401', display_name: 'Opus 4.8', type: 'model' },
      { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5', type: 'model' },
    ]);
    expect(out[0].hasCapabilityInfo).toBe(false);
    expect(out[0].model).toMatchObject({
      id: 'claude-opus-4-8',
      contextWindow: 1_000_000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
      supportsFastMode: false,
    });
    expect(out[1].model).toMatchObject({ id: 'claude-haiku-4-5', contextWindow: 200_000, efforts: [] });
  });

  it('响应带能力信息时按响应为准(hasCapabilityInfo=true)', () => {
    const out = mapAnthropicHttpModels([
      {
        id: 'claude-opus-4-8',
        display_name: 'Opus 4.8',
        max_input_tokens: 900_000,
        capabilities: { efforts: ['low', 'high', 'max'], fast_mode: true },
      },
    ]);
    expect(out[0].hasCapabilityInfo).toBe(true);
    expect(out[0].model).toMatchObject({
      contextWindow: 900_000, // max_input_tokens 优先于 1M 规则
      efforts: ['low', 'high', 'max'],
      supportsFastMode: true,
    });
  });

  it('dated 变体归一后 first-wins(API 新发布在前 = 保留最新);过滤非 model 条目与别名', () => {
    const out = mapAnthropicHttpModels([
      { id: 'claude-sonnet-5-20260601', display_name: 'Sonnet 5 (new)' },
      { id: 'claude-sonnet-5-20260101', display_name: 'Sonnet 5 (old)' },
      { id: 'not-a-claude-model', display_name: 'Other' },
      { id: 'claude-opus-4-8', type: 'alias' },
    ]);
    expect(out.map((e) => e.model.id)).toEqual(['claude-sonnet-5']);
    expect(out[0].model.name).toBe('Sonnet 5 (new)');
  });

  it('坏输入安全', () => {
    expect(mapAnthropicHttpModels(undefined)).toEqual([]);
    expect(mapAnthropicHttpModels([null, {}, { id: 42 }])).toEqual([]);
  });
});
