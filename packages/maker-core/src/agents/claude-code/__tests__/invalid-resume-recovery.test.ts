/** Claude invalid-resume 的 preflight + 单次运行期 fresh fallback 回归。 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps, StartSessionOptions } from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { AgentEvent } from '../../../types/events.js';
import type { Logger } from '../../../interfaces/logger.js';
import { sanitizeClaudeProjectKey } from '../claude-projects-fs.js';

const sdkMock = vi.hoisted(() => ({ query: vi.fn(), forkSession: vi.fn() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: sdkMock.query,
  forkSession: sdkMock.forkSession,
}));

import { ClaudeCodeAgent } from '../index.js';

const tempDirs: string[] = [];
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

function createLogger(): Logger {
  const logger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function createDeps(overrides: Partial<AgentDeps> = {}): AgentDeps {
  const auth: AuthAdapter = {
    async getState() {
      return { authenticated: true };
    },
    async triggerLogin() {
      return { authenticated: true };
    },
    async logout() {},
    async getAuthEnv() {
      return {};
    },
  };
  return {
    auth,
    runtimeConfig: {},
    binaryPath: process.execPath,
    logger: createLogger(),
    ...overrides,
  };
}

function createControlledStream() {
  const items: unknown[] = [];
  let waiter: {
    resolve: (value: IteratorResult<unknown>) => void;
    reject: (error: unknown) => void;
  } | null = null;
  let failure: unknown;
  let ended = false;
  const pump = (): void => {
    if (!waiter) return;
    const current = waiter;
    if (items.length > 0) {
      waiter = null;
      current.resolve({ done: false, value: items.shift() });
    } else if (failure !== undefined) {
      waiter = null;
      current.reject(failure);
    } else if (ended) {
      waiter = null;
      current.resolve({ done: true, value: undefined });
    }
  };
  return {
    emit(value: unknown): void {
      items.push(value);
      pump();
    },
    fail(error: unknown): void {
      failure = error;
      pump();
    },
    end(): void {
      ended = true;
      pump();
    },
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<unknown>>((resolve, reject) => {
            waiter = { resolve, reject };
            pump();
          }),
      };
    },
  };
}

function createFakeQuery(stream: ReturnType<typeof createControlledStream>) {
  return {
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    setPermissionMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    applyFlagSettings: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {
      stream.end();
    }),
    rewindFiles: vi.fn(async () => ({ canRewind: false })),
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-invalid-resume-'));
  tempDirs.push(dir);
  return dir;
}

async function seedTranscript(configDir: string, workingDir: string, sdkSessionId: string): Promise<void> {
  const normalized = await fs.realpath(workingDir);
  const projectDir = path.join(configDir, 'projects', sanitizeClaudeProjectKey(normalized));
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, `${sdkSessionId}.jsonl`), '{"type":"summary"}\n', 'utf8');
}

async function startHarness(args: {
  resumeSessionId: string;
  transcriptExists: boolean;
  onInvalidResumeSession: StartSessionOptions['onInvalidResumeSession'];
}) {
  const configDir = await makeTempDir();
  const workingDir = await makeTempDir();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  if (args.transcriptExists) {
    await seedTranscript(configDir, workingDir, args.resumeSessionId);
  }

  const streams = [createControlledStream(), createControlledStream(), createControlledStream()];
  const queries = streams.map(createFakeQuery);
  const queryOptions: Array<Record<string, unknown>> = [];
  const consumedInputs: unknown[][] = [];
  sdkMock.query.mockImplementation((options: unknown) => {
    const index = queryOptions.length;
    queryOptions.push((options as { options?: Record<string, unknown> }).options ?? {});
    const consumed: unknown[] = [];
    consumedInputs.push(consumed);
    const prompt = (options as { prompt?: AsyncIterable<unknown> }).prompt;
    if (prompt) {
      void (async () => {
        try {
          for await (const input of prompt) consumed.push(input);
        } catch {
          /* query replacement closes the old prompt */
        }
      })();
    }
    return queries[index];
  });

  const agent = new ClaudeCodeAgent(createDeps());
  const handle = await agent.startSession({
    sessionId: 'local-session',
    model: 'claude-opus-4-6',
    workingDir,
    permissionMode: 'acceptEdits',
    resumeSessionId: args.resumeSessionId,
    onInvalidResumeSession: args.onInvalidResumeSession,
  });
  const events: AgentEvent[] = [];
  const collected = (async () => {
    for await (const event of handle.events()) events.push(event);
  })();
  return {
    handle,
    streams,
    queries,
    queryOptions,
    consumedInputs,
    events,
    collected,
  };
}

