/**
 * clientEndpointsService 单测(规则 14:依赖注入 + 内存 harness)。
 *
 * 校验语义(全字段必填/协议白名单)在 @lizi/maker-shared 侧已覆盖;这里只测
 * desktop 宿主层:dev 烘焙 map 组装、阻断式重试循环(失败 → prompt → 重试/退出,
 * 无静默降级、无烘焙合并)、sendSync IPC 形状、init 前 getter 的 dev 旁路。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLIENT_ENDPOINT_KEYS } from '@lizi/maker-shared/client-endpoints';

const ipcOn = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  app: { getPath: vi.fn(), isPackaged: false, exit: vi.fn() },
  dialog: { showMessageBoxSync: vi.fn() },
  ipcMain: { on: ipcOn },
  net: { request: vi.fn() },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  bakedClientEndpoints,
  getClientEndpoint,
  getResolvedClientEndpoints,
  registerClientEndpointsIpc,
  resetClientEndpointsForTest,
  resolveClientEndpointsBlocking,
  CLIENT_ENDPOINTS_SYNC_CHANNEL,
} from '../clientEndpointsService';

afterEach(() => {
  resetClientEndpointsForTest();
  ipcOn.mockClear();
});

const FULL_MANIFEST = JSON.stringify({
  schemaVersion: 1,
  apiBaseUrl: 'https://api.remote.example.com',
  authApiBaseUrl: 'https://auth.remote.example.com',
  deviceLinkApiBaseUrl: 'https://device.remote.example.com',
  oauthBrokerApiBaseUrl: 'https://oauth.remote.example.com',
  heartbeatUrl: 'https://heartbeat.remote.example.com',
  slackHookWsUrl: 'wss://hook.remote.example.com',
  websiteUrl: 'https://www.remote.example.com',
  xdGatewayBaseUrl: 'https://gateway.remote.example.com',
});

describe('bakedClientEndpoints(dev 专用)', () => {
  // 具体值随测试环境注入的 VITE_* 变化(vitest 可能带真实生产 env),
  // 只断言环境无关的不变量:全键齐备、核心端点非空(dev fallback 兜底)。
  it('全键齐备,核心端点非空', () => {
    const baked = bakedClientEndpoints();
    expect(Object.keys(baked).sort()).toEqual([...CLIENT_ENDPOINT_KEYS].sort());
    expect(baked.apiBaseUrl).toBeTruthy();
    expect(baked.authApiBaseUrl).toBeTruthy();
    expect(baked.deviceLinkApiBaseUrl).toBeTruthy();
  });
});

describe('resolveClientEndpointsBlocking(阻断循环,清单即唯一事实源)', () => {
  it('首次成功:不进 prompt,所有值来自清单', async () => {
    const promptRetry = vi.fn();
    const result = await resolveClientEndpointsBlocking({
      fetchManifestText: async () => FULL_MANIFEST,
      promptRetry,
      exitApp: vi.fn(),
    });
    expect(result?.apiBaseUrl).toBe('https://api.remote.example.com');
    expect(result?.websiteUrl).toBe('https://www.remote.example.com');
    expect(promptRetry).not.toHaveBeenCalled();
  });

  it('失败 → prompt 选重试 → 第二次成功(无静默降级)', async () => {
    const fetchManifestText = vi
      .fn<(timeoutMs: number) => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(FULL_MANIFEST);
    const promptRetry = vi.fn().mockReturnValue('retry');
    const exitApp = vi.fn();
    const result = await resolveClientEndpointsBlocking({
      fetchManifestText,
      promptRetry,
      exitApp,
    });
    expect(promptRetry).toHaveBeenCalledTimes(1);
    expect(promptRetry).toHaveBeenCalledWith('fetch-failed');
    expect(fetchManifestText).toHaveBeenCalledTimes(2);
    expect(result?.apiBaseUrl).toBe('https://api.remote.example.com');
    expect(exitApp).not.toHaveBeenCalled();
  });

  it('清单缺字段同样阻断(无烘焙回退),prompt 带 reason', async () => {
    const manifest = JSON.parse(FULL_MANIFEST) as Record<string, unknown>;
    delete manifest.heartbeatUrl;
    const promptRetry = vi.fn().mockReturnValue('exit');
    const exitApp = vi.fn();
    const result = await resolveClientEndpointsBlocking({
      fetchManifestText: async () => JSON.stringify(manifest),
      promptRetry,
      exitApp,
    });
    expect(result).toBeNull();
    expect(promptRetry).toHaveBeenCalledWith('missing-field:heartbeatUrl');
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it('fetch 抛错视同失败进 prompt,选退出返回 null', async () => {
    const promptRetry = vi.fn().mockReturnValue('exit');
    const exitApp = vi.fn();
    const result = await resolveClientEndpointsBlocking({
      fetchManifestText: async () => {
        throw new Error('boom');
      },
      promptRetry,
      exitApp,
    });
    expect(result).toBeNull();
    expect(exitApp).toHaveBeenCalledTimes(1);
  });
});

describe('getter / IPC', () => {
  it('init 之前(dev / smoke 旁路)getClientEndpoint 返回 dev 烘焙值', () => {
    expect(getClientEndpoint('apiBaseUrl')).toBe(bakedClientEndpoints().apiBaseUrl);
  });

  it('注入解析结果后,sendSync handler 返回完整 map', () => {
    const resolved = { ...bakedClientEndpoints(), websiteUrl: 'https://site.example.com' };
    resetClientEndpointsForTest(resolved);
    registerClientEndpointsIpc();
    expect(ipcOn).toHaveBeenCalledWith(CLIENT_ENDPOINTS_SYNC_CHANNEL, expect.any(Function));
    const handler = ipcOn.mock.calls[0][1] as (event: { returnValue?: unknown }) => void;
    const event: { returnValue?: unknown } = {};
    handler(event);
    expect(event.returnValue).toMatchObject({ websiteUrl: 'https://site.example.com' });
    expect(getResolvedClientEndpoints().websiteUrl).toBe('https://site.example.com');
    expect(getClientEndpoint('websiteUrl')).toBe('https://site.example.com');
  });
});
