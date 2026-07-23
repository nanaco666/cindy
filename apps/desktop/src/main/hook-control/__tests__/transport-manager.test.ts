/**
 * transport + manager 集成测试(单连接 + JWT 形态): 对真实 ws server
 * (WebSocketServer, 端口 0)跑完整行为 —— 登录 token 鉴权头、hello 自报
 * 别名、welcome 后状态 connected、ping 自动回 pong、dispatch 的 stub ack、
 * 未登录不发起连接、setEnabled(false) 停线。依赖全部注入, 不需要 Electron。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import {
  HOOK_FEATURE_MULTI_TEAM,
  HOOK_FEATURE_SLACK_TOOLS,
  makeBindState,
  makeBindUpdate,
  makePing,
  makePrefsState,
  makeQueryRequest,
  makeTaskDispatch,
  makeToolResponse,
  makeWelcome,
  parseHookMessage,
  serializeHookMessage,
  type HookMessage,
} from '@cindy/slack-hook-protocol';

import {
  createHookControlManager,
  HookNotConnectedError,
  HookPrefsTimeoutError,
  type HookControlManagerDeps,
} from '../manager';
import { createHookTransport, type HookTransportOpts } from '../transport';
import type { SlackHookStore, SlackHookConfigState } from '../store';

const noopLog = { info: () => {}, warn: () => {} };

/** 内存版单配置 store。 */
function memoryStore(initial: Partial<SlackHookConfigState> & { url: string }): SlackHookStore {
  let state: SlackHookConfigState = {
    enabled: initial.enabled ?? true,
    urlOverride: initial.url,
    workspaces: initial.workspaces ?? {},
    bindingsCache: initial.bindingsCache ?? [],
  };
  return {
    get: () => ({
      ...state,
      workspaces: { ...state.workspaces },
      bindingsCache: state.bindingsCache.map((e) => ({ ...e })),
    }),
    effectiveUrl: () => state.urlOverride ?? 'wss://unused.example',
    setEnabled(enabled) {
      state = { ...state, enabled };
      return state;
    },
    setWorkspaces(workspaces) {
      state = { ...state, workspaces };
      return state;
    },
    setBindingsCache(entries) {
      state = { ...state, bindingsCache: entries.map((e) => ({ ...e })) };
      return state;
    },
  };
}

function makeManager(
  store: SlackHookStore,
  overrides: Partial<HookControlManagerDeps> = {},
): ReturnType<typeof createHookControlManager> {
  return createHookControlManager({
    store,
    createTransport: createHookTransport,
    getAuthToken: async () => 'jwt-token-1',
    refreshAuthToken: async () => false,
    deviceInfo: () => ({ deviceId: 'dev-1', deviceName: 'TestBox' }),
    agents: ['claude-code', 'codex'],
    notifyStatus: () => {},
    log: noopLog,
    ...overrides,
  });
}

/** server 侧帧收集器: 逐帧 parse, 按需等待某类型消息。 */
function collectFrames(sock: ServerSocket) {
  const frames: HookMessage[] = [];
  const waiters: Array<{ type: string; resolve: (m: HookMessage) => void }> = [];
  sock.on('message', (data) => {
    const parsed = parseHookMessage(data.toString());
    if (!parsed.ok) throw new Error(`server got bad frame: ${parsed.error}`);
    frames.push(parsed.message);
    const idx = waiters.findIndex((w) => w.type === parsed.message.type);
    if (idx >= 0) waiters.splice(idx, 1)[0].resolve(parsed.message);
  });
  return {
    frames,
    waitFor(type: HookMessage['type']): Promise<HookMessage> {
      const hit = frames.find((f) => f.type === type);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
  };
}

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
  cleanups = [];
});

async function startServer(): Promise<{ wss: WebSocketServer; url: string }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const addr = wss.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  cleanups.push(() => wss.close());
  return { wss, url: `ws://127.0.0.1:${addr.port}` };
}

async function startUpgradeServer(
  onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
): Promise<{ url: string }> {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(404).end();
  });
  server.on('upgrade', onUpgrade);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  cleanups.push(() => server.close());
  return { url: `ws://127.0.0.1:${addr.port}` };
}

function transportOpts(
  url: string,
  overrides: Partial<HookTransportOpts> = {},
): HookTransportOpts {
  return {
    url,
    getAuthToken: async () => 'jwt-token-1',
    refreshAuthToken: async () => false,
    buildHello: () => ({
      deviceId: 'dev-1',
      deviceName: 'TestBox',
      workspaces: ['chat'],
      agents: ['codex'],
    }),
    onMessage: () => {},
    onStatus: () => {},
    timing: { backoffBaseMs: 10, backoffMaxMs: 20, standbyRetryMs: 200 },
    log: noopLog,
    ...overrides,
  };
}

