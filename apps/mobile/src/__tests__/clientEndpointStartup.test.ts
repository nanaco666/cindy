/**
 * 远程端点清单启动解析(clientEndpointStartup)+ env live binding 回写的单测。
 *
 * 关键覆盖:
 *  - 「跨模块 live binding 可见性」:applyResolvedClientEndpoints 对 `export let`
 *    重赋值后,另一个模块(本测试文件)经命名空间导入看到新值——这是 mobile
 *    不改 26 个消费文件的前提假设,用测试钉死;
 *  - 兜底阶梯(2026-07-18 定案):CDN 严格解析失败后,先「包内正本为底 + CDN
 *    合法字段覆盖」,再「整份包内正本」;两级都不可用才 ok:false 阻断。
 *    测试一律经 deps.bundledManifestText 注入正本(vitest 无 metro require)。
 */
import { describe, expect, it, vi } from 'vitest';

async function freshModules() {
  vi.resetModules();
  const env = await import('@/config/env');
  const startup = await import('@/config/clientEndpointStartup');
  return { env, startup };
}

const FULL_MANIFEST_OBJECT = {
  schemaVersion: 1,
  // apiBaseUrl 已退役出 parser:留在 fixture 里覆盖"未知字段向前兼容忽略"
  apiBaseUrl: 'https://api-next.example.com',
  authApiBaseUrl: 'https://auth-next.example.com',
  deviceLinkApiBaseUrl: 'https://relay-next.example.com',
  oauthBrokerApiBaseUrl: 'https://oauth-next.example.com',
  ossApiBaseUrl: 'https://oss-next.example.com',
  heartbeatUrl: 'https://heartbeat-next.example.com',
  slackHookWsUrl: 'wss://hook-next.example.com',
  websiteUrl: 'https://www.next.example.com',
  modelAccessApiBaseUrl: 'https://model-access-next.example.com',
  githubApiBaseUrl: 'https://github-api-next.example.com',
  skillhubApiBaseUrl: 'https://skillhub-next.example.com',
  cdnBaseUrl: 'https://cdn-next.example.com/app',
  mobileUpdateBaseUrl: 'https://mobile-update-next.example.com',
};
const FULL_MANIFEST = JSON.stringify(FULL_MANIFEST_OBJECT);

// 包内正本 stand-in:全字段合法、值域与 CDN 清单区分开,便于断言来源。
const BUNDLED_MANIFEST_OBJECT = Object.fromEntries(
  Object.entries(FULL_MANIFEST_OBJECT).map(([key, value]) => [
    key,
    typeof value === 'string' ? value.replace('-next', '-bundled').replace('.next', '.bundled') : value,
  ]),
);
const BUNDLED_MANIFEST = JSON.stringify(BUNDLED_MANIFEST_OBJECT);

