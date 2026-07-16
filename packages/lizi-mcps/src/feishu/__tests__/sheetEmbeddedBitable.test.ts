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

function createDeps() {
  const getNode = vi.fn(async () => ({
    code: 0,
    data: { node: { obj_token: 'shtSpreadsheet', obj_type: 'sheet' } },
  }));
  const query = vi.fn(async () => ({
    code: 0,
    data: {
      sheets: [
        {
          sheet_id: 'normalSheet',
          title: '普通页签',
          index: 0,
          resource_type: 'sheet',
          grid_properties: { row_count: 3, column_count: 2 },
        },
        {
          sheet_id: '2cjT0b',
          title: '【需求池】待设计内容',
          index: 1,
          resource_type: 'bitable',
          grid_properties: { row_count: 0, column_count: 0 },
        },
        {
          sheet_id: 'bangSheet',
          title: 'Data!2024',
          index: 2,
          resource_type: 'sheet',
          grid_properties: { row_count: 2, column_count: 2 },
        },
      ],
    },
  }));
  const request = vi.fn(async (payload: { url: string }) => {
    if (payload.url.endsWith('/metainfo')) {
      return {
        code: 0,
        data: {
          sheets: [
            {
              properties: { sheetId: 'normalSheet' },
            },
            {
              properties: { sheetId: '2cjT0b' },
              blockInfo: {
                blockToken: 'bascnRealAppToken_tblDefaultTable',
                blockType: 'BITABLE',
              },
            },
          ],
        },
      };
    }
    if (payload.url.includes('/values/')) {
      const requestedRange = decodeURIComponent(payload.url.split('/values/')[1]);
      return {
        code: 0,
        data: { valueRange: { range: requestedRange, values: [['A', 'B']] } },
      };
    }
    throw new Error(`Unexpected request: ${payload.url}`);
  });
  const listRecords = vi.fn(async () => ({
    code: 0,
    data: {
      items: Array.from({ length: 10 }, (_, index) => ({
        record_id: `rec${index + 1}`,
        fields: { 需求: `需求 ${index + 1}` },
      })),
      total: 42,
      has_more: true,
      page_token: 'next-page',
    },
  }));

  const client = {
    request,
    wiki: { space: { getNode } },
    sheets: { spreadsheetSheet: { query } },
    bitable: { appTableRecord: { list: listRecords } },
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
      } catch (error) {
        return { ok: false, errorCode: 'NETWORK_ERROR', data: error };
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

async function callTool(
  deps: FeishuMcpDeps,
  name: string,
  args: Record<string, unknown>,
) {
  const server = createFeishuMcpServer(deps);
  return tools(server).call_tool.handler({ name, args });
}

describe('embedded bitable sheet tabs', () => {
  it('routes a wiki sheet URL through v2 metainfo into bitable records', async () => {
    const deps = createDeps();
    const result = await callTool(deps, 'sheet_read_range', {
      spreadsheet:
        'https://xd.feishu.cn/wiki/wikiNode?sheet=2cjT0b&table=tblLinkedTable&view=vewLinkedView',
    });

    expect(result.isError).toBeUndefined();
    expect(deps.client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: '/open-apis/sheets/v2/spreadsheets/shtSpreadsheet/metainfo',
      }),
      expect.any(Object),
    );
    expect(deps.client.bitable.appTableRecord.list).toHaveBeenCalledWith(
      {
        path: {
          app_token: 'bascnRealAppToken',
          table_id: 'tblLinkedTable',
        },
        params: { page_size: 20, view_id: 'vewLinkedView' },
      },
      expect.any(Object),
    );

    expect(parse(result)).toMatchObject({
      ok: true,
      data: {
        resource_type: 'bitable',
        spreadsheet_token: 'shtSpreadsheet',
        sheet_id: '2cjT0b',
        app_token: 'bascnRealAppToken',
        table_id: 'tblLinkedTable',
        view_id: 'vewLinkedView',
        total: 42,
        has_more: true,
        page_token: 'next-page',
      },
    });
    expect(parse(result).data.records).toHaveLength(10);
  });

  it('enriches bitable tabs returned by sheet_list_sheets', async () => {
    const deps = createDeps();
    const body = parse(
      await callTool(deps, 'sheet_list_sheets', {
        spreadsheet: 'https://xd.feishu.cn/sheets/shtSpreadsheet?sheet=2cjT0b',
      }),
    );

    expect(body.data.sheets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sheet_id: '2cjT0b',
          resource_type: 'bitable',
          app_token: 'bascnRealAppToken',
          table_id: 'tblDefaultTable',
          block_type: 'BITABLE',
        }),
      ]),
    );
  });

  it('rejects a fully prefixed A1 range on a bitable tab instead of hitting values', async () => {
    const deps = createDeps();
    const body = parse(
      await callTool(deps, 'sheet_read_range', {
        spreadsheet: 'shtSpreadsheet',
        range: '2cjT0b!A1:D20',
      }),
    );

    expect(body).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(deps.client.bitable.appTableRecord.list).not.toHaveBeenCalled();
    const valuesCalls = (deps.client.request as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => (call[0] as { url: string }).url.includes('/values/'),
    );
    expect(valuesCalls).toHaveLength(0);
  });

  it('drops URL table/view hints when an explicit sheet argument overrides the URL tab', async () => {
    const deps = createDeps();
    const result = await callTool(deps, 'sheet_read_range', {
      spreadsheet:
        'https://xd.feishu.cn/sheets/shtSpreadsheet?sheet=normalSheet&table=tblOtherTab&view=vewOtherTab',
      sheet: '2cjT0b',
    });

    expect(result.isError).toBeUndefined();
    expect(deps.client.bitable.appTableRecord.list).toHaveBeenCalledWith(
      {
        path: {
          app_token: 'bascnRealAppToken',
          table_id: 'tblDefaultTable',
        },
        params: { page_size: 20 },
      },
      expect.any(Object),
    );
  });

  it('keeps URL table/view hints when sheet names the same tab by title', async () => {
    const deps = createDeps();
    const result = await callTool(deps, 'sheet_read_range', {
      spreadsheet:
        'https://xd.feishu.cn/wiki/wikiNode?sheet=2cjT0b&table=tblLinkedTable&view=vewLinkedView',
      sheet: '【需求池】待设计内容',
    });

    expect(result.isError).toBeUndefined();
    expect(deps.client.bitable.appTableRecord.list).toHaveBeenCalledWith(
      {
        path: {
          app_token: 'bascnRealAppToken',
          table_id: 'tblLinkedTable',
        },
        params: { page_size: 20, view_id: 'vewLinkedView' },
      },
      expect.any(Object),
    );
  });

  it('keeps fully prefixed range reads working on ordinary tabs', async () => {
    const deps = createDeps();
    const body = parse(
      await callTool(deps, 'sheet_read_range', {
        spreadsheet: 'shtSpreadsheet',
        range: 'normalSheet!A1:B3',
      }),
    );

    expect(body).toMatchObject({
      ok: true,
      data: {
        spreadsheet_token: 'shtSpreadsheet',
        range: 'normalSheet!A1:B3',
        values: [['A', 'B']],
      },
    });
    expect(deps.client.bitable.appTableRecord.list).not.toHaveBeenCalled();
  });

  it('splits on the last "!" so quoted tab names containing "!" resolve', async () => {
    const deps = createDeps();
    const body = parse(
      await callTool(deps, 'sheet_read_range', {
        spreadsheet: 'shtSpreadsheet',
        range: "'Data!2024'!A1:B2",
      }),
    );

    expect(body).toMatchObject({
      ok: true,
      data: {
        spreadsheet_token: 'shtSpreadsheet',
        range: 'bangSheet!A1:B2',
      },
    });
  });

  it('resolves quoted tab-title prefixes per A1 notation', async () => {
    const deps = createDeps();
    const body = parse(
      await callTool(deps, 'sheet_read_range', {
        spreadsheet: 'shtSpreadsheet',
        range: "'普通页签'!A1:B3",
      }),
    );

    expect(body).toMatchObject({
      ok: true,
      data: {
        spreadsheet_token: 'shtSpreadsheet',
        range: 'normalSheet!A1:B3',
        values: [['A', 'B']],
      },
    });
  });

  it('still lists tabs when v2 metainfo enrichment fails', async () => {
    const deps = createDeps();
    (deps.client.request as ReturnType<typeof vi.fn>).mockImplementation(
      async (payload: { url: string }) => {
        if (payload.url.endsWith('/metainfo')) {
          return { code: 1254005, msg: 'forbidden', data: undefined };
        }
        throw new Error(`Unexpected request: ${payload.url}`);
      },
    );

    const body = parse(
      await callTool(deps, 'sheet_list_sheets', {
        spreadsheet: 'https://xd.feishu.cn/sheets/shtSpreadsheet',
      }),
    );

    expect(body.ok).toBe(true);
    expect(body.data.sheet_count).toBe(3);
    const bitableTab = body.data.sheets.find(
      (sheet: { sheet_id: string }) => sheet.sheet_id === '2cjT0b',
    );
    expect(bitableTab).toMatchObject({ resource_type: 'bitable' });
    expect(bitableTab.app_token).toBeUndefined();
  });

  it('keeps ordinary sheet range reads on the values endpoint', async () => {
    const deps = createDeps();
    const body = parse(
      await callTool(deps, 'sheet_read_range', {
        spreadsheet: 'shtSpreadsheet',
        sheet: 'normalSheet',
        range: 'A1:B3',
      }),
    );

    expect(body).toMatchObject({
      ok: true,
      data: {
        spreadsheet_token: 'shtSpreadsheet',
        range: 'normalSheet!A1:B3',
        values: [['A', 'B']],
      },
    });
    expect(deps.client.bitable.appTableRecord.list).not.toHaveBeenCalled();
  });
});
