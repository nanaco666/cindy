/**
 * Slack 渠道映射单测 — messageId codec / actionId codec / Block Kit 结构 /
 * markdown→mrkdwn 转换。这些是 desktop ↔ Slack 之间的协议面, 行为钉死。
 */
import { describe, expect, it } from 'vitest';

import {
  encodeMessageId,
  decodeMessageId,
  encodeActionId,
  decodeActionId,
  buildCardBlocks,
  buildMrkdwnBlocks,
} from '../blocks.js';
import { markdownToMrkdwn } from '../mrkdwn.js';
import type { InteractiveCardSpec } from '../../types.js';

describe('messageId codec', () => {
  it('round-trip: channelId|ts', () => {
    const id = encodeMessageId('D0123ABC', '1718000000.123456');
    expect(id).toBe('D0123ABC|1718000000.123456');
    expect(decodeMessageId(id)).toEqual({
      channelId: 'D0123ABC',
      ts: '1718000000.123456',
    });
  });

  it('decode 拒绝非法格式', () => {
    expect(() => decodeMessageId('no-separator')).toThrow();
    expect(() => decodeMessageId('|ts-only')).toThrow();
  });
});

describe('actionId codec', () => {
  it('round-trip: buttonId#index(buttonId 可含 #)', () => {
    expect(decodeActionId(encodeActionId('model:pick', 3))).toBe('model:pick');
    expect(decodeActionId(encodeActionId('permission:allow:once', 0))).toBe(
      'permission:allow:once',
    );
  });

  it('无数字后缀时原样返回(防御)', () => {
    expect(decodeActionId('plain-id')).toBe('plain-id');
    expect(decodeActionId('weird#suffix')).toBe('weird#suffix');
  });
});

describe('buildCardBlocks', () => {
  const SPEC: InteractiveCardSpec = {
    title: '🔧 工具调用：Bash',
    body: '**参数预览**',
    buttons: [
      { id: 'permission:allow:once', label: '✅ 仅本次允许', type: 'primary', payload: { requestId: 'r1' } },
      { id: 'permission:allow:always', label: '✅ 总是允许', type: 'default', payload: { requestId: 'r1' } },
      { id: 'permission:deny', label: '❌ 拒绝', type: 'danger', payload: { requestId: 'r1' } },
    ],
  };

  it('header + section + actions 结构, action_id 唯一且 value 带 JSON payload', () => {
    const blocks = buildCardBlocks(SPEC, markdownToMrkdwn(SPEC.body));
    expect(blocks[0].type).toBe('header');
    expect(blocks[1].type).toBe('section');
    const actions = blocks[2] as { type: string; elements: Array<Record<string, unknown>> };
    expect(actions.type).toBe('actions');
    expect(actions.elements).toHaveLength(3);
    const ids = actions.elements.map((e) => e.action_id);
    expect(new Set(ids).size).toBe(3); // 唯一性
    expect(decodeActionId(String(ids[0]))).toBe('permission:allow:once');
    expect(JSON.parse(String(actions.elements[0].value))).toEqual({ requestId: 'r1' });
    // style 映射: primary / danger 有 style, default 无
    expect(actions.elements[0].style).toBe('primary');
    expect(actions.elements[1].style).toBeUndefined();
    expect(actions.elements[2].style).toBe('danger');
  });

  it('按钮 >5 个时分块(Slack actions block 上限)', () => {
    const many: InteractiveCardSpec = {
      body: 'pick one',
      buttons: Array.from({ length: 12 }, (_, i) => ({
        id: 'model:pick',
        label: `M${i}`,
        payload: { i },
      })),
    };
    const blocks = buildCardBlocks(many, 'pick one');
    const actionBlocks = blocks.filter((b) => b.type === 'actions');
    expect(actionBlocks).toHaveLength(3); // 5+5+2
    // 跨块 action_id 仍全局唯一
    const ids = actionBlocks.flatMap((b) =>
      (b as unknown as { elements: Array<{ action_id: string }> }).elements.map(
        (e) => e.action_id,
      ),
    );
    expect(new Set(ids).size).toBe(12);
  });

  it('超长 body 切多个 section(3000 上限)', () => {
    const blocks = buildMrkdwnBlocks('x'.repeat(6500));
    expect(blocks).toHaveLength(3);
    expect(blocks.every((b) => b.type === 'section')).toBe(true);
  });
});

describe('markdownToMrkdwn', () => {
  it('粗体 / 删除线 / 链接 / 标题 / 列表', () => {
    expect(markdownToMrkdwn('**加粗** 和 __也加粗__')).toBe('*加粗* 和 *也加粗*');
    expect(markdownToMrkdwn('~~删掉~~')).toBe('~删掉~');
    expect(markdownToMrkdwn('[文档](https://example.com/a)')).toBe(
      '<https://example.com/a|文档>',
    );
    expect(markdownToMrkdwn('## 标题二')).toBe('*标题二*');
    expect(markdownToMrkdwn('- 项目一\n* 项目二')).toBe('• 项目一\n• 项目二');
  });

  it('代码块与行内 code 内部不转换', () => {
    const fence = '```\n**not bold** [x](https://a.b)\n```';
    expect(markdownToMrkdwn(fence)).toBe(fence);
    expect(markdownToMrkdwn('`**code**` 外面 **bold**')).toBe('`**code**` 外面 *bold*');
  });

  it('图片 markdown 不被当作链接转换', () => {
    expect(markdownToMrkdwn('![alt](https://example.com/img.png)')).toBe(
      '![alt](https://example.com/img.png)',
    );
  });
});

