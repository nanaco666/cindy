/**
 * CompanionHost 单元测试。
 *
 * 所有 I/O 均通过注入依赖替换为内存 fake 或真实 unix socket（os.tmpdir() 下）。
 * 不依赖 Electron 模块、不写仓库工作区（仓规红线 23）。
 *
 * 覆盖点：
 *   - 安装指纹对比（已最新 / 不一致 / 未安装）与原子替换
 *   - start() 握手成功路径
 *   - start() 超时失败路径
 *   - 复用已运行实例（socket 已通）
 *   - stop() 正常 shutdown + 兜底 kill
 *   - 心跳失联发 'disconnected'
 *   - daemon-status 事件转发
 *   - 非 darwin no-op
 */

import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CompanionHost, type CompanionHostDeps } from '../CompanionHost.js';

// ── fake logger ───────────────────────────────────────────────────────────────

function makeFakeLogger() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
}

// ── 内存 fake FS ──────────────────────────────────────────────────────────────

/**
 * 极简内存文件系统，供测试替换真实 fs。
 * existsSync / readFileSync 按 store 内容响应；
 * mkdirSync / renameSync / rmSync / unlinkSync / copyFileSync 记录调用供断言。
 */
function makeFakeFs(files: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(files));
  return {
    store,
    existsSync: vi.fn((p: string) => store.has(p)),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    readFileSync: vi.fn((p: string, _enc: string) => {
      if (!store.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return store.get(p)!;
    }),
    mkdirSync: vi.fn(),
    renameSync: vi.fn((from: string, to: string) => {
      const val = store.get(from) ?? '';
      store.set(to, val);
      store.delete(from);
    }),
    rmSync: vi.fn((p: string) => { store.delete(p); }),
    unlinkSync: vi.fn((p: string) => { store.delete(p); }),
    copyFileSync: vi.fn(),
  };
}

// ── 测试用临时目录工厂 ─────────────────────────────────────────────────────────

/**
 * 全局临时目录注册表，供 afterEach 统一清理，防止用例崩溃时残留文件影响后续用例。
 */
const tmpDirsToCleanup: string[] = [];

afterEach(() => {
  // 清理所有本次用例创建的临时目录
  for (const d of tmpDirsToCleanup) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirsToCleanup.length = 0;
});

/**
 * 用 fs.mkdtempSync 在 /tmp（硬前缀，规避 macOS os.tmpdir() 的长符号链接路径）
 * 下创建唯一临时目录，确保 installDir/companion.sock 总长 ≤ 104 字节
 * （unix socket 路径上限；macOS os.tmpdir() → /private/var/folders/... 很容易超限
 * 导致 server.listen 报 EINVAL，是之前 flake 的 root cause）。
 *
 * 创建的目录自动注册到 tmpDirsToCleanup，在 afterEach 中被清理。
 */
function makeTmpInstallDir(): string {
  // /tmp 在 macOS 是指向 /private/tmp 的符号链接，实际路径短，不超限
  const dir = fs.mkdtempSync('/tmp/cpn-');
  tmpDirsToCleanup.push(dir);
  return dir;
}

// ── 真实 unix socket 服务器（监听指定 sockPath） ──────────────────────────────

/**
 * 在给定 sockPath 启动 net.Server（所有方均在 /tmp 下，仓规红线 23）。
 * 连接建立后按选项发送 hello 消息。
 *
 * P2 flake 修复：listen 前清理残留 socket 文件（前次测试崩溃可能留下同名文件
 * 导致下次 listen 报 EADDRINUSE）。
 */
async function startFakeCompanionServer(
  sockPath: string,
  opts: {
    fingerprint?: string;
    pid?: number;
    sendHello?: boolean;
    helloDelay?: number;
    /** 连接建立后额外写入的消息（与 hello 在同一 write 调用，用于测试 P1-2） */
    extraMessages?: string[];
  } = {},
): Promise<{
  server: net.Server;
  connections: net.Socket[];
  close: () => Promise<void>;
}> {
  const connections: net.Socket[] = [];

  const server = net.createServer((sock) => {
    connections.push(sock);
    // 默认：收到 shutdown 就关闭连接，让 stop() 的 waitForSocketClose 能快速完成
    sock.setEncoding('utf8');
    let recvBuf = '';
    sock.on('data', (data: string) => {
      recvBuf += data;
      let nl = recvBuf.indexOf('\n');
      while (nl >= 0) {
        const line = recvBuf.slice(0, nl).trim();
        recvBuf = recvBuf.slice(nl + 1);
        if (line) {
          try {
            const msg = JSON.parse(line) as { type: string };
            if (msg.type === 'shutdown') { sock.destroy(); }
          } catch { /* ignore */ }
        }
        nl = recvBuf.indexOf('\n');
      }
    });

    if (opts.sendHello !== false) {
      const hello = JSON.stringify({
        type: 'hello',
        protocolVersion: 1,
        companionFingerprint: opts.fingerprint ?? 'fp-abc123',
        pid: opts.pid ?? 99999,
      });
      const sendIt = () => {
        if (opts.extraMessages && opts.extraMessages.length > 0) {
          // P1-2 测试：将 hello 与 extraMessages 写入同一个 write() 调用，
          // 确保它们落在同一个 TCP/socket chunk 里，触发 buffer 共享场景。
          const payload = [hello, ...opts.extraMessages].map((m) => `${m}\n`).join('');
          sock.write(payload);
        } else {
          sock.write(`${hello}\n`);
        }
      };
      if (opts.helloDelay) {
        setTimeout(sendIt, opts.helloDelay);
      } else {
        setImmediate(sendIt);
      }
    }
  });

  // 确保目录存在，并清理可能存在的残留 socket 文件（防 EADDRINUSE flake）
  fs.mkdirSync(path.dirname(sockPath), { recursive: true });
  try { fs.unlinkSync(sockPath); } catch { /* not exists, fine */ }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return {
    server,
    connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of connections) c.destroy();
        server.close(() => {
          // 清理 socket 文件
          try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
          resolve();
        });
      }),
  };
}

// ── real connectSocket helper ──────────────────────────────────────────────────

function realConnectSocket(sockPath: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const s = net.createConnection({ path: sockPath });
    s.once('connect', () => { s.removeAllListeners('error'); resolve(s); });
    s.once('error', () => { s.destroy(); resolve(null); });
  });
}

// ── deps factory ──────────────────────────────────────────────────────────────

/**
 * 构建可注入依赖集合，全 fake，不触碰真实文件系统。
 * installDir 可指定，供测试精确控制 sock 路径。
 */
