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
  heartbeatUrl: 'https://heartbeat.example.com',
  slackHookWsUrl: 'wss://slack-hook.example.com',
  websiteUrl: 'https://www.example.com',
  xdGatewayBaseUrl: 'https://gateway.example.com',
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
      JSON.stringify({ ...VALID_MANIFEST, futureKey: 'x', cdnBaseUrl: 'https://cdn.example.com' }),
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
