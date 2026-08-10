import type { ComputerDriverStatus } from '@cindy/mcps';
import { describe, expect, it, vi } from 'vitest';

import { ComputerUseSetupService } from '../computerUseSetupService.js';

function status(
  platform: 'macos' | 'windows',
  permissionStatus: 'granted' | 'missing' | 'not_required',
  installed = true,
): ComputerDriverStatus {
  return {
    installed,
    executablePath: installed ? '/tmp/cua-driver' : null,
    version: installed ? '0.12.2' : null,
    daemonRunning: installed,
    permissionState: {
      platform,
      required: platform === 'macos',
      status: permissionStatus,
      accessibility: permissionStatus,
      screenRecording: permissionStatus,
      screenRecordingCapturable: permissionStatus,
      canGrant: platform === 'macos',
    },
    installCommand: 'install-cua-driver',
    docsUrl: 'https://cua.ai/docs/cua-driver',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ComputerUseSetupService', () => {
  it('keeps one install operation and lets repeated requests join it', async () => {
    const install = deferred<{ status: ComputerDriverStatus }>();
    const installDriver = vi.fn(() => install.promise);
    const setEnabled = vi.fn(async () => ({ codexMcpRefreshed: true }));
    const service = new ComputerUseSetupService({
      getStatus: vi.fn(async () => status('windows', 'not_required', false)),
      installDriver,
      requestPermissions: vi.fn(),
      setEnabled,
      cancelPermissionGrant: vi.fn(),
      closePermissionGuide: vi.fn(),
      onStatusChanged: vi.fn(),
    });

    const first = service.start({ intent: 'permissions-only' });
    await flushMicrotasks();
    const second = service.start({ intent: 'enable' });

    expect(second).toBe(first);
    expect(service.getSnapshot()).toMatchObject({
      active: true,
      phase: 'installing',
      intent: 'enable',
    });
    expect(installDriver).toHaveBeenCalledOnce();

    install.resolve({ status: status('windows', 'not_required') });
    await expect(first).resolves.toMatchObject({ active: false, phase: 'ready' });
    expect(setEnabled).toHaveBeenCalledOnce();
  });

  it('keeps polling after the Renderer detaches and exposes the same operation for reattach', async () => {
    const missing = status('macos', 'missing');
    const granted = status('macos', 'granted');
    const poll = deferred<void>();
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(granted);
    const cancelPermissionGrant = vi.fn();
    const service = new ComputerUseSetupService({
      getStatus,
      installDriver: vi.fn(),
      requestPermissions: vi.fn(async () => ({ status: missing })),
      setEnabled: vi.fn(async () => ({ codexMcpRefreshed: true })),
      cancelPermissionGrant,
      closePermissionGuide: vi.fn(),
      onStatusChanged: vi.fn(),
      sleep: () => poll.promise,
    });

    const operation = service.start({ intent: 'permissions-only' });
    await flushMicrotasks();
    await flushMicrotasks();
    const reattached = service.getSnapshot();

    expect(reattached).toMatchObject({
      operationId: 1,
      active: true,
      phase: 'waiting-permissions',
    });
    expect(cancelPermissionGrant).not.toHaveBeenCalled();

    poll.resolve();
    await expect(operation).resolves.toMatchObject({
      operationId: 1,
      active: false,
      phase: 'ready',
      status: granted,
    });
  });

  it('only explicit cancellation invalidates the generation and closes the guide', async () => {
    const missing = status('macos', 'missing');
    const permission = deferred<{ status: ComputerDriverStatus }>();
    const cancelPermissionGrant = vi.fn();
    const closePermissionGuide = vi.fn();
    const setEnabled = vi.fn(async () => ({ codexMcpRefreshed: true }));
    const service = new ComputerUseSetupService({
      getStatus: vi.fn(async () => missing),
      installDriver: vi.fn(),
      requestPermissions: vi.fn(() => permission.promise),
      setEnabled,
      cancelPermissionGrant,
      closePermissionGuide,
      onStatusChanged: vi.fn(),
    });

    const operation = service.start({ intent: 'enable' });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(service.getSnapshot().phase).toBe('requesting-permissions');

    expect(service.cancel()).toMatchObject({
      operationId: 2,
      active: false,
      phase: 'cancelled',
    });
    expect(cancelPermissionGrant).toHaveBeenCalledOnce();
    expect(closePermissionGuide).toHaveBeenCalledOnce();

    permission.resolve({ status: status('macos', 'granted') });
    await expect(operation).resolves.toMatchObject({ phase: 'cancelled' });
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('skips TCC permission work on Windows and enables without byte progress state', async () => {
    const windowsReady = status('windows', 'not_required');
    const requestPermissions = vi.fn();
    const setEnabled = vi.fn(async () => ({ codexMcpRefreshed: true }));
    const service = new ComputerUseSetupService({
      getStatus: vi.fn(async () => windowsReady),
      installDriver: vi.fn(),
      requestPermissions,
      setEnabled,
      cancelPermissionGrant: vi.fn(),
      closePermissionGuide: vi.fn(),
      onStatusChanged: vi.fn(),
    });

    await expect(service.start({ intent: 'enable' })).resolves.toMatchObject({
      phase: 'ready',
      status: windowsReady,
    });
    expect(requestPermissions).not.toHaveBeenCalled();
    expect(setEnabled).toHaveBeenCalledWith(true);
  });
});