function makeDeps(overrides: Partial<CompanionHostDeps> = {}): CompanionHostDeps {
  const rest = overrides;
  return {
    platform: 'darwin',
    isPackaged: () => false,
    getResourcesCompanionPath: () => '/fake-resources/Cindy Computer Use.app',
    getInstallDir: () => makeTmpInstallDir(),
    getBuildScriptPath: () => '/fake/scripts/build-computer-use-companion.mjs',
    fs: makeFakeFs() as unknown as CompanionHostDeps['fs'],
    copyBundle: vi.fn(async () => {}),
    runBuildScript: vi.fn(async () => '/fake-resources/Cindy Computer Use.app'),
    openApp: vi.fn(async () => {}),
    connectSocket: vi.fn(async () => null),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    logger: makeFakeLogger(),
    ...rest,
  };
}

// ── 辅助：构建 fs fake 使 bundle 已匹配安装 ───────────────────────────────────

function makeMatchingFsWithBundles(
  resourcesBundle: string,
  installBundle: string,
  fingerprint: string,
) {
  const fp = `${fingerprint}\n`;
  const fakeFs = makeFakeFs({
    [`${resourcesBundle}/Contents/Resources/.build-fingerprint`]: fp,
    [`${installBundle}/Contents/Resources/.build-fingerprint`]: fp,
  });
  fakeFs.existsSync.mockImplementation((p: string) => {
    if (p === resourcesBundle || p === installBundle) return true;
    return fakeFs.store.has(p);
  });
  return fakeFs;
}

// ── 测试套件 ──────────────────────────────────────────────────────────────────

describe('CompanionHost — non-darwin no-op', () => {
  it('ensureInstalled returns not-supported on non-darwin', async () => {
    const host = new CompanionHost(makeDeps({ platform: 'win32' }));
    const result = await host.ensureInstalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not-supported');
  });

  it('start returns not-supported on non-darwin', async () => {
    const host = new CompanionHost(makeDeps({ platform: 'win32' }));
    const result = await host.start();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not-supported');
  });

  it('stop is no-op on non-darwin', async () => {
    await expect(new CompanionHost(makeDeps({ platform: 'win32' })).stop()).resolves.toBeUndefined();
  });
});

describe('CompanionHost — ensureInstalled', () => {
  it('skips install when fingerprint matches', async () => {
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installDir = makeTmpInstallDir();
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');
    const fakeFs = makeMatchingFsWithBundles(resourcesBundle, installBundle, 'fp-xyz');

    const deps = makeDeps({
      getResourcesCompanionPath: () => resourcesBundle,
      getInstallDir: () => installDir,
      fs: fakeFs as unknown as CompanionHostDeps['fs'],
    });

    const host = new CompanionHost(deps);
    expect((await host.ensureInstalled()).ok).toBe(true);
    expect(deps.copyBundle).not.toHaveBeenCalled();
  });

  it('performs atomic replace when fingerprint mismatches', async () => {
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installDir = makeTmpInstallDir();
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');
    const fakeFs = makeFakeFs({
      [`${resourcesBundle}/Contents/Resources/.build-fingerprint`]: 'fp-new\n',
      [`${installBundle}/Contents/Resources/.build-fingerprint`]: 'fp-old\n',
    });
    fakeFs.existsSync.mockImplementation((p: string) => {
      if (p === resourcesBundle || p === installBundle) return true;
      return fakeFs.store.has(p);
    });

    const deps = makeDeps({
      getResourcesCompanionPath: () => resourcesBundle,
      getInstallDir: () => installDir,
      fs: fakeFs as unknown as CompanionHostDeps['fs'],
    });

    expect((await new CompanionHost(deps).ensureInstalled()).ok).toBe(true);
    expect(deps.copyBundle).toHaveBeenCalledOnce();
    expect(fakeFs.renameSync).toHaveBeenCalledOnce();
    expect(fakeFs.rmSync).toHaveBeenCalledOnce();
    // 日志应提示 TCC 可能需重新授权
    const logger = deps.logger as ReturnType<typeof makeFakeLogger>;
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('TCC'), expect.any(Object));
  });

  it('installs when not yet installed', async () => {
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installDir = makeTmpInstallDir();
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');
    const fakeFs = makeFakeFs({
      [`${resourcesBundle}/Contents/Resources/.build-fingerprint`]: 'fp-new\n',
    });
    fakeFs.existsSync.mockImplementation((p: string) => {
      if (p === resourcesBundle) return true;
      if (p === installBundle) return false;
      return fakeFs.store.has(p);
    });

    const deps = makeDeps({
      getResourcesCompanionPath: () => resourcesBundle,
      getInstallDir: () => installDir,
      fs: fakeFs as unknown as CompanionHostDeps['fs'],
    });

    expect((await new CompanionHost(deps).ensureInstalled()).ok).toBe(true);
    expect(deps.copyBundle).toHaveBeenCalledOnce();
    expect(fakeFs.renameSync).toHaveBeenCalledOnce();
    expect(fakeFs.rmSync).not.toHaveBeenCalled();
  });

  it('returns failure when resources bundle missing', async () => {
    const fakeFs = makeFakeFs();
    fakeFs.existsSync.mockReturnValue(false);
    const deps = makeDeps({ fs: fakeFs as unknown as CompanionHostDeps['fs'] });
    expect((await new CompanionHost(deps).ensureInstalled()).ok).toBe(false);
  });

  it('runs build script in dev mode', async () => {
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installDir = makeTmpInstallDir();
    const fakeFs = makeFakeFs({
      [`${resourcesBundle}/Contents/Resources/.build-fingerprint`]: 'fp-v1\n',
    });
    fakeFs.existsSync.mockImplementation((p: string) => p === resourcesBundle || fakeFs.store.has(p));

    const deps = makeDeps({
      isPackaged: () => false,
      getResourcesCompanionPath: () => resourcesBundle,
      getInstallDir: () => installDir,
      fs: fakeFs as unknown as CompanionHostDeps['fs'],
    });

    await new CompanionHost(deps).ensureInstalled();
    expect(deps.runBuildScript).toHaveBeenCalledOnce();
  });

  it('does not run build script in packaged mode', async () => {
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installDir = makeTmpInstallDir();
    const fakeFs = makeFakeFs({
      [`${resourcesBundle}/Contents/Resources/.build-fingerprint`]: 'fp-v1\n',
    });
    fakeFs.existsSync.mockImplementation((p: string) => p === resourcesBundle || fakeFs.store.has(p));

    const deps = makeDeps({
      isPackaged: () => true,
      getResourcesCompanionPath: () => resourcesBundle,
      getInstallDir: () => installDir,
      fs: fakeFs as unknown as CompanionHostDeps['fs'],
    });

    await new CompanionHost(deps).ensureInstalled();
    expect(deps.runBuildScript).not.toHaveBeenCalled();
  });
});