// ── thread = session 模型 ─────────────────────────────────────────────────────

import { SlackIM } from '../index.js';
import type {
  SlackRelayInboundEvent,
  SlackRelayTransport,
} from '../transport.js';
import type { IMHost } from '../../types.js';

function makeHost(): IMHost {
  return {
    paths: { feishuMediaDir: '/tmp/x', slackMediaDir: '/tmp/y' },
    secrets: {
      isAvailable: () => false,
      write: () => false,
      read: () => null,
      remove: () => {},
    },
    ipc: { handle: () => {}, broadcast: () => {} },
    httpPostForm: async () => ({ status: 200, body: {} }),
    createLogger: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  } as unknown as IMHost;
}

interface TransportHarness {
  transport: SlackRelayTransport;
  calls: Array<{ method: string; args: Record<string, unknown> }>;
  pushEvent: (e: SlackRelayInboundEvent) => void;
}

function makeTransport(): TransportHarness {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  let onEvent: ((e: SlackRelayInboundEvent) => void) | null = null;
  const transport: SlackRelayTransport = {
    subscribe(handlers) {
      onEvent = handlers.onEvent;
      handlers.onStatus('connected');
      return () => {};
    },
    async call(method, args) {
      calls.push({ method, args });
      return { ok: true, data: { ts: '999.1' } };
    },
    async uploadFile() {
      return { ok: true, fileId: 'F1' };
    },
    async downloadFile() {
      return { ok: true };
    },
    async getLinkStatus() {
      return {
        linked: true,
        teamId: 'T1',
        slackUserId: 'U1',
        slackName: null,
        dmChannelId: 'D1',
      };
    },
  };
  return {
    transport,
    calls,
    pushEvent: (e) => onEvent?.(e),
  };
}

describe('thread = session: 入站 scopeKey 推导', () => {
  it('顶层消息 scopeKey = 自身 ts;thread 回复 scopeKey = threadTs', async () => {
    const h = makeTransport();
    const im = new SlackIM(makeHost(), h.transport);
    await im.init();
    const seen: Array<{ ts?: string; scopeKey?: string }> = [];
    im.onMessage((e) => seen.push({ ts: e.threadTs, scopeKey: e.scopeKey }));

    h.pushEvent({ kind: 'message', channelId: 'D1', ts: '100.1', text: 'top', files: [] });
    h.pushEvent({
      kind: 'message',
      channelId: 'D1',
      ts: '100.5',
      threadTs: '100.1',
      text: 'reply',
      files: [],
    });
    // 入站处理是异步的(附件下载路径)— 等 microtask 清空
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toEqual([
      { ts: undefined, scopeKey: '100.1' },
      { ts: '100.1', scopeKey: '100.1' },
    ]);
  });

  it('card_action: 顶层卡片 scopeKey 回退自身 ts(接管 root 卡退出按钮反查键)', async () => {
    const h = makeTransport();
    const im = new SlackIM(makeHost(), h.transport);
    await im.init();
    const seen: Array<{ scopeKey?: string }> = [];
    im.onCardAction((e) => seen.push({ scopeKey: e.scopeKey }));

    h.pushEvent({
      kind: 'card_action',
      channelId: 'D1',
      messageTs: '300.3',
      actionId: 'control:thread-exit#0',
      value: '{}',
    });
    h.pushEvent({
      kind: 'card_action',
      channelId: 'D1',
      messageTs: '300.9',
      threadTs: '300.3',
      actionId: 'permission:allow:once#0',
      value: '{}',
    });
    expect(seen).toEqual([{ scopeKey: '300.3' }, { scopeKey: '300.3' }]);
  });
});

describe('thread = session: 出站 thread_ts', () => {
  it('sendText/sendMarkdownText/sendInteractiveCard 透传 thread_ts;无 opts 不带', async () => {
    const h = makeTransport();
    const im = new SlackIM(makeHost(), h.transport);
    await im.init();

    await im.sendText('U1', 'hi', { threadTs: '100.1' });
    await im.sendMarkdownText('U1', '**hi**', { threadTs: '100.1' });
    await im.sendInteractiveCard('U1', { body: 'b', buttons: [] }, { threadTs: '100.1' });
    await im.sendText('U1', 'top-level');

    const postCalls = h.calls.filter((c) => c.method === 'chat.postMessage');
    expect(postCalls).toHaveLength(4);
    expect(postCalls[0].args.thread_ts).toBe('100.1');
    expect(postCalls[1].args.thread_ts).toBe('100.1');
    expect(postCalls[2].args.thread_ts).toBe('100.1');
    expect(postCalls[3].args.thread_ts).toBeUndefined();
  });

  it('startStreamingText 首发带 thread_ts;threadKeyForMessage 提取 ts', async () => {
    const h = makeTransport();
    const im = new SlackIM(makeHost(), h.transport);
    await im.init();

    await im.startStreamingText('U1', 'thinking', { threadTs: '100.1' });
    const post = h.calls.find((c) => c.method === 'chat.postMessage');
    expect(post?.args.thread_ts).toBe('100.1');

    expect(im.threadKeyForMessage('D1|456.7')).toBe('456.7');
  });
});
