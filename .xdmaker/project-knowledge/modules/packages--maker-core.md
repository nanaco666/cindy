---
id: packages--maker-core
type: module
covers:
  - packages/maker-core/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-06T14:24:56.000Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# packages--maker-core

## 是什么

`@lizi/maker-core` 是 XDMaker 的核心抽象层，封装了 AI agent（Claude Code / Codex）的会话编排、事件流翻译、能力声明、鉴权透传和跨 agent 记忆系统。**严格零 Electron 依赖**——所有 IO（safeStorage、userData、spawn 路径、SQLite 工厂）由 host 层（`apps/desktop/src/main/maker-host/`）通过依赖注入传入。包的入口是 `packages/maker-core/src/index.ts`。TypeScript source-only，不编译产物（`"main": "./src/index.ts"`）。

## 关键抽象 / 核心代码地标

- **`Maker`** (`src/maker.ts`) — 顶层 Session 注册中心 + Agent 路由。持有 `agents: Partial<Record<AgentKind, BaseAgent>>` 和 `activeSessions: Map<string, Session>`。Session ID 是纯 UUID（`crypto.randomUUID()`），调用方可传入 `opts.id` 幂等复用。`createSession` 内部将 `sessionId: id`（business 层 session id）透传给 `agent.startSession`，让 agent 在构造 MCP provider ctx 时塞入 `ctx.sessionId`，控制类工具（如 `enable_collab_mode`）用它把回调路由到对应 session 的业务函数。对外暴露 `createSession`、`closeSession`、`listActiveSessions`、`shutdown`、`oneShot`、`forkSdkSession`、`getAgentAuthState`、`triggerAgentLogin`、`logoutAgent`、`cancelAgentLogin`、`listCustomizations`、`scanAtResources`、`listAgentCommands`、`listAgentSkills`、`getAgentMemoryStatus`、`setAgentMemory`、`resetAgentMemory`、`getAgentStatus`、`getCapabilities`、`listAvailableAgents`、`getSession`、`getSessionMeta`、`isSessionAlive`、`listAllMeta` 等统一入口；host 的 IPC handler 只需跟 Maker 交互，不直接碰 BaseAgent 或 Session。事件机制：`on(listener): () => void`，事件类型含 `session:created` 和 `session:closed`。`MakerDeps` 注入 `SessionStorage`、`Logger`、`SessionLifecycleHooks`（session close 副作用钩子，desktop 用来清 worktree/temp 文件/image cache）和可选的 `MakerMemoryManager`。

- **`Session`** (`src/session.ts`) — 单次 agent 会话的 UI 友好包装。持有 `AgentSessionHandle`，暴露 `send`/`abort`/`close`、运行时切换（`setModel`/`setEffort`/`setPermissionMode`/`setFastMode`/`setExtraDirs`/`setVendorOptions`）、rewind preview/commit（Claude-only）、事件订阅（`onEvent`/`onStatusChange`）和 `setInteractionListener` 注入。内部 `runEventLoop` 把 handle 的 `AsyncIterable<AgentEvent>` 转为 listener push（`startEventLoopIfNeeded` 保证只启动一次）。四态生命周期：`'active' | 'aborting' | 'closed' | 'error'`（纯内存不持久化，与 desktop DB 的产品归档状态独立）。`setVendorOptions(patch)` 浅合并到 handle 内部 closure，用于 Orca 协同模式等 host 需要中途切换 session-specific 配置的场景；不写 DB，持久化由调用方负责。`close()` 已加 DEBUG-TEMP 日志打印调用方栈帧，排查 stuck-Generating 问题（排查完删）。