async function waitForDone(events: AgentEvent[]): Promise<void> {
  await vi.waitFor(() => expect(events.some((event) => event.type === 'done')).toBe(true));
}

afterEach(async () => {
  sdkMock.query.mockReset();
  sdkMock.forkSession.mockReset();
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('Claude invalid-resume recovery', () => {
  it('preflight missing clears the old id and starts fresh before any turn is sent', async () => {
    const clear = vi.fn(async () => true);
    const h = await startHarness({
      resumeSessionId: 'sdk-missing',
      transcriptExists: false,
      onInvalidResumeSession: clear,
    });

    expect(clear).toHaveBeenCalledWith('sdk-missing');
    expect(h.queryOptions).toHaveLength(1);
    expect(h.queryOptions[0]).not.toHaveProperty('resume');
    await h.handle.close();
    h.streams[0].end();
    await h.collected;
  });

  it('suppresses the failed resume boundary, replays one input, and finishes on a fresh query', async () => {
    const clear = vi.fn(async () => true);
    const h = await startHarness({
      resumeSessionId: 'sdk-old',
      transcriptExists: true,
      onInvalidResumeSession: clear,
    });

    await h.handle.send({ type: 'user', content: 'hello once' });
    h.streams[0].emit({
      type: 'result',
      is_error: true,
      subtype: 'error_during_execution',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    h.streams[0].fail(
      new Error('Claude Code returned an error result: No conversation found with session ID: sdk-old'),
    );
    await vi.waitFor(() => expect(h.queryOptions).toHaveLength(2));
    h.streams[1].emit({
      type: 'system',
      subtype: 'init',
      session_id: 'sdk-new',
    });
    h.streams[1].emit({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'recovered' }] },
      session_id: 'sdk-new',
    });
    h.streams[1].emit({
      type: 'result',
      is_error: false,
      result: 'recovered',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await waitForDone(h.events);

    expect(clear).toHaveBeenCalledTimes(1);
    expect(h.queryOptions[0]).toHaveProperty('resume', 'sdk-old');
    expect(h.queryOptions[1]).not.toHaveProperty('resume');
    await vi.waitFor(() => expect(h.consumedInputs.map((inputs) => inputs.length)).toEqual([1, 1]));
    expect(h.events.filter((event) => event.type === 'error')).toHaveLength(0);
    expect(h.events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(h.events).toContainEqual({
      type: 'session_id',
      data: 'sdk-new',
      source: 'claude-code',
    });

    await h.handle.close();
    h.streams[1].end();
    await h.collected;
  });

  it('stops after one fresh fallback when the replacement query also crashes', async () => {
    const clear = vi.fn(async () => true);
    const h = await startHarness({
      resumeSessionId: 'sdk-old',
      transcriptExists: true,
      onInvalidResumeSession: clear,
    });
    await h.handle.send({ type: 'user', content: 'hello once' });
    h.streams[0].fail(new Error('No conversation found with session ID: sdk-old'));
    await vi.waitFor(() => expect(h.queryOptions).toHaveLength(2));
    h.streams[1].fail(new Error('fresh query crashed'));
    await h.collected;

    expect(clear).toHaveBeenCalledTimes(1);
    expect(h.queryOptions).toHaveLength(2);
    expect(h.events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(h.events.find((event) => event.type === 'error')?.data).toMatchObject({
      reason: 'sdk_stream_crashed',
      isTerminal: true,
    });
  });

  it('does not overwrite a concurrently replaced id when compare-and-clear misses', async () => {
    const clear = vi.fn(async () => false);
    const h = await startHarness({
      resumeSessionId: 'sdk-old',
      transcriptExists: true,
      onInvalidResumeSession: clear,
    });
    await h.handle.send({ type: 'user', content: 'hello once' });
    h.streams[0].fail(new Error('No conversation found with session ID: sdk-old'));
    await h.collected;

    expect(clear).toHaveBeenCalledTimes(1);
    expect(h.queryOptions).toHaveLength(1);
    expect(h.events.find((event) => event.type === 'error')?.data).toMatchObject({
      reason: 'resume_session_not_found',
      isTerminal: true,
    });
  });

  it('keeps a valid resumed conversation on the original query without invoking recovery', async () => {
    const clear = vi.fn(async () => true);
    const h = await startHarness({
      resumeSessionId: 'sdk-valid',
      transcriptExists: true,
      onInvalidResumeSession: clear,
    });
    await h.handle.send({ type: 'user', content: 'hello once' });
    h.streams[0].emit({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'valid response' }] },
      session_id: 'sdk-valid',
    });
    h.streams[0].emit({
      type: 'result',
      is_error: false,
      result: 'valid response',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await waitForDone(h.events);

    expect(clear).not.toHaveBeenCalled();
    expect(h.queryOptions).toHaveLength(1);
    expect(h.queryOptions[0]).toHaveProperty('resume', 'sdk-valid');
    expect(h.events.filter((event) => event.type === 'error')).toHaveLength(0);
    await h.handle.close();
    h.streams[0].end();
    await h.collected;
  });

  it('does not clear or retry unrelated HTTP failures', async () => {
    const clear = vi.fn(async () => true);
    const h = await startHarness({
      resumeSessionId: 'sdk-old',
      transcriptExists: true,
      onInvalidResumeSession: clear,
    });
    await h.handle.send({ type: 'user', content: 'hello once' });
    h.streams[0].fail(new Error('HTTP 404 from upstream gateway'));
    await h.collected;

    expect(clear).not.toHaveBeenCalled();
    expect(h.queryOptions).toHaveLength(1);
    expect(h.events.find((event) => event.type === 'error')?.data).toMatchObject({
      reason: 'sdk_stream_crashed',
      isTerminal: true,
    });
  });

  it('releases a non-resume is_error result after the short correlation window', async () => {
    const clear = vi.fn(async () => true);
    const h = await startHarness({
      resumeSessionId: 'sdk-valid',
      transcriptExists: true,
      onInvalidResumeSession: clear,
    });
    await h.handle.send({ type: 'user', content: 'hello once' });
    h.streams[0].emit({
      type: 'result',
      is_error: true,
      result: 'rate limit reached',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    await waitForDone(h.events);

    expect(clear).not.toHaveBeenCalled();
    expect(h.queryOptions).toHaveLength(1);
    expect(h.events.find((event) => event.type === 'error')?.data).toMatchObject({
      message: 'rate limit reached',
      isTerminal: true,
    });
    await h.handle.close();
    h.streams[0].end();
    await h.collected;
  });

  it('uses the same one-shot fresh fallback for remote Claude sessions', async () => {
    const workingDir = await makeTempDir();
    const streams = [createControlledStream(), createControlledStream()];
    const queries = streams.map((stream) => ({
      ...createFakeQuery(stream),
      send: vi.fn(async () => {}),
    }));
    const startParams: Array<Record<string, unknown>> = [];
    const remoteCcQueryFactory = vi.fn(async (options: { startParams: Record<string, unknown> }) => {
      startParams.push(options.startParams);
      return queries[startParams.length - 1] as never;
    });
    const clear = vi.fn(async () => true);
    const agent = new ClaudeCodeAgent(
      createDeps({
        runtimeConfig: { remoteEndpoint: 'https://gateway.example' },
        remoteCcQueryFactory,
      }),
    );
    const handle = await agent.startSession({
      sessionId: 'remote-local-session',
      remoteHostId: 'remote-host',
      model: 'claude-opus-4-6',
      workingDir,
      permissionMode: 'acceptEdits',
      resumeSessionId: 'remote-sdk-old',
      onInvalidResumeSession: clear,
    });
    const events: AgentEvent[] = [];
    const collected = (async () => {
      for await (const event of handle.events()) events.push(event);
    })();

    await handle.send({ type: 'user', content: 'remote hello' });
    await vi.waitFor(() => expect(queries[0].send).toHaveBeenCalledTimes(1));
    streams[0].fail(new Error('No conversation found with session ID: remote-sdk-old'));
    await vi.waitFor(() => expect(remoteCcQueryFactory).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(queries[1].send).toHaveBeenCalledTimes(1));
    streams[1].emit({
      type: 'system',
      subtype: 'init',
      session_id: 'remote-sdk-new',
    });
    streams[1].emit({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'remote recovered' }] },
      session_id: 'remote-sdk-new',
    });
    streams[1].emit({
      type: 'result',
      is_error: false,
      result: 'remote recovered',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await waitForDone(events);

    expect(clear).toHaveBeenCalledTimes(1);
    expect(startParams[0]).toHaveProperty('resumeSdkSessionId', 'remote-sdk-old');
    expect(startParams[1]).not.toHaveProperty('resumeSdkSessionId');
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
    await handle.close();
    streams[1].end();
    await collected;
  });
});
