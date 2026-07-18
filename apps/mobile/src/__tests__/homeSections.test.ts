import { describe, expect, it } from 'vitest';
import { buildGroupedHomeRows, buildHomeSections, buildMixedHomeRows } from '@/session/homeSections';
import type { MobileHomePresentation, MobileHomeProjectGroup } from '@/session/mobileHome';
import type { RemoteSessionListItem } from '@/session/sessionList';

// 最小 fixture:buildHomeSections / rows 只读取下面这几个字段,其余字段对本测试无关,
// 用 cast 避免构造完整 RemoteSessionListItem / MobileHomeProjectGroup。
function listItem(id: string, lastActivityAt: string): RemoteSessionListItem {
  return { session: { id }, lastActivityAt } as unknown as RemoteSessionListItem;
}

function projectGroup(
  key: string,
  latestActivityAt: string,
  sessions: RemoteSessionListItem[],
): MobileHomeProjectGroup {
  return { key, latestActivityAt, sessions, sessionCount: sessions.length } as unknown as MobileHomeProjectGroup;
}

function presentation(over: Partial<MobileHomePresentation>): MobileHomePresentation {
  return { pinned: [], chats: [], projects: [], ...over } as unknown as MobileHomePresentation;
}

describe('buildHomeSections', () => {
  it('置顶收起时保留分区但清空 data(表头照常渲染,只折叠下属会话)', () => {
    const home = presentation({
      pinned: [listItem('p1', '2026-06-02T00:00:00Z'), listItem('p2', '2026-06-01T00:00:00Z')],
      chats: [listItem('c1', '2026-06-03T00:00:00Z')],
    });

    const expanded = buildHomeSections(home, false, false);
    const pinnedExpanded = expanded.find((s) => s.key === 'pinned');
    expect(pinnedExpanded?.title).toBe('置顶');
    expect(pinnedExpanded?.data).toHaveLength(2);

    const collapsed = buildHomeSections(home, false, true);
    const pinnedCollapsed = collapsed.find((s) => s.key === 'pinned');
    expect(pinnedCollapsed).toBeDefined();
    expect(pinnedCollapsed?.title).toBe('置顶'); // 表头仍在
    expect(pinnedCollapsed?.data).toHaveLength(0); // 只清空下属会话
  });

  it('仅置顶且收起时,只有一个空 data 的置顶分区(对应 Home 的空态守卫)', () => {
    const home = presentation({ pinned: [listItem('p1', '2026-06-01T00:00:00Z')] });
    const sections = buildHomeSections(home, false, true);
    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe('pinned');
    expect(sections[0].data).toHaveLength(0);
  });

  it('无置顶时不产生置顶分区', () => {
    const home = presentation({ chats: [listItem('c1', '2026-06-01T00:00:00Z')] });
    const sections = buildHomeSections(home, false, false);
    expect(sections.find((s) => s.key === 'pinned')).toBeUndefined();
  });

  it('分组模式按桌面层级拆分数据,但不渲染项目 / 对话汇总表头', () => {
    const home = presentation({
      chats: [listItem('c1', '2026-06-01T00:00:00Z')],
      projects: [projectGroup('proj-a', '2026-06-02T00:00:00Z', [listItem('s1', '2026-06-02T00:00:00Z')])],
    });
    expect(buildHomeSections(home, false, false).find((s) => s.title === null)?.key).toBe('mixed');
    expect(buildHomeSections(home, true, false).map((s) => [s.key, s.title])).toEqual([
      ['projects', null],
      ['dialogue', null],
    ]);
  });
});

describe('buildMixedHomeRows / buildGroupedHomeRows', () => {
  const home = presentation({
    chats: [listItem('chat-old', '2026-06-01T00:00:00Z')],
    projects: [
      projectGroup('proj-new', '2026-06-05T00:00:00Z', [
        listItem('s1', '2026-06-05T00:00:00Z'),
        listItem('s2', '2026-06-04T00:00:00Z'),
      ]),
    ],
  });

  it('混排:项目下属会话展平为 session 行,按活动时间倒序', () => {
    const rows = buildMixedHomeRows(home);
    expect(rows.every((r) => r.kind === 'session')).toBe(true);
    // proj 的两条(06-05/06-04)比 chat(06-01)新 → 排在前
    expect(rows.map((r) => (r.kind === 'session' ? r.source : 'project'))).toEqual(['project', 'project', 'chat']);
  });

  it('分组:固定桌面层级,项目文件夹始终在普通对话之前', () => {
    const rows = buildGroupedHomeRows(home);
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toContain('project');
    expect(kinds).toContain('session');
    // 用户口头定稿:移动端跟 Mac 侧栏一致,分组模式不再按时间把普通对话插到项目上方。
    expect(rows[0].kind).toBe('project');
  });
});
