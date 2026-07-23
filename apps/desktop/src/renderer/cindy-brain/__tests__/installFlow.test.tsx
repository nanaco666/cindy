/** installFlow.test — Node 高风险权限必须经过第二次人工确认。 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { confirmAndInstallGhost } from '../installFlow';

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const baseManifest = {
  schemaVersion: 2 as const,
  id: 'node-ghost',
  name: 'Node Ghost',
  version: '1.0.0',
  kind: 'chip' as const,
  entry: 'main.js',
  slots: ['node'] as const,
  node: { entry: 'node/worker.cjs', protocol: 'json-rpc-stdio' as const },
};

function setupWindow(manifest: object) {
  const install = vi.fn(async () => ({ ghost: { manifest } }));
  const electronAPI = {
    ghosts: {
      inspect: vi.fn(async () => ({
        manifest,
        packageSha256: 'a'.repeat(64),
        trust: {
          level: 'unverified',
          publisherSigned: false,
          publisherVerified: false,
          reviewed: false,
        },
      })),
      listSync: vi.fn(() => ({ ghosts: [] })),
      install,
    },
  };
  Object.defineProperty(globalThis, 'window', {
    value: { electronAPI },
    configurable: true,
  });
  return { install };
}

function deps(confirm: (options: unknown) => Promise<boolean>) {
  return {
    t: ((key: string) => key) as never,
    confirm,
    confirmWithCheckbox: vi.fn(async () => ({ ok: true, checked: false })),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, 'window');
});

describe('installFlow · Node 二次确认', () => {
  it('用户在第二层风险提示取消时，不会安装 Node 插件', async () => {
    const { install } = setupWindow(baseManifest);
    const confirm = vi.fn(async () => false);

    await confirmAndInstallGhost('/tmp/node.cindy', deps(confirm));

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'settings.ghosts.installConfirm.nodeRiskTitle',
        confirmText: 'settings.ghosts.installConfirm.nodeRiskConfirm',
      }),
    );
    expect(install).not.toHaveBeenCalled();
  });

  it('两层都确认后才安装 Node 插件', async () => {
    const { install } = setupWindow(baseManifest);
    const confirm = vi.fn(async () => true);

    await confirmAndInstallGhost('/tmp/node.cindy', deps(confirm));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith('/tmp/node.cindy', {
      enable: false,
      expectedPackageSha256: 'a'.repeat(64),
    });
  });

  it('普通浏览器沙箱插件没有多余的第二层 Node 提示', async () => {
    const manifest = { ...baseManifest, slots: ['card'], node: undefined };
    const { install } = setupWindow(manifest);
    const confirm = vi.fn(async () => true);

    await confirmAndInstallGhost('/tmp/plain.cindy', deps(confirm));

    expect(confirm).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledTimes(1);
  });
});
