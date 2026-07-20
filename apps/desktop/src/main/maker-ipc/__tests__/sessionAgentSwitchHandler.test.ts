import { describe, expect, it, vi } from 'vitest';

import {
  applyPendingAgentSwitchIfIdle,
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
      return 'boundary-client-1';
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
      sdkSessionId: null,
    });
    const boundary = vi.mocked(deps.insertBoundaryMessage).mock.calls[0][1];
    expect(boundary.fromAgentKind).toBe('cc');
    expect(boundary.toAgentKind).toBe('codex');
    expect(boundary.fromModel).toBe('claude-fable-5');
    expect(boundary.toModel).toBe('gpt-5.5');
    expect(boundary.fromSdkSessionId).toBe('sdk-old');
    expect(boundary.resumed).toBe(false);
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

describe('deferred switch (turn running)', () => {
  function makeDepsWithPending(overrides: Partial<MakerSessionAgentSwitchHandlerDeps> = {}) {
    const base = makeDeps(overrides);
    const store = new Map<
      string,
      {
        targetAgentKind: 'claude-code' | 'codex';
        model: string;
        providerId: string | null | undefined;
        effort?: string;
        fastMode?: boolean;
      }
    >();
    base.deps.pendingSwitches = {
      set: (id, intent) => void store.set(id, intent),
      get: (id) => store.get(id),
      clear: (id) => void store.delete(id),
    };
    return { ...base, store };
  }

  it('turn 运行中登记 pending 并返回 deferred,不触碰任何状态', async () => {
    const { deps, calls, store } = makeDepsWithPending({
      getLiveSession: vi.fn(() => ({ isTurnRunning: () => true })),
    });
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result).toMatchObject({ switched: false, deferred: true, agentKind: 'codex', model: 'gpt-5.5' });
    expect(calls).toEqual([]);
    expect(store.get('s1')).toEqual({ targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });
  });

  it('意图制:空闲时外部调用同样只登记意图(不关引擎/不建交接/不插边界行)', async () => {
    const { deps, calls, store } = makeDepsWithPending();
    const result = await performSessionAgentSwitch(deps, {
      ...validParams,
      effort: 'xhigh',
      fastMode: true,
    });
    expect(result).toMatchObject({ switched: false, deferred: true });
    expect(calls).toEqual([]);
    expect(deps.listMessagesForHandoff).not.toHaveBeenCalled();
    expect(store.get('s1')).toEqual({
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: null,
      effort: 'xhigh',
      fastMode: true,
    });
  });

  it('意图制:反复改选只覆盖意图,applyNow 才执行真切换', async () => {
    const { deps, calls, store } = makeDepsWithPending();
    await performSessionAgentSwitch(deps, validParams);
    await performSessionAgentSwitch(deps, { ...validParams, model: 'gpt-5.5-codex' });
    expect(calls).toEqual([]);
    expect(store.get('s1')).toMatchObject({ model: 'gpt-5.5-codex' });
    const result = await performSessionAgentSwitch(deps, {
      ...validParams,
      model: 'gpt-5.5-codex',
      applyNow: true,
      skipBootstrap: true,
    });
    expect(result).toMatchObject({ switched: true });
    expect(calls).toEqual(['close', 'db', 'boundary', 'pending']);
  });

  it('意图制:effort/fastMode 经意图透传到 applyAgentSwitchToDb', async () => {
    const { deps, store } = makeDepsWithPending();
    store.set('s1', {
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'openai',
      effort: 'high',
      fastMode: true,
    });
    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', {
      agentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'openai',
      sdkSessionId: null,
      effort: 'high',
      fastMode: true,
    });
  });

  it('同引擎 no-op 清除已登记的 pending(用户改主意)', async () => {
    const { deps, store } = makeDepsWithPending();
    store.set('s1', { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });
    await performSessionAgentSwitch(deps, { ...validParams, targetAgentKind: 'claude-code', model: 'claude-sonnet-5' });
    expect(store.has('s1')).toBe(false);
  });

  it('applyPendingAgentSwitchIfIdle:空闲时清 pending 并执行切换(skipBootstrap)', async () => {
    const { deps, calls, store } = makeDepsWithPending();
    store.set('s1', { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: 'openai' });
    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(store.has('s1')).toBe(false);
    // skipBootstrap:不含 'bootstrap'
    expect(calls).toEqual(['close', 'db', 'boundary', 'pending']);
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', {
      agentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'openai',
      sdkSessionId: null,
    });
  });

  it('applyPendingAgentSwitchIfIdle:turn 仍在跑时保留 pending 本次不动', async () => {
    const { deps, calls, store } = makeDepsWithPending({
      getLiveSession: vi.fn(() => ({ isTurnRunning: () => true })),
    });
    store.set('s1', { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });
    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(store.has('s1')).toBe(true);
    expect(calls).toEqual([]);
  });

  it('applyPendingAgentSwitchIfIdle:无 pending 时 no-op', async () => {
    const { deps, calls } = makeDepsWithPending();
    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(calls).toEqual([]);
  });

  it('applyPendingAgentSwitchIfIdle:执行失败吞掉不抛(不阻塞发送),pending 已清', async () => {
    const { deps, store } = makeDepsWithPending({
      applyAgentSwitchToDb: vi.fn(async () => {
        throw new Error('db locked');
      }),
    });
    store.set('s1', { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });
    await expect(applyPendingAgentSwitchIfIdle(deps, 's1')).resolves.toBeUndefined();
    expect(store.has('s1')).toBe(false);
    expect(deps.log.warn).toHaveBeenCalled();
  });
});

