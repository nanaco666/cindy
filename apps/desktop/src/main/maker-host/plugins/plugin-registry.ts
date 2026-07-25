/**
 * PluginRegistry — two-tier enable decision with essential override.
 *
 * Priority (highest to lowest):
 *   1. essential === true          → always enabled
 *   2. project settings explicit   → use project value
 *   3. builtin default             → true, except explicitly opt-in plugins
 *
 * isEnabled() is synchronous (used by MCP provider gate during session start).
 * getEnableState() is async (used by IPC handlers for the Settings UI).
 *
 * Essential plugins are hidden from listPlugins() — they are infrastructure
 * that cannot be toggled, so showing them adds no value.
 */

import type { Plugin, PluginId } from './types.js';
import { DEFAULT_DISABLED_PLUGIN_IDS, ESSENTIAL_PLUGIN_IDS, GLOBAL_PLUGIN_IDS, HOSTED_ELSEWHERE_PLUGIN_IDS } from './types.js';
import type { SettingsReader } from './settings-reader.js';
import { createBuiltinPlugins } from './builtin-plugins.js';

export interface PluginRegistryDeps {
  settingsReader: SettingsReader;
}

export interface PluginEnableState {
  effectiveEnabled: boolean;
  projectOverride?: { enabled: boolean; workingDir: string } | null;
  globalOverride?: { enabled: boolean } | null;
}

export interface PluginListItem {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'hub' | 'local';
  essential: boolean;
  effectiveEnabled: boolean;
  projectOverride?: { enabled: boolean; workingDir: string } | null;
}

export class PluginRegistry {
  private plugins: Plugin[];
  private settingsReader: SettingsReader;

  constructor(deps: PluginRegistryDeps) {
    this.settingsReader = deps.settingsReader;
    this.plugins = createBuiltinPlugins();
  }

  /**
   * Synchronous two-tier enable check.
   * Called from MCP provider isEnabled(ctx) gate during session start.
   */
  isEnabled(pluginId: PluginId, workingDir?: string): boolean {
    // Tier 0 — unknown plugin: fail-open.
    const plugin = this.plugins.find((p) => p.id === pluginId);
    if (!plugin && !ESSENTIAL_PLUGIN_IDS.has(pluginId)) return true;

    // Tier 1 — essential: always enabled.
    if (ESSENTIAL_PLUGIN_IDS.has(pluginId)) {
      return true;
    }

    // Tier 2 — global settings for machine-level plugins.
    if (GLOBAL_PLUGIN_IDS.has(pluginId)) {
      const globalVal = this.settingsReader.readGlobalPluginSetting(pluginId);
      if (globalVal !== null) return globalVal;
      return !DEFAULT_DISABLED_PLUGIN_IDS.has(pluginId);
    }

    // Tier 3 — project settings.
    if (workingDir) {
      const projectVal = this.settingsReader.readProjectPluginSetting(workingDir, pluginId);
      if (projectVal !== null) return projectVal;
    }

    // Tier 4 — builtin default.
    return !DEFAULT_DISABLED_PLUGIN_IDS.has(pluginId);
  }

  /** Full async enable-state query used by IPC handlers. */
  async getEnableState(pluginId: PluginId, workingDir?: string): Promise<PluginEnableState> {
    const plugin = this.plugins.find((p) => p.id === pluginId);
    const essential = plugin?.essential ?? ESSENTIAL_PLUGIN_IDS.has(pluginId);

    if (essential) {
      return { effectiveEnabled: true, projectOverride: null, globalOverride: null };
    }

    let globalOverride: { enabled: boolean } | null = null;
    if (GLOBAL_PLUGIN_IDS.has(pluginId)) {
      const gv = this.settingsReader.readGlobalPluginSetting(pluginId);
      if (gv !== null) {
        globalOverride = { enabled: gv };
      }
      return {
        effectiveEnabled:
          globalOverride !== null ? globalOverride.enabled : !DEFAULT_DISABLED_PLUGIN_IDS.has(pluginId),
        projectOverride: null,
        globalOverride,
      };
    }

    let projectOverride: { enabled: boolean; workingDir: string } | null = null;
    if (workingDir) {
      const pv = this.settingsReader.readProjectPluginSetting(workingDir, pluginId);
      if (pv !== null) {
        projectOverride = { enabled: pv, workingDir };
      }
    }

    const effectiveEnabled =
      projectOverride !== null ? projectOverride.enabled : !DEFAULT_DISABLED_PLUGIN_IDS.has(pluginId);

    return { effectiveEnabled, projectOverride, globalOverride: null };
  }