describe('runStartupEndpointResolve(CDN 优先 + 包内正本兜底)', () => {
  it('拉取成功:全量采用 CDN 清单,回写 env live binding,跨模块可见', async () => {
    const { env, startup } = await freshModules();
    expect(env.DEVICE_LINK_API_BASE_URL).toBe('https://relay.example.invalid');

    const outcome = await startup.runStartupEndpointResolve({
      fetchManifestText: async () => FULL_MANIFEST,
      bundledManifestText: BUNDLED_MANIFEST,
    });

    expect(outcome).toEqual({ ok: true, source: 'cdn' });
    // 跨模块 live binding:本模块持有的 env 命名空间看到重赋值后的新值
    expect(env.AUTH_API_BASE_URL).toBe('https://auth-next.example.com'); // 单一字段无脑取
    expect(env.DEVICE_LINK_API_BASE_URL).toBe('https://relay-next.example.com');
    // 语音网关地址与清单解耦(xdGatewayBaseUrl 已退役):保持构建期 env 值不动
    expect(env.MOBILE_VOICE_LITELLM_BASE_URL).toBe('https://gateway.example.invalid');
    // 非自建变体(IS_OTA_SELFHOST=false):mobileUpdateBaseUrl 不覆写,恒空串
    expect(env.OTA_SERVER_BASE_URL).toBe('');
    // 清单未带 review 字段 → 审核模式保持默认 false
    expect(env.REVIEW_MODE).toBe(false);
  });

  it('清单 review 命中二进制版本号 → REVIEW_MODE=true;不命中 → false', async () => {
    vi.resetModules();
    // 注入二进制版本号(默认 mock 无版本字段,APP_BINARY_VERSION 为空串恒不命中)
    vi.doMock('expo-constants', () => ({
      default: { expoConfig: { version: '9.9.9' }, nativeAppVersion: '9.9.9' },
    }));
    try {
      const env = await import('@/config/env');
      const startup = await import('@/config/clientEndpointStartup');
      expect(env.APP_BINARY_VERSION).toBe('9.9.9');
      expect(env.REVIEW_MODE).toBe(false);

      // 版本不一致:不进审核模式
      let outcome = await startup.runStartupEndpointResolve({
        fetchManifestText: async () =>
          JSON.stringify({ ...FULL_MANIFEST_OBJECT, review: '9.9.8' }),
        bundledManifestText: BUNDLED_MANIFEST,
      });
      expect(outcome).toEqual({ ok: true, source: 'cdn' });
      expect(env.REVIEW_MODE).toBe(false);

      // 版本一致:进审核模式
      outcome = await startup.runStartupEndpointResolve({
        fetchManifestText: async () =>
          JSON.stringify({ ...FULL_MANIFEST_OBJECT, review: '9.9.9' }),
        bundledManifestText: BUNDLED_MANIFEST,
      });
      expect(outcome).toEqual({ ok: true, source: 'cdn' });
      expect(env.REVIEW_MODE).toBe(true);

      // 审核结束清单清空字段:退出审核模式(重新拉清单即恢复)
      outcome = await startup.runStartupEndpointResolve({
        fetchManifestText: async () =>
          JSON.stringify({ ...FULL_MANIFEST_OBJECT, review: '' }),
        bundledManifestText: BUNDLED_MANIFEST,
      });
      expect(outcome).toEqual({ ok: true, source: 'cdn' });
      expect(env.REVIEW_MODE).toBe(false);
    } finally {
      vi.doUnmock('expo-constants');
      vi.resetModules();
    }
  });

  it('清单缺字段 → 字段级兜底:CDN 值优先,缺的字段吃包内正本', async () => {
    const { startup } = await freshModules();
    const manifest: Record<string, unknown> = { ...FULL_MANIFEST_OBJECT };
    delete manifest.heartbeatUrl;
    const apply = vi.fn();
    const outcome = await startup.runStartupEndpointResolve({
      fetchManifestText: async () => JSON.stringify(manifest),
      bundledManifestText: BUNDLED_MANIFEST,
      apply,
    });
    expect(outcome).toEqual({
      ok: true,
      source: 'cdn+bundled',
      fallbackFrom: 'missing-field:heartbeatUrl',
    });
    expect(apply).toHaveBeenCalledTimes(1);
    const resolved = apply.mock.calls[0][0] as Record<string, unknown>;
    expect(resolved.deviceLinkApiBaseUrl).toBe('https://relay-next.example.com'); // CDN 值优先
    expect(resolved.heartbeatUrl).toBe('https://heartbeat-bundled.example.com'); // 缺字段吃包内
  });

  it('清单字段值非法(空串/非 string)→ 该字段按缺失处理吃包内值,其余 CDN 值保留', async () => {
    const { startup } = await freshModules();
    const apply = vi.fn();
    const outcome = await startup.runStartupEndpointResolve({
      fetchManifestText: async () =>
        JSON.stringify({ ...FULL_MANIFEST_OBJECT, heartbeatUrl: '', websiteUrl: 42 }),
      bundledManifestText: BUNDLED_MANIFEST,
      apply,
    });
    expect(outcome).toMatchObject({ ok: true, source: 'cdn+bundled' });
    const resolved = apply.mock.calls[0][0] as Record<string, unknown>;
    expect(resolved.heartbeatUrl).toBe('https://heartbeat-bundled.example.com');
    expect(resolved.websiteUrl).toBe('https://www.bundled.example.com');
    expect(resolved.deviceLinkApiBaseUrl).toBe('https://relay-next.example.com');
  });

  it('review 只信 CDN:CDN review 非 string → 按未填处理,包内正本的 review 不泄漏', async () => {
    const { startup } = await freshModules();
    const apply = vi.fn();
    const outcome = await startup.runStartupEndpointResolve({
      fetchManifestText: async () => JSON.stringify({ ...FULL_MANIFEST_OBJECT, review: true }),
      bundledManifestText: JSON.stringify({ ...BUNDLED_MANIFEST_OBJECT, review: '1.2.3' }),
      apply,
    });
    expect(outcome).toEqual({
      ok: true,
      source: 'cdn+bundled',
      fallbackFrom: 'invalid-field:review',
    });
    // 包内正本带送审版本号也不得随兜底生效(误开审核模式 = 用户失去更新通道)
    expect((apply.mock.calls[0][0] as { reviewVersion: string | null }).reviewVersion).toBe(null);
  });

  it('字段级兜底下 CDN 的合法 review 值原样生效', async () => {
    const { startup } = await freshModules();
    const apply = vi.fn();
    const manifest: Record<string, unknown> = { ...FULL_MANIFEST_OBJECT, review: '9.9.9' };
    delete manifest.heartbeatUrl;
    const outcome = await startup.runStartupEndpointResolve({
      fetchManifestText: async () => JSON.stringify(manifest),
      bundledManifestText: JSON.stringify({ ...BUNDLED_MANIFEST_OBJECT, review: '1.2.3' }),
      apply,
    });
    expect(outcome).toMatchObject({ ok: true, source: 'cdn+bundled' });
    expect((apply.mock.calls[0][0] as { reviewVersion: string | null }).reviewVersion).toBe('9.9.9');
  });

  it('CDN 的 review 空串是「显式关闭」,透传而不吃包内值', async () => {
    const { startup } = await freshModules();
    const apply = vi.fn();
    const manifest: Record<string, unknown> = { ...FULL_MANIFEST_OBJECT, review: '' };
    delete manifest.heartbeatUrl; // 制造字段级兜底路径
    const outcome = await startup.runStartupEndpointResolve({
      fetchManifestText: async () => JSON.stringify(manifest),
      bundledManifestText: JSON.stringify({ ...BUNDLED_MANIFEST_OBJECT, review: '1.2.3' }),
      apply,
    });
    expect(outcome).toMatchObject({ ok: true, source: 'cdn+bundled' });
    expect((apply.mock.calls[0][0] as { reviewVersion: string | null }).reviewVersion).toBe(null);
  });

  it('拉取失败 → 整份兜底包内正本(不再阻断);正本 review 恒按未填处理', async () => {
    const { env, startup } = await freshModules();
    const apply = vi.fn();
    const outcome = await startup.runStartupEndpointResolve({
      fetchManifestText: async () => null,
      bundledManifestText: JSON.stringify({ ...BUNDLED_MANIFEST_OBJECT, review: '1.2.3' }),
      apply,
    });
    expect(outcome).toEqual({ ok: true, source: 'bundled', fallbackFrom: 'fetch-failed' });
    expect((apply.mock.calls[0][0] as { reviewVersion: string | null }).reviewVersion).toBe(null);

    // 不注入 apply 时同样回写 env(整份兜底端点生效)
    const outcome2 = await startup.runStartupEndpointResolve({
      fetchManifestText: async () => null,
      bundledManifestText: BUNDLED_MANIFEST,
    });
    expect(outcome2).toEqual({ ok: true, source: 'bundled', fallbackFrom: 'fetch-failed' });
    expect(env.DEVICE_LINK_API_BASE_URL).toBe('https://relay-bundled.example.com');
    expect(env.REVIEW_MODE).toBe(false);
  });

  it('CDN 字段值为 string 但 URL 非法 → 合并过不了严格校验,跌到整份兜底', async () => {
    const { startup } = await freshModules();
    const apply = vi.fn();
    const outcome = await startup.runStartupEndpointResolve({
      fetchManifestText: async () =>
        JSON.stringify({ ...FULL_MANIFEST_OBJECT, heartbeatUrl: 'not-a-url' }),
      bundledManifestText: BUNDLED_MANIFEST,
      apply,
    });
    expect(outcome).toEqual({
      ok: true,
      source: 'bundled',
      fallbackFrom: 'invalid-field:heartbeatUrl',
    });
    // 整份兜底:CDN 其余合法值一并放弃,端点全部来自包内正本
    expect((apply.mock.calls[0][0] as { deviceLinkApiBaseUrl: string }).deviceLinkApiBaseUrl).toBe(
      'https://relay-bundled.example.com',
    );
  });

  it('清单非 JSON → 整份兜底包内正本', async () => {
    const { env, startup } = await freshModules();
    const outcome = await startup.runStartupEndpointResolve({
      fetchManifestText: async () => 'not-json{',
      bundledManifestText: BUNDLED_MANIFEST,
    });
    expect(outcome).toEqual({ ok: true, source: 'bundled', fallbackFrom: 'invalid-json' });
    expect(env.DEVICE_LINK_API_BASE_URL).toBe('https://relay-bundled.example.com');
  });

  it('包内正本不可用时保持阻断语义:ok:false 且 env 不动', async () => {
    const { env, startup } = await freshModules();
    const manifest: Record<string, unknown> = { ...FULL_MANIFEST_OBJECT };
    delete manifest.heartbeatUrl;
    const apply = vi.fn();
    for (const [text, reason] of [
      [JSON.stringify(manifest), 'missing-field:heartbeatUrl'],
      [null, 'fetch-failed'],
      ['not-json{', 'invalid-json'],
    ] as const) {
      const outcome = await startup.runStartupEndpointResolve({
        fetchManifestText: async () => text,
        bundledManifestText: null,
        apply,
      });
      expect(outcome).toEqual({ ok: false, reason });
    }
    expect(apply).not.toHaveBeenCalled();
    expect(env.DEVICE_LINK_API_BASE_URL).toBe('https://relay.example.invalid');
  });

  it('自建变体(IS_OTA_SELFHOST=1):mobileUpdateBaseUrl 覆写整包发现基址(可远程迁域名)', async () => {
    process.env.EXPO_PUBLIC_XDT_OTA_SELFHOST = '1';
    process.env.EXPO_PUBLIC_XDT_OTA_URL = 'https://baked-ota.example.invalid';
    try {
      const { env, startup } = await freshModules();
      expect(env.OTA_SERVER_BASE_URL).toBe('https://baked-ota.example.invalid');
      const outcome = await startup.runStartupEndpointResolve({
        fetchManifestText: async () => FULL_MANIFEST,
        bundledManifestText: BUNDLED_MANIFEST,
      });
      expect(outcome).toEqual({ ok: true, source: 'cdn' });
      // 清单值优先于烧包 env:已发自建包靠改线上清单即可迁域名
      expect(env.OTA_SERVER_BASE_URL).toBe('https://mobile-update-next.example.com');
    } finally {
      delete process.env.EXPO_PUBLIC_XDT_OTA_SELFHOST;
      delete process.env.EXPO_PUBLIC_XDT_OTA_URL;
      vi.resetModules();
    }
  });

  it('fetch 抛错视同拉取失败 → 整份兜底;永不 reject', async () => {
    const { env, startup } = await freshModules();
    const fetchManifestText = vi
      .fn<(timeoutMs: number) => Promise<string | null>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(FULL_MANIFEST);
    await expect(
      startup.runStartupEndpointResolve({ fetchManifestText, bundledManifestText: BUNDLED_MANIFEST }),
    ).resolves.toEqual({ ok: true, source: 'bundled', fallbackFrom: 'fetch-failed' });
    // 下一次拉到完整清单:CDN 值覆盖兜底值
    await expect(
      startup.runStartupEndpointResolve({ fetchManifestText, bundledManifestText: BUNDLED_MANIFEST }),
    ).resolves.toEqual({ ok: true, source: 'cdn' });
    expect(env.AUTH_API_BASE_URL).toBe('https://auth-next.example.com');
  });
});

