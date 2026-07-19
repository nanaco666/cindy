import { describe, expect, it, vi } from 'vitest';

import {
  buildHandoffText,
  createAgentHandoffPendingRegistry,
  extractPlainText,
  prependHandoffToUserMessage,
  type HandoffSourceMessage,
} from '../agentHandoff';

function msg(role: string, content: unknown, createdAt = 0): HandoffSourceMessage {
  return { role, content, createdAt };
}

describe('extractPlainText', () => {
  it('透传纯文本', () => {
    expect(extractPlainText('你好')).toBe('你好');
  });

  it('解析 JSON 字符串形态的 {text} 与 SDK blocks', () => {
    expect(extractPlainText(JSON.stringify({ text: 'hi', images: [], files: [] }))).toBe('hi');
    expect(
      extractPlainText(JSON.stringify([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])),
    ).toBe('a\nb');
  });

  it('对象形态取 text / message,未知形态回空', () => {
    expect(extractPlainText({ text: 't' })).toBe('t');
    expect(extractPlainText({ message: 'm' })).toBe('m');
    expect(extractPlainText(42)).toBe('');
    expect(extractPlainText(null)).toBe('');
  });
});

describe('buildHandoffText', () => {
  const opts = { fromLabel: 'Claude Code', toLabel: 'Codex' };

  it('framing 包含续接指令与双引擎名,并以结束标记收尾', () => {
    const text = buildHandoffText([msg('user', '第一个问题'), msg('assistant', '第一个回答')], opts);
    expect(text).toContain('Claude Code');
    expect(text).toContain('Codex');
    expect(text).toContain('不要向用户提及本段交接说明');
    expect(text.trimEnd().endsWith('== 交接说明结束,以下是用户的新消息 ==')).toBe(true);
  });

  it('最近轮次逐字保留,更早轮次进单行提要', () => {
    const messages: HandoffSourceMessage[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(msg('user', `问题${i}`));
      messages.push(msg('assistant', `回答${i}`));
    }
    const text = buildHandoffText(messages, opts);
    // 最近 4 轮(4..7)逐字
    expect(text).toContain('[用户]\n问题7');
    expect(text).toContain('[助手]\n回答7');
    expect(text).toContain('[用户]\n问题4');
    // 更早轮(0..3)在提要区
    expect(text).toContain('- 用户: 问题0');
    expect(text).toContain('回应: 回答3');
    expect(text).not.toContain('[用户]\n问题0');
  });

  it('工具调用渲染为 name + input 摘要,tool_result/thinking 不进正文', () => {
    const text = buildHandoffText(
      [
        msg('user', '改一下代码'),
        msg('tool_use', { toolUseId: 't1', toolName: 'Read', input: { file_path: '/a.ts' } }),
        msg('tool_result', { anything: 'x'.repeat(500) }),
        msg('thinking', { kind: 'thinking', text: '内心戏' }),
        msg('assistant', '改好了'),
      ],
      opts,
    );
    expect(text).toContain('[工具] Read: {"file_path":"/a.ts"}');
    expect(text).not.toContain('内心戏');
    expect(text).not.toContain('x'.repeat(200));
  });

  it('合成指令行([UI_ACTION_TRIGGER])不进交接', () => {
    const text = buildHandoffText(
      [msg('user', '正常消息'), msg('user', '[UI_ACTION_TRIGGER] resume'), msg('assistant', '好')],
      opts,
    );
    expect(text).not.toContain('UI_ACTION_TRIGGER');
    expect(text).toContain('正常消息');
  });

  it('超长文本被逐条截断,总长受硬上限保护', () => {
    const big = 'x'.repeat(50_000);
    const messages: HandoffSourceMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(msg('user', big));
      messages.push(msg('assistant', big));
    }
    const text = buildHandoffText(messages, opts);
    expect(text.length).toBeLessThanOrEqual(16_000);
  });
});

describe('prependHandoffToUserMessage', () => {
  it('string 形态直接前拼', () => {
    expect(prependHandoffToUserMessage('新消息', 'HANDOFF')).toBe('HANDOFF\n\n新消息');
  });

  it('content string 形态前拼且保持结构', () => {
    expect(prependHandoffToUserMessage({ type: 'user', content: '新消息' }, 'H')).toEqual({
      type: 'user',
      content: 'H\n\n新消息',
    });
  });

  it('blocks 形态前插独立 text block,不改原 blocks', () => {
    const original = { type: 'user' as const, content: [{ type: 'text', text: '新消息' }] };
    const out = prependHandoffToUserMessage(original, 'H');
    expect(out).toEqual({
      type: 'user',
      content: [{ type: 'text', text: 'H' }, { type: 'text', text: '新消息' }],
    });
    expect(original.content).toHaveLength(1);
  });
});

