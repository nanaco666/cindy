---
id: packages--orca-workflow
type: module
covers:
  - packages/orca-workflow/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-06T07:00:40.960Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# packages--orca-workflow

## 是什么

`@fmfsaisai/orca-workflow`（`packages/orca-workflow`）是 Orca 多 agent 协同（Lead/Worker）中**唯 worker→lead 方向**的能力包：提供 MCP provider `orca_worker_bridge`（worker 侧调用 `send_to_lead` / `read_lead` / `lead_status`）与 Lead/Worker 两份 system prompt 渲染函数。Lead→worker/team 方向的工具面（`start_team` / `create_worker` / `send_to_worker` 等 9+3 个工具，架构文档中称为工具面 "C"）不在本包，由 `packages/lizi-mcps` 的 `lizi_orca` server 承担；本包（工具面 "B"）只负责 worker 向 lead 汇报/查询这一条链路，以及两侧 agent 的初始 system prompt 文案。早期 Lead 侧门面 `orca_bridge`（工具面 "A"）已整体删除。`apps/desktop` 的 main 进程（`maker-host/index.ts`、`maker-ipc/register.ts`）是唯一消费方，把本包的 provider 注册进 MCP、把渲染出的 prompt 塞进 session 创建流程,并通过依赖注入（`OrcaBridgeMcpDeps`）把 host 侧的 session 管理、DB store、消息派发能力喂给它。权威架构文档见仓库根 `docs/orca-team-architecture.md`（owner: yuhaobo/fmfsaisai），改本包前必须先读该文档的「协同运行时行为契约」「坑点与不变量」两节——它们是本包代码的约束源，文档与代码冲突时以代码为准但要求同步修正文档。

## 关键抽象 / 核心代码地标