describe('hook-control transport handshake recovery', () => {
  it('upgrade 401 只刷新一次凭证，并立即用新 token 重连', async () => {
    let upgrades = 0;
    const authHeaders: Array<string | undefined> = [];
    const wss = new WebSocketServer({ noServer: true });
    cleanups.push(() => wss.close());
    const { url } = await startUpgradeServer((req, socket, head) => {
      upgrades += 1;
      authHeaders.push(req.headers.authorization);
      if (upgrades === 1) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });
    let token = 'stale-token';
    let refreshes = 0;
    const statuses: string[] = [];
    const transport = createHookTransport(
      transportOpts(url, {
        getAuthToken: async () => token,
        refreshAuthToken: async () => {
          refreshes += 1;
          token = 'fresh-token';
          return true;
        },
        onStatus: (status) => statuses.push(status),
      }),
    );
    cleanups.push(() => transport.dispose());

    const [sock] = (await once(wss, 'connection')) as [ServerSocket];
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => statuses.at(-1), { timeout: 3000 }).toBe('connected');
    expect(refreshes).toBe(1);
    expect(authHeaders).toEqual(['Bearer stale-token', 'Bearer fresh-token']);
  });

  it('服务端 close 4000 进入 standby，且仅按低频周期探测接管', async () => {
    const { wss, url } = await startServer();
    let connections = 0;
    wss.on('connection', (sock) => {
      connections += 1;
      sock.on('message', () => sock.close(4000, 'device already connected'));
    });
    const statuses: string[] = [];
    const transport = createHookTransport(
      transportOpts(url, { onStatus: (status) => statuses.push(status) }),
    );
    cleanups.push(() => transport.dispose());

    await expect.poll(() => statuses.at(-1), { timeout: 3000 }).toBe('standby');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(connections).toBe(1);
    await expect.poll(() => connections, { timeout: 3000 }).toBe(2);
    expect(statuses.at(-1)).toBe('standby');
    expect(statuses.filter((status) => status === 'standby')).toHaveLength(2);
  });

  it('upgrade 503 保持 error 并按退避重连，不误判 standby', async () => {
    let upgrades = 0;
    const { url } = await startUpgradeServer((_req, socket) => {
      upgrades += 1;
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
    const statuses: string[] = [];
    const transport = createHookTransport(
      transportOpts(url, { onStatus: (status) => statuses.push(status) }),
    );
    cleanups.push(() => transport.dispose());

    await expect.poll(() => upgrades, { timeout: 3000 }).toBeGreaterThanOrEqual(2);
    expect(statuses).toContain('error');
    expect(statuses).not.toContain('standby');
  });
});

const WORKSPACES = { xdmaker: 'E:\\AIWork\\XDMaker', blog: 'D:\\repos\\blog' };

describe('hook-control transport + manager(真实 ws server)', () => {
  it('JWT 鉴权头 + hello 自报别名 + welcome 后 connected + pong + stub 拒绝 dispatch', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, workspaces: WORKSPACES });

    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<
      [ServerSocket, { headers: Record<string, string | undefined> }]
    >;
    manager.sync();
    const [sock, req] = await connPromise;
    const server = collectFrames(sock);

    // 鉴权头 = 登录 accessToken(不是共享密钥)
    expect(req.headers.authorization).toBe('Bearer jwt-token-1');

    // hello: 只报别名, 绝不带本地路径
    const hello = await server.waitFor('hello');
    if (hello.type !== 'hello') throw new Error('unreachable');
    expect(hello.payload.deviceId).toBe('dev-1');
    // 内置「对话」伪目录 chat 恒在清单第一位, 真实别名跟在后面
    expect(hello.payload.workspaces[0]).toBe('chat');
    expect([...hello.payload.workspaces].sort()).toEqual(['blog', 'chat', 'xdmaker']);
    expect(JSON.stringify(hello)).not.toContain('AIWork');

    // welcome -> connected
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    // ping -> pong(transport 层自动)
    sock.send(serializeHookMessage(makePing()));
    const pong = await server.waitFor('pong');
    expect(pong.type).toBe('pong');

    // dispatch -> 无 dispatcher 的 stub: rejected(disabled)
    sock.send(
      serializeHookMessage(
        makeTaskDispatch({
          requestId: 'req-1',
          externalKey: 'slack:C1:1.1',
          workspace: 'xdmaker',
          prompt: '干活',
        }),
      ),
    );
    const ack = await server.waitFor('task.ack');
    if (ack.type !== 'task.ack') throw new Error('unreachable');
    expect(ack.payload).toMatchObject({
      requestId: 'req-1',
      result: 'rejected',
      reason: 'disabled',
    });
  });

  it('未登录(token=null): 不发起连接, 状态 error + not logged in', async () => {
    const { wss, url } = await startServer();
    let serverGotConnection = false;
    wss.on('connection', () => {
      serverGotConnection = true;
    });
    const store = memoryStore({ url });
    const manager = makeManager(store, { getAuthToken: async () => null });
    cleanups.push(() => manager.dispose());

    manager.sync();
    await expect.poll(() => manager.snapshot().lastError, { timeout: 3000 }).toBe('not logged in');
    expect(manager.snapshot().status).toBe('error');
    expect(serverGotConnection).toBe(false);
  });

  it('setEnabled(false) + sync 停线, snapshot 状态转 disabled', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const closed = once(sock, 'close');

    store.setEnabled(false);
    manager.sync();
    await closed; // desktop 侧主动断开
    expect(manager.snapshot().status).toBe('disabled');
  });

  it('bindStart(SIWS OIDC): 发空 bind.start, server 回 pending+authorizeUrl, 打开系统浏览器', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const opened: string[] = [];
    const manager = makeManager(store, { openExternalUrl: (u) => opened.push(u) });
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    // 用户点「连接 Slack」: 发空 bind.start, 乐观置 pending
    expect(manager.bindStart()).toBe(true);
    const bind = await server.waitFor('bind.start');
    if (bind.type !== 'bind.start') throw new Error('unreachable');
    expect(bind.payload.email).toBeUndefined(); // OIDC: 不带邮箱
    expect(manager.snapshot().binding?.state).toBe('pending');

    // server 回 pending + 授权链接 → manager 打开系统浏览器一次, authorizeUrl 入快照
    const authorizeUrl = 'https://slack.example.com/openid/connect/authorize?state=abc';
    sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'pending', slackUserId: null, slackUserName: null, message: null, authorizeUrl }),
      ),
    );
    await expect.poll(() => manager.snapshot().binding?.authorizeUrl, { timeout: 3000 }).toBe(authorizeUrl);
    expect(opened).toEqual([authorizeUrl]);

    // 重连时的 pending 回放不重复弹浏览器(一次性置位)
    sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'pending', slackUserId: null, slackUserName: null, message: null, authorizeUrl }),
      ),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(opened).toEqual([authorizeUrl]); // 仍只开过一次
  });

  it('bind.update(revoked): 自动关开关 + 断开连接, 保留 revoked 绑定态供 UI 展示', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    // server 推被顶掉(另一设备绑定成功): 本机应自动下线
    const closed = once(sock, 'close');
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'revoked',
          slackUserId: null,
          slackUserName: null,
          message: '你的 Slack 账号已绑定到新设备',
        }),
      ),
    );
    await closed; // desktop 侧主动断开
    expect(store.get().enabled).toBe(false);
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('disabled');
    // 绑定态保留 revoked(含 server 给的原因), 设置页据此显示被踢提示
    expect(manager.snapshot().binding).toMatchObject({
      state: 'revoked',
      message: '你的 Slack 账号已绑定到新设备',
    });
  });

  it('bind.update(denied): 取消授权自动关开关(toggle 弹回)', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    // 用户在浏览器取消授权 → server 推 denied → 本机自动下线, toggle 弹回
    const closed = once(sock, 'close');
    sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'denied', slackUserId: null, slackUserName: null, message: null }),
      ),
    );
    await closed;
    expect(store.get().enabled).toBe(false);
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('disabled');
    expect(manager.snapshot().binding?.state).toBe('denied');

    // 重开开关(armAutoBind)= 新一轮流程: 清掉残留终止态快照 —— renderer 不会
    // 拿陈旧的失败态误弹提示/确认框, server 连上后推回真实现状
    manager.armAutoBind();
    expect(manager.snapshot().binding).toBeNull();
  });

  it('bind.update(none) 且无授权意图(启动回放/离线期间被解绑): 自动关开关, 不留「已连接·未绑定」僵尸态', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url }); // enabled=true 持久化, 模拟 App 启动拉起
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync(); // 启动路径: 不 armAutoBind(意图只在用户手动开 toggle 时置位)
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    // hello 回放: server 已无此设备绑定(离线期间被顶掉/解绑/服务端数据迁移)→ 推 none
    const closed = once(sock, 'close');
    sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'none', slackUserId: null, slackUserName: null, message: null }),
      ),
    );
    await closed; // 开关语义 = 连接 + 绑定齐备才允许保持打开: 无绑定即弹回并断开
    expect(store.get().enabled).toBe(false);
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('disabled');
    // 启动时没有授权意图, 不该自动发起绑定(不能在用户无操作时突然弹浏览器)
    expect(server.frames.some((f) => f.type === 'bind.start')).toBe(false);
  });

  it('reason 常量与 hook-protocol 对齐(shared 层不引协议包, 靠本测试拴住)', async () => {
    const protocol = await import('@cindy/slack-hook-protocol');
    const shared = await import('../../../shared/hookControlIpc');
    expect(shared.HOOK_BIND_REASON_NOT_INSTALLED).toBe(protocol.BIND_FAIL_REASON_NOT_INSTALLED);
  });

  it('failed + not-installed = "等安装"中间态: 不下线, 等 server 装完推 confirmed', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    // 授权的 workspace 未安装 App → server 推 failed + 结构化 reason:
    // 保持在线等用户安装(server 装完自动补完绑定), 不弹回 toggle
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'failed',
          slackUserId: null,
          slackUserName: null,
          message: 'workspace 未安装',
          reason: 'not-installed',
          installUrl: 'https://hook.example/slack/install-to?team=T_NOAPP',
        }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().binding?.reason, { timeout: 3000 })
      .toBe('not-installed');
    expect(store.get().enabled).toBe(true);
    expect(manager.snapshot().status).toBe('connected');
    // 定制安装链接透传(renderer 优先用它, 安装页预选 workspace)
    expect(manager.snapshot().binding?.installUrl).toBe(
      'https://hook.example/slack/install-to?team=T_NOAPP',
    );

    // 用户装完 App → server 自动补完绑定推 confirmed → 正常已绑定
    sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'confirmed', slackUserId: 'U1', slackUserName: 'devuser', message: null }),
      ),
    );
    await expect.poll(() => manager.snapshot().binding?.state, { timeout: 3000 }).toBe('confirmed');
    expect(store.get().enabled).toBe(true);
  });

  it('安装看门狗: "等安装"超时未 confirmed → toggle 弹回, 保留原因', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store, { installWaitTimeoutMs: 120 });
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'failed',
          slackUserId: null,
          slackUserName: null,
          message: 'workspace 未安装',
          reason: 'not-installed',
        }),
      ),
    );
    // 用户一直没装(或装到了别的 workspace)→ 看门狗到点弹回
    await expect.poll(() => store.get().enabled, { timeout: 3000 }).toBe(false);
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('disabled');
    // 原因保留供 UI 显示引导行
    expect(manager.snapshot().binding).toMatchObject({ state: 'failed', reason: 'not-installed' });
  });

  it('armAutoBind: 连上后 server 推 none → 自动发空 bind.start 并弹浏览器', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const opened: string[] = [];
    const manager = makeManager(store, { openExternalUrl: (u) => opened.push(u) });
    cleanups.push(() => manager.dispose());

    manager.armAutoBind(); // 相当于打开 toggle
    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    // hello 后 server 推回绑定现状 = none(未绑定) → manager 自动发起绑定
    sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'none', slackUserId: null, slackUserName: null, message: null }),
      ),
    );
    const bind = await server.waitFor('bind.start');
    expect(bind.type).toBe('bind.start');
    // server 回授权链接 → 自动弹浏览器一次
    const authorizeUrl = 'https://slack.example.com/openid/connect/authorize?state=z';
    sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'pending', slackUserId: null, slackUserName: null, message: null, authorizeUrl }),
      ),
    );
    await expect.poll(() => opened, { timeout: 3000 }).toEqual([authorizeUrl]);
  });

  it('armAutoBind: 已绑定设备连上 server 推 confirmed → 不重发 bind.start、不弹浏览器', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const opened: string[] = [];
    const manager = makeManager(store, { openExternalUrl: (u) => opened.push(u) });
    cleanups.push(() => manager.dispose());

    manager.armAutoBind();
    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'confirmed',
          slackUserId: 'U1',
          slackUserName: 'devuser',
          message: null,
          teamName: 'acme',
        }),
      ),
    );
    await expect.poll(() => manager.snapshot().binding?.state, { timeout: 3000 }).toBe('confirmed');
    await new Promise((r) => setTimeout(r, 50));
    expect(server.frames.some((f) => f.type === 'bind.start')).toBe(false);
    expect(opened).toEqual([]);
    // workspace 名透传进绑定快照(状态行「已绑定 <team> @<name>」数据源)
    expect(manager.snapshot().binding?.teamName).toBe('acme');
  });

  it('cindy_slack provider gate 跟随绑定与 server capability，断线抖动不重复刷新', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const changes: boolean[] = [];
    const manager = makeManager(store, {
      onSlackToolProviderEnabledChanged: (enabled) => changes.push(enabled),
    });
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');
    expect(changes).toEqual([]);

    const confirmed = makeBindUpdate({
      state: 'confirmed',
      slackUserId: 'U1',
      slackUserName: 'devuser',
      message: null,
    });
    sock.send(serializeHookMessage(confirmed));
    await expect.poll(() => manager.snapshot().binding?.state, { timeout: 3000 }).toBe('confirmed');
    expect(manager.getSlackToolAvailability()).toMatchObject({
      bound: true,
      serverSupportsTools: false,
    });
    expect(changes).toEqual([]);

    // 同一绑定下，server 能力升级会打开 provider；重复 welcome 不重复刷新。
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'mock-new', features: [HOOK_FEATURE_SLACK_TOOLS] }),
      ),
    );
    await expect.poll(() => changes, { timeout: 3000 }).toEqual([true]);
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'mock-new', features: [HOOK_FEATURE_SLACK_TOOLS] }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(changes).toEqual([true]);

    // 重连到旧 server 时按新 welcome 关闭；再次升级可重新打开。
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock-old', features: [] })));
    await expect.poll(() => changes, { timeout: 3000 }).toEqual([true, false]);
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'mock-new', features: [HOOK_FEATURE_SLACK_TOOLS] }),
      ),
    );
    await expect.poll(() => changes, { timeout: 3000 }).toEqual([true, false, true]);

    // confirmed 回放与短暂连接抖动都不改变最近一次成功能力快照。
    sock.send(serializeHookMessage(confirmed));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(changes).toEqual([true, false, true]);
    sock.close();
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).not.toBe('connected');
    expect(manager.getSlackToolAvailability().serverSupportsTools).toBe(true);
    expect(changes).toEqual([true, false, true]);

    manager.revokeAndDisconnect();
    expect(changes).toEqual([true, false, true, false]);
  });

  it('armAutoBind: 重开 toggle 撞上 server 回放的旧 pending → 重新发起并弹新链接', async () => {
    // 场景: 本地看门狗超时(3 分钟)早于 server 侧 pending TTL(10 分钟), toggle
    // 弹回后重开, server 按 hello 回放旧 pending —— 必须重发 bind.start 换新链接
    // 并弹浏览器, 否则用户卡在「授权中」等一个永远不会弹出的授权页
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const opened: string[] = [];
    const manager = makeManager(store, { openExternalUrl: (u) => opened.push(u) });
    cleanups.push(() => manager.dispose());

    manager.armAutoBind();
    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    // server 回放旧的进行中授权(旧链接)
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'pending',
          slackUserId: null,
          slackUserName: null,
          message: null,
          authorizeUrl: 'https://slack.example.com/authorize?state=old',
        }),
      ),
    );
    // 自动重新发起(server 那头会作废旧尝试签新 state)
    await server.waitFor('bind.start');
    expect(opened).toEqual([]); // 旧链接不弹
    const freshUrl = 'https://slack.example.com/authorize?state=fresh';
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'pending',
          slackUserId: null,
          slackUserName: null,
          message: null,
          authorizeUrl: freshUrl,
        }),
      ),
    );
    await expect.poll(() => opened, { timeout: 3000 }).toEqual([freshUrl]);
  });

  it('armAutoBind: bind.update 处理中连接恰好掉线(send 失败)→ 意图保留待重连重试, 不弹回开关', async () => {
    // 场景: 用户刚开 toggle, server 回放 bind.update(none) 的同一时刻连接掉了,
    // bind.start 发不出去。旧行为会消费掉 autoBindIntent, 重连回放 none 时走
    // autoDisable 把开关静默弹回(用户视角: 点了开关没弹浏览器又自己关了);
    // 现在意图保留, 重连回放后自动重试发起授权。用 fake transport 精确控制
    // send 失败时机(真 ws 无法确定性模拟"处理帧时掉线")。
    const store = memoryStore({ url: 'wss://fake.example' });
    const sent: HookMessage[] = [];
    let sendOk = false;
    const transportOpts: Parameters<typeof createHookTransport>[0][] = [];
    const manager = makeManager(store, {
      createTransport: (opts) => {
        transportOpts.push(opts);
        return {
          send: (m) => {
            if (!sendOk) return false;
            sent.push(m);
            return true;
          },
          dispose: () => {},
        };
      },
      openExternalUrl: () => {},
    });
    cleanups.push(() => manager.dispose());

    manager.armAutoBind(); // 打开 toggle
    manager.sync();
    const opts = transportOpts[0];
    opts.onStatus('connected', null);
    const none = makeBindUpdate({ state: 'none', slackUserId: null, slackUserName: null, message: null });
    if (none.type !== 'bind.update') throw new Error('unreachable');

    // 第一帧 none: send 失败(掉线瞬间)→ 不 auto-disable, 意图保留
    opts.onMessage(none, (m) => (sendOk ? (sent.push(m), true) : false));
    expect(store.get().enabled).toBe(true);
    expect(sent.some((f) => f.type === 'bind.start')).toBe(false);

    // 重连回放 none: send 恢复 → 自动重试发起绑定, 开关仍开
    sendOk = true;
    opts.onMessage(none, (m) => (sent.push(m), true));
    expect(sent.some((f) => f.type === 'bind.start')).toBe(true);
    expect(store.get().enabled).toBe(true);
    expect(manager.snapshot().binding?.state).toBe('pending');
  });

  it('授权看门狗: 超时仍 pending(用户关掉浏览器)→ 本地判 expired, toggle 弹回', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store, {
      openExternalUrl: () => {},
      bindPendingTimeoutMs: 120,
    });
    cleanups.push(() => manager.dispose());

    manager.armAutoBind();
    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'none', slackUserId: null, slackUserName: null, message: null }),
      ),
    );
    await server.waitFor('bind.start');
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'pending',
          slackUserId: null,
          slackUserName: null,
          message: null,
          authorizeUrl: 'https://slack.example.com/authorize?state=z',
        }),
      ),
    );
    // 浏览器被用户直接关掉 = 永远等不到回调 → 看门狗到点本地判 expired 并弹回 toggle
    await expect.poll(() => store.get().enabled, { timeout: 3000 }).toBe(false);
    expect(manager.snapshot().binding?.state).toBe('expired');
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('disabled');
  });

  it('授权看门狗: 超时前授权完成(confirmed)→ 撤计时器, 不误关', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store, {
      openExternalUrl: () => {},
      bindPendingTimeoutMs: 120,
    });
    cleanups.push(() => manager.dispose());

    manager.armAutoBind();
    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'none', slackUserId: null, slackUserName: null, message: null }),
      ),
    );
    await server.waitFor('bind.start');
    sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'confirmed', slackUserId: 'U1', slackUserName: 'devuser', message: null }),
      ),
    );
    await expect.poll(() => manager.snapshot().binding?.state, { timeout: 3000 }).toBe('confirmed');
    // 熬过看门狗时限: 已 confirmed 不该被误判超时
    await new Promise((r) => setTimeout(r, 200));
    expect(store.get().enabled).toBe(true);
    expect(manager.snapshot().binding?.state).toBe('confirmed');
    expect(manager.snapshot().status).toBe('connected');
  });

  it('revokeAndDisconnect(关 toggle): 发 bind.revoke 解绑并断开, 本地绑定归零', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');
    sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'confirmed', slackUserId: 'U1', slackUserName: 'devuser', message: null }),
      ),
    );
    await expect.poll(() => manager.snapshot().binding?.state, { timeout: 3000 }).toBe('confirmed');

    // 关 toggle: 解除绑定并断开(再开需重新授权)
    manager.revokeAndDisconnect();
    store.setEnabled(false);
    manager.sync();
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('disabled');
    await expect
      .poll(() => server.frames.some((f) => f.type === 'bind.revoke'), { timeout: 3000 })
      .toBe(true);
    // 本地绑定态归零(stop 后收不到 server 回的 none 帧, 主动置)
    expect(manager.snapshot().binding?.state).toBe('none');
  });

  it('server 不可达时进入 error/connecting 并保持重试, dispose 干净退出', async () => {
    const store = memoryStore({ url: 'ws://127.0.0.1:1' });
    const manager = makeManager(store);
    manager.sync();
    await expect
      .poll(() => {
        const s = manager.snapshot().status;
        return s === 'error' || s === 'connecting';
      }, { timeout: 5000 })
      .toBe(true);
    // dispose 后所有 timer/socket 释放 —— 测试进程能自然退出即证明无泄漏
    manager.dispose();
  });
});

