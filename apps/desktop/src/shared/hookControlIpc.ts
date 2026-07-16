/**
 * shared/hookControlIpc.ts
 * ---------------------------------------------------------------------------
 * Slack Hook(hook-control)的 IPC 通道名与线上类型 —— main / preload / renderer
 * 三端共享的唯一契约(模式对齐 deviceLinkIpc.ts)。
 *
 * 功能背景: desktop 主动外连公司中心部署的 slack-hook-server(WS 拨出),
 * 接收 Slack 归一化后的任务派发。产品形态是**单条内置连接**:
 *   - 服务器地址内置系统默认值(高级用户可经配置文件覆写, 无 UI 入口);
 *   - 鉴权用登录 JWT(与 device-link 同模型), 没有密钥概念, 用户零输入;
 *   - 用户可操作面 = 开关 / Slack 账号绑定 / 工作目录清单。
 */

/** 内置服务器地址(系统默认值; slack-hook.json 的 urlOverride 可覆写, 规则 20)。 */
export { SLACK_HOOK_DEFAULT_URL } from './endpoints';

/**
 * 由 WS 服务器地址推导 Slack App 安装链接: wss→https / ws→http, 去尾斜杠后拼
 * bolt InstallProvider 的固定路径 /slack/install(directInstall 模式, 302 直跳
 * Slack 授权页)。安装是 workspace 级一次性动作, 与本机连接/绑定状态无关。
 */
export function slackHookInstallUrl(wsUrl: string): string {
  return `${wsUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '')}/slack/install`;
}

export const HOOK_CONTROL_INVOKE = {
  /** 取当前快照(配置 + 运行时状态 + 绑定状态)。 */
  GET: 'maker:hook-control:get',
  /** 总开关。 */
  SET_ENABLED: 'maker:hook-control:set-enabled',
  /** 覆写工作目录清单(别名 -> 本地绝对路径, 全量替换)。 */
  SET_WORKSPACES: 'maker:hook-control:set-workspaces',
  /** 发起 Slack 账号绑定(bind.start; SIWS OIDC, 无参数)。 */
  BIND_START: 'maker:hook-control:bind-start',
  /** 解除 Slack 账号绑定(bind.revoke)。 */
  BIND_REVOKE: 'maker:hook-control:bind-revoke',
  /** 拉取绑定用户的全部目录偏好快照(经 WS prefs.get, 10s 超时)。 */
  PREFS_GET: 'maker:hook-control:prefs-get',
  /** 部分更新某目录偏好(经 WS prefs.set; null = 清空回默认)。 */
  PREFS_SET: 'maker:hook-control:prefs-set',
} as const;

export const HOOK_CONTROL_EVENT = {
  /** 状态推送(完整快照; 连接与绑定状态变化都走这里)。 */
  STATUS_CHANGED: 'maker:hook-control:status-changed',
  /** 目录偏好快照推送(prefs.state; 含 Slack /model 卡改动的实时同步)。 */
  PREFS_CHANGED: 'maker:hook-control:prefs-changed',
} as const;

/**
 * Slack 账号绑定状态(与 hook-protocol 的 BindUpdateState 一致, 本文件为
 * renderer 侧独立声明, 避免 shared 层引协议包)。阶段 4 起绑定走 Sign in with
 * Slack(OIDC):
 *   none 未绑定 / pending 已生成授权链接·等浏览器授权(authorizeUrl 非空) /
 *   confirmed 已绑定 / denied 授权被拒 / expired 授权超时 /
 *   failed 流程失败(如老服务器、workspace 未安装) / revoked 被解除(含被新设备顶掉)
 */
export type HookBindingState =
  | 'none'
  | 'pending'
  | 'confirmed'
  | 'denied'
  | 'expired'
  | 'failed'
  | 'revoked';

