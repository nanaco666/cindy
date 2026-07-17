import { beforeEach, describe, expect, it, vi } from 'vitest';

let memorySettings = {
  maker: true,
  claudeCode: false,
  codex: false,
};

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/tmp/xdt-maker-test-app',
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected path: ${name}`);
      return '/tmp/xdt-maker-test-user-data';
    },
  },
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    chmodSync: vi.fn(),
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      chmodSync: vi.fn(),
    },
  };
});

// runtime-configs 运行期读端点清单;单测里没有 initClientEndpoints,mock 成 fixture 直读。
vi.mock('../../clientEndpointsService.js', async () => {
  const { TEST_CLIENT_ENDPOINTS } = await import('../../../test/vitest/clientEndpointsFixture');
  return {
    getClientEndpoint: (key: keyof typeof TEST_CLIENT_ENDPOINTS) => TEST_CLIENT_ENDPOINTS[key],
  };
});

describe('runtime-configs', () => {
  beforeEach(() => {
    vi.resetModules();
    memorySettings = {
      maker: true,
      claudeCode: false,
      codex: false,
    };
  });

  it('propagates persisted Maker Memory enablement into agent runtime configs', async () => {
    vi.doMock('../memory-settings-store.js', () => ({
      readMemorySettings: () => memorySettings,
    }));

    const { buildDesktopClaudeRuntimeConfig, desktopCodexRuntimeConfig } = await import('../runtime-configs.js');

    const claudeConfig = buildDesktopClaudeRuntimeConfig(() => 'http://127.0.0.1:1234');

    expect(claudeConfig.memoryEnabled).toBe(false);
    expect(claudeConfig.makerMemoryEnabled).toBe(true);
    expect(desktopCodexRuntimeConfig.memoryEnabled).toBe(false);
    expect(desktopCodexRuntimeConfig.makerMemoryEnabled).toBe(true);

    memorySettings = {
      maker: false,
      claudeCode: true,
      codex: true,
    };

    expect(claudeConfig.memoryEnabled).toBe(false);
    expect(claudeConfig.makerMemoryEnabled).toBe(false);
    expect(desktopCodexRuntimeConfig.memoryEnabled).toBe(false);
    expect(desktopCodexRuntimeConfig.makerMemoryEnabled).toBe(false);
  });
});
