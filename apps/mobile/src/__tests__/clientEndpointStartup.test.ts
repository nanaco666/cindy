/**
 * 远程端点清单启动解析(clientEndpointStartup,清单即唯一事实源)+ env
 * live binding 回写的单测。
 *
 * 关键覆盖:
 *  - 「跨模块 live binding 可见性」:applyResolvedClientEndpoints 对 `export let`
 *    重赋值后,另一个模块(本测试文件)经命名空间导入看到新值——这是 mobile
 *    不改 26 个消费文件的前提假设,用测试钉死;
 *  - 阻断语义:拉取失败 / 清单非法 / 缺字段 → 返回 ok:false 且 env 不被改动
 *    (没有缓存回退、没有逐字段烘焙回退),重试 = 调用方再跑一次。
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

describe('runStartupEndpointResolve(清单即唯一事实源)', () => {
  it('拉取成功:回写 env live binding,跨模块可见', async () => {
    const { env, startup } = await freshModules();
    expect(env.API_BASE_URL).toBe('https://api.example.invalid');

    const outcome = await startup.runStartupEndpointResolve({
      fetchManifestText: async () => FULL_MANIFEST,
    });

    expect(outcome).toEqual({ ok: true });
    // apiBaseUrl 已退役:清单里的残留值(喂老客户端)不再回填,保持 env 初值
    expect(env.API_BASE_URL).toBe('https://api.example.invalid');
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
      });
      expect(outcome).toEqual({ ok: true });
      expect(env.REVIEW_MODE).toBe(false);

      // 版本一致:进审核模式
      outcome = await startup.runStartupEndpointResolve({
        fetchManifestText: async () =>
          JSON.stringify({ ...FULL_MANIFEST_OBJECT, review: '9.9.9' }),
      });
      expect(outcome).toEqual({ ok: true });
      expect(env.REVIEW_MODE).toBe(true);

      // 审核结束清单清空字段:退出审核模式(重新拉清单即恢复)
      outcome = await startup.runStartupEndpointResolve({
        fetchManifestText: async () =>
          JSON.stringify({ ...FULL_MANIFEST_OBJECT, review: '' }),
      });
      expect(outcome).toEqual({ ok: true });
      expect(env.REVIEW_MODE).toBe(false);
    } finally {
      vi.doUnmock('expo-constants');
      vi.resetModules();
    }
  });

  it('清单 review 非 string(布尔等)→ 整份拒绝(阻断),env 不动', async () => {
    const { env, startup } = await freshModules();
    const outcome = await startup.runStartupEndpointResolve({
      fetchManifestText: async () => JSON.stringify({ ...FULL_MANIFEST_OBJECT, review: true }),
    });
    expect(outcome).toEqual({ ok: false, reason: 'invalid-field:review' });
    expect(env.REVIEW_MODE).toBe(false);
    expect(env.API_BASE_URL).toBe('https://api.example.invalid');
  });

  it('自建变体(IS_OTA_SELFHOST=1):mobileUpdateBaseUrl 覆写整包发现基址(可远程迁域名)', async () => {
    process.env.EXPO_PUBLIC_XDT_OTA_SELFHOST = '1';
    process.env.EXPO_PUBLIC_XDT_OTA_URL = 'https://baked-ota.example.invalid';
    try {
      const { env, startup } = await freshModules();
      expect(env.OTA_SERVER_BASE_URL).toBe('https://baked-ota.example.invalid');
      const outcome = await startup.runStartupEndpointResolve({
        fetchManifestText: async () => FULL_MANIFEST,
      });
      expect(outcome).toEqual({ ok: true });
      // 清单值优先于烧包 env:已发自建包靠改线上清单即可迁域名
      expect(env.OTA_SERVER_BASE_URL).toBe('https://mobile-update-next.example.com');
    } finally {
      delete process.env.EXPO_PUBLIC_XDT_OTA_SELFHOST;
      delete process.env.EXPO_PUBLIC_XDT_OTA_URL;
      vi.resetModules();
    }
  });

  it('拉取失败 → ok:false(fetch-failed),env 保持构建期值不动', async () => {
    const { env, startup } = await freshModules();
    const outcome = await startup.runStartupEndpointResolve({
      fetchManifestText: async () => null,
    });
    expect(outcome).toEqual({ ok: false, reason: 'fetch-failed' });
    expect(env.API_BASE_URL).toBe('https://api.example.invalid');
  });

  it('清单缺字段 → ok:false(无烘焙回退),env 不动', async () => {
    const { env, startup } = await freshModules();
    const manifest: Record<string, unknown> = { ...FULL_MANIFEST_OBJECT };
    delete manifest.heartbeatUrl;
    const apply = vi.fn();
    const outcome = await startup.runStartupEndpointResolve({
      fetchManifestText: async () => JSON.stringify(manifest),
      apply,
    });
    expect(outcome).toEqual({ ok: false, reason: 'missing-field:heartbeatUrl' });
    expect(apply).not.toHaveBeenCalled();
    expect(env.API_BASE_URL).toBe('https://api.example.invalid');
  });

  it('清单非法 → ok:false(坏清单不静默降级),env 不动', async () => {
    const { env, startup } = await freshModules();
    const outcome = await startup.runStartupEndpointResolve({
      fetchManifestText: async () => 'not-json{',
    });
    expect(outcome).toEqual({ ok: false, reason: 'invalid-json' });
    expect(env.API_BASE_URL).toBe('https://api.example.invalid');
  });

  it('fetch 抛错视同失败,永不 reject;重试 = 再调一次可成功', async () => {
    const { env, startup } = await freshModules();
    const fetchManifestText = vi
      .fn<(timeoutMs: number) => Promise<string | null>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(FULL_MANIFEST);
    await expect(
      startup.runStartupEndpointResolve({ fetchManifestText }),
    ).resolves.toEqual({ ok: false, reason: 'fetch-failed' });
    await expect(
      startup.runStartupEndpointResolve({ fetchManifestText }),
    ).resolves.toEqual({ ok: true });
    expect(env.AUTH_API_BASE_URL).toBe('https://auth-next.example.com');
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
