// @ts-nocheck —— 被测对象是 .mjs 发布工具模块。
import { describe, expect, it, vi } from 'vitest';

import {
  baselineBuildNumber,
  baselineRuntimeVersion,
  assertExpoManifestForPromotion,
  buildOtaPointerLocation,
  buildReleasePointerLocation,
  assertReleaseRecordForPromotion,
  fetchCanaryReleaseBaseline,
  fetchJsonPointer,
} from '../../scripts/lib/release-pointers.mjs';

function response(status: number, value: unknown = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => value,
  };
}

describe('mobile release pointer paths', () => {
  it('iOS / Android 共用 canary 与 stable 命名约定', () => {
    expect(buildReleasePointerLocation({
      cdnBase: 'https://cdn.example/app/',
      ossPrefix: '/cindy/',
      platform: 'ios',
      channel: 'canary',
    })).toEqual({
      file: 'canary-release.json',
      key: 'cindy/mobile-ota/ios/canary-release.json',
      url: 'https://cdn.example/app/mobile-ota/ios/canary-release.json',
    });
    expect(buildReleasePointerLocation({
      cdnBase: 'https://cdn.example/app',
      ossPrefix: 'cindy',
      platform: 'android',
      channel: 'stable',
    }).file).toBe('release.json');
  });

  it('OTA 指针按 runtime 隔离且 canary 不覆盖 latest.json', () => {
    expect(buildOtaPointerLocation({
      cdnBase: 'https://cdn.example/app',
      ossPrefix: 'cindy',
      platform: 'android',
      runtimeVersion: 'rtv 1',
      channel: 'canary',
    })).toEqual({
      file: 'canary-latest.json',
      key: 'cindy/mobile-ota/android/rtv 1/canary-latest.json',
      url: 'https://cdn.example/app/mobile-ota/android/rtv%201/canary-latest.json',
    });
  });
});

describe('fetchCanaryReleaseBaseline', () => {
  it('优先 canary；存在时不读取 stable', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('canary-release')) return response(200, { buildNumber: '2', runtimeVersion: 'canary' });
      return response(200, { buildNumber: '1', runtimeVersion: 'stable' });
    });
    const baseline = await fetchCanaryReleaseBaseline({
      canaryUrl: 'https://cdn/canary-release.json',
      stableUrl: 'https://cdn/release.json',
      fetchImpl: fetcher,
    });
    expect(baseline.source).toBe('canary');
    expect(baselineRuntimeVersion(baseline)).toBe('canary');
    expect(baselineBuildNumber(baseline)).toBe('2');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('canary 404 才回退 stable；两者 404 才是首发', async () => {
    const stableFetcher = vi.fn(async (url: string) => (
      url.includes('canary-release')
        ? response(404)
        : response(200, { buildNumber: 7, runtimeVersion: 'stable' })
    ));
    const stable = await fetchCanaryReleaseBaseline({
      canaryUrl: 'https://cdn/canary-release.json',
      stableUrl: 'https://cdn/release.json',
      fetchImpl: stableFetcher,
    });
    expect(stable.source).toBe('stable');
    expect(baselineBuildNumber(stable)).toBe(7);

    const none = await fetchCanaryReleaseBaseline({
      canaryUrl: 'https://cdn/canary-release.json',
      stableUrl: 'https://cdn/release.json',
      fetchImpl: async () => response(404),
    });
    expect(none).toEqual({ record: null, source: 'none', url: null });
  });

  it('非 404、坏 JSON 与缺关键字段均 fail closed', async () => {
    await expect(fetchJsonPointer('https://cdn/x.json', async () => response(500)))
      .rejects.toThrow(/HTTP 500/);
    await expect(fetchJsonPointer('https://cdn/x.json', async () => ({
      status: 200,
      ok: true,
      json: async () => { throw new Error('bad'); },
    }))).rejects.toThrow(/JSON 解析失败/);

    const malformed = { record: {}, source: 'canary', url: 'https://cdn/canary-release.json' };
    expect(() => baselineBuildNumber(malformed)).toThrow(/buildNumber/);
    expect(() => baselineRuntimeVersion(malformed)).toThrow(/runtimeVersion/);
  });

  it('promote 拒绝缺 version/installUrl 的损坏 canary 指针', () => {
    const base = { source: 'canary', url: 'https://cdn/canary-release.json' };
    expect(() => assertReleaseRecordForPromotion({
      ...base,
      record: { version: '1.0.0', buildNumber: 1, runtimeVersion: 'rtv' },
    })).toThrow(/installUrl/);
    expect(() => assertReleaseRecordForPromotion({
      ...base,
      record: { version: '1.0.0', buildNumber: 1, runtimeVersion: 'rtv', installUrl: 'https://store' },
    })).not.toThrow();
  });

  it('promote 严格校验 canary OTA manifest 的 runtime 和最小协议形状', () => {
    const valid = {
      id: 'update-1',
      runtimeVersion: 'rtv',
      launchAsset: { url: 'https://cdn/launch.js' },
      assets: [],
    };
    expect(assertExpoManifestForPromotion(valid, 'rtv', 'https://cdn/canary-latest.json')).toBe(valid);
    expect(() => assertExpoManifestForPromotion({ ...valid, runtimeVersion: 'old' }, 'rtv', 'u'))
      .toThrow(/runtimeVersion/);
    expect(() => assertExpoManifestForPromotion({ ...valid, id: '' }, 'rtv', 'u')).toThrow(/缺 id/);
    expect(() => assertExpoManifestForPromotion({ ...valid, launchAsset: {} }, 'rtv', 'u'))
      .toThrow(/launchAsset 缺 url/);
    expect(() => assertExpoManifestForPromotion({ ...valid, assets: {} }, 'rtv', 'u'))
      .toThrow(/assets 数组/);
  });
});
