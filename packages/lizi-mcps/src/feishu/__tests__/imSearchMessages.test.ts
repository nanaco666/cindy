import { describe, expect, it, vi } from 'vitest';
import * as lark from '@larksuiteoapi/node-sdk';

import { createFeishuMcpServer } from '../mcp/server.js';
import type { FeishuMcpDeps } from '../../types.js';

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

function tools(server: unknown) {
  return (
    server as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<ToolResult> }>;
    }
  )._registeredTools;
}

function parse(result: ToolResult) {
  const block = result.content[0];
  if (block?.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('Expected first MCP content block to be text');
  }
  return JSON.parse(block.text);
}

/**
 * Harness for im_search_messages. Stubs the three client surfaces the tool
 * touches: `client.request` (the POST /open-apis/search/v2/message call routed
 * through callOpenApi), `client.im.message.get` (per-hit hydration) and
 * `client.contact.user.batch` (open_id → name resolution).
 */
function createDeps(over: {
  searchItems?: unknown[];
  hasMore?: boolean;
  pageToken?: string;
} = {}) {
  const request = vi.fn(async () => ({
    code: 0,
    data: {
      items: over.searchItems ?? ['om_1', 'om_2'],
      has_more: over.hasMore ?? false,
      ...(over.pageToken ? { page_token: over.pageToken } : {}),
    },
  }));
  const get = vi.fn(async (payload: { path: { message_id: string } }) => ({
    code: 0,
    data: {
      items: [
        {
          message_id: payload.path.message_id,
          msg_type: 'text',
          body: { content: '{"text":"hello"}' },
          sender: { id_type: 'open_id', id: 'ou_a', sender_type: 'user' },
        },
      ],
    },
  }));
  const batch = vi.fn(async () => ({
    code: 0,
    data: { items: [{ open_id: 'ou_a', name: 'Alice' }] },
  }));

  const client = {
    request,
    im: { message: { get } },
    contact: { user: { batch } },
  };

  const deps = {
    client,
    getFeishuClient: () => client as unknown as lark.Client,
    safeCall: async (fn: () => Promise<{ code?: number; data?: unknown }>) => {
      try {
        const res = await fn();
        return res.code && res.code !== 0
          ? { ok: false, errorCode: 'FEISHU_API_ERROR', data: res }
          : { ok: true, data: res.data };
      } catch (err) {
        return { ok: false, errorCode: 'NETWORK_ERROR', data: err };
      }
    },
    resolveP2pChatId: vi.fn(),
    ensureToken: vi.fn(async () => ({ token: 'user-token' })),
    forceRefresh: vi.fn(async () => ({ token: 'fresh-token' })),
    getOrDownloadMedia: vi.fn(),
    uploadFeishuImage: vi.fn(),
    feishuImageMaxBytes: 10 * 1024 * 1024,
    streamToBuffer: vi.fn(),
    mimeFromHeaders: vi.fn(),
  } as unknown as FeishuMcpDeps & { client: typeof client };
  return deps;
}

async function search(deps: FeishuMcpDeps, args: Record<string, unknown>) {
  const server = createFeishuMcpServer(deps);
  return tools(server).call_tool.handler({ name: 'im_search_messages', args });
}

describe('im_search_messages', () => {
  it('searches via POST /search/v2/message and hydrates hits with sender_name', async () => {
    const deps = createDeps();
    const result = await search(deps, { query: '周会纪要' });
    expect(result.isError).toBeUndefined();

    // POST to the search endpoint with the keyword in the body.
    expect(deps.client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: '/open-apis/search/v2/message',
        data: expect.objectContaining({ query: '周会纪要' }),
      }),
      expect.any(Object),
    );
    // Each returned message_id is hydrated via im.message.get.
    expect(deps.client.im.message.get).toHaveBeenCalledTimes(2);

    const body = parse(result);
    expect(body).toMatchObject({
      ok: true,
      data: {
        query: '周会纪要',
        count: 2,
        has_more: false,
        user_map: { ou_a: 'Alice' },
      },
    });
    // sender enriched with best-effort sender_name, same shape as im_read_messages.
    expect(body.data.messages[0].sender.sender_name).toBe('Alice');
    expect(body.data.messages.map((m: { message_id: string }) => m.message_id)).toEqual([
      'om_1',
      'om_2',
    ]);
  });

  it('hydrate=false returns only message_ids without fetching content', async () => {
    const deps = createDeps();
    const body = parse(await search(deps, { query: 'x', hydrate: false }));
    expect(body).toMatchObject({ ok: true, data: { message_ids: ['om_1', 'om_2'] } });
    expect(body.data.messages).toBeUndefined();
    expect(deps.client.im.message.get).not.toHaveBeenCalled();
  });

  it('keeps the hydrate=true shape (messages/user_map) on an empty result', async () => {
    // Zero hits must not silently switch the response shape to message_ids:
    // a caller that always reads `messages` under hydrate=true would break.
    const deps = createDeps({ searchItems: [] });
    const body = parse(await search(deps, { query: 'nomatch' }));
    expect(body).toMatchObject({
      ok: true,
      data: { query: 'nomatch', count: 0, has_more: false, messages: [], user_map: {} },
    });
    expect(body.data.message_ids).toBeUndefined();
    // Nothing to hydrate → no per-hit fetch.
    expect(deps.client.im.message.get).not.toHaveBeenCalled();
  });

  it('clamps page_size to the 1-20 range', async () => {
    const deps = createDeps();
    await search(deps, { query: 'x', page_size: 200, hydrate: false });
    expect(deps.client.request).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ page_size: 20 }) }),
      expect.any(Object),
    );
  });

  it('surfaces page_token only when has_more', async () => {
    const more = parse(
      await search(createDeps({ hasMore: true, pageToken: 'tok' }), {
        query: 'x',
        hydrate: false,
      }),
    );
    expect(more.data).toMatchObject({ has_more: true, page_token: 'tok' });

    const done = parse(await search(createDeps(), { query: 'x', hydrate: false }));
    expect(done.data.has_more).toBe(false);
    expect(done.data.page_token).toBeUndefined();
  });

  it('truncates an oversized hydrated payload (same guard as im_read_messages)', async () => {
    const deps = createDeps({ searchItems: ['om_big'] });
    // One hit whose body is far larger than the 100 KB MCP response budget.
    const huge = 'x'.repeat(200 * 1024);
    (deps.client.im.message.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            message_id: 'om_big',
            msg_type: 'text',
            body: { content: JSON.stringify({ text: huge }) },
            sender: { id_type: 'open_id', id: 'ou_a' },
          },
        ],
      },
    });
    const result = await search(deps, { query: 'x' });
    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text!;
    expect(text).toContain('[Content truncated]');
    expect(Buffer.byteLength(text, 'utf-8')).toBeLessThan(200 * 1024);
  });

  it('propagates a search API error without hydrating', async () => {
    const deps = createDeps();
    (deps.client.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      code: 99991663,
      msg: 'permission denied',
    });
    const result = await search(deps, { query: 'x' });
    expect(result.isError).toBe(true);
    expect(parse(result).ok).toBe(false);
    expect(deps.client.im.message.get).not.toHaveBeenCalled();
  });
});
