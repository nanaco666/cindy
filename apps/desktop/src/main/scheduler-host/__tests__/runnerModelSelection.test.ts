/**
 * MakerScheduleRunner 模型选择回归测试。
 *
 * 背景（2026-06 实际线上踩坑）：
 *   1. 任务编辑器空 model 时 UI 显示 availableModels[0]（Opus 4.8），但 runner 的
 *      defaultModelFor 兜底硬编码成了上一代（Opus 4.7）—— 用户"看着选了 4.8 实际跑 4.7"。
 *   2. heartbeat（持续会话）模式 runner 只读绑定 session 的 meta.model，schedule.model
 *      被静默忽略 —— 用户在任务里改模型永远不生效。
 *
 * 防回归点：
 *   - 非 heartbeat：schedule.model 透传；空时兜底 claude-sonnet-4-6 / gpt-5.5
 *     （成本保守,故意不跟对话的 Opus 默认;必须与 renderer useScheduleForm.ts
 *     schedulerFallbackModel 同步）。
 *   - heartbeat：schedule.model 显式设置时优先于 meta.model，并通过 session.setModel
 *     同步给运行时（覆盖 maker.createSession 复用 active session 忽略 opts.model 的路径）
 *     + backfillSessionMeta 落库；schedule.model 留空才沿用 meta.model，且不触发 setModel。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type {
  AgentEvent,
  Maker,
  Session,
  SessionSendResult,
} from '@cindy/maker-core';
import type {
  FireContext,
  Logger,
  Notifier,
  Schedule,
} from '@cindy/maker-scheduler';

const mocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
  getSessionRowSnapshot: vi.fn(),
  ensureDialogueWorkspaceDir: vi.fn(),
  wireSessionToIpc: vi.fn(),
  resolveWorkingDir: vi.fn(),
  backfillSessionMeta: vi.fn(),
  getSessionProvider: vi.fn(),
  setSessionProvider: vi.fn(),
  hydrateSessionProvider: vi.fn(),
  isSessionInTurn: vi.fn(),
}));

vi.mock('../../maker-host/session-provider-store.js', () => ({
  getSessionProvider: mocks.getSessionProvider,
  setSessionProvider: mocks.setSessionProvider,
  hydrateSessionProvider: mocks.hydrateSessionProvider,
}));

vi.mock('../../localDb/ipc/messages.js', () => ({
  createMessage: mocks.createMessage,
}));

vi.mock('../../localDb/ipc/sessions.js', () => ({
  getSessionRowSnapshot: mocks.getSessionRowSnapshot,
  touchUserSendInDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../localDb/dialogueWorkspace', () => ({
  ensureDialogueWorkspaceDir: mocks.ensureDialogueWorkspaceDir,
}));

vi.mock('../../maker-ipc/register.js', () => ({
  wireSessionToIpc: mocks.wireSessionToIpc,
  isSessionInTurn: mocks.isSessionInTurn,
  noteSilentStopUserSend: vi.fn(),
  onSilentStopSettled: vi.fn(() => () => {}),
}));

vi.mock('../workdir-resolver', () => ({
  resolveWorkingDir: mocks.resolveWorkingDir,
}));

vi.mock('../runners/_shared', () => ({
  backfillSessionMeta: mocks.backfillSessionMeta,
}));

import { MakerScheduleRunner } from '../runner';

type SessionSendOptions = Parameters<Session['send']>[1];
type SendImpl = (
  message: Parameters<Session['send']>[0],
  opts?: SessionSendOptions,
) => Promise<SessionSendResult>;

interface FakeSessionHarness {
  session: Session;
  send: ReturnType<typeof vi.fn<SendImpl>>;
  setModel: ReturnType<typeof vi.fn>;
  setEffort: ReturnType<typeof vi.fn>;
  emit(event: AgentEvent): void;
}

function createSessionHarness(): FakeSessionHarness {
  const listeners: Array<(event: AgentEvent) => void> = [];
  const send = vi.fn<SendImpl>(async (_message, opts) => {
    await opts?.onAccepted?.();
    return { accepted: true };
  });
  const setModel = vi.fn(async () => undefined);
  const setEffort = vi.fn(async () => undefined);
  const session = {
    id: 'scheduler-session',
    agentKind: 'claude-code',
    model: 'claude-sonnet-4-6',
    remoteHostId: null,
    send,
    setModel,
    setEffort,
    onEvent(listener: (event: AgentEvent) => void) {
      listeners.push(listener);
      return () => {
        listeners.splice(0, listeners.length);
      };
    },
    abort: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as Session;

  return {
    session,
    send,
    setModel,
    setEffort,
    emit(event: AgentEvent) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function createLogger(): Logger {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
}

function baseSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    name: 'model selection test',
    prompt: 'do the thing',
    jobType: 'prompt',
    source: 'user',
    kind: 'cron',
    cronExpr: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    agentKind: 'claude-code',
    workspaceKind: 'project',
    workingDir: '/work',
    useWorktree: false,
    notify: { desktop: true, feishu: false },
    status: 'active',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function createFireContext(): FireContext {
  return {
    runId: 'run-1',
    firedAt: 1_700_000_000_100,
    signal: new AbortController().signal,
    onSessionBound: vi.fn(async () => undefined),
  };
}

interface RunnerHarness {
  runner: MakerScheduleRunner;
  createSession: ReturnType<typeof vi.fn>;
  closeSession: ReturnType<typeof vi.fn>;
}

function createRunnerHarness(
  h: FakeSessionHarness,
  meta: { model?: string; effort?: string; workDir?: string; sdkSessionId?: string } | null = null,
  opts: { sessionAlive?: boolean; activeSessions?: Session[] } = {},
): RunnerHarness {
  const createSession = vi.fn(async () => h.session);
  const closeSession = vi.fn(async () => undefined);
  const maker = {
    createSession,
    getSessionMeta: vi.fn(async () => meta),
    getSession: vi.fn(() => h.session),
    listActiveSessions: vi.fn(() => opts.activeSessions ?? [h.session]),
    closeSession,
    // 默认 false = fresh spawn（opts.model/effort 已生效）；true 模拟进程内
    // 复用 active session 的路径（createSession 忽略 opts, setModel/setEffort 是唯一通道）。
    isSessionAlive: vi.fn(() => opts.sessionAlive ?? false),
  } as unknown as Maker;
  const notifier: Notifier = { notify: vi.fn(async () => undefined) };
  const runner = new MakerScheduleRunner({
    maker,
    getDb: () => ({}) as never,
    notifier,
    logger: createLogger(),
  });
  return { runner, createSession, closeSession };
}

/** 跑完整个 fire：等 send 被调用后 emit done，返回 createSession 收到的 opts。 */
async function fireToCompletion(
  harness: RunnerHarness,
  h: FakeSessionHarness,
  schedule: Schedule,
): Promise<{ model: string }> {
  const firePromise = harness.runner.fire(schedule, createFireContext());
  await vi.waitFor(() => expect(h.send).toHaveBeenCalled());
  h.emit({ type: 'done', data: {} });
  await firePromise;
  return harness.createSession.mock.calls[0][0] as { model: string };
}

