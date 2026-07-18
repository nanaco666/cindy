/**
 * cindy-slack 设置页黑盒测试:settingsHtml 先读宿主 app-context,再按 region
 * 选择清单允许的 Slack OAuth Client ID。脚本跑在无 preload 的沙箱页面,
 * 这里用最小 DOM/fetch 假体锁住真实请求 body 与未知 region 的 fail-closed。
 */
import fs from 'node:fs';
import { Script, createContext } from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

const SETTINGS_SOURCE = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../resources/builtin-ghosts/cindy-slack/settings.js',
  ),
  'utf-8',
);

interface FetchCall {
  url: string;
  init?: { method?: string; body?: string };
}

function createHarness(region: string) {
  const calls: FetchCall[] = [];
  const listeners = new Map<string, () => void>();
  const elements = new Map<string, Record<string, unknown>>();

  for (const id of ['status', 'accounts', 'connect-rw', 'connect-ro']) {
    elements.set(id, {
      textContent: '',
      disabled: false,
      appendChild: vi.fn(),
      addEventListener: (_event: string, listener: () => void) => listeners.set(id, listener),
    });
  }

  const fetch = vi.fn(async (url: string, init?: FetchCall['init']) => {
    calls.push({ url, init });
    if (url === '/oauth') return { ok: true, status: 200, json: async () => [] };
    if (url === '/app-context') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, context: { region } }),
      };
    }
    if (url === '/oauth/slack_account/connect') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, account: { label: 'tester' } }),
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const context = createContext({
    document: {
      getElementById: (id: string) => elements.get(id),
      createElement: () => ({ appendChild: vi.fn(), addEventListener: vi.fn() }),
    },
    fetch,
    // 状态提示的 4 秒清理不属于本测试行为，避免留下真实 timer handle。
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn(),
  });
  new Script(SETTINGS_SOURCE, { filename: 'builtin-ghosts/cindy-slack/settings.js' }).runInContext(
    context,
  );

  return { calls, listeners };
}

async function waitForConnect(calls: FetchCall[]): Promise<FetchCall | undefined> {
  for (let i = 0; i < 20; i++) {
    const call = calls.find((entry) => entry.url === '/oauth/slack_account/connect');
    if (call) return call;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return undefined;
}

describe('cindy-slack settings · region Client ID', () => {
  it.each([
    ['cn', '2372848536.11511864051187'],
    ['global', '2372848536.11619977511874'],
  ])('%s 构建选择对应 Slack App', async (region, expectedClientId) => {
    const harness = createHarness(region);
    harness.listeners.get('connect-rw')?.();
    const connect = await waitForConnect(harness.calls);
    expect(connect).toBeDefined();
    expect(JSON.parse(connect?.init?.body ?? '{}')).toEqual({ clientId: expectedClientId });
  });

  it('未知 region fail-closed,不发起 OAuth connect', async () => {
    const harness = createHarness('unknown');
    harness.listeners.get('connect-rw')?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.calls.some((entry) => entry.url === '/oauth/slack_account/connect')).toBe(false);
  });
});