describe('mergeManifestWithBundled(字段级兜底合并纯函数)', () => {
  it('CDN 非对象/不可解析 → null(走整份兜底)', async () => {
    const { startup } = await freshModules();
    expect(startup.mergeManifestWithBundled(BUNDLED_MANIFEST, null)).toBe(null);
    expect(startup.mergeManifestWithBundled(BUNDLED_MANIFEST, 'not-json{')).toBe(null);
    expect(startup.mergeManifestWithBundled(BUNDLED_MANIFEST, '[1,2]')).toBe(null);
  });

  it('CDN schemaVersion 超出支持版本/非法 → 放弃合并(不兼容清单的字段不按旧语义收编)', async () => {
    const { startup } = await freshModules();
    for (const schemaVersion of [999, 0, 1.5, 'x']) {
      expect(
        startup.mergeManifestWithBundled(
          BUNDLED_MANIFEST,
          JSON.stringify({ schemaVersion, apiBaseUrl: 'https://api-next.example.com' }),
        ),
      ).toBe(null);
    }
  });

  it('CDN schemaVersion 合法或缺失 → 正常合并,schemaVersion 恒取包内正本', async () => {
    const { startup } = await freshModules();
    for (const cdn of [
      { schemaVersion: 1, apiBaseUrl: 'https://api-next.example.com' },
      { apiBaseUrl: 'https://api-next.example.com' },
    ]) {
      const merged = startup.mergeManifestWithBundled(BUNDLED_MANIFEST, JSON.stringify(cdn));
      expect(merged).not.toBe(null);
      const parsed = JSON.parse(merged as string) as Record<string, unknown>;
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.apiBaseUrl).toBe('https://api-next.example.com');
      expect(parsed.heartbeatUrl).toBe('https://heartbeat-bundled.example.com');
    }
  });

  it('包内正本的 review 在合并时被剥离;CDN 的 review 才会出现在合并结果里', async () => {
    const { startup } = await freshModules();
    const bundledWithReview = JSON.stringify({ ...BUNDLED_MANIFEST_OBJECT, review: '1.2.3' });
    const noCdnReview = JSON.parse(
      startup.mergeManifestWithBundled(bundledWithReview, JSON.stringify({ schemaVersion: 1 })) as string,
    ) as Record<string, unknown>;
    expect('review' in noCdnReview).toBe(false);
    const withCdnReview = JSON.parse(
      startup.mergeManifestWithBundled(
        bundledWithReview,
        JSON.stringify({ schemaVersion: 1, review: '9.9.9' }),
      ) as string,
    ) as Record<string, unknown>;
    expect(withCdnReview.review).toBe('9.9.9');
  });
});