- `src/orca-bridge-mcp.ts` — 核心实现：
  - `createOrcaWorkerBridgeMcpProvider(deps: OrcaBridgeMcpDeps): McpProvider` — 对外唯一工厂。返回的 provider `isEnabled` 对 `orcaRole === 'worker'` **以及所有 `agentKind === 'codex'`** 为真（Codex app-server 是单进程全局注册 MCP server、没有 per-thread MCP override,无法按 role 收窄可见性,详见「不要做的事」#1）。`toClaudeSdkConfig` 内注册三个 MCP tool。
  - `send_to_lead` tool — worker 向其 lead session 发消息。走 `resolveWorkerLink` 做归属校验（拿运行时 `ctx.getSessionContext?.()` 解出的 `vendorOptions.orcaRole==='worker'` + 真实 `sessionId` 与 `OrcaTeamStore.getWorkerLink` 返回的 link 双向核对，识别信息以运行时 context 为准、不是调用参数传的 `worker_id`——任一不匹配都 fail-closed 返回错误,不放行）,再走 `dispatchOrcaToolMessage` 把消息投给 lead。存在 host-dispatch 和 package 内直发两条路径：若 `deps.dispatchInterAgentMessage` 存在则走 host（返回 `{hostDispatched, queued}`，成功即视为“已回报”)；否则直接调用 `Session.send`。`markLeadDispatchAccepted` / `settleWorkerReport` 处理 lead session 捕获缓冲的重置与 worker auto-bridge pending 的清除，`workerReportSettled` 幂等门控防止 host queue drain 时 `hostOnAccepted` 二次触发。
  - `read_lead` / `lead_status` tool — 只读诊断，从 `CapturedSessionRegistry` 读取捕获到的 lead session 最近输出/状态,不发消息。
  - `CapturedSessionRegistry` / `CapturedSessionEntry` — 包内维护的一份"lead session 输出捕获"缓存（按 `sessionId` keyed，进程内存,重启即丢——重启后的事实来源是 desktop DB 的 `orca_workers.status`，本 registry 只是运行时优化）,靠 `Session.onEvent` 订阅 `text`/`done`/terminal-error 事件累积 `finalText`（上限 `MAX_CAPTURED_TEXT = 64KiB`，环形截断）；`ensureCapturedSession` 检测缓存里的 session 引用是否已被外部 rehydrate 关闭（`status === 'closed' | 'error'`）,过期则重新订阅。
  - `formatOrcaCommunicationMessage(orcaSource, content)` — 持久化到 DB 的消息格式（JSON `{orcaSource, content}`）；`formatAgentMessage(source, content, workerId?)` — 真正 send 给 session 的格式（`[From Orca Lead]` / `[From Orca Worker]` 前缀 + lead→worker 时附 `Bridge note` 告知 worker_id）。两者必须配套使用（package 注释标注：main 进程 worker `initial_task` 派活路径复用同一份格式，保证 MCP 工具入口与手动 toggle 入口效果一致）。
  - `sanitizeOrcaSendError` — 发送失败时的错误净化：错误名只允许匹配 `^[A-Za-z][A-Za-z0-9]{0,63}$`,错误 code 只允许极小白名单（当前仅 `SESSION_RUNNING`）,其余一律折叠为 `'Error'`/`errorKind: 'unknown'`。这是故意的安全控制,不是疏漏——防止 `Error.message` 里可能带的 prompt/token/用户消息/文件内容通过日志或 tool 返回值泄漏,测试用 `SECRET_PROMPT`/`SECRET_TOKEN`/`SECRET_USER_MESSAGE`/`SECRET_FILE_BODY` 等占位字符串显式断言不泄漏。
  - `__testing` — 导出 `autoBridgeStateCount` / `clearAutoBridgeState` / `hasAutoBridgePending`，仅测试用,访问包级私有 `workerAutoBridgePending` Map（模块级单例,同一进程内跨所有 provider 实例共享,非按 provider 实例隔离）。
  - `OrcaBridgeMcpDeps` — 依赖注入接口：`getMaker`、`logger`、`persistUserMessage`、`wireSession`、可选 `hydrateSessionRoute` / `orcaTeamStore` / `dispatchInterAgentMessage`。全部由 `apps/desktop` 的 `maker-host/index.ts` 实例化传入,本包不直接持有 Maker/DB/IPC 实例。`ensureSessionFromMeta` 内的调用顺序是不变量：`hydrateSessionRoute` 必须先 await 完成,再判断 lead session 是否已 active、再决定 `createSession` 还是复用——冷 lead 与热 lead 两条路径都要先 hydrate 再交互。
  - `OrcaTeamStore` 接口（`getWorkerLink` + `updateWorkerStatus`）— 由 `apps/desktop/src/main/maker-host/orcaTeamStoreAdapter.ts` 实现,桥接本包 `OrcaWorkerLink.workflowId` 字段命名与 desktop 内部 `teamId` 命名（两者同时携带，desktop 侧用 teamId，本包协议字段名是对 worker agent 可见的 `workflow_id`,不要假设二者会统一改名——改了会破坏已发布协议）。
- `src/orca-bridge-prompt.ts` — 两份 system prompt 纯函数：
  - `renderOrcaLeadSystemPrompt(initialWorker?: OrcaInitialWorkerRef | null): string` — Lead 的行为契约文案：只列出 `get_workspace_info` / `create_worker` / `send_to_worker`（诊断工具 `worker_status`/`read_worker` 明确标注仅用于紧急诊断,不能用于常规轮询）；核心规则是"dispatch 后立即结束 turn、不产出任何文字、不 poll",并给出正确/错误行为示例；末尾按规则区分"子代理"请求应走原生 subagent 机制而非 Orca worker。
  - `renderOrcaWorkerSystemPrompt(meta: OrcaWorkerPromptMeta): string` — Worker 的身份行、工具清单（`send_to_lead`/`read_lead`/`lead_status`,强制带 `worker_id` 参数）与执行契约（做完必须 `send_to_lead`、禁止 poll lead、不主动 commit、不能创建新 worker）。
  - `parseOrcaInitialWorkerRef(value)` — 从任意 unknown 值安全解析出 `{workerId, sessionId}`,失败返回 `null`（不 throw）。
  - 这两个函数渲染出的文案属于「系统提示词」（AGENTS.md 规则 11 覆盖范围）——任何改动都要先跟 Lizi 确认；历史上曾因 Lead prompt 用裸工具名引用只有 Claude-lead 专属旧 `orca_bridge` 才有的诊断工具（Codex Lead 看不到）制造噪音,现已通过把诊断工具统一桥入全局可见的 `lizi_orca` 解决（prompt 正文本身未改,未触发规则 11 确认流程，见 `docs/orca-team-architecture.md` 坑点 #5）。
