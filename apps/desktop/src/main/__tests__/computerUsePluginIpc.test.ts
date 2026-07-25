import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('computer use plugin IPC invariants', () => {
  it('rebuilds cached Codex MCP config after global plugin enablement changes', () => {
    const registerSource = fs.readFileSync(
      path.resolve(__dirname, '../maker-ipc/register.ts'),
      'utf-8',
    );
    const setEnabledStart = registerSource.indexOf('ipcMain.handle(MAKER_INVOKE.PLUGINS_SET_ENABLED');
    const clearEnabledStart = registerSource.indexOf('ipcMain.handle(MAKER_INVOKE.PLUGINS_CLEAR_ENABLED');
    expect(setEnabledStart).toBeGreaterThanOrEqual(0);
    expect(clearEnabledStart).toBeGreaterThan(setEnabledStart);

    const setEnabledBody = registerSource.slice(setEnabledStart, clearEnabledStart);
    const clearEnabledEnd = registerSource.indexOf('ipcMain.handle(MAKER_INVOKE.PLUGINS_SET_PROJECT_ENABLED', clearEnabledStart);
    const clearEnabledBody = registerSource.slice(
      clearEnabledStart,
      clearEnabledEnd > clearEnabledStart ? clearEnabledEnd : undefined,
    );

    for (const body of [setEnabledBody, clearEnabledBody]) {
      expect(body).toContain('GLOBAL_PLUGIN_IDS.has(id)');
      expect(body).toContain('await shutdownCodexEnvironment();');
      expect(body).toContain('await restartCodexAfterAuthModeChange();');
      expect(body.indexOf('GLOBAL_PLUGIN_IDS.has(id)')).toBeLessThan(
        body.indexOf('getPluginRegistry()'),
      );
      expect(body.indexOf('await shutdownCodexEnvironment();')).toBeLessThan(
        body.indexOf('await restartCodexAfterAuthModeChange();'),
      );
    }
  });
});
