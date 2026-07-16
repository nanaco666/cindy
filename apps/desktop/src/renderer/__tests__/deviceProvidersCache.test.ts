/**
 * useDeviceProviders 的 deviceId-aware 缓存单测(device-link「以被控端为准」)。
 * 守住:远程走隧道 maker:provider:list、按 deviceId 隔离、inflight 去重、缓存命中不重拉、
 * evict 只清该设备、evict 在途结果丢弃不复活 —— 与 useAgentCapabilities 同范式。
 * 模块级缓存:每个用例 vi.resetModules() + 动态 import 拿干净模块。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

type Providers = { providers: Array<{ id: string }> };
const result = (deviceId: string): Providers => ({ providers: [{ id: `${deviceId}-xd` }] });

/** stub window.electronAPI.deviceLink.invoke,返回 spy。 */
function stubDeviceLink() {
  const invoke = vi.fn(async (deviceId: string, _channel: string, _args: unknown[]) => result(deviceId));
  vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
  return invoke;
}

describe('useDeviceProviders deviceId-aware cache', () => {
  it('远程路径:prefetch 命中 deviceLink.invoke(maker:provider:list, [])', async () => {
    const invoke = stubDeviceLink();
    const mod = await import('@/hooks/useDeviceProviders');
    await mod.prefetchDeviceProviders('dev-1');
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:provider:list', []);
  });

  it('缓存命中:同设备二次 prefetch 不再发请求', async () => {
    const invoke = stubDeviceLink();
    const mod = await import('@/hooks/useDeviceProviders');
    await mod.prefetchDeviceProviders('dev-1');
    await mod.prefetchDeviceProviders('dev-1');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('inflight 去重:同设备并发只发一次', async () => {
    const invoke = stubDeviceLink();
    const mod = await import('@/hooks/useDeviceProviders');
    await Promise.all([mod.prefetchDeviceProviders('dev-1'), mod.prefetchDeviceProviders('dev-1')]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('key 隔离:dev-1 / dev-2 各拉各的,互不影响', async () => {
    const invoke = stubDeviceLink();
    const mod = await import('@/hooks/useDeviceProviders');
    await mod.prefetchDeviceProviders('dev-1');
    await mod.prefetchDeviceProviders('dev-2');
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:provider:list', []);
    expect(invoke).toHaveBeenCalledWith('dev-2', 'maker:provider:list', []);
    expect(invoke).toHaveBeenCalledTimes(2);
    // dev-2 已缓存:再 prefetch 不重拉(隔离 + 命中)。
    await mod.prefetchDeviceProviders('dev-2');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('驱逐:evict 后同设备重新拉取;只清该设备(dev-2 仍命中缓存)', async () => {
    const invoke = stubDeviceLink();
    const mod = await import('@/hooks/useDeviceProviders');
    await mod.prefetchDeviceProviders('dev-1');
    await mod.prefetchDeviceProviders('dev-2');
    expect(invoke).toHaveBeenCalledTimes(2);
    mod.evictDeviceProviders('dev-1');
    await mod.prefetchDeviceProviders('dev-1'); // 缓存已清 → 重拉(+1)
    await mod.prefetchDeviceProviders('dev-2'); // 未清 → 命中(+0)
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('evict 在途 prefetch → 结果丢弃,不复活缓存(重连/升级目标端后串旧)', async () => {
    const resolvers: Array<(v: Providers) => void> = [];
    const invoke = vi.fn(() => new Promise<Providers>((r) => resolvers.push(r)));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');

    const p = mod.prefetchDeviceProviders('dev-1'); // 在途(invoke 未 resolve)
    mod.evictDeviceProviders('dev-1'); // 设备下线 → 驱逐(代际自增)
    resolvers.forEach((r) => r(result('dev-1-stale'))); // 在途请求随后才回来
    await p;

    // 被驱逐的在途结果不得回写缓存 → 再 prefetch 必须重新发请求(总计 2 次)。
    const p2 = mod.prefetchDeviceProviders('dev-1');
    resolvers.forEach((r) => r(result('dev-1-fresh'))); // resolve 第二轮(含已 resolve 的第一轮,no-op)
    await p2;
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('reject(旧版被控端不识别通道)→ 不缓存,下次重试', async () => {
    let call = 0;
    const invoke = vi.fn(async () => {
      call += 1;
      throw new Error("channel 'maker:provider:list' not allowed remotely");
    });
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');
    await mod.prefetchDeviceProviders('dev-old'); // swallow
    await mod.prefetchDeviceProviders('dev-old'); // 上次失败未缓存 → 再发
    expect(call).toBe(2);
  });
});
