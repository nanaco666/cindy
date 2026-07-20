/**
 * Plugin list/detail view models derived only from the installed Ghost contract.
 *
 * Inputs: shared Ghost manifests, install records, and host-owned origin metadata.
 * Outputs: renderer-safe list/detail facts without marketplace or runtime invention.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import {
  ghostContentKeys,
  ghostPermissionItems,
  type GhostPermissionItem,
  type GhostToolDecl,
  type InstalledGhost,
} from '../../../../shared/ghost';

/**
 * Plugin 页面展示的来源分组。
 *
 * 来源不从 ghost.json 自报,而由宿主的内置播种状态决定:内置/企业来自
 * provisioning.json,外部来自用户安装的 .cindy。这样第三方包不能冒充官方。
 */
export type GhostPluginOrigin = 'builtin' | 'enterprise' | 'external';

export interface GhostPluginListItem {
  id: string;
  name: string;
  description: string;
  version: string;
  origin: GhostPluginOrigin;
  enabled: boolean;
  canUse: boolean;
  iconDataUrl?: string;
}
export interface GhostPluginDetail extends GhostPluginListItem {
  installed: boolean;
  author: string | null;
  contents: readonly string[];
  permissions: GhostPermissionItem[];
  tools: readonly GhostToolDecl[];
  hasSettingsUi: boolean;
  cindyCapabilities: readonly string[];
  panelMinWidth: number | null;
  installDir: string | null;
}

/** Existing builtinStatusSync summary for a bundled Plugin that can be restored. */
export interface RestorableGhostPlugin {
  id: string;
  name: string;
  description?: string;
  version: string;
  manifest: import('../../../../shared/ghost').GhostManifest;
  tier: 'builtin' | 'enterprise';
  iconDataUrl?: string;
}

export type GhostFallbackIconKind =
  'diagram' | 'media' | 'search' | 'communication' | 'code' | 'calendar' | 'generic';

/**
 * Chooses a restrained local symbol when a Plugin package has no icon asset.
 * This is presentation-only: a package-provided icon always wins.
 */
export function ghostFallbackIconKind(name: string, id: string): GhostFallbackIconKind {
  const identity = `${id} ${name}`.toLocaleLowerCase();
  if (/mermaid|diagram|flow|chart|draw|绘图|流程|图表/u.test(identity)) return 'diagram';
  if (/mivo|art|image|video|media|photo|图片|图像|视频/u.test(identity)) return 'media';
  if (/search|browser|web|网页|搜索/u.test(identity)) return 'search';
  if (/feishu|lark|slack|chat|message|mail|飞书|消息/u.test(identity)) return 'communication';
  if (/github|gitlab|git|code|dev|代码/u.test(identity)) return 'code';
  if (/calendar|schedule|日历|日程/u.test(identity)) return 'calendar';
  return 'generic';
}

/**
 * Applies the Plugin list's search and source semantics in one place so the
 * result list and every source-tab count use the same matching set.
 */
export function filterGhostPluginItems<T extends GhostPluginListItem>(
  items: readonly T[],
  query: string,
  origin: GhostPluginOrigin | 'all' = 'all',
): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (origin !== 'all' && item.origin !== origin) return false;
    return `${item.name} ${item.description} ${item.id}`
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });
}

/** Counts source groups from the already search-matched Plugin list. */
export function countGhostPluginOrigins(
  items: readonly GhostPluginListItem[],
): Record<GhostPluginOrigin, number> {
  const counts: Record<GhostPluginOrigin, number> = {
    builtin: 0,
    enterprise: 0,
    external: 0,
  };
  for (const item of items) counts[item.origin] += 1;
  return counts;
}

/**
 * Orders installed shortcuts by host-recorded recency while keeping never-used items stable.
 * Unknown/stale ids are ignored, so uninstall or migration residue cannot hide an item.
 */