describe('Phase 2:切回停泊引擎(resume + 增量交接)', () => {
  const parked = { sdkSessionId: 'sdk-parked-codex', watermarkCreatedAt: 100, watermarkRowid: 7 };

  function makeResumeDeps(overrides: Partial<MakerSessionAgentSwitchHandlerDeps> = {}) {
    return makeDeps({
      findParkedEngineSession: vi.fn(async () => parked),
      listMessagesForHandoff: vi.fn(async (_sessionId: string, after?: { createdAt: number; rowid: number }) =>
        after
          ? [{ role: 'user', content: '离开期间的问题', createdAt: 200 }]
          : [
              { role: 'user', content: '最早的问题', createdAt: 1 },
              { role: 'tool_use', content: { toolUseId: 't1', toolName: 'Edit', input: { file_path: '/repo/a.ts' } }, createdAt: 2 },
              { role: 'user', content: '离开期间的问题', createdAt: 200 },
            ],
      ),
      updateBoundaryMessage: vi.fn(async () => {}),
      ...overrides,
    });
  }

  it('有停泊绑定:DB 落停泊 id、交接为增量模式、边界行标 resumed', async () => {
    const { deps } = makeResumeDeps();
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result).toMatchObject({ switched: true, engineReady: true });
    expect(deps.findParkedEngineSession).toHaveBeenCalledWith('s1', 'codex');
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', {
      agentKind: 'codex',
      model: 'gpt-5.5',
      providerId: null,
      sdkSessionId: 'sdk-parked-codex',
    });
    // 增量素材按水位线取
    expect(deps.listMessagesForHandoff).toHaveBeenCalledWith('s1', {
      createdAt: 100,
      rowid: 7,
    });
    const boundary = vi.mocked(deps.insertBoundaryMessage).mock.calls[0][1];
    expect(boundary.resumed).toBe(true);
    // 增量 framing(归位续接),且工作状态区来自全量历史
    expect(boundary.handoff).toContain('切回由你继续');
    expect(boundary.handoff).toContain('- /repo/a.ts');
    expect(boundary.handoff).not.toContain('最早的问题');
    expect(boundary.handoff).toContain('离开期间的问题');
  });

  it('无停泊绑定(查询返回 null):v1 全量行为不变', async () => {
    const { deps } = makeResumeDeps({ findParkedEngineSession: vi.fn(async () => null) });
    await performSessionAgentSwitch(deps, validParams);
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ sdkSessionId: null }),
    );
    const boundary = vi.mocked(deps.insertBoundaryMessage).mock.calls[0][1];
    expect(boundary.resumed).toBe(false);
    expect(boundary.handoff).toContain('最早的问题');
  });

  it('resume 模式无视 skipBootstrap:pending-apply 路径也 eager spawn(回落窗口)', async () => {
    const { deps, calls } = makeResumeDeps();
    await performSessionAgentSwitch(deps, { ...validParams, skipBootstrap: true });
    expect(calls).toContain('bootstrap');
  });

  it('resume bootstrap 失败:清停泊 id → 边界行改写全量交接 → fresh 重试成功', async () => {
    const bootstrap = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error('resume transcript missing'));
    const { deps } = makeResumeDeps({ bootstrapSwitchedSession: bootstrap });
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result).toMatchObject({ switched: true, engineReady: true });
    // 第二次 applyAgentSwitchToDb 清掉失效停泊 id
    expect(vi.mocked(deps.applyAgentSwitchToDb).mock.calls[1][1]).toMatchObject({
      sdkSessionId: null,
    });
    // 边界行改写为全量交接 + resumed:false
    const rewritten = vi.mocked(deps.updateBoundaryMessage!).mock.calls[0];
    expect(rewritten[1]).toBe('boundary-client-1');
    expect(rewritten[2].resumed).toBe(false);
    expect(rewritten[2].handoff).toContain('最早的问题');
    // pending 最终是全量交接
    const lastPending = vi.mocked(deps.setPendingHandoff).mock.calls.at(-1)![1];
    expect(lastPending).toContain('最早的问题');
    expect(bootstrap).toHaveBeenCalledTimes(2);
  });

  it('resume 回落中清停泊 id 失败:不再重试 spawn,engineReady=false', async () => {
    const bootstrap = vi.fn(async () => {
      throw new Error('resume transcript missing');
    });
    const applyDb = vi
      .fn(async () => {})
      .mockResolvedValueOnce(undefined) // 首次提交成功
      .mockRejectedValueOnce(new Error('db locked')); // 回落清 id 失败
    const { deps } = makeResumeDeps({
      bootstrapSwitchedSession: bootstrap,
      applyAgentSwitchToDb: applyDb,
    });
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result).toMatchObject({ switched: true, engineReady: false });
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it('resume 两段 bootstrap 都失败:engineReady=false,pending 为全量交接', async () => {
    const bootstrap = vi.fn(async () => {
      throw new Error('spawn failed');
    });
    const { deps } = makeResumeDeps({ bootstrapSwitchedSession: bootstrap });
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result).toMatchObject({ switched: true, engineReady: false });
    expect(bootstrap).toHaveBeenCalledTimes(2);
    const lastPending = vi.mocked(deps.setPendingHandoff).mock.calls.at(-1)![1];
    expect(lastPending).toContain('最早的问题');
  });
});