describe('目录偏好远程读写(prefs.get / prefs.set / prefs.state 往返)', () => {
  /** 建连到 connected 的快捷流程, 返回 server socket + 帧收集器。 */
  async function connect(
    manager: ReturnType<typeof createHookControlManager>,
    wss: WebSocketServer,
  ): Promise<{ sock: ServerSocket; server: ReturnType<typeof collectFrames> }> {
    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');
    return { sock, server };
  }

  const PREFS_VIEW = {
    bound: true,
    prefs: [
      {
        workspace: 'xdmaker',
        model: 'claude-opus-4-8',
        effort: 'high',
        agentKind: 'claude-code',
        permissionMode: 'ask',
      },
    ],
  };

  it('getWorkspacePrefs: 发 prefs.get(带 requestId), replyTo 配对 resolve 并广播', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const notified: unknown[] = [];
    const manager = makeManager(store, { notifyPrefs: (v) => notified.push(v) });
    cleanups.push(() => manager.dispose());
    const { sock, server } = await connect(manager, wss);

    const promise = manager.getWorkspacePrefs();
    const get = await server.waitFor('prefs.get');
    if (get.type !== 'prefs.get') throw new Error('unreachable');
    expect(get.payload.requestId.length).toBeGreaterThan(0);
    sock.send(
      serializeHookMessage(
        makePrefsState({ replyTo: get.payload.requestId, ...PREFS_VIEW }),
      ),
    );
    await expect(promise).resolves.toEqual(PREFS_VIEW);
    expect(notified).toEqual([PREFS_VIEW]); // 回执同样广播(多窗口同步)
  });

  it('setWorkspacePrefs: 帧只含已定义 patch 字段(undefined 不进帧, null 保留)', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());
    const { sock, server } = await connect(manager, wss);

    const promise = manager.setWorkspacePrefs('xdmaker', { effort: 'low', permissionMode: null });
    const set = await server.waitFor('prefs.set');
    if (set.type !== 'prefs.set') throw new Error('unreachable');
    expect(set.payload.workspace).toBe('xdmaker');
    expect(set.payload.effort).toBe('low');
    expect(set.payload.permissionMode).toBeNull();
    expect('model' in set.payload).toBe(false);
    expect('agentKind' in set.payload).toBe(false);
    sock.send(serializeHookMessage(makePrefsState({ replyTo: set.payload.requestId, ...PREFS_VIEW })));
    await expect(promise).resolves.toEqual(PREFS_VIEW);
  });

  it('server 静默(旧版本丢 prefs 帧): 按注入的短超时拒绝 HookPrefsTimeoutError', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store, { prefsTimeoutMs: 100 });
    cleanups.push(() => manager.dispose());
    await connect(manager, wss);

    await expect(manager.getWorkspacePrefs()).rejects.toBeInstanceOf(HookPrefsTimeoutError);
  });

  it('未连接: 立即拒绝 HookNotConnectedError', async () => {
    const store = memoryStore({ url: 'ws://127.0.0.1:1', enabled: false });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());
    await expect(manager.getWorkspacePrefs()).rejects.toBeInstanceOf(HookNotConnectedError);
  });

  it('主动推送(replyTo null): 只广播, 不惊动在途请求', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const notified: unknown[] = [];
    const manager = makeManager(store, { notifyPrefs: (v) => notified.push(v), prefsTimeoutMs: 300 });
    cleanups.push(() => manager.dispose());
    const { sock, server } = await connect(manager, wss);

    const promise = manager.getWorkspacePrefs();
    await server.waitFor('prefs.get');
    // /model 卡改动触发的主动推送先到 —— 广播但不 resolve 在途请求
    sock.send(serializeHookMessage(makePrefsState({ replyTo: null, ...PREFS_VIEW })));
    await expect.poll(() => notified.length, { timeout: 2000 }).toBe(1);
    await expect(promise).rejects.toBeInstanceOf(HookPrefsTimeoutError); // 无回执, 到点超时
  });

  it('断线在途请求快速失败(不挂满超时)', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store, { prefsTimeoutMs: 60_000 });
    cleanups.push(() => manager.dispose());
    const { sock, server } = await connect(manager, wss);

    const promise = manager.getWorkspacePrefs();
    await server.waitFor('prefs.get');
    sock.close(); // server 掉线
    await expect(promise).rejects.toBeInstanceOf(HookNotConnectedError);
  });
});