describe('CompanionHost — start() handshake', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts and completes handshake successfully', async () => {
    const installDir = makeTmpInstallDir();
    const sockPath = path.join(installDir, 'companion.sock');
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');

    const fakeFs = makeMatchingFsWithBundles(resourcesBundle, installBundle, 'fp-ok');
    // sock 文件不存在（新启动）
    fakeFs.existsSync.mockImplementation((p: string) => {
      if (p === resourcesBundle || p === installBundle) return true;
      if (p === sockPath) return false;
      return fakeFs.store.has(p);
    });

    // 启动 fake server 监听 companion.sock
    const srv = await startFakeCompanionServer(sockPath, { fingerprint: 'fp-ok', pid: 12345 });

    try {
      const deps = makeDeps({
        getResourcesCompanionPath: () => resourcesBundle,
        getInstallDir: () => installDir,
        fs: fakeFs as unknown as CompanionHostDeps['fs'],
        // 第一次（probe 已运行实例）返回 null；之后真实连接
        connectSocket: vi.fn()
          .mockResolvedValueOnce(null)
          .mockImplementation((p: string) => realConnectSocket(p)),
        openApp: vi.fn(async () => {}),
      });

      const host = new CompanionHost(deps);
      const result = await host.start();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.handshake.pid).toBe(12345);
        expect(result.handshake.companionFingerprint).toBe('fp-ok');
        expect(result.handshake.protocolVersion).toBe(1);
        expect(result.handshake.reused).toBe(false);
      }
      await host.stop();
    } finally {
      await srv.close();
    }
  }, 10_000);

  it('reuses existing instance when socket already reachable', async () => {
    const installDir = makeTmpInstallDir();
    const sockPath = path.join(installDir, 'companion.sock');
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');

    const fakeFs = makeMatchingFsWithBundles(resourcesBundle, installBundle, 'fp-reuse');
    fakeFs.existsSync.mockImplementation((p: string) => {
      if (p === resourcesBundle || p === installBundle) return true;
      return fakeFs.store.has(p);
    });

    const srv = await startFakeCompanionServer(sockPath, { fingerprint: 'fp-reuse', pid: 55555 });

    try {
      const deps = makeDeps({
        getResourcesCompanionPath: () => resourcesBundle,
        getInstallDir: () => installDir,
        fs: fakeFs as unknown as CompanionHostDeps['fs'],
        // 首次 probe 直接成功（已运行实例）
        connectSocket: vi.fn().mockImplementation((p: string) => realConnectSocket(p)),
        openApp: vi.fn(async () => {}),
      });

      const host = new CompanionHost(deps);
      const result = await host.start();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.handshake.reused).toBe(true);
        expect(result.handshake.pid).toBe(55555);
      }
      // open -na 不应被调用（复用）
      expect(deps.openApp).not.toHaveBeenCalled();
      await host.stop();
    } finally {
      await srv.close();
    }
  }, 10_000);

  it('fails with timeout when hello never arrives', async () => {
    const installDir = makeTmpInstallDir();
    const sockPath = path.join(installDir, 'companion.sock');
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');

    const fakeFs = makeMatchingFsWithBundles(resourcesBundle, installBundle, 'fp-t');
    fakeFs.existsSync.mockImplementation((p: string) => {
      if (p === resourcesBundle || p === installBundle) return true;
      if (p === sockPath) return false;
      return fakeFs.store.has(p);
    });

    // 启动 server 但不发 hello
    const srv = await startFakeCompanionServer(sockPath, { sendHello: false });

    try {
      // 注入 fake setTimeout 使 waitForHello 立即超时
      const capturedCallbacks: Array<() => void> = [];
      const deps = makeDeps({
        getResourcesCompanionPath: () => resourcesBundle,
        getInstallDir: () => installDir,
        fs: fakeFs as unknown as CompanionHostDeps['fs'],
        connectSocket: vi.fn()
          .mockResolvedValueOnce(null)
          .mockImplementation((p: string) => realConnectSocket(p)),
        openApp: vi.fn(async () => {}),
        setTimeout: ((cb: () => void): ReturnType<typeof setTimeout> => {
          capturedCallbacks.push(cb);
          return 999 as unknown as ReturnType<typeof setTimeout>;
        }) as typeof globalThis.setTimeout,
        clearTimeout: ((): void => {}) as typeof globalThis.clearTimeout,
      });

      const host = new CompanionHost(deps);
      const startPromise = host.start();

      // 等连接建立与 data 监听器注册
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // 触发第一个捕获到的 hello 超时回调
      capturedCallbacks[0]?.();

      const result = await startPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/hello not received/i);
    } finally {
      await srv.close();
    }
  }, 15_000);

  it('fails when socket never becomes reachable', async () => {
    const installDir = makeTmpInstallDir();
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');

    const fakeFs = makeMatchingFsWithBundles(resourcesBundle, installBundle, 'fp-x');
    fakeFs.existsSync.mockImplementation((p: string) => {
      if (p === resourcesBundle || p === installBundle) return true;
      return fakeFs.store.has(p);
    });

    // connectSocket 始终返回 null
    const deps = makeDeps({
      getResourcesCompanionPath: () => resourcesBundle,
      getInstallDir: () => installDir,
      fs: fakeFs as unknown as CompanionHostDeps['fs'],
      connectSocket: vi.fn(async () => null),
      openApp: vi.fn(async () => {}),
    });

    // 让 Date.now() 快速超过 deadline
    const realNow = Date.now;
    let callCount = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount++;
      return callCount <= 1 ? realNow() : realNow() + 20_000;
    });

    const result = await new CompanionHost(deps).start();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not reachable/i);
  }, 5_000);
});

