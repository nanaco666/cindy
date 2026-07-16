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
        create: ReturnType<typeof vi.fn>;
        reply: ReturnType<typeof vi.fn>;
      };
    };
  };
} {
  const client = {
    im: {
      message: {
        create: vi.fn(async () => ({
          code: 0,
          data: {
            message_id: 'om_sent_1',
            chat_id: 'oc_group',
            create_time: '1782200000',
          },
        })),
        reply: vi.fn(async () => ({
          code: 0,
          data: {
            message_id: 'om_reply_1',
            chat_id: 'oc_group',
            thread_id: 'omt_thread',
            create_time: '1782200000',
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

async function callImSendMessage(deps: FeishuMcpDeps, args: Record<string, unknown>) {
  const server = createFeishuMcpServer(deps);
  return tools(server).call_tool.handler({ name: 'im_send_message', args });
}

describe('im_send_message reply mode', () => {
  it('replies to a message in thread mode when message_id is provided', async () => {
    const deps = createDeps();

    const result = await callImSendMessage(deps, {
      message_id: 'om_root',
      content: '已确认,失败原因是资源缺失。',
    });

    expect(result.isError).toBeUndefined();
    expect(deps.client.im.message.reply).toHaveBeenCalledWith(
      {
        path: { message_id: 'om_root' },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text: '已确认,失败原因是资源缺失。' }),
          reply_in_thread: true,
        },
      },
      expect.any(Object),
    );
    expect(deps.client.im.message.create).not.toHaveBeenCalled();
    expect(parse(result)).toMatchObject({
      ok: true,
      data: {
        message_id: 'om_reply_1',
        chat_id: 'oc_group',
        thread_id: 'omt_thread',
      },
    });
  });

  it('keeps existing send behavior when receive_id is provided', async () => {
    const deps = createDeps();

    const result = await callImSendMessage(deps, {
      receive_id_type: 'chat_id',
      receive_id: 'oc_group',
      content: '普通群消息',
    });

    expect(result.isError).toBeUndefined();
    expect(deps.client.im.message.create).toHaveBeenCalledWith(
      {
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_group',
          msg_type: 'text',
          content: JSON.stringify({ text: '普通群消息' }),
        },
      },
      expect.any(Object),
    );
    expect(deps.client.im.message.reply).not.toHaveBeenCalled();
  });

  it('passes through preformatted text JSON and uuid in reply mode', async () => {
    const deps = createDeps();

    const result = await callImSendMessage(deps, {
      message_id: 'om_root',
      content: '{"text":"hello"}',
      uuid: 'uuid-1',
    });

    expect(result.isError).toBeUndefined();
    expect(deps.client.im.message.reply).toHaveBeenCalledWith(
      {
        path: { message_id: 'om_root' },
        data: {
          msg_type: 'text',
          content: '{"text":"hello"}',
          reply_in_thread: true,
          uuid: 'uuid-1',
        },
      },
      expect.any(Object),
    );
  });

  it('allows non-thread reply when explicitly requested', async () => {
    const deps = createDeps();

    const result = await callImSendMessage(deps, {
      message_id: 'om_root',
      content: '普通回复',
      reply_in_thread: false,
    });

    expect(result.isError).toBeUndefined();
    expect(deps.client.im.message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reply_in_thread: false }),
      }),
      expect.any(Object),
    );
  });

  it('rejects ambiguous target arguments before calling Feishu', async () => {
    const deps = createDeps();

    const result = await callImSendMessage(deps, {
      receive_id: 'oc_group',
      message_id: 'om_root',
      content: 'hello',
    });

    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({
      ok: false,
      errorCode: 'INVALID_ARGS',
    });
    expect(deps.client.im.message.create).not.toHaveBeenCalled();
    expect(deps.client.im.message.reply).not.toHaveBeenCalled();
  });

  it('requires either receive_id or message_id before calling Feishu', async () => {
    const deps = createDeps();

    const result = await callImSendMessage(deps, {
      content: 'hello',
    });

    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({
      ok: false,
      errorCode: 'INVALID_ARGS',
    });
    expect(deps.client.im.message.create).not.toHaveBeenCalled();
    expect(deps.client.im.message.reply).not.toHaveBeenCalled();
  });
});
