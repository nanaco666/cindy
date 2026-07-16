import { describe, expect, it } from 'vitest';
import {
  describeToolUse,
  humanizeToolToken,
  parseToolName,
  truncateToolText,
} from '../toolUseDescriptor';

describe('parseToolName', () => {
  it('parses Claude Code mcp__server__tool names', () => {
    expect(parseToolName('mcp__feishu__read_by_url')).toEqual({
      kind: 'mcp',
      server: 'feishu',
      tool: 'read_by_url',
    });
  });

  it('keeps single-underscore server names intact (double-underscore split)', () => {
    expect(parseToolName('mcp__orca_worker_bridge__send_to_lead')).toEqual({
      kind: 'mcp',
      server: 'orca_worker_bridge',
      tool: 'send_to_lead',
    });
  });

  it('rejoins extra double-underscore segments into the tool part', () => {
    expect(parseToolName('mcp__server__part_a__part_b')).toEqual({
      kind: 'mcp',
      server: 'server',
      tool: 'part_a__part_b',
    });
  });

  it('parses codex mcp:server:tool names', () => {
    expect(parseToolName('mcp:feishu:read_by_url')).toEqual({
      kind: 'mcp',
      server: 'feishu',
      tool: 'read_by_url',
    });
  });

  it('keeps colons inside the tool part for codex names', () => {
    expect(parseToolName('mcp:s:a:b')).toEqual({ kind: 'mcp', server: 's', tool: 'a:b' });
  });

  it('parses dynamic tool names with and without namespace', () => {
    expect(parseToolName('dynamic:ns:tool')).toEqual({ kind: 'dynamic', namespace: 'ns', tool: 'tool' });
    expect(parseToolName('dynamic:tool')).toEqual({ kind: 'dynamic', tool: 'tool' });
  });

  it('parses collab tool names', () => {
    expect(parseToolName('collab:wait')).toEqual({ kind: 'collab', tool: 'wait' });
  });

  it('falls back to plain for builtin and malformed names', () => {
    expect(parseToolName('Bash')).toEqual({ kind: 'plain', name: 'Bash' });
    expect(parseToolName('')).toEqual({ kind: 'plain', name: '' });
    expect(parseToolName('mcp__')).toEqual({ kind: 'plain', name: 'mcp__' });
    expect(parseToolName('mcp__server')).toEqual({ kind: 'plain', name: 'mcp__server' });
    expect(parseToolName('mcp:server')).toEqual({ kind: 'plain', name: 'mcp:server' });
    expect(parseToolName('dynamic:')).toEqual({ kind: 'plain', name: 'dynamic:' });
    expect(parseToolName('collab:')).toEqual({ kind: 'plain', name: 'collab:' });
  });
});

