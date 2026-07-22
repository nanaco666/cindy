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
  HOOK_FEATURE_MULTI_TEAM,
  HOOK_FEATURE_SLACK_TOOLS,
  makeBindRevoke,
  makeBindStart,
  makeHello,
  makePrefsGet,
  makePrefsSet,
  makeQueryResponse,
  makeTaskAck,
  makeToolRequest,
  type BindUpdatePayload,
  type HelloInput,
  type HookMessage,
} from '@cindy/slack-hook-protocol';

import {
  HOOK_BIND_REASON_NOT_INSTALLED,
  HOOK_BIND_REASON_ALREADY_BOUND,
  HOOK_BIND_REASON_SUPERSEDED,
  HOOK_CHAT_WORKSPACE_ALIAS,
} from '../../shared/hookControlIpc.js';
import type {
  HookBindingView,
  HookConnectionStatus,
  HookPendingBindView,
  HookPrefsPatch,
  HookPrefsView,
  HookTeamBindingView,
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
  /** upgrade 401 后强制刷新一次登录凭证；成功后 transport 立即重连。 */
  refreshAuthToken: () => Promise<boolean>;
  /** hello 用的设备身份(authManager deviceId + hostname)。 */
  deviceInfo: () => { deviceId: string; deviceName: string };
  /** hello 声明的可用 agent 类型。 */
  agents: string[];
  /** 状态变化推送(IPC 层广播到所有窗口)。 */
  notifyStatus: (view: SlackHookView) => void;
  /**
   * cindy_slack provider 的构建期可用性(bound + server capability)翻转通知。
   *
   * Claude 每个 session 启动时都会重新评估 provider；Codex 会把 MCP server
   * 清单冻结在共享 app-server / bridge 中，host 用这个出口失效其缓存。只在
   * false <-> true 真变化时触发。server capability 保留最近一次成功 welcome 的
   * 快照，因此连接抖动不会反复重建；重连到不同版本 server 时会准确刷新。
   */
  onSlackToolProviderEnabledChanged?: (enabled: boolean) => void;
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
   * (multi-team)添加新 Slack workspace 绑定: 发 bind.start(空 teamId, 用户在
   * 授权页自选)。已有真在途授权(pending)时忽略(返回 true); 终止态(denied/
   * expired/failed)允许直接重试覆盖。false = 未连接或 server 不支持 multi-team。
   */
  addBinding(): boolean;
  /** (multi-team)给指定 team 重新授权(bind.start 带 teamId, pin 授权页)。 */
  rebindTeam(teamId: string): boolean;
  /**
   * (multi-team)解绑指定 team。displaced 行 = 仅清本地缓存(服务端本就没有该
   * 绑定, 离线也能删); 活跃行 = 发 bind.revoke{teamId} 并乐观移除(需在线)。
   */
  revokeTeam(teamId: string): boolean;
  /**
   * (multi-team)取消在途授权: 本地清 pendingBind, 在线时发 bind.revoke
   * {pendingOnly:true} 作废 server 侧登记(pending 授权 / 等安装)。幂等。
   */
  cancelPendingBind(): boolean;
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
  callSlackTool(
    tool: string,
    args?: Record<string, unknown>,
    teamId?: string | null,
  ): Promise<HookSlackToolResult>;
  /** Slack 工具可用性快照(cindy_slack provider 的 isEnabled / slack_status 数据源)。 */
  getSlackToolAvailability(): HookSlackToolAvailability;
  /**
   * 拉取绑定用户的全部目录偏好快照(prefs.get -> prefs.state 往返)。
   * 未连接 reject HookNotConnectedError; 超时(server 太旧, prefs 帧被丢)
   * reject HookPrefsTimeoutError。
   */
  getWorkspacePrefs(): Promise<HookPrefsView>;
  /**
   * 部分更新某目录偏好并返回写后的最新快照(语义同 getWorkspacePrefs)。
   * teamId: (multi-team)写入目标 team; 仅 server 宣告 multi-team 时进帧。
   */
  setWorkspacePrefs(
    workspace: string,
    patch: HookPrefsPatch,
    teamId?: string | null,
  ): Promise<HookPrefsView>;
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
  /** 绑定已 confirmed(multi-team 下 = 至少一条未 displaced 的绑定)。 */
  bound: boolean;
  /** server 已宣告 slack-tools 能力(welcome.features)。 */
  serverSupportsTools: boolean;
  binding: HookBindingView | null;
  /** server 已宣告 multi-team 能力(true 时非 status 工具必须带 teamId)。 */
  multiTeam: boolean;
  /** (multi-team)可用绑定清单(不含 displaced 行), 供 slack_status / 工具描述消费。 */
  bindings: Array<{ teamId: string; teamName: string | null }>;
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

/**
 * (multi-team)自动首绑的延迟窗口: 空 bind.state 后等这么久没有任何
 * bind.update(pending 回放)到达才发起首绑。server 的 hello 同步帧背靠背
 * 下发, 同一 TCP flush 内到达远快于本窗口; 取值只需盖住网络抖动。
 */
const AUTO_BIND_DEFER_MS = 300;

/** transport 状态 -> 渲染层状态。 */
function toViewStatus(s: HookTransportStatus | null, enabled: boolean): HookConnectionStatus {
  if (!enabled) return 'disabled';
  switch (s) {
    case 'connected':
      return 'connected';
    case 'standby':
      return 'standby';
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
    refreshAuthToken,
    deviceInfo,
    agents,
    notifyStatus,
    onSlackToolProviderEnabledChanged,
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
  /**
   * server 推送的最新绑定状态(bind.update); 未推送过为 null。
   * 仅老 server(单绑定)路径维护 —— multi-team 模式下对外的 legacy binding
   * 视图由 bindings/pendingBind 在 toView 里映射, 本变量不参与。
   */
  let binding: HookBindingView | null = null;
  /**
   * (multi-team)绑定列表(活跃 + displaced 行)。权威来源是 bind.state 快照与
   * confirmed/revoked(带 teamId)事件; 冷启动从 store.bindingsCache 预热,
   * 让「已关闭 · N 个绑定已保留」与重开秒恢复在断线状态下也成立。
   */
  let multiBindings: HookTeamBindingView[] = store
    .get()
    .bindingsCache.map((e) => ({ ...e, displaced: false }));
  /** (multi-team)在途授权状态(添加/重绑 workspace 的 pending 与其终止态)。 */
  let pendingBind: HookPendingBindView | null = null;
  /**
   * (multi-team)自动首绑的延迟触发器: 空 bind.state + autoBindIntent 时不能
   * 立即发 bind.start —— server 的 hello 同步可能紧跟一帧 pending 回放(旧
   * 授权仍在途), 先到的回放会走「pending + 意图 → 重新发起」的既有路径签新
   * 链接; 只有短窗内没有任何 bind.update 到达才由本计时器发起首绑。
   */
  let autoBindDefer: NodeJS.Timeout | null = null;
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
  /**
   * 最近一次成功 welcome 宣告的 server 能力集。瞬时断线不清空，避免 Codex MCP
   * 清单随网络抖动反复重建；重连后的新 welcome 会整组覆盖并触发 gate 复算。
   */
  let serverFeatures: string[] = [];
  /** cindy_slack provider 的构建期 gate 当前值；初始未绑定 = false。 */
  let slackToolProviderEnabled = false;
  let disposed = false;

  /** server 是否宣告 multi-team 能力(最近一次成功 welcome 快照)。 */
  function serverMultiTeam(): boolean {
    return serverFeatures.includes(HOOK_FEATURE_MULTI_TEAM);
  }

  /** multi-team 视图是否生效: server 宣告能力, 或本地缓存里有多绑定行(冷启动/
   *  断线期间 serverFeatures 尚空, 但上一次会话已是多绑定世界)。 */
  function multiTeamKnown(): boolean {
    return serverMultiTeam() || multiBindings.length > 0;
  }

  /** (multi-team)当前可用(未 displaced)的绑定行。 */
  function activeBindings(): HookTeamBindingView[] {
    return multiBindings.filter((b) => !b.displaced);
  }

  /** 只在 provider 构建期 gate 真翻转时通知 host 失效 Codex MCP 缓存。 */
  function notifySlackToolProviderEnabledIfChanged(): void {
    // multi-team: 至少一条可用绑定 + 总开关打开(关开关不再 revoke, 绑定保留
    // 在本地/服务端, 必须用 enabled 把工具面关掉); 老 server: 关开关会把
    // binding 置 none, confirmed 判据自足, enabled 条件恒真不改变行为。
    const bound = multiTeamKnown()
      ? activeBindings().length > 0 && store.get().enabled
      : binding?.state === 'confirmed';
    const next = bound && serverFeatures.includes(HOOK_FEATURE_SLACK_TOOLS);
    if (next === slackToolProviderEnabled) return;
    slackToolProviderEnabled = next;
    onSlackToolProviderEnabledChanged?.(next);
  }

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

  /**
   * multi-team 模式下映射给老消费点的 legacy 单绑定视图: 在途授权优先
   * (pending/denied/expired/failed 原样透传), 否则首个可用绑定映射成
   * confirmed, 都没有则 none —— 让只认 binding 字段的读取方拿到语义上
   * 最接近的单值快照。
   */
  function legacyBindingView(): HookBindingView | null {
    if (pendingBind !== null) {
      return {
        state: pendingBind.state,
        slackUserId: null,
        slackUserName: null,
        message: pendingBind.message,
        authorizeUrl: pendingBind.authorizeUrl,
        reason: pendingBind.reason,
        installUrl: pendingBind.installUrl,
        teamName: null,
      };
    }
    const first = activeBindings()[0];
    if (first !== undefined) {
      return {
        state: 'confirmed',
        slackUserId: first.slackUserId,
        slackUserName: first.slackUserName,
        message: null,
        authorizeUrl: null,
        reason: null,
        installUrl: null,
        teamName: first.teamName,
      };
    }
    return {
      state: 'none',
      slackUserId: null,
      slackUserName: null,
      message: null,
      authorizeUrl: null,
      reason: null,
      installUrl: null,
      teamName: null,
    };
  }

  function toView(): SlackHookView {
    const config = store.get();
    return {
      enabled: config.enabled,
      url: store.effectiveUrl(),
      workspaces: { ...config.workspaces },
      status: toViewStatus(status, config.enabled),
      lastError: config.enabled ? lastError : null,
      binding: multiTeamKnown() ? legacyBindingView() : binding,
      bindings: multiBindings.map((b) => ({ ...b })),
      pendingBind: pendingBind !== null ? { ...pendingBind } : null,
      serverMultiTeam: serverMultiTeam(),
    };
  }

  /** (multi-team)把当前绑定列表(含 displaced 行的 team 信息)写回本地缓存。 */
  function persistBindingsCache(): void {
    try {
      store.setBindingsCache(
        multiBindings.map((b) => ({
          teamId: b.teamId,
          teamName: b.teamName,
          slackUserId: b.slackUserId,
          slackUserName: b.slackUserName,
        })),
      );
    } catch (err) {
      // 缓存是体验增强(冷启动显示/diff), 写失败不影响运行时状态
      log.warn(`persist bindings cache failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
      if (multiTeamKnown()) {
        // multi-team: "等安装"挂在 pendingBind 上。已有可用绑定时只作废这次
        // 添加尝试(连接与其它绑定不受影响); 首绑(0 可用绑定)保持老语义弹回。
        if (pendingBind?.state !== 'failed' || pendingBind.reason !== HOOK_BIND_REASON_NOT_INSTALLED) {
          return;
        }
        autoBindIntent = false;
        openAuthorizeOnNextPending = false;
        if (activeBindings().length > 0) {
          if (transport !== null && status === 'connected') {
            transport.send(makeBindRevoke({ pendingOnly: true }));
          }
          pendingBind = null;
          notifyStatus(toView());
          log.info('multi-team add-binding install wait timed out, pending cleared');
        } else {
          store.setEnabled(false);
          stop();
          notifyStatus(toView());
          log.info('slack hook auto-disabled: app install not completed in time (multi-team)');
        }
        return;
      }
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
      if (!store.get().enabled) return;
      if (multiTeamKnown()) {
        if (pendingBind?.state !== 'pending') return;
        autoBindIntent = false;
        openAuthorizeOnNextPending = false;
        if (activeBindings().length > 0) {
          // 已有可用绑定: 只作废这次"添加/重绑"授权(server 侧登记顺手作废),
          // 总开关与既有绑定不受影响
          if (transport !== null && status === 'connected') {
            transport.send(makeBindRevoke({ pendingOnly: true }));
          }
          pendingBind = null;
          notifyStatus(toView());
          log.info('multi-team add-binding authorize timed out, pending cleared');
        } else {
          // 首绑超时: 与单绑定同语义 —— 本地判 expired, toggle 弹回
          pendingBind = { ...pendingBind, state: 'expired', authorizeUrl: null };
          store.setEnabled(false);
          stop();
          notifyStatus(toView());
          log.info('slack hook auto-disabled: first authorize timed out (multi-team)');
        }
        return;
      }
      if (binding?.state !== 'pending') return;
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
    if (multiTeamKnown()) {
      // multi-team: 在途授权落 pendingBind(乐观置位, 语义同 markBindingPending)
      pendingBind = {
        state: 'pending',
        message: null,
        authorizeUrl: null,
        reason: null,
        installUrl: null,
        teamId: null,
      };
    } else {
      markBindingPending();
    }
    armBindWatchdog();
    notifyStatus(toView());
    return true;
  }

  /**
   * (multi-team)发起添加/重绑授权: bind.start 带可选 teamId(重绑时 pin
   * 授权页), 乐观置 pendingBind 并臂授权看门狗。false = 发不出(未连接)。
   */
  function initiateMultiBind(teamId: string | null): boolean {
    if (transport === null || status !== 'connected') return false;
    if (!transport.send(makeBindStart(teamId !== null ? { teamId } : {}))) return false;
    openAuthorizeOnNextPending = true;
    pendingBind = {
      state: 'pending',
      message: null,
      authorizeUrl: null,
      reason: null,
      installUrl: null,
      teamId,
    };
    armBindWatchdog();
    notifyStatus(toView());
    return true;
  }

  function clearAutoBindDefer(): void {
    if (autoBindDefer !== null) {
      clearTimeout(autoBindDefer);
      autoBindDefer = null;
    }
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
      // 能力声明: 会消费 bind.state 快照与按 team 定位的帧(multi-team)。
      // 老 server 校验器只查已知字段, 本字段安全透传。
      features: [HOOK_FEATURE_MULTI_TEAM],
    };
  }

  /**
   * (multi-team)bind.update 处理: 事件帧只做行级更新与在途授权状态维护,
   * 列表权威以 bind.state 快照为准(server 在任何绑定变化后都会补推快照)。
   * 与老路径的关键差异: confirmed/revoked 按 teamId 定位行; none 只清在途
   * 授权不清列表; 终止态只在「首绑(0 可用绑定)」时才弹回 toggle。
   */
  function handleMultiBindUpdate(payload: BindUpdatePayload): void {
    const state = payload.state;
    if (state === 'confirmed') {
      // 添加/重绑成功: 行级 upsert + 在途授权收口(看门狗/意图/弹窗置位全清)
      const pendingBefore = pendingBind;
      clearBindWatchdog();
      clearInstallWatchdog();
      clearAutoBindDefer();
      autoBindIntent = false;
      openAuthorizeOnNextPending = false;
      pendingBind = null;
      const teamId = payload.teamId ?? null;
      if (teamId !== null && payload.slackUserId !== null) {
        const row: HookTeamBindingView = {
          teamId,
          teamName: payload.teamName ?? null,
          slackUserId: payload.slackUserId,
          slackUserName: payload.slackUserName,
          displaced: false,
        };
        const idx = multiBindings.findIndex((b) => b.teamId === teamId);
        // 「添加 workspace」流落在已绑定的活跃 team 上: Slack 授权页右上角的
        // workspace 下拉默认停在当前登录的 workspace, 用户没切换就点了允许 ——
        // 结果只是刷新原绑定, 列表不变。若不提示, 用户看到的是"点了添加却毫无
        // 反应"(实测踩坑)。以本地终止态 already-bound 呈现指引; 指定 team 的
        // 重绑(pendingBefore.teamId === teamId)与 displaced 行的复活不提示。
        if (
          idx >= 0 &&
          !multiBindings[idx].displaced &&
          pendingBefore !== null &&
          pendingBefore.teamId !== teamId
        ) {
          pendingBind = {
            state: 'failed',
            message: null,
            authorizeUrl: null,
            reason: HOOK_BIND_REASON_ALREADY_BOUND,
            installUrl: null,
            teamId,
          };
        }
        if (idx >= 0) multiBindings[idx] = row;
        else multiBindings.push(row);
        persistBindingsCache();
      }
      // teamId 缺失属异常(multi server 恒下发): 不猜行, 等随后的 bind.state 对齐
      notifySlackToolProviderEnabledIfChanged();
      notifyStatus(toView());
      return;
    }
    if (state === 'revoked') {
      const teamId = payload.teamId ?? null;
      if (teamId !== null) {
        const idx = multiBindings.findIndex((b) => b.teamId === teamId);
        if (idx >= 0) {
          if ((payload.reason ?? null) === HOOK_BIND_REASON_SUPERSEDED) {
            // 被另一台设备顶掉: 行保留标注 displaced, 用户可重新绑定或删除
            multiBindings[idx] = { ...multiBindings[idx], displaced: true };
          } else {
            multiBindings.splice(idx, 1);
          }
          persistBindingsCache();
        }
      } else {
        // 无 teamId 的全量解除(异常/服务端清理): 清列表, 等 bind.state 对齐
        multiBindings = [];
        persistBindingsCache();
      }
      notifySlackToolProviderEnabledIfChanged();
      notifyStatus(toView());
      return;
    }
    if (state === 'none') {
      // 只影响在途授权(server 侧已无进行中流程); 列表只信 bind.state/confirmed/revoked
      clearBindWatchdog();
      clearInstallWatchdog();
      pendingBind = null;
      if (autoBindIntent) {
        clearAutoBindDefer();
        if (initiateMultiBind(null)) {
          autoBindIntent = false;
          return;
        }
        log.info('multi-team bind.start send failed mid-frame, keeping auto-bind intent');
      }
      notifyStatus(toView());
      return;
    }
    // pending / denied / expired / failed → 在途授权状态
    const authorizeUrl = payload.authorizeUrl ?? null;
    pendingBind = {
      state,
      message: payload.message,
      authorizeUrl,
      reason: payload.reason ?? null,
      installUrl: payload.installUrl ?? null,
      // 授权流早期 server 不带 teamId(用户尚未选 workspace), 保留本地发起时
      // 记下的目标 team(重绑场景)供 UI 定位
      teamId: payload.teamId ?? pendingBind?.teamId ?? null,
    };
    // 授权/安装看门狗跟随真实状态(语义同老路径, 见各 arm 函数注释)
    if (state !== 'pending') clearBindWatchdog();
    else if (bindWatchdog === null) armBindWatchdog();
    const awaitingInstall =
      state === 'failed' && (payload.reason ?? null) === HOOK_BIND_REASON_NOT_INSTALLED;
    if (awaitingInstall && store.get().enabled) {
      if (installWatchdog === null) armInstallWatchdog();
    } else {
      clearInstallWatchdog();
    }
    // 刚开 toggle 撞上 server 回放的旧 pending: 重新发起换新链接(老路径同语义;
    // 同时取消 bind.state 分支排下的延迟首绑, 避免双发)
    if (state === 'pending' && autoBindIntent) {
      clearAutoBindDefer();
      if (initiateMultiBind(null)) {
        autoBindIntent = false;
        return;
      }
      log.info('multi-team bind.start send failed mid-frame, keeping auto-bind intent');
      notifyStatus(toView());
      return;
    }
    // 用户刚发起添加/重绑 → 首帧 pending 带授权链接时打开系统浏览器一次
    if (state === 'pending' && authorizeUrl !== null && openAuthorizeOnNextPending) {
      openAuthorizeOnNextPending = false;
      try {
        openExternalUrl?.(authorizeUrl);
      } catch (err) {
        log.warn(`openExternal(authorizeUrl) failed: ${String(err)}`);
      }
    }
    // 终止态: 首绑(0 可用绑定)保持老语义弹回 toggle; 已有绑定时只把终止态留
    // 在 pendingBind 供 UI 展示原因, 连接与既有绑定不受影响
    const terminal =
      state === 'denied' || state === 'expired' || (state === 'failed' && !awaitingInstall);
    if (terminal) {
      autoBindIntent = false;
      clearAutoBindDefer();
      if (activeBindings().length === 0 && store.get().enabled) {
        store.setEnabled(false);
        stop();
        log.info(`slack hook auto-disabled on first-bind ${state} (multi-team)`);
      }
    }
    notifyStatus(toView());
  }

  /** 业务帧处理(v2 帧 + 任务派发)。 */
  function handleBusinessMessage(msg: HookMessage, send: (m: HookMessage) => boolean): void {
    if (msg.type === 'bind.state') {
      // (multi-team)绑定全量快照(权威列表): 整体替换活跃行; 本地已知(缓存/
      // 上一轮)但快照缺失的 team 保留为 displaced 行 —— 覆盖「绑定在本机
      // 离线期间被另一台设备顶掉」的冷启动场景(实时被顶走 revoked 事件)。
      const snap = msg.payload.bindings;
      const snapIds = new Set(snap.map((e) => e.teamId));
      const next: HookTeamBindingView[] = snap.map((e) => ({
        teamId: e.teamId,
        teamName: e.teamName,
        slackUserId: e.slackUserId,
        slackUserName: e.slackUserName,
        displaced: false,
      }));
      for (const row of multiBindings) {
        if (!snapIds.has(row.teamId)) next.push({ ...row, displaced: true });
      }
      multiBindings = next;
      persistBindingsCache();
      notifySlackToolProviderEnabledIfChanged();
      // 开关即绑定(首次 0 绑定): 快照为空且用户刚开 toggle → 延迟一小窗发起
      // 首绑。不立即发的原因: server 的 hello 同步可能紧跟一帧 pending 回放,
      // 先让它走「pending + 意图 → 重新发起」路径签新链接; 短窗内没有任何
      // bind.update 才由计时器发空 bind.start(见 autoBindDefer 声明注释)。
      if (autoBindIntent) {
        if (activeBindings().length > 0) {
          autoBindIntent = false; // 已有绑定, 秒恢复, 无需发起授权
        } else if (autoBindDefer === null) {
          autoBindDefer = setTimeout(() => {
            autoBindDefer = null;
            if (!autoBindIntent || !store.get().enabled) return;
            if (pendingBind !== null) return; // 回放先到, 已交给 pending 路径
            if (initiateMultiBind(null)) autoBindIntent = false;
          }, AUTO_BIND_DEFER_MS);
          autoBindDefer.unref?.();
        }
      }
      notifyStatus(toView());
      log.info(`bind.state: ${snap.length} bindings`);
      return;
    }
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
      if (serverMultiTeam()) {
        // multi-team 双方能力齐备: 事件帧按 team 行级处理, 老状态机不参与
        handleMultiBindUpdate(msg.payload);
        log.info(`bind.update(multi): ${msg.payload.state}`);
        return;
      }
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
      notifySlackToolProviderEnabledIfChanged();
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
        if (msg.payload.state === 'none' || msg.payload.state === 'pending') {
          if (initiateBind()) {
            autoBindIntent = false;
            // initiateBind 会把 binding 乐观置 pending 并 notifyStatus, 这里直接返回
            // 避免下方用刚被覆盖前的旧状态再 notify 一次(状态闪回)
            return;
          }
          // 发不出 bind.start = 连接恰在本帧处理中掉线: 保留意图等重连回放
          // bind.update 时重试, 且不落入下方 autoDisable(none 会把用户刚打开
          // 的开关静默弹回, 表现为"点了开关没弹浏览器又自己关了")
          log.info('bind.start send failed mid-frame, keeping auto-bind intent for reconnect replay');
          notifyStatus(toView());
          return;
        }
        autoBindIntent = false;
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
    clearAutoBindDefer();
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
      refreshAuthToken,
      buildHello,
      onMessage: handleBusinessMessage,
      onWelcome: (payload) => {
        if (created === null || transport !== created) return;
        // server 能力集以最新一次握手为准(重连可能落到另一版本实例)
        serverFeatures = [...payload.features];
        // 落回老 server(无 multi-team): 多绑定列表与缓存作废 —— 老 server 是
        // 单绑定权威(它会经 bind.update 推现状), 残留的多绑定行会让 toView
        // 误走 multi 映射、渲染层误开列表 UI。pendingBind 无条件清: 滚动发布
        // multi→old 横跳时 0 绑定设备的在途态也不该滞留(老 server 随后会推现状)
        if (!serverMultiTeam()) {
          pendingBind = null;
          if (multiBindings.length > 0) {
            multiBindings = [];
            persistBindingsCache();
          }
        }
        notifySlackToolProviderEnabledIfChanged();
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
      // multi-team 的 gate 含 enabled 因子(关开关不再清绑定), setEnabled 后的
      // sync 是它唯一的重算点; 老路径下本调用是幂等 no-op
      notifySlackToolProviderEnabledIfChanged();
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
      // 开关即绑定: 置一次性意图, 连上后收到 bind.update(none/pending) 或
      // (multi-team)空 bind.state 自动发起绑定
      autoBindIntent = true;
      // 重开开关 = 新一轮流程: 清掉上一轮残留的终止态绑定快照(failed/expired
      // 等), 否则 renderer 会拿陈旧的 not-installed 误弹"安装确认框"、用户对
      // 过时弹窗点取消还会误杀刚建立的新绑定。server 连上后按 hello 推回真实
      // 现状; confirmed 保留(离线关开关的边缘场景, 重开即显已绑定)。
      if (binding !== null && binding.state !== 'confirmed') binding = null;
      // multi-team 的在途授权快照同理清掉(真在途的话 server 会回放 pending)
      pendingBind = null;
    },
    bindRevoke() {
      if (transport === null || status !== 'connected') return false;
      return transport.send(makeBindRevoke());
    },
    addBinding() {
      // 需 server multi-team 能力(老 server 对多绑定语义一无所知)
      if (!serverMultiTeam()) return false;
      // 真在途授权(pending)时忽略(幂等, 不打断进行中的流程); 终止态
      // (denied/expired/failed)允许直接重试覆盖
      if (pendingBind?.state === 'pending') return true;
      return initiateMultiBind(null);
    },
    rebindTeam(teamId) {
      if (!serverMultiTeam()) return false;
      return initiateMultiBind(teamId);
    },
    revokeTeam(teamId) {
      const idx = multiBindings.findIndex((b) => b.teamId === teamId);
      if (idx < 0) return true; // 行已不在(重复点击/竞态), 幂等成功
      if (multiBindings[idx].displaced) {
        // displaced 行: 服务端本就没有该绑定, 删除 = 仅清本地缓存(离线可用)
        multiBindings.splice(idx, 1);
        persistBindingsCache();
        notifyStatus(toView());
        return true;
      }
      if (!serverMultiTeam() || transport === null || status !== 'connected') return false;
      if (!transport.send(makeBindRevoke({ teamId }))) return false;
      // 乐观移除: server 处理后还会补推 bind.state 快照对齐
      multiBindings.splice(idx, 1);
      persistBindingsCache();
      notifySlackToolProviderEnabledIfChanged();
      notifyStatus(toView());
      return true;
    },
    cancelPendingBind() {
      // 本地收口无条件执行(离线也能取消显示); server 侧登记在线时顺手作废
      clearBindWatchdog();
      clearInstallWatchdog();
      clearAutoBindDefer();
      autoBindIntent = false;
      openAuthorizeOnNextPending = false;
      const hadPending = pendingBind !== null;
      pendingBind = null;
      if (serverMultiTeam() && transport !== null && status === 'connected' && hadPending) {
        transport.send(makeBindRevoke({ pendingOnly: true }));
      }
      notifyStatus(toView());
      return true;
    },
    callSlackTool(tool, args, teamId) {
      const fail = (code: string, message: string): Promise<HookSlackToolResult> =>
        Promise.resolve({ ok: false, error: { code, message } });
      const t = transport;
      if (t === null || status !== 'connected') {
        return fail('HOOK_NOT_CONNECTED', 'Slack 连接不在线, 请检查 设置 → Slack 开关与网络');
      }
      const bound = multiTeamKnown()
        ? activeBindings().length > 0
        : binding?.state === 'confirmed';
      if (!bound) {
        return fail('NOT_BOUND', '本设备未绑定 Slack, 请先到 设置 → Slack 完成绑定');
      }
      // 老 server 不认识 tool.request(丢帧不应答): 按能力宣告短路, 不打空炮
      if (!serverFeatures.includes(HOOK_FEATURE_SLACK_TOOLS)) {
        return fail('SERVER_TOO_OLD', 'Slack 服务端版本过旧, 不支持 Slack 工具, 请联系管理员升级');
      }
      const requestId = randomUUID();
      // teamId 仅在 server 宣告 multi-team 后进帧(老 server 语境下无意义)
      const withTeam = teamId != null && serverMultiTeam() ? { teamId } : {};
      return new Promise<HookSlackToolResult>((resolve) => {
        if (
          !t.send(
            makeToolRequest({ requestId, tool, ...(args !== undefined ? { args } : {}), ...withTeam }),
          )
        ) {
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
      const multi = multiTeamKnown();
      return {
        connected: status === 'connected',
        // multi-team 关开关不清绑定, bound 必须叠 enabled 因子 —— 否则 Slack
        // 已关的设备上 cindy_slack 工具面仍会挂进新会话(老路径关开关会把
        // binding 归零, confirmed 判据自足)
        bound: multi
          ? store.get().enabled && activeBindings().length > 0
          : binding?.state === 'confirmed',
        serverSupportsTools: serverFeatures.includes(HOOK_FEATURE_SLACK_TOOLS),
        binding: multi ? legacyBindingView() : binding,
        multiTeam: serverMultiTeam(),
        bindings: activeBindings().map((b) => ({ teamId: b.teamId, teamName: b.teamName })),
      };
    },
    getWorkspacePrefs() {
      return sendPrefsRequest((requestId) => makePrefsGet({ requestId }));
    },
    setWorkspacePrefs(workspace, patch, teamId) {
      return sendPrefsRequest((requestId) =>
        makePrefsSet({
          requestId,
          workspace,
          // undefined 字段不进帧(部分更新语义); null 显式清空
          ...(patch.model !== undefined ? { model: patch.model } : {}),
          ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
          ...(patch.agentKind !== undefined ? { agentKind: patch.agentKind } : {}),
          ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
          // (multi-team)偏好归属 team: 仅 server 宣告能力时进帧(老 server 不查
          // 本字段, 但语义上单绑定无归属概念, 不发保持帧面与老版本逐字节一致)
          ...(teamId != null && serverMultiTeam() ? { teamId } : {}),
        }),
      );
    },
    revokeAndDisconnect() {
      if (serverMultiTeam()) {
        // (multi-team)关 toggle = 只断开, **不再发全量 bind.revoke** —— 绑定
        // 保留在服务端与本地缓存, 重开开关秒恢复(解绑改走显式 revokeTeam)。
        // 在途的添加/重绑授权顺手作废(pendingOnly, 不触碰已确认绑定)。
        if (transport !== null && status === 'connected' && pendingBind !== null) {
          transport.send(makeBindRevoke({ pendingOnly: true }));
        }
        autoBindIntent = false;
        openAuthorizeOnNextPending = false;
        pendingBind = null;
        stop();
        // gate 的 enabled 因子在 ipc 层 setEnabled(false) + sync() 后重算
        notifySlackToolProviderEnabledIfChanged();
        return;
      }
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
      pendingBind = null;
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
      notifySlackToolProviderEnabledIfChanged();
      stop();
    },
    dispose() {
      disposed = true;
      stop();
    },
  };
}