  /**
   * List non-essential plugins with their enable state for the Settings UI.
   * Essential plugins are hidden — they can't be toggled, so showing them
   * adds only cognitive burden.
   */
  async listPlugins(workingDir?: string): Promise<PluginListItem[]> {
    const results: PluginListItem[] = [];
    for (const plugin of this.plugins) {
      if (ESSENTIAL_PLUGIN_IDS.has(plugin.id)) continue;
      // Toggleable but surfaced in a dedicated Settings section (e.g. browser
      // under「电脑使用」), so omit from the generic builtin-tools list.
      if (HOSTED_ELSEWHERE_PLUGIN_IDS.has(plugin.id)) continue;
      const state = await this.getEnableState(plugin.id, workingDir);
      results.push({
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        source: plugin.source,
        essential: false,
        effectiveEnabled: state.effectiveEnabled,
        projectOverride: state.projectOverride ?? undefined,
      });
    }
    return results;
  }

  /**
   * Set project-level override for a plugin. Essential plugins reject
   * silently (return false).
   */
  async setProjectEnabled(pluginId: PluginId, workingDir: string, enabled: boolean): Promise<boolean> {
    if (ESSENTIAL_PLUGIN_IDS.has(pluginId)) return false;
    if (GLOBAL_PLUGIN_IDS.has(pluginId)) {
      return this.setEnabled(pluginId, enabled);
    }
    const defaultEnabled = !DEFAULT_DISABLED_PLUGIN_IDS.has(pluginId);
    if (enabled === defaultEnabled) {
      await this.settingsReader.clearProjectPluginSetting(workingDir, pluginId);
      return true;
    }
    await this.settingsReader.writeProjectPluginSetting(workingDir, pluginId, enabled);
    return true;
  }

  async clearProjectEnabled(pluginId: PluginId, workingDir: string): Promise<boolean> {
    if (ESSENTIAL_PLUGIN_IDS.has(pluginId)) return false;
    if (GLOBAL_PLUGIN_IDS.has(pluginId)) {
      return this.clearEnabled(pluginId);
    }
    await this.settingsReader.clearProjectPluginSetting(workingDir, pluginId);
    return true;
  }

  async setEnabled(pluginId: PluginId, enabled: boolean): Promise<boolean> {
    if (ESSENTIAL_PLUGIN_IDS.has(pluginId)) return false;
    const defaultEnabled = !DEFAULT_DISABLED_PLUGIN_IDS.has(pluginId);
    if (enabled === defaultEnabled) {
      await this.clearEnabled(pluginId);
      return true;
    }
    await this.settingsReader.writeGlobalPluginSetting(pluginId, enabled);
    return true;
  }

  async clearEnabled(pluginId: PluginId): Promise<boolean> {
    if (ESSENTIAL_PLUGIN_IDS.has(pluginId)) return false;
    await this.settingsReader.clearGlobalPluginSetting(pluginId);
    return true;
  }

  /** Get all registered plugins (metadata only, no enable state). Returns a copy. */
  getPlugins(): Plugin[] {
    return this.plugins.map((p) => ({
      ...p,
      capabilities: { ...p.capabilities, mcps: [...(p.capabilities.mcps ?? [])] },
    }));
  }
}
