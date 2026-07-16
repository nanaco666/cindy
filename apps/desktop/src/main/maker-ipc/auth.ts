/**
 * apps/desktop/src/main/maker-ipc/auth.ts
 *
 * maker:auth:* IPC 的 Electron adapter —— 取代老 codex:auth:* 链路。
 *
 * handler body 在 authHandlers.ts，便于不启动 Electron 直接测试。
 * renderer 调 `electronAPI.maker.auth.*(agentKind)` → IPC → Maker → BaseAgent.deps.auth。
 * 不再需要 vendor 名出现在 IPC 路径上, agentKind 是参数。
 */


import type { Maker } from '@lizi/maker-core';
import { BrowserWindow } from 'electron';
import { createLogger } from '../logger.js';

import { readClaudeApiKey } from '../maker-host/auth-adapters.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { clearChatgptBridgeCredentialCache } from '../maker-host/anthropic-responses-bridge-host.js';
import { refreshCatalogDerivedModels } from '../maker-host/catalog-to-descriptors.js';
import { refreshDiscoveredCodexModels } from '../maker-host/createDesktopProviderService.js';
import { registerMakerAuthHandlers } from './authHandlers.js';
import { createElectronIpcHandlerRegistry } from './electronIpcRegistry.js';

const log = createLogger('maker-ipc:auth');

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (e) {
      log.warn(`broadcast to window failed: ${String(e)}`);
    }
  }
}

export function registerMakerAuthIpc(maker: Maker): void {
  log.info('registering maker:auth:* IPC handlers');

  registerMakerAuthHandlers(
    createElectronIpcHandlerRegistry(),
    maker,
    broadcast,
    readClaudeApiKey,
    // codex 登录/登出完成 → 清 bridge 凭证缓存 + 重读 models_cache 刷新 chatgpt/ 发现清单;
    // handler 在 AUTH_STATE_CHANGED 广播前 await,renderer refetch 即见最新目录(设置页
    // triggerLogin 路径不经 finalizeCodexAfterAuthModeChange,必须在这里同样收口)。
    async (authenticated) => {
      clearChatgptBridgeCredentialCache();
      await refreshDiscoveredCodexModels(authenticated);
      refreshCatalogDerivedModels(maker, getActiveCatalog());
    },
  );

  log.info('maker:auth:* IPC handlers registered');
}
