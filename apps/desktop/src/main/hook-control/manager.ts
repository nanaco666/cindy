/**
 * hook-control/manager.ts
 * ---------------------------------------------------------------------------
 * Slack Hook 连接编排(单连接形态): 持有唯一 transport 的生命周期与运行时
 * 状态(连接态 / 最新绑定态), 供 IPC 快照与状态推送。
 *
 * 与多连接旧版的差异: 服务器是公司中心部署的唯一实例, 地址内置、鉴权走
 * 登录 JWT(token 源注入), 不再有连接列表 / per 连接 secret。dispatcher 与
 * bindings 的 connectionId 维度保留(键固定为 SLACK_HOOK_CONNECTION_ID),
 * 其实现不感知单/多连接差异。
 *
 * 依赖全部注入(store / transport 工厂 / token 源 / 设备信息 / 状态回调),
 * 测试用内存 harness 直接驱动(规则 14); Electron 绑定在 ipc.ts 组装。
 */

import { randomUUID } from 'node:crypto';

import {
  HOOK_FEATURE_SLACK_TOOLS,
  makeBindRevoke,
  makeBindStart,
  makeHello,
  makePrefsGet,
  makePrefsSet,
  makeQueryResponse,
  makeTaskAck,
  makeToolRequest,
  type HelloInput,
  type HookMessage,
} from '@cindy/slack-hook-protocol';

import {
  HOOK_BIND_REASON_NOT_INSTALLED,
  HOOK_CHAT_WORKSPACE_ALIAS,
} from '../../shared/hookControlIpc.js';
import type {
  HookBindingView,
  HookConnectionStatus,
  HookPrefsPatch,
  HookPrefsView,
  SlackHookView,
} from '../../shared/hookControlIpc.js';
import type { SlackHookStore } from './store.js';
import type { HookDispatcher } from './dispatcher.js';
import { buildQueryResponse, type AgentModelSource } from './queryResponder.js';
import type { HookTransport, HookTransportOpts, HookTransportStatus } from './transport.js';

/** dispatcher / bindings 的 connectionId 固定键(单连接形态)。 */
export const SLACK_HOOK_CONNECTION_ID = 'slack';

export interface HookControlManagerDeps {
  store: SlackHookStore;
  /** transport 工厂 —— 生产为 createHookTransport, 测试可注入假实现。 */
  createTransport: (opts: HookTransportOpts) => HookTransport;
  /** 登录 accessToken 源(transport 每次建连实时取; null = 未登录)。 */
  getAuthToken: () => Promise<string | null>;
  /** hello 用的设备身份(authManager deviceId + hostname)。 */
  deviceInfo: () => { deviceId: string; deviceName: string };
  /** hello 声明的可用 agent 类型。 */
  agents: string[];
  /** 状态变化推送(IPC 层广播到所有窗口)。 */
  notifyStatus: (view: SlackHookView) => void;
  /** 目录偏好快照推送(prefs.state 到达时广播; 含请求回执与 /model 卡主动推)。 */
  notifyPrefs?: (view: HookPrefsView) => void;
  /** prefs 读写往返超时(默认 10s; 测试注短)。 */
  prefsTimeoutMs?: number;
  /** Slack 网关工具往返超时(默认 60s —— 搜索/长查询比 prefs 慢得多; 测试注短)。 */
  toolTimeoutMs?: number;
  /**
   * OIDC 授权等待上限(默认 3 分钟; 测试注短)。外部系统浏览器无法感知
   * 「用户直接关掉了授权页」, 只能本地超时兜底: 到点仍 pending 视为放弃,
   * toggle 自动弹回(与 server 推 expired 的自动下线同一条路径, 先到先赢)。
   */
  bindPendingTimeoutMs?: number;
  /** "等安装"上限(默认 10 分钟; 测试注短)。见 DEFAULT_INSTALL_WAIT_TIMEOUT_MS。 */
  installWaitTimeoutMs?: number;
  /** 任务派发器。不注入时 dispatch 走 stub 拒绝(纯连接层测试用)。 */
  dispatcher?: HookDispatcher;
  /** query.request(models)的数据源(与会话选择器同规则实时派生, 允许异步); 不注入回空清单。 */
  listAgentModels?: () => AgentModelSource[] | Promise<AgentModelSource[]>;
  /**
   * 打开系统浏览器(SIWS OIDC 授权链接)。生产注入 electron shell.openExternal,
   * 测试注入假实现 —— 避免 manager 顶层 import electron(vitest 环境无 electron)。
   * 不注入时为 no-op(纯连接层测试)。
   */
  openExternalUrl?: (url: string) => void;
  log: { info(msg: string): void; warn(msg: string): void };
}

