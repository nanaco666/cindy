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

function createDeps(
  overrides: Partial<FeishuMcpDeps> = {},
): FeishuMcpDeps & { client: { im: { message: { list: ReturnType<typeof vi.fn> } } } } {
  const client = {
    im: {
      message: {
        list: vi.fn(async () => ({
          code: 0,
          data: {
            items: [
              {
                message_id: 'om_1',
                sender: { id_type: 'open_id', id: 'ou_peer' },
              },
            ],
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
    resolveP2pChatId: vi.fn(async () => ({ ok: true, data: { chat_id: 'oc_p2p' } })),
    ensureToken: vi.fn(async () => ({ token: 'user-token' })),
    forceRefresh: vi.fn(async () => ({ token: 'fresh-token' })),
    getOrDownloadMedia: vi.fn(),
    uploadFeishuImage: vi.fn(),
    feishuImageMaxBytes: 10 * 1024 * 1024,
    streamToBuffer: vi.fn(),
    mimeFromHeaders: vi.fn(),
    ...overrides,
  };
}

async function callImReadMessages(deps: FeishuMcpDeps, args: Record<string, unknown>) {
  const server = createFeishuMcpServer(deps);
  return tools(server).call_tool.handler({
    name: 'im_read_messages',
    args,
  });
}

describe('im_read_messages p2p open_id support', () => {
  it('resolves open_id to p2p chat_id before listing messages', async () => {
    const deps = createDeps();

    const result = await callImReadMessages(deps, {
      open_id: 'ou_peer',
      page_size: 10,
    });

    expect(result.isError).toBeUndefined();
    expect(deps.resolveP2pChatId).toHaveBeenCalledWith(
      deps.client,
      'ou_peer',
      expect.any(Object),
    );
    expect(deps.client.im.message.list).toHaveBeenCalledWith(
      {
        params: {
          container_id_type: 'chat',
          container_id: 'oc_p2p',
          page_size: 10,
          sort_type: 'ByCreateTimeDesc',
        },
      },
      expect.any(Object),
    );
    expect(parse(result)).toMatchObject({
      ok: true,
      data: { messages: [{ message_id: 'om_1' }] },
    });
  });

  it('requires exactly one of container_id or open_id', async () => {
    const missing = await callImReadMessages(createDeps(), { page_size: 10 });
    expect(missing.isError).toBe(true);
    expect(parse(missing)).toMatchObject({
      ok: false,
      errorCode: 'INVALID_ARGS',
    });

    const both = await callImReadMessages(createDeps(), {
      container_id: 'oc_group',
      open_id: 'ou_peer',
      page_size: 10,
    });
    expect(both.isError).toBe(true);
    expect(parse(both)).toMatchObject({
      ok: false,
      errorCode: 'INVALID_ARGS',
    });
  });

  it('returns a clear error when p2p chat lookup is empty', async () => {
    const deps = createDeps({
      resolveP2pChatId: vi.fn(async () => ({
        ok: false,
        errorCode: 'P2P_CHAT_NOT_FOUND',
        data: { open_id: 'ou_peer', message: '未找到与该用户的单聊会话。' },
      })),
    });

    const result = await callImReadMessages(deps, {
      open_id: 'ou_peer',
      page_size: 10,
    });

    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({
      ok: false,
      errorCode: 'P2P_CHAT_NOT_FOUND',
      data: { open_id: 'ou_peer' },
    });
    expect(deps.client.im.message.list).not.toHaveBeenCalled();
  });
});