describe('CompanionHost — stop()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends shutdown and server receives it', async () => {
    const installDir = makeTmpInstallDir();
    const sockPath = path.join(installDir, 'companion.sock');
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');

    const fakeFs = makeMatchingFsWithBundles(resourcesBundle, installBundle, 'fp-stop');
    fakeFs.existsSync.mockImplementation((p: string) => {
      if (p === resourcesBundle || p === installBundle) return true;
      if (p === sockPath) return false;
      return fakeFs.store.has(p);
    });

    const receivedLines: string[] = [];
    const srv = await startFakeCompanionServer(sockPath, { pid: 77777 });
    // 在服务器侧记录收到的消息
    srv.server.on('connection', (conn) => {
      conn.setEncoding('utf8');
      conn.on('data', (data: string) => {
        receivedLines.push(...data.split('\n').filter(Boolean));
        // 收到 shutdown 后关闭连接，模拟 companion 正常退出
        if (receivedLines.some((l) => {
          try { return (JSON.parse(l) as { type: string }).type === 'shutdown'; }
          catch { return false; }
        })) {
          conn.destroy();
        }
      });
    });

    try {
      const deps = makeDeps({
        getResourcesCompanionPath: () => resourcesBundle,
        getInstallDir: () => installDir,
        fs: fakeFs as unknown as CompanionHostDeps['fs'],
        connectSocket: vi.fn()
          .mockResolvedValueOnce(null)
          .mockImplementation((p: string) => realConnectSocket(p)),
        openApp: vi.fn(async () => {}),
      });

      const host = new CompanionHost(deps);
      const startResult = await host.start();
      expect(startResult.ok).toBe(true);

      await expect(host.stop()).resolves.toBeUndefined();
      expect(receivedLines.some((l) => {
        try { return (JSON.parse(l) as { type: string }).type === 'shutdown'; }
        catch { return false; }
      })).toBe(true);
    } finally {
      await srv.close();
    }
  }, 10_000);

  it('falls back to kill by pid when companion does not close in time', async () => {
    const installDir = makeTmpInstallDir();
    const sockPath = path.join(installDir, 'companion.sock');
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');

    const fakeFs = makeMatchingFsWithBundles(resourcesBundle, installBundle, 'fp-kill');
    fakeFs.existsSync.mockImplementation((p: string) => {
      if (p === resourcesBundle || p === installBundle) return true;
      if (p === sockPath) return false;
      return fakeFs.store.has(p);
    });

    const srv = await startFakeCompanionServer(sockPath, { pid: 88888 });

    try {
      const deps = makeDeps({
        getResourcesCompanionPath: () => resourcesBundle,
        getInstallDir: () => installDir,
        fs: fakeFs as unknown as CompanionHostDeps['fs'],
        connectSocket: vi.fn()
          .mockResolvedValueOnce(null)
          .mockImplementation((p: string) => realConnectSocket(p)),
        openApp: vi.fn(async () => {}),
      });

      const host = new CompanionHost(deps);
      const startResult = await host.start();
      expect(startResult.ok).toBe(true);

      // 关闭 server 使连接断开——stop() 收到 close 事件后尝试 kill pid
      await srv.close();

      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

      // 等 socket 关闭传播到 host
      await new Promise((r) => setTimeout(r, 50));

      await expect(host.stop()).resolves.toBeUndefined();
      expect(killSpy).toHaveBeenCalledWith(88888, 'SIGTERM');
      killSpy.mockRestore();
    } finally {
      // srv already closed above, but try anyway
      try { await srv.close(); } catch { /* ignore */ }
    }
  }, 10_000);
});

describe('CompanionHost — heartbeat', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits disconnected after max missed pongs', async () => {
    const installDir = makeTmpInstallDir();
    const sockPath = path.join(installDir, 'companion.sock');
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');

    const fakeFs = makeMatchingFsWithBundles(resourcesBundle, installBundle, 'fp-hb');
    fakeFs.existsSync.mockImplementation((p: string) => {
      if (p === resourcesBundle || p === installBundle) return true;
      if (p === sockPath) return false;
      return fakeFs.store.has(p);
    });

    const srv = await startFakeCompanionServer(sockPath, { pid: 11111 });

    try {
      // 使用 fake setInterval 控制心跳触发
      const intervals: Array<{ cb: () => void; id: number }> = [];
      let nextId = 100;
      const fakeSetInterval = ((cb: () => void): ReturnType<typeof setInterval> => {
        const id = nextId++;
        intervals.push({ cb, id });
        return id as unknown as ReturnType<typeof setInterval>;
      }) as typeof globalThis.setInterval;
      const fakeClearInterval = ((id: unknown): void => {
        const idx = intervals.findIndex((i) => i.id === id);
        if (idx >= 0) intervals.splice(idx, 1);
      }) as typeof globalThis.clearInterval;

      const deps = makeDeps({
        getResourcesCompanionPath: () => resourcesBundle,
        getInstallDir: () => installDir,
        fs: fakeFs as unknown as CompanionHostDeps['fs'],
        connectSocket: vi.fn()
          .mockResolvedValueOnce(null)
          .mockImplementation((p: string) => realConnectSocket(p)),
        openApp: vi.fn(async () => {}),
        setInterval: fakeSetInterval,
        clearInterval: fakeClearInterval,
      });

      const host = new CompanionHost(deps);
      const disconnectedFired = new Promise<void>((resolve) => host.once('disconnected', resolve));

      const startResult = await host.start();
      expect(startResult.ok).toBe(true);

      // 心跳 interval 已注册
      expect(intervals).toHaveLength(1);
      const tick = intervals[0]!.cb;

      // MAX_MISSED_PONGS = 2，第 3 次 tick 时 missedPongs >= 2 → emit disconnected
      tick(); // missedPongs = 1
      tick(); // missedPongs = 2
      tick(); // >= MAX_MISSED_PONGS → emit disconnected

      await disconnectedFired;
      await host.stop();
    } finally {
      await srv.close();
    }
  }, 10_000);

  it('daemon-status event is forwarded to host', async () => {
    const installDir = makeTmpInstallDir();
    const sockPath = path.join(installDir, 'companion.sock');
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');

    const fakeFs = makeMatchingFsWithBundles(resourcesBundle, installBundle, 'fp-ds');
    fakeFs.existsSync.mockImplementation((p: string) => {
      if (p === resourcesBundle || p === installBundle) return true;
      if (p === sockPath) return false;
      return fakeFs.store.has(p);
    });

    const srv = await startFakeCompanionServer(sockPath, { pid: 22222 });

    try {
      const deps = makeDeps({
        getResourcesCompanionPath: () => resourcesBundle,
        getInstallDir: () => installDir,
        fs: fakeFs as unknown as CompanionHostDeps['fs'],
        connectSocket: vi.fn()
          .mockResolvedValueOnce(null)
          .mockImplementation((p: string) => realConnectSocket(p)),
        openApp: vi.fn(async () => {}),
      });

      const host = new CompanionHost(deps);
      const daemonStatusPromise = new Promise<unknown>((resolve) => host.once('daemon-status', resolve));

      const startResult = await host.start();
      expect(startResult.ok).toBe(true);

      // companion 侧推送 daemon-status
      const conn = srv.connections[0];
      expect(conn).toBeDefined();
      conn!.write(`${JSON.stringify({ type: 'daemon-status', running: true, pid: 55555, restarts: 0 })}\n`);

      const status = await daemonStatusPromise;
      expect(status).toMatchObject({ type: 'daemon-status', running: true, pid: 55555 });

      await host.stop();
    } finally {
      await srv.close();
    }
  }, 10_000);
});

// ── 新增测试：P1-1 / P1-2 / P1-3 ─────────────────────────────────────────────