export interface HookControlManager {
  /** 按当前配置 + 登录态同步连接(启动 / 开关 / 配置变更 / 登录态变化后调用)。 */
  sync(): void;
  /**
   * 在线上重发 hello(重读配置, 别名清单以最新一帧为准 —— 协议明确支持)。
   * 工作目录变更时优先走这里, 避免整条连接重建造成设置页状态闪烁;
   * false = 未连接, 调用方回退 sync()(下次建连的 hello 自带新清单)。
   */
  refreshHello(): boolean;
  /** 渲染层快照。 */
  snapshot(): SlackHookView;
  /**
   * 发起 Slack 账号绑定(SIWS OIDC): 发 bind.start(无参); server 回
   * bind.update(pending, authorizeUrl), main 打开系统浏览器。false = 连接不在线。
   * 手动重试用; "开关即绑定"的自动路径走 armAutoBind + 连上后自动发起。
   */
  bindStart(): boolean;
  /**
   * 开关即绑定: 打开 toggle 时置一次性意图, 连上后 server 推回绑定现状 ——
   * none 自动发起 OIDC(弹浏览器), confirmed 不弹(已绑定秒恢复)。判定即清。
   */
  armAutoBind(): void;
  /** 解除 Slack 账号绑定(bind.revoke); 当前无 UI 入口, 保留供未来显式解绑。 */
  bindRevoke(): boolean;
  /**
   * 关闭开关: **解除绑定并断开** —— 在线则先发 bind.revoke(server 清绑定与
   * 一切在途登记), 本地绑定态归零, 再断开。再打开需重新走浏览器授权。
   * 离线时发不出 revoke(尽力而为), 服务端绑定保留, 重开会按 confirmed 秒恢复。
   */
  revokeAndDisconnect(): void;
  /**
   * 调用 server 侧 Slack 网关工具(tool.request -> tool.response 往返)。
   * 永不 reject —— 各类失败(未连接 / 未绑定 / server 太旧 / 超时 / server
   * 侧错误)一律 resolve 为 { ok:false, error:{code,message} }, MCP 工具层
   * 1:1 映射为结构化结果, 不需要 try/catch。
   */
  callSlackTool(tool: string, args?: Record<string, unknown>): Promise<HookSlackToolResult>;
  /** Slack 工具可用性快照(lizi_slack provider 的 isEnabled / slack_status 数据源)。 */
  getSlackToolAvailability(): HookSlackToolAvailability;
  /**
   * 拉取绑定用户的全部目录偏好快照(prefs.get -> prefs.state 往返)。
   * 未连接 reject HookNotConnectedError; 超时(server 太旧, prefs 帧被丢)
   * reject HookPrefsTimeoutError。
   */
  getWorkspacePrefs(): Promise<HookPrefsView>;
  /** 部分更新某目录偏好并返回写后的最新快照(语义同 getWorkspacePrefs)。 */
  setWorkspacePrefs(workspace: string, patch: HookPrefsPatch): Promise<HookPrefsView>;
  dispose(): void;
}

/** Slack 网关工具的结构化错误(server 码透传 + 本地码, 见 callSlackTool)。 */
export interface HookSlackToolError {
  /**
   * 错误码。本地产生的四种: HOOK_NOT_CONNECTED(未连接)/ NOT_BOUND(未绑定,
   * 本地短路)/ SERVER_TOO_OLD(welcome.features 无 slack-tools)/ TIMEOUT;
   * 其余为 server 侧透传(NO_USER_TOKEN / TOKEN_EXPIRED / RATE_LIMITED 等)。
   */
  code: string;
  message: string;
}

/** callSlackTool 的结构化结果(永不 throw)。 */
export type HookSlackToolResult =
  | { ok: true; result: unknown }
  | { ok: false; error: HookSlackToolError };

/** Slack 工具可用性快照。 */
export interface HookSlackToolAvailability {
  connected: boolean;
  /** 绑定已 confirmed。 */
  bound: boolean;
  /** server 已宣告 slack-tools 能力(welcome.features)。 */
  serverSupportsTools: boolean;
  binding: HookBindingView | null;
}

/** 连接不在线时的 prefs 读写失败(IPC 层映射 HOOK_NOT_CONNECTED)。 */
export class HookNotConnectedError extends Error {
  constructor() {
    super('slack hook connection is not connected');
    this.name = 'HookNotConnectedError';
  }
}

