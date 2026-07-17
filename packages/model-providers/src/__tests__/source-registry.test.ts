/**
 * source（目录加载/兜底/合并）与 registry（可见性/来源/路由解析）的纯逻辑测试。
 */

import { describe, it, expect, vi } from 'vitest';

import { BUNDLED_CATALOG } from '../catalog.js';
import {
  loadCatalog,
  resolveCatalogUrl,
  mergeWithBundled,
  CATALOG_CFG_PATH,
  type CatalogIO,
} from '../source.js';
import {
  buildRegistry,
  providersForAgent,
  connectedProvidersForAgent,
  providerOffersModel,
  getModel,
  sourcesForModel,
  effectiveSourceIdForModel,
  resolveRoute,
} from '../registry.js';
import type { Catalog } from '../types.js';

const MINIMAL: Catalog = {
  version: 'test',
  providers: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      source: 'builtin',
      agents: ['claude-code'],
      auth: { method: 'oauth' },
      routing: { 'claude-code': { upstream: 'https://api.anthropic.com', authStrategy: 'oauth-passthrough' } },
      models: {
        'claude-code': [
          { id: 'claude-opus-4-8', name: 'Opus 4.8', contextWindow: 1_000_000, efforts: ['high'], defaultEffort: 'high' },
        ],
      },
    },
  ],
};

describe('resolveCatalogUrl', () => {
  it('prefers explicit url', () => {
    expect(resolveCatalogUrl({ url: 'https://x/y.json', baseUrl: 'https://b' })).toBe('https://x/y.json');
  });
  it('builds from baseUrl + cfg path', () => {
    expect(resolveCatalogUrl({ baseUrl: 'https://cdn.example.com/base/' })).toBe(
      `https://cdn.example.com/base${CATALOG_CFG_PATH}`,
    );
  });
  it('returns null when neither given', () => {
    expect(resolveCatalogUrl({})).toBeNull();
  });
});

describe('mergeWithBundled', () => {
  it('keeps primary providers and fills missing bundled ones by id', () => {
    const merged = mergeWithBundled(MINIMAL);
    const ids = merged.providers.map((p) => p.id);
    expect(ids).toContain('anthropic');
    expect(ids).toContain('openai');
    expect(ids).toContain('xd');
    // primary's anthropic wins (only 1 cc model in MINIMAL)
    expect(merged.providers.find((p) => p.id === 'anthropic')!.models['claude-code']!.length).toBe(1);
  });

  it('backfills access for an old primary catalog without mutating it', () => {
    const merged = mergeWithBundled(MINIMAL);
    expect(MINIMAL.providers[0].access).toBeUndefined();
    expect(merged.providers.find((p) => p.id === 'anthropic')?.access).toEqual({
      kind: 'subscription',
      product: 'Claude.ai',
    });
  });

  it('preserves access explicitly supplied by the primary catalog', () => {
    const primary: Catalog = {
      ...MINIMAL,
      providers: MINIMAL.providers.map((p) => ({ ...p, access: { kind: 'api' } })),
    };
    expect(mergeWithBundled(primary).providers.find((p) => p.id === 'anthropic')?.access).toEqual({ kind: 'api' });
  });

  it('does not infer bundled billing when a same-id primary changes auth or upstream', () => {
    const apiKeyPrimary: Catalog = {
      ...MINIMAL,
      providers: MINIMAL.providers.map((p) => ({
        ...p,
        auth: { method: 'apiKey' as const },
        routing: {
          'claude-code': {
            ...p.routing['claude-code']!,
            authStrategy: 'api-key-header' as const,
          },
        },
      })),
    };
    const alternateOAuthPrimary: Catalog = {
      ...MINIMAL,
      providers: MINIMAL.providers.map((p) => ({
        ...p,
        routing: {
          'claude-code': {
            ...p.routing['claude-code']!,
            upstream: 'https://oauth-proxy.example.test',
          },
        },
      })),
    };

    expect(mergeWithBundled(apiKeyPrimary).providers[0].access).toBeUndefined();
    expect(mergeWithBundled(alternateOAuthPrimary).providers[0].access).toBeUndefined();
  });
});