describe('CompanionHost — P1-1: build script receives correct darwin platform key', () => {
  it('passes darwin-arm64 or darwin-x64 to runBuildScript (never macos-arm64)', async () => {
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installDir = makeTmpInstallDir();
    const fakeFs = makeFakeFs({
      [`${resourcesBundle}/Contents/Resources/.build-fingerprint`]: 'fp-v1\n',
    });
    fakeFs.existsSync.mockImplementation((p: string) => p === resourcesBundle || fakeFs.store.has(p));

    const deps = makeDeps({
      isPackaged: () => false,
      getResourcesCompanionPath: () => resourcesBundle,
      getInstallDir: () => installDir,
      fs: fakeFs as unknown as CompanionHostDeps['fs'],
    });

    await new CompanionHost(deps).ensureInstalled();

    expect(deps.runBuildScript).toHaveBeenCalledOnce();
    const [, platformKey] = (deps.runBuildScript as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    // 必须是 darwin- 前缀，arm64 或 x64；绝对不能是旧的 'macos-arm64'
    expect(platformKey).toMatch(/^darwin-(arm64|x64)$/);
    expect(platformKey).not.toBe('macos-arm64');
  });
});

describe('CompanionHost — P1-2: hello + daemon-status in same chunk not dropped', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits daemon-status even when it arrives in the same write() as hello', async () => {
    const installDir = makeTmpInstallDir();
    const sockPath = path.join(installDir, 'companion.sock');
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');

    const fakeFs = makeMatchingFsWithBundles(resourcesBundle, installBundle, 'fp-p12');
    fakeFs.existsSync.mockImplementation((p: string) => {
      if (p === resourcesBundle || p === installBundle) return true;
      if (p === sockPath) return false;
      return fakeFs.store.has(p);
    });

    // 把 hello 与 daemon-status 写进同一个 write() 调用（同一 chunk），触发 P1-2 的场景
    const daemonStatusMsg = JSON.stringify({ type: 'daemon-status', running: true, pid: 44444, restarts: 0 });
    const srv = await startFakeCompanionServer(sockPath, {
      fingerprint: 'fp-p12',
      pid: 33333,
      extraMessages: [daemonStatusMsg],
    });

    try {
      const deps = makeDeps({
        getResourcesCompanionPath: () => resourcesBundle,
        getInstallDir: () => installDir,
        fs: fakeFs as unknown as CompanionHostDeps['fs'],
        connectSocket: vi.fn()
          .mockResolvedValueOnce(null)
          .mockImplementation((p: string) => realConnectSocket(p)),
        openApp: vi.fn(async () => {}),
      });

      const host = new CompanionHost(deps);
      const daemonStatusPromise = new Promise<unknown>((resolve) => host.once('daemon-status', resolve));

      const startResult = await host.start();
      expect(startResult.ok).toBe(true);

      // daemon-status 必须被 emit，即使它与 hello 在同一 chunk 里
      const status = await daemonStatusPromise;
      expect(status).toMatchObject({ type: 'daemon-status', running: true, pid: 44444 });

      await host.stop();
    } finally {
      await srv.close();
    }
  }, 10_000);
});

describe('CompanionHost — P1-3: fingerprint mismatch triggers restart', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shuts down stale running instance and starts fresh when fingerprints differ', async () => {
    const installDir = makeTmpInstallDir();
    const sockPath = path.join(installDir, 'companion.sock');
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');

    // installed bundle 指纹为 fp-new（最新），但运行中进程 hello 报的是 fp-old（过时）
    const installedFingerprint = 'fp-new';
    const runningFingerprint = 'fp-old';

    const fakeFs = makeFakeFs({
      [`${resourcesBundle}/Contents/Resources/.build-fingerprint`]: `${installedFingerprint}\n`,
      [`${installBundle}/Contents/Resources/.build-fingerprint`]: `${installedFingerprint}\n`,
    });
    fakeFs.existsSync.mockImplementation((p: string) => {
      if (p === resourcesBundle || p === installBundle) return true;
      return fakeFs.store.has(p);
    });

    // 第一个 fake server：代表旧进程（指纹 fp-old）
    const staleServer = await startFakeCompanionServer(sockPath, {
      fingerprint: runningFingerprint,
      pid: 66666,
    });

    // 记录 stale server 收到的消息，用于断言 shutdown 被发出
    const staleReceived: string[] = [];
    staleServer.server.on('connection', (conn) => {
      conn.setEncoding('utf8');
      conn.on('data', (data: string) => {
        staleReceived.push(...data.split('\n').filter(Boolean));
        // 收到 shutdown → 关闭连接，模拟旧进程正常退出
        if (staleReceived.some((l) => {
          try { return (JSON.parse(l) as { type: string }).type === 'shutdown'; }
          catch { return false; }
        })) {
          // 关闭所有连接，让 waitForSocketClose 成功
          for (const c of staleServer.connections) c.destroy();
        }
      });
    });

    // openApp 被调用后，启动第二个 fake server（新实例，指纹 fp-new）
    let newServer: Awaited<ReturnType<typeof startFakeCompanionServer>> | undefined;

    const deps = makeDeps({
      getResourcesCompanionPath: () => resourcesBundle,
      getInstallDir: () => installDir,
      fs: fakeFs as unknown as CompanionHostDeps['fs'],
      // 首次 probe → stale socket 可达；重启后轮询 → 新 socket 可达
      connectSocket: vi.fn()
        .mockImplementationOnce((p: string) => realConnectSocket(p))     // probe stale
        .mockImplementationOnce(async () => null)                         // 首次轮询（socket 还没好）
        .mockImplementation((p: string) => realConnectSocket(p)),          // 之后轮询新实例
      openApp: vi.fn(async () => {
        // 旧进程收到 shutdown 后 staleServer 连接已断开；启动新实例
        newServer = await startFakeCompanionServer(sockPath, {
          fingerprint: installedFingerprint,
          pid: 77777,
        });
      }),
    });

    const host = new CompanionHost(deps);

    try {
      const result = await host.start();

      // 断言：旧 stale 进程收到了 shutdown
      expect(staleReceived.some((l) => {
        try { return (JSON.parse(l) as { type: string }).type === 'shutdown'; }
        catch { return false; }
      })).toBe(true);

      // 断言：openApp 被调用（走了重启路径）
      expect(deps.openApp).toHaveBeenCalledOnce();

      // 断言：start() 最终成功，握手来自新实例
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.handshake.companionFingerprint).toBe(installedFingerprint);
        expect(result.handshake.pid).toBe(77777);
        // 重启后的实例不是复用，reused 为 false
        expect(result.handshake.reused).toBe(false);
      }

      await host.stop();
    } finally {
      await staleServer.close();
      if (newServer) await newServer.close();
    }
  }, 15_000);
});

// ── 新增测试：协议版本 2 ────────────────────────────────────────────────────────