- `src/index.ts` — 桶导出，也可通过 `package.json` 的 `exports` 子路径 `./mcp`（=`orca-bridge-mcp.js`）、`./prompt`（=`orca-bridge-prompt.js`）单独导入。
- `src/vite-env.d.ts` — 声明 `*.md?raw` 的 ambient 模块类型,当前包内没有任何 `.ts` 文件实际使用这个 import 形态,是未接线的遗留/预留声明,不代表存在真正的文档内嵌功能。

## 模块边界

- **上游依赖**：`@lizi/maker-core`（`AgentEvent` / `AgentKind` / `Logger` / `Maker` / `McpProvider` / `McpProviderContext` / `Session` 等类型,以及 `isTerminalAgentErrorEvent` / `toSessionDispatchOutcome` 两个判定函数）、`@modelcontextprotocol/sdk`（`McpServer`）、`zod`（tool 参数 schema）、`node:crypto`（`randomUUID`）。**不依赖 Electron、不依赖 `apps/*`、不依赖 `@lizi/maker-shared`**——这不只是约定,`eslint.config.mjs` 用自定义 `no-restricted-imports` 规则硬性拦截任何 `electron*` / `apps/*` import,报错文案是 "`@fmfsaisai/orca-workflow` must not depend on Electron. Host capabilities should be injected by apps/desktop."；任何新增需要 host 能力（文件系统、窗口广播等）的需求都必须走 `OrcaBridgeMcpDeps` 新增一个回调字段,不能直接 import。
- **唯一消费方**：`apps/desktop`（`package.json` 声明 `"@fmfsaisai/orca-workflow": "workspace:*"`）。具体接入点：
  - `apps/desktop/src/main/maker-host/index.ts` — 组装 `orcaBridgeDeps`（`getMaker`/`logger`/`persistUserMessage`→`createMessage`/`wireSession`→`wireSessionToIpc`/`hydrateSessionRoute`→`hydrateSessionProvider`/`orcaTeamStore`→`orcaTeamStoreAdapter`/`dispatchInterAgentMessage`）,调用一次 `createOrcaWorkerBridgeMcpProvider` 拿到 provider 后注册进 Claude 与 Codex 两条 agent 构造路径的 MCP provider 列表。
  - `apps/desktop/src/main/maker-host/orcaTeamStoreAdapter.ts` — 实现 `OrcaTeamStore`,做 `teamId`/`workflowId` 字段名桥接。
  - `apps/desktop/src/main/maker-ipc/register.ts` — 调用 `renderOrcaLeadSystemPrompt` / `renderOrcaWorkerSystemPrompt`（经 `applyOrcaInstructions`,按 `vendorOptions.orcaRole` 分支）生成 session 创建时的 system prompt；也负责重启后从 DB `sessions.orca_role`/`orca_workers`/`orca_teams` 懒合成 vendorOptions（`synthesizeOrcaVendorOptionsFromDb`）,这是 `resolveWorkerLink` 归属校验能在重启后继续工作的前提。
  - `apps/desktop/src/main/maker-ipc/orcaInterAgentDispatcher.ts` — 实现/消费 `dispatchInterAgentMessage`,决定消息直发还是排队,并把 accepted/rollback 语义喂回本包的 `send_to_lead` handler；同时导入 `formatAgentMessage`/`formatOrcaCommunicationMessage` 保证"手动 toggle"派发路径与 MCP 工具路径消息格式一致。
  - `apps/desktop/src/main/maker-ipc/orcaManualInterrupt.ts` — 注释级引用,说明手动中断兜底路径要与本包的 capture 路径互相配合。
  - `apps/desktop/src/renderer/components/chat/MessageStream.tsx` — 按工具全名字符串（`mcp:orca_worker_bridge:send_to_lead` 等）识别本包工具调用做特殊渲染。
  - 注意区分：desktop 侧 `local-db:orca-workflows:*` IPC channel 名与 `orcaTeams.ts` 里的 "orca-workflows"（复数,带 s）是 desktop 本地 DB 概念的命名,与本 npm 包名字仅是字面撞车,不是对本包的引用。
