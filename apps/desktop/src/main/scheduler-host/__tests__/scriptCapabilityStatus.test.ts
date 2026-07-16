import { describe, expect, it } from 'vitest';

import { resolveScriptCapabilityStatuses } from '../script-capability-status';

describe('resolveScriptCapabilityStatuses', () => {
  it('marks jira capabilities ok when xd-atlassian is installed and awake', () => {
    const statuses = resolveScriptCapabilityStatuses([
      { id: 'xd-atlassian', name: 'XD Atlassian', enabled: true },
    ]);
    expect(statuses).toEqual([
      { capability: 'jira.read', state: 'ok' },
      { capability: 'jira.comment', state: 'ok' },
      { capability: 'sessions.dispatch', state: 'ok' },
      { capability: 'feishu.read', state: 'ok' },
    ]);
  });

  it('marks jira capabilities ghost-asleep when the ghost is disabled', () => {
    const statuses = resolveScriptCapabilityStatuses([
      { id: 'xd-atlassian', name: 'XD Atlassian', enabled: false },
    ]);
    expect(statuses.find((s) => s.capability === 'jira.read')).toEqual({
      capability: 'jira.read',
      state: 'ghost-asleep',
      ghostName: 'XD Atlassian',
    });
    // host 原生能力不受意识状态影响
    expect(statuses.find((s) => s.capability === 'sessions.dispatch')?.state).toBe('ok');
  });

  it('marks jira capabilities ghost-missing (name falls back to id) when not installed', () => {
    const statuses = resolveScriptCapabilityStatuses([]);
    expect(statuses.find((s) => s.capability === 'jira.comment')).toEqual({
      capability: 'jira.comment',
      state: 'ghost-missing',
      ghostName: 'xd-atlassian',
    });
  });
});
