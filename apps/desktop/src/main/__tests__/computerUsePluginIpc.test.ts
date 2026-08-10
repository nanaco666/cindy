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

  it('schedules a retry when the shared host is busy', async () => {
    const onDeferred = vi.fn();

    await expect(
      refreshCodexMcpEnvironment({
        restartCodex: vi.fn(async () => {
          throw new Error('codex busy');
        }),
        shutdownCodexEnvironment: vi.fn(async () => undefined),
        onDeferred,
      }),
    ).resolves.toEqual({ codexMcpRefreshed: false });

    expect(onDeferred).toHaveBeenCalledOnce();
  });

  it('returns the non-blocking refresh result after global plugin persistence', () => {
    const registerSource = fs.readFileSync(
      path.resolve(__dirname, '../maker-ipc/register.ts'),
      'utf-8',
    );
    const helperStart = registerSource.indexOf('const setPluginEnabled = async');
    const setEnabledStart = registerSource.indexOf(
      'ipcMain.handle(MAKER_INVOKE.PLUGINS_SET_ENABLED',
    );
    const clearEnabledStart = registerSource.indexOf(
      'ipcMain.handle(MAKER_INVOKE.PLUGINS_CLEAR_ENABLED',
    );
    expect(setEnabledStart).toBeGreaterThanOrEqual(0);
    expect(clearEnabledStart).toBeGreaterThan(setEnabledStart);

    const helperBody = registerSource.slice(helperStart, setEnabledStart);
    const setEnabledBody = registerSource.slice(setEnabledStart, clearEnabledStart);
    const clearEnabledEnd = registerSource.indexOf(
      'registerProjectPluginPolicyHandlers',
      clearEnabledStart,
    );
    expect(clearEnabledEnd).toBeGreaterThan(clearEnabledStart);
    const clearEnabledBody = registerSource.slice(clearEnabledStart, clearEnabledEnd);

    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(setEnabledBody).toContain('return setPluginEnabled(id, enabled)');
    for (const body of [helperBody, clearEnabledBody]) {
      expect(body).toContain('GLOBAL_PLUGIN_IDS.has(id)');
      expect(body).toContain("id !== 'browser'");
      expect(body).toContain('await getPluginRegistry()');
      expect(body).toContain('return { codexMcpRefreshed: true };');
      expect(body).toContain('return refreshCodexMcpEnvironment({');
      expect(body.indexOf('await getPluginRegistry()')).toBeLessThan(
        body.indexOf('GLOBAL_PLUGIN_IDS.has(id)'),
      );
      expect(body.indexOf('GLOBAL_PLUGIN_IDS.has(id)')).toBeLessThan(
        body.indexOf('return refreshCodexMcpEnvironment({'),
      );
      expect(body).not.toContain('await shutdownCodexEnvironment();');
    }
  });

  it('preserves the live Codex bridge plugin gate while refresh is deferred', () => {
    const providersSource = fs.readFileSync(
      path.resolve(__dirname, '../mcp-integrations/mcp-providers.ts'),
      'utf-8',
    );

    expect(providersSource).toContain(
      "context?.agentKind === 'codex' || pluginRegistry.isEnabled('android')",
    );
    expect(providersSource).toContain(
      "context?.agentKind === 'codex' || pluginRegistry.isEnabled('computer')",
    );
  });

  it('keeps the @ desktop-window gate machine-scoped', () => {
    const registerSource = fs.readFileSync(
      path.resolve(__dirname, '../maker-ipc/register.ts'),
      'utf-8',
    );
    const handlerStart = registerSource.indexOf('ipcMain.handle(MAKER_INVOKE.AT_CONTEXT_LIST');
    const handlerEnd = registerSource.indexOf(
      'ipcMain.handle(MAKER_INVOKE.LIST_CUSTOMIZATIONS',
      handlerStart,
    );
    const handlerBody = registerSource.slice(handlerStart, handlerEnd);

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handlerBody).toContain("getPluginRegistry().isEnabled('computer')");
    expect(handlerBody).not.toContain(
      "getPluginRegistry().isEnabled('computer', request.workingDir)",
    );
  });

  it('revalidates Computer Use guide requests at the Main IPC boundary', () => {
    const registerSource = fs.readFileSync(
      path.resolve(__dirname, '../maker-ipc/register.ts'),
      'utf-8',
    );
    const handlerStart = registerSource.indexOf(
      'ipcMain.handle(MAKER_INVOKE.COMPUTER_GRANT_PERMISSIONS',
    );
    const handlerEnd = registerSource.indexOf(
      'ipcMain.handle(MAKER_INVOKE.COMPUTER_DRIVER_ICON',
      handlerStart,
    );
    const handlerBody = registerSource.slice(handlerStart, handlerEnd);

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handlerBody).toContain('assertTrustedAppRendererEvent(_event)');
    expect(handlerBody).toContain('parseComputerPermissionGrantRequest(payload)');
    expect(handlerBody).toContain("throwIpcError('INVALID_PARAMS'");
    expect(handlerBody).toContain('freshPermissionProbe: true');
    expect(handlerBody).toContain('bypassPermissionProbeCache: true');
    expect(handlerBody).not.toContain('options?.initialStatus');
    expect(handlerBody.indexOf('getComputerDriverStatus({')).toBeLessThan(
      handlerBody.indexOf('requestComputerPermissions({'),
    );
  });

  it('validates and guards the Main-owned setup operation IPC', () => {
    const registerSource = fs.readFileSync(
      path.resolve(__dirname, '../maker-ipc/register.ts'),
      'utf-8',
    );
    const handlerStart = registerSource.indexOf('ipcMain.handle(MAKER_INVOKE.COMPUTER_SETUP_START');
    const handlerEnd = registerSource.indexOf(
      'ipcMain.handle(MAKER_INVOKE.COMPUTER_SETUP_CANCEL',
      handlerStart,
    );
    const handlerBody = registerSource.slice(handlerStart, handlerEnd);

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handlerBody).toContain('assertTrustedAppRendererEvent(_event)');
    expect(handlerBody).toContain('parseComputerUseSetupStartRequest(payload)');
    expect(handlerBody).toContain("throwIpcError('INVALID_PARAMS'");
    expect(handlerBody).toContain('computerUseSetup.start(');
  });

  it('guards Computer Use guide cancellation before mutating Main state', () => {
    const registerSource = fs.readFileSync(
      path.resolve(__dirname, '../maker-ipc/register.ts'),
      'utf-8',
    );
    const handlerStart = registerSource.indexOf(
      'ipcMain.handle(MAKER_INVOKE.COMPUTER_CANCEL_PERMISSION_GRANT',
    );
    const handlerEnd = registerSource.indexOf(
      'ipcMain.handle(MAKER_INVOKE.COMPUTER_CHECK_UPDATE',
      handlerStart,
    );
    const handlerBody = registerSource.slice(handlerStart, handlerEnd);

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handlerBody).toContain('isComputerPermissionGuideWebContents(_event.sender)');
    expect(handlerBody).toContain('assertTrustedAppRendererEvent(_event)');
    expect(handlerBody.indexOf('assertTrustedAppRendererEvent(_event)')).toBeLessThan(
      handlerBody.indexOf('cancelComputerDriverPermissionGrant()'),
    );
  });
});

