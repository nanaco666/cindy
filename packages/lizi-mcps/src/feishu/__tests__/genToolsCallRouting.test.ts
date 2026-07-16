import { describe, expect, it, vi } from 'vitest';
import * as lark from '@larksuiteoapi/node-sdk';

import { createFeishuMcpServer } from '../mcp/server.js';
import type { FeishuMcpDeps } from '../../types.js';

/**
 * Regression guard for the discovery ↔ execution seam.
 *
 * `list_tools` surfaces vendored full-coverage tools under `more`, and
 * `call_tool` must be able to route every one of them through the SAME
 * registry — i.e. a name shown in `more` may never come back UNKNOWN_TOOL.
 *
 * The earlier genTools tests exercised `registerGeneratedTools` /
 * `makeGenHandler` against a throwaway registry in isolation, so they could
 * not catch a wiring divergence between the two entry tools. This drives the
 * REAL `createFeishuMcpServer` factory end-to-end (list → call) so any future
 * split (separate registry instance, registration skipped, entry tool reading
 * a different source than the registry) fails CI instead of only surfacing in
 * a live build.
 */

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

describe('generated tools: list_tools discovery stays in sync with call_tool execution', () => {
  it('every tool surfaced under list_tools.more is routable by call_tool (never UNKNOWN_TOOL)', async () => {
    const server = createFeishuMcpServer(deps());
    const t = tools(server);

    const listed = parse(await t.list_tools.handler({ category: 'vc' }));
    const moreNames: string[] = (listed.more?.tools ?? []).map((x: { name: string }) => x.name);
    expect(moreNames.length).toBeGreaterThan(0);

    for (const name of moreNames) {
      const res = parse(await t.call_tool.handler({ name, args: {} }));
      // ok / INVALID_ARGS (missing path param) both mean "routed to the
      // dispatcher"; only UNKNOWN_TOOL means discovery & execution diverged.
      expect(
        res.errorCode,
        `call_tool('${name}') must route, got UNKNOWN_TOOL`,
      ).not.toBe('UNKNOWN_TOOL');
    }
  });

  it('the exact VC-bridge tools resolve in call_tool', async () => {
    const server = createFeishuMcpServer(deps());
    const t = tools(server);
    for (const name of [
      'vc.v1.meeting.listByNo',
      'vc.v1.meetingRecording.get',
      'minutes.v1.minute.get',
    ]) {
      const res = parse(
        await t.call_tool.handler({
          name,
          args: { path: { meeting_id: 'x', minute_token: 'y' } },
        }),
      );
      expect(res.errorCode, name).not.toBe('UNKNOWN_TOOL');
    }
  });
});