describe('loadCatalog', () => {
  it('dev: reads local path, skips network', async () => {
    const fetchText = vi.fn();
    const io: CatalogIO = { readFile: vi.fn(async () => JSON.stringify(MINIMAL)), fetchText };
    const cat = await loadCatalog({ localPath: '/repo/providers.json' }, io);
    expect(io.readFile).toHaveBeenCalledWith('/repo/providers.json');
    expect(fetchText).not.toHaveBeenCalled();
    expect(cat.providers.find((p) => p.id === 'anthropic')).toBeTruthy();
  });

  it('fetches remote then merges bundled', async () => {
    const io: CatalogIO = { fetchText: vi.fn(async () => JSON.stringify(MINIMAL)) };
    const cat = await loadCatalog({ url: 'https://x/y.json' }, io);
    expect(io.fetchText).toHaveBeenCalledWith('https://x/y.json');
    expect(cat.version).toBe('test');
    // 远端目录裁剪到只有 anthropic，bundled 补回 openai/xd（mergeWithBundled）。
    expect(cat.providers.map((p) => p.id).sort()).toEqual(['anthropic', 'openai', 'xai', 'xd']);
  });

  it('falls back to bundled when fetch fails', async () => {
    const io: CatalogIO = {
      fetchText: vi.fn(async () => {
        throw new Error('network down');
      }),
    };
    const cat = await loadCatalog({ url: 'https://x/y.json' }, io);
    expect(cat.version).toBe(BUNDLED_CATALOG.version);
    expect(cat.providers.map((p) => p.id).sort()).toEqual(['anthropic', 'openai', 'xai', 'xd']);
  });

  it('disableFetch → bundled (no network)', async () => {
    const fetchText = vi.fn();
    const cat = await loadCatalog({ url: 'https://x/y.json', disableFetch: true }, { fetchText });
    expect(fetchText).not.toHaveBeenCalled();
    expect(cat.providers.length).toBe(BUNDLED_CATALOG.providers.length);
  });
});

describe('registry visibility & sources', () => {
  const views = buildRegistry(BUNDLED_CATALOG, { xd: true, anthropic: false, openai: false });

  it('providersForAgent ignores connection', () => {
    // openai 现在也声明 claude-code(ChatGPT 订阅直连 gpt-5.5 等,经 responses-bridge)。
    expect(providersForAgent(views, 'claude-code').map((p) => p.id).sort()).toEqual(['anthropic', 'openai', 'xai', 'xd']);
    expect(providersForAgent(views, 'codex').map((p) => p.id).sort()).toEqual(['openai', 'xai', 'xd']);
  });

  it('connectedProvidersForAgent honors connection', () => {
    expect(connectedProvidersForAgent(views, 'claude-code').map((p) => p.id)).toEqual(['xd']);
    expect(connectedProvidersForAgent(views, 'codex').map((p) => p.id)).toEqual(['xd']);
  });

  it('providerOffersModel / getModel (agent-scoped)', () => {
    const xd = views.find((p) => p.id === 'xd')!;
    expect(providerOffersModel(xd, 'gpt-5.5', 'codex')).toBe(true);
    expect(providerOffersModel(xd, 'no-such', 'codex')).toBe(false);
    // claude-opus 只在 cc 列表;按 codex 查不到,按 claude-code 查得到。
    expect(providerOffersModel(xd, 'claude-opus-4-8', 'codex')).toBe(false);
    expect(getModel(xd, 'claude-opus-4-8', 'claude-code')?.name).toBe('Opus 4.8');
  });

  it('sourcesForModel: only connected providers by default', () => {
    // only xd connected → claude-opus on cc has just [xd]
    expect(sourcesForModel(views, 'claude-opus-4-8', 'claude-code').map((p) => p.id)).toEqual(['xd']);
    // include unconnected → anthropic also offers it
    expect(sourcesForModel(views, 'claude-opus-4-8', 'claude-code', { onlyConnected: false }).map((p) => p.id).sort())
      .toEqual(['anthropic', 'xd']);
  });

  it('sourcesForModel: same model two sources when both connected', () => {
    const all = buildRegistry(BUNDLED_CATALOG, { xd: true, anthropic: true, openai: true, xai: true });
    expect(sourcesForModel(all, 'gpt-5.5', 'codex').map((p) => p.id).sort()).toEqual(['openai', 'xd']);
    expect(sourcesForModel(all, 'gpt-5.5', 'claude-code').map((p) => p.id)).toEqual(['xd']);
    expect(sourcesForModel(all, 'xai/grok-4.3', 'codex').map((p) => p.id)).toEqual(['xai']);
  });

  it('effectiveSourceIdForModel 只在真正提供当前模型的已连接来源里选默认', () => {
    const openaiOnly = buildRegistry(BUNDLED_CATALOG, {
      xd: false,
      anthropic: false,
      openai: true,
      xai: false,
    });
    // OpenAI 虽支持 claude-code agent，但不提供 Opus；不能拼成 OpenAI + Opus。
    expect(
      effectiveSourceIdForModel(openaiOnly, null, 'claude-opus-4-8', 'claude-code'),
    ).toBeNull();
    expect(
      effectiveSourceIdForModel(openaiOnly, null, 'chatgpt/gpt-5.5', 'claude-code'),
    ).toBe('openai');
  });

  it('effectiveSourceIdForModel 保留有效显式来源，失效时回落到同模型默认来源', () => {
    const all = buildRegistry(BUNDLED_CATALOG, {
      xd: true,
      anthropic: true,
      openai: true,
      xai: true,
    });
    expect(
      effectiveSourceIdForModel(all, 'anthropic', 'claude-opus-4-8', 'claude-code'),
    ).toBe('anthropic');
    expect(
      effectiveSourceIdForModel(all, 'openai', 'claude-opus-4-8', 'claude-code'),
    ).toBe('xd');
  });
});