describe('CompanionHost — protocolVersion 2 hello accepted', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts hello with protocolVersion 2 and completes handshake', async () => {
    const installDir = makeTmpInstallDir();
    const sockPath = path.join(installDir, 'companion.sock');
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');

    const fakeFs = makeMatchingFsWithBundles(resourcesBundle, installBundle, 'fp-v2');
    fakeFs.existsSync.mockImplementation((p: string) => {
      if (p === resourcesBundle || p === installBundle) return true;
      if (p === sockPath) return false;
      return fakeFs.store.has(p);
    });

    // 启动发送 protocolVersion:2 的 fake companion server
    const server = net.createServer((sock) => {
      const hello = JSON.stringify({
        type: 'hello',
        protocolVersion: 2,
        companionFingerprint: 'fp-v2',
        pid: 23456,
      });
      setImmediate(() => sock.write(`${hello}\n`));
      sock.setEncoding('utf8');
      let buf = '';
      sock.on('data', (data: string) => {
        buf += data;
        if (buf.includes('"shutdown"')) sock.destroy();
      });
    });
    fs.mkdirSync(path.dirname(sockPath), { recursive: true });
    try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(sockPath, () => { server.removeListener('error', reject); resolve(); });
    });

    try {
      const deps = makeDeps({
        getResourcesCompanionPath: () => resourcesBundle,
        getInstallDir: () => installDir,
        fs: fakeFs as unknown as CompanionHostDeps['fs'],
        connectSocket: vi.fn()
          .mockResolvedValueOnce(null)
          .mockImplementation((p: string) => realConnectSocket(p)),
        openApp: vi.fn(async () => {}),
      });

      const host = new CompanionHost(deps);
      const result = await host.start();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.handshake.protocolVersion).toBe(2);
        expect(result.handshake.pid).toBe(23456);
      }
      await host.stop();
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
          resolve();
        });
      });
    }
  }, 10_000);
});

describe('CompanionHost — guide-update / guide-dismiss send path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('showGuide sends guide-update message to companion', async () => {
    const installDir = makeTmpInstallDir();
    const sockPath = path.join(installDir, 'companion.sock');
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');

    const fakeFs = makeMatchingFsWithBundles(resourcesBundle, installBundle, 'fp-guide');
    fakeFs.existsSync.mockImplementation((p: string) => {
      if (p === resourcesBundle || p === installBundle) return true;
      if (p === sockPath) return false;
      return fakeFs.store.has(p);
    });

    const receivedMessages: unknown[] = [];
    const srv = await startFakeCompanionServer(sockPath, { fingerprint: 'fp-guide', pid: 12001 });
    srv.server.on('connection', (conn) => {
      conn.setEncoding('utf8');
      let buf = '';
      conn.on('data', (data: string) => {
        buf += data;
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            try { receivedMessages.push(JSON.parse(line)); } catch { /* ignore */ }
          }
          nl = buf.indexOf('\n');
        }
      });
    });

    try {
      const deps = makeDeps({
        getResourcesCompanionPath: () => resourcesBundle,
        getInstallDir: () => installDir,
        fs: fakeFs as unknown as CompanionHostDeps['fs'],
        connectSocket: vi.fn()
          .mockResolvedValueOnce(null)
          .mockImplementation((p: string) => realConnectSocket(p)),
        openApp: vi.fn(async () => {}),
      });

      const host = new CompanionHost(deps);
      const startResult = await host.start();
      expect(startResult.ok).toBe(true);

      const guideState = {
        accessibilityGranted: false,
        screenRecordingGranted: false,
        draggedAccessibility: false,
        draggedScreenRecording: false,
        appBundlePath: '/Applications/Cindy Computer Use.app',
      };
      const showResult = await host.showGuide(guideState);
      expect(showResult.ok).toBe(true);

      // 等消息传到 server
      await new Promise((r) => setTimeout(r, 50));

      const guideUpdateMsgs = receivedMessages.filter(
        (m) => (m as { type: string }).type === 'guide-update'
      );
      expect(guideUpdateMsgs.length).toBeGreaterThan(0);
      const msg = guideUpdateMsgs[0] as { type: string; state: { appBundlePath: string } };
      expect(msg.state.appBundlePath).toBe('/Applications/Cindy Computer Use.app');

      await host.stop();
    } finally {
      await srv.close();
    }
  }, 10_000);

  it('dismissGuide sends guide-dismiss message to companion', async () => {
    const installDir = makeTmpInstallDir();
    const sockPath = path.join(installDir, 'companion.sock');
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');

    const fakeFs = makeMatchingFsWithBundles(resourcesBundle, installBundle, 'fp-dismiss');
    fakeFs.existsSync.mockImplementation((p: string) => {
      if (p === resourcesBundle || p === installBundle) return true;
      if (p === sockPath) return false;
      return fakeFs.store.has(p);
    });

    const receivedMessages: unknown[] = [];
    const srv = await startFakeCompanionServer(sockPath, { fingerprint: 'fp-dismiss', pid: 12002 });
    srv.server.on('connection', (conn) => {
      conn.setEncoding('utf8');
      let buf = '';
      conn.on('data', (data: string) => {
        buf += data;
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            try { receivedMessages.push(JSON.parse(line)); } catch { /* ignore */ }
          }
          nl = buf.indexOf('\n');
        }
      });
    });

    try {
      const deps = makeDeps({
        getResourcesCompanionPath: () => resourcesBundle,
        getInstallDir: () => installDir,
        fs: fakeFs as unknown as CompanionHostDeps['fs'],
        connectSocket: vi.fn()
          .mockResolvedValueOnce(null)
          .mockImplementation((p: string) => realConnectSocket(p)),
        openApp: vi.fn(async () => {}),
      });

      const host = new CompanionHost(deps);
      const startResult = await host.start();
      expect(startResult.ok).toBe(true);

      await host.dismissGuide();

      await new Promise((r) => setTimeout(r, 50));

      const dismissMsgs = receivedMessages.filter(
        (m) => (m as { type: string }).type === 'guide-dismiss'
      );
      expect(dismissMsgs.length).toBeGreaterThan(0);

      await host.stop();
    } finally {
      await srv.close();
    }
  }, 10_000);
});