describe('computer use UI feedback invariants', () => {
  it('keeps Android success feedback when Codex MCP refresh is deferred', () => {
    const sectionSource = fs.readFileSync(
      path.resolve(__dirname, '../../renderer/components/settings/ComputerUseSection.tsx'),
      'utf-8',
    );
    const toggleAndroidStart = sectionSource.indexOf('const handleToggleAndroid');
    const toggleComputerStart = sectionSource.indexOf(
      'const handleToggleComputer',
      toggleAndroidStart,
    );
    expect(toggleAndroidStart).toBeGreaterThanOrEqual(0);
    expect(toggleComputerStart).toBeGreaterThan(toggleAndroidStart);

    const toggleAndroidBody = sectionSource.slice(toggleAndroidStart, toggleComputerStart);
    const successToast = toggleAndroidBody.indexOf('toast.success(');
    const deferredWarning = toggleAndroidBody.indexOf('if (result.codexMcpRefreshed === false)');
    expect(successToast).toBeGreaterThanOrEqual(0);
    expect(deferredWarning).toBeGreaterThan(successToast);
  });

  it('moves the legacy CLI-only permission poll into the Main-owned service', () => {
    const sectionSource = fs.readFileSync(
      path.resolve(__dirname, '../../renderer/components/settings/ComputerUseSection.tsx'),
      'utf-8',
    );
    const serviceSource = fs.readFileSync(
      path.resolve(__dirname, '../maker-ipc/computerUseSetupService.ts'),
      'utf-8',
    );

    expect(sectionSource).not.toContain("refreshComputerPermissionStatus('permission-poll'");
    expect(serviceSource).toContain('waitForPermissions(operationId, status)');
    expect(serviceSource).toContain('bypassPermissionProbeCache: true');
    expect(serviceSource).toContain('DEFAULT_PERMISSION_POLL_TIMEOUT_MS');
  });

  it('refreshes mutable macOS permission state before enabling Computer Use', () => {
    const serviceSource = fs.readFileSync(
      path.resolve(__dirname, '../maker-ipc/computerUseSetupService.ts'),
      'utf-8',
    );
    const freshProbe = serviceSource.indexOf('freshPermissionProbe: true');
    const enableCall = serviceSource.indexOf('await this.deps.setEnabled(true)');

    expect(freshProbe).toBeGreaterThanOrEqual(0);
    expect(enableCall).toBeGreaterThan(freshProbe);
    expect(serviceSource.slice(freshProbe, enableCall)).toContain(
      'bypassPermissionProbeCache: true',
    );
  });

  it('preserves the deferred Codex refresh warning after native onboarding', () => {
    const sectionSource = fs.readFileSync(
      path.resolve(__dirname, '../../renderer/components/settings/ComputerUseSection.tsx'),
      'utf-8',
    );
    const toggleStart = sectionSource.indexOf('const handleToggleComputer');
    const toggleEnd = sectionSource.indexOf('const handleDownload', toggleStart);
    const toggleBody = sectionSource.slice(toggleStart, toggleEnd);

    expect(toggleStart).toBeGreaterThanOrEqual(0);
    expect(toggleEnd).toBeGreaterThan(toggleStart);
    expect(toggleBody).toContain('result.codexMcpRefreshed === false');
    expect(toggleBody).toContain("toast.warning(t('settings.computerUse.codexRefreshDeferred'))");
  });

  it('only detaches the setup observer when Settings unmounts', () => {
    const sectionSource = fs.readFileSync(
      path.resolve(__dirname, '../../renderer/components/settings/ComputerUseSection.tsx'),
      'utf-8',
    );
    const cleanupStart = sectionSource.indexOf('// Renderer lifetime only owns this observer.');
    const cleanupEnd = sectionSource.indexOf('const openComputerPermissionSettings', cleanupStart);
    const toggleStart = sectionSource.indexOf('const handleToggleComputer');
    const toggleEnd = sectionSource.indexOf('const handleOpenComputerPermission', toggleStart);
    const cleanupBody = sectionSource.slice(cleanupStart, cleanupEnd);
    const toggleBody = sectionSource.slice(toggleStart, toggleEnd);

    expect(cleanupStart).toBeGreaterThanOrEqual(0);
    expect(cleanupBody).toContain('computerUseSectionMountedRef.current = false');
    expect(cleanupBody).toContain('unsubscribe()');
    expect(cleanupBody).not.toContain('cancelPermissionGrant');
    expect(cleanupBody).not.toContain('cancelSetup');
    expect(toggleStart).toBeGreaterThanOrEqual(0);
    expect(toggleBody).toContain("startSetup({ intent: 'enable' })");
    expect(toggleBody).not.toContain('installDriver()');
    expect(toggleBody).not.toContain('grantPermissions(');
  });
});