- **`BaseAgent`** (`src/agents/base-agent.ts`) — 抽象基类，ClaudeCodeAgent 和 CodexAgent 继承实现。定义 `AgentDeps`（`auth: AuthAdapter`、`runtimeConfig: AgentRuntimeConfig`、`binaryPath`、`logger`、`mcpProviders`、`makerMemory`、`capabilityAdditions`、`isTrustedMcpServer`、`prepareCodexExtraSpawnConfig`、`prepareCodexResumeSession` 等）。唯一 abstract 方法：`startSession → AgentSessionHandle`。非 abstract 但可覆盖（默认抛 `NotSupportedError`）：`oneShot`、`forkSdkSession`、`getMemoryStatus`/`setMemory`/`resetMemory`。默认 no-op：`listAgentCommands` (返回 [])、`listAgentSkills`、`listCustomizations`、`scanAtResources`（用 PaletteScanner）、`dispose`。`memoryOverride: boolean | undefined` 保护字段由构造期 `runtimeConfig.memoryEnabled` 初始化，运行时 `setMemory` 可变更；子类在 buildQuery closure 中通过 getter 读取以捕获动态变化。

  **`claudeHooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>`**（新增，Claude 专用）：host 构造 ClaudeCodeAgent 时按 `HookEvent`（`PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `SessionStart` 等）注入 in-process JS 回调表，`ClaudeCodeAgent.startSession` 将其透传给 SDK `options.hooks`；Codex 不消费此字段。设计边界：maker-core 自己不持有任何 hook 实现，仅作注入点；hook 类型直接复用 SDK 的 `HookCallbackMatcher`，与 `mcpProviders` 使用 `McpServerConfig` 同模式。闭包语义：hooks 在 `startSession` 时一次性传给 SDK，之后无法替换（与 `vendorOptions` 同坑）；host 若需运行时可替换，应自己包一层 `(input) => current(input)` 走可变引用。与 `canUseTool` 的关系：`PreToolUse` 比 `canUseTool` 更早，返回 `'allow'`/`'deny'` 会跳过 `canUseTool`；返回 `'defer'` 或不给 `permissionDecision` 才继续走原 permission 流程，注入时需注意避免打穿 Orca / 协同模式那套 permission UI。`undefined` 时不传 `hooks` 字段，行为与改动前一致。

  **`StartSessionOptions`** 新增 `sessionId?: string`：business 层 session id（由 `maker.createSession` 的 `opts.id` 经 maker.ts 透传至此），agent 将它放入 `McpProviderContext.sessionId`，让 MCP server 工厂闭包绑定"当前 session 是谁"，工具 handler 据此回调 host 的 session 级业务函数（如 `enable_collab_mode` 需要 leadSessionId）。与 `AgentSessionHandle.id`（SDK 自己生成的 sdkSessionId）不同；未提供时 `ctx.sessionId` 为 `undefined`，工具应返回业务错误码（如 `LEAD_NOT_SUPPORTED`）。

- **`AgentSessionHandle`** 接口 — vendor-neutral 统一契约。必选：`id`、`agentKind`、`model`、`send`、`abort`、`close`、`events() → AsyncIterable<AgentEvent>`、`getUsageSnapshot`、`setInteractionResolver`。可选（不实现则 Session 层抛 NotSupportedError）：`setModel`、`setEffort`、`setPermissionMode`、`setFastMode`、`setExtraDirs`、`setVendorOptions`、`getFastMode`、`previewRewindFiles`、`commitRewindFiles`、`isTurnRunning`。
  - `setVendorOptions?(patch: Record<string, unknown>): Promise<void>` — 运行时浅合并 vendorOptions 到内部 closure。**必须用 `Object.assign` 原地合并，不能重赋值**——MCP server tool handler 闭包在 startSession 时捕获 `vo` 对象引用，重赋值会让旧闭包永远停留在旧值上（Orca toggle 关再开后 Lead 工具指向第一次 workflow/worker 的 bug 根因）。不发起任何 SDK 调用，只改 closure；下一 turn / 异步 tool 调用立即看到新字段。

- **`ClaudeCodeAgent`** (`src/agents/claude-code/index.ts`) — 基于 `@anthropic-ai/claude-agent-sdk` 的 `query()`/`forkSession()`/`getSessionMessages()` API。env 由 `buildClaudeEnv(auth, runtimeConfig)` 组装（清洗 process.env → 注入 behaviorFlags → endpoint → authEnv → `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` → telemetry 抑制 → 可选网络 debug）。`mcpProviders` 过 `isEnabled` 过滤 + `toClaudeSdkConfig` 转换。systemPrompt 多段拼接（SDK preset → engine 内置 `MAKER_SYSTEM_PROMPT_APPEND` → makerMemoryRules → host 产品级 `runtimeConfig.systemPrompt` → per-workdir MEMORY.md index snapshot → per-call `userPrompt`），走 SDK `{ type: 'preset', preset: 'claude_code', append }` 格式。支持 rewind（`pendingRewindTo` 标记 → `q.close()` 杀老 forward loop → 下一 `send` 检测标记 → `buildQuery({ resumeSessionAt, forkSession: true })` 重建 + 同一 eventQueue 续流）。`oneShot` 走 Anthropic HTTP API 直调（非 CLI 子进程），默认 `claude-haiku-4-5`。图片输入走 `ImageResizer`（基于 sharp，优化 vision token 用量）。运行时 `setExtraDirs` 改 closure 变量 `mutableExtraDirs`，下一 turn 的 `buildQuery` 读取生效（当前 turn 用旧值）。MakerMemory 注入：enable 时 snapshot MEMORY.md index（会话启动时快照，rewind 不刷新） + 创建 `MemoryFlushController`。

  `startSession` 的 `buildQuery` 在展开 SDK options 时，若 `this.deps.claudeHooks` 有值则追加 `hooks: this.deps.claudeHooks`；`undefined` 时不传该字段，SDK 走默认（无 hook）。

  event loop 退出时和 `handle.close()` 调用时均已加 DEBUG-TEMP 日志（含 `eventQueueResidualSize` 和调用方 stack），用于追查 stuck-Generating 根因，排查完需删除。

  **SSE idle watchdog**（`startSession` scope，turn 级）：上游 stream 静默超过阈值时，emit 结构化 `error` 事件 + 调 `q.interrupt()`（与用户手动 stop 同路径），**不**调 `abortController.abort()`（后者会让 SDK Query 进黑洞 session 导致后续 send 全失败）。
  - 阈值默认 300 s，对齐 Anthropic Agent SDK 的 `CLAUDE_STREAM_IDLE_TIMEOUT_MS` 默认值；通过 env `XDT_CC_SSE_IDLE_TIMEOUT_MS`（毫秒）覆盖，设 0 关闭。
  - 生命周期：`handle.send` 在 `inputQueue.push` 之后调 `armSseIdle()`（避免把 client 端 image-resizer 等耗时算进上游静默配额）→ 每条 SDK message 调 `noteSseActivity(eventType)` 重新 arm → `onTurnEnd` 调 `clearSseIdle()` + `turnInFlight=false` → watchdog 触发时先清 `turnInFlight` 再 `interrupt`（防 SDK drain 期间再次 arm）→ loop `finally` 兜底 `clearSseIdle()`。
  - 解析逻辑在 `parseIdleTimeoutMs(raw)` 函数；非有限正整数一律回退到默认值。

  **内置命令** (`src/agents/claude-code/commands.ts`) — `CLAUDE_CODE_AGENT_COMMANDS` 列表，由 `listAgentCommands` 返回给 host/renderer：
  - `/compact` — 清空对话历史但在 context 保留摘要，支持可选说明参数。
  - `/context` — 以彩色网格可视化当前 context window 用量（system prompt、tools、messages、free space 各占比）。

  **`system-prompt-append.md`**（`src/agents/claude-code/system-prompt-append.md`）当前为空文件。所有产品级规则（mermaid 渲染、内部系统 MCP 路由、实时信息查询、音频播放器、绘图、免责声明）已上移至 host 层维护：
  - `apps/desktop/src/main/maker-host/host-system-prompt.md`（vendor-neutral）
  - `apps/desktop/src/main/maker-host/claude-system-prompt.md`（Claude host 专属）
  - host 通过 `runtimeConfig.systemPrompt` 注入，与 `SYSTEM_PROMPT_APPEND` 常量在 `startSession` 内拼接。
  - 只有**仅在 Claude Code 引擎层生效**的规则（CC SDK 协议细节、ToolSearch 行为等真正不可移植到其他 vendor 的内容）才写回 `.md`。

  `startSession` 中 `vo` 声明为 `const vo: Record<string, unknown> = { ...(opts.vendorOptions ?? {}) }`（mutable closure），`setVendorOptions` 实现通过 `Object.assign(vo, patch)` 原地合并；MCP server `isEnabled(ctx)` 中 `ctx.vendorOptions` 始终指向同一 `vo` 对象，任何后续 `setVendorOptions` 调用对所有已注册 tool handler 立即可见。`buildMcpServers` 构造 `McpProviderContext` 时同时注入 `sessionId: opts.sessionId`（来自 maker.ts 透传），让控制类 MCP 工具（如 `enable_collab_mode`）能在 tool handler 闭包中把回调路由到对应 session 的业务函数。

  **`toSdkModelString` 映射规则**（`src/agents/claude-code/index.ts`）：
  - `*opus-4-8*` → `claude-opus-4-8[1m]`
  - `*opus-4-7*` → `claude-opus-4-7[1m]`
  - `*opus-4-6*` → `claude-opus-4-6[1m]`
  - `claude-fable-5` → `claude-fable-5[1m]`
  - `claude-sonnet-5` → `claude-sonnet-5[1m]`
  - `claude-sonnet-4-6` → `claude-sonnet-4-6[1m]`
  - 其余 `*sonnet*` → `${model}[1m]`（兜底透传显式 id，仍不裸 `sonnet`）
  - `claude-haiku-4-5` → `claude-haiku-4-5-20251001`
  - `gpt-5.5` / `gpt-5.4` → 追加 `[1m]`；`codex/gpt-5.5` / `codex/gpt-5.4` → 原样透传（不加 `[1m]`）
  - `deepseek/deepseek-v4-pro` / `deepseek/deepseek-v4-flash` → 追加 `[1m]`
  - `z-ai/glm-5.2` → 追加 `[1m]`
  - 其余 model id 原样透传

  **设计说明**：一律走显式版本号，不用 `'opus'` / `'sonnet'` 裸别名——cc-code 二进制升级后别名指针会漂移到下一代模型（`'opus'` 从 4.6 漂到 4.7；裸 `'sonnet[1m]'` 在 Sonnet 5 上线后仍被二进制解析成 `claude-sonnet-4-6`，用户选 Sonnet 5 实际命中 4.6，2026-07 实踩）。`[1m]` 是 SDK beta 通道后缀，在 `toSdkModelString` 里对 1M 窗口型号静态追加；haiku 用日期版本号、`codex/*` 骨折路由不追加 `[1m]`。模型路由不依赖 `[1m]`：`isAnthropicWireModel` 只按 `claude-` / `sonnet` / `opus` / `haiku` / `fable` 前缀判定。

- **`CodexAgent`** (`src/agents/codex/index.ts`) — 走共享 `AppServerHost`（共享 codex app-server 子进程 + JSON-RPC NDJSON）。N 个 session 通过 `thread_id` 多路复用同一子进程。Phase 1–4 完成：基础对话、resume（`thread/resume`）、approval（commandExecution/fileChange/MCP elicitation）、runtime 切换、fork（`thread/fork`）、oneShot。`oneShot` 用 `gpt-5.4-mini`。**无 rewind 支持**（协议限制）。MCP allowlist 支持（`isTrustedMcpServer` 回调，trusted 直接 accept 免弹 UI）。sandbox policy 映射：`bypassPermissions` → `danger-full-access`，`auto` → `workspace-write` + `on-failure`，`ask`(default) → `workspace-write` + `on-request`。`setVendorOptions` 已实现接口但当前为 noop（Codex MCP bridge 用全局空 ctx 注册，不读 per-session vo，见 `codexEnvironment.ts`）；只记日志，不抛 NotSupportedError，host 可无差别调用；后续 Codex MCP 支持 per-session ctx 后在此挂闭包。**不消费 `claudeHooks`**（该字段 Claude 专用）。

  **`system-prompt-append.md`**（`src/agents/codex/system-prompt-append.md`）当前为空文件。所有产品级规则已上移至 host 层：
  - `apps/desktop/src/main/maker-host/host-system-prompt.md`（vendor-neutral）
  - `apps/desktop/src/main/maker-host/codex-system-prompt.md`（Codex host 专属）
  - host 通过 `runtimeConfig.systemPrompt` 注入，与 `SYSTEM_PROMPT_APPEND` 在 `developerInstructions` 拼接后通过 `thread/start` 送入 codex 子进程。
  - 只有**仅在 Codex 引擎层生效**的规则（codex-rs 协议细节、approvalPolicy / sandbox 行为等）才写回 `.md`。

- **`buildCodexEnv`** (`src/agents/codex/env-builder.ts`) — 组装 Codex 子进程的 env 字典。在清洗 `process.env` 基础上注入 auth、endpoint、行为 flags 等；末尾做两项兜底：Python UTF-8 encoding（`PYTHONUTF8`/`PYTHONIOENCODING`）；**NO_PROXY 规范化**：合并现有 `NO_PROXY` 和 `no_proxy`（小写），追加 `127.0.0.1`、`localhost`、`::1`，写回大写 `NO_PROXY`，删除小写 `no_proxy`——防止企业网络 PAC/HTTP_PROXY 把 localhost MCP bridge 请求路由到上游代理，Rust reqwest（codex rmcp）收到 HTML 错误页后报 `UnexpectedContentType`，导致所有 lizi_mcp / orca worker 工具不可用。

- **`AppServerHost`** (`src/agents/codex/app-server/host.ts`) — 单例懒启动 codex app-server 子进程管理器。首次 `ensureStarted()` 触发 spawn + initialize，并发调用共享同一 Promise（idempotent + parallel-safe）。notification 按 `threadId` 路由到 `subscribers: Map<threadId, ThreadEventHandlers>`，含 notification 缓冲回放（默认 5000ms 窗口，解决 `thread/started` 竞态）。`lastAccountRateLimits` 缓存账号配额快照，新 `subscribeThread` 时立即重放（用户开新 codex session 不必等下次 turn 才看到 chip 数据）。`shutdown()` 设 `shuttingDown` 标记 → clear subscribers/buffered → 委托 `AppServerClient.close()`；完成后重置 `shuttingDown = false` + `startPromise = null`，允许后续 `ensureStarted` 重新 spawn（transport error 恢复路径）。子进程 crash/IO 错误时广播给所有 subscriber 的 error handler 后强制 shutdown。

- **`AppServerClient`** (`src/agents/codex/app-server/client.ts`) — JSON-RPC NDJSON 传输层，管理 stdin/stdout 双向通信。`close()` 优雅关闭：先 `stdin.end()` 让 server 看到 EOF，然后 SIGTERM 兜底（Windows 子进程不会随父进程终止，必须显式 kill）。有 `maxMessageSize` 守卫（默认 16MB），单行超限直接 close session 防 OOM。stderr 分类处理：检测 `AUTH_INVALIDATED_RE` 模式触发 `onAuthInvalidated`（单次 latch 防刷屏）。

- **`CustomizationScanner`** (`src/agents/claude-code/customization-scanner.ts`) — 扫描 `~/.claude/` 和 `{workingDir}/.claude/` 下三种 kind（`skill`/`command`/`agent`）的本地 customization 文件，输出统一 `AgentCustomization` 列表。Read-only，不写文件、不发网络。缺失目录 soft miss 收进 errors 不抛。排序：scope (global 先) → kind (skill, command, agent) → name 字母序。

- **翻译器** (`src/agents/claude-code/translator.ts` / `src/agents/codex/translator.ts`) — 各自把 vendor SDK 事件翻译为统一 `AgentEvent` 类型流（`text`/`thinking`/`tool_use`/`tool_result`/`status`/`done`/`error` 等），renderer 不感知 vendor 差异。Claude 翻译器维护 `RuntimeState`（currentThinking、lastAssistantMeta）+ `TurnState`（text accumulation、toolUses count）。Codex 翻译器维护 `CodexRuntimeState`（reasoningStartedAt、reasoningTextLen、itemTextLen、emittedToolUse），含 reasoning summary text delta 流式处理。

- **`UsageTracker`** (`src/agents/shared/usage-tracker.ts`) — agent-agnostic token/context/cost 状态机，从 vendor SDK 原始 usage 映射到统一 `UsageSnapshot`。单 turn 累计，turn end reset；含 per-model cost 跟踪和 per-turn/session 级 cache hit rate 统计。

- **`AsyncQueue`** (`src/agents/shared/async-queue.ts`) — 多生产者 push + 单消费者 async iterable 的轻量队列，agent event loop 核心数据结构。接口：`push(item)`、`end()`、`size(): number`（DEBUG-TEMP，排查 stuck-Generating 用，后续删除）、`[Symbol.asyncIterator]`。

- **`ImageResizer`** (`src/agents/shared/image-resizer.ts`) — 本地图片 vision token 优化，基于 `sharp`（peerDep，optional）。SHA256(path+mtime+size+'v1') 缓存 key，LRU 200MB 上限，5s 超时，失败 fallback 到原图。单例模式 via `getDefaultImageResizer()`/`configureDefaultImageResizer()`。

- **`TurnStartPhrases`** (`src/agents/shared/turn-start-phrases.ts`) — turn 开始时的随机暖心文案池（one-shot tip sampling + pity 保底计数器），跨 agent 复用。

- **`PaletteScanner`** (`src/agents/shared/palette-scanner.ts`) — `scanWorkspaceFileResources` 扫描 workspace 文件/目录为 `@` palette 提供结果（两 agent 共用）；`scanClaudeSlashCommands` 扫 `~/.claude/{commands,skills}/` 提供 agent skills；`scanClaudeAtResources` 扫 workdir 为 Claude agent `@` palette 提供结果。

- **凭证形态推导** (`src/agents/credential-mode.ts`) — 纯函数组，按会话显式来源推导子进程凭证形态（`AgentCredentialMode`，定义在 `interfaces/auth-adapter.ts`）。`resolveAgentCredentialMode`：`providerId === 'xd'` → `gateway-key`；官方订阅来源（claude-code+`anthropic` / codex+`openai`）→ `oauth-bearer`；未指定来源的 `codex/*` model → `gateway-key`；其余 `undefined`（交回各 adapter 既有 fallback）。`resolveEffectiveCredentialModeFromAuthSource` 把"未显式指定来源"归一化成 fallback 实际形态。`canReuseHostForCredentialMode` 判断共享 `AppServerHost`（codex 单例子进程）能否被复用——凭证形态不同必须重启子进程，否则会串用错误凭证。

- **Session 派发结果** (`src/session-send-outcome.ts`) — `SessionDispatchOutcome` = `{dispatched:true}` | `{dispatched:false, reason:'cancelled-before-dispatch', message, context}`。`toSessionDispatchOutcome(SessionSendResult, ctx)` 把 `session.send` 的 `{accepted, reason}` 结果（`SessionSendResult` 定义在 `session.ts`）转成带上下文的结构化结果；`assertSendDispatched` 是断言版（未派发直接抛）。用于区分"送进 vendor 了"和"vendor 派发前被取消"两种语义，host 据此决定是否重试/提示。

- **CC 转录迁移/归位** (`src/agents/claude-code/transcript-relocation.ts`) — `relocateClaudeSessionTranscripts`：会话 workingDir 变更（对话移进/移出项目、换目录）时，把该会话全部 sdk session 的转录 jsonl **复制**（非移动，保证可重入/不丢历史）到新 cwd 的 CLI 转码目录，否则下次 resume 会因 CLI 在新 cwd 转码目录找不到 jsonl 而报 `No conversation found with session ID`。`ensureClaudeTranscriptInWorkingDir`：resume spawn 前 / rewind fork 后做"归位"，全局扫描比 mtime 确保 workingDir 转码目录里是最新副本（覆盖 CLI 运行中 cd、fork jsonl 落源文件旁等 DB workingDir 未变的分叉场景）。路径工具复用 `claude-projects-fs.ts`。

- **Maker Memory 子系统** (`src/memory/`) — 跨 agent、per-workdir 记忆层：
  - `MakerMemoryManager` (`manager.ts`) — 顶层单例 + per-workdir Store 实例池。`setAgents()` 解决"agents 需要 manager，manager 需要 agents"的循环依赖（manager 先创建，agents 构造后回填）。enable 时联动调 agent `setMemory(false)` 关原生 auto-memory；`dispose()` 关所有 db。
  - `MakerMemoryStore` (`store.ts`) — per-workdir facade，组合 `MemoryStorage` (fs) 和 `MemoryFts` (sqlite)，暴露 read/write/delete/list/search/getIndex/consolidate。init 时做 sanity check（storage/FTS count 同步），fts 同步失败不阻塞主路径（文件是 source of truth）。
  - `MemoryStorage` (`storage.ts`) — 文件系统 CRUD + frontmatter YAML 解析 + MEMORY.md 索引自动重建（`rebuildIndex()` 在 write/delete 后触发，LLM 不直接改 MEMORY.md）。文件格式 `<type>_<slug>.md`（YAML frontmatter + body），有 soft limit (2KB) / hard limit (8KB)。目录 `<basePath>/<sanitized-workdir>/`，含路径遍历保护和 slug 校验。
  - `MemoryFts` (`fts.ts`) — SQLite FTS5 全文检索（standalone 模式，porter stemming + unicode61 分词）。
  - `MemoryFlushController` (`flush-controller.ts`) — 监控 token usage，三档阈值 `[0.70, 0.85, 0.92]` 触发 flush 信号，当前 A 轻版只打 INFO 日志验证信号源，尚未接真实 flush 逻辑。每档阈值单 session 内只触发一次，收到 `compact_boundary` 事件后重置所有 fired 标记（compact 后又有空间）。
  - `MAKER_MEMORY_RULES` (`system-prompt.ts`) — 注入 agent system prompt 的静态规范段，教 LLM 通过 `lizi_memory` MCP server 操作 memory。
  - 类型层 (`types/memory.ts` + `memory/types.ts`) — 4 类分片（user/feedback/project/reference），frontmatter yaml 结构，WriteOptions/WriteResult/SearchHit/MemoryConfig/MemoryError。

## 类型系统地标

- `src/types/common.ts` — `AgentKind`（`'claude-code' | 'codex'`）、`Effort`（6 态: `'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`）、`PermissionMode`（6 态）、`ReasoningDisplay`、`UserMessage`（含 image/file/mention content block）、`AuthState`
- `src/types/capabilities.ts` — `Capabilities`、`CapabilityStatus`（`{ supported: true } | { supported: false; reason: 'sdk-missing' | 'not-implemented' | 'platform-limited' }`）、`ModelDescriptor`（含 `efforts`/`defaultEffort`/`supportsFastMode`/`effortDisplayNames`）、`EffortDescriptor`、`PermissionModeDescriptor`、`MemoryCapability`
- `src/types/events.ts` — `AgentEvent` union（`text`/`thinking`/`tool_use`/`tool_result`/`tool_result_full`/`image`/`account_usage`/`interaction_request`/`interaction_dismissed`/`status`/`compact_boundary`/`session_id`/`done`/`error`），`InteractionRequest`/`InteractionDecision`（三态：`permission`/`ask_user_question`/`plan_review`），`UsageSnapshot`，`RewindFilesResult`，`ForkSdkSessionOptions`/`ForkSdkSessionResult`
- `src/types/memory.ts` — `MemoryStatus`、`MemorySetResult`、`MemoryResetResult`
- `src/types/context-usage.ts` — `ContextUsageData`：`/context` 命令的结构化 payload（categories / gridRows / memoryFiles / totalTokens / maxTokens / percentage / model），镜像 SDK `SDKControlGetContextUsageResponse` 但不把 SDK 类型泄漏进 renderer 契约，**必须 JSON-serializable**（跨 IPC）
- `src/types/customizations.ts` — `AgentCustomization`（engine/kind/scope/name/absolutePath/mdPath/files/frontmatter/engineExtras）、`ListCustomizationsOptions`、`ListCustomizationsResult`
- `src/types/palette.ts` — `ScanAtResourcesOptions`、`ScanAtResourcesResult`、`ListAgentSkillsResult`、`CommandDefinition`、`AgentBuiltinCommand`
- `src/types/permissions.ts` — `SessionPermissionUpdate`、`createSessionPermissionUpdate`、`coerceSessionPermissionUpdates`、`hasSessionPermissionUpdates`
- `src/types/md-raw.d.ts` — markdown 文件 `?raw` import 类型声明
- `src/interfaces/` — `AuthAdapter`（`getState`/`triggerLogin`/`logout`/`getAuthEnv`/`cancelLogin?`/`invalidate?`）、`AgentRuntimeConfig`（endpoint, behaviorFlags, pathPrepends, systemPrompt, memoryEnabled, makerMemoryEnabled, userDataPath）、`SessionStorage`/`SessionMeta`、`Logger`（含 `child()`）、`McpProvider`（`isEnabled`/`toClaudeSdkConfig`）；`McpProviderContext`（`agentKind`/`workingDir`/`vendorOptions?`/`sessionId?`）——`sessionId` 为 business 层 session id，Codex 全局 ctx 场景不注入（undefined 表示"无法绑定到单个 session"）。

## 模块边界

**依赖**:
- `@anthropic-ai/claude-agent-sdk` 0.2.112 — Claude Code SDK（query/fork/getSessionMessages）；`HookEvent` / `HookCallbackMatcher` 类型由此 import 供 `AgentDeps.claudeHooks` 使用
- `@anthropic-ai/sdk` ^0.91.1 — Anthropic HTTP API client（oneShot 直接 HTTP 调用用）
- `gray-matter` ^4.0.3 — frontmatter 解析（memory storage + customization scanner）
- `better-sqlite3` — **peerDependency, optional** — FTS5 用，host 注入 `SqliteFactory`，maker-core 自己不 require
- `sharp` — **peerDependency, optional** — 图片 resize，host 层按需注入

**被谁依赖**:
- `apps/desktop` — main 进程的 `maker-host/` 层实例化 Maker，注入所有 deps（AuthAdapter 实现、SessionStorage SQLite 实现、Logger electron-log 实现、McpProvider 飞书/memory MCP 实例、binaryPath 已下载的 CLI 路径等）。IPC handler 全部通过 Maker 公开方法路由。host 在构造 `ClaudeCodeAgent` 时可通过 `claudeHooks` 注入 SDK in-process hook 回调（例：图片 read 检测、敏感路径拦截等业务逻辑）。
- `packages/lizi-mcps` — 消费 memory 相关类型（`MakerMemoryStore`/`MemoryRecord` 等）实现 `lizi_memory` MCP server；同时通过 `McpProviderContext.sessionId` 实现 session 级控制类工具（如 `enable_collab_mode`）。

**不依赖**: Electron、Node native modules（除 type-only better-sqlite3/sharp）、任何 UI 框架、desktop localDb 实现。

## 不要做的事

1. **不要在 maker-core 引入 Electron 依赖**。所有 IO（文件系统路径、safeStorage、userData、子进程 spawn 路径解析）必须通过 `AgentDeps` / `MakerDeps` 注入，由 host 层（`apps/desktop/src/main/maker-host/`）实现。
2. **不要在 AgentSessionHandle 上加 vendor-specific 方法**。handle 接口是 vendor-neutral 的统一契约，vendor 特有行为通过可选方法或在子类内部处理。
3. **不要让 renderer 感知 vendor 差异**。translator 必须把 SDK 事件翻译成已有 `AgentEventType` union 成员，不新增 vendor-only 事件类型。
4. **不要在 maker-core 做 UI 状态/权限弹窗/DB 产品语义**。Session 的 `status` 是 SDK 子进程运行态（纯内存），与 desktop DB 的产品归档状态（`active`/`archived`/`deleted`）是独立维度，不可混用。
5. **不要让 LLM 直接改 MEMORY.md 索引文件**。索引由 `MemoryStorage.rebuildIndex()` 在 write/delete 后自动重建。这是与 Claude Code auto-memory "让 LLM 手写索引"的关键区分。
6. **不要在 FTS 同步失败时阻塞写入**。文件是 source of truth，FTS5 是派生索引，写入成功即返回，FTS 错误只 log warn。
7. **不要在 BaseAgent 子类之外持久化 Session 运行态到 DB**。`status` 曾被错误地 coerce 成 DB `'archived'` 导致正在运行的 session 被误标归档——运行态只存内存（`Maker.activeSessions` / `Session.status`）。
8. **shutdown 是完全并发的**：`agent.dispose()` 和 `session.close()` 通过 `Promise.allSettled()` 并发执行（agent disposal 先入队以保证 SIGTERM 优先到达事件循环），不是"先 session 再 agent"的串行模式。`makerMemory.dispose()` 在 allSettled 之后同步执行。
9. **不要在 `MemoryFlushController` 阈值回调里直接触发真实 flush**。当前是 A 轻版只记录 INFO 日志，flush 逻辑未接入，修改前需确认轻版/重版策略边界。
10. **`toSdkModelString` 禁止使用 `'opus'` / `'sonnet'` 等裸别名**。cc-code 二进制升级后别名指针会漂移到下一代模型，必须用显式版本号（如 `opus-4-6`、`opus-4-7`）。
11. **rewind 重建路径不要拆成多套**。`pendingRewindTo` 标记 → `q.close()` → 下一 `send` 重建 query 是唯一的 session 重启路径，所有需要重启 CLI 子进程的场景（rewind、配置变更等）都应复用此机制。
12. **`setVendorOptions` 的 `vo` 必须用 `Object.assign` 原地合并，禁止 `vo = {...vo, ...patch}` 重赋值**。MCP server tool handler 闭包在 startSession 时捕获 `vo` 对象引用，重赋值让旧闭包永远停留在旧对象上，导致 toggle 关再开后 Lead 工具指向旧 workflow/worker 的 bug。
13. **`buildCodexEnv` 中 `NO_PROXY` 必须始终包含 `127.0.0.1`/`localhost`/`::1`，且只保留大写 `NO_PROXY`，删除小写 `no_proxy`**。Rust reqwest（codex rmcp）在企业 PAC/HTTP_PROXY 环境下会把 localhost 请求路由到上游代理，导致 lizi_mcp / orca worker 工具全部不可用；大小写双份在 Rust/Go 生态里会互相覆盖，产生不确定行为。
14. **`McpProviderContext.sessionId` 与 `AgentSessionHandle.id`（sdkSessionId）是两个不同维度，不可混用**。前者是 business 层 UUID（来自 `maker.createSession` 的 `opts.id`），后者是 SDK 自己生成的内部 id；Codex 全局 ctx 场景（`codexEnvironment.ts`）不注入 `sessionId`，工具应以 `undefined` 作为"无法绑定到单个 session"的判断依据。
15. **不要把 vendor-neutral / 依赖桌面端能力的规则写入 engine 层 `system-prompt-append.md`**。两个引擎的 `.md` 当前均为空，产品级规则（mermaid 渲染、MCP 路由、实时信息查询等）统一在 host 层 `maker-host/host-system-prompt.md` 及各 vendor 专属 `claude-system-prompt.md` / `codex-system-prompt.md` 中维护，避免两份 `.md` 字节级重复。只有真正不可移植到其他 vendor 的引擎协议细节才写回对应 `.md`。
16. **SSE idle watchdog 触发必须走 `q.interrupt()`，禁止 `abortController.abort()`**。`abort()` 会让整个 SDK Query 进入黑洞 session，后续所有 `send` 调用全部失败；`interrupt()` 与用户手动 stop 同路径，SDK 仍会 drain 出 `ResultMessage` 走正常 translator 路径。watchdog 计时器 arm 必须在 `inputQueue.push` 之后（避免把 client 端 image-resizer 等耗时算进上游静默配额），`turnInFlight=false` 必须在 `interrupt()` 之前置位（防 SDK drain 消息重新 arm timer）。
17. **`AsyncQueue.size()` 是临时排查接口，排查完成后须一并删除**（接口声明 + 实现 + 所有调用点）。不要在业务逻辑中依赖 `size()` 做判断，queue 的消费语义由 `AsyncIterable` 驱动。
18. **`AgentDeps.claudeHooks` 中不要在 maker-core 层实现任何 hook 业务逻辑**。hook 回调（`PreToolUse` 拦截、路径检测等）属于 host 层业务，maker-core 只负责把 `deps.claudeHooks` 原样透传给 SDK `options.hooks`；Codex 不读此字段。

## 演进备忘

_仅追加。每次重大改动留一行：日期 - 做了什么 - 原因。_

- 2026-05-18 — `setOneM` 从 `q.setModel` 切换改为 `pendingOneMRestart` 标记 + CLI 子进程重启 — `[1m]` beta header 在 spawn 时由 `--betas` 注入，`q.setModel` 无法撤销已挂载的 beta 集合，实测 toggle off 后 contextWindow 仍报 1M；rewind 与 oneM 重启共用同一重建块。
- 2026-05-18 — `toSdkModelString` 新增 `deepseek/deepseek-v4-pro` 和 `deepseek/deepseek-v4-flash` → 追加 `[1m]` 映射 — 支持 DeepSeek 模型走 1M context 路径，与 opus/sonnet/gpt-5.x 保持一致。
- 2026-05-23 — `AgentSessionHandle` 新增可选方法 `setVendorOptions`，ClaudeCodeAgent 以 `Object.assign` 原地合并实现，CodexAgent noop 实现，Session 层透传 — 修复 Orca toggle 重开后 Lead 工具永远读到第一次 vo 对象的 bug（MCP 闭包捕获 ref，不能重赋值）。
- 2026-05-24 — `buildCodexEnv` 末尾追加 NO_PROXY 规范化逻辑（合并大小写、强制追加 localhost 条目、删除小写 `no_proxy`）— 修复企业网络 PAC/HTTP_PROXY 把 localhost MCP bridge 请求路由到上游代理导致 codex 端所有 lizi_mcp / orca worker 工具不可用的问题。
- 2026-05-24 — `McpProviderContext` 新增 `sessionId?`，`StartSessionOptions` 新增 `sessionId?`，`maker.createSession` 透传 `sessionId: id` 给 `agent.startSession`，ClaudeCodeAgent 将其注入 MCP provider ctx — 让控制类 MCP 工具（如 `enable_collab_mode`）在 tool handler 闭包内知道"我属于哪个 business session"，实现 session 级回调路由；Codex 全局 ctx 场景不注入，保持 undefined 语义。
- 2026-05-24 — ClaudeCodeAgent 和 CodexAgent 的 `system-prompt-append.md` 清空，将 mermaid 渲染等所有 vendor-neutral 产品级规则上移至 host 层（`host-system-prompt.md` / `claude-system-prompt.md` / `codex-system-prompt.md`）— 消除两份引擎 `.md` 字节级重复，engine 层只保留真正不可移植的引擎协议细节。
- 2026-05-26 — `CLAUDE_CODE_AGENT_COMMANDS` 新增 `/context` 内置命令 — 让用户可视化当前 context window token 用量分布（system prompt、tools、messages、free space）。
- 2026-05-27 — `ClaudeCodeAgent.startSession` 新增 turn 级 SSE idle watchdog（`armSseIdle`/`noteSseActivity`/`clearSseIdle` + `parseIdleTimeoutMs`）— 修复 AI Gateway 在 tool_result 提交后 SSE 流挂死不发任何 event 也不发 [DONE]、客户端无限等待（实测 57 分钟+）的问题；默认 300 s，通过 env `XDT_CC_SSE_IDLE_TIMEOUT_MS` 覆盖。
- 2026-05-27 — `AsyncQueue` 接口新增 `size(): number`，`handle.close()` 和 `session.close()` 加 DEBUG-TEMP 调用方 stack 日志 — 追查 stuck-Generating 根因（事件是否残留在 queue 未被 drain、close 从哪条路径触发），排查完后需整体删除。
- 2026-05-28 — `AgentDeps` 新增 `claudeHooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>`，`ClaudeCodeAgent.startSession` 将其透传给 SDK `options.hooks` — 为 host 层提供 Claude SDK in-process hook 注入点（PreToolUse / PostToolUse 等），maker-core 自身不持有任何 hook 实现；Codex 不消费此字段。
- 2026-07-06 — 仓库迁移后手动补录（refresh 因模块体量大屡次超时，改由人工核对源码增量更新）：`toSdkModelString` 扩到 opus-4-8 / fable-5 / sonnet-5 / sonnet-4-6 / codex/gpt-5.5 / z-ai/glm-5.2（并记录 Sonnet 5 裸别名误命中 4.6 的实踩）；新增 `credential-mode.ts`（子进程凭证形态推导 + AppServerHost 复用判断）、`session-send-outcome.ts`（派发前取消的结构化结果）、`transcript-relocation.ts`（workingDir 变更时 CC 转录 jsonl 复制/归位）、`types/context-usage.ts`（`/context` 结构化 payload）。