describe('describeToolUse — command tools', () => {
  it('extracts the Bash description when present', () => {
    expect(describeToolUse('Bash', { command: 'git status', description: '查看工作区状态' })).toEqual({
      kind: 'command',
      toolName: 'Bash',
      description: '查看工作区状态',
      command: 'git status',
    });
  });

  it('omits description when missing, non-string, or blank', () => {
    expect(describeToolUse('Bash', { command: 'ls' })).toEqual({
      kind: 'command',
      toolName: 'Bash',
      command: 'ls',
      intent: { action: 'list' },
    });
    expect(describeToolUse('Bash', { command: 'ls', description: 42 })).not.toHaveProperty('description');
    expect(describeToolUse('Bash', { command: 'ls', description: null })).not.toHaveProperty('description');
    expect(describeToolUse('Bash', { command: 'ls', description: '   ' })).not.toHaveProperty('description');
  });

  it('prefers displayCommand over command for codex exec, never has description', () => {
    expect(
      describeToolUse('exec', { command: 'pwsh -c "git status"', displayCommand: 'git status', cwd: '/repo' }),
    ).toEqual({ kind: 'command', toolName: 'exec', command: 'git status', cwd: '/repo' });
    expect(describeToolUse('exec', { command: 'ls -la' })).toEqual({
      kind: 'command',
      toolName: 'exec',
      command: 'ls -la',
      intent: { action: 'list' },
    });
  });

  it('degrades to an empty command when input is unusable', () => {
    expect(describeToolUse('Bash', null)).toEqual({ kind: 'command', toolName: 'Bash', command: '' });
    expect(describeToolUse('exec', 'oops')).toEqual({ kind: 'command', toolName: 'exec', command: '' });
    expect(describeToolUse('Bash', [1, 2])).toEqual({ kind: 'command', toolName: 'Bash', command: '' });
  });

  it('derives intent from codex commandActions, preferring them over local parsing', () => {
    expect(
      describeToolUse('exec', {
        command: 'grep -n foo src/',
        commandActions: [{ type: 'search', command: 'grep -n foo src/', query: 'foo', path: 'src/' }],
      }),
    ).toMatchObject({ intent: { action: 'search', target: 'foo', path: 'src/' } });
    // commandActions 全是 unknown → 回退本地规则解析。
    expect(
      describeToolUse('exec', {
        command: 'pnpm test',
        commandActions: [{ type: 'unknown', command: 'pnpm test' }],
      }),
    ).toMatchObject({ intent: { action: 'test' } });
  });

  it('skips intent computation when the model already wrote a description', () => {
    expect(
      describeToolUse('Bash', { command: 'ls src', description: '看看源码目录' }),
    ).not.toHaveProperty('intent');
  });

  it('omits intent for commands the local parser cannot classify', () => {
    expect(describeToolUse('Bash', { command: 'git status' })).not.toHaveProperty('intent');
    expect(describeToolUse('exec', { command: 'rm -rf build' })).not.toHaveProperty('intent');
  });
});

describe('describeToolUse — file tools', () => {
  it('maps Read/Edit/MultiEdit/Write to file actions with basename', () => {
    expect(describeToolUse('Read', { file_path: '/repo/src/app.ts' })).toEqual({
      kind: 'file',
      toolName: 'Read',
      action: 'read',
      filePath: '/repo/src/app.ts',
      fileName: 'app.ts',
    });
    expect(describeToolUse('Edit', { file_path: '/repo/a.ts' })).toMatchObject({ action: 'edit' });
    expect(describeToolUse('MultiEdit', { file_path: '/repo/a.ts' })).toMatchObject({ action: 'edit' });
    expect(describeToolUse('Write', { file_path: '/repo/a.ts' })).toMatchObject({ action: 'create' });
  });

  it('handles Windows separators in fileName', () => {
    expect(describeToolUse('Read', { file_path: 'C:\\repo\\src\\app.ts' })).toMatchObject({
      fileName: 'app.ts',
    });
  });

  it('falls back from file_path to path, then degrades to generic', () => {
    expect(describeToolUse('Read', { path: '/repo/b.ts' })).toMatchObject({ filePath: '/repo/b.ts' });
    expect(describeToolUse('Read', {})).toEqual({ kind: 'generic', toolName: 'Read' });
  });
});