describe('CompanionHost — locate-switch request/response', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves with found result when companion replies found', async () => {
    const installDir = makeTmpInstallDir();
    const sockPath = path.join(installDir, 'companion.sock');
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');

    const fakeFs = makeMatchingFsWithBundles(resourcesBundle, installBundle, 'fp-ls');
    fakeFs.existsSync.mockImplementation((p: string) => {
      if (p === resourcesBundle || p === installBundle) return true;
      if (p === sockPath) return false;
      return fakeFs.store.has(p);
    });

    const srv = await startFakeCompanionServer(sockPath, { fingerprint: 'fp-ls', pid: 13001 });
    // 服务器侧监听 locate-switch 请求并回复 found
    srv.server.on('connection', (conn) => {
      conn.setEncoding('utf8');
      let buf = '';
      conn.on('data', (data: string) => {
        buf += data;
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            try {
              const msg = JSON.parse(line) as { type: string; id?: number };
              if (msg.type === 'locate-switch' && typeof msg.id === 'number') {
                const reply = JSON.stringify({
                  type: 'switch-location',
                  id: msg.id,
                  status: 'found',
                  x: 120,
                  y: 80,
                  windowWidth: 800,
                  windowHeight: 600,
                  value: false,
                });
                conn.write(`${reply}\n`);
              }
            } catch { /* ignore */ }
          }
          nl = buf.indexOf('\n');
        }
      });
    });

    try {
      const deps = makeDeps({
        getResourcesCompanionPath: () => resourcesBundle,
        getInstallDir: () => installDir,
        fs: fakeFs as unknown as CompanionHostDeps['fs'],
        connectSocket: vi.fn()
          .mockResolvedValueOnce(null)
          .mockImplementation((p: string) => realConnectSocket(p)),
        openApp: vi.fn(async () => {}),
      });

      const host = new CompanionHost(deps);
      const startResult = await host.start();
      expect(startResult.ok).toBe(true);

      const locResult = await host.locateSwitch();
      expect(locResult.status).toBe('found');
      if (locResult.status === 'found') {
        expect(locResult.x).toBe(120);
        expect(locResult.y).toBe(80);
        expect(locResult.value).toBe(false);
      }

      await host.stop();
    } finally {
      await srv.close();
    }
  }, 10_000);

  it('resolves with not-found when companion replies not-found', async () => {
    const installDir = makeTmpInstallDir();
    const sockPath = path.join(installDir, 'companion.sock');
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');

    const fakeFs = makeMatchingFsWithBundles(resourcesBundle, installBundle, 'fp-lsnf');
    fakeFs.existsSync.mockImplementation((p: string) => {
      if (p === resourcesBundle || p === installBundle) return true;
      if (p === sockPath) return false;
      return fakeFs.store.has(p);
    });

    const srv = await startFakeCompanionServer(sockPath, { fingerprint: 'fp-lsnf', pid: 13002 });
    srv.server.on('connection', (conn) => {
      conn.setEncoding('utf8');
      let buf = '';
      conn.on('data', (data: string) => {
        buf += data;
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            try {
              const msg = JSON.parse(line) as { type: string; id?: number };
              if (msg.type === 'locate-switch' && typeof msg.id === 'number') {
                conn.write(`${JSON.stringify({ type: 'switch-location', id: msg.id, status: 'not-found' })}\n`);
              }
            } catch { /* ignore */ }
          }
          nl = buf.indexOf('\n');
        }
      });
    });

    try {
      const deps = makeDeps({
        getResourcesCompanionPath: () => resourcesBundle,
        getInstallDir: () => installDir,
        fs: fakeFs as unknown as CompanionHostDeps['fs'],
        connectSocket: vi.fn()
          .mockResolvedValueOnce(null)
          .mockImplementation((p: string) => realConnectSocket(p)),
        openApp: vi.fn(async () => {}),
      });

      const host = new CompanionHost(deps);
      await host.start();
      const locResult = await host.locateSwitch();
      expect(locResult.status).toBe('not-found');
      await host.stop();
    } finally {
      await srv.close();
    }
  }, 10_000);

  it('resolves with unavailable when 8s timeout expires (no reply)', async () => {
    const installDir = makeTmpInstallDir();
    const sockPath = path.join(installDir, 'companion.sock');
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');

    const fakeFs = makeMatchingFsWithBundles(resourcesBundle, installBundle, 'fp-lsto');
    fakeFs.existsSync.mockImplementation((p: string) => {
      if (p === resourcesBundle || p === installBundle) return true;
      if (p === sockPath) return false;
      return fakeFs.store.has(p);
    });

    // 服务器不回复 switch-location(模拟超时)
    const srv = await startFakeCompanionServer(sockPath, { fingerprint: 'fp-lsto', pid: 13003 });

    try {
      // 注入 fake setTimeout 使 locateSwitch 立即超时
      const capturedTimeouts: Array<() => void> = [];
      const deps = makeDeps({
        getResourcesCompanionPath: () => resourcesBundle,
        getInstallDir: () => installDir,
        fs: fakeFs as unknown as CompanionHostDeps['fs'],
        connectSocket: vi.fn()
          .mockResolvedValueOnce(null)
          .mockImplementation((p: string) => realConnectSocket(p)),
        openApp: vi.fn(async () => {}),
        setTimeout: ((cb: () => void): ReturnType<typeof setTimeout> => {
          capturedTimeouts.push(cb);
          return capturedTimeouts.length as unknown as ReturnType<typeof setTimeout>;
        }) as typeof globalThis.setTimeout,
        clearTimeout: ((): void => {}) as typeof globalThis.clearTimeout,
      });

      const host = new CompanionHost(deps);
      const startResult = await host.start();
      expect(startResult.ok).toBe(true);

      const locPromise = host.locateSwitch();

      // 等连接与消息循环稳定
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // 触发最后一个 timeout 回调(locateSwitch 的超时)
      const lastCb = capturedTimeouts[capturedTimeouts.length - 1];
      lastCb?.();

      const locResult = await locPromise;
      expect(locResult.status).toBe('unavailable');

      await host.stop();
    } finally {
      await srv.close();
    }
  }, 15_000);
});

