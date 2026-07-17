import { describe, expect, it } from 'vitest';

import {
  CLIENT_ENDPOINT_KEYS,
  type ClientEndpointMap,
  parseClientEndpointManifest,
  resolveClientEndpointsStrict,
} from '../clientEndpoints';

const VALID_MANIFEST = {
  schemaVersion: 1,
  apiBaseUrl: 'https://api.example.com',
  authApiBaseUrl: 'https://auth.example.com',
  deviceLinkApiBaseUrl: 'https://device-link.example.com',
  oauthBrokerApiBaseUrl: 'https://oauth.example.com',
  heartbeatUrl: 'https://heartbeat.example.com',
  slackHookWsUrl: 'wss://slack-hook.example.com',
  websiteUrl: 'https://www.example.com',
  xdGatewayBaseUrl: 'https://gateway.example.com',
  modelAccessApiBaseUrl: 'https://model-access.example.com',
  cdnBaseUrl: 'https://cdn.example.com/app',
  cdnInternalBaseUrl: 'http://cdn-internal.example.com:20080/app',
};

function bakedDefaults(): ClientEndpointMap {
  const map = {} as ClientEndpointMap;
  for (const key of CLIENT_ENDPOINT_KEYS) map[key] = `https://baked.example.com/${key}`;
  return map;
}

describe('parseClientEndpointManifest', () => {
  it('接受合法全量清单并归一尾斜杠', () => {
    const result = parseClientEndpointManifest(
      JSON.stringify({ ...VALID_MANIFEST, apiBaseUrl: 'https://api.example.com///' }),
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('unreachable');
    expect(result.endpoints.apiBaseUrl).toBe('https://api.example.com');
    expect(result.endpoints.slackHookWsUrl).toBe('wss://slack-hook.example.com');
  });

  it('接受部分字段的清单(缺省字段不出现在结果里)', () => {
    const result = parseClientEndpointManifest(
      JSON.stringify({ schemaVersion: 1, apiBaseUrl: 'https://api.example.com' }),
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('unreachable');
    expect(result.endpoints).toEqual({ apiBaseUrl: 'https://api.example.com' });
  });

  it('忽略未知字段(向前兼容)', () => {
    const result = parseClientEndpointManifest(
      JSON.stringify({ schemaVersion: 1, apiBaseUrl: 'https://api.example.com', futureKey: 'x' }),
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('unreachable');
    expect(Object.keys(result.endpoints)).toEqual(['apiBaseUrl']);
  });

  it.each([
    ['非法 JSON', 'not-json{', 'invalid-json'],
    ['数组', '[]', 'not-an-object'],
    ['null', 'null', 'not-an-object'],
    ['schemaVersion 缺失', JSON.stringify({ apiBaseUrl: 'https://a.com' }), 'invalid-schema-version'],
    ['schemaVersion 非整数', JSON.stringify({ schemaVersion: 1.5 }), 'invalid-schema-version'],
    ['schemaVersion 字符串', JSON.stringify({ schemaVersion: '1' }), 'invalid-schema-version'],
    [
      'schemaVersion 超前',
      JSON.stringify({ schemaVersion: 2, apiBaseUrl: 'https://a.com' }),
      'unsupported-schema-version:2',
    ],
  ])('拒绝:%s', (_label, raw, reason) => {
    expect(parseClientEndpointManifest(raw)).toEqual({ ok: false, reason });
  });

  it.each([
    ['https 字段给 http', { apiBaseUrl: 'http://api.example.com' }, 'invalid-protocol:apiBaseUrl'],
    ['wss 字段给 ws', { slackHookWsUrl: 'ws://hook.example.com' }, 'invalid-protocol:slackHookWsUrl'],
    ['非 URL', { websiteUrl: 'not a url' }, 'invalid-field:websiteUrl'],
    ['空串', { websiteUrl: '   ' }, 'invalid-field:websiteUrl'],
    ['非字符串', { websiteUrl: 42 }, 'invalid-field:websiteUrl'],
    [
      'URL 带凭据',
      { apiBaseUrl: 'https://user:pass@api.example.com' },
      'credentials-in-url:apiBaseUrl',
    ],
  ])('单字段非法整份拒绝:%s', (_label, patch, reason) => {
    const raw = JSON.stringify({ schemaVersion: 1, ...patch });
    expect(parseClientEndpointManifest(raw)).toEqual({ ok: false, reason });
  });

  it('cdnInternalBaseUrl 允许 http', () => {
    const result = parseClientEndpointManifest(
      JSON.stringify({ schemaVersion: 1, cdnInternalBaseUrl: 'http://internal.example.com/app' }),
    );
    expect(result).toMatchObject({ ok: true });
  });
});

describe('resolveClientEndpointsStrict(阻断语义)', () => {
  it('拉取失败(null)→ ok:false,不产出任何端点', () => {
    expect(resolveClientEndpointsStrict(null, bakedDefaults())).toEqual({
      ok: false,
      reason: 'fetch-failed',
    });
  });

  it('清单非法 → ok:false(坏清单不静默降级)', () => {
    expect(resolveClientEndpointsStrict('broken{{', bakedDefaults())).toEqual({
      ok: false,
      reason: 'invalid-json',
    });
    expect(
      resolveClientEndpointsStrict(
        JSON.stringify({ schemaVersion: 1, apiBaseUrl: 'ftp://bad' }),
        bakedDefaults(),
      ),
    ).toEqual({ ok: false, reason: 'invalid-protocol:apiBaseUrl' });
  });

  it('成功:清单字段覆盖烘焙值,缺省字段逐项回退烘焙值', () => {
    const baked = bakedDefaults();
    const result = resolveClientEndpointsStrict(
      JSON.stringify({ schemaVersion: 1, apiBaseUrl: 'https://remote.example.com' }),
      baked,
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('unreachable');
    expect(result.endpoints.apiBaseUrl).toBe('https://remote.example.com');
    expect(result.endpoints.websiteUrl).toBe(baked.websiteUrl);
    expect(Object.keys(result.endpoints).sort()).toEqual([...CLIENT_ENDPOINT_KEYS].sort());
  });

  it('全量清单:所有字段来自清单', () => {
    const result = resolveClientEndpointsStrict(JSON.stringify(VALID_MANIFEST), bakedDefaults());
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('unreachable');
    for (const key of CLIENT_ENDPOINT_KEYS) {
      expect(result.endpoints[key]).toBe(
        (VALID_MANIFEST as unknown as Record<string, string>)[key].replace(/\/+$/, ''),
      );
    }
  });
});
