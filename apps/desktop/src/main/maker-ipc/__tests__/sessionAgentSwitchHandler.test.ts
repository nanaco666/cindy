import { describe, expect, it, vi } from 'vitest';

import {
  performSessionAgentSwitch,
  type AgentSwitchSessionRow,
  type MakerSessionAgentSwitchHandlerDeps,
} from '../sessionAgentSwitchHandler';

function makeRow(overrides: Partial<AgentSwitchSessionRow> = {}): AgentSwitchSessionRow {
  return {
    id: 's1',
    agentKind: 'cc',
    model: 'claude-fable-5',
    status: 'active',
    remoteHostId: null,
    orcaRole: null,
    sdkSessionId: 'sdk-old',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<MakerSessionAgentSwitchHandlerDeps> = {}): {
  deps: MakerSessionAgentSwitchHandlerDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const deps: MakerSessionAgentSwitchHandlerDeps = {
    getSessionRow: vi.fn(async () => makeRow()),
    getLiveSession: vi.fn(() => ({ isTurnRunning: () => false })),
    closeSession: vi.fn(async () => {
      calls.push('close');
    }),
    listMessagesForHandoff: vi.fn(async () => [
      { role: 'user', content: '你好', createdAt: 1 },
      { role: 'assistant', content: '你好!', createdAt: 2 },
    ]),
    applyAgentSwitchToDb: vi.fn(async () => {
      calls.push('db');
    }),
    insertBoundaryMessage: vi.fn(async () => {
      calls.push('boundary');
    }),
    setPendingHandoff: vi.fn(() => {
      calls.push('pending');
    }),
    bootstrapSwitchedSession: vi.fn(async () => {
      calls.push('bootstrap');
    }),
    withCloseSuppressed: vi.fn((_sessionId, fn) => fn()),
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
  return { deps, calls };
}

const validParams = {
  sessionId: 's1',
  targetAgentKind: 'codex',
  model: 'gpt-5.5',
  providerId: null,
};

describe('performSessionAgentSwitch', () => {
  it('happy path:close → DB 提交 → 边界行 → pending → bootstrap,顺序正确', async () => {
    const { deps, calls } = makeDeps();
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result).toEqual({ switched: true, agentKind: 'codex', model: 'gpt-5.5', engineReady: true });
    expect(calls).toEqual(['close', 'db', 'boundary', 'pending', 'bootstrap']);
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', {
      agentKind: 'codex',
      model: 'gpt-5.5',
      providerId: null,
    });
    const boundary = vi.mocked(deps.insertBoundaryMessage).mock.calls[0][1];
    expect(boundary.fromAgentKind).toBe('cc');
    expect(boundary.toAgentKind).toBe('codex');
    expect(boundary.fromModel).toBe('claude-fable-5');
    expect(boundary.toModel).toBe('gpt-5.5');
    expect(boundary.fromSdkSessionId).toBe('sdk-old');
    expect(boundary.handoff).toContain('Claude Code');
    // close→bootstrap 全程在抑制窗口内(切换的瞬态 close 不得触发 worktree 回收)
    expect(deps.withCloseSuppressed).toHaveBeenCalledTimes(1);
  });

  it('codex → claude-code 方向同样工作', async () => {
    const { deps } = makeDeps({
      getSessionRow: vi.fn(async () => makeRow({ agentKind: 'codex', model: 'gpt-5.5' })),
    });
    const result = await performSessionAgentSwitch(deps, {
      sessionId: 's1',
      targetAgentKind: 'claude-code',
      model: 'claude-fable-5',
    });
    expect(result.switched).toBe(true);
    const boundary = vi.mocked(deps.insertBoundaryMessage).mock.calls[0][1];
    expect(boundary.fromAgentKind).toBe('codex');
    expect(boundary.toAgentKind).toBe('cc');
  });

  it('参数校验:非法 sessionId / targetAgentKind / model 抛 INVALID_PARAMS', async () => {
    const { deps } = makeDeps();
    await expect(performSessionAgentSwitch(deps, { ...validParams, sessionId: 7 })).rejects.toThrow(/INVALID_PARAMS/);
    await expect(
      performSessionAgentSwitch(deps, { ...validParams, targetAgentKind: 'gemini' }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    await expect(performSessionAgentSwitch(deps, { ...validParams, model: '' })).rejects.toThrow(/INVALID_PARAMS/);
  });

  it('会话不存在或已删除抛 NOT_FOUND', async () => {
    const missing = makeDeps({ getSessionRow: vi.fn(async () => null) });
    await expect(performSessionAgentSwitch(missing.deps, validParams)).rejects.toThrow(/NOT_FOUND/);
    const deleted = makeDeps({ getSessionRow: vi.fn(async () => makeRow({ status: 'deleted' })) });
    await expect(performSessionAgentSwitch(deleted.deps, validParams)).rejects.toThrow(/NOT_FOUND/);
  });

  it('远程会话与 Orca 会话抛 UNSUPPORTED_CAPABILITY', async () => {
    const remote = makeDeps({ getSessionRow: vi.fn(async () => makeRow({ remoteHostId: 'host-1' })) });
    await expect(performSessionAgentSwitch(remote.deps, validParams)).rejects.toThrow(/UNSUPPORTED_CAPABILITY/);
    const orca = makeDeps({ getSessionRow: vi.fn(async () => makeRow({ orcaRole: 'lead' })) });
    await expect(performSessionAgentSwitch(orca.deps, validParams)).rejects.toThrow(/UNSUPPORTED_CAPABILITY/);
  });

  it('同引擎目标 = no-op 成功,不发生任何状态变更', async () => {
    const { deps, calls } = makeDeps();
    const result = await performSessionAgentSwitch(deps, {
      ...validParams,
      targetAgentKind: 'claude-code',
      model: 'claude-sonnet-5',
    });
    expect(result.switched).toBe(false);
    expect(calls).toEqual([]);
  });

  it('turn 进行中抛 SESSION_RUNNING,不触碰任何状态', async () => {
    const { deps, calls } = makeDeps({
      getLiveSession: vi.fn(() => ({ isTurnRunning: () => true })),
    });
    await expect(performSessionAgentSwitch(deps, validParams)).rejects.toThrow(/SESSION_RUNNING/);
    expect(calls).toEqual([]);
  });

  it('无 live session 时跳过 close,其余照常', async () => {
    const { deps, calls } = makeDeps({ getLiveSession: vi.fn(() => null) });
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result.switched).toBe(true);
    expect(calls).toEqual(['db', 'boundary', 'pending', 'bootstrap']);
  });

  it('边界行插入失败降级:仍设 pending 并 bootstrap,返回成功', async () => {
    const { deps, calls } = makeDeps({
      insertBoundaryMessage: vi.fn(async () => {
        throw new Error('db write failed');
      }),
    });
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result.switched).toBe(true);
    expect(calls).toEqual(['close', 'db', 'pending', 'bootstrap']);
    expect(deps.log.warn).toHaveBeenCalled();
  });

  it('bootstrap 失败返回 engineReady=false(切换已提交,下一条消息 lazy-create 重试)', async () => {
    const { deps } = makeDeps({
      bootstrapSwitchedSession: vi.fn(async () => {
        throw new Error('spawn failed');
      }),
    });
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result).toMatchObject({ switched: true, engineReady: false });
    expect(deps.setPendingHandoff).toHaveBeenCalled();
  });

  it('DB 提交失败原样抛出,不插边界行、不设 pending', async () => {
    const { deps, calls } = makeDeps({
      applyAgentSwitchToDb: vi.fn(async () => {
        throw new Error('db locked');
      }),
    });
    await expect(performSessionAgentSwitch(deps, validParams)).rejects.toThrow('db locked');
    expect(calls).toEqual(['close']);
  });
});