describe('isReviewModeActive(送审版本号匹配纯函数)', () => {
  it('严格相等(含 trim)才命中;任一侧为空恒 false', async () => {
    const { env } = await freshModules();
    expect(env.isReviewModeActive('1.4.0', '1.4.0')).toBe(true);
    expect(env.isReviewModeActive(' 1.4.0 ', '1.4.0')).toBe(true);
    expect(env.isReviewModeActive('1.4.1', '1.4.0')).toBe(false);
    expect(env.isReviewModeActive(null, '1.4.0')).toBe(false);
    expect(env.isReviewModeActive(undefined, '1.4.0')).toBe(false);
    expect(env.isReviewModeActive('', '1.4.0')).toBe(false);
    // 拿不到二进制版本号(空串)时宁可不进审核模式
    expect(env.isReviewModeActive('1.4.0', '')).toBe(false);
    expect(env.isReviewModeActive('', '')).toBe(false);
  });
});

describe('applyResolvedClientEndpoints', () => {
  it('auth 单一字段无脑取,空值忽略', async () => {
    const { env } = await freshModules();
    env.applyResolvedClientEndpoints({ authApiBaseUrl: 'https://auth-new.example.com' });
    expect(env.AUTH_API_BASE_URL).toBe('https://auth-new.example.com');
    env.applyResolvedClientEndpoints({});
    expect(env.AUTH_API_BASE_URL).toBe('https://auth-new.example.com'); // 空对象不回退
  });
});
