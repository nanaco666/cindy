import type {
  AndroidMcpDeps,
  BrowserMcpDeps,
  ComputerMcpDeps,
  FeishuBotMcpHostDeps,
  LiziMcpId,
  LiziMcpProvider,
  LiziMcpSessionContext,
  SchedulerMcpDeps,
  SshMcpDeps,
  MemoryMcpDeps,
  ContactsMcpDeps,
  LspMcpDeps,
} from './types.js';
import { createSlackBotMcpServer, type SlackBotMcpDeps } from './lizi_slackBotMcpServer.js';
import { createFeishuBotMcpServer } from './lizi_feishuBotMcpServer.js';
import { createSchedulerMcpServer } from './lizi_schedulerMcpServer.js';
import { createSshMcpServer } from './lizi_sshMcpServer.js';
import { createLiziMemoryMcpServer } from './lizi_memoryMcpServer.js';
import { createLiziContactsMcpServer } from './lizi_contactsMcpServer.js';
import { createXdtHelperMcpServer, type XdtHelperMcpDeps } from './lizi_xdtHelperMcpServer.js';
import { createOrcaMcpServer, type OrcaMcpDeps } from './orca/index.js';
import { createLiziLspMcpServer, detectTypeScriptProject } from './lsp/index.js';
import { createBrowserMcpServer } from './browser/index.js';
import { createComputerMcpServer } from './computer/index.js';
import { createAndroidMcpServer } from './android/index.js';
import { resolveLiziMcpSessionContext } from './session-context.js';

export interface CreateLiziMcpProvidersOptions {
  /**
   * Optional allow-list. Omit to enable every MCP whose deps were supplied.
   */
  enabled?: readonly LiziMcpId[];
  android?: AndroidMcpDeps;
  /** Browser automation tools. Host injects the neutral runtime implementation. */
  browser?: BrowserMcpDeps;
  /** Local desktop computer-use tools backed by a host-managed external driver. */
  computer?: ComputerMcpDeps;
  /** slack bot 通道工具(send_file_to_user)— 仅 source='slack' session 注入。 */
  slackBot?: Pick<SlackBotMcpDeps, 'sendFile' | 'logger'>;
  feishuBot?: FeishuBotMcpHostDeps;
  scheduler?: SchedulerMcpDeps;
  /**
   * lizi_ssh: 在已配置 SSH 主机上直接执行命令（复用 desktop ConnectionPool 的
   * alias / ssh-agent / key，远端零安装；直连、暂不支持 ProxyJump 跳板——
   * ConnectionPool 既有限制）。deps 的 getPool /
   * ensureReady 必须是 lazy async（desktop 侧 `await import()` remote-ssh 模块
   * 防循环依赖）。对应可关插件 id 'ssh'。
   */
  ssh?: SshMcpDeps;
  /**
   * Maker Memory deps. workdir 由 toClaudeSdkConfig(ctx) 时按 session 绑定, 这里
   * 只需要 host 提供 getManager + 可选 logger。
   */
  memory?: Omit<MemoryMcpDeps, 'workdir'>;
  /**
   * 智能通讯录(lizi_contacts)deps. 全局单库, 无 workdir 绑定;
   * isEnabled 来自 host 设置层开关(缺省常开)。
   */
  contacts?: ContactsMcpDeps;
  /**
   * TypeScript LSP MCP. workdir is bound per session. A blank workdir means the
   * host cannot provide per-session context (current Codex bridge), so the
   * provider stays disabled for that path.
   */
  lsp?: Omit<LspMcpDeps, 'workdir'> & { isUserEnabled?: () => boolean };
  /**
   * xdt-helper 无外部依赖,host 仍需显式传(即使 {}) 才会被启用,与其他 server 一致。
   * 传 undefined → 不启用;传 {} 或 { logger } → 启用。
   */
  xdtHelper?: XdtHelperMcpDeps;
  /**
   * lizi_orca MCP server: 多 worker 协同(Orca team)控制工具集。
   * 对应"协同模式"可关插件。deps 注入即激活 9 个 team 工具。
   */
  orca?: OrcaMcpDeps;
}