describe('CompanionHost — watch-permissions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends watch-permissions and receives initial permission-state event on enable', async () => {
    const installDir = makeTmpInstallDir();
    const sockPath = path.join(installDir, 'companion.sock');
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');

    const fakeFs = makeMatchingFsWithBundles(resourcesBundle, installBundle, 'fp-wp');
    fakeFs.existsSync.mockImplementation((p: string) => {
      if (p === resourcesBundle || p === installBundle) return true;
      if (p === sockPath) return false;
      return fakeFs.store.has(p);
    });

    const srv = await startFakeCompanionServer(sockPath, { fingerprint: 'fp-wp', pid: 14001 });
    // 服务器侧监听 watch-permissions 并立即发送 permission-state 快照
    srv.server.on('connection', (conn) => {
      conn.setEncoding('utf8');
      let buf = '';
      conn.on('data', (data: string) => {
        buf += data;
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            try {
              const msg = JSON.parse(line) as { type: string; enabled?: boolean };
              if (msg.type === 'watch-permissions' && msg.enabled) {
                // 发送初始快照
                conn.write(`${JSON.stringify({ type: 'permission-state', accessibility: true, screenRecording: false })}\n`);
              }
            } catch { /* ignore */ }
          }
          nl = buf.indexOf('\n');
        }
      });
    });

    try {
      const deps = makeDeps({
        getResourcesCompanionPath: () => resourcesBundle,
        getInstallDir: () => installDir,
        fs: fakeFs as unknown as CompanionHostDeps['fs'],
        connectSocket: vi.fn()
          .mockResolvedValueOnce(null)
          .mockImplementation((p: string) => realConnectSocket(p)),
        openApp: vi.fn(async () => {}),
      });

      const host = new CompanionHost(deps);
      const permStatePromise = new Promise<unknown>((resolve) => host.once('permission-state', resolve));

      await host.start();
      const watchResult = await host.watchPermissions(true);
      expect(watchResult.ok).toBe(true);

      const permState = await permStatePromise;
      expect(permState).toMatchObject({
        type: 'permission-state',
        accessibility: true,
        screenRecording: false,
      });

      await host.stop();
    } finally {
      await srv.close();
    }
  }, 10_000);

  it('emits permission-state on change after initial snapshot (edge-triggered)', async () => {
    const installDir = makeTmpInstallDir();
    const sockPath = path.join(installDir, 'companion.sock');
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');

    const fakeFs = makeMatchingFsWithBundles(resourcesBundle, installBundle, 'fp-wpedge');
    fakeFs.existsSync.mockImplementation((p: string) => {
      if (p === resourcesBundle || p === installBundle) return true;
      if (p === sockPath) return false;
      return fakeFs.store.has(p);
    });

    let serverConn: net.Socket | undefined;
    const srv = await startFakeCompanionServer(sockPath, { fingerprint: 'fp-wpedge', pid: 14002 });
    srv.server.on('connection', (conn) => {
      serverConn = conn;
    });

    try {
      const deps = makeDeps({
        getResourcesCompanionPath: () => resourcesBundle,
        getInstallDir: () => installDir,
        fs: fakeFs as unknown as CompanionHostDeps['fs'],
        connectSocket: vi.fn()
          .mockResolvedValueOnce(null)
          .mockImplementation((p: string) => realConnectSocket(p)),
        openApp: vi.fn(async () => {}),
      });

      const host = new CompanionHost(deps);
      const permEvents: unknown[] = [];
      host.on('permission-state', (msg) => permEvents.push(msg));

      await host.start();
      // 等 server 连接建立
      await new Promise((r) => setTimeout(r, 100));

      // companion 侧主动推送两次 permission-state(模拟初始快照 + 一次变化)
      serverConn!.write(`${JSON.stringify({ type: 'permission-state', accessibility: false, screenRecording: false })}\n`);
      await new Promise((r) => setTimeout(r, 30));
      serverConn!.write(`${JSON.stringify({ type: 'permission-state', accessibility: true, screenRecording: false })}\n`);
      await new Promise((r) => setTimeout(r, 30));

      expect(permEvents).toHaveLength(2);
      expect(permEvents[0]).toMatchObject({ accessibility: false, screenRecording: false });
      expect(permEvents[1]).toMatchObject({ accessibility: true, screenRecording: false });

      await host.stop();
    } finally {
      await srv.close();
    }
  }, 10_000);
});

describe('CompanionHost — guide events emitted via EventEmitter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits guide-event when companion sends guide-attached or guide-close-requested', async () => {
    const installDir = makeTmpInstallDir();
    const sockPath = path.join(installDir, 'companion.sock');
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');

    const fakeFs = makeMatchingFsWithBundles(resourcesBundle, installBundle, 'fp-ge');
    fakeFs.existsSync.mockImplementation((p: string) => {
      if (p === resourcesBundle || p === installBundle) return true;
      if (p === sockPath) return false;
      return fakeFs.store.has(p);
    });

    let serverConn: net.Socket | undefined;
    const srv = await startFakeCompanionServer(sockPath, { fingerprint: 'fp-ge', pid: 15001 });
    srv.server.on('connection', (conn) => { serverConn = conn; });

    try {
      const deps = makeDeps({
        getResourcesCompanionPath: () => resourcesBundle,
        getInstallDir: () => installDir,
        fs: fakeFs as unknown as CompanionHostDeps['fs'],
        connectSocket: vi.fn()
          .mockResolvedValueOnce(null)
          .mockImplementation((p: string) => realConnectSocket(p)),
        openApp: vi.fn(async () => {}),
      });

      const host = new CompanionHost(deps);
      const guideEvents: unknown[] = [];
      host.on('guide-event', (msg) => guideEvents.push(msg));

      await host.start();
      await new Promise((r) => setTimeout(r, 100));

      // companion 侧推送 guide-attached 和 guide-close-requested
      serverConn!.write(`${JSON.stringify({
        type: 'guide-attached',
        systemX: 0, systemY: 0, systemWidth: 800, systemHeight: 600,
        panelX: 300, panelY: 400,
      })}\n`);
      await new Promise((r) => setTimeout(r, 30));
      serverConn!.write(`${JSON.stringify({ type: 'guide-close-requested' })}\n`);
      await new Promise((r) => setTimeout(r, 30));

      expect(guideEvents).toHaveLength(2);
      expect((guideEvents[0] as { type: string }).type).toBe('guide-attached');
      expect((guideEvents[1] as { type: string }).type).toBe('guide-close-requested');

      await host.stop();
    } finally {
      await srv.close();
    }
  }, 10_000);
});

describe('CompanionHost — start() 幂等：已有活跃 socket 时不重复拨号', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('第二次 start() 返回 reused:true，不向 fake server 发起第二次连接，不重调 openApp', async () => {
    const installDir = makeTmpInstallDir();
    const sockPath = path.join(installDir, 'companion.sock');
    const resourcesBundle = '/fake-res/Cindy Computer Use.app';
    const installBundle = path.join(installDir, 'Cindy Computer Use.app');

    const fakeFs = makeMatchingFsWithBundles(resourcesBundle, installBundle, 'fp-idem');
    fakeFs.existsSync.mockImplementation((p: string) => {
      if (p === resourcesBundle || p === installBundle) return true;
      if (p === sockPath) return false;
      return fakeFs.store.has(p);
    });

    const srv = await startFakeCompanionServer(sockPath, { fingerprint: 'fp-idem', pid: 42424 });

    try {
      const deps = makeDeps({
        getResourcesCompanionPath: () => resourcesBundle,
        getInstallDir: () => installDir,
        fs: fakeFs as unknown as CompanionHostDeps['fs'],
        // 第一次 probe（检测已运行实例）返回 null；之后真实连接供首次 start 握手
        connectSocket: vi.fn()
          .mockResolvedValueOnce(null)
          .mockImplementation((p: string) => realConnectSocket(p)),
        openApp: vi.fn(async () => {}),
      });

      const host = new CompanionHost(deps);

      // 第一次 start() — 走正常启动路径（probe null → openApp → 握手成功）
      const first = await host.start();
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.handshake.pid).toBe(42424);
        expect(first.handshake.reused).toBe(false);
      }
      expect(deps.openApp).toHaveBeenCalledOnce();

      // 此时 fake server 已有 1 个连接
      const connectionsBefore = srv.connections.length;
      expect(connectionsBefore).toBe(1);

      // 第二次 start() — socket 仍活跃，应命中早返回，不新建连接
      const second = await host.start();
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.handshake.pid).toBe(42424);
        expect(second.handshake.reused).toBe(true);
        expect(second.handshake.companionFingerprint).toBe('fp-idem');
      }

      // fake server 连接数未增加（没有第二次拨号）
      expect(srv.connections.length).toBe(connectionsBefore);
      // openApp 没有被再次调用
      expect(deps.openApp).toHaveBeenCalledOnce();

      await host.stop();
    } finally {
      await srv.close();
    }
  }, 10_000);
});