describe('createAgentHandoffPendingRegistry', () => {
  it('set → peek 命中内存,consume 后不再注入且不回查 DB', async () => {
    const query = vi.fn(async () => 'from-db');
    const reg = createAgentHandoffPendingRegistry(query);
    reg.set('s1', 'H1');
    expect(await reg.peek('s1')).toBe('H1');
    reg.consume('s1');
    expect(await reg.peek('s1')).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('内存 miss 时经 DB 重建并缓存(重启恢复语义)', async () => {
    const query = vi.fn(async () => 'from-db');
    const reg = createAgentHandoffPendingRegistry(query);
    expect(await reg.peek('s1')).toBe('from-db');
    expect(await reg.peek('s1')).toBe('from-db');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('DB 查询失败按无 pending 处理且不缓存(下次重查)', async () => {
    const query = vi.fn(async () => {
      throw new Error('db down');
    });
    const reg = createAgentHandoffPendingRegistry(query);
    expect(await reg.peek('s1')).toBeNull();
    expect(await reg.peek('s1')).toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('clear 后回落 DB 查询', async () => {
    const query = vi.fn(async () => null);
    const reg = createAgentHandoffPendingRegistry(query);
    reg.set('s1', 'H1');
    reg.clear('s1');
    expect(await reg.peek('s1')).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('buildHandoffText 工作状态区(社区 handoff packet 口径)', () => {
  const opts = { fromLabel: 'Claude Code', toLabel: 'Codex' };

  it('从 tool_use 提取改动文件(Claude Edit/Write 与 Codex apply_patch)与命令', () => {
    const text = buildHandoffText(
      [
        msg('user', '改代码'),
        msg('tool_use', { toolUseId: 't1', toolName: 'Edit', input: { file_path: '/repo/a.ts' } }),
        msg('tool_use', { toolUseId: 't2', toolName: 'Write', input: { file_path: '/repo/b.ts' } }),
        msg('tool_use', { toolUseId: 't3', toolName: 'apply_patch', input: { path: '/repo/c.ts' } }),
        msg('tool_use', { toolUseId: 't4', toolName: 'Bash', input: { command: 'pnpm test:unit' } }),
        msg('tool_use', { toolUseId: 't5', toolName: 'shell', input: { command: ['git', 'status', '--short'] } }),
        msg('assistant', '改好了'),
      ],
      opts,
    );
    expect(text).toContain('== 工作状态(自动提取)==');
    expect(text).toContain('- /repo/a.ts');
    expect(text).toContain('- /repo/b.ts');
    expect(text).toContain('- /repo/c.ts');
    expect(text).toContain('- pnpm test:unit');
    expect(text).toContain('- git status --short');
  });

  it('同一文件多次编辑去重;Read 等只读工具不进清单', () => {
    const text = buildHandoffText(
      [
        msg('user', 'q'),
        msg('tool_use', { toolUseId: 't1', toolName: 'Edit', input: { file_path: '/repo/a.ts' } }),
        msg('tool_use', { toolUseId: 't2', toolName: 'Edit', input: { file_path: '/repo/a.ts' } }),
        msg('tool_use', { toolUseId: 't3', toolName: 'Read', input: { file_path: '/repo/readonly.ts' } }),
      ],
      opts,
    );
    expect(text.match(/- \/repo\/a\.ts/g)).toHaveLength(1);
    // Read 的路径可出现在对话区的工具行,但不得进「改动过的文件」清单(行首 '- ')
    expect(text).not.toContain('- /repo/readonly.ts');
  });

  it('无工具活动时不渲染工作状态区', () => {
    const text = buildHandoffText([msg('user', '你好'), msg('assistant', '你好!')], opts);
    expect(text).not.toContain('== 工作状态');
  });

  it('framing 包含「先核对工作区、以工作区为准」纪律', () => {
    const text = buildHandoffText([msg('user', 'q')], opts);
    expect(text).toContain('git status');
    expect(text).toContain('以工作区现状为准');
  });
});
