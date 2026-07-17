/**
 * active-catalog XD 网关权威模型清单重建单测。
 * 不变量:null / 空列表 = fail-open(目录静态清单);有值时网关清单为准——
 * 目录同 id 条目沿用产品元数据,目录没有的合成默认条目(仅 claude-code tab),
 * 目录有、网关没有的不展示;其它供应商永不受影响。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG } from '@lizi/model-providers';

import {
  getActiveCatalog,
  setActiveCatalog,
  setXdGatewayModels,
} from '../active-catalog.js';

function xdModels(agent: 'claude-code' | 'codex') {
  const xd = getActiveCatalog().providers.find((p) => p.id === 'xd');
  return xd?.models[agent] ?? [];
}

const staticXd = BUNDLED_CATALOG.providers.find((p) => p.id === 'xd');
const staticCcIds = (staticXd?.models['claude-code'] ?? []).map((m) => m.id);

afterEach(() => {
  setXdGatewayModels(null);
  setActiveCatalog(BUNDLED_CATALOG);
});

describe('XD 网关权威模型清单重建', () => {
  it('未设置(null)= fail-open,目录静态清单原样生效', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    expect(xdModels('claude-code').map((m) => m.id)).toEqual(staticCcIds);
  });

  it('空列表同样 fail-open(清空会让供应商行整个消失)', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([]);
    expect(xdModels('claude-code').map((m) => m.id)).toEqual(staticCcIds);
  });

  it('网关清单为准:目录同 id 沿用元数据,目录没有的合成条目进 claude-code tab', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([
      { id: 'claude-opus-4-6' },
      { id: 'gpt-5.6-sol', contextWindow: 272_000 },
    ]);

    const cc = xdModels('claude-code');
    expect(cc.map((m) => m.id)).toEqual(['claude-opus-4-6', 'gpt-5.6-sol']);
    // 目录条目沿用产品元数据(展示名不是裸 id)
    const known = cc.find((m) => m.id === 'claude-opus-4-6');
    expect(known?.name).not.toBe('claude-opus-4-6');
    // 合成条目:id 当展示名,contextWindow 用网关上报值,口径同自定义 OAuth 发现
    const synthesized = cc.find((m) => m.id === 'gpt-5.6-sol');
    expect(synthesized).toMatchObject({
      name: 'gpt-5.6-sol',
      contextWindow: 272_000,
      efforts: [],
      defaultEffort: null,
    });
    // codex tab 只保留目录已知条目(合成条目不进,协议覆盖面不猜)
    expect(xdModels('codex').map((m) => m.id)).toEqual([]);
  });

  it('目录有、网关没有 → 不展示;网关上报缺 contextWindow 时合成条目用保守默认', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([{ id: 'brand-new-model' }]);

    const cc = xdModels('claude-code');
    expect(cc.map((m) => m.id)).toEqual(['brand-new-model']);
    expect(cc[0].contextWindow).toBe(200_000);
    expect(cc.map((m) => m.id)).not.toContain(staticCcIds[0]);
  });

  it('其它供应商的模型列表逐字不变(同 id 模型经订阅直连仍可用)', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    const anthropicBefore = getActiveCatalog().providers.find((p) => p.id === 'anthropic');
    setXdGatewayModels([{ id: 'claude-opus-4-6' }]);
    const anthropicAfter = getActiveCatalog().providers.find((p) => p.id === 'anthropic');
    expect(anthropicAfter?.models).toEqual(anthropicBefore?.models);
  });

  it('传 null 清除,回到静态清单', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([{ id: 'claude-opus-4-6' }]);
    expect(xdModels('claude-code')).toHaveLength(1);
    setXdGatewayModels(null);
    expect(xdModels('claude-code').map((m) => m.id)).toEqual(staticCcIds);
  });
});