describe('refreshHello(工作目录变更在线重报, 不重建连接)', () => {
  it('已连接: 原连接上重发 hello 携带最新别名清单; 连接不断', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, workspaces: { xdmaker: 'E:\AIWork\XDMaker' } });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    let closed = false;
    sock.on('close', () => (closed = true));
    store.setWorkspaces({ xdmaker: 'E:\AIWork\XDMaker', blog: 'D:\repos\blog' });
    expect(manager.refreshHello()).toBe(true);

    await expect
      .poll(
        () => server.frames.filter((f) => f.type === 'hello').length,
        { timeout: 3000 },
      )
      .toBe(2);
    const second = server.frames.filter((f) => f.type === 'hello').at(-1);
    if (second?.type !== 'hello') throw new Error('unreachable');
    expect([...second.payload.workspaces].sort()).toEqual(['blog', 'chat', 'xdmaker']);
    expect(closed).toBe(false); // 连接原地不动 —— 这是与 sync() 重建的本质区别
    expect(manager.snapshot().status).toBe('connected');
  });

  it('未连接: 返回 false(调用方回退 sync)', async () => {
    const store = memoryStore({ url: 'ws://127.0.0.1:1', enabled: false });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());
    expect(manager.refreshHello()).toBe(false);
  });
});

describe('内置 chat 伪目录的清单注入', () => {
  it("query 'workspaces' 应答含 chat 且排第一; 与真实别名去重", async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, workspaces: WORKSPACES });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    sock.send(serializeHookMessage(makeQueryRequest({ queryId: 'q-ws', kind: 'workspaces' })));
    const resp = await server.waitFor('query.response');
    if (resp.type !== 'query.response') throw new Error('unreachable');
    expect(resp.payload.workspaces?.[0]).toBe('chat');
    expect([...(resp.payload.workspaces ?? [])].sort()).toEqual(['blog', 'chat', 'xdmaker']);
    // 去重: 即便(历史遗留)存量配置里有 chat 键, 也只出现一次
    expect(resp.payload.workspaces?.filter((w) => w === 'chat')).toHaveLength(1);
  });
});

