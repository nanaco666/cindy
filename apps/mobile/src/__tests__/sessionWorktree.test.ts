import { describe, expect, it } from 'vitest';
import { sessionWorktreeInfo, sessionWorktreeLabel } from '@/session/sessionWorktree';

describe('session worktree display', () => {
  it('extracts a stable worktree label from macOS and Windows paths', () => {
    expect(sessionWorktreeInfo({ worktreePath: '/repo/app/.xdt-worktrees/feat-mobile' })).toEqual({
      path: '/repo/app/.xdt-worktrees/feat-mobile',
      name: 'feat-mobile',
    });
    expect(sessionWorktreeLabel({ worktreePath: 'D:\\repo\\.xdt-worktrees\\feat-win\\' })).toBe('Worktree feat-win');
  });

  it('omits empty worktree state', () => {
    expect(sessionWorktreeInfo({ worktreePath: null })).toBeNull();
    expect(sessionWorktreeLabel({ worktreePath: '  ' })).toBeNull();
  });
});