describe('resolveRoute', () => {
  const views = buildRegistry(BUNDLED_CATALOG, { xd: true, anthropic: true, openai: true, xai: true });
  // xd 网关地址以内置 catalog(providers.json,端点单点)为准;门禁校验其与权威源一致
  const xdRouting = BUNDLED_CATALOG.providers.find((prov) => prov.id === 'xd')?.routing;

  it('anthropic claude (claude-code) → direct upstream, oauth-passthrough', () => {
    const r = resolveRoute(views, 'anthropic', 'claude-opus-4-8', 'claude-code');
    expect(r?.routing.upstream).toBe('https://api.anthropic.com');
    expect(r?.routing.authStrategy).toBe('oauth-passthrough');
  });

  it('xd claude (claude-code) → gateway, gateway-key, 不删 anthropic-beta(fast 经网关透传)', () => {
    // commit 6024f25cb 起:XD cc 网关不再 headerDelete anthropic-beta，Fast 可经网关透传。
    const r = resolveRoute(views, 'xd', 'claude-opus-4-8', 'claude-code');
    expect(r?.routing.upstream).toBe(xdRouting?.['claude-code']?.upstream);
    expect(r?.routing.authStrategy).toBe('gateway-key');
    expect(r?.routing.headerDelete).toBeUndefined();
  });

  it('xd gpt (codex) → gateway/v1; openai gpt (codex) → chatgpt direct', () => {
    expect(resolveRoute(views, 'xd', 'gpt-5.5', 'codex')?.routing.upstream).toBe(xdRouting?.codex?.upstream);
    const oa = resolveRoute(views, 'openai', 'gpt-5.5', 'codex');
    expect(oa?.routing.upstream).toBe('https://chatgpt.com/backend-api/codex');
    expect(oa?.routing.authStrategy).toBe('oauth-passthrough');
  });

  it('xai grok (codex) → api.x.ai/v1 with provider OAuth token and xai/ model rewrite', () => {
    const r = resolveRoute(views, 'xai', 'xai/grok-4.3', 'codex');
    expect(r?.routing.upstream).toBe('https://api.x.ai/v1');
    expect(r?.routing.authStrategy).toBe('provider-oauth-header');
    expect(r?.routing.modelIdRewrite).toEqual({ stripPrefix: 'xai/' });
  });

  it('rejects unsupported (provider, model, agent) combos', () => {
    expect(resolveRoute(views, 'anthropic', 'gpt-5.5', 'claude-code')).toBeNull(); // anthropic offers no gpt
    expect(resolveRoute(views, 'anthropic', 'claude-opus-4-8', 'codex')).toBeNull(); // anthropic has no codex agent
    expect(resolveRoute(views, 'openai', 'claude-opus-4-8', 'codex')).toBeNull();
    expect(resolveRoute(views, 'nope', 'claude-opus-4-8', 'claude-code')).toBeNull();
  });
});
