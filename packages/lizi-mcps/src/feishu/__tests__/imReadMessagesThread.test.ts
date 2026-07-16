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
  client: {
    im: {
      message: {
        get: ReturnType<typeof vi.fn>;
        list: ReturnType<typeof vi.fn>;
      };
    };
    contact: { user: { batch: ReturnType<typeof vi.fn> } };
  };
} {
  const client = {
    im: {
      message: {
        get: vi.fn(async () => ({
          code: 0,
          data: {
            items: [{ message_id: 'om_root', thread_id: 'omt_resolved' }],
          },
        })),
        list: vi.fn(async () => ({
          code: 0,
          data: {
            items: [
              {
                message_id: 'om_reply_1',
                thread_id: 'omt_1',
                sender: { id_type: 'open_id', id: 'ou_peer' },
              },
            ],
          },
        })),
      },
    },
    contact: {
      user: {
        batch: vi.fn(async () => ({
          code: 0,
          data: {
            items: [{ open_id: 'ou_peer', name: 'Peer User' }],
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
  };
}

async function callImReadMessages(deps: FeishuMcpDeps, args: Record<string, unknown>) {
  const server = createFeishuMcpServer(deps);
  return tools(server).call_tool.handler({ name: 'im_read_messages', args });
}

describe('im_read_messages thread mode', () => {
  it('lists messages from a thread container', async () => {
    const deps = createDeps();

    const result = await callImReadMessages(deps, {
      container_id_type: 'thread',
      container_id: 'omt_1',
      page_size: 20,
    });

    expect(result.isError).toBeUndefined();
    expect(deps.client.im.message.get).not.toHaveBeenCalled();
    expect(deps.client.im.message.list).toHaveBeenCalledWith(
      {
        params: {
          container_id_type: 'thread',
          container_id: 'omt_1',
          page_size: 20,
          sort_type: 'ByCreateTimeAsc',
        },
      },
      expect.any(Object),
    );
    expect(parse(result)).toMatchObject({
      ok: true,
      data: {
        thread_id: 'omt_1',
        messages: [
          {
            message_id: 'om_reply_1',
            sender: { sender_name: 'Peer User' },
          },
        ],
        user_map: { ou_peer: 'Peer User' },
      },
    });
  });

  it('resolves message_id to thread_id before listing replies', async () => {
    const deps = createDeps();

    const result = await callImReadMessages(deps, {
      container_id_type: 'thread',
      message_id: 'om_root',
    });

    expect(result.isError).toBeUndefined();
    expect(deps.client.im.message.get).toHaveBeenCalledWith(
      { path: { message_id: 'om_root' } },
      expect.any(Object),
    );
    expect(deps.client.im.message.list).toHaveBeenCalledWith(
      {
        params: {
          container_id_type: 'thread',
          container_id: 'omt_resolved',
          page_size: 20,
          sort_type: 'ByCreateTimeAsc',
        },
      },
      expect.any(Object),
    );
    expect(parse(result)).toMatchObject({
      ok: true,
      data: {
        thread_id: 'omt_resolved',
        source_message_id: 'om_root',
      },
    });
  });

  it('accepts both thread_id and source message_id when container_id is already a thread id', async () => {
    const deps = createDeps();
    deps.client.im.message.get = vi.fn(async () => ({
      code: 0,
      data: {
        items: [{ message_id: 'om_root', thread_id: 'omt_known' }],
      },
    }));

    const result = await callImReadMessages(deps, {
      container_id_type: 'thread',
      container_id: 'omt_known',
      message_id: 'om_root',
      page_size: 20,
    });

    expect(result.isError).toBeUndefined();
    expect(deps.client.im.message.get).toHaveBeenCalledWith(
      { path: { message_id: 'om_root' } },
      expect.any(Object),
    );
    expect(deps.client.im.message.list).toHaveBeenCalledWith(
      {
        params: {
          container_id_type: 'thread',
          container_id: 'omt_known',
          page_size: 20,
          sort_type: 'ByCreateTimeAsc',
        },
      },
      expect.any(Object),
    );
    expect(parse(result)).toMatchObject({
      ok: true,
      data: {
        thread_id: 'omt_known',
        source_message_id: 'om_root',
      },
    });
  });

  it('rejects mismatched thread_id and source message_id in thread mode', async () => {
    const deps = createDeps();

    const result = await callImReadMessages(deps, {
      container_id_type: 'thread',
      container_id: 'omt_known',
      message_id: 'om_root',
    });

    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({
      ok: false,
      errorCode: 'INVALID_ARGS',
      data: {
        container_id: 'omt_known',
        message_id: 'om_root',
        resolved_thread_id: 'omt_resolved',
      },
    });
    expect(deps.client.im.message.list).not.toHaveBeenCalled();
  });

  it('requires thread container_id or message_id in thread mode', async () => {
    const missing = await callImReadMessages(createDeps(), {
      container_id_type: 'thread',
    });
    expect(missing.isError).toBe(true);
    expect(parse(missing)).toMatchObject({
      ok: false,
      errorCode: 'INVALID_ARGS',
    });

  });

  it('rejects time filters in thread mode before calling Feishu', async () => {
    const deps = createDeps();

    const result = await callImReadMessages(deps, {
      container_id_type: 'thread',
      container_id: 'omt_1',
      start_time: '2026-06-22T10:00:00+08:00',
      end_time: '2026-06-22T11:00:00+08:00',
    });

    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({
      ok: false,
      errorCode: 'INVALID_ARGS',
      data: {
        unsupported_fields: ['start_time', 'end_time'],
      },
    });
    expect(deps.client.im.message.list).not.toHaveBeenCalled();
  });

  it('rejects both container_id and message_id when container_id is not a thread id', async () => {
    const result = await callImReadMessages(createDeps(), {
      container_id_type: 'thread',
      container_id: 'om_not_thread',
      message_id: 'om_root',
    });

    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({
      ok: false,
      errorCode: 'INVALID_ARGS',
    });
  });

  it('caps page_size to the Feishu message max 50 and reports it', async () => {
    const deps = createDeps();
    deps.client.im.message.list = vi.fn(async () => ({
      code: 0,
      data: {
        items: [],
        has_more: true,
        page_token: 'next-token',
      },
    }));

    const result = await callImReadMessages(deps, {
      container_id_type: 'thread',
      container_id: 'omt_1',
      page_size: 1000,
    });

    expect(deps.client.im.message.list).toHaveBeenCalledWith(
      {
        params: {
          container_id_type: 'thread',
          container_id: 'omt_1',
          page_size: 50,
          sort_type: 'ByCreateTimeAsc',
        },
      },
      expect.any(Object),
    );
    const payload = parse(result);
    expect(payload).toMatchObject({
      ok: true,
      data: {
        requested_page_size: 1000,
        applied_page_size: 50,
        has_more: true,
        page_token: 'next-token',
      },
    });
    expect(payload.data.hint).toContain('50');
    expect(payload.data.hint).toContain('page_token');
  });
});
