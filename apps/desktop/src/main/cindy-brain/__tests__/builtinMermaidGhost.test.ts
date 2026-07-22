import { readFileSync } from 'node:fs';
import { createContext, Script } from 'node:vm';

import { repairMermaidSource } from '@lizi/maker-shared/mermaid-autofix';
import { describe, expect, it, vi } from 'vitest';

import { validateGhostManifest } from '../../../shared/ghost';

type HostMessageHandler = (message: Record<string, unknown>) => void | Promise<void>;

interface CindyMessage {
  type: string;
  callId?: string;
  ok?: boolean;
  result?: {
    markdown?: string;
    source?: string;
    changed?: boolean;
    validation?: string;
    note?: string;
  };
  message?: string;
}

const ghostRoot = new URL('../../../../resources/builtin-ghosts/official/cindy-mermaid/', import.meta.url);
const mainSource = readFileSync(new URL('main.js', ghostRoot), 'utf8');
const manifestSource = readFileSync(new URL('ghost.json', ghostRoot), 'utf8');
const provisioningSource = readFileSync(new URL('../provisioning.json', ghostRoot), 'utf8');

function createMermaidHarness() {
  let handler: HostMessageHandler | undefined;
  const messages: CindyMessage[] = [];
  const cindy = {
    onHostMessage: vi.fn((nextHandler: HostMessageHandler) => {
      handler = nextHandler;
    }),
    send: vi.fn((message: CindyMessage) => {
      messages.push(message);
    }),
  };

  new Script(mainSource, { filename: 'builtin-ghosts/official/cindy-mermaid/main.js' }).runInContext(
    createContext({ cindy }),
  );
  if (!handler) throw new Error('Cindy Mermaid did not register its host-message handler');

  return {
    async submit(source: unknown, tool = 'prepare_mermaid'): Promise<CindyMessage> {
      messages.length = 0;
      await handler!({ type: 'tool-call', tool, callId: 'call-1', args: { source } });
      const result = messages.findLast((message) => message.type === 'tool-result');
      if (!result) throw new Error('Cindy Mermaid did not return a tool-result');
      return JSON.parse(JSON.stringify(result)) as CindyMessage;
    },
  };
}

describe('内置意识 Cindy Mermaid', () => {
  it('身份卡通过校验且保持最小权限，并面向所有用户播种', () => {
    const result = validateGhostManifest(JSON.parse(manifestSource));
    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
    if (!result.ok) return;

    expect(result.manifest).toMatchObject({
      id: 'cindy-mermaid',
      name: 'Cindy Mermaid',
      version: '1.0.0',
      command: 'cindy-mermaid',
      entry: 'main.js',
      launch: 'on-demand',
      slots: ['tool'],
    });
    expect(result.manifest.tools).toHaveLength(1);
    expect(result.manifest.tools?.[0]).toMatchObject({
      name: 'prepare_mermaid',
      parameters: { type: 'object', required: ['source'] },
    });
    expect(result.manifest.network).toBeUndefined();
    expect(result.manifest.cindy).toBeUndefined();
    expect(result.manifest.panel).toBeUndefined();
    expect(result.manifest.subscribe).toBeUndefined();

    const provisioning = JSON.parse(provisioningSource) as {
      ghosts: Record<string, { audience: string }>;
    };
    expect(provisioning.ghosts['cindy-mermaid']).toEqual({ audience: 'all' });
  });

  it('合法 flowchart 保持源码并返回可直接使用的 Mermaid Markdown', async () => {
    const source = 'flowchart TD\n  A[Start] --> B[End]';
    const result = await createMermaidHarness().submit(source);

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      source,
      markdown: `\`\`\`mermaid\n${source}\n\`\`\``,
      changed: false,
      validation: 'not-performed',
    });
    expect(result.result?.note).toContain('未调用 Mermaid 引擎');
  });

  it('一次修复常见 flowchart 机械语法问题', async () => {
    const source = [
      'flowchart TD',
      'subgraph Pub["发布侧"]',
      'CFG[仓内正本 config/client-endpoints.json] → OSS[OSS 桶]',
      'end',
      'OSS -->|CDN 公开读| CDN',
    ].join('\n');
    const expected = [
      'flowchart TD',
      'subgraph Pub ["发布侧"]',
      'CFG["仓内正本 config/client-endpoints.json"] --> OSS[OSS 桶]',
      'end',
      'OSS -->|"CDN 公开读"| CDN',
    ].join('\n');

    const result = await createMermaidHarness().submit(source);
    expect(result.ok).toBe(true);
    expect(result.result?.source).toBe(expected);
    expect(result.result?.changed).toBe(true);
  });

  it('只对非 flowchart 应用安全的通用注释修复', async () => {
    const source = 'erDiagram\n// relationship\nPERSON ||--o{ ORDER : places';
    const result = await createMermaidHarness().submit(source);

    expect(result.result?.source).toBe('erDiagram\n%% relationship\nPERSON ||--o{ ORDER : places');
  });

  it('规范化 BOM、CRLF、首尾空行并解包一层 Mermaid fence', async () => {
    const result = await createMermaidHarness().submit(
      '﻿  \r\n```mmd\r\n\r\nflowchart LR\r\nA → B\r\n\r\n```\r\n',
    );

    expect(result.ok).toBe(true);
    expect(result.result?.source).toBe('flowchart LR\nA --> B');
    expect(result.result?.markdown).toBe('```mermaid\nflowchart LR\nA --> B\n```');
  });

  it('源码含反引号时使用更长的安全 fence', async () => {
    const source = 'flowchart TD\nA["value ``` raw"] --> B';
    const result = await createMermaidHarness().submit(source);

    expect(result.result?.markdown).toBe(`\`\`\`\`mermaid\n${source}\n\`\`\`\``);
  });

  it.each([
    [undefined, 'INVALID_SOURCE'],
    [42, 'INVALID_SOURCE'],
    ['', 'INVALID_SOURCE'],
    ['flowchart TD\n' + 'x'.repeat(2001), 'LINE_TOO_LONG'],
    ['A\n'.repeat(50001), 'SOURCE_TOO_LARGE'],
  ])('拒绝非法或过大的 source %#', async (source, code) => {
    const result = await createMermaidHarness().submit(source);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(code);
  });

  it('未知工具返回稳定错误', async () => {
    const result = await createMermaidHarness().submit('flowchart TD\nA --> B', 'validate_mermaid');
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain('UNKNOWN_TOOL');
  });

  it.each([
    'flowchart TD\nA → B\nB ⇒ C',
    'flowchart LR\nC1 -->|注册 + 入队| H1',
    'flowchart TD\nA[Step: parse (user) input] --> B',
    'flowchart TD\nA[(database)] --> B[[subroutine]]',
    'flowchart TD\nA[go → stop] --> B\nB → C',
    'sequenceDiagram\n// note here\nA->>B: hi',
    'erDiagram\nPERSON ||--o{ ORDER : places',
    '---\ntitle: demo\n---\nflowchart TD\nA → B',
  ])('与 maker-shared 自动修复保持一致：%s', async (source) => {
    const result = await createMermaidHarness().submit(source);
    expect(result.ok).toBe(true);
    expect(result.result?.source).toBe(repairMermaidSource(source));
  });
});
