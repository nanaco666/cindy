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
  heartbeatUrl: 'https://heartbeat-next.example.com',
  slackHookWsUrl: 'wss://hook-next.example.com',
  websiteUrl: 'https://www.next.example.com',
  xdGatewayBaseUrl: 'https://gateway-next.example.com',
  cdnBaseUrl: 'https://cdn-next.example.com/app',
  cdnInternalBaseUrl: 'http://cdn-internal-next.example.com:20080/app',
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
    // 跨模块 live binding:本模块持有的 env 命名空间看到重赋值后的新值
    expect(env.API_BASE_URL).toBe('https://api-next.example.com');
    expect(env.AUTH_API_BASE_URL).toBe('https://auth-next.example.com'); // 单一字段无脑取
    expect(env.DEVICE_LINK_API_BASE_URL).toBe('https://relay-next.example.com');
    expect(env.MOBILE_VOICE_LITELLM_BASE_URL).toBe('https://gateway-next.example.com');
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
    expect(env.API_BASE_URL).toBe('https://api-next.example.com');
  });
});

describe('applyResolvedClientEndpoints', () => {
  it('device-link 未显式给出时按新 apiBase 走 localRelay 派生链', async () => {
    vi.resetModules();
    // 本用例需要"构建 env 未显式配置 device-link"的前提,清掉 vitest 注入的显式值
    const originalRelay = process.env.EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL;
    delete process.env.EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL;
    try {
      const env = await import('@/config/env');
      env.applyResolvedClientEndpoints({ apiBaseUrl: 'http://192.168.1.2:3333' });
      expect(env.API_BASE_URL).toBe('http://192.168.1.2:3333');
      expect(env.DEVICE_LINK_API_BASE_URL).toBe('http://192.168.1.2:3335');
    } finally {
      process.env.EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL = originalRelay;
    }
  });

  it('auth 单一字段无脑取,空值忽略', async () => {
    const { env } = await freshModules();
    env.applyResolvedClientEndpoints({ authApiBaseUrl: 'https://auth-new.example.com' });
    expect(env.AUTH_API_BASE_URL).toBe('https://auth-new.example.com');
    env.applyResolvedClientEndpoints({});
    expect(env.AUTH_API_BASE_URL).toBe('https://auth-new.example.com'); // 空对象不回退
  });
});