describe('computer use platform copy invariants', () => {
  it('keeps macOS permission guidance out of the Windows copy path', () => {
    const sectionSource = fs.readFileSync(
      path.resolve(__dirname, '../../renderer/components/settings/ComputerUseSection.tsx'),
      'utf-8',
    );
    expect(sectionSource).toContain("nextStatus.permissionState?.platform === 'macos'");
    const macPermissionBlockStart = sectionSource.indexOf(
      "{window.electronAPI.platform === 'darwin' ? (",
    );
    const permissionTitle = sectionSource.indexOf(
      "t('settings.computerUse.directControl.permissions.title')",
      macPermissionBlockStart,
    );
    expect(macPermissionBlockStart).toBeGreaterThanOrEqual(0);
    expect(permissionTitle).toBeGreaterThan(macPermissionBlockStart);

    for (const locale of ['en', 'ja', 'ko', 'zh-CN']) {
      const messages = JSON.parse(
        fs.readFileSync(
          path.resolve(__dirname, `../../renderer/i18n/locales/${locale}/common.json`),
          'utf-8',
        ),
      ) as {
        settings: {
          computerUse: {
            directControl: {
              driverInfo: string;
              permissionIntro: { description: string; macosDescription: string };
            };
          };
        };
      };
      const directControl = messages.settings.computerUse.directControl;
      expect(directControl.driverInfo).not.toContain('macOS');
      expect(directControl.permissionIntro.description).not.toContain('macOS');
      expect(directControl.permissionIntro.macosDescription).toContain('macOS');
    }
  });
});
