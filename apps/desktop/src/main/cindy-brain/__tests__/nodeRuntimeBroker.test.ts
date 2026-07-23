/** nodeRuntimeBroker.test — 随包 Node / MCP stdio 中继的纯进程假体单测。 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import {
  GhostNodeRuntimeBroker,
  type NodeWorkerProcess,
} from '../nodeRuntimeBroker';

class FakeNodeProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 1234;
  killed = false;
  received: Array<Record<string, unknown>> = [];
  private inputBuffer = '';

  constructor(private readonly onMessage?: (message: Record<string, unknown>) => void) {
    super();
    this.stdin.on('data', (chunk) => {
      this.inputBuffer += String(chunk);
      for (;;) {
        const newline = this.inputBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = this.inputBuffer.slice(0, newline);
        this.inputBuffer = this.inputBuffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        this.received.push(message);
        this.onMessage?.(message);
      }
    });
    queueMicrotask(() => this.emit('spawn'));
  }

  send(message: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', null, signal ?? 'SIGTERM'));
    return true;
  }
}

function fakeGhost(
  options: { protocol?: 'json-rpc-stdio' | 'mcp-stdio'; lifecycle?: 'on-demand' | 'resident' } = {},
): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'node-ghost',
      name: 'Node Ghost',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['node'],
      node: {
        entry: 'node/worker.cjs',
        protocol: options.protocol ?? 'json-rpc-stdio',
        ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
      },
    },
    dir: '/fake/node-ghost',
    enabled: true,
  } as InstalledGhost;
}

function rpcRequest(method = 'echo', params: unknown = { value: 1 }) {
  return { type: 'node-request', method, params };
}

function makeAutoReplyProcess(methods?: string[]) {
  const process = new FakeNodeProcess((message) => {
    if (typeof message.method === 'string') methods?.push(message.method);
    if (message.id !== undefined && typeof message.method === 'string') {
      queueMicrotask(() =>
        process.send({
          jsonrpc: '2.0',
          id: message.id,
          result: { method: message.method, params: message.params },
        }),
      );
    }
  });
  return process;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('nodeRuntimeBroker · 进程生命周期', () => {
  it('第一次请求才启动，同一插件后续请求复用同一个进程', async () => {
    const ghost = fakeGhost();
    const children: FakeNodeProcess[] = [];
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => {
        const child = makeAutoReplyProcess();
        children.push(child);
        return child as unknown as NodeWorkerProcess;
      },
    });

    expect(broker.stateOf('node-ghost')).toBe('off');
    expect(await broker.handleRequest('node-ghost', rpcRequest('first'))).toMatchObject({
      ok: true,
      result: { method: 'first' },
    });
    expect(await broker.handleRequest('node-ghost', rpcRequest('second'))).toMatchObject({
      ok: true,
      result: { method: 'second' },
    });
    expect(children).toHaveLength(1);
    expect(broker.stateOf('node-ghost')).toBe('running');
    broker.destroyAll();
  });

  it('停用式 stop 立即拒绝在途请求并关闭进程', async () => {
    const ghost = fakeGhost();
    const child = new FakeNodeProcess(); // 不回 response，保持在途
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest('slow'));
    await vi.waitFor(() => expect(child.received).toHaveLength(1));
    broker.stop('node-ghost');
    expect(await pending).toMatchObject({ ok: false, errorCode: 'PROCESS_EXITED' });
    expect(child.killed).toBe(true);
    expect(broker.stateOf('node-ghost')).toBe('off');
  });

  it('按需进程空闲两分钟后自动关闭', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost();
    const child = makeAutoReplyProcess();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest());
    await vi.runAllTicks();
    await expect(pending).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(child.killed).toBe(true);
    expect(broker.stateOf('node-ghost')).toBe('off');
  });

  it('resident 档可提前启动且不会设置空闲关闭', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost({ lifecycle: 'resident' });
    const child = makeAutoReplyProcess();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });

    await broker.startResident(ghost);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(child.killed).toBe(false);
    expect(broker.stateOf('node-ghost')).toBe('running');
    broker.destroyAll();
  });
});

describe('nodeRuntimeBroker · 权限与协议', () => {
  it('没声明 node 槽时拒绝且不启动进程', async () => {
    const ghost = fakeGhost();
    ghost.manifest.slots = ['card'];
    const spawnProcess = vi.fn();
    const broker = new GhostNodeRuntimeBroker({ getGhost: () => ghost, spawnProcess });

    expect(await broker.handleRequest('node-ghost', rpcRequest())).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('mcp-stdio 由主机先 initialize，再发送 initialized 通知和业务方法', async () => {
    const methods: string[] = [];
    const ghost = fakeGhost({ protocol: 'mcp-stdio' });
    const child = makeAutoReplyProcess(methods);
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });

    const result = await broker.handleRequest('node-ghost', rpcRequest('tools/list', {}));
    expect(result.ok).toBe(true);
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    const init = child.received[0];
    expect(init).toMatchObject({
      method: 'initialize',
      params: { clientInfo: { name: 'Cindy' } },
    });
    broker.destroyAll();
  });

  it('Node notification 只转交给 main.js；反向 RPC 请求 Cindy 恒回 -32601', async () => {
    const events: unknown[] = [];
    const ghost = fakeGhost();
    const child = makeAutoReplyProcess();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
      sendToGhost: (_id, event) => events.push(event),
      now: () => 99,
    });
    await broker.handleRequest('node-ghost', rpcRequest());

    child.send({ jsonrpc: '2.0', method: 'progress', params: { pct: 50 } });
    child.send({ jsonrpc: '2.0', id: 'server-1', method: 'sampling/createMessage', params: {} });
    await vi.waitFor(() =>
      expect(child.received).toContainEqual(
        expect.objectContaining({
          id: 'server-1',
          error: { code: -32601, message: expect.any(String) },
        }),
      ),
    );
    expect(events).toContainEqual({
      type: 'event',
      name: 'node-notification',
      method: 'progress',
      params: { pct: 50 },
      ts: 99,
    });
    broker.destroyAll();
  });

  it('非法 stdout 会终止进程并返回协议错误，不会拖垮主机', async () => {
    const ghost = fakeGhost();
    const child = new FakeNodeProcess();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest());
    await vi.waitFor(() => expect(child.received).toHaveLength(1));
    child.stdout.write('not-json\n');
    expect(await pending).toMatchObject({ ok: false, errorCode: 'PROTOCOL_ERROR' });
    expect(child.killed).toBe(true);
  });

  it('UTF-8 汉字被拆在两个 stdout chunk 时仍能完整解析', async () => {
    const ghost = fakeGhost();
    const child = new FakeNodeProcess();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest());
    await vi.waitFor(() => expect(child.received).toHaveLength(1));
    const line = Buffer.from(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: child.received[0].id,
        result: { text: '中文结果' },
      })}\n`,
      'utf8',
    );
    const firstChineseByte = line.indexOf(Buffer.from('中'));
    child.stdout.write(line.subarray(0, firstChineseByte + 1));
    child.stdout.write(line.subarray(firstChineseByte + 1));

    await expect(pending).resolves.toMatchObject({
      ok: true,
      result: { text: '中文结果' },
    });
    broker.destroyAll();
  });
});
