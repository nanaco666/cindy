import type { AgentKind, SessionSendResult, UserMessage } from '@lizi/maker-core';
import { describe, expect, it, vi } from 'vitest';
import {
  createMakerSendTransaction,
  type MakerSendTransactionDeps,
  type MakerSendTransactionSession,
} from '../makerSendTransaction';
import type { MakerSessionCreateOpts } from '../sessionRequest';
import { CredentialModeSwitchBusyError } from '../../maker-host/codex-credential-switch';

function createSession(overrides: Partial<MakerSendTransactionSession> = {}): MakerSendTransactionSession {
  return {
    id: 'session-1',
    agentKind: 'codex',
    workDir: 'C:\\repo',
    remoteHostId: null,
    isTurnRunning: vi.fn(() => false),
    send: vi.fn(async (_message: UserMessage | string, opts?: { onAccepted?: () => Promise<void> }) => {
      await opts?.onAccepted?.();
      return { accepted: true } satisfies SessionSendResult;
    }),
    ...overrides,
  };
}

function createDeps(overrides: Partial<MakerSendTransactionDeps> = {}) {
  const session = createSession();
  const deps: MakerSendTransactionDeps = {
    getSession: vi.fn((sessionId: string) => (sessionId === session.id ? session : undefined)),
    closeSession: vi.fn(async () => {}),
    getSessionMeta: vi.fn(async () => ({ title: '现有会话' })),
    ensureRemoteReadyForSessionStart: vi.fn(async () => {}),
    checkWorkDirExists: vi.fn(async () => true),
    isOrcaMcpHydrated: vi.fn(() => true),
    buildCreateOptsWithStderr: vi.fn((opts: MakerSessionCreateOpts) => opts),
    synthesizeOrcaVendorOptionsFromDb: vi.fn(async () => false),
    readSessionExtraDirsFromDb: vi.fn(async () => []),
    readSessionWorkingDirFromDb: vi.fn(async () => null),
    withRehydrateCloseSuppressed: vi.fn(async (_sessionId, fn) => await fn()),
    bootstrapSession: vi.fn(async (opts: MakerSessionCreateOpts) => ({
      session: createSession({
        id: opts.id ?? session.id,
        agentKind: opts.agentKind as AgentKind,
        workDir: opts.workingDir,
        remoteHostId: opts.remoteHostId ?? null,
      }),
      didInjectOrcaInstructions: false,
      didInjectProjectContext: false,
    })),
    markOrcaRoleIfNeeded: vi.fn(async () => {}),
    broadcastSessionCreated: vi.fn(),
    prepareSendUserMessage: vi.fn(async (_sessionId, message) => message as UserMessage | string),
    createDbMessage: vi.fn(async () => {}),
    previewUserPrompt: vi.fn(),
    commitUserPromptPreview: vi.fn(),
    rollbackUserPromptPreview: vi.fn(),
    isSessionRunningError: vi.fn(() => false),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
  return { deps, session };
}

describe('maker SEND transaction', () => {
  it('rejects invalid sessionId before touching transaction dependencies', async () => {
    const { deps } = createDeps();
    const transaction = createMakerSendTransaction(deps);

    await expect(transaction.sendToAgentAccepted(undefined, 'hello')).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(deps.ensureRemoteReadyForSessionStart).not.toHaveBeenCalled();
  });

  it('sends to an existing session and persists the user message in the accepted hook', async () => {
    const beforeDispatchDirectUserTurn = vi.fn();
    const { deps, session } = createDeps({ beforeDispatchDirectUserTurn });
    const transaction = createMakerSendTransaction(deps);
    const shouldBroadcast = vi.fn(() => true);
    const onPersisting = vi.fn();
    const onPersisted = vi.fn();

    await expect(
      transaction.sendToAgentAccepted(
        'session-1',
        { type: 'user', content: 'hello' },
        undefined,
        {
          messageUuid: 'message-uuid',
          userName: 'Lizi',
          persistUserMessage: {
            clientId: 'client-1',
            content: 'hello',
            sdkSessionId: 'sdk-1',
            delivery: 'turn',
            shouldBroadcast,
            onPersisting,
            onPersisted,
          },
        },
      ),
    ).resolves.toEqual({
      accepted: true,
      outcome: { kind: 'session-dispatch', source: 'maker-ipc', dispatched: true },
    });

    expect(deps.ensureRemoteReadyForSessionStart).toHaveBeenCalledWith({ session, createOpts: undefined });
    expect(deps.prepareSendUserMessage).toHaveBeenCalledWith('session-1', { type: 'user', content: 'hello' });
    expect(session.send).toHaveBeenCalledWith(
      { type: 'user', content: 'hello' },
      expect.objectContaining({
        logTitle: '现有会话',
        messageUuid: 'message-uuid',
        userName: 'Lizi',
      }),
    );
    expect(onPersisting).toHaveBeenCalled();
    expect(beforeDispatchDirectUserTurn).not.toHaveBeenCalled();
    expect(deps.previewUserPrompt).toHaveBeenCalledWith(
      session,
      'hello',
      {
        source: 'maker_send:onPersisting',
        clientId: 'client-1',
      },
    );
    expect(deps.createDbMessage).toHaveBeenCalledWith(
      'session-1',
      {
        clientId: 'client-1',
        role: 'user',
        content: 'hello',
        agentMeta: {
          uuid: 'message-uuid',
          sdkSessionId: 'sdk-1',
          delivery: 'turn',
        },
      },
      { shouldBroadcast },
    );
    expect(onPersisted).toHaveBeenCalled();
    expect(deps.commitUserPromptPreview).toHaveBeenCalledWith('session-1', 'client-1');
    expect(deps.rollbackUserPromptPreview).not.toHaveBeenCalled();
  });

  it('threads scheduler origin into session.send opts and persisted agentMeta', async () => {
    // scheduler 排队消息经 coordinator drain 透传 origin(见 AgentInputSendOpts.origin):
    // 既打到本轮 turnOrigin(session.send opts),也合进落库 agentMeta(自动化标签)。
    const { deps, session } = createDeps();
    const transaction = createMakerSendTransaction(deps);
    const origin = { kind: 'scheduler', scheduleId: 'sch-1', scheduleName: 'PR 心跳' } as const;

    await transaction.sendToAgentAccepted(
      'session-1',
      { type: 'user', content: 'hb prompt' },
      undefined,
      {
        messageUuid: 'message-uuid',
        origin,
        persistUserMessage: {
          clientId: 'client-1',
          content: 'hb prompt',
          sdkSessionId: 'sdk-1',
          delivery: 'turn',
        },
      },
    );

    expect(session.send).toHaveBeenCalledWith(
      { type: 'user', content: 'hb prompt' },
      expect.objectContaining({ origin }),
    );
    expect(deps.createDbMessage).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        agentMeta: expect.objectContaining({ origin }),
      }),
      undefined,
    );
  });

  it('awaits the direct-send baseline hook before vendor dispatch', async () => {
    const events: string[] = [];
    const beforeDispatchDirectUserTurn = vi.fn(async () => {
      events.push('baseline');
    });
    const session = createSession({
      send: vi.fn(async () => {
        events.push('send');
        return { accepted: true } satisfies SessionSendResult;
      }),
    });
    const { deps } = createDeps({
      getSession: vi.fn(() => session),
      beforeDispatchDirectUserTurn,
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(transaction.sendToAgentAccepted('session-1', 'hello')).resolves.toMatchObject({
      accepted: true,
    });

    expect(events).toEqual(['baseline', 'send']);
    expect(beforeDispatchDirectUserTurn).toHaveBeenCalledWith('session-1');
  });

  it('consumes the direct-send baseline when vendor dispatch is not accepted', async () => {
    const beforeDispatchDirectUserTurn = vi.fn(async () => {});
    const onUndispatchedDirectUserTurn = vi.fn();
    const session = createSession({
      send: vi.fn(async () => (
        { accepted: false, reason: 'cancelled-before-dispatch' } satisfies SessionSendResult
      )),
    });
    const { deps } = createDeps({
      getSession: vi.fn(() => session),
      beforeDispatchDirectUserTurn,
      onUndispatchedDirectUserTurn,
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(transaction.sendToAgentAccepted('session-1', 'hello')).resolves.toMatchObject({
      accepted: false,
      reason: 'cancelled-before-dispatch',
    });

    expect(beforeDispatchDirectUserTurn).toHaveBeenCalledWith('session-1');
    expect(onUndispatchedDirectUserTurn).toHaveBeenCalledWith('session-1');
  });

  it('consumes the direct-send baseline when vendor dispatch throws before acceptance', async () => {
    const beforeDispatchDirectUserTurn = vi.fn(async () => {});
    const onUndispatchedDirectUserTurn = vi.fn();
    const session = createSession({
      send: vi.fn(async () => {
        throw new Error('start failed');
      }),
    });
    const { deps } = createDeps({
      getSession: vi.fn(() => session),
      beforeDispatchDirectUserTurn,
      onUndispatchedDirectUserTurn,
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(transaction.sendToAgentAccepted('session-1', 'hello')).rejects.toThrow('start failed');

    expect(beforeDispatchDirectUserTurn).toHaveBeenCalledWith('session-1');
    expect(onUndispatchedDirectUserTurn).toHaveBeenCalledWith('session-1');
  });

  it('rolls back the prompt preview if accepted persistence fails before dispatch', async () => {
    const { deps, session } = createDeps({
      createDbMessage: vi.fn(async () => {
        throw new Error('write failed');
      }),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted(
        'session-1',
        { type: 'user', content: 'hello' },
        undefined,
        {
          persistUserMessage: {
            clientId: 'client-1',
            content: 'hello',
          },
        },
      ),
    ).rejects.toThrow('write failed');

    expect(session.send).toHaveBeenCalled();
    expect(deps.previewUserPrompt).toHaveBeenCalledWith(
      session,
      'hello',
      {
        source: 'maker_send:onPersisting',
        clientId: 'client-1',
      },
    );
    expect(deps.commitUserPromptPreview).not.toHaveBeenCalled();
    expect(deps.rollbackUserPromptPreview).toHaveBeenCalledWith(
      'session-1',
      'client-1',
      'maker_send:failed-before-dispatch',
    );
  });

  it('returns host-send failure before dispatch when the existing session workdir is missing', async () => {
    const { deps, session } = createDeps({
      checkWorkDirExists: vi.fn(async () => false),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(transaction.sendToAgentAccepted('session-1', 'hello')).resolves.toEqual({
      accepted: false,
      reason: 'WORKDIR_MISSING',
      outcome: {
        kind: 'host-send',
        accepted: false,
        code: 'WORKDIR_MISSING',
        message: 'working directory is missing for session session-1',
      },
    });

    expect(deps.checkWorkDirExists).toHaveBeenCalledWith('session-1', 'C:\\repo', 'codex', null);
    expect(session.send).not.toHaveBeenCalled();
  });

  it('lazy-create adopts the DB working_dir when the caller-provided one is stale', async () => {
    // 场景:输入队列崩溃快照回放,createOpts 内嵌启动 sweep 改写前的老路径。
    const staleDir = '/data/xdt-maker/dialogues/2026-06-22/lazy-1';
    const dbDir = '/data/Cindy/dialogues/2026-06-22/lazy-1';
    const checkWorkDirExists = vi.fn(async (_sid: string, dir: string | undefined | null) => dir === dbDir);
    const { deps } = createDeps({
      getSession: vi.fn(() => undefined),
      checkWorkDirExists,
      readSessionWorkingDirFromDb: vi.fn(async () => dbDir),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('lazy-1', 'hello', {
        agentKind: 'codex',
        model: 'gpt-5.5',
        workingDir: staleDir,
      }),
    ).resolves.toMatchObject({ accepted: true });

    // 首检拿 caller 值且静默(有 DB 兜底候选);兜底检拿 DB 值正常广播语义。
    expect(checkWorkDirExists).toHaveBeenNthCalledWith(1, 'lazy-1', staleDir, 'codex', undefined, {
      suppressMissingBroadcast: true,
    });
    expect(checkWorkDirExists).toHaveBeenNthCalledWith(2, 'lazy-1', dbDir, 'codex', undefined);
    // bootstrap 用采纳后的 DB 路径 spawn。
    expect(deps.bootstrapSession).toHaveBeenCalledWith(expect.objectContaining({ workingDir: dbDir }));
  });

  it('lazy-create still fails with WORKDIR_MISSING when caller and DB workdirs are both gone', async () => {
    const { deps } = createDeps({
      getSession: vi.fn(() => undefined),
      checkWorkDirExists: vi.fn(async () => false),
      readSessionWorkingDirFromDb: vi.fn(async () => '/db/also-gone'),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('lazy-2', 'hello', {
        agentKind: 'codex',
        model: 'gpt-5.5',
        workingDir: '/stale/gone',
      }),
    ).resolves.toMatchObject({ accepted: false, reason: 'WORKDIR_MISSING' });
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
  });

  it('rejects missing sessions when create opts are not provided', async () => {
    const { deps } = createDeps({
      getSession: vi.fn(() => undefined),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(transaction.sendToAgentAccepted('missing-session', 'hello')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(deps.ensureRemoteReadyForSessionStart).toHaveBeenCalledWith({
      session: undefined,
      createOpts: undefined,
    });
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
  });

  it('lazy-creates a missing session before sending and broadcasts the created session', async () => {
    const lazySession = createSession({ id: 'lazy-session', workDir: 'D:\\lazy' });
    const { deps } = createDeps({
      getSession: vi.fn(() => undefined),
      bootstrapSession: vi.fn(async () => ({
        session: lazySession,
        didInjectOrcaInstructions: true,
        didInjectProjectContext: true,
      })),
    });
    const transaction = createMakerSendTransaction(deps);
    const createOpts: MakerSessionCreateOpts = {
      id: 'lazy-session',
      agentKind: 'claude-code',
      workingDir: 'D:\\lazy',
      model: 'claude-opus-4-7',
    };

    await expect(transaction.sendToAgentAccepted('lazy-session', 'hello', createOpts)).resolves.toMatchObject({
      accepted: true,
      outcome: { kind: 'session-dispatch', dispatched: true },
    });

    expect(deps.checkWorkDirExists).toHaveBeenCalledWith('lazy-session', 'D:\\lazy', 'claude-code', undefined);
    expect(deps.synthesizeOrcaVendorOptionsFromDb).toHaveBeenCalledWith('lazy-session', createOpts);
    expect(deps.bootstrapSession).toHaveBeenCalledWith(createOpts);
    expect(deps.markOrcaRoleIfNeeded).toHaveBeenCalledWith('lazy-session', undefined);
    expect(deps.broadcastSessionCreated).toHaveBeenCalledWith('lazy-session');
    expect(lazySession.send).toHaveBeenCalled();
  });

  it('returns lazy-create failure without dispatching when bootstrap fails', async () => {
    const { deps } = createDeps({
      getSession: vi.fn(() => undefined),
      bootstrapSession: vi.fn(async () => {
        throw new Error('bootstrap exploded');
      }),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('lazy-session', 'hello', {
        id: 'lazy-session',
        agentKind: 'codex',
        workingDir: 'D:\\lazy',
        model: 'gpt-5.4',
      }),
    ).resolves.toEqual({
      accepted: false,
      reason: 'LAZY_CREATE_FAILED',
      outcome: {
        kind: 'host-send',
        accepted: false,
        code: 'LAZY_CREATE_FAILED',
        message: 'bootstrap exploded',
      },
    });
    expect(deps.broadcastSessionCreated).not.toHaveBeenCalled();
  });

  it('maps lazy-create credential busy to CREDENTIAL_SWITCH_BUSY without dispatching', async () => {
    const { deps } = createDeps({
      getSession: vi.fn(() => undefined),
      bootstrapSession: vi.fn(async () => {
        throw new CredentialModeSwitchBusyError(['busy-session']);
      }),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('lazy-session', 'hello', {
        id: 'lazy-session',
        agentKind: 'codex',
        workingDir: 'D:\\lazy',
        model: 'gpt-5.4',
      }),
    ).resolves.toMatchObject({
      accepted: false,
      reason: 'CREDENTIAL_SWITCH_BUSY',
      outcome: {
        kind: 'host-send',
        code: 'CREDENTIAL_SWITCH_BUSY',
      },
    });
    expect(deps.broadcastSessionCreated).not.toHaveBeenCalled();
    expect(deps.prepareSendUserMessage).not.toHaveBeenCalled();
  });

  it('rehydrates an active Orca session before sending when MCP vendor options are stale', async () => {
    const oldSession = createSession({ id: 'orca-session', workDir: 'C:\\repo' });
    const newSession = createSession({ id: 'orca-session', workDir: 'C:\\repo' });
    const { deps } = createDeps({
      getSession: vi.fn(() => oldSession),
      isOrcaMcpHydrated: vi.fn(() => false),
      synthesizeOrcaVendorOptionsFromDb: vi.fn(async () => true),
      readSessionExtraDirsFromDb: vi.fn(async () => ['C:\\shared']),
      bootstrapSession: vi.fn(async () => ({
        session: newSession,
        didInjectOrcaInstructions: true,
        didInjectProjectContext: false,
      })),
    });
    const transaction = createMakerSendTransaction(deps);
    const createOpts: MakerSessionCreateOpts = {
      id: 'orca-session',
      agentKind: 'codex',
      workingDir: 'C:\\repo',
      model: 'gpt-5.4',
      orcaRole: 'lead',
    };

    await expect(transaction.sendToAgentAccepted('orca-session', 'hello', createOpts)).resolves.toMatchObject({
      accepted: true,
    });

    expect(deps.withRehydrateCloseSuppressed).toHaveBeenCalledWith('orca-session', expect.any(Function));
    expect(deps.closeSession).toHaveBeenCalledWith('orca-session');
    expect(deps.bootstrapSession).toHaveBeenCalledWith(expect.objectContaining({
      extraDirs: ['C:\\shared'],
    }));
    expect(deps.markOrcaRoleIfNeeded).toHaveBeenCalledWith('orca-session', 'lead');
    expect(oldSession.send).not.toHaveBeenCalled();
    expect(newSession.send).toHaveBeenCalled();
  });

  it('returns rehydrate failure without sending when active Orca rehydrate fails', async () => {
    const oldSession = createSession({ id: 'orca-session', workDir: 'C:\\repo' });
    const { deps } = createDeps({
      getSession: vi.fn(() => oldSession),
      isOrcaMcpHydrated: vi.fn(() => false),
      synthesizeOrcaVendorOptionsFromDb: vi.fn(async () => true),
      withRehydrateCloseSuppressed: vi.fn(async () => {
        throw new Error('rehydrate exploded');
      }),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('orca-session', 'hello', {
        id: 'orca-session',
        agentKind: 'codex',
        workingDir: 'C:\\repo',
        model: 'gpt-5.4',
      }),
    ).resolves.toEqual({
      accepted: false,
      reason: 'REHYDRATE_FAILED',
      outcome: {
        kind: 'host-send',
        accepted: false,
        code: 'REHYDRATE_FAILED',
        message: 'rehydrate exploded',
      },
    });

    expect(oldSession.send).not.toHaveBeenCalled();
  });

  it('maps rehydrate credential busy to CREDENTIAL_SWITCH_BUSY without sending', async () => {
    const oldSession = createSession({ id: 'orca-session', workDir: 'C:\\repo' });
    const { deps } = createDeps({
      getSession: vi.fn(() => oldSession),
      isOrcaMcpHydrated: vi.fn(() => false),
      synthesizeOrcaVendorOptionsFromDb: vi.fn(async () => true),
      withRehydrateCloseSuppressed: vi.fn(async () => {
        throw new CredentialModeSwitchBusyError(['busy-session']);
      }),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('orca-session', 'hello', {
        id: 'orca-session',
        agentKind: 'codex',
        workingDir: 'C:\\repo',
        model: 'gpt-5.4',
      }),
    ).resolves.toMatchObject({
      accepted: false,
      reason: 'CREDENTIAL_SWITCH_BUSY',
      outcome: {
        kind: 'host-send',
        code: 'CREDENTIAL_SWITCH_BUSY',
      },
    });

    expect(oldSession.send).not.toHaveBeenCalled();
    expect(deps.prepareSendUserMessage).not.toHaveBeenCalled();
  });

  it('does not rehydrate stale Orca sessions while a turn is running', async () => {
    const runningSession = createSession({
      id: 'orca-session',
      isTurnRunning: vi.fn(() => true),
    });
    const { deps } = createDeps({
      getSession: vi.fn(() => runningSession),
      isOrcaMcpHydrated: vi.fn(() => false),
      synthesizeOrcaVendorOptionsFromDb: vi.fn(async () => true),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('orca-session', 'hello', {
        id: 'orca-session',
        agentKind: 'codex',
        workingDir: 'C:\\repo',
        model: 'gpt-5.4',
      }),
    ).rejects.toMatchObject({ code: 'SESSION_RUNNING' });

    expect(deps.withRehydrateCloseSuppressed).not.toHaveBeenCalled();
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.prepareSendUserMessage).not.toHaveBeenCalled();
    expect(runningSession.send).not.toHaveBeenCalled();
  });

  it('maps a running error thrown by send to SESSION_RUNNING', async () => {
    const runningError = Object.assign(new Error('SESSION_RUNNING: race'), {
      code: 'SESSION_RUNNING',
    });
    const session = createSession({
      send: vi.fn(async () => {
        throw runningError;
      }),
    });
    const { deps } = createDeps({
      getSession: vi.fn(() => session),
      isSessionRunningError: vi.fn((err) => err === runningError),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(transaction.sendToAgentAccepted('session-1', 'hello')).rejects.toMatchObject({
      code: 'SESSION_RUNNING',
    });
  });

  it('maps cancelled-before-dispatch send results to accepted false', async () => {
    const session = createSession({
      send: vi.fn(async () => (
        { accepted: false, reason: 'cancelled-before-dispatch' } satisfies SessionSendResult
      )),
    });
    const { deps } = createDeps({
      getSession: vi.fn(() => session),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(transaction.sendToAgentAccepted('session-1', 'hello')).resolves.toEqual({
      accepted: false,
      reason: 'cancelled-before-dispatch',
      outcome: {
        kind: 'session-dispatch',
        source: 'maker-ipc',
        dispatched: false,
        reason: 'cancelled-before-dispatch',
        context: 'SEND/session-1/send',
        message: 'Session send was cancelled before vendor dispatch: SEND/session-1/send',
      },
    });
  });

  it('ignores caller-provided persisted message createdAt', async () => {
    const { deps } = createDeps();
    const transaction = createMakerSendTransaction(deps);

    await transaction.sendToAgentAccepted('session-1', 'hello', undefined, {
      persistUserMessage: {
        clientId: 'client-1',
        content: 'hello',
        createdAt: 'not-a-date',
      },
    });

    const persistedMessage = vi.mocked(deps.createDbMessage).mock.calls[0]?.[1];
    expect(persistedMessage).not.toHaveProperty('createdAt');
  });
});
