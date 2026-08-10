import { GLOBAL_PLUGIN_IDS } from '../maker-host/plugins/types.js';

interface PluginEnablementRegistry {
  setEnabled: (id: string, enabled: boolean) => Promise<boolean>;
  clearEnabled: (id: string) => Promise<boolean>;
}

interface PluginEnablementHandlerDeps {
  getPluginRegistry: () => PluginEnablementRegistry;
  invalidatePiEnvironment: () => void;
  refreshCodexMcpEnvironment: () => Promise<{ codexMcpRefreshed: boolean }>;
  rejectEssentialPlugin: (id: string) => never;
}

async function refreshPluginMcpEnvironments(
  id: string,
  deps: PluginEnablementHandlerDeps,
): Promise<{ codexMcpRefreshed: boolean }> {
  const isMachineWide = GLOBAL_PLUGIN_IDS.has(id);
  if (!isMachineWide && id !== 'browser') {
    return { codexMcpRefreshed: true };
  }

  // Pi generations freeze their provider set. Machine-wide preference changes
  // must retire the current generation so the next session observes the saved
  // value; active sessions keep their old generation through their lease.
  if (isMachineWide) {
    deps.invalidatePiEnvironment();
  }

  return deps.refreshCodexMcpEnvironment();
}

/** Persist an explicit plugin override before refreshing frozen MCP environments. */
export async function setPluginEnabledAndRefresh(
  id: string,
  enabled: boolean,
  deps: PluginEnablementHandlerDeps,
): Promise<{ codexMcpRefreshed: boolean }> {
  const ok = await deps.getPluginRegistry().setEnabled(id, enabled);
  if (!ok) {
    deps.rejectEssentialPlugin(id);
  }
  return refreshPluginMcpEnvironments(id, deps);
}

/** Clear a plugin override before refreshing frozen MCP environments. */
export async function clearPluginEnabledAndRefresh(
  id: string,
  deps: PluginEnablementHandlerDeps,
): Promise<{ codexMcpRefreshed: boolean }> {
  const ok = await deps.getPluginRegistry().clearEnabled(id);
  if (!ok) {
    deps.rejectEssentialPlugin(id);
  }
  return refreshPluginMcpEnvironments(id, deps);
}
