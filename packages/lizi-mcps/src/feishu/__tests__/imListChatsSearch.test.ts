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
    request: ReturnType<typeof vi.fn>;
    im: { chat: { list: ReturnType<typeof vi.fn> } };
  };
} {
  const client = {
    request: vi.fn(async () => ({
      code: 0,
      data: {
        items: [
          {
            meta_data: {
              chat_id: 'oc_project',
              name: 'project-xdt-小镇工程师',
              chat_mode: 'default',
            },
          },
        ],
        total: 1,
      },
    })),
    im: {
      chat: {
        list: vi.fn(async () => ({
          code: 0,
          data: {
            items: [{ chat_id: 'oc_list', name: '列表里的群' }],
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

async function callImListChats(deps: FeishuMcpDeps, args: Record<string, unknown>) {
  const server = createFeishuMcpServer(deps);
  return tools(server).call_tool.handler({ name: 'im_list_chats', args });
}

describe('im_list_chats search mode', () => {
  it('uses Feishu chat search API when query is provided', async () => {
    const deps = createDeps();

    const result = await callImListChats(deps, {
      query: '小镇工程师',
      page_size: 20,
    });

    expect(result.isError).toBeUndefined();
    expect(deps.client.request).toHaveBeenCalledWith(
      {
        method: 'POST',
        url: '/open-apis/im/v2/chats/search',
        params: { page_size: 20 },
        data: { query: '小镇工程师' },
      },
      expect.any(Object),
    );
    expect(deps.client.im.chat.list).not.toHaveBeenCalled();
    expect(parse(result)).toMatchObject({
      ok: true,
      data: {
        chats: [{ chat_id: 'oc_project', name: 'project-xdt-小镇工程师' }],
        total: 1,
      },
    });
  });

  it('quotes hyphenated query before sending it to chat search', async () => {
    const deps = createDeps();

    await callImListChats(deps, {
      query: 'project-xdt-小镇工程师',
    });

    expect(deps.client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { query: '"project-xdt-小镇工程师"' },
      }),
      expect.any(Object),
    );
  });

  it('unwraps already JSON-quoted queries before search', async () => {
    const deps = createDeps();

    await callImListChats(deps, {
      query: '"已引号的群名"',
    });

    expect(deps.client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { query: '已引号的群名' },
      }),
      expect.any(Object),
    );
  });

  it('maps public chat modes to Feishu wire values', async () => {
    const deps = createDeps();

    await callImListChats(deps, {
      query: '工程师',
      chat_modes: ['topic', 'group', 'topic'],
      search_types: ['private'],
      sort: 'member_count',
      disable_search_by_user: true,
    });

    expect(deps.client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          query: '工程师',
          filter: {
            search_types: ['private'],
            chat_modes: ['thread', 'default'],
            disable_search_by_user: true,
          },
          sorter: 'member_count_desc',
        },
      }),
      expect.any(Object),
    );
  });

  it('filters exact chat name on search results', async () => {
    const deps = createDeps();
    deps.client.request.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          { meta_data: { chat_id: 'oc_exact', name: '小镇工程师群' } },
          { meta_data: { chat_id: 'oc_fuzzy', name: '小镇工程师群-旧' } },
        ],
        total: 2,
      },
    });

    const result = await callImListChats(deps, {
      query: '小镇工程师群',
      exact_name: true,
    });

    expect(parse(result)).toMatchObject({
      ok: true,
      data: {
        chats: [{ chat_id: 'oc_exact', name: '小镇工程师群' }],
        total: 1,
        search_total: 2,
        exact_name: true,
      },
    });
  });

  it('does not report exact_name filtering when query is omitted', async () => {
    const deps = createDeps();

    const result = await callImListChats(deps, {
      member_ids: ['ou_member'],
      exact_name: true,
    });

    const payload = parse(result);
    expect(payload).toMatchObject({
      ok: true,
      data: {
        chats: [{ chat_id: 'oc_project', name: 'project-xdt-小镇工程师' }],
        total: 1,
      },
    });
    expect(payload.data.exact_name).toBeUndefined();
    expect(payload.data.search_total).toBeUndefined();
  });

  it('also accepts SDK v1 chat search items without meta_data envelope', async () => {
    const deps = createDeps();
    deps.client.request.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            chat_id: 'oc_v1',
            name: 'project-xdt-小镇工程师',
            chat_status: 'normal',
          },
        ],
        has_more: true,
        page_token: 'next-page',
      },
    });

    const result = await callImListChats(deps, {
      query: 'project-xdt-小镇工程师',
      search_types: ['private'],
      chat_modes: ['topic'],
      sort: 'member_count',
      disable_search_by_user: true,
      exact_name: true,
      page_size: 20,
    });

    expect(parse(result)).toMatchObject({
      ok: true,
      data: {
        chats: [{ chat_id: 'oc_v1', name: 'project-xdt-小镇工程师' }],
        total: 1,
        has_more: true,
        page_token: 'next-page',
        next_page_args: {
          query: 'project-xdt-小镇工程师',
          search_types: ['private'],
          chat_modes: ['topic'],
          sort: 'member_count',
          disable_search_by_user: true,
          exact_name: true,
          page_size: 20,
          page_token: 'next-page',
        },
      },
    });
    expect(parse(result).data.hint).toContain('next_page_args');
  });

  it('keeps old chat list behavior when no search args are provided', async () => {
    const deps = createDeps();

    const result = await callImListChats(deps, {
      page_size: 20,
    });

    expect(deps.client.im.chat.list).toHaveBeenCalledWith(
      { params: { page_size: 20 } },
      expect.any(Object),
    );
    expect(deps.client.request).not.toHaveBeenCalled();
    expect(parse(result)).toMatchObject({
      ok: true,
      data: {
        chats: [{ chat_id: 'oc_list', name: '列表里的群' }],
      },
    });
  });
});