/** prefs 往返超时 —— server 大概率是不认识 prefs.* 帧的旧版本(丢帧不应答)。 */
export class HookPrefsTimeoutError extends Error {
  constructor() {
    super('hook server did not answer prefs request (server too old or stalled)');
    this.name = 'HookPrefsTimeoutError';
  }
}

/** prefs 往返默认超时(对齐 server 侧 queryBroker 的 10s)。 */
const DEFAULT_PREFS_TIMEOUT_MS = 10_000;

/** Slack 网关工具往返默认超时(全量搜索等长查询远慢于 prefs, 取宽上限)。 */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

/**
 * OIDC 授权等待默认上限: 已登录 Slack 的浏览器一键授权只要几秒, 3 分钟给足
 * 「浏览器里现登录 Slack」的余量; 超时即视为用户关掉/放弃了授权页。
 * (server 侧 state 令牌 TTL 10 分钟是安全上限, 与这里的 UX 上限是两回事。)
 */
const DEFAULT_BIND_PENDING_TIMEOUT_MS = 180_000;

/**
 * "等安装"默认上限: 授权检出 workspace 未装 App 后保持连接等 server 的
 * confirmed 推送(用户在浏览器走安装流程, 装完 server 自动补完绑定)。
 * 到点没等到即视为放弃, toggle 弹回。需小于 server 侧登记 TTL(15 分钟)。
 */
const DEFAULT_INSTALL_WAIT_TIMEOUT_MS = 600_000;

/** transport 状态 -> 渲染层状态。 */
function toViewStatus(s: HookTransportStatus | null, enabled: boolean): HookConnectionStatus {
  if (!enabled) return 'disabled';
  switch (s) {
    case 'connected':
      return 'connected';
    case 'error':
      return 'error';
    case 'stopped':
    case 'connecting':
    case null:
    default:
      return 'connecting';
  }
}

