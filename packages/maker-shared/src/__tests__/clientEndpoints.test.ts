import { describe, expect, it } from 'vitest';

import {
  CLIENT_ENDPOINT_KEYS,
  parseClientEndpointManifest,
  resolveClientEndpointsStrict,
} from '../clientEndpoints';

const VALID_MANIFEST = {
  schemaVersion: 1,
  apiBaseUrl: 'https://api.example.com',
  authApiBaseUrl: 'https://auth.example.com',
  deviceLinkApiBaseUrl: 'https://device-link.example.com',
  oauthBrokerApiBaseUrl: 'https://oauth.example.com',
  ossApiBaseUrl: 'https://oss.example.com',
  heartbeatUrl: 'https://heartbeat.example.com',
  slackHookWsUrl: 'wss://slack-hook.example.com',
  websiteUrl: 'https://www.example.com',
  modelAccessApiBaseUrl: 'https://model-access.example.com',
  githubApiBaseUrl: 'https://github-api.example.com',
  cdnBaseUrl: 'https://cdn.example.com/app',
  mobileUpdateBaseUrl: 'https://mobile-update.example.com',
};

describe('parseClientEndpointManifest(全字段必填)', () => {
  it('接受合法全量清单并归一尾斜杠', () => {
    const result = parseClientEndpointManifest(
      JSON.stringify({ ...VALID_MANIFEST, apiBaseUrl: 'https://api.example.com///' }),
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('unreachable');
    expect(result.endpoints.apiBaseUrl).toBe('https://api.example.com');
    expect(result.endpoints.slackHookWsUrl).toBe('wss://slack-hook.example.com');
    expect(Object.keys(result.endpoints).sort()).toEqual([...CLIENT_ENDPOINT_KEYS].sort());
  });

  it('忽略未知字段(向前兼容)', () => {
    const result = parseClientEndpointManifest(
      JSON.stringify({ ...VALID_MANIFEST, futureKey: 'x', _note: '正本内注释' }),
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('unreachable');
    expect(Object.keys(result.endpoints).sort()).toEqual([...CLIENT_ENDPOINT_KEYS].sort());
  });

  it.each(CLIENT_ENDPOINT_KEYS)('缺失字段 %s → 整份拒绝(无烘焙回退)', (key) => {
    const manifest: Record<string, unknown> = { ...VALID_MANIFEST };
    delete manifest[key];
    expect(parseClientEndpointManifest(JSON.stringify(manifest))).toEqual({
      ok: false,
      reason: `missing-field:${key}`,
    });
  });

  it.each([
    ['非法 JSON', 'not-json{', 'invalid-json'],
    ['数组', '[]', 'not-an-object'],
    ['null', 'null', 'not-an-object'],
    [
      'schemaVersion 缺失',
      JSON.stringify({ ...VALID_MANIFEST, schemaVersion: undefined }),
      'invalid-schema-version',
    ],
    [
      'schemaVersion 非整数',
      JSON.stringify({ ...VALID_MANIFEST, schemaVersion: 1.5 }),
      'invalid-schema-version',
    ],
    [
      'schemaVersion 字符串',
      JSON.stringify({ ...VALID_MANIFEST, schemaVersion: '1' }),
      'invalid-schema-version',
    ],
    [
      'schemaVersion 超前',
      JSON.stringify({ ...VALID_MANIFEST, schemaVersion: 2 }),
      'unsupported-schema-version:2',
    ],
  ])('拒绝:%s', (_label, raw, reason) => {
    expect(parseClientEndpointManifest(raw)).toEqual({ ok: false, reason });
  });

  it.each([
    ['https 字段给 http', { apiBaseUrl: 'http://api.example.com' }, 'invalid-protocol:apiBaseUrl'],
    ['wss 字段给 ws', { slackHookWsUrl: 'ws://hook.example.com' }, 'invalid-protocol:slackHookWsUrl'],
    ['cdnBaseUrl 给 http', { cdnBaseUrl: 'http://cdn.example.com' }, 'invalid-protocol:cdnBaseUrl'],
    ['非 URL', { websiteUrl: 'not a url' }, 'invalid-field:websiteUrl'],
    ['空串', { websiteUrl: '   ' }, 'invalid-field:websiteUrl'],
    ['非字符串', { websiteUrl: 42 }, 'invalid-field:websiteUrl'],
    [
      'URL 带凭据',
      { apiBaseUrl: 'https://user:pass@api.example.com' },
      'credentials-in-url:apiBaseUrl',
    ],
  ])('单字段非法整份拒绝:%s', (_label, patch, reason) => {
    const raw = JSON.stringify({ ...VALID_MANIFEST, ...patch });
    expect(parseClientEndpointManifest(raw)).toEqual({ ok: false, reason });
  });

  describe('review 可选布尔字段(手机版审核模式)', () => {
    it('缺失 → review=false(线上老清单不受影响,不阻断)', () => {
      const result = parseClientEndpointManifest(JSON.stringify(VALID_MANIFEST));
      expect(result).toMatchObject({ ok: true, review: false });
    });

    it.each([true, false])('显式 %s → 原样透出', (value) => {
      const result = parseClientEndpointManifest(
        JSON.stringify({ ...VALID_MANIFEST, review: value }),
      );
      expect(result).toMatchObject({ ok: true, review: value });
    });

    it.each([
      ['字符串 "true"', 'true'],
      ['数字 1', 1],
      ['null', null],
    ])('存在但非 boolean(%s)→ 整份拒绝(配置错要炸出来)', (_label, value) => {
      expect(
        parseClientEndpointManifest(JSON.stringify({ ...VALID_MANIFEST, review: value })),
      ).toEqual({ ok: false, reason: 'invalid-field:review' });
    });
  });

  it('忽略已退役字段 cdnInternalBaseUrl / xdGatewayBaseUrl(老清单向前兼容)', () => {
    const result = parseClientEndpointManifest(
      JSON.stringify({
        ...VALID_MANIFEST,
        cdnInternalBaseUrl: 'http://cdn-internal.example.com:20080/app',
        xdGatewayBaseUrl: 'https://gateway.example.com',
      }),
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('unreachable');
    expect('cdnInternalBaseUrl' in result.endpoints).toBe(false);
    expect('xdGatewayBaseUrl' in result.endpoints).toBe(false);
  });
});

describe('allowHttp 宽松模式(仅 dev 本地文件路径)', () => {
  const LOCAL_MANIFEST = {
    ...VALID_MANIFEST,
    apiBaseUrl: 'http://localhost:3333',
    authApiBaseUrl: 'http://localhost:3344',
    deviceLinkApiBaseUrl: 'http://localhost:3335',
    slackHookWsUrl: 'ws://localhost:3346',
  };

  it('默认(不传 options)拒绝 http/ws——packaged 校验零放松', () => {
    expect(parseClientEndpointManifest(JSON.stringify(LOCAL_MANIFEST))).toEqual({
      ok: false,
      reason: 'invalid-protocol:apiBaseUrl',
    });
  });

  it('allowHttp:true 时接受 http localhost 与 ws', () => {
    const result = parseClientEndpointManifest(JSON.stringify(LOCAL_MANIFEST), {
      allowHttp: true,
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('unreachable');
    expect(result.endpoints.apiBaseUrl).toBe('http://localhost:3333');
    expect(result.endpoints.slackHookWsUrl).toBe('ws://localhost:3346');
  });

  it('allowHttp:true 仍拒绝垃圾输入 / 缺字段 / 带凭据', () => {
    expect(parseClientEndpointManifest('broken{{', { allowHttp: true })).toEqual({
      ok: false,
      reason: 'invalid-json',
    });
    const missing: Record<string, unknown> = { ...LOCAL_MANIFEST };
    delete missing.cdnBaseUrl;
    expect(parseClientEndpointManifest(JSON.stringify(missing), { allowHttp: true })).toEqual({
      ok: false,
      reason: 'missing-field:cdnBaseUrl',
    });
    expect(
      parseClientEndpointManifest(
        JSON.stringify({ ...LOCAL_MANIFEST, apiBaseUrl: 'http://user:pass@localhost:3333' }),
        { allowHttp: true },
      ),
    ).toEqual({ ok: false, reason: 'credentials-in-url:apiBaseUrl' });
  });

  it('allowHttp:true 仍拒绝非 http/https 协议(如 file:)', () => {
    expect(
      parseClientEndpointManifest(
        JSON.stringify({ ...LOCAL_MANIFEST, apiBaseUrl: 'file:///etc/hosts' }),
        { allowHttp: true },
      ),
    ).toEqual({ ok: false, reason: 'invalid-protocol:apiBaseUrl' });
  });

  it('resolveClientEndpointsStrict 透传 options', () => {
    const result = resolveClientEndpointsStrict(JSON.stringify(LOCAL_MANIFEST), {
      allowHttp: true,
    });
    expect(result).toMatchObject({ ok: true });
  });
});

describe('resolveClientEndpointsStrict(清单即唯一事实源)', () => {
  it('拉取失败(null)→ ok:false,不产出任何端点', () => {
    expect(resolveClientEndpointsStrict(null)).toEqual({ ok: false, reason: 'fetch-failed' });
  });

  it('清单非法 / 缺字段 → ok:false(不静默降级)', () => {
    expect(resolveClientEndpointsStrict('broken{{')).toEqual({
      ok: false,
      reason: 'invalid-json',
    });
    const missing: Record<string, unknown> = { ...VALID_MANIFEST };
    delete missing.heartbeatUrl;
    expect(resolveClientEndpointsStrict(JSON.stringify(missing))).toEqual({
      ok: false,
      reason: 'missing-field:heartbeatUrl',
    });
  });

  it('成功:所有字段来自清单本身', () => {
    const result = resolveClientEndpointsStrict(JSON.stringify(VALID_MANIFEST));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('unreachable');
    for (const key of CLIENT_ENDPOINT_KEYS) {
      expect(result.endpoints[key]).toBe(
        (VALID_MANIFEST as unknown as Record<string, string>)[key].replace(/\/+$/, ''),
      );
    }
  });
});