- **对外接口形态**：本包不导出任何 class 实例或单例状态给消费方直接操作,只导出"工厂函数 + 纯函数 + 类型"；`createOrcaWorkerBridgeMcpProvider` 调用时创建的 `CapturedSessionRegistry` 是闭包私有状态、一次 provider 实例对应一份；但 `workerAutoBridgePending` 是模块级单例 Map,跨所有 provider 实例共享（同进程内）。

## 不要做的事

- 不要假设 `orca_worker_bridge` 只对 worker session 可见——`isEnabled` 对所有 `agentKind === 'codex'` 也为真（Codex HTTP bridge 是进程级全局注册,无法按角色收窄可见性,这是已知且被接受的现状,不是待修的 bug）。真正的越权防护在工具调用时由 `resolveWorkerLink` fail-closed 兜底,新增/修改 tool handler 时必须保持这个"可见性宽、执行时严格校验"的模式,不能把安全边界寄望于可见性收窄（`docs/orca-team-architecture.md` 坑点 #4，状态：follow-up，短期收不掉）。
- 不要修改 `renderOrcaLeadSystemPrompt` / `renderOrcaWorkerSystemPrompt` 的文案而不先按 AGENTS.md 规则 11 找 Lizi 确认——这两个函数渲染的内容会进最终 system prompt,影响 Anthropic prompt cache 前缀稳定性与全体用户的 agent 行为（规则 10 的四指标）。
- 不要在 `send_to_lead` 的 accept/settle 逻辑里跳过 `workerReportSettled` 幂等门控,或让 `settleWorkerReport` 在 host queue drain 时被二次触发——worker 可能已被重新派活变成 `running`,重复 settle 会把它错误地改回 `done`。
- 不要让 `formatOrcaCommunicationMessage`（持久化格式）和 `formatAgentMessage`（真正 send 格式）在某条入口各自实现一遍——host 侧任何新增的 lead→worker/worker→lead 派活路径都必须复用这两个函数,否则会和 MCP 工具入口产生行为不一致。
- 不要给 `OrcaWorkerLink` 改字段名而不同步 `apps/desktop/src/main/maker-host/orcaTeamStoreAdapter.ts` 里的 `workflowId`/`teamId` 双写兼容逻辑——本包协议字段名是 `workflowId`（对 worker agent 可见的 wire 字段）,desktop 内部模型字段名是 `teamId`,这是历史命名差异,adapter 层故意同时携带两者。
- 不要绕开 `CapturedSessionRegistry` 的 stale 检测（`ensureCapturedSession` 里对 `status === 'closed' | 'error'` 的判断）直接复用旧 `session` 引用——lead session 可能已被 host 端的 active-orca rehydrate 逻辑关闭重建,继续监听旧实例会导致 `read_lead`/`lead_status` 读到永远不更新的陈旧输出。
- 不要在错误处理路径里绕过 `sanitizeOrcaSendError` 直接把 `err.message` 塞进日志或 tool 返回值——`Error.message` 可能携带 prompt/token/用户消息/文件内容等敏感信息,必须走白名单化的错误名/错误码。
- 不要给本包新增 `electron*` 或 `apps/*` 的 import 来"抄近路"拿 host 能力——`eslint.config.mjs` 的 `no-restricted-imports` 规则会直接拦截,正确做法是在 `OrcaBridgeMcpDeps` 上加一个新回调字段,由 `apps/desktop` 实现后注入。

## 演进备忘

_仅追加。每次重大改动留一行：日期 - 做了什么 - 原因。_
