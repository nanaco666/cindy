import { describe, expect, it, vi } from 'vitest';
import * as lark from '@larksuiteoapi/node-sdk';

import { createFeishuMcpServer } from '../mcp/server.js';
import type { FeishuMcpDeps } from '../../types.js';

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

function tools(server: unknown) {
  return (server as {
    _registeredTools: Record<string, { handler: (args: unknown) => Promise<ToolResult> }>;
  })._registeredTools;
}

function parse(result: ToolResult) {
  const block = result.content[0];
  if (block?.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('Expected first MCP content block to be text');
  }
  return JSON.parse(block.text);
}

function createDeps(): FeishuMcpDeps & {
  client: { im: { message: { list: ReturnType<typeof vi.fn> } } };
} {
  const client = {
    im: {
      message: {
        list: vi.fn(async () => ({
          code: 0,
          data: {
            items: [{ message_id: 'om_1', sender: { id_type: 'open_id', id: 'ou_peer' } }],
          },
        })),
      },
    },
  };

  return {
    client,
    getFeishuClient: () => client as unknown as lark.Client,
    safeCall: async (fn) => {
      try {
        const res = await fn();
        return res.code && res.code !== 0
          ? { ok: false, errorCode: 'FEISHU_API_ERROR', data: res }
          : { ok: true, data: res.data };
      } catch (err) {
        return { ok: false, errorCode: 'NETWORK_ERROR', data: err };
      }
    },
    // 本组用例只走 container_id,不会触发 p2p 反查;仅为满足 FeishuMcpDeps 接口
    // (open_id 反查特性合入后 resolveP2pChatId 成为必填)提供 stub。
    resolveP2pChatId: vi.fn(async () => ({ ok: true, data: { chat_id: 'oc_p2p' } })),
    ensureToken: vi.fn(async () => ({ token: 'user-token' })),
    forceRefresh: vi.fn(async () => ({ token: 'fresh-token' })),
    getOrDownloadMedia: vi.fn(),
    uploadFeishuImage: vi.fn(),
    feishuImageMaxBytes: 10 * 1024 * 1024,
    streamToBuffer: vi.fn(),
    mimeFromHeaders: vi.fn(),
  };
}

async function callImReadMessages(deps: FeishuMcpDeps, args: Record<string, unknown>) {
  const server = createFeishuMcpServer(deps);
  return tools(server).call_tool.handler({ name: 'im_read_messages', args });
}

describe('im_read_messages page_size cap', () => {
  it('caps page_size to Feishu max 50 and tells the caller it was capped', async () => {
    const deps = createDeps();
    // 飞书还有后续页:确认 cap 提示与 has_more 提示能共存。
    deps.client.im.message.list = vi.fn(async () => ({
      code: 0,
      data: {
        items: [{ message_id: 'om_1', sender: { id_type: 'open_id', id: 'ou_peer' } }],
        has_more: true,
        page_token: 'next-token',
      },
    }));

    const result = await callImReadMessages(deps, { container_id: 'oc_group', page_size: 100 });

    expect(result.isError).toBeUndefined();
    // 发给飞书的是钳过的 50,不是原始 100 —— 不会裸撞飞书 400。
    expect(deps.client.im.message.list).toHaveBeenCalledWith(
      {
        params: {
          container_id_type: 'chat',
          container_id: 'oc_group',
          page_size: 50,
          sort_type: 'ByCreateTimeDesc',
        },
      },
      expect.any(Object),
    );
    const payload = parse(result);
    expect(payload).toMatchObject({
      ok: true,
      data: {
        requested_page_size: 100,
        applied_page_size: 50,
        has_more: true,
        page_token: 'next-token',
      },
    });
    // hint 同时说明"被钳到 50"和"可翻页",别让模型以为自己拿到了 100。
    expect(payload.data.hint).toContain('50');
    expect(payload.data.hint).toContain('page_token');
  });

  it('does not add a cap notice when page_size is within the limit', async () => {
    const deps = createDeps();

    const result = await callImReadMessages(deps, { container_id: 'oc_group', page_size: 30 });

    expect(deps.client.im.message.list).toHaveBeenCalledWith(
      {
        params: {
          container_id_type: 'chat',
          container_id: 'oc_group',
          page_size: 30,
          sort_type: 'ByCreateTimeDesc',
        },
      },
      expect.any(Object),
    );
    const payload = parse(result);
    expect(payload.data.requested_page_size).toBeUndefined();
    expect(payload.data.applied_page_size).toBeUndefined();
  });

  it('defaults to 20 when page_size is omitted', async () => {
    const deps = createDeps();

    await callImReadMessages(deps, { container_id: 'oc_group' });

    expect(deps.client.im.message.list).toHaveBeenCalledWith(
      {
        params: {
          container_id_type: 'chat',
          container_id: 'oc_group',
          page_size: 20,
          sort_type: 'ByCreateTimeDesc',
        },
      },
      expect.any(Object),
    );
  });

  it('allows chat callers to request ascending create-time order', async () => {
    const deps = createDeps();

    await callImReadMessages(deps, {
      container_id: 'oc_group',
      sort_type: 'ByCreateTimeAsc',
    });

    expect(deps.client.im.message.list).toHaveBeenCalledWith(
      {
        params: {
          container_id_type: 'chat',
          container_id: 'oc_group',
          page_size: 20,
          sort_type: 'ByCreateTimeAsc',
        },
      },
      expect.any(Object),
    );
  });

  it('clamps a below-range page_size up to 1 and reports it (lower bound)', async () => {
    const deps = createDeps();

    const result = await callImReadMessages(deps, { container_id: 'oc_group', page_size: 0 });

    // 下界同样钳制 + 告知,不再静默(greptile P2 反馈:两端对称)。
    expect(deps.client.im.message.list).toHaveBeenCalledWith(
      {
        params: {
          container_id_type: 'chat',
          container_id: 'oc_group',
          page_size: 1,
          sort_type: 'ByCreateTimeDesc',
        },
      },
      expect.any(Object),
    );
    const payload = parse(result);
    expect(payload.data.requested_page_size).toBe(0);
    expect(payload.data.applied_page_size).toBe(1);
    expect(payload.data.hint).toContain('1');
  });
});
