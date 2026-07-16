/**
 * feishuToolRegistry.test.ts
 * ---------------------------------------------------------------------------
 * Locks in the contract for the registry that backs the two MCP entry tools
 * (`feishu_list_tools` / `feishu_call_tool`):
 *
 *   - list() returns the right name+description+category set
 *   - call() runs the handler with parsed args on the happy path
 *   - call() returns INVALID_ARGS + JSON Schema when zod validation fails
 *   - call() returns UNKNOWN_TOOL when the name is not registered
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { FeishuToolRegistry } from '../mcp/toolRegistry.js';
import type { FeishuToolContentBlock } from '../mcp/toolRegistry.js';

/**
 * Narrow a content block to its text variant so tests can read `.text` safely.
 * The union became (text | image) when media_download started returning image
 * blocks; existing tests only ever produce text blocks, so a hard assertion
 * is fine here — fail loud if an unexpected variant slips in.
 */
function asText(block: FeishuToolContentBlock): { type: 'text'; text: string } {
  if (block.type !== 'text') {
    throw new Error(`expected text content block, got ${block.type}`);
  }
  return block;
}

describe('FeishuToolRegistry', () => {
  it('list() filters by category and returns name+description', () => {
    const r = new FeishuToolRegistry();
    r.register({
      name: 'docx_search',
      category: 'docx',
      description: 'search docs',
      inputShape: { query: z.string() },
      handler: async () => ({ content: [{ type: 'text', text: '{}' }] }),
    });
    r.register({
      name: 'im_list_chats',
      category: 'im',
      description: 'list chats',
      inputShape: {},
      handler: async () => ({ content: [{ type: 'text', text: '{}' }] }),
    });
    r.register({
      name: 'sheet_read_range',
      category: 'sheet',
      description: 'read sheet range',
      inputShape: {},
      handler: async () => ({ content: [{ type: 'text', text: '{}' }] }),
    });

    expect(r.list('docx')).toEqual([
      { name: 'docx_search', category: 'docx', description: 'search docs' },
    ]);
    expect(r.list('sheet')).toEqual([
      { name: 'sheet_read_range', category: 'sheet', description: 'read sheet range' },
    ]);
    expect(r.list().length).toBe(3);
    expect(r.listCategories().sort()).toEqual(['docx', 'im', 'sheet']);
  });

  it('call() invokes the handler with parsed args on the happy path', async () => {
    const r = new FeishuToolRegistry();
    let received: unknown = null;
    r.register({
      name: 'echo',
      category: 'misc',
      description: 'echo',
      inputShape: { msg: z.string(), n: z.number().default(1) },
      handler: async (args) => {
        received = args;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });

    const result = await r.call('echo', { msg: 'hi' });
    expect(received).toEqual({ msg: 'hi', n: 1 }); // default applied
    expect(result.isError).toBeUndefined();
    expect(asText(result.content[0]).text).toBe('ok');
  });

  it('call() returns INVALID_ARGS + JSON Schema when args fail zod validation', async () => {
    const r = new FeishuToolRegistry();
    r.register({
      name: 'docx_search',
      category: 'docx',
      description: 'search docs',
      inputShape: {
        query: z.string().describe('search keywords'),
        page_size: z.number().default(20),
      },
      handler: async () => ({ content: [{ type: 'text', text: '{}' }] }),
    });

    // page_size as string instead of number
    const result = await r.call('docx_search', { query: 'hi', page_size: '10' });
    expect(result.isError).toBe(true);

    const body = JSON.parse(asText(result.content[0]).text) as {
      ok: boolean;
      errorCode: string;
      data: { tool: string; validation_errors: unknown[]; schema: unknown; hint: string };
    };
    expect(body.ok).toBe(false);
    expect(body.errorCode).toBe('INVALID_ARGS');
    expect(body.data.tool).toBe('docx_search');
    expect(body.data.validation_errors.length).toBeGreaterThan(0);
    // schema must be an object so the LLM can self-correct
    expect(typeof body.data.schema).toBe('object');
    expect(body.data.schema).not.toBeNull();
  });

  it('call() rejects unknown keys with INVALID_ARGS instead of silently stripping them', async () => {
    // Regression: the registry uses z.strictObject so a misspelled / wrong-case key
    // (e.g. camelCase `sessionIds` instead of snake_case `session_ids`) fails loudly
    // with the offending key in validation_errors + the schema, letting the LLM
    // self-correct in its tool-calling loop. With a plain z.object the unknown key
    // would be dropped silently and the call would "succeed but be ignored".
    const r = new FeishuToolRegistry();
    let received: unknown = 'sentinel';
    r.register({
      name: 'get_history',
      category: 'misc',
      description: 'get history',
      inputShape: { session_ids: z.array(z.string()).optional() },
      handler: async (args) => {
        received = args;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });

    const result = await r.call('get_history', { sessionIds: ['abc'] }); // wrong: camelCase
    expect(result.isError).toBe(true);
    expect(received).toBe('sentinel'); // handler never ran

    const body = JSON.parse(asText(result.content[0]).text) as {
      ok: boolean;
      errorCode: string;
      data: { tool: string; validation_errors: unknown[]; schema: unknown };
    };
    expect(body.ok).toBe(false);
    expect(body.errorCode).toBe('INVALID_ARGS');
    // the unrecognized key must appear in the validation errors so the LLM can fix it
    expect(JSON.stringify(body.data.validation_errors)).toContain('sessionIds');
  });

  it('call() returns UNKNOWN_TOOL with capped suggestions + count when name is unregistered', async () => {
    const r = new FeishuToolRegistry();
    r.register({
      name: 'a',
      category: 'misc',
      description: 'a',
      inputShape: {},
      handler: async () => ({ content: [{ type: 'text', text: '{}' }] }),
    });

    const result = await r.call('does_not_exist', {});
    expect(result.isError).toBe(true);

    const body = JSON.parse(asText(result.content[0]).text) as {
      ok: boolean;
      errorCode: string;
      data: {
        requested: string;
        available_count: number;
        suggestions: string[];
        truncated: boolean;
      };
    };
    expect(body.errorCode).toBe('UNKNOWN_TOOL');
    expect(body.data.requested).toBe('does_not_exist');
    // The full registry is no longer dumped (PR #267 P2): capped suggestions +
    // a count, so a typo can't blow up the turn with hundreds of names.
    expect(body.data.available_count).toBe(1);
    expect(body.data.suggestions).toEqual(['a']);
    expect(body.data.truncated).toBe(false);
  });

  it('call() accepts undefined args by treating them as {}', async () => {
    const r = new FeishuToolRegistry();
    let received: unknown = 'sentinel';
    r.register({
      name: 'noargs',
      category: 'misc',
      description: 'no args',
      inputShape: {},
      handler: async (args) => {
        received = args;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });

    const result = await r.call('noargs', undefined);
    expect(result.isError).toBeUndefined();
    expect(received).toEqual({});
  });

  it('register() rejects duplicate tool names', () => {
    const r = new FeishuToolRegistry();
    r.register({
      name: 'dup',
      category: 'misc',
      description: 'first',
      inputShape: {},
      handler: async () => ({ content: [{ type: 'text', text: '' }] }),
    });
    expect(() =>
      r.register({
        name: 'dup',
        category: 'misc',
        description: 'second',
        inputShape: {},
        handler: async () => ({ content: [{ type: 'text', text: '' }] }),
      }),
    ).toThrow(/duplicate/);
  });
});
