/**
 * transport + manager 集成测试(单连接 + JWT 形态): 对真实 ws server
 * (WebSocketServer, 端口 0)跑完整行为 —— 登录 token 鉴权头、hello 自报
 * 别名、welcome 后状态 connected、ping 自动回 pong、dispatch 的 stub ack、
 * 未登录不发起连接、setEnabled(false) 停线。依赖全部注入, 不需要 Electron。
 */

import { once } from 'node:events';

import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import {
  makeBindUpdate,
  makePing,
  makePrefsState,
  makeQueryRequest,
  makeTaskDispatch,
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
import { createHookTransport } from '../transport';
import type { SlackHookStore, SlackHookConfigState } from '../store';

const noopLog = { info: () => {}, warn: () => {} };

/** 内存版单配置 store。 */
function memoryStore(initial: Partial<SlackHookConfigState> & { url: string }): SlackHookStore {
  let state: SlackHookConfigState = {
    enabled: initial.enabled ?? true,
    urlOverride: initial.url,
    workspaces: initial.workspaces ?? {},
  };
  return {
    get: () => ({ ...state, workspaces: { ...state.workspaces } }),
    effectiveUrl: () => state.urlOverride ?? 'wss://unused.example',
    setEnabled(enabled) {
      state = { ...state, enabled };
      return state;
    },
    setWorkspaces(workspaces) {
      state = { ...state, workspaces };
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
        makeBindUpdate({ state: 'confirmed', slackUserId: 'U1', slackUserName: 'lizi', message: null }),
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
          slackUserName: 'lizi',
          message: null,
          teamName: 'xindong',
        }),
      ),
    );
    await expect.poll(() => manager.snapshot().binding?.state, { timeout: 3000 }).toBe('confirmed');
    await new Promise((r) => setTimeout(r, 50));
    expect(server.frames.some((f) => f.type === 'bind.start')).toBe(false);
    expect(opened).toEqual([]);
    // workspace 名透传进绑定快照(状态行「已绑定 <team> @<name>」数据源)
    expect(manager.snapshot().binding?.teamName).toBe('xindong');
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
        makeBindUpdate({ state: 'confirmed', slackUserId: 'U1', slackUserName: 'lizi', message: null }),
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
        makeBindUpdate({ state: 'confirmed', slackUserId: 'U1', slackUserName: 'lizi', message: null }),
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