export function createHookControlManager(deps: HookControlManagerDeps): HookControlManager {
  const {
    store,
    createTransport,
    getAuthToken,
    deviceInfo,
    agents,
    notifyStatus,
    notifyPrefs,
    prefsTimeoutMs,
    toolTimeoutMs,
    bindPendingTimeoutMs,
    installWaitTimeoutMs,
    dispatcher,
    listAgentModels,
    openExternalUrl,
    log,
  } = deps;
  const id = SLACK_HOOK_CONNECTION_ID;

  let transport: HookTransport | null = null;
  let status: HookTransportStatus | null = null;
  let lastError: string | null = null;
  /** server 推送的最新绑定状态(bind.update); 未推送过为 null。 */
  let binding: HookBindingView | null = null;
  /**
   * 用户点「连接 Slack」发起 OIDC 后的一次性置位: 下一帧 bind.update(pending,
   * authorizeUrl)到达时打开系统浏览器一次即清 —— 重连时的 pending 状态回放
   * 不会重复弹浏览器(否则每次重连都弹一个 Slack 授权页)。
   */
  let openAuthorizeOnNextPending = false;
  /**
   * 一次性意图: 用户刚打开 toggle(armAutoBind), 连上后 server 按 hello 推回
   * 绑定现状 —— 若为 none(未绑定)则自动发起 OIDC 绑定(弹浏览器), 若已 confirmed
   * 则啥都不做(秒恢复不重弹)。在收到 bind.update 时判定, 避开 onConnected 时
   * 绑定态还没从 server 回来的竞态; 判定后即清, 不会每次重连都弹。
   */
  let autoBindIntent = false;
  /**
   * 授权看门狗: initiateBind 后计时, 到点仍停在 pending(用户关掉了浏览器 /
   * 放着没动)则本地判过期并自动关 toggle。bind.update 到达任何非 pending
   * 状态、或连接停止时清除。
   */
  let bindWatchdog: NodeJS.Timeout | null = null;
  /**
   * 安装看门狗: 授权检出 workspace 未装 App(failed + not-installed)后保持
   * 连接等 server 装完自动补完绑定的 confirmed 推送; 到点没等到则弹回 toggle。
   */
  let installWatchdog: NodeJS.Timeout | null = null;
  /** 在途的 prefs 往返(requestId -> 挂起 promise; prefs.state.replyTo 配对)。 */
  const pendingPrefs = new Map<
    string,
    { resolve: (v: HookPrefsView) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  /** 在途的 Slack 工具往返(requestId -> resolve; tool.response.replyTo 配对)。 */
  const pendingTools = new Map<
    string,
    { resolve: (v: HookSlackToolResult) => void; timer: NodeJS.Timeout }
  >();
  /** welcome 宣告的 server 能力集(断线清空 —— 重连可能落到另一版本实例)。 */
  let serverFeatures: string[] = [];
  let disposed = false;

  /** 断线/重建时在途 prefs 请求快速失败(不让 IPC invoke 挂满超时)。 */
  function drainPendingPrefs(): void {
    for (const [, pending] of pendingPrefs) {
      clearTimeout(pending.timer);
      pending.reject(new HookNotConnectedError());
    }
    pendingPrefs.clear();
  }

  /** 断线/重建时在途工具请求快速失败(resolve 结构化错误, 语义与 prefs 对齐)。 */
  function drainPendingTools(): void {
    for (const [, pending] of pendingTools) {
      clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        error: { code: 'HOOK_NOT_CONNECTED', message: 'Slack 连接已断开, 请稍后重试' },
      });
    }
    pendingTools.clear();
  }

  /** 发起一次 prefs 往返(get/set 共用): 连接就绪 -> 发帧 -> 等 replyTo 配对。 */
  function sendPrefsRequest(build: (requestId: string) => HookMessage): Promise<HookPrefsView> {
    const t = transport;
    if (t === null || status !== 'connected') {
      return Promise.reject(new HookNotConnectedError());
    }
    const requestId = randomUUID();
    const frame = build(requestId);
    return new Promise<HookPrefsView>((resolve, reject) => {
      if (!t.send(frame)) {
        reject(new HookNotConnectedError());
        return;
      }
      const timer = setTimeout(() => {
        pendingPrefs.delete(requestId);
        reject(new HookPrefsTimeoutError());
      }, prefsTimeoutMs ?? DEFAULT_PREFS_TIMEOUT_MS);
      timer.unref?.();
      pendingPrefs.set(requestId, { resolve, reject, timer });
    });
  }

  function toView(): SlackHookView {
    const config = store.get();
    return {
      enabled: config.enabled,
      url: store.effectiveUrl(),
      workspaces: { ...config.workspaces },
      status: toViewStatus(status, config.enabled),
      lastError: config.enabled ? lastError : null,
      binding,
    };
  }

  /**
   * bind.start 发出后的乐观置位: server 的 bind.update(pending)要一个网络
   * 往返才回来, 期间绑定态若停在 none 渲染层会闪回未绑定 UI; 这里先置
   * pending(authorizeUrl 暂空, 等 server 真值), 后续 bind.update 覆盖。
   */
  function markBindingPending(): void {
    binding = {
      state: 'pending',
      slackUserId: binding?.slackUserId ?? null,
      slackUserName: binding?.slackUserName ?? null,
      message: null,
      authorizeUrl: null,
      reason: null,
      installUrl: null,
      teamName: binding?.teamName ?? null,
    };
  }

  function clearBindWatchdog(): void {
    if (bindWatchdog !== null) {
      clearTimeout(bindWatchdog);
      bindWatchdog = null;
    }
  }

  function clearInstallWatchdog(): void {
    if (installWatchdog !== null) {
      clearTimeout(installWatchdog);
      installWatchdog = null;
    }
  }

  /**
   * 起安装看门狗: "等安装"期到点仍未收到 confirmed(用户没装 / 装到了别的
   * workspace / 放弃)则弹回 toggle 并断开; binding 保留 not-installed 供 UI
   * 显示原因与重试提示。
   */
  function armInstallWatchdog(): void {
    clearInstallWatchdog();
    installWatchdog = setTimeout(() => {
      installWatchdog = null;
      if (!store.get().enabled) return;
      if (binding?.state !== 'failed' || binding.reason !== HOOK_BIND_REASON_NOT_INSTALLED) return;
      autoBindIntent = false;
      openAuthorizeOnNextPending = false;
      store.setEnabled(false);
      stop();
      notifyStatus(toView());
      log.info('slack hook auto-disabled: app install not completed in time');
    }, installWaitTimeoutMs ?? DEFAULT_INSTALL_WAIT_TIMEOUT_MS);
    installWatchdog.unref?.();
  }

  /**
   * 起授权看门狗: 到点仍 pending 则视为用户放弃(关掉浏览器/没操作), 本地判
   * expired 并走与 server 推终止态相同的自动下线路径(toggle 弹回 + 断开)。
   */
  function armBindWatchdog(): void {
    clearBindWatchdog();
    bindWatchdog = setTimeout(() => {
      bindWatchdog = null;
      if (binding?.state !== 'pending' || !store.get().enabled) return;
      autoBindIntent = false;
      openAuthorizeOnNextPending = false;
      binding = {
        state: 'expired',
        slackUserId: null,
        slackUserName: null,
        message: null,
        authorizeUrl: null,
        reason: null,
        installUrl: null,
        teamName: null,
      };
      store.setEnabled(false);
      stop();
      notifyStatus(toView());
      log.info('slack hook auto-disabled: authorize timed out (browser closed or idle)');
    }, bindPendingTimeoutMs ?? DEFAULT_BIND_PENDING_TIMEOUT_MS);
    bindWatchdog.unref?.();
  }

  /**
   * 发起 SIWS OIDC 绑定(发空 bind.start; server 回 pending+authorizeUrl 时
   * 由 openAuthorizeOnNextPending 弹一次浏览器)。手动「连接 Slack」与"开关即
   * 绑定"的自动路径共用。返回 false = 连接不在线, 发不出。
   */
  function initiateBind(): boolean {
    if (transport === null || status !== 'connected') return false;
    if (!transport.send(makeBindStart({}))) return false;
    openAuthorizeOnNextPending = true;
    markBindingPending();
    armBindWatchdog();
    notifyStatus(toView());
    return true;
  }

  function buildHello(): HelloInput {
    // 每次连接成功都重读配置 —— 别名映射变更后重连即生效
    const device = deviceInfo();
    return {
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      // 内置「对话」伪目录恒在清单第一位(与真实目录同级; Set 去重防存量撞名)
      workspaces: [
        ...new Set([HOOK_CHAT_WORKSPACE_ALIAS, ...Object.keys(store.get().workspaces)]),
      ],
      agents,
    };
  }

  /** 业务帧处理(v2 帧 + 任务派发)。 */
  function handleBusinessMessage(msg: HookMessage, send: (m: HookMessage) => boolean): void {
    if (msg.type === 'tool.response') {
      // Slack 网关工具应答: replyTo 配对在途请求; 迟到帧(已超时清理)静默丢
      const pending = pendingTools.get(msg.payload.replyTo);
      if (pending === undefined) {
        log.warn(`tool.response for unknown requestId=${msg.payload.replyTo}, dropped (late?)`);
        return;
      }
      pendingTools.delete(msg.payload.replyTo);
      clearTimeout(pending.timer);
      if (msg.payload.ok) {
        pending.resolve({ ok: true, result: msg.payload.result });
      } else {
        // parse 层已强制 ok=false 必带非空 error, 这里只是类型收窄兜底
        const err = msg.payload.error ?? { code: 'INTERNAL', message: 'server returned no error detail' };
        pending.resolve({ ok: false, error: { code: err.code, message: err.message } });
      }
      return;
    }
    if (msg.type === 'prefs.state') {
      // 全量快照 latest-wins: 回执(replyTo 命中在途请求)与主动推送(/model
      // 卡写入后)都无条件广播 —— 多窗口/面板保持同步
      const view: HookPrefsView = {
        bound: msg.payload.bound,
        prefs: msg.payload.prefs.map((p) => ({ ...p })),
      };
      if (msg.payload.replyTo !== null) {
        const pending = pendingPrefs.get(msg.payload.replyTo);
        if (pending !== undefined) {
          pendingPrefs.delete(msg.payload.replyTo);
          clearTimeout(pending.timer);
          pending.resolve(view);
        }
      }
      notifyPrefs?.(view);
      return;
    }
    if (msg.type === 'bind.update') {
      const authorizeUrl = msg.payload.authorizeUrl ?? null;
      binding = {
        state: msg.payload.state,
        slackUserId: msg.payload.slackUserId,
        slackUserName: msg.payload.slackUserName,
        message: msg.payload.message,
        authorizeUrl,
        reason: msg.payload.reason ?? null,
        installUrl: msg.payload.installUrl ?? null,
        teamName: msg.payload.teamName ?? null,
      };
      // 授权看门狗跟随真实状态: 离开 pending 即撤; 重连回放 pending(server 侧
      // 授权仍在途)且本地没在计时的补一只 —— 断线重连不会让"等授权"变成无限等。
      if (msg.payload.state !== 'pending') {
        clearBindWatchdog();
      } else if (bindWatchdog === null) {
        armBindWatchdog();
      }
      // "等安装"态(授权已过、workspace 未装 App): 不下线, 保持连接等 server
      // 装完自动补完绑定推回 confirmed(免二次授权); 安装看门狗兜底超时弹回。
      // 其它任何状态到达即撤(confirmed = 装完补完; 其余 = 流程终止/重开)。
      const awaitingInstall =
        msg.payload.state === 'failed' &&
        (msg.payload.reason ?? null) === HOOK_BIND_REASON_NOT_INSTALLED;
      if (awaitingInstall && store.get().enabled) {
        if (installWatchdog === null) armInstallWatchdog();
      } else {
        clearInstallWatchdog();
      }
      // 用户刚点「连接 Slack」→ 首帧 pending 带授权链接时打开系统浏览器一次
      // (置位一次性; 重连时的 pending 回放不弹, 见 openAuthorizeOnNextPending 注释)。
      // 远程控制场景 openExternal 落在被控机, 设置页另给「复制链接」兜底(规则 26)。
      if (msg.payload.state === 'pending' && authorizeUrl !== null && openAuthorizeOnNextPending) {
        openAuthorizeOnNextPending = false;
        try {
          openExternalUrl?.(authorizeUrl);
        } catch (err) {
          log.warn(`openExternal(authorizeUrl) failed: ${String(err)}`);
        }
      }
      // 开关即绑定: 用户刚打开 toggle(armAutoBind), 连上后 server 按 hello 推回
      // 绑定现状 —— none 或 pending 都自动(重新)发起 OIDC 绑定(弹浏览器一次),
      // confirmed 则不弹(已绑定设备重开秒恢复)。pending 也要重发起的原因:
      // 本地看门狗超时(3 分钟)早于 server 侧 pending TTL(10 分钟), toggle 弹回
      // 后重开会撞上 server 回放的旧 pending —— 若不重发起, 浏览器不弹、bind.start
      // 不重发, 用户会卡在「授权中」;initiateBind 让 server 作废旧尝试签新链接。
      // 一次性: 判定后即清, 后续回放不再触发。
      if (autoBindIntent) {
        autoBindIntent = false;
        if (msg.payload.state === 'none' || msg.payload.state === 'pending') {
          initiateBind();
          // initiateBind 会把 binding 乐观置 pending 并 notifyStatus, 这里直接返回
          // 避免下方用刚被覆盖前的旧状态再 notify 一次(状态闪回)
          return;
        }
      }
      // 自动下线的终止态(开关语义 = 连接 + 绑定齐备才允许保持打开):
      //   revoked  被其它设备顶掉(实时推送, 保留原因供设置页展示被踢);
      //   denied/expired/failed  用户取消授权 / 授权超时 / 流程失败 —— toggle 弹回;
      //   none     server 侧已无绑定, 且本轮不是用户刚开开关(autoBindIntent
      //            分支已在上方消费并 return) —— 典型是绑定在本机离线期间丢失
      //            (被顶时不在线收不到 revoked、服务端解绑/迁移), 启动后 hello
      //            回放拿到 none。不弹回会留下「开关开着 · 已连接 · 未绑定」的
      //            僵尸态(看着可用实际派发不通), 弹回后重开即走新一轮授权。
      // 例外: failed + not-installed 是"等安装"中间态(上方已臂安装看门狗),
      // 保持在线等 confirmed, 不在这里下线。
      const autoDisable =
        msg.payload.state === 'revoked' ||
        msg.payload.state === 'denied' ||
        msg.payload.state === 'expired' ||
        msg.payload.state === 'none' ||
        (msg.payload.state === 'failed' && !awaitingInstall);
      if (autoDisable && store.get().enabled) {
        autoBindIntent = false;
        store.setEnabled(false);
        stop();
        log.info(`slack hook auto-disabled on bind.update=${msg.payload.state}`);
      }
      notifyStatus(toView());
      log.info(`bind.update: ${msg.payload.state}`);
      return;
    }
    if (msg.type === 'query.request') {
      // 接收日志: /bind /model /effort 的实时问答帧。排查「server 到底有没有
      // 转发到本机」时这是唯一的客户端侧证据(低频帧, INFO 无性能顾虑)。
      log.info(`query.request received: kind=${msg.payload.kind} queryId=${msg.payload.queryId}`);
      // buildQueryResponse 现为异步(models 数据源要实时读 listProviders);
      // 内部已捕获数据源错误(回 ok:false), 这里不会 reject。
      void buildQueryResponse(
        {
          listWorkspaces: () => [
            ...new Set([HOOK_CHAT_WORKSPACE_ALIAS, ...Object.keys(store.get().workspaces)]),
          ],
          listAgentModels: () => listAgentModels?.() ?? [],
        },
        msg.payload,
      ).then((response) => send(makeQueryResponse(response)));
      return;
    }
    if (msg.type === 'task.cancel') {
      log.info(`task.cancel received: requestId=${msg.payload.requestId}`);
      if (dispatcher) {
        dispatcher.cancel(id, msg.payload.requestId);
      } else {
        log.warn('task.cancel ignored (no dispatcher)');
      }
      return;
    }
    if (msg.type === 'session.archive') {
      // Slack 私聊 /new 换代 -> 归档旧代会话(幂等, 无绑定即 no-op)
      if (dispatcher) {
        dispatcher.handleSessionArchive(id, msg.payload.externalKey);
      } else {
        log.warn('session.archive ignored (no dispatcher)');
      }
      return;
    }
    if (msg.type === 'interaction.decision') {
      // 交互卡按钮回流(低频帧, INFO 留证据)
      log.info(
        `interaction.decision received: interactionId=${msg.payload.interactionId} button=${msg.payload.buttonId}`,
      );
      if (dispatcher) {
        dispatcher.handleInteractionDecision(id, msg.payload);
      } else {
        log.warn('interaction.decision ignored (no dispatcher)');
      }
      return;
    }
    if (msg.type === 'task.dispatch') {
      // 接收日志: 复用已有会话的派发在 dispatcher 里是静默路径(只有新建才留
      // worktree 痕迹), 没有这条就无法区分「没收到」和「静默复用」。
      log.info(
        `task.dispatch received: requestId=${msg.payload.requestId} externalKey=${msg.payload.externalKey} sessionId=${msg.payload.sessionId ?? '(new/bound)'}`,
      );
      if (dispatcher) {
        dispatcher.handleDispatch(id, msg.payload, send);
        return;
      }
      log.info(`dispatch received (requestId=${msg.payload.requestId}) — no dispatcher, rejecting`);
      send(
        makeTaskAck({
          requestId: msg.payload.requestId,
          result: 'rejected',
          reason: 'disabled',
          sessionId: null,
          queuePosition: null,
        }),
      );
      return;
    }
    // task.ack / turn.end 不该由 server 发给 desktop; 未知业务帧只记日志
    log.warn(`unexpected message type=${msg.type}, ignored`);
  }

  function stop(): void {
    // 看门狗随连接停止一并撤(dispose / 关 toggle / sync 重建都不该留残余计时器)
    clearBindWatchdog();
    clearInstallWatchdog();
    serverFeatures = [];
    if (transport === null) return;
    const t = transport;
    transport = null;
    status = null;
    lastError = null;
    drainPendingPrefs();
    drainPendingTools();
    t.dispose();
  }

  function start(): void {
    // created 先声明后赋值: transport 工厂同步触发首个 onStatus(connecting),
    // 此时按"未注册"丢弃(status 随后统一置 connecting, 不丢信息)
    let created: HookTransport | null = null;
    created = createTransport({
      url: store.effectiveUrl(),
      getAuthToken,
      buildHello,
      onMessage: handleBusinessMessage,
      onWelcome: (payload) => {
        if (created === null || transport !== created) return;
        // server 能力集以最新一次握手为准(重连可能落到另一版本实例)
        serverFeatures = [...payload.features];
      },
      onStatus: (s, err) => {
        // 构造期 / dispose / 重建后的尾随回调不再处理
        if (created === null || transport !== created) return;
        status = s;
        lastError = err;
        // 掉线(含退避重连中): 在途往返快速失败, 不让调用方挂满超时
        if (s !== 'connected') {
          drainPendingPrefs();
          drainPendingTools();
          serverFeatures = [];
        }
        // 握手完成 → dispatcher 刷新发送函数并补发离线积压的 turn.end
        if (s === 'connected') {
          const t = created;
          dispatcher?.onConnected(id, (m) => t.send(m));
          // 阶段 4 起绑定走 SIWS OIDC, 由用户点「连接 Slack」显式发起(需开浏览器),
          // 不再随连接就绪自动绑 —— 抢占式绑定若自动补绑会让两台设备互相顶。
        }
        notifyStatus(toView());
      },
      log,
    });
    transport = created;
    status = 'connecting';
  }

  return {
    sync() {
      // 统一策略: 停旧建新 —— url/别名/登录态变更全部经重建生效, 不做增量 diff
      stop();
      if (store.get().enabled && !disposed) start();
      notifyStatus(toView());
    },
    snapshot: () => toView(),
    refreshHello() {
      if (transport === null || status !== 'connected') return false;
      return transport.send(makeHello(buildHello()));
    },
    bindStart() {
      return initiateBind();
    },
    armAutoBind() {
      // 开关即绑定: 置一次性意图, 连上后收到 bind.update(none/pending) 自动发起绑定
      autoBindIntent = true;
      // 重开开关 = 新一轮流程: 清掉上一轮残留的终止态绑定快照(failed/expired
      // 等), 否则 renderer 会拿陈旧的 not-installed 误弹"安装确认框"、用户对
      // 过时弹窗点取消还会误杀刚建立的新绑定。server 连上后按 hello 推回真实
      // 现状; confirmed 保留(离线关开关的边缘场景, 重开即显已绑定)。
      if (binding !== null && binding.state !== 'confirmed') binding = null;
    },
    bindRevoke() {
      if (transport === null || status !== 'connected') return false;
      return transport.send(makeBindRevoke());
    },
    callSlackTool(tool, args) {
      const fail = (code: string, message: string): Promise<HookSlackToolResult> =>
        Promise.resolve({ ok: false, error: { code, message } });
      const t = transport;
      if (t === null || status !== 'connected') {
        return fail('HOOK_NOT_CONNECTED', 'Slack 连接不在线, 请检查 设置 → Slack 开关与网络');
      }
      if (binding?.state !== 'confirmed') {
        return fail('NOT_BOUND', '本设备未绑定 Slack, 请先到 设置 → Slack 完成绑定');
      }
      // 老 server 不认识 tool.request(丢帧不应答): 按能力宣告短路, 不打空炮
      if (!serverFeatures.includes(HOOK_FEATURE_SLACK_TOOLS)) {
        return fail('SERVER_TOO_OLD', 'Slack 服务端版本过旧, 不支持 Slack 工具, 请联系管理员升级');
      }
      const requestId = randomUUID();
      return new Promise<HookSlackToolResult>((resolve) => {
        if (!t.send(makeToolRequest({ requestId, tool, ...(args !== undefined ? { args } : {}) }))) {
          resolve({
            ok: false,
            error: { code: 'HOOK_NOT_CONNECTED', message: 'Slack 连接不在线, 请稍后重试' },
          });
          return;
        }
        const timer = setTimeout(() => {
          pendingTools.delete(requestId);
          resolve({
            ok: false,
            error: { code: 'TIMEOUT', message: 'Slack 工具请求超时(服务端无应答), 请稍后重试' },
          });
        }, toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
        timer.unref?.();
        pendingTools.set(requestId, { resolve, timer });
      });
    },
    getSlackToolAvailability() {
      return {
        connected: status === 'connected',
        bound: binding?.state === 'confirmed',
        serverSupportsTools: serverFeatures.includes(HOOK_FEATURE_SLACK_TOOLS),
        binding,
      };
    },
    getWorkspacePrefs() {
      return sendPrefsRequest((requestId) => makePrefsGet({ requestId }));
    },
    setWorkspacePrefs(workspace, patch) {
      return sendPrefsRequest((requestId) =>
        makePrefsSet({
          requestId,
          workspace,
          // undefined 字段不进帧(部分更新语义); null 显式清空
          ...(patch.model !== undefined ? { model: patch.model } : {}),
          ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
          ...(patch.agentKind !== undefined ? { agentKind: patch.agentKind } : {}),
          ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
        }),
      );
    },
    revokeAndDisconnect() {
      // 关 toggle = 解除绑定并断开: 在线则先发 bind.revoke(server 清绑定 +
      // pendingLink + 等安装登记, 取消"安装确认框"也走这里), 本地绑定态直接
      // 归零(stop 后收不到 server 回的 none 帧, 不能靠推送), 清在途意图与
      // 弹窗置位。送达是尽力而为(离线不发; 发出后立即断开, 极端竞态可能丢
      // 帧): 丢帧后果有界 —— server 侧绑定/等安装登记保留(登记最长 15 分钟),
      // 期间装 App 只会把绑定落到用户自己已验过的身份上, 重开开关按 confirmed
      // 恢复, 不产生安全风险, 也不会有半解绑状态。
      if (transport !== null && status === 'connected') {
        transport.send(makeBindRevoke());
      }
      autoBindIntent = false;
      openAuthorizeOnNextPending = false;
      binding = {
        state: 'none',
        slackUserId: null,
        slackUserName: null,
        message: null,
        authorizeUrl: null,
        reason: null,
        installUrl: null,
        teamName: null,
      };
      stop();
    },
    dispose() {
      disposed = true;
      stop();
    },
  };
}
