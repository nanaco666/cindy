/**
 * workGroupBlockInteraction.test.ts
 * ---------------------------------------------------------------------------
 * WorkGroupBlock「两级展开」交互的回归锁定。
 *
 * 旧行为(PR #56):点开「已工作」组时 `expandBlocks(childBlockIds)` 把所有子卡
 * 批量 seed 为展开,内部 thinking / 工具调用一次点击全部摊开。
 * 2026-06 改为两级展开 —— 点开组只渲染子卡的折叠头行,内部不替用户展开,
 * 由用户在组内逐个点开。
 *
 * 测试环境维持仓库约定的 'node'(vitest.config.ts):不引 jsdom / testing-library,
 * 用静态源码扫描锁定「onToggle 只翻自身状态、不再 seed 子卡」的接线不被回退。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('WorkGroupBlock — 两级展开接线静态扫描', () => {
  const source = readFileSync(
    resolve(__dirname, '..', 'components', 'chat', 'WorkGroupBlock.tsx'),
    'utf8',
  );

  it('onToggle 不再 seed 子卡展开态(内部 thinking / 工具调用由用户逐个点开)', () => {
    // 任何把 expandBlocks(...) seed 重新塞回组件的改动都会回到「点一次把内部全摊开」
    // 的旧行为,与两级展开契约冲突 —— 故整份源码都不应再出现 expandBlocks。
    expect(source).not.toMatch(/expandBlocks/);
  });

  it('onToggle 仍翻转组自身的展开态', () => {
    const onToggle = source.slice(source.indexOf('const onToggle'));
    expect(onToggle).toMatch(/setExpanded\(\(v\) => !v\)/);
  });
});