function selected(
  enabled: ReadonlySet<LiziMcpId> | null,
  id: LiziMcpId,
): boolean {
  return enabled === null || enabled.has(id);
}

function readFeishuChatId(ctx: LiziMcpSessionContext): string | null {
  const raw = ctx.vendorOptions?.feishuChatId;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function readSlackChatId(ctx: LiziMcpSessionContext): string | null {
  const raw = ctx.vendorOptions?.slackChatId;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** thread = session 模型: organic slack session 的 thread root ts(可缺省)。 */
function readSlackThreadTs(ctx: LiziMcpSessionContext): string | null {
  const raw = ctx.vendorOptions?.slackThreadTs;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

export function createLiziMcpProviders(
  opts: CreateLiziMcpProvidersOptions,
): LiziMcpProvider[] {
  const enabled = opts.enabled ? new Set(opts.enabled) : null;
  const providers: LiziMcpProvider[] = [];

  if (opts.browser && selected(enabled, 'browser')) {
    providers.push({
      name: 'lizi_browser',
      // ctx 注入:agent 实际跑在哪个 chat session 里,backend 必须以那个 session
      // 为操作主体,不能依赖 host 端的 UI-焦点推断(用户提交 prompt 后立刻切到
      // 别的 session,会让 backend 把 tab 落到错误 session)。
      //
      // 用 wrap runtime 模式把 ctx.sessionId 透传到 host backend 路径:每次
      // `runtime.call(req)` 内部把 `__mcpSessionId` 挂到 req 上。vendored runtime
      // 不识别这个字段会忽略;host 端 RsbWebviewBackend 优先读它,fallback 才走
      // `getActiveSessionId`(给非 MCP 路径,如设置页直接调 status 用)。
      toClaudeSdkConfig: (ctx) => {
        const baseDeps = opts.browser!;
        const sessionId = ctx.sessionId;
        return {
          type: 'sdk',
          name: 'lizi_browser',
          instance: createBrowserMcpServer({
            ...baseDeps,
            getRuntime: () => {
              const inner = baseDeps.getRuntime();
              if (!sessionId) return inner;
              return {
                call: (req) =>
                  inner.call({
                    ...req,
                    // Extra field on the request — vendored runtime ignores
                    // unknown keys, host RsbWebviewBackend reads it as the
                    // authoritative agent session.
                    __mcpSessionId: sessionId,
                  } as typeof req),
              };
            },
          }),
        };
      },
    });
  }

  if (opts.android && selected(enabled, 'android')) {
    providers.push({
      name: 'lizi_android',
      toClaudeSdkConfig: (ctx) => ({
        type: 'sdk',
        name: 'lizi_android',
        instance: createAndroidMcpServer(opts.android!, {
          sessionId: ctx.sessionId,
          getSessionContext: () => resolveLiziMcpSessionContext(ctx),
        }),
      }),
    });
  }

  if (opts.computer && selected(enabled, 'computer')) {
    providers.push({
      name: 'lizi_computer',
      toClaudeSdkConfig: (ctx) => ({
        type: 'sdk',
        name: 'lizi_computer',
        instance: createComputerMcpServer(opts.computer!, {
          sessionId: ctx.sessionId,
          getSessionContext: () => resolveLiziMcpSessionContext(ctx),
        }),
      }),
    });
  }

  // lizi_feishu 已于 2026-07-16 摘壳:飞书全部能力(44 精品 + 123 只读直通)
  // 迁入内置意识 cindy-feishu(source:'login-feishu-token' 登录态凭证,主机
  // 现取现注入零迁移)。与 web-search/mivo 不同,feishu 后端(feishu/ 目录、
  // FeishuTokenManager、registry)**留任**——scheduler 脚本 capability broker
  // (desktop scheduler-host/script-capability-broker.ts)仍经 registry 直调
  // 工具实现,登录 token 刷新链仍由 authManager 驱动(与 lizi_art 同模式:
  // 壳下线、后端留任)。

  // lizi_mivo 已于 2026-07-13 退役:mivo 全部 13 工具(图/视频/音乐/音效/3D
  // 生成、格式转换、按钮动作、下载)整体迁入内置意识 xd-mivo(network 槽
  // exchange 二段式凭证 + as:'media'/as:'file' 双路落地),MCP 壳与 mivo
  // 后端一并删除(与 web-search 同模式,MivoClient 无其它消费方,不留后端);
  // 凭证经官方别名表映射老 mivo_api_key 存储键,老用户零迁移。

  // lizi_web_search 已于 2026-07-12 退役:搜索能力整体迁入内置意识
  // cindy-web-search(network 槽自带 brave/tavily 通道),MCP 壳与
  // web-search 后端一并删除(与 lizi_art 不同,无其它消费方,不留后端)。

  // lizi_google 已于 2026-07-13 退役:Google 能力整体迁入内置意识
  // filo-google(oauth 凭证 + 内置 Filo 应用身份),MCP 壳与 google 后端
  // 一并删除;老账号(filoCurrent)由主机启动时一次性搬账进意识保险库。

  // slack(Slack 官方托管 MCP)已于 2026-07-15 退役:能力整体迁入内置意识
  // cindy-slack(电子脑自带最小 MCP 客户端直连 mcp.slack.com,oauth 凭证
  // tokenBroker 模式 + broker 弹跳回调),MCP 壳与 slack-official 后端一并
  // 删除;老账号(safe-storage 单账号)由主机启动时一次性搬账进意识保险库
  // (slackAccountsMigration)。

  // lizi_jira / lizi_confluence 已于 2026-07-14 退役:Jira + Confluence 全部
  // 29 个操作合并迁入内置意识 xd-atlassian(oauth 凭证 tokenBroker 模式,
  // client secret 留在 XDT server broker、不随包分发;回调钉死 53682 端口),
  // MCP 壳与 jira/confluence 后端一并删除;老账号(safe-storage 单账号)由
  // 主机启动时一次性搬账进意识保险库(atlassianAccountsMigration)。

  // lizi_github 已于 2026-07-14 退役:GitHub 全部操作迁入内置意识 cindy-github
  // (PAT 凭证存意识保险库,经 ghost_call 调用),MCP 壳与 github 后端一并删除;
  // 老 PAT(safe-storage 单账号)由主机启动时一次性搬账进意识保险库
  // (githubAccountsMigration)。

  // lizi_gitlab(gitlab_lizi)已于 2026-07-14 退役:GitLab 全部操作迁入内置意识
  // cindy-gitlab(多连接声明 gitlab_conn,实例地址 + PAT 成对存主机保险库,经
  // ghost_call 调用),MCP 壳与 gitlab 后端一并删除;老账号(safe-storage 单账号)
  // 由主机启动时一次性搬账进意识多连接清单(gitlabAccountsMigration)。

  if (opts.feishuBot && selected(enabled, 'lizi_feishu_bot')) {
    providers.push({
      name: 'lizi_feishu_bot',
      toClaudeSdkConfig: (ctx) => ({
        type: 'sdk',
        name: 'lizi_feishu_bot',
        instance: createFeishuBotMcpServer({
          getChatId: () =>
            readFeishuChatId(ctx) ?? opts.feishuBot!.getOwnerOpenId() ?? null,
          sendFile: opts.feishuBot!.sendFile,
          sendMessage: opts.feishuBot!.sendMessage,
        }),
      }),
    });
  }

  // slack bot 通道工具 — 与 feishu 版平行, 仅 source='slack' session 注入。
  // 不动 lizi_feishu_bot(其 tool 面对在跑的 feishu 会话是 prompt/cache 相邻物)。
  if (opts.slackBot && selected(enabled, 'lizi_slack_bot')) {
    providers.push({
      name: 'lizi_slack_bot',
      isEnabled: (ctx) => ctx.vendorOptions?.source === 'slack',
      toClaudeSdkConfig: (ctx) => ({
        type: 'sdk',
        name: 'lizi_slack_bot',
        instance: createSlackBotMcpServer({
          getChatId: () => readSlackChatId(ctx),
          getThreadTs: () => readSlackThreadTs(ctx),
          sendFile: opts.slackBot!.sendFile,
        }),
      }),
    });
  }

  if (opts.scheduler && selected(enabled, 'lizi_scheduler')) {
    providers.push({
      name: 'lizi_scheduler',
      // 第一版无门控：cc / codex 任何 session 都能用 schedule_* 工具。
      // 与 IPC 层 maker.schedule.* 同源（renderer 也是任何窗口都能调）。
      // 绑定 ctx 仅为 schedule_silence_current_run / schedule_notify_current_run 服务：
      // 它们据 sessionId 反查本会话当前 in-flight run,免去 agent 传 runId
      // (杜绝传参漂移 + caller-ownership)。
      // 与 lizi_xdt_helper 同范式;codex 路径由 HTTP bridge 的 AsyncLocalStorage 补回 ctx。
      toClaudeSdkConfig: (ctx) => ({
        type: 'sdk',
        name: 'lizi_scheduler',
        instance: createSchedulerMcpServer(opts.scheduler!, {
          agentKind: ctx.agentKind === 'codex' ? 'codex' : 'claude-code',
          workingDir: ctx.workingDir,
          sessionId: ctx.sessionId,
          vendorOptions: ctx.vendorOptions,
        }),
      }),
    });
  }

  if (opts.ssh && selected(enabled, 'lizi_ssh')) {
    providers.push({
      name: 'lizi_ssh',
      // 无 isEnabled 门控:plugin 系统已在 host 层(mcp-providers.ts wrap)按
      // plugin id 'ssh' 包了 isEnabled 检查,这里再加就是双重门(同 lizi_orca)。
      // ctx 当前仅日志归因用;工具本身不依赖 workingDir,Codex bridge 空 ctx
      // 也能正常工作。
      toClaudeSdkConfig: (ctx) => ({
        type: 'sdk',
        name: 'lizi_ssh',
        instance: createSshMcpServer(opts.ssh!, {
          agentKind: ctx.agentKind === 'codex' ? 'codex' : 'claude-code',
          workingDir: ctx.workingDir,
          sessionId: ctx.sessionId,
          vendorOptions: ctx.vendorOptions,
        }),
      }),
    });
  }

  if (opts.xdtHelper && selected(enabled, 'lizi_xdt_helper')) {
    providers.push({
      name: 'lizi_xdt_helper',
      // 无门控:任何 cc / codex session 都能让模型查 xdt-maker 自身能力。
      // 自省类工具 (get_capabilities / get_current_session_id) 全静态数据/读 ctx, 无 auth、无 IPC。
      // send_to_session 走 host 注入的 deps.sendToSession, ctx 闭包绑定 sessionId 让工具知道 dispatcher 是谁。
      // Codex HTTP bridge 会在工具调用时用 AsyncLocalStorage 恢复当前 thread
      // 对应的 session ctx;未绑定 session 的调用仍会按工具语义返 NO_SESSION_CONTEXT
      // 或 LEAD_NOT_SUPPORTED。
      // send_to_session 是 skill 的 session handoff 原语, 放 essential 常开;
      // 协同 team 工具在独立的 lizi_orca server(可关插件)。
      toClaudeSdkConfig: (ctx) => ({
        type: 'sdk',
        name: 'lizi_xdt_helper',
        instance: createXdtHelperMcpServer(opts.xdtHelper!, {
          agentKind: ctx.agentKind === 'codex' ? 'codex' : 'claude-code',
          workingDir: ctx.workingDir,
          sessionId: ctx.sessionId,
          vendorOptions: ctx.vendorOptions,
        }),
      }),
    });
  }

  if (opts.orca && selected(enabled, 'lizi_orca')) {
    providers.push({
      name: 'lizi_orca',
      // 无 isEnabled 门控:plugin 系统已经在 host 那层 (mcp-providers.ts wrap)
      // 包了一层 isEnabled 检查 builtinTools.collab.enabled(plugin id 'collab'
      // 重指向 provider 'lizi_orca'), 这里再加就是双重门。
      // ctx 闭包绑定 sessionId/vendorOptions 让工具知道是哪个 session 在调。
      // Codex HTTP bridge 的 server factory 初始 ctx 是空的,但 tool handler 会
      // 通过 AsyncLocalStorage 在调用时解析真实 session ctx。
      toClaudeSdkConfig: (ctx) => ({
        type: 'sdk',
        name: 'lizi_orca',
        instance: createOrcaMcpServer(opts.orca!, {
          agentKind: ctx.agentKind === 'codex' ? 'codex' : 'claude-code',
          workingDir: ctx.workingDir,
          sessionId: ctx.sessionId,
          vendorOptions: ctx.vendorOptions,
        }),
      }),
    });
  }

  if (opts.memory && selected(enabled, 'lizi_memory')) {
    providers.push({
      name: 'lizi_memory',
      // 跟 manager.isEnabled() 同步: Maker memory 关闭时 server 整个不注册,
      // LLM 完全看不到 list_tools / call_tool, 不会主动探索 → 不浪费 token,
      // 不让用户看到"明明关了为啥还有 mcp_lizi_memory_* 调用记录"的困惑。
      //
      // Claude 端: 每次 startSession 时 buildMcpServers 调本函数, manager 状态即时反映。
      // Codex 端: 第一次 host spawn 时 prepareCodexExtraSpawnConfig 调本函数, host
      //   长生命周期下后续 disable 不影响已 spawn 的 host (老 thread 仍看到 server,
      //   但 withStore 会用 MAKER_MEMORY_NOT_READY 兜底)。
      isEnabled: () => opts.memory!.getManager().isEnabled(),
      toClaudeSdkConfig: (ctx) => ({
        type: 'sdk',
        name: 'lizi_memory',
        instance: createLiziMemoryMcpServer({
          getManager: opts.memory!.getManager,
          workdir: ctx.workingDir,
          getSessionContext: () => resolveLiziMcpSessionContext(ctx),
          ...(opts.memory!.searchSessions ? { searchSessions: opts.memory!.searchSessions } : {}),
          ...(opts.memory!.logger ? { logger: opts.memory!.logger } : {}),
        }),
      }),
    });
  }

  if (opts.contacts && selected(enabled, 'lizi_contacts')) {
    providers.push({
      name: 'lizi_contacts',
      // 跟 memory 同模式: 设置层开关关闭时 server 整个不注册(LLM 看不到, 不浪费
      // token); Codex host 长生命周期下运行期关闭由 withContacts 的
      // CONTACTS_NOT_READY 工具级拦截兜底。
      ...(opts.contacts.isEnabled ? { isEnabled: () => opts.contacts!.isEnabled!() } : {}),
      toClaudeSdkConfig: () => ({
        type: 'sdk',
        name: 'lizi_contacts',
        instance: createLiziContactsMcpServer(opts.contacts!),
      }),
    });
  }

  if (opts.lsp && selected(enabled, 'lizi_lsp')) {
    providers.push({
      name: 'lizi_lsp',
      // LIZI_LSP_DISABLED=1 lets us run A/B benchmarks against grep+Read
      // baselines without changing prompt wording — flip the env, restart
      // xdt-maker, and lsp_* tools vanish from the agent's tool list entirely.
      isEnabled: (ctx) =>
        (opts.lsp!.isUserEnabled?.() ?? false)
        && !process.env.LIZI_LSP_DISABLED
        && Boolean(ctx.workingDir)
        && detectTypeScriptProject(ctx.workingDir),
      toClaudeSdkConfig: (ctx) => ({
        type: 'sdk',
        name: 'lizi_lsp',
        instance: createLiziLspMcpServer({
          workdir: ctx.workingDir,
          pool: opts.lsp!.pool,
          ...(opts.lsp!.logger ? { logger: opts.lsp!.logger } : {}),
        }),
      }),
    });
  }

  return providers;
}
