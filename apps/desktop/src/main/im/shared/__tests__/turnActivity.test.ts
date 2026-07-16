/**
 * turnActivity — IM 流式卡片过程展示的纯逻辑测试:
 * 工具标签格式化(文件 basename / Bash 截断 / MCP 名)、滚动窗口、
 * 渲染形态(状态行 + 引用块时间线 / writing 态 / 空活动零输出)。
 */
import { describe, it, expect } from 'vitest';

import {
  createTurnActivity,
  formatToolStep,
  pushToolStep,
  renderActivity,
  MAX_VISIBLE_STEPS,
} from '../turnActivity';

describe('formatToolStep — 工具标签', () => {
  it('文件类工具取 basename', () => {
    expect(formatToolStep('Read', { file_path: '/a/b/slackRelay.ts' })).toBe(
      'Read slackRelay.ts',
    );
    expect(formatToolStep('Edit', { file_path: 'C:\\proj\\x.ts'.replace(/\\/g, '/') })).toBe(
      'Edit x.ts',
    );
  });

  it('Bash 命令压成单行并截断', () => {
    const long = `pnpm vitest run ${'x'.repeat(100)}`;
    const label = formatToolStep('Bash', { command: long });
    expect(label.startsWith('Bash pnpm vitest run')).toBe(true);
    expect(label.length).toBeLessThanOrEqual(64);
    expect(label.endsWith('…')).toBe(true);
    expect(formatToolStep('Bash', { command: 'echo a\n  echo b' })).toBe('Bash echo a echo b');
  });

  it('Grep/Glob 取 pattern, WebSearch 取 query, Task 取 description', () => {
    expect(formatToolStep('Grep', { pattern: 'recordRoute' })).toBe('Grep recordRoute');
    expect(formatToolStep('WebSearch', { query: 'slack rate limit' })).toBe(
      'WebSearch slack rate limit',
    );
    expect(formatToolStep('Task', { description: '搜索单机约束' })).toBe('Task 搜索单机约束');
  });

  it('MCP 工具名 mcp__server__tool → server:tool', () => {
    expect(formatToolStep('mcp__lizi_feishu__call_tool', {})).toBe('lizi_feishu:call_tool');
  });

  it('未知工具 / 取不到参数时只显示工具名', () => {
    expect(formatToolStep('TodoWrite', { todos: [] })).toBe('TodoWrite');
    expect(formatToolStep('Read', null)).toBe('Read');
  });
});

describe('pushToolStep — 滚动窗口', () => {
  it('超过窗口上限时老步骤滚出, 总数保留', () => {
    const a = createTurnActivity(0);
    for (let i = 1; i <= MAX_VISIBLE_STEPS + 3; i++) {
      pushToolStep(a, 'Grep', { pattern: `p${i}` });
    }
    expect(a.totalSteps).toBe(MAX_VISIBLE_STEPS + 3);
    expect(a.recentSteps).toHaveLength(MAX_VISIBLE_STEPS);
    expect(a.recentSteps[0]).toBe(`Grep p4`);
    expect(a.recentSteps.at(-1)).toBe(`Grep p${MAX_VISIBLE_STEPS + 3}`);
  });
});

describe('renderActivity — 渲染形态', () => {
  it('无任何步骤 → 空串(纯文本快答不多一行)', () => {
    expect(renderActivity(createTurnActivity(0), 1000, false)).toBe('');
    expect(renderActivity(createTurnActivity(0), 1000, true)).toBe('');
  });

  it('工具阶段: 状态行带步数与耗时, 当前步标 ▸, 历史步标 ✓', () => {
    const a = createTurnActivity(0);
    pushToolStep(a, 'Read', { file_path: '/x/relay.ts' });
    pushToolStep(a, 'Bash', { command: 'pnpm vitest run' });
    const view = renderActivity(a, 42_000, false);
    expect(view.split('\n')).toEqual([
      '⚙️ 第 2 步 · 42s',
      '> ✓ Read relay.ts',
      '> ▸ Bash pnpm vitest run',
    ]);
  });

  it('writing 态: 全部步骤标 ✓, 追加"正在书写回复"行;耗时分钟格式', () => {
    const a = createTurnActivity(0);
    pushToolStep(a, 'Read', { file_path: '/x/relay.ts' });
    const view = renderActivity(a, 90_000, true);
    expect(view.split('\n')).toEqual([
      '⚙️ 第 1 步 · 1m30s',
      '> ✓ Read relay.ts',
      '> ▸ ✍️ 正在书写回复',
    ]);
  });
});