describe('Slack 网关工具代理(tool.request/tool.response)', () => {
  /** 建连 -> welcome(带/不带 slack-tools)-> 绑定 confirmed 的通用起手。 */
  async function connectWithTools(opts: {
    features?: string[];
    confirmed?: boolean;
    toolTimeoutMs?: number;
  }) {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, workspaces: WORKSPACES });
    const manager = makeManager(store, {
      ...(opts.toolTimeoutMs !== undefined ? { toolTimeoutMs: opts.toolTimeoutMs } : {}),
    });
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'mock', features: opts.features ?? [HOOK_FEATURE_SLACK_TOOLS] }),
      ),
    );
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');
    if (opts.confirmed !== false) {
      sock.send(
        serializeHookMessage(
          makeBindUpdate({
            state: 'confirmed',
            slackUserId: 'U1',
            slackUserName: 'tester',
            message: null,
          }),
        ),
      );
      await expect
        .poll(() => manager.snapshot().binding?.state, { timeout: 3000 })
        .toBe('confirmed');
    }
    return { manager, sock, server };
  }

  it('成功往返: tool.request 携带 tool/args, replyTo 配对 resolve 结果', async () => {
    const { manager, sock, server } = await connectWithTools({});
    const pending = manager.callSlackTool('callTool', { name: 'search', arguments: { q: 'x' } });
    const req = await server.waitFor('tool.request');
    if (req.type !== 'tool.request') throw new Error('unreachable');
    expect(req.payload.tool).toBe('callTool');
    expect(req.payload.args).toEqual({ name: 'search', arguments: { q: 'x' } });
    sock.send(
      serializeHookMessage(
        makeToolResponse({ replyTo: req.payload.requestId, ok: true, result: { hit: 1 } }),
      ),
    );
    expect(await pending).toEqual({ ok: true, result: { hit: 1 } });
    // 可用性快照三真
    expect(manager.getSlackToolAvailability()).toMatchObject({
      connected: true,
      bound: true,
      serverSupportsTools: true,
    });
  });

  it('server 侧结构化错误透传(code/message 原样)', async () => {
    const { manager, sock, server } = await connectWithTools({});
    const pending = manager.callSlackTool('listTools');
    const req = await server.waitFor('tool.request');
    if (req.type !== 'tool.request') throw new Error('unreachable');
    sock.send(
      serializeHookMessage(
        makeToolResponse({
          replyTo: req.payload.requestId,
          ok: false,
          error: { code: 'NO_USER_TOKEN', message: '需重新授权' },
        }),
      ),
    );
    const r = await pending;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ code: 'NO_USER_TOKEN', message: '需重新授权' });
  });

  it('SERVER_TOO_OLD: welcome 未宣告 slack-tools 时短路, 不发帧', async () => {
    const { manager, server } = await connectWithTools({ features: [] });
    const r = await manager.callSlackTool('status');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('SERVER_TOO_OLD');
    expect(server.frames.some((f) => f.type === 'tool.request')).toBe(false);
  });

  it('NOT_BOUND: 未绑定时短路, 不发帧', async () => {
    const { manager, server } = await connectWithTools({ confirmed: false });
    const r = await manager.callSlackTool('status');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_BOUND');
    expect(server.frames.some((f) => f.type === 'tool.request')).toBe(false);
  });

  it('HOOK_NOT_CONNECTED: 未连接时短路', async () => {
    const store = memoryStore({ url: 'ws://127.0.0.1:1', enabled: false });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());
    const r = await manager.callSlackTool('status');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('HOOK_NOT_CONNECTED');
  });

  it('TIMEOUT: server 不应答时按注入超时收口; 迟到应答静默丢弃', async () => {
    const { manager, sock, server } = await connectWithTools({ toolTimeoutMs: 60 });
    const pending = manager.callSlackTool('listTools');
    const req = await server.waitFor('tool.request');
    if (req.type !== 'tool.request') throw new Error('unreachable');
    const r = await pending;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('TIMEOUT');
    // 迟到帧: 不抛不炸(replyTo 已无配对)
    sock.send(
      serializeHookMessage(makeToolResponse({ replyTo: req.payload.requestId, ok: true, result: 1 })),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('断线 drain: 在途请求 resolve HOOK_NOT_CONNECTED; 能力保留到下一次 welcome 覆盖', async () => {
    const { manager, sock, server } = await connectWithTools({});
    const pending = manager.callSlackTool('listTools');
    await server.waitFor('tool.request');
    sock.close();
    const r = await pending;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('HOOK_NOT_CONNECTED');
    // 瞬时断线只让调用期 fail-closed，不触发 Codex 工具清单抖动；下一次 welcome
    // 会整组覆盖能力快照。
    expect(manager.getSlackToolAvailability()).toMatchObject({
      connected: false,
      serverSupportsTools: true,
    });
  });
});

describe('多 workspace 绑定(multi-team)', () => {
  const T1 = { teamId: 'T1', teamName: 'acme', slackUserId: 'U1', slackUserName: 'devuser' };
  const T2 = { teamId: 'T2', teamName: 'sideproj', slackUserId: 'U2', slackUserName: 'lizi2' };

  /** 建连到 connected 的 multi-team 起手(welcome 宣告 multi-team [+ 可选 slack-tools])。 */
  async function connectMulti(opts?: {
    managerOverrides?: Partial<HookControlManagerDeps>;
    features?: string[];
  }) {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store, opts?.managerOverrides ?? {});
    cleanups.push(() => manager.dispose());
    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(
      serializeHookMessage(
        makeWelcome({
          serverName: 'mock-multi',
          features: opts?.features ?? [HOOK_FEATURE_MULTI_TEAM],
        }),
      ),
    );
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');
    return { manager, store, sock, server, wss, url };
  }

  it('hello 声明 multi-team 能力; bind.state 快照整体对齐 + 写本地缓存 + legacy binding 映射', async () => {
    const { manager, store, sock, server } = await connectMulti();
    const hello = server.frames.find((f) => f.type === 'hello');
    if (hello?.type !== 'hello') throw new Error('unreachable');
    expect(hello.payload.features).toContain(HOOK_FEATURE_MULTI_TEAM);

    sock.send(serializeHookMessage(makeBindState({ bindings: [T1, T2] })));
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(2);
    const snap = manager.snapshot();
    expect(snap.serverMultiTeam).toBe(true);
    expect(snap.bindings).toEqual([
      { ...T1, displaced: false },
      { ...T2, displaced: false },
    ]);
    // legacy binding 字段映射为首个可用绑定(老消费点兼容)
    expect(snap.binding).toMatchObject({
      state: 'confirmed',
      slackUserId: 'U1',
      teamName: 'acme',
    });
    // 本地缓存随快照落盘
    expect(store.get().bindingsCache).toEqual([T1, T2]);
  });

  it('addBinding: 发空 bind.start, pending 落 pendingBind 并弹浏览器; confirmed(teamId) upsert 行 + 清 pendingBind', async () => {
    const opened: string[] = [];
    const { manager, sock, server } = await connectMulti({
      managerOverrides: { openExternalUrl: (u) => opened.push(u) },
    });
    sock.send(serializeHookMessage(makeBindState({ bindings: [T1] })));
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(1);

    expect(manager.addBinding()).toBe(true);
    const bind = await server.waitFor('bind.start');
    if (bind.type !== 'bind.start') throw new Error('unreachable');
    expect(bind.payload.teamId).toBeUndefined(); // 添加新 workspace: 授权页自选
    expect(manager.snapshot().pendingBind?.state).toBe('pending');

    const authorizeUrl = 'https://slack.example.com/authorize?state=add';
    sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'pending', slackUserId: null, slackUserName: null, message: null, authorizeUrl }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().pendingBind?.authorizeUrl, { timeout: 3000 })
      .toBe(authorizeUrl);
    expect(opened).toEqual([authorizeUrl]);
    // 已有真在途授权时重复 addBinding 幂等忽略(不重发帧)
    expect(manager.addBinding()).toBe(true);
    expect(server.frames.filter((f) => f.type === 'bind.start')).toHaveLength(1);

    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'confirmed',
          slackUserId: 'U2',
          slackUserName: 'lizi2',
          message: null,
          teamId: 'T2',
          teamName: 'sideproj',
        }),
      ),
    );
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(2);
    expect(manager.snapshot().pendingBind).toBeNull();
    expect(manager.snapshot().bindings[1]).toEqual({ ...T2, displaced: false });
  });

  it('rebindTeam: bind.start 带 teamId(pin 授权页)', async () => {
    const { manager, sock, server } = await connectMulti();
    sock.send(serializeHookMessage(makeBindState({ bindings: [T1] })));
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(1);
    expect(manager.rebindTeam('T1')).toBe(true);
    const bind = await server.waitFor('bind.start');
    if (bind.type !== 'bind.start') throw new Error('unreachable');
    expect(bind.payload.teamId).toBe('T1');
    expect(manager.snapshot().pendingBind).toMatchObject({ state: 'pending', teamId: 'T1' });
  });

  it('revoked(teamId, reason=superseded): 行保留标注 displaced, 不弹开关不掉线', async () => {
    const { manager, store, sock } = await connectMulti();
    sock.send(serializeHookMessage(makeBindState({ bindings: [T1, T2] })));
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(2);

    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'revoked',
          slackUserId: null,
          slackUserName: null,
          message: '已在另一台设备绑定',
          teamId: 'T1',
          reason: 'superseded',
        }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().bindings.find((b) => b.teamId === 'T1')?.displaced, {
        timeout: 3000,
      })
      .toBe(true);
    // 另一行不受影响; 总开关不弹回, 连接保持
    expect(manager.snapshot().bindings.find((b) => b.teamId === 'T2')?.displaced).toBe(false);
    expect(store.get().enabled).toBe(true);
    expect(manager.snapshot().status).toBe('connected');
  });

  it('revoked(teamId, 无 reason): 行直接移除', async () => {
    const { manager, sock } = await connectMulti();
    sock.send(serializeHookMessage(makeBindState({ bindings: [T1, T2] })));
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(2);
    sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'revoked', slackUserId: null, slackUserName: null, message: null, teamId: 'T1' }),
      ),
    );
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(1);
    expect(manager.snapshot().bindings[0].teamId).toBe('T2');
  });

  it('revokeTeam: 发 bind.revoke{teamId} 并乐观移除; displaced 行删除 = 仅清本地', async () => {
    const { manager, store, sock, server } = await connectMulti();
    sock.send(serializeHookMessage(makeBindState({ bindings: [T1, T2] })));
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(2);

    expect(manager.revokeTeam('T1')).toBe(true);
    const revoke = await server.waitFor('bind.revoke');
    if (revoke.type !== 'bind.revoke') throw new Error('unreachable');
    expect(revoke.payload.teamId).toBe('T1');
    expect(manager.snapshot().bindings.map((b) => b.teamId)).toEqual(['T2']);
    expect(store.get().bindingsCache.map((b) => b.teamId)).toEqual(['T2']);

    // displaced 行删除: 不发帧, 只清本地缓存
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'revoked',
          slackUserId: null,
          slackUserName: null,
          message: null,
          teamId: 'T2',
          reason: 'superseded',
        }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().bindings.find((b) => b.teamId === 'T2')?.displaced, {
        timeout: 3000,
      })
      .toBe(true);
    const framesBefore = server.frames.filter((f) => f.type === 'bind.revoke').length;
    expect(manager.revokeTeam('T2')).toBe(true);
    expect(manager.snapshot().bindings).toEqual([]);
    expect(store.get().bindingsCache).toEqual([]);
    await new Promise((r) => setTimeout(r, 30));
    expect(server.frames.filter((f) => f.type === 'bind.revoke')).toHaveLength(framesBefore);
  });

  it('cancelPendingBind: 本地清 pendingBind + 发 bind.revoke{pendingOnly}', async () => {
    const { manager, sock, server } = await connectMulti({
      managerOverrides: { openExternalUrl: () => {} },
    });
    sock.send(serializeHookMessage(makeBindState({ bindings: [T1] })));
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(1);
    manager.addBinding();
    await server.waitFor('bind.start');
    expect(manager.snapshot().pendingBind?.state).toBe('pending');

    expect(manager.cancelPendingBind()).toBe(true);
    expect(manager.snapshot().pendingBind).toBeNull();
    const revoke = await server.waitFor('bind.revoke');
    if (revoke.type !== 'bind.revoke') throw new Error('unreachable');
    expect(revoke.payload.pendingOnly).toBe(true);
    expect(revoke.payload.teamId ?? null).toBeNull();
  });

  it('关开关(multi-team): 不发全量 bind.revoke, 绑定保留, 重开秒恢复', async () => {
    const { manager, store, sock, server } = await connectMulti();
    sock.send(serializeHookMessage(makeBindState({ bindings: [T1, T2] })));
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(2);

    // ipc SET_ENABLED(false) 的编排: revokeAndDisconnect -> setEnabled -> sync
    manager.revokeAndDisconnect();
    store.setEnabled(false);
    manager.sync();
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('disabled');
    // 没有任何 bind.revoke 帧(无在途授权时连 pendingOnly 也不发)
    expect(server.frames.some((f) => f.type === 'bind.revoke')).toBe(false);
    // 绑定与缓存保留 —— 「已关闭 · N 个绑定已保留」的数据源
    expect(manager.snapshot().bindings).toHaveLength(2);
    expect(store.get().bindingsCache).toHaveLength(2);
  });

  it('本地缓存 diff: 服务端快照缺失的 team 生成 displaced 行(离线期间被顶)', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, bindingsCache: [T1, T2] });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());
    // 冷启动(未连接)即可从缓存显示绑定行
    expect(manager.snapshot().bindings).toHaveLength(2);

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(
      serializeHookMessage(makeWelcome({ serverName: 'mock', features: [HOOK_FEATURE_MULTI_TEAM] })),
    );
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    // 服务端只剩 T2(T1 在离线期间被另一台设备顶掉)
    sock.send(serializeHookMessage(makeBindState({ bindings: [T2] })));
    await expect
      .poll(() => manager.snapshot().bindings.find((b) => b.teamId === 'T1')?.displaced, {
        timeout: 3000,
      })
      .toBe(true);
    expect(manager.snapshot().bindings.find((b) => b.teamId === 'T2')?.displaced).toBe(false);
    // displaced 行的 team 信息留在缓存(重启后仍能显示与重绑)
    expect(store.get().bindingsCache.map((b) => b.teamId).sort()).toEqual(['T1', 'T2']);
  });

  it('老 server 回落: welcome 无 multi-team 时清掉缓存行, 多绑定动作全部拒绝', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, bindingsCache: [T1] });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());
    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock-old', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    // 老 server 是单绑定权威: 缓存行清空, UI 回落单绑定样式
    expect(manager.snapshot().serverMultiTeam).toBe(false);
    expect(manager.snapshot().bindings).toEqual([]);
    expect(store.get().bindingsCache).toEqual([]);
    // 多绑定动作 no-op(不发帧)
    expect(manager.addBinding()).toBe(false);
    expect(manager.rebindTeam('T1')).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(server.frames.some((f) => f.type === 'bind.start')).toBe(false);
  });

  it('armAutoBind + 空 bind.state: 延迟窗后自动发起首绑(server 无 pending 回放)', async () => {
    const opened: string[] = [];
    const { manager, sock, server } = await connectMulti({
      managerOverrides: { openExternalUrl: (u) => opened.push(u) },
    });
    manager.armAutoBind();
    sock.send(serializeHookMessage(makeBindState({ bindings: [] })));
    // 延迟窗(300ms)后发起
    const bind = await server.waitFor('bind.start');
    expect(bind.type).toBe('bind.start');
    const authorizeUrl = 'https://slack.example.com/authorize?state=first';
    sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'pending', slackUserId: null, slackUserName: null, message: null, authorizeUrl }),
      ),
    );
    await expect.poll(() => opened, { timeout: 3000 }).toEqual([authorizeUrl]);
  });

  it('armAutoBind + 空 bind.state 后紧跟 pending 回放: 重新发起换新链接, 不用旧链接弹浏览器', async () => {
    const opened: string[] = [];
    const { manager, sock, server } = await connectMulti({
      managerOverrides: { openExternalUrl: (u) => opened.push(u) },
    });
    manager.armAutoBind();
    sock.send(serializeHookMessage(makeBindState({ bindings: [] })));
    // server 回放旧的进行中授权(旧链接) —— 在延迟窗内先到
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'pending',
          slackUserId: null,
          slackUserName: null,
          message: null,
          authorizeUrl: 'https://slack.example.com/authorize?state=stale',
        }),
      ),
    );
    await server.waitFor('bind.start');
    expect(opened).toEqual([]); // 旧链接不弹
    const freshUrl = 'https://slack.example.com/authorize?state=fresh';
    sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'pending', slackUserId: null, slackUserName: null, message: null, authorizeUrl: freshUrl }),
      ),
    );
    await expect.poll(() => opened, { timeout: 3000 }).toEqual([freshUrl]);
    // 延迟窗过去后也不会再多发一次 bind.start(意图已消费)
    await new Promise((r) => setTimeout(r, 400));
    expect(server.frames.filter((f) => f.type === 'bind.start')).toHaveLength(1);
  });

  it('首绑终止态(denied): 开关弹回后快照保留 pendingBind 终止态(设置页兜底行数据源)', async () => {
    const { manager, store, sock, server } = await connectMulti();
    manager.armAutoBind();
    sock.send(serializeHookMessage(makeBindState({ bindings: [] })));
    await server.waitFor('bind.start');
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'pending',
          slackUserId: null,
          slackUserName: null,
          message: null,
          authorizeUrl: 'https://slack.example.com/authorize?state=x',
        }),
      ),
    );
    await expect.poll(() => manager.snapshot().pendingBind?.state, { timeout: 3000 }).toBe('pending');
    // 用户在授权页点取消 → server 推 denied → 首绑(0 绑定)自动关开关,
    // 但终止态必须留在快照里 —— 渲染层靠它显示失败原因与重试提示,
    // 否则用户只看到开关静默弹回(review P1)
    sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'denied', slackUserId: null, slackUserName: null, message: null }),
      ),
    );
    await expect.poll(() => store.get().enabled, { timeout: 3000 }).toBe(false);
    const snap = manager.snapshot();
    expect(snap.pendingBind?.state).toBe('denied');
    expect(snap.bindings).toEqual([]);
  });

  it('添加流授权落在已绑定 team: 合成 already-bound 终止态提示; 指定 team 重绑不提示', async () => {
    const { manager, sock, server } = await connectMulti();
    sock.send(serializeHookMessage(makeBindState({ bindings: [T1] })));
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(1);

    // 「添加 workspace」流: 用户在授权页没切 workspace, confirmed 回的还是 T1
    expect(manager.addBinding()).toBe(true);
    await server.waitFor('bind.start');
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'confirmed',
          slackUserId: 'U1',
          slackUserName: 'devuser',
          message: null,
          teamId: 'T1',
          teamName: 'acme',
        }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().pendingBind?.reason, { timeout: 3000 })
      .toBe('already-bound');
    const snap = manager.snapshot();
    expect(snap.pendingBind?.state).toBe('failed');
    expect(snap.pendingBind?.teamId).toBe('T1');
    expect(snap.bindings).toHaveLength(1);

    // 指定 team 的重绑(刷新授权)回到同 team 是预期动作, 不合成提示
    expect(manager.cancelPendingBind()).toBe(true);
    expect(manager.rebindTeam('T1')).toBe(true);
    await expect
      .poll(() => server.frames.filter((f) => f.type === 'bind.start').length, { timeout: 3000 })
      .toBe(2);
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'confirmed',
          slackUserId: 'U1',
          slackUserName: 'devuser',
          message: null,
          teamId: 'T1',
          teamName: 'acme',
        }),
      ),
    );
    await expect.poll(() => manager.snapshot().pendingBind, { timeout: 3000 }).toBeNull();
    expect(manager.snapshot().bindings).toHaveLength(1);
  });

  it('tool.request 携带 teamId; bound 判据 = 存在可用绑定(无需 legacy confirmed)', async () => {
    const { manager, sock, server } = await connectMulti({
      features: [HOOK_FEATURE_MULTI_TEAM, HOOK_FEATURE_SLACK_TOOLS],
    });
    sock.send(serializeHookMessage(makeBindState({ bindings: [T1, T2] })));
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(2);
    expect(manager.getSlackToolAvailability()).toMatchObject({
      bound: true,
      multiTeam: true,
      bindings: [
        { teamId: 'T1', teamName: 'acme' },
        { teamId: 'T2', teamName: 'sideproj' },
      ],
    });

    const pending = manager.callSlackTool('callTool', { name: 'search' }, 'T2');
    const req = await server.waitFor('tool.request');
    if (req.type !== 'tool.request') throw new Error('unreachable');
    expect(req.payload.teamId).toBe('T2');
    sock.send(
      serializeHookMessage(makeToolResponse({ replyTo: req.payload.requestId, ok: true, result: 1 })),
    );
    expect(await pending).toEqual({ ok: true, result: 1 });

    // 不带 teamId 的调用(如 status 总览)不注入字段
    const pending2 = manager.callSlackTool('status');
    const req2 = await new Promise<HookMessage>((resolve) => {
      const check = (): void => {
        const hits = server.frames.filter((f) => f.type === 'tool.request');
        if (hits.length >= 2) resolve(hits[1]);
        else setTimeout(check, 10);
      };
      check();
    });
    if (req2.type !== 'tool.request') throw new Error('unreachable');
    expect('teamId' in req2.payload).toBe(false);
    sock.send(
      serializeHookMessage(makeToolResponse({ replyTo: req2.payload.requestId, ok: true, result: 2 })),
    );
    expect(await pending2).toEqual({ ok: true, result: 2 });
  });

  it('prefs.set 携带 teamId(multi-team 下偏好归属)', async () => {
    const { manager, sock, server } = await connectMulti();
    sock.send(serializeHookMessage(makeBindState({ bindings: [T1] })));
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(1);

    const promise = manager.setWorkspacePrefs('xdmaker', { effort: 'low' }, 'T1');
    const set = await server.waitFor('prefs.set');
    if (set.type !== 'prefs.set') throw new Error('unreachable');
    expect(set.payload.teamId).toBe('T1');
    expect(set.payload.effort).toBe('low');
    sock.send(
      serializeHookMessage(
        makePrefsState({ replyTo: set.payload.requestId, bound: true, prefs: [] }),
      ),
    );
    await expect(promise).resolves.toEqual({ bound: true, prefs: [] });
  });
});
