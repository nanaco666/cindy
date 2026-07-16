import type { MobileHomePresentation, MobileHomeProjectGroup } from './mobileHome';
import type { RemoteSessionListItem } from './sessionList';

/** 首页列表的一行:项目分组头,或一条会话(置顶 / 普通 / 项目内)。 */
export type HomeRow =
  | { key: string; kind: 'project'; project: MobileHomeProjectGroup }
  | { key: string; kind: 'session'; item: RemoteSessionListItem; source: 'chat' | 'pinned' | 'project' };

/** SectionList 的一个分区。title 为 null 的分区不渲染表头。 */
export type HomeSection = { data: HomeRow[]; key: string; title: string | null };

/**
 * 把 home 展示模型拆成 SectionList 的分区(纯函数,便于单测)。
 * - 置顶单独成区;`pinnedCollapsed` 时清空 data 但**保留分区**(SectionList 对空 data 仍渲染
 *   表头,所以折叠时表头照常显示,只折叠下属会话)。
 * - 其余按 `groupByProject` 走分组(项目成组)或混排(项目展平为行),均按活动时间倒序。
 */
export function buildHomeSections(
  home: MobileHomePresentation,
  groupByProject: boolean,
  pinnedCollapsed: boolean,
): HomeSection[] {
  const sections: HomeSection[] = [];
  if (home.pinned.length > 0) {
    sections.push({
      data: pinnedCollapsed
        ? []
        : home.pinned.map((item) => ({ item, key: `pinned:${item.session.id}`, kind: 'session', source: 'pinned' })),
      key: 'pinned',
      title: '置顶',
    });
  }

  const rows = groupByProject ? buildGroupedHomeRows(home) : buildMixedHomeRows(home);
  if (rows.length > 0) {
    sections.push({
      data: rows,
      key: groupByProject ? 'grouped' : 'mixed',
      title: null,
    });
  }
  return sections;
}

/** 混排模式:chats + 各项目下属会话全部展平为会话行,按活动时间倒序。 */
export function buildMixedHomeRows(home: MobileHomePresentation): HomeRow[] {
  return [
    // 自动化组行用组 key(组内 primary 会变,session.id 不稳定;组 key 稳定才能保住展开态与 diff)。
    ...home.chats.map((item) => ({ item, key: `chat:${item.automationGroup?.key ?? item.session.id}`, kind: 'session' as const, source: 'chat' as const })),
    ...home.projects.flatMap((project) =>
      project.sessions.map((item) => ({
        item,
        key: `project:${project.key}:${item.automationGroup?.key ?? item.session.id}`,
        kind: 'session' as const,
        source: 'project' as const,
      })),
    ),
  ].sort(compareHomeRowsByActivityDesc);
}

/** 分组模式:chats 为会话行 + 每个项目为一个 project 行,按活动时间倒序。 */
export function buildGroupedHomeRows(home: MobileHomePresentation): HomeRow[] {
  return [
    ...home.chats.map((item) => ({ item, key: `chat:${item.automationGroup?.key ?? item.session.id}`, kind: 'session' as const, source: 'chat' as const })),
    ...home.projects.map((project) => ({ key: project.key, kind: 'project' as const, project })),
  ].sort(compareHomeRowsByActivityDesc);
}

function compareHomeRowsByActivityDesc(a: HomeRow, b: HomeRow): number {
  return homeRowActivity(b).localeCompare(homeRowActivity(a));
}

function homeRowActivity(row: HomeRow): string {
  return row.kind === 'project' ? row.project.latestActivityAt : row.item.lastActivityAt;
}