describe('describeToolUse — search / web / todo / task tools', () => {
  it('maps Grep and Glob to search descriptors', () => {
    expect(describeToolUse('Grep', { pattern: 'foo', path: 'src', glob: '*.ts' })).toEqual({
      kind: 'search',
      toolName: 'Grep',
      mode: 'grep',
      pattern: 'foo',
      path: 'src',
      glob: '*.ts',
    });
    expect(describeToolUse('Glob', { pattern: '**/*.md' })).toEqual({
      kind: 'search',
      toolName: 'Glob',
      mode: 'glob',
      pattern: '**/*.md',
    });
    expect(describeToolUse('Grep', {})).toEqual({ kind: 'generic', toolName: 'Grep' });
  });

  it('maps WebFetch / WebSearch / web_search to web descriptors', () => {
    expect(describeToolUse('WebFetch', { url: 'https://x.dev' })).toEqual({
      kind: 'web',
      toolName: 'WebFetch',
      mode: 'fetch',
      target: 'https://x.dev',
    });
    expect(describeToolUse('WebSearch', { query: 'electron ipc' })).toMatchObject({
      mode: 'search',
      target: 'electron ipc',
    });
    expect(describeToolUse('web_search', { query: 'codex' })).toMatchObject({ mode: 'search' });
    expect(describeToolUse('WebFetch', {})).toEqual({
      kind: 'generic',
      toolName: 'WebFetch',
    });
  });

  it('maps TodoWrite / update_plan to todo', () => {
    expect(describeToolUse('TodoWrite', { todos: [] })).toEqual({ kind: 'todo', toolName: 'TodoWrite' });
    expect(describeToolUse('update_plan', null)).toEqual({ kind: 'todo', toolName: 'update_plan' });
  });

  it('extracts Task description and subagent type', () => {
    expect(
      describeToolUse('Task', { description: '搜索代码', subagent_type: 'Explore', prompt: '...' }),
    ).toEqual({ kind: 'task', toolName: 'Task', description: '搜索代码', subagentType: 'Explore' });
    expect(describeToolUse('Task', {})).toEqual({ kind: 'task', toolName: 'Task' });
  });
});

describe('describeToolUse — mcp / dynamic / collab', () => {
  it('builds mcp descriptors with humanized tool label and detail', () => {
    expect(describeToolUse('mcp__feishu__read_by_url', { url: 'https://f.cn/doc' })).toEqual({
      kind: 'mcp',
      toolName: 'mcp__feishu__read_by_url',
      server: 'feishu',
      tool: 'read_by_url',
      serverLabel: 'feishu',
      toolLabel: 'read by url',
      detail: 'https://f.cn/doc',
    });
  });

  it('picks detail by key priority (description first)', () => {
    expect(
      describeToolUse('mcp:jira:query_issues', { query: 'bug', description: '查询未关闭缺陷' }),
    ).toMatchObject({ detail: '查询未关闭缺陷' });
  });

  it('truncates long detail to 80 chars and omits detail for non-record input', () => {
    const long = 'x'.repeat(200);
    const withLong = describeToolUse('mcp__s__t', { description: long });
    expect(withLong).toMatchObject({ detail: `${'x'.repeat(77)}...` });
    expect(describeToolUse('mcp__s__t', null)).not.toHaveProperty('detail');
  });

  it('builds dynamic and collab descriptors', () => {
    expect(describeToolUse('dynamic:ns:do_thing', { query: 'q' })).toEqual({
      kind: 'dynamic',
      toolName: 'dynamic:ns:do_thing',
      namespace: 'ns',
      tool: 'do_thing',
      toolLabel: 'do thing',
      detail: 'q',
    });
    expect(describeToolUse('collab:wait', null)).toEqual({
      kind: 'collab',
      toolName: 'collab:wait',
      tool: 'wait',
      toolLabel: 'wait',
    });
  });
});

describe('describeToolUse — generic fallback', () => {
  it('maps unknown tools to generic with detail extraction', () => {
    expect(describeToolUse('SomethingNew', { description: '做点什么' })).toEqual({
      kind: 'generic',
      toolName: 'SomethingNew',
      detail: '做点什么',
    });
  });

  it('never throws on hostile input shapes', () => {
    for (const input of [null, undefined, 'str', 42, [], { nested: { deep: true } }]) {
      expect(() => describeToolUse('SomethingNew', input)).not.toThrow();
      expect(describeToolUse('SomethingNew', input)).toMatchObject({ kind: 'generic' });
    }
  });
});

describe('helpers', () => {
  it('humanizes underscore tokens', () => {
    expect(humanizeToolToken('read_by_url')).toBe('read by url');
    expect(humanizeToolToken('part_a__part_b')).toBe('part a part b');
  });

  it('truncates display text with ellipsis', () => {
    expect(truncateToolText('short', 10)).toBe('short');
    expect(truncateToolText('a'.repeat(12), 10)).toBe(`${'a'.repeat(7)}...`);
  });
});