export function sortGhostPluginItemsByRecentUse<T extends Pick<GhostPluginListItem, 'id'>>(
  items: readonly T[],
  recentIds: readonly string[],
): T[] {
  const recentIndex = new Map(recentIds.map((id, index) => [id, index]));
  return items
    .map((item, stableIndex) => ({ item, stableIndex }))
    .sort((a, b) => {
      const aRecent = recentIndex.get(a.item.id);
      const bRecent = recentIndex.get(b.item.id);
      if (aRecent !== undefined || bRecent !== undefined) {
        if (aRecent === undefined) return 1;
        if (bRecent === undefined) return -1;
        if (aRecent !== bRecent) return aRecent - bRecent;
      }
      return a.stableIndex - b.stableIndex;
    })
    .map(({ item }) => item);
}

/**
 * 将安装清单转换成列表卡片需要的最小字段。
 *
 * 这里刻意不加入安装量、使用量、认证徽章等旧原型字段;这些字段在 Ghost
 * runtime 中没有事实来源,页面不应继续展示伪数据。
 */
export function toGhostPluginListItem(
  ghost: InstalledGhost,
  origin: GhostPluginOrigin,
): GhostPluginListItem {
  const { manifest } = ghost;
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description ?? '',
    version: manifest.version,
    origin,
    enabled: ghost.enabled,
    canUse: Boolean(manifest.command),
    ...(ghost.iconDataUrl !== undefined ? { iconDataUrl: ghost.iconDataUrl } : {}),
  };
}

/** Adapts the existing builtin restore summary without inventing manifest facts. */
export function toRestorableGhostPluginListItem(ghost: RestorableGhostPlugin): GhostPluginListItem {
  return {
    id: ghost.id,
    name: ghost.name,
    description: ghost.description ?? '',
    version: ghost.version,
    origin: ghost.tier,
    enabled: false,
    canUse: false,
    ...(ghost.iconDataUrl !== undefined ? { iconDataUrl: ghost.iconDataUrl } : {}),
  };
}

/**
 * 详情页复用列表 adapter 的基础字段,再补充 manifest 明确声明的权限与工具。
 * 权限与详情卡共用 shared/ghost.ts 的纯推导函数,不在 renderer 复制规则。
 */
export function toGhostPluginDetail(
  ghost: InstalledGhost,
  origin: GhostPluginOrigin,
): GhostPluginDetail {
  const listItem = toGhostPluginListItem(ghost, origin);
  const { manifest } = ghost;
  return {
    ...listItem,
    installed: true,
    author: manifest.author ?? null,
    contents: ghostContentKeys(manifest),
    permissions: ghostPermissionItems(manifest),
    tools: manifest.tools ?? [],
    hasSettingsUi: Boolean(manifest.settingsHtml),
    cindyCapabilities: [
      ...(manifest.cindy?.image ?? []).map((action) => `image.${action}`),
      ...(manifest.cindy?.video ?? []).map((action) => `video.${action}`),
    ],
    panelMinWidth: manifest.panel ? (manifest.panel.minWidth ?? 280) : null,
    installDir: ghost.dir,
  };
}

/**
 * Builds removed bundled Plugin detail from its still-shipped, validated seed
 * manifest. Uninstall changes runtime/install state only; it does not erase
 * the package's declared configuration, Tools, permissions, or metadata.
 */
export function toRestorableGhostPluginDetail(ghost: RestorableGhostPlugin): GhostPluginDetail {
  const { manifest } = ghost;
  return {
    ...toRestorableGhostPluginListItem(ghost),
    installed: false,
    author: manifest.author ?? null,
    contents: ghostContentKeys(manifest),
    permissions: ghostPermissionItems(manifest),
    tools: manifest.tools ?? [],
    hasSettingsUi: Boolean(manifest.settingsHtml),
    cindyCapabilities: [
      ...(manifest.cindy?.image ?? []).map((action) => `image.${action}`),
      ...(manifest.cindy?.video ?? []).map((action) => `video.${action}`),
    ],
    panelMinWidth: manifest.panel ? (manifest.panel.minWidth ?? 280) : null,
    installDir: null,
  };
}
