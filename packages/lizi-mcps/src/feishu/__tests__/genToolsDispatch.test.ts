import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  decorateScopeHint,
  fillPath,
  makeGenHandler,
  MissingPathParamError,
  projectToCategory,
  type LarkGenToolDef,
} from '../mcp/genTools.js';
import type { FeishuApiResult } from '../../types.js';

// A passthrough formatter so we can assert on the raw FeishuApiResult the
// handler produced (mirrors what the real formatToolResult wraps).
const fmt = (r: FeishuApiResult) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(r) }],
  ...(r.ok ? {} : { isError: true as const }),
});
const parse = (res: { content: Array<{ type: string; text?: string }> }) =>
  JSON.parse(res.content[0]!.text!);

function def(overrides: Partial<LarkGenToolDef> = {}): LarkGenToolDef {
  return {
    project: 'vc',
    name: 'vc.v1.meetingRecording.get',
    sdkName: 'vc.v1.meetingRecording.get',
    path: '/open-apis/vc/v1/meetings/:meeting_id/recording',
    httpMethod: 'GET',
    description: 'get recording',
    accessTokens: ['tenant', 'user'],
    schema: { path: z.object({ meeting_id: z.string() }) },
    ...overrides,
  };
}

describe('fillPath', () => {
  it('substitutes a single :param and URL-encodes it', () => {
    expect(fillPath('/a/:id/b', { id: 'x y/z' })).toBe('/a/x%20y%2Fz/b');
  });
  it('substitutes multiple params', () => {
    expect(
      fillPath('/open-apis/:p/v1/:r/get', { p: 'vc', r: 'm1' }),
    ).toBe('/open-apis/vc/v1/m1/get');
  });
  it('passes through templates with no :params', () => {
    expect(fillPath('/open-apis/minutes/v1/minutes/search', {})).toBe(
      '/open-apis/minutes/v1/minutes/search',
    );
  });
  it('throws MissingPathParamError when a param is absent / empty', () => {
    expect(() => fillPath('/a/:id', {})).toThrow(MissingPathParamError);
    expect(() => fillPath('/a/:id', { id: '' })).toThrow(MissingPathParamError);
    try {
      fillPath('/a/:meeting_id', {});
    } catch (e) {
      expect((e as MissingPathParamError).param).toBe('meeting_id');
    }
  });
});

describe('makeGenHandler', () => {
  it('GET with only path → templated url, no params/data', async () => {
    const callOpenApi = vi.fn(async () => ({ ok: true, data: { recording: {} } }));
    const handler = makeGenHandler(def(), callOpenApi, fmt);
    const res = await handler({ path: { meeting_id: '7652' } });
    expect(callOpenApi).toHaveBeenCalledWith(
      'GET',
      '/open-apis/vc/v1/meetings/7652/recording',
      { params: undefined, data: undefined },
    );
    expect(parse(res)).toMatchObject({ ok: true, data: { recording: {} } });
  });

  it('POST with path + data → passes data as body', async () => {
    const callOpenApi = vi.fn(async () => ({ ok: true, data: {} }));
    const handler = makeGenHandler(
      def({
        name: 'minutes.v1.minutes.search',
        path: '/open-apis/minutes/v1/minutes/search',
        httpMethod: 'POST',
      }),
      callOpenApi,
      fmt,
    );
    await handler({ data: { query: '周会' } });
    expect(callOpenApi).toHaveBeenCalledWith(
      'POST',
      '/open-apis/minutes/v1/minutes/search',
      { params: undefined, data: { query: '周会' } },
    );
  });

  it('GET with params → passes params as query', async () => {
    const callOpenApi = vi.fn(async () => ({ ok: true, data: {} }));
    const handler = makeGenHandler(
      def({ path: '/open-apis/vc/v1/meetings/:meeting_id/recording' }),
      callOpenApi,
      fmt,
    );
    await handler({ path: { meeting_id: 'm1' }, params: { user_id_type: 'open_id' } });
    expect(callOpenApi).toHaveBeenCalledWith(
      'GET',
      '/open-apis/vc/v1/meetings/m1/recording',
      { params: { user_id_type: 'open_id' }, data: undefined },
    );
  });

  it('missing path param → INVALID_ARGS, callOpenApi NOT called', async () => {
    const callOpenApi = vi.fn(async () => ({ ok: true, data: {} }));
    const handler = makeGenHandler(def(), callOpenApi, fmt);
    const res = await handler({});
    expect(callOpenApi).not.toHaveBeenCalled();
    expect(parse(res)).toMatchObject({
      ok: false,
      errorCode: 'INVALID_ARGS',
      data: { missing_path_param: 'meeting_id' },
    });
  });
});

describe('decorateScopeHint', () => {
  it('enriches a generic error with endpoint + scope hint', () => {
    const out = decorateScopeHint(
      { ok: false, errorCode: 'FEISHU_API_ERROR', data: { code: 1, msg: 'no perm' } },
      def(),
    );
    expect(out.data).toMatchObject({
      code: 1,
      msg: 'no perm',
      endpoint: 'GET /open-apis/vc/v1/meetings/:meeting_id/recording',
    });
    expect((out.data as { scope_hint: string }).scope_hint).toContain('scope');
  });
  it('leaves success and AUTH_EXPIRED untouched', () => {
    const ok: FeishuApiResult = { ok: true, data: { a: 1 } };
    expect(decorateScopeHint(ok, def())).toBe(ok);
    const auth: FeishuApiResult = { ok: false, errorCode: 'AUTH_EXPIRED' };
    expect(decorateScopeHint(auth, def())).toBe(auth);
  });
});

describe('projectToCategory', () => {
  it('aliases generated projects into premium buckets', () => {
    expect(projectToCategory('docs')).toBe('docx');
    expect(projectToCategory('sheets')).toBe('sheet');
    expect(projectToCategory('base')).toBe('bitable');
    expect(projectToCategory('directory')).toBe('contact');
  });
  it('passes unknown projects through unchanged', () => {
    expect(projectToCategory('vc')).toBe('vc');
    expect(projectToCategory('approval')).toBe('approval');
    expect(projectToCategory('corehr')).toBe('corehr');
  });
});
