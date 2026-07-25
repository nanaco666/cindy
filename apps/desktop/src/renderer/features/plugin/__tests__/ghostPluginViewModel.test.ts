/**
 * Regression coverage for the Plugin list view-model helpers, focused on the
 * membership-gated "团队共享"(enterprise) group visibility.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { describe, expect, it } from 'vitest';

import {
  showsEnterpriseGhostGroup,
  visibleGhostPluginItems,
  type GhostPluginListItem,
} from '../lib/ghostPluginViewModel';

function item(id: string, origin: GhostPluginListItem['origin']): GhostPluginListItem {
  return {
    id,
    name: id,
    description: '',
    version: '1.0.0',
    origin,
    enabled: true,
    canUse: true,
  };
}

describe('showsEnterpriseGhostGroup', () => {
  it('shows the enterprise group only for org membership', () => {
    expect(showsEnterpriseGhostGroup('org')).toBe(true);
    expect(showsEnterpriseGhostGroup('personal')).toBe(false);
  });

  it('fails closed when the login identity is missing', () => {
    expect(showsEnterpriseGhostGroup(undefined)).toBe(false);
  });
});

describe('visibleGhostPluginItems', () => {
  const items = [item('cindy-art', 'builtin'), item('xd-feishu', 'enterprise'), item('my-pack', 'external')];

  it('drops enterprise entries when the group is hidden', () => {
    expect(visibleGhostPluginItems(items, false).map((i) => i.id)).toEqual([
      'cindy-art',
      'my-pack',
    ]);
  });

  it('keeps every entry, order intact, when the group is visible', () => {
    expect(visibleGhostPluginItems(items, true).map((i) => i.id)).toEqual([
      'cindy-art',
      'xd-feishu',
      'my-pack',
    ]);
  });
});
