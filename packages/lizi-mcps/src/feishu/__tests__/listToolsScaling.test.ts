import { describe, expect, it, vi } from 'vitest';
import * as lark from '@larksuiteoapi/node-sdk';

import { createFeishuMcpServer } from '../mcp/server.js';
import type { FeishuMcpDeps } from '../../types.js';

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
function tools(server: unknown) {
  return (
    server as {
      _registeredTools: Record<string, { handler: (a: unknown) => Promise<ToolResult> }>;
    }
  )._registeredTools;
}
function parse(r: ToolResult) {
  return JSON.parse(r.content[0]!.text!);
}

// list_tools never touches the client/token, so a minimal deps stub is enough.
function deps(): FeishuMcpDeps {
  const client = {};
  return {
    getFeishuClient: () => client as unknown as lark.Client,
    safeCall: async () => ({ ok: true, data: {} }),
    ensureToken: async () => ({ token: 't' }),
    forceRefresh: async () => ({ token: 't' }),
    resolveP2pChatId: vi.fn(),
    getOrDownloadMedia: vi.fn(),
    uploadFeishuImage: vi.fn(),
    feishuImageMaxBytes: 1,
    streamToBuffer: vi.fn(),
    mimeFromHeaders: vi.fn(),
  } as unknown as FeishuMcpDeps;
}

async function listTools(args: Record<string, unknown>) {
  const server = createFeishuMcpServer(deps());
  return parse(await tools(server).list_tools.handler(args));
}

describe('list_tools recommended / more scaling', () => {
  it('overview lists categories incl. generated-only ones (vc)', async () => {
    const o = await listTools({});
    expect(Array.isArray(o.categories)).toBe(true);
    expect(o.categories.some((c: { name: string }) => c.name === 'vc')).toBe(true);
  });

  it('premium category splits into recommended (premium) + more (generated)', async () => {
    const r = await listTools({ category: 'minutes' });
    const recNames = r.recommended.map((t: { name: string }) => t.name);
    expect(recNames).toContain('meeting_content');
    // generated minutes.v1.* land in `more`
    expect(r.more.total).toBeGreaterThan(0);
    // generated-tools rule bundled once
    expect(r.rules['generated-tools']).toBeTruthy();
  });

  it('generated-only category (vc) has empty recommended + populated more', async () => {
    const r = await listTools({ category: 'vc' });
    expect(r.recommended).toEqual([]);
    expect(r.more.total).toBeGreaterThan(0);
    expect(r.more.tools.every((t: { name: string }) => t.name.startsWith('vc.'))).toBe(true);
  });

  it('q filters more tools by substring', async () => {
    const r = await listTools({ category: 'vc', q: 'recording' });
    expect(r.more.matched).toBeLessThanOrEqual(r.more.total);
    expect(r.more.matched).toBeGreaterThan(0);
    expect(
      r.more.tools.every((t: { name: string; description: string }) =>
        (t.name + t.description).toLowerCase().includes('recording'),
      ),
    ).toBe(true);
  });

  it('resolves synonym project category to its premium bucket (sheets→sheet, base→bitable)', async () => {
    // PR #267 P2: an agent browsing by the RAW Feishu project name must not get
    // an empty category just because the tools register under the premium
    // bucket's alias. list_tools normalizes the input category through the same
    // projectToCategory map used at registration.
    const viaSynonym = await listTools({ category: 'sheets' });
    const viaBucket = await listTools({ category: 'sheet' });
    // Normalized to the same bucket → identical response, echoed as the bucket.
    expect(viaSynonym.category).toBe('sheet');
    expect(viaSynonym).toEqual(viaBucket);
    // …and it actually surfaces tools (premium sheet + generated sheets.v3).
    expect(viaSynonym.recommended.length + (viaSynonym.more?.total ?? 0)).toBeGreaterThan(0);

    // base → bitable behaves the same way.
    const base = await listTools({ category: 'base' });
    expect(base.category).toBe('bitable');
    expect(base).toEqual(await listTools({ category: 'bitable' }));

    // A non-aliased category (drive is its own category after the drive fix; vc
    // never had an alias) passes through unchanged.
    expect((await listTools({ category: 'vc' })).category).toBe('vc');
    expect((await listTools({ category: 'drive' })).category).toBe('drive');
  });

  it('paginates more tools', async () => {
    const p1 = await listTools({ category: 'vc', page_size: 2, page: 1 });
    expect(p1.more.tools.length).toBeLessThanOrEqual(2);
    if (p1.more.total > 2) {
      expect(p1.more.has_more).toBe(true);
      expect(p1.more.next_page).toBe(2);
      const p2 = await listTools({ category: 'vc', page_size: 2, page: 2 });
      expect(p2.more.tools[0]?.name).not.toBe(p1.more.tools[0]?.name);
    }
  });
});
