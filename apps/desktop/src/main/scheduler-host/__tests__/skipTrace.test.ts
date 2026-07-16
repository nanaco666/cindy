/**
 * skip-trace 承载会话选择回归:
 *   - 绑定会话空闲 → 直接复用(跳过记录与真实运行同时间线);
 *   - 绑定会话正在跑 turn(busy)→ 不往直播对话里插合成消息,回落
 *     skipLogSessionId / 新建专属留痕会话(PR #608 review thread:
 *     Defer skip logging while bound session is busy)。
 *
 * @vitest-environment node
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
  getSessionRowSnapshot: vi.fn(),
  sessionCreateToRow: vi.fn(() => ({})),
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => ({})) }));
vi.mock('../../localDb/schema', () => ({ sessions: { id: 'sessions.id' } }));
vi.mock('../../localDb/mapper', () => ({ sessionCreateToRow: mocks.sessionCreateToRow }));
vi.mock('../../localDb/ipc/messages.js', () => ({ createMessage: mocks.createMessage }));
vi.mock('../../localDb/ipc/sessions.js', () => ({
  getSessionRowSnapshot: mocks.getSessionRowSnapshot,
  touchUserSendInDb: vi.fn().mockResolvedValue(undefined),
}));

import { recordScheduleSkip } from '../skip-trace';
import type { SkipTraceDeps } from '../skip-trace';

const hookResult = {
  decision: 'skip',
  exitCode: 2,
  timedOut: false,
  aborted: false,
  durationMs: 5,
  stdout: 'no new PR',
  stderr: '',
} as never;

function makeDeps(overrides: Partial<SkipTraceDeps> = {}) {
  const insertValues = vi.fn(async () => undefined);
  const insert = vi.fn(() => ({ values: insertValues }));
  const update = vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) }));
  const bindSkipLogSession = vi.fn(async () => undefined);
  const deps: SkipTraceDeps = {
    getDb: () => ({ insert, update }) as never,
    logger: { warn: vi.fn(), info: vi.fn() } as never,
    bindSkipLogSession,
    ...overrides,
  };
  return { deps, insert, bindSkipLogSession };
}

function makeSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sch-1',
    name: 'PR 巡检',
    workingDir: '/repo',
    workspaceKind: 'project',
    agentKind: 'claude-code',
    preRunHook: { command: 'node scripts/check.mjs' },
    notify: { desktop: true, feishu: false },
    ...overrides,
  } as never;
}

const ctx = { runId: 'run-1', firedAt: 1_700_000_000_000 };

describe('recordScheduleSkip 承载会话选择', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createMessage.mockResolvedValue(undefined);
    mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active' });
  });

  it('绑定会话空闲 → 直接复用 targetSessionId', async () => {
    const { deps, insert } = makeDeps({ isSessionBusy: () => false });
    const sessionId = await recordScheduleSkip(
      deps,
      makeSchedule({ targetSessionId: 'sess-bound' }),
      ctx,
      hookResult,
    );
    expect(sessionId).toBe('sess-bound');
    expect(mocks.createMessage).toHaveBeenCalledWith('sess-bound', expect.anything());
    expect(insert).not.toHaveBeenCalled();
  });

  it('绑定会话正在跑 turn → 不插直播对话,新建专属留痕会话并回写绑定', async () => {
    const { deps, insert, bindSkipLogSession } = makeDeps({
      isSessionBusy: (id) => id === 'sess-bound',
    });
    const sessionId = await recordScheduleSkip(
      deps,
      makeSchedule({ targetSessionId: 'sess-bound' }),
      ctx,
      hookResult,
    );
    expect(sessionId).toBeDefined();
    expect(sessionId).not.toBe('sess-bound');
    expect(insert).toHaveBeenCalledTimes(1);
    expect(bindSkipLogSession).toHaveBeenCalledWith('sch-1', sessionId);
    expect(mocks.createMessage).toHaveBeenCalledWith(sessionId, expect.anything());
  });

  it('绑定会话 busy 但已有专属留痕会话 → 复用 skipLogSessionId', async () => {
    const { deps, insert } = makeDeps({ isSessionBusy: (id) => id === 'sess-bound' });
    const sessionId = await recordScheduleSkip(
      deps,
      makeSchedule({ targetSessionId: 'sess-bound', skipLogSessionId: 'sess-trace' }),
      ctx,
      hookResult,
    );
    expect(sessionId).toBe('sess-trace');
    expect(insert).not.toHaveBeenCalled();
  });
});
