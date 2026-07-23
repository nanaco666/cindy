/**
 * nodeRuntimeBroker — 随意识安装的本地 Node 工作进程守门与 stdio 中继。
 *
 * 安全边界：
 * - 只执行已安装目录内、ghost.json 明确声明的单个 JS 入口；无 command / args / shell；
 * - 子进程拥有当前系统用户级本机权限，绝不把它描述成系统沙箱；
 * - 子进程只有 JSON-RPC stdio，不能直接拿到 Cindy IPC。所有 Cindy 能力仍须
 *   Node → main.js → contextBridge → 主机，并再次经过对应 slot 守门；
 * - 一段启用的意识最多一个 Node 进程，多会话复用；按需启动、闲置关闭，
 *   停用/更新/卸载/主机退出时由上层 stop；
 * - MCP 只开放 client→server 调用。server 反向请求 Cindy 能力恒回 -32601。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type {
  GhostPipeEventPush,
  GhostPipeNodeResult,
  InstalledGhost,
} from '../../shared/ghost.js';

const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const MAX_PENDING_REQUESTS = 32;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_STDIO_LINE_BYTES = 1024 * 1024;
const MCP_PROTOCOL_VERSION = '2025-06-18';

interface NodeWorkerReadable {
  on(event: 'data', listener: (chunk: Buffer | string) => void): this;
}

interface NodeWorkerWritable {
  destroyed?: boolean;
  write(chunk: string): boolean;
}

/** 生产使用 ChildProcessWithoutNullStreams；最小接口便于纯单测注入假进程。 */
export interface NodeWorkerProcess {
  stdin: NodeWorkerWritable;
  stdout: NodeWorkerReadable;
  stderr: NodeWorkerReadable;
  pid?: number;
  killed?: boolean;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  once(event: 'spawn', listener: () => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface GhostNodeRuntimeBrokerDeps {
  getGhost(id: string): InstalledGhost | null;
  spawnProcess?: (entryPath: string, cwd: string, ghostId: string) => NodeWorkerProcess;
  sendToGhost?: (ghostId: string, payload: GhostPipeEventPush) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  log?: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

interface PendingRpc {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface WorkerEntry {
  ghost: InstalledGhost;
  child: NodeWorkerProcess;
  /** stdout 的 UTF-8 字节可能把一个汉字切在两个 chunk 之间，必须流式解码。 */
  stdoutDecoder: StringDecoder;
  stdoutBuffer: string;
  nextId: number;
  pending: Map<string, PendingRpc>;
  idleTimer: NodeJS.Timeout | null;
  mcpInitPromise: Promise<void> | null;
  stopping: boolean;
}

class NodeRpcError extends Error {
  constructor(
    readonly kind: 'exit' | 'protocol' | 'timeout' | 'remote',
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

function defaultSpawnProcess(entryPath: string, cwd: string, ghostId: string): NodeWorkerProcess {
  // 不继承 API key / token 等宿主环境变量。Node 本身仍有用户级本机权限，
  // 这里只是在“无意泄露宿主秘密”和“系统运行必需变量”之间取最小集合。
  const inheritedKeys = [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
  ] as const;
  const env: NodeJS.ProcessEnv = {
    ELECTRON_RUN_AS_NODE: '1',
    CINDY_GHOST_ID: ghostId,
  };
  for (const key of inheritedKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return spawn(process.execPath, [entryPath], {
    cwd,
    env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }) as NodeWorkerProcess;
}

function errorResult(
  errorCode: Extract<GhostPipeNodeResult, { ok: false }>['errorCode'],
  message: string,
  data?: unknown,
): GhostPipeNodeResult {
  return { ok: false, errorCode, message, ...(data !== undefined ? { data } : {}) };
}

/** 每意识一个本地 Node 工作进程的生命周期与 JSON-RPC stdio 中继。 */
export class GhostNodeRuntimeBroker {
  private readonly workers = new Map<string, WorkerEntry>();

  constructor(private readonly deps: GhostNodeRuntimeBrokerDeps) {}

  stateOf(ghostId: string): 'off' | 'running' {
    return this.workers.has(ghostId) ? 'running' : 'off';
  }

  /** resident 档在插件启用/启动时调用；按需档保持零进程。 */
  async startResident(ghost: InstalledGhost): Promise<void> {
    if (!ghost.enabled || ghost.manifest.node?.lifecycle !== 'resident') return;
    const entry = await this.ensureWorker(ghost);
    if (ghost.manifest.node.protocol === 'mcp-stdio') await this.ensureMcpInitialized(entry);
  }

  /** main.js 的 node-request 入口。 */
  async handleRequest(ghostId: string, payload: unknown): Promise<GhostPipeNodeResult> {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost?.enabled || !ghost.manifest.slots.includes('node') || !ghost.manifest.node) {
      return errorResult('PERMISSION_DENIED', '插件未申请本地 Node 权限，或当前未启用');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return errorResult('INVALID_REQUEST', 'node-request 载荷必须是对象');
    }
    const request = payload as Record<string, unknown>;
    if (request.type !== 'node-request') {
      return errorResult('INVALID_REQUEST', '请求类型必须是 node-request');
    }
    if (
      typeof request.method !== 'string' ||
      !/^[A-Za-z0-9_./:-]{1,128}$/.test(request.method)
    ) {
      return errorResult('INVALID_REQUEST', 'method 必须是 1–128 位安全方法名');
    }
    if (
      request.timeoutMs !== undefined &&
      (typeof request.timeoutMs !== 'number' ||
        !Number.isInteger(request.timeoutMs) ||
        request.timeoutMs < 1_000 ||
        request.timeoutMs > MAX_REQUEST_TIMEOUT_MS)
    ) {
      return errorResult('INVALID_REQUEST', 'timeoutMs 必须是 1000–120000 的整数');
    }
    let paramsJson: string;
    try {
      paramsJson = JSON.stringify(request.params ?? null);
    } catch {
      return errorResult('INVALID_REQUEST', 'params 必须可以转换成 JSON');
    }
    if (Buffer.byteLength(paramsJson, 'utf8') > MAX_REQUEST_BYTES) {
      return errorResult('INVALID_REQUEST', `params 不能超过 ${MAX_REQUEST_BYTES} 字节`);
    }

    let entry: WorkerEntry;
    try {
      entry = await this.ensureWorker(ghost);
    } catch (error) {
      return errorResult(
        'PROCESS_START_FAILED',
        error instanceof Error ? error.message : 'Node 工作进程启动失败',
      );
    }
    if (entry.pending.size >= MAX_PENDING_REQUESTS) {
      return errorResult('RATE_LIMITED', '这个插件同时等待的 Node 请求太多');
    }

    try {
      if (ghost.manifest.node.protocol === 'mcp-stdio') {
        if (request.method === 'initialize' || request.method === 'notifications/initialized') {
          return errorResult('INVALID_REQUEST', 'MCP 初始化由 Cindy 主机统一管理');
        }
        await this.ensureMcpInitialized(entry);
      }
      const result = await this.sendRpc(
        entry,
        request.method,
        request.params ?? null,
        (request.timeoutMs as number | undefined) ?? DEFAULT_REQUEST_TIMEOUT_MS,
      );
      return { ok: true, result };
    } catch (error) {
      if (error instanceof NodeRpcError) {
        if (error.kind === 'timeout') return errorResult('TIMEOUT', error.message);
        if (error.kind === 'exit') return errorResult('PROCESS_EXITED', error.message);
        return errorResult('PROTOCOL_ERROR', error.message, error.data);
      }
      return errorResult('INTERNAL', error instanceof Error ? error.message : String(error));
    } finally {
      this.scheduleIdleStop(entry);
    }
  }

  /** 停用、更新或卸载一个插件时立即停止其 Node。 */
  stop(ghostId: string): void {
    const entry = this.workers.get(ghostId);
    if (!entry) return;
    entry.stopping = true;
    this.workers.delete(ghostId);
    this.clearIdleTimer(entry);
    for (const pending of entry.pending.values()) {
      this.clearTimer(pending.timer);
      pending.reject(new NodeRpcError('exit', 'Node 工作进程已停止'));
    }
    entry.pending.clear();
    try {
      entry.child.kill('SIGTERM');
      const hardKill = this.setTimer(() => {
        try {
          // ChildProcess.killed 只表示“发过信号”，不代表真的退出；两秒后无条件
          // 再发 SIGKILL，已退出进程会安全返回 false。
          entry.child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, 2_000);
      hardKill.unref?.();
    } catch {
      // 已退出即视为停止成功。
    }
    this.sendStatus(ghostId, 'stopped');
  }

  /** Cindy 退出时收掉全部随包 Node 进程。 */
  destroyAll(): void {
    for (const ghostId of [...this.workers.keys()]) this.stop(ghostId);
  }

  private async ensureWorker(ghost: InstalledGhost): Promise<WorkerEntry> {
    const existing = this.workers.get(ghost.manifest.id);
    if (existing) return existing;
    const node = ghost.manifest.node;
    if (!node) throw new Error('ghost.json 缺少 node 工作进程详单');

    const entryPath = path.resolve(ghost.dir, ...node.entry.split('/'));
    const root = path.resolve(ghost.dir);
    if (entryPath === root || !entryPath.startsWith(`${root}${path.sep}`)) {
      throw new Error('node.entry 越出插件安装目录');
    }
    this.sendStatus(ghost.manifest.id, 'starting');
    let child: NodeWorkerProcess;
    try {
      child = (this.deps.spawnProcess ?? defaultSpawnProcess)(entryPath, root, ghost.manifest.id);
    } catch (error) {
      this.sendStatus(ghost.manifest.id, 'crashed', error instanceof Error ? error.message : String(error));
      throw error;
    }
    const entry: WorkerEntry = {
      ghost,
      child,
      stdoutDecoder: new StringDecoder('utf8'),
      stdoutBuffer: '',
      nextId: 1,
      pending: new Map(),
      idleTimer: null,
      mcpInitPromise: null,
      stopping: false,
    };
    this.workers.set(ghost.manifest.id, entry);
    child.stdout.on('data', (chunk) => this.handleStdout(entry, chunk));
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim().slice(0, 4_096);
      if (text) this.deps.log?.warn('ghost node stderr', { ghostId: ghost.manifest.id, text });
    });
    child.on('exit', (code, signal) => this.handleExit(entry, code, signal, null));
    child.on('error', (error) => this.handleExit(entry, null, null, error));

    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
        child.once('exit', (code, signal) => {
          reject(new Error(`Node 工作进程启动前退出(code=${code}, signal=${signal ?? 'none'})`));
        });
      });
    } catch (error) {
      if (this.workers.get(ghost.manifest.id) === entry) this.workers.delete(ghost.manifest.id);
      try {
        child.kill('SIGKILL');
      } catch {
        // no-op
      }
      throw error;
    }
    this.deps.log?.info('ghost node process started', {
      ghostId: ghost.manifest.id,
      pid: child.pid,
      protocol: node.protocol,
    });
    this.sendStatus(ghost.manifest.id, 'running');
    this.scheduleIdleStop(entry);
    return entry;
  }

  private async ensureMcpInitialized(entry: WorkerEntry): Promise<void> {
    if (!entry.mcpInitPromise) {
      entry.mcpInitPromise = this.sendRpc(
        entry,
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'Cindy', version: '1' },
        },
        10_000,
      ).then(() => {
        this.writeLine(entry, {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
          params: {},
        });
      });
      entry.mcpInitPromise.catch(() => {
        entry.mcpInitPromise = null;
      });
    }
    await entry.mcpInitPromise;
  }

  private sendRpc(
    entry: WorkerEntry,
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    this.clearIdleTimer(entry);
    const id = String(entry.nextId++);
    return new Promise((resolve, reject) => {
      const timer = this.setTimer(() => {
        entry.pending.delete(id);
        reject(new NodeRpcError('timeout', `Node 请求 ${method} 等待超时`));
        this.scheduleIdleStop(entry);
      }, timeoutMs);
      timer.unref?.();
      entry.pending.set(id, { resolve, reject, timer });
      try {
        this.writeLine(entry, { jsonrpc: '2.0', id, method, params });
      } catch (error) {
        entry.pending.delete(id);
        this.clearTimer(timer);
        reject(error);
      }
    });
  }

  private writeLine(entry: WorkerEntry, message: Record<string, unknown>): void {
    if (entry.child.stdin.destroyed) throw new NodeRpcError('exit', 'Node stdin 已关闭');
    entry.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(entry: WorkerEntry, chunk: Buffer | string): void {
    if (this.workers.get(entry.ghost.manifest.id) !== entry) return;
    entry.stdoutBuffer += entry.stdoutDecoder.write(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'),
    );
    for (;;) {
      const newline = entry.stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = entry.stdoutBuffer.slice(0, newline).trim();
      entry.stdoutBuffer = entry.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.failProtocol(entry, 'Node stdout 不是合法的逐行 JSON-RPC');
        return;
      }
      this.handleRpcMessage(entry, message);
      if (this.workers.get(entry.ghost.manifest.id) !== entry) return;
    }
    // 只限制“还没遇到换行的一条消息”，同一 chunk 里很多合法短消息不会误伤。
    if (Buffer.byteLength(entry.stdoutBuffer, 'utf8') > MAX_STDIO_LINE_BYTES) {
      this.failProtocol(entry, 'Node stdout 单行超过 1MB');
    }
  }

  private handleRpcMessage(entry: WorkerEntry, message: unknown): void {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.failProtocol(entry, 'Node 返回的 JSON-RPC 消息必须是对象');
      return;
    }
    const msg = message as Record<string, unknown>;
    if (msg.jsonrpc !== '2.0') {
      this.failProtocol(entry, 'Node 返回的消息缺少 jsonrpc: "2.0"');
      return;
    }
    if (msg.id !== undefined && typeof msg.method !== 'string') {
      const pending = entry.pending.get(String(msg.id));
      if (!pending) return; // 迟到或未知 response，静默丢弃。
      entry.pending.delete(String(msg.id));
      this.clearTimer(pending.timer);
      if (msg.error && typeof msg.error === 'object') {
        const rpcError = msg.error as Record<string, unknown>;
        pending.reject(
          new NodeRpcError(
            'remote',
            typeof rpcError.message === 'string' ? rpcError.message : 'Node JSON-RPC 返回错误',
            rpcError.data,
          ),
        );
      } else if ('result' in msg) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new NodeRpcError('protocol', 'Node response 同时缺少 result 与 error'));
      }
      this.scheduleIdleStop(entry);
      return;
    }
    if (typeof msg.method === 'string' && msg.id !== undefined) {
      // MCP server→client 反向请求不接 Cindy 能力，明确回“不支持”。这条是
      // Node 不能直接控制 Cindy 的代码边界，不靠作者自觉。
      this.writeLine(entry, {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Cindy host does not expose reverse RPC methods' },
      });
      return;
    }
    if (typeof msg.method === 'string') {
      this.deps.sendToGhost?.(entry.ghost.manifest.id, {
        type: 'event',
        name: 'node-notification',
        method: msg.method,
        ...('params' in msg ? { params: msg.params } : {}),
        ts: this.now(),
      });
      return;
    }
    this.failProtocol(entry, '无法识别 Node JSON-RPC 消息');
  }

  private failProtocol(entry: WorkerEntry, message: string): void {
    for (const pending of entry.pending.values()) {
      this.clearTimer(pending.timer);
      pending.reject(new NodeRpcError('protocol', message));
    }
    entry.pending.clear();
    this.deps.log?.warn('ghost node protocol failed', {
      ghostId: entry.ghost.manifest.id,
      message,
    });
    try {
      entry.child.kill('SIGKILL');
    } catch {
      // exit handler still converges state when available
    }
  }

  private handleExit(
    entry: WorkerEntry,
    code: number | null,
    signal: string | null,
    error: Error | null,
  ): void {
    const ghostId = entry.ghost.manifest.id;
    if (this.workers.get(ghostId) !== entry) return;
    this.workers.delete(ghostId);
    this.clearIdleTimer(entry);
    const detail = error?.message ?? `code=${code}, signal=${signal ?? 'none'}`;
    for (const pending of entry.pending.values()) {
      this.clearTimer(pending.timer);
      pending.reject(new NodeRpcError('exit', `Node 工作进程已退出(${detail})`));
    }
    entry.pending.clear();
    if (!entry.stopping) {
      this.deps.log?.warn('ghost node process exited', { ghostId, detail });
      this.sendStatus(ghostId, 'crashed', detail);
    }
  }

  private scheduleIdleStop(entry: WorkerEntry): void {
    if (this.workers.get(entry.ghost.manifest.id) !== entry) return;
    if (entry.ghost.manifest.node?.lifecycle === 'resident' || entry.pending.size > 0) return;
    this.clearIdleTimer(entry);
    const timeoutMs =
      (entry.ghost.manifest.node?.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_MS / 1_000) * 1_000;
    entry.idleTimer = this.setTimer(() => this.stop(entry.ghost.manifest.id), timeoutMs);
    entry.idleTimer.unref?.();
  }

  private clearIdleTimer(entry: WorkerEntry): void {
    if (!entry.idleTimer) return;
    this.clearTimer(entry.idleTimer);
    entry.idleTimer = null;
  }

  private sendStatus(
    ghostId: string,
    state: 'starting' | 'running' | 'stopped' | 'crashed',
    message?: string,
  ): void {
    this.deps.sendToGhost?.(ghostId, {
      type: 'event',
      name: 'node-status',
      state,
      ...(message ? { message } : {}),
      ts: this.now(),
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private setTimer(callback: () => void, delayMs: number): NodeJS.Timeout {
    if (this.deps.setTimer) return this.deps.setTimer(callback, delayMs);
    return setTimeout(callback, delayMs) as NodeJS.Timeout;
  }

  private clearTimer(timer: NodeJS.Timeout): void {
    if (this.deps.clearTimer) this.deps.clearTimer(timer);
    else clearTimeout(timer);
  }
}
