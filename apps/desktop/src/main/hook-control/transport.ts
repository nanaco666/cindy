/**
 * hook-control/transport.ts
 * ---------------------------------------------------------------------------
 * 单条 hook 连接的 WS 传输层: desktop 主动拨出到中心 slack-hook-server。
 *
 *   - 拨出方向: 本机不开任何监听端口(与 feishu WSClient 同一模型),
 *     鉴权用 Authorization: Bearer <登录 accessToken> 头
 *     (与 device-link 同模型; token 每次重连实时取, 刷新天然兼容)。
 *   - 协议帧: 全部经 @cindy/slack-hook-protocol —— 出帧走构造器 + serialize, 入帧
 *     一律先过 parseHookMessage, 坏帧记日志丢弃(规则 9)。
 *   - 生命周期: open -> 发 hello -> 等 welcome(此后状态才算 connected) ->
 *     心跳(定期 ping + 空闲看门狗); 断开按指数退避重连(1s -> 30s 封顶),
 *     welcome 到达后退避归零。
 *   - ping 自动回 pong 在本层处理(纯协议行为); 其余消息透传给上层
 *     (manager 决定业务响应, 如 dispatch 的 stub ack)。
 */

import WebSocket from 'ws';

import {
  makeHello,
  makePing,
  makePong,
  parseHookMessage,
  serializeHookMessage,
  type HelloInput,
  type HookMessage,
} from '@cindy/slack-hook-protocol';

/** transport 对外状态(manager 映射为 HookConnectionStatus)。 */
export type HookTransportStatus = 'connecting' | 'connected' | 'error' | 'stopped';

export interface HookTransportOpts {
  url: string;
  /**
   * 建连时实时取登录 accessToken(每次重连重取; 现值缺失时调用方内部可
   * refresh)。返回 null = 当前未登录, 本轮跳过并按退避重试 —— 登录事件
   * 会经 manager.sync 重建 transport, 不依赖这里的轮询。
   */
  getAuthToken: () => Promise<string | null>;
  /** 每次连接成功后发送的 hello 内容(重读配置, 别名变更即时生效)。 */
  buildHello: () => HelloInput;
  /** welcome / ping / pong 之外的消息透传(dispatch 等业务帧)。send 返回是否送出。 */
  onMessage: (msg: HookMessage, send: (m: HookMessage) => boolean) => void;
  onStatus: (status: HookTransportStatus, lastError: string | null) => void;
  log: { info(msg: string): void; warn(msg: string): void; debug?(msg: string): void };
}

export interface HookTransport {
  send(msg: HookMessage): boolean;
  dispose(): void;
}

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** 心跳发送间隔。 */
const PING_INTERVAL_MS = 25_000;
/** 空闲看门狗: 超过该时长没收到任何帧视为死链, 主动断开触发重连。 */
const IDLE_TIMEOUT_MS = 65_000;

export function createHookTransport(opts: HookTransportOpts): HookTransport {
  const { url, getAuthToken, buildHello, onMessage, onStatus, log } = opts;

  let ws: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let lastFrameAt = 0;
  let lastError: string | null = null;

  function setStatus(status: HookTransportStatus): void {
    if (stopped && status !== 'stopped') return;
    onStatus(status, lastError);
  }

  function clearTimers(): void {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function scheduleRetry(): void {
    if (stopped || retryTimer) return;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  function send(msg: HookMessage): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(serializeHookMessage(msg));
      return true;
    } catch (err) {
      log.warn(`send failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  function startHeartbeat(): void {
    lastFrameAt = Date.now();
    pingTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // 看门狗先于 ping: 长时间静默直接判死, terminate 触发 close -> 重连
      if (Date.now() - lastFrameAt > IDLE_TIMEOUT_MS) {
        log.warn('idle timeout, terminating connection');
        ws.terminate();
        return;
      }
      send(makePing());
    }, PING_INTERVAL_MS);
  }

  function connect(): void {
    if (stopped) return;
    setStatus('connecting');
    void getAuthToken()
      .catch(() => null)
      .then((token) => {
        if (stopped) return;
        if (!token) {
          // 未登录: 不发起无凭证连接(必 401), 记状态按退避重试;
          // 登录事件会经 manager.sync 重建 transport 即时恢复
          lastError = 'not logged in';
          setStatus('error');
          scheduleRetry();
          return;
        }
        openSocket(token);
      });
  }

  function openSocket(token: string): void {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
        handshakeTimeout: 15_000,
      });
    } catch (err) {
      // URL 非法等同步失败: 记错误并按退避重试(配置修好后自然恢复)
      lastError = err instanceof Error ? err.message : String(err);
      setStatus('error');
      scheduleRetry();
      return;
    }
    ws = socket;

    socket.on('open', () => {
      if (stopped) return;
      // open 只代表 TCP/WS 通了; connected 状态等 welcome —— 先自报家门
      send(makeHello(buildHello()));
      startHeartbeat();
    });

    socket.on('message', (data) => {
      if (stopped) return;
      lastFrameAt = Date.now();
      const parsed = parseHookMessage(typeof data === 'string' ? data : data.toString('utf-8'));
      if (!parsed.ok) {
        log.warn(`bad frame dropped: ${parsed.error}`);
        return;
      }
      const msg = parsed.message;
      if (msg.type === 'ping') {
        send(makePong());
        return;
      }
      if (msg.type === 'pong') return;
      if (msg.type === 'welcome') {
        attempt = 0;
        lastError = null;
        log.info(`handshake complete with ${msg.payload.serverName}`);
        setStatus('connected');
        return;
      }
      onMessage(msg, send);
    });

    socket.on('error', (err) => {
      lastError = err instanceof Error ? err.message : String(err);
      log.warn(`ws error: ${lastError}`);
    });

    socket.on('close', (code) => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      ws = null;
      if (stopped) return;
      log.info(`ws closed (code=${code}), scheduling reconnect`);
      setStatus(lastError ? 'error' : 'connecting');
      scheduleRetry();
    });
  }

  connect();

  return {
    send,
    dispose() {
      stopped = true;
      clearTimers();
      try {
        ws?.terminate();
      } catch {
        /* already closed */
      }
      ws = null;
      onStatus('stopped', null);
    },
  };
}