describe('MakerScheduleRunner model selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createMessage.mockResolvedValue(undefined);
    mocks.backfillSessionMeta.mockResolvedValue(undefined);
    mocks.resolveWorkingDir.mockResolvedValue({ ok: true, path: '/work' });
    mocks.getSessionProvider.mockReturnValue(null);
    mocks.isSessionInTurn.mockReturnValue(false);
    mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active' });
  });

  describe('non-heartbeat (每次新建 session)', () => {
    it('schedule.model 留空时 Claude 兜底 claude-sonnet-4-6（成本保守,与 UI 空值回退一致）', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h);

      const opts = await fireToCompletion(harness, h, baseSchedule({ model: undefined }));

      expect(opts.model).toBe('claude-sonnet-4-6');
    });

    it('schedule.model 留空时 Codex 兜底 gpt-5.5', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h);

      const opts = await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: undefined, agentKind: 'codex' }),
      );

      expect(opts.model).toBe('gpt-5.5');
    });

    it('schedule.model 显式设置时原样透传', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h);

      const opts = await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: 'claude-sonnet-4-6' }),
      );

      expect(opts.model).toBe('claude-sonnet-4-6');
      expect(h.setModel).not.toHaveBeenCalled();
    });
  });

  describe('heartbeat (持续会话绑定)', () => {
    const HEARTBEAT_META = {
      model: 'claude-opus-4-7',
      effort: 'high',
      workDir: '/work',
      sdkSessionId: 'sdk-1',
    };

    it('schedule.model 显式设置时优先于绑定 session 的 meta.model，并同步给运行时 + 落库', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h, HEARTBEAT_META);

      const opts = await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: 'claude-opus-4-8', targetSessionId: 'scheduler-session' }),
      );

      expect(opts.model).toBe('claude-opus-4-8');
      // createSession 可能复用进程内 active session（忽略 opts.model），必须显式 setModel
      expect(h.setModel).toHaveBeenCalledWith('claude-opus-4-8');
      // sessions.model 落库，让 chat UI picker 与下次 fire 的 meta.model 一致
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ model: 'claude-opus-4-8' }),
        expect.anything(),
      );
    });

    it('schedule.model 留空时沿用 meta.model，不触发 setModel / model 落库', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h, HEARTBEAT_META);

      const opts = await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: undefined, targetSessionId: 'scheduler-session' }),
      );

      expect(opts.model).toBe('claude-opus-4-7');
      expect(h.setModel).not.toHaveBeenCalled();
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ model: undefined }),
        expect.anything(),
      );
    });

    it('schedule.model 与 meta.model 相同时不做多余的 setModel 同步', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h, HEARTBEAT_META);

      const opts = await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: 'claude-opus-4-7', targetSessionId: 'scheduler-session' }),
      );

      expect(opts.model).toBe('claude-opus-4-7');
      expect(h.setModel).not.toHaveBeenCalled();
    });

    it('setModel 失败不阻断 fire（非致命，fresh spawn 路径 opts.model 已生效）', async () => {
      const h = createSessionHarness();
      h.setModel.mockRejectedValue(new Error('switchModel not supported'));
      const harness = createRunnerHarness(h, HEARTBEAT_META);

      const opts = await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: 'claude-opus-4-8', targetSessionId: 'scheduler-session' }),
      );

      expect(opts.model).toBe('claude-opus-4-8');
      expect(h.send).toHaveBeenCalled();
      // fresh spawn 路径 opts.model 已在 createSession 生效, setModel 只是幂等兜底,
      // 失败也照常落库 —— meta 与实际运行一致。
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ model: 'claude-opus-4-8' }),
        expect.anything(),
      );
    });

    it('复用 active session 时 setModel 失败 → 跳过 model 落库, 下次 fire 可重试', async () => {
      // 反例锁定: 复用路径 createSession 忽略 opts.model, setModel 是唯一生效通道。
      // 失败仍落库的话 meta.model 变成新值 → 下次 fire 判定"无变化"不再 setModel,
      // 运行时永远停在旧 model 且 UI 显示新值（review thread: only persist after success）。
      const h = createSessionHarness();
      h.setModel.mockRejectedValue(new Error('transient RPC failure'));
      const harness = createRunnerHarness(h, HEARTBEAT_META, { sessionAlive: true });

      await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: 'claude-opus-4-8', targetSessionId: 'scheduler-session' }),
      );

      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ model: undefined }),
        expect.anything(),
      );
    });

    it('复用 active session 时 setEffort 失败 → 跳过 effort 落库, 下次 fire 可重试', async () => {
      const h = createSessionHarness();
      h.setEffort.mockRejectedValue(new Error('transient RPC failure'));
      const harness = createRunnerHarness(h, HEARTBEAT_META, { sessionAlive: true });

      await fireToCompletion(
        harness,
        h,
        baseSchedule({
          model: 'claude-opus-4-7', // 与 meta 相同, 不触发 model 同步
          effort: 'xhigh',
          targetSessionId: 'scheduler-session',
        }),
      );

      expect(h.setEffort).toHaveBeenCalledWith('xhigh');
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ effort: undefined }),
        expect.anything(),
      );
    });

    it('复用 active session 时 setModel / setEffort 成功 → 照常落库', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h, HEARTBEAT_META, { sessionAlive: true });

      await fireToCompletion(
        harness,
        h,
        baseSchedule({
          model: 'claude-opus-4-8',
          effort: 'xhigh',
          targetSessionId: 'scheduler-session',
        }),
      );

      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ model: 'claude-opus-4-8', effort: 'xhigh' }),
        expect.anything(),
      );
    });

    it('legacy session meta 无 model 时落兜底 Sonnet 并 setModel + 落库（显式锁定静默升级契约）', async () => {
      // 历史持续会话可能从未存过 model（meta.model undefined）。此时:
      // rawModel=undefined → defaultModelFor='claude-sonnet-4-6',
      // heartbeatModelChanged=true → setModel + backfill 落库。
      // 这是有意行为（兜底必须与 UI 空值回退一致）,本用例防止未来误改。
      const h = createSessionHarness();
      const harness = createRunnerHarness(h, { workDir: '/work', sdkSessionId: 'sdk-1' });

      const opts = await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: undefined, targetSessionId: 'scheduler-session' }),
      );

      expect(opts.model).toBe('claude-sonnet-4-6');
      expect(h.setModel).toHaveBeenCalledWith('claude-sonnet-4-6');
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ model: 'claude-sonnet-4-6' }),
        expect.anything(),
      );
    });

    it('schedule.effort 与 meta.effort 不一致时 setEffort 同步运行时（active session 复用路径）', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h, HEARTBEAT_META);

      await fireToCompletion(
        harness,
        h,
        baseSchedule({
          model: 'claude-opus-4-7',
          effort: 'xhigh',
          targetSessionId: 'scheduler-session',
        }),
      );

      expect(h.setEffort).toHaveBeenCalledWith('xhigh');
    });

    it('schedule.effort 留空或与 meta.effort 相同时不触发 setEffort', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h, HEARTBEAT_META);

      await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: 'claude-opus-4-7', targetSessionId: 'scheduler-session' }),
      );
      expect(h.setEffort).not.toHaveBeenCalled();

      const h2 = createSessionHarness();
      const harness2 = createRunnerHarness(h2, HEARTBEAT_META);
      await fireToCompletion(
        harness2,
        h2,
        baseSchedule({
          model: 'claude-opus-4-7',
          effort: 'high', // 与 meta.effort 相同
          targetSessionId: 'scheduler-session',
        }),
      );
      expect(h2.setEffort).not.toHaveBeenCalled();
    });
  });

  // ── per-session 来源(供应商)注入 ──────────────────────────────────────────
  // 不变量(镜像 model,但更简单——provider 走独立内存 store,与 session 是否复用无关):
  //   - 留空 + 非 heartbeat → 不碰 store(fresh session 默认 null = 原生默认路由,no-break)。
  //   - 留空 + heartbeat → hydrate 绑定会话的 provider_id(只在内存无条目时写,不覆盖)。
  //   - 显式设置 → setSessionProvider 覆盖 + backfill 落 sessions.provider_id。
  describe('provider (来源) 注入', () => {
    it('非 heartbeat + 留空 providerId → 不调 setSessionProvider/hydrate(原生默认,no-break)', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h);

      await fireToCompletion(harness, h, baseSchedule({ model: 'claude-sonnet-4-6' }));

      expect(mocks.setSessionProvider).not.toHaveBeenCalled();
      expect(mocks.hydrateSessionProvider).not.toHaveBeenCalled();
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ providerId: undefined }),
        expect.anything(),
      );
    });

    it('非 heartbeat + 显式 providerId → setSessionProvider 覆盖 + 落库', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h);

      await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: 'claude-sonnet-4-6', providerId: 'anthropic' }),
      );

      expect(mocks.setSessionProvider).toHaveBeenCalledWith('scheduler-session', 'anthropic');
      expect(mocks.hydrateSessionProvider).not.toHaveBeenCalled();
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ providerId: 'anthropic' }),
        expect.anything(),
      );
    });

    it('heartbeat + 留空 → hydrate 绑定会话的 provider_id(沿用会话来源,不覆盖、不落库)', async () => {
      mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active', providerId: 'openai' });
      const h = createSessionHarness();
      const harness = createRunnerHarness(h, {
        model: 'claude-opus-4-7',
        workDir: '/work',
        sdkSessionId: 'sdk-1',
      });

      await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: undefined, targetSessionId: 'scheduler-session' }),
      );

      expect(mocks.hydrateSessionProvider).toHaveBeenCalledWith('scheduler-session', 'openai');
      expect(mocks.setSessionProvider).not.toHaveBeenCalled();
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ providerId: undefined }),
        expect.anything(),
      );
    });

    it('heartbeat + 显式 providerId → setSessionProvider 覆盖绑定会话来源 + 落库', async () => {
      mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active', providerId: 'openai' });
      const h = createSessionHarness();
      const harness = createRunnerHarness(h, {
        model: 'claude-opus-4-7',
        workDir: '/work',
        sdkSessionId: 'sdk-1',
      });

      await fireToCompletion(
        harness,
        h,
        baseSchedule({
          model: 'claude-opus-4-7',
          providerId: 'anthropic',
          targetSessionId: 'scheduler-session',
        }),
      );

      expect(mocks.setSessionProvider).toHaveBeenCalledWith('scheduler-session', 'anthropic');
      expect(mocks.hydrateSessionProvider).not.toHaveBeenCalled();
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ providerId: 'anthropic' }),
        expect.anything(),
      );
    });

    it('heartbeat 复用本地 Codex 且跨 credential family → 先关闭再按新来源重建', async () => {
      mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active', providerId: 'xd' });
      const h = createSessionHarness();
      Object.defineProperty(h.session, 'agentKind', { value: 'codex' });
      Object.defineProperty(h.session, 'model', { value: 'codex/gpt-5.5' });
      const harness = createRunnerHarness(h, {
        model: 'codex/gpt-5.5',
        workDir: '/work',
        sdkSessionId: 'sdk-1',
      }, { sessionAlive: true });

      await fireToCompletion(
        harness,
        h,
        baseSchedule({
          agentKind: 'codex',
          model: 'gpt-5.4',
          providerId: 'openai',
          targetSessionId: 'scheduler-session',
        }),
      );

      expect(harness.closeSession).toHaveBeenCalledWith('scheduler-session');
      expect(harness.closeSession.mock.invocationCallOrder[0])
        .toBeLessThan(harness.createSession.mock.invocationCallOrder[0]);
      expect(harness.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'openai', model: 'gpt-5.4' }),
      );
      expect(mocks.setSessionProvider).toHaveBeenCalledWith('scheduler-session', 'openai');
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ model: 'gpt-5.4', providerId: 'openai' }),
        expect.anything(),
      );
    });

    it('heartbeat 复用本地 Codex 且其它本地 Codex 正忙 → 顺延且不关闭任何会话', async () => {
      mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active', providerId: 'xd' });
      const h = createSessionHarness();
      Object.defineProperty(h.session, 'agentKind', { value: 'codex' });
      Object.defineProperty(h.session, 'model', { value: 'codex/gpt-5.5' });
      const busyCodexSession = {
        id: 'busy-codex-session',
        agentKind: 'codex',
        remoteHostId: null,
        isTurnRunning: () => true,
      } as unknown as Session;
      const harness = createRunnerHarness(h, {
        model: 'codex/gpt-5.5',
        workDir: '/work',
        sdkSessionId: 'sdk-1',
      }, { sessionAlive: true, activeSessions: [h.session, busyCodexSession] });

      const result = await harness.runner.fire(
        baseSchedule({
          agentKind: 'codex',
          model: 'gpt-5.4',
          providerId: 'openai',
          targetSessionId: 'scheduler-session',
        }),
        createFireContext(),
      );

      expect(result).toEqual({
        sessionId: 'scheduler-session',
        deferred: true,
        deferRetryMs: 90_000,
      });
      expect(harness.closeSession).not.toHaveBeenCalled();
      expect(harness.createSession).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
    });

    it('heartbeat 复用本地 Claude 且从 XD 切到 Anthropic → 先关闭再按新来源重建', async () => {
      mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active', providerId: 'xd' });
      const h = createSessionHarness();
      Object.defineProperty(h.session, 'model', { value: 'claude-sonnet-4-6' });
      const harness = createRunnerHarness(h, {
        model: 'claude-sonnet-4-6',
        workDir: '/work',
        sdkSessionId: 'sdk-1',
      }, { sessionAlive: true });

      await fireToCompletion(
        harness,
        h,
        baseSchedule({
          model: 'claude-opus-4-8',
          providerId: 'anthropic',
          targetSessionId: 'scheduler-session',
        }),
      );

      expect(harness.closeSession).toHaveBeenCalledWith('scheduler-session');
      expect(harness.closeSession.mock.invocationCallOrder[0])
        .toBeLessThan(harness.createSession.mock.invocationCallOrder[0]);
      expect(harness.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'anthropic', model: 'claude-opus-4-8' }),
      );
      expect(mocks.setSessionProvider).toHaveBeenCalledWith('scheduler-session', 'anthropic');
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ model: 'claude-opus-4-8', providerId: 'anthropic' }),
        expect.anything(),
      );
    });

    it('heartbeat 复用本地 Claude 且目标会话正忙 → 顺延且不关闭会话', async () => {
      mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active', providerId: 'xd' });
      const h = createSessionHarness();
      Object.defineProperty(h.session, 'model', { value: 'claude-sonnet-4-6' });
      Object.defineProperty(h.session, 'isTurnRunning', { value: () => true });
      const harness = createRunnerHarness(h, {
        model: 'claude-sonnet-4-6',
        workDir: '/work',
        sdkSessionId: 'sdk-1',
      }, { sessionAlive: true });

      const result = await harness.runner.fire(
        baseSchedule({
          model: 'claude-opus-4-8',
          providerId: 'anthropic',
          targetSessionId: 'scheduler-session',
        }),
        createFireContext(),
      );

      expect(result).toEqual({
        sessionId: 'scheduler-session',
        deferred: true,
        deferRetryMs: 90_000,
      });
      expect(harness.closeSession).not.toHaveBeenCalled();
      expect(harness.createSession).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
    });
  });
});
