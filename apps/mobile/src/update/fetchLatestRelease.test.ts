import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLatestRelease } from './fetchLatestRelease';

const BASE = 'https://ota.example.com';
const resp = (status: number, json?: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => json ?? {},
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchLatestRelease —— 区分"无更新"与"连不上"', () => {
  it('非自建变体(baseUrl 为空)→ null,不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchLatestRelease('ios', 8000, '')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('200 → 返回 JSON 记录', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(200, { runtimeVersion: 'rtv1', version: '1.2.0' })));
    await expect(fetchLatestRelease('ios', 8000, BASE)).resolves.toEqual({ runtimeVersion: 'rtv1', version: '1.2.0' });
  });

  it('404(服务端确认暂无记录)→ null(= 无更新)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(404)));
    await expect(fetchLatestRelease('ios', 8000, BASE)).resolves.toBeNull();
  });

  it('500 / 502(服务异常)→ 抛错,不当成"无更新"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(500)));
    await expect(fetchLatestRelease('ios', 8000, BASE)).rejects.toThrow(/HTTP 500/);
    vi.stubGlobal('fetch', vi.fn(async () => resp(502)));
    await expect(fetchLatestRelease('ios', 8000, BASE)).rejects.toThrow(/HTTP 502/);
  });

  it('网络错误 → 抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network request failed'); }));
    await expect(fetchLatestRelease('ios', 8000, BASE)).rejects.toThrow(/Network request failed/);
  });
});