/** Slack 绑定快照(server 经 bind.update 推送, main 缓存最新一帧)。 */
export interface HookBindingView {
  state: HookBindingState;
  slackUserId: string | null;
  slackUserName: string | null;
  message: string | null;
  /**
   * SIWS OIDC 授权链接(仅 state=pending 时非空): 桌面端用系统浏览器打开它
   * 完成 Slack 授权。远程控制场景下 openExternal 落在被控机, 故设置页同时
   * 给「复制链接」兜底(规则 26)。
   */
  authorizeUrl: string | null;
  /**
   * 结构化失败原因(仅 state=failed 时可能非空, 透传 bind.update.reason)。
   * 已知值 'not-installed': 授权的 Slack workspace 未安装 App(授权本身不要求
   * 安装, 但 bot 无 token 收发消息), 设置页据此显示「安装 Slack App」引导行
   * (判定走本字段, 不解析 message 文案, 规则 9)。
   */
  reason: string | null;
  /**
   * 按 workspace 定制的安装链接(仅 not-installed 时可能非空, 透传
   * bind.update.installUrl): 带 team 参数, 安装授权页预选到刚授权的
   * workspace。老 server 不下发时回退 slackHookInstallUrl 通用链接。
   */
  installUrl: string | null;
  /**
   * 绑定所在 Slack workspace 显示名(仅 confirmed 时可能非空, 透传
   * bind.update.teamName): 状态行展示「已绑定 @xxx(workspace)」。老 server
   * 不下发时为 null, 回退只显示用户名。
   */
  teamName: string | null;
}

/** binding.reason 已知值(与 hook-protocol 的 BIND_FAIL_REASON_NOT_INSTALLED 对齐)。 */
export const HOOK_BIND_REASON_NOT_INSTALLED = 'not-installed';

/**
 * 连接运行时状态:
 *  - disabled:   开关关闭, 不建连
 *  - connecting: 正在建连 / 退避重连中(含已开 WS 但尚未收到 welcome)
 *  - connected:  握手完成(hello -> welcome), 可收派发
 *  - error:      最近一次连接失败(仍在退避重试), lastError 给原因
 */
export type HookConnectionStatus = 'disabled' | 'connecting' | 'connected' | 'error';

/** 渲染层可见的 Slack Hook 快照(单连接)。 */
export interface SlackHookView {
  enabled: boolean;
  /** 实际生效的服务器地址(默认内置值; 被 urlOverride 覆写时为覆写值)。 */
  url: string;
  /** 工作区别名 -> 本地绝对路径。协议里只跑别名, 路径不出本机。 */
  workspaces: Record<string, string>;
  status: HookConnectionStatus;
  lastError: string | null;
  /** Slack 账号绑定状态; 未连接过 / server 未推送时为 null(按未绑定显示)。 */
  binding: HookBindingView | null;
}

/** 工作区别名的合法格式(与 hook server 侧约定一致)。 */
export const HOOK_WORKSPACE_ALIAS_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * 保留别名「对话」: 内置的伪工作目录, 与真实目录同级 —— 桌面端把它恒定加进
 * 上报给 server 的目录清单(排第一), Slack 侧所有目录选择卡自然多一个 chat
 * 选项; 派发到 chat 的任务不落任何仓库, 每个会话分配独立的 app 托管对话
 * 目录(userData/dialogues/..., workspaceKind='dialogue', 落侧边栏「对话」
 * 分组)。server 对别名透传不校验, 解析完全在桌面端; 用户不能用它命名真实
 * 目录(store 校验拦截)。偏好按 (用户, 'chat') 存, 与真实目录同一套体系。
 */
export const HOOK_CHAT_WORKSPACE_ALIAS = 'chat';

/**
 * 单目录会话偏好(与协议 WorkspacePrefsEntry 同形, shared 层独立声明避免
 * 引协议包)。null = 未设置, 跟随桌面端草稿默认(权限默认完全访问)。
 * 数据正本在 slack-hook-server 的 user_prefs 表, 与 Slack /model 卡同源。
 */
export interface HookWorkspacePrefs {
  workspace: string;
  model: string | null;
  effort: string | null;
  agentKind: string | null;
  permissionMode: string | null;
}

/** 偏好快照(prefs.state 的 renderer 侧形态)。bound=false 时 prefs 恒空。 */
export interface HookPrefsView {
  bound: boolean;
  prefs: HookWorkspacePrefs[];
}

/** 偏好部分更新 patch(undefined 不动, null 显式清空)。 */
export interface HookPrefsPatch {
  model?: string | null;
  effort?: string | null;
  agentKind?: string | null;
  permissionMode?: string | null;
}
