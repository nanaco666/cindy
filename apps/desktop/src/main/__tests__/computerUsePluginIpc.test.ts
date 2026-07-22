import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { refreshCodexMcpEnvironment } from '../maker-ipc/codexMcpRefresh.js';

describe('computer use plugin IPC invariants', () => {
  it('stops the shared Codex host before shutting down its MCP bridge', async () => {
    const calls: string[] = [];

    await expect(
      refreshCodexMcpEnvironment({
        restartCodex: vi.fn(async () => {
          calls.push('restart-codex');
        }),
        shutdownCodexEnvironment: vi.fn(async () => {
          calls.push('shutdown-bridge');
        }),
      }),
    ).resolves.toEqual({ codexMcpRefreshed: true });

    expect(calls).toEqual(['restart-codex', 'shutdown-bridge']);
  });

  it('keeps the existing bridge alive and reports deferred when Codex is busy', async () => {
    const shutdownCodexEnvironment = vi.fn(async () => undefined);
    const logger = { warn: vi.fn() };

    await expect(
      refreshCodexMcpEnvironment({
        restartCodex: vi.fn(async () => {
          throw new Error('codex busy');
        }),
        shutdownCodexEnvironment,
        logger,
      }),
    ).resolves.toEqual({ codexMcpRefreshed: false });

    expect(shutdownCodexEnvironment).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('shared host could not restart'),
      { error: 'codex busy' },
    );
  });

  it('reports deferred instead of rejecting when bridge invalidation fails', async () => {
    const logger = { warn: vi.fn() };

    await expect(
      refreshCodexMcpEnvironment({
        restartCodex: vi.fn(async () => undefined),
        shutdownCodexEnvironment: vi.fn(async () => {
          throw new Error('bridge shutdown failed');
        }),
        logger,
      }),
    ).resolves.toEqual({ codexMcpRefreshed: false });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('old bridge could not shut down'),
      { error: 'bridge shutdown failed' },
    );
  });

  it('returns the non-blocking refresh result after global plugin persistence', () => {
    const registerSource = fs.readFileSync(
      path.resolve(__dirname, '../maker-ipc/register.ts'),
      'utf-8',
    );
    const setEnabledStart = registerSource.indexOf(
      'ipcMain.handle(MAKER_INVOKE.PLUGINS_SET_ENABLED',
    );
    const clearEnabledStart = registerSource.indexOf(
      'ipcMain.handle(MAKER_INVOKE.PLUGINS_CLEAR_ENABLED',
    );
    expect(setEnabledStart).toBeGreaterThanOrEqual(0);
    expect(clearEnabledStart).toBeGreaterThan(setEnabledStart);

    const setEnabledBody = registerSource.slice(setEnabledStart, clearEnabledStart);
    const clearEnabledEnd = registerSource.indexOf(
      'registerProjectPluginPolicyHandlers',
      clearEnabledStart,
    );
    const clearEnabledBody = registerSource.slice(clearEnabledStart, clearEnabledEnd);

    for (const body of [setEnabledBody, clearEnabledBody]) {
      expect(body).toContain('GLOBAL_PLUGIN_IDS.has(id)');
      expect(body).toContain('await getPluginRegistry()');
      expect(body).toContain('return refreshCodexMcpEnvironment({');
      expect(body.indexOf('await getPluginRegistry()')).toBeLessThan(
        body.indexOf('return refreshCodexMcpEnvironment({'),
      );
      expect(body).not.toContain('await shutdownCodexEnvironment();');
    }
  });
});
