---
id: packages--lizi-mcps
type: module
covers:
  - packages/lizi-mcps/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-06T15:29:57.000Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
## 是什么

`packages/lizi-mcps` 是 XDMaker 的 MCP（Model Context Protocol）工具包，向 LLM agent 暴露结构化工具，覆盖：xdt-helper（会话列表、聊天历史）、memory、scheduler、feishu / google / jira / confluence / art / **mivo** 等外部服务、以及 **`lsp/` 子模块**（TypeScript LSP 智能查询）。通过 `registerXxxTool` 函数注册到 MCP server，返回值走统一的 `okPayload` / `errorPayload` 包装（LSP 子模块走自己的 text-output 协议，见下方）。

## 关键抽象

- **`registerGetChatHistoryTool`**（`src/xdt-helper/get_chat_history.ts`）：拉取聊天消息，游标分页（默认 200/次，最大 1000）。
  - 响应结构分两层：
    - `sessions`：`{ [sessionId]: { workingDir, agentKind, title } }` — session 元数据，按 id 索引，避免每条 message 重复携带。
    - `messages`：数组，每行含 `id / sessionId / role / content(已 JSON 解析) / createdAt(ISO)`；`toolUseId / agentMeta / rewindAt` 仅在非 null 时出现（omit-when-null）。
  - 要查某条 message 的 workdir/agentKind/title，用 `sessions[message.sessionId]`。

- **`registerListSessionsTool`**（`src/xdt-helper/list_sessions.ts`）：列举 session，游标分页（默认 100/次，最大 1000）。
  - 固定字段：`id / title / workingDir / agentKind / workspaceKind / model / status / source / createdAt / updatedAt / messageCount`（messageCount 已过滤 rewind 软删消息）。
  - omit-when-null 字段：`orcaRole / parentSessionId / userSendAt`（绝大多数 session 为 null，不输出）。

- **`registerImageEdit`**（`src/art/mcpServer.ts`）：图像编辑工具，`model` 字段枚举三选一：
  - `gpt-image-2`：**默认**，无论质量需求如何，只要用户未显式指定 Google 系就传此值。
  - `gemini-3-pro-image-preview`：用户显式触发 Google 系且场景质量极致敏感（最终稿、真实感、复杂改图）时选用。
  - `gemini-3.1-flash-image-preview`：用户显式触发 Google 系且场景求快/求省（草稿、快速迭代、批量变体）时选用。
  - `XdproxyImageEditParams.model` 类型收口为 `XdproxyImageModel`（`src/types.ts`），不再是字面量联合，方便后续扩模型。
  - **选模型硬规则**：禁止因"质量需求高"自动跳 Google；只有用户显式说 nano banana / nanobanana / gemini / google / 谷歌 / 纳米香蕉，才进入 Google 系 pro / flash 二选一。

- **`registerDocxListBlockChildrenTool`**（`src/feishu/mcp/server.ts`）：读取指定飞书 Docx 块的直接子块，用于导航表格结构。
  - 参数：`url_or_document_id`、`block_id`（根块传 document_id，单元格传 table_cell block_id）、`page_size`（默认 500，最大 500）、`page_token`、`document_revision_id`（默认 -1 即最新）。
  - 响应：`{ document_id, parent_block_id, children: [...], has_more?, page_token? }`。
  - 典型用法：对表格 block_id 调用 → 拿 table_cell block_id → 再调用 → 拿内部文本块；写入文字时更新文本块，不直接改 table_cell 容器。
  - 底层走 `callOpenApi`（见下）。

- **`callOpenApi`**（`src/feishu/mcp/server.ts`）：飞书 Open API 统一 HTTP 调用底层，支持 `GET | PUT | POST | PATCH | DELETE`。原 `callSheetV2` 现在是它的薄包装（仅限 `GET | PUT | POST`，接口签名不变）。新工具应直接使用 `callOpenApi` 以获得完整 HTTP method 支持。

- **Feishu client `safeCall` 错误上报**（`src/feishu/client.ts`）：lark SDK 对非 2xx 抛 axios 错误，真实 Feishu code/msg 在 `err.response.data`。`safeCall` 现在：
  - **日志**：将 `err.response.data` JSON 序列化后追加到 error log（`body=...`），不再只暴露无意义的"Request failed with status code 400"。
  - **返回值**：`{ ok: false, errorCode: 'NETWORK_ERROR', data: { detail, response? } }`，`response` 字段在有 body 时追加，供上层诊断权限/scope/payload 问题。

- **Mivo reactive auth-failure recovery**（`src/mivo/mcp/server.ts` + `types.ts` + `service.ts`）：
  - `MivoMcpDeps.onApiKeyAuthFailure?()` — 可选 host 回调，当工具调用发现无 client（`MIVO_API_KEY_MISSING`）或结果带 auth-failure 文本时触发。
  - **触发时机**：(a) `deps.getClient()` 返回 null 时（key 本地缺失）；(b) 工具返回 `isError` 且 `containsAuthFailureSignal()` 命中（匹配 `'认证失败' / 'MIVO_API_KEY_MISSING' / 'authentication failed' / 'token 无效'`）。
  - **行为**：fire-and-forget（`fireAuthFailure` 不 await），当前调用仍向 agent 暴露错误；host 负责从中心服务器拉取最新 key，`service.ts` 的 client cache 在下次 `call_tool` 时用新 key 自动刷新。
  - **限流责任在 host**：`fireAuthFailure` 在包内不做 debounce，host 须自行避免将一批失败转换为一批 server 刷新请求。
  - `MivoServiceOptions.onApiKeyAuthFailure` 同步新增，`createMivoService` 透传到 deps。

### `lsp/` 子模块 — TypeScript LSP MCP（Phase 1）

| 文件 | 职责 |
|---|---|
| `lsp/lsp-mcp-server.ts` | factory：构造 McpServer + 注册 6 个工具 |
| `lsp/registry.ts` | `LspToolRegistry`：统一包 handler，成功路径吐 text、失败路径吐 `Error [CODE]: msg` |
| `lsp/server/jsonrpc.ts` | LSP JSON-RPC 客户端（Content-Length 分帧、stderr 分类、graceful close） |
| `lsp/server/lsp-server-process.ts` | 单 LS 进程封装（初始化 + lazy `ensureFileOpen` + 10MB 文件硬上限） |
| `lsp/server/lsp-server-pool.ts` | per-workdir+language 池，10 min idle reaper，shutdown race guard |
| `lsp/launcher/typescript.ts` | 用 `process.execPath + ELECTRON_RUN_AS_NODE=1` 跑 `cli.mjs`，**绕过 Windows .cmd shim** |
| `lsp/installer/npm-installer.ts` | lazy npm install `typescript-language-server` 到 `<userData>/lsp-servers/` |
| `lsp/detect/typescript.ts` | per-workdir 检测：tsconfig / monorepo markers / package.json typescript dep |
| `lsp/_shared.ts` | text 格式化函数族（Anthropic-aligned），gitignore filter，100KB 输出 cap |
| `lsp/tools/*.ts` | 6 个工具：`lsp_goto_definition / lsp_find_references / lsp_workspace_symbol / lsp_outline / lsp_hover / lsp_incoming_calls` |

**关键决策（Phase 1 锁定）**：
- **text 输出而非 JSON**：mirror Anthropic `@anthropic-ai/claude-agent-sdk` cli.js 的 `W37 / CGK / xGK / ...` 格式函数。v1/v2 用 pretty-JSON 时单次 `lsp_outline` 78KB，agent 转头去 grep；v3 改 text 后同任务 ~3KB，agent 直接消费。
- **all-tool 统一入参 `{file, line, character}`**（1-based，编辑器视角）；`workspace_symbol` 也要 `anchorFile`（用作 didOpen 锚点，tsserver 只搜已 didOpen 文件的 project graph）。
- **gitignore filter** 在 `_shared.ts:filterGitIgnoredUris`，覆盖 4 个 location-producing 操作（findRefs / goToDef / workspaceSymbol；goToImpl 我们暂未实现）。
- **10MB 文件硬上限**（`FILE_SIZE_LIMIT_BYTES`）+ **100KB 输出 cap**（`MAX_OUTPUT_CHARS`）：防 tsserver 被巨型生成文件压垮 + 防 Claude Code UI 把结果卸载到 toolu_*.json。

**Provider 启用 4 重 gate**（按顺序，全过才注入 lsp_* 到 agent 工具列表）：
1. `opts.lsp!.isUserEnabled?.() ?? false` —— Beta toggle，**默认 false / fail-closed**
2. `!process.env.LIZI_LSP_DISABLED` —— dev / benchmark 一票否决
3. `Boolean(ctx.workingDir)` —— 空 workdir（Codex 全局 ctx）直接关
4. `detectTypeScriptProject(ctx.workingDir)` —— 非 TS 项目关

Desktop host 注入路径：`apps/desktop/src/main/maker-host/index.ts` → 全局单 `LspServerPool` → `apps/desktop/src/main/mcp-integrations/mcp-providers.ts` 把 `readLspModeSettings().enabled` 喂给 `isUserEnabled`。

## 模块边界

- 本包是纯工具注册层，不持有业务状态，不直接操作 DB——数据查询通过注入的 service/repo 调用。
- 与 render / main 解耦：main 通过初始化配置将 service 注入，package 内部不感知 Electron。
- 响应格式优化（去重、omit null）在本层做，调用方（LLM agent）按文档解析。

## 不要做的事

- 不要在 message 行里重新带 `sessionWorkingDir / sessionAgentKind / sessionTitle`——session 元数据已提升到顶层 `sessions` map，重复会浪费 token。
- 不要把 `toolUseId / agentMeta / rewindAt / orcaRole / parentSessionId / userSendAt` 写成固定字段输出 null——统一 omit-when-null。
- 不要在本包内 `console.log`，走项目统一 logger。
- 不要为"将来可能需要"的字段提前扩展响应结构；以实际业务需要为准。
- **image_edit 工具**：不要因为"任务复杂/质量要求高"就自动从 `gpt-image-2` 切到 Google 系——只有用户显式触发关键词才切；切入 Google 系后才在 pro / flash 间根据任务性质选择。
- **docx 表格工具**：读取 table_cell 内容时，不要跳过 `docx_list_block_children` 直接改 table_cell 容器——应先拿子块 block_id，再操作内部文本块。新 Feishu Open API 工具直接用 `callOpenApi`，不要再用 `callSheetV2`（后者仅保留向后兼容，只支持 GET/PUT/POST）。
- **Mivo auth-failure recovery**：
  - 不要在 `fireAuthFailure` 内部 await `onApiKeyAuthFailure`——当前 tool call 已经失败，等 host 刷新会不必要延长工具感知延迟。
  - 不要在 package 内部做 debounce/throttle——限流责任在 host，host 须防止大量失败调用变成大量 server 刷新。
  - 不要把非 auth 错误（schema 错误、网络超时等）误判为 auth 失败——`containsAuthFailureSignal` 只匹配确定的 mivo auth 错误签名，不要往 `AUTH_FAILURE_PATTERNS` 里加通用错误词。
- **LSP 子模块**：
  - 不要往 `_shared.ts` 加 JSON-pretty 输出 helper —— v1/v2 走过这条死路（agent 看不进去）；新增工具一律 text + 100KB cap。
  - 不要在工具 description 里写「prefer this over grep」之类的引导 —— 实测无用，且偏离 Anthropic 官方做法。
  - 不要在 providers.ts 把 LSP gate 默认 fallback 成 `true` —— 默认 false 是用户契约（Beta opt-in）。
  - 不要往 LSP gate 4 重判定里塞业务 flag —— 任何新条件先改 `register.ts:bootstrapSession` 的镜像计算一起加，否则 indicator 跟实际能力会漂移。
  - 不要给 `lsp_*` 工具加 `shouldDefer: true`（这是官方 plugin 的策略，但官方靠 UI 弹窗推荐补回 discoverability，我们 provider 是 always-inject，deferred 会让 agent 看不到）。
  - 不要为多语言（Python / Go / C# 等）现在去抽 launcher 抽象 —— Phase 1 锁定 TS only，Phase 2 加第二种语言时再抽。
  - 不要给 LSP 加 session 级别的 footer indicator（类似 `usedProjectContext` 的 Brain icon）。LSP 只是工具列表多 6 个项,**不改 system prompt**;而 `usedProjectContext` 的 Brain icon 表达的是「这个 session 注入了项目知识库 prompt」,语义不同。2026-05-26 实验过一版（commit `9cada418` 引入,同日 revert）后明确：tool-level capability 的开关已经在 admin 设置里有控制项,不需要再在每个 session 里复读。

## 演进备忘

- 2026-05-24：`get_chat_history` 响应结构重构——session 元数据提升为顶层 `sessions` map 去重；`toolUseId / agentMeta / rewindAt` 改为 omit-when-null；`list_sessions` 的 `orcaRole / parentSessionId / userSendAt` 同样改为 omit-when-null；两个工具的 DESCRIPTION 同步更新以准确描述新结构。整体减少 60–80% token 输出。

- **2026-05-25：Phase 1 LSP 落地**（commits `3bacbdc1` → `9cada418`，5 个 feat + 1 个 fix + 1 个 revert）

  **为什么自建 vs 用 Anthropic 官方 typescript-lsp plugin**：
  - 初判：Windows `.cmd` shim spawn 失败 + `settings.json` 拒 `lspServers` override + 只服务 Claude Code 不服务 Codex
  - 实查打脸：Anthropic 在 Claude Code **v2.1.132 修了 Windows**（bundle 了 cross-spawn）—— 我之前编造的"6 个月没修"是错的。`@anthropic-ai/claude-agent-sdk@0.2.112` 已带这个 fix
  - **真正留下来的自建理由**：XDMaker 是自家产品，希望零配置（不要每用户 `/plugin install` + 自己装 ts-language-server）；per-workdir pool 接 maker shutdown 钩子；Phase 2 多语言节奏由我们定。`30% 真增量 / 70% 重新实现 Anthropic 已有设计`
  - **决策**：保留自建，但 v3 把 Anthropic 的好设计（text 输出、10MB 文件 cap、100KB 输出 cap、gitignore filter、`Md8/SGK/IGK` 格式函数族）全部 mirror 过来

  **Codex 暂不支持**：标准 MCP `tools/call` 不携带 caller thread_id，Codex 又用共享 app-server 子进程 N session 多路复用同一个 MCP client；handler 拿不到 per-session workdir。这是**上游协议级限制**（codex-rs），不是 in-house 能解的。Phase 1 选择不做兼容 workaround（providers.ts 通过 `Boolean(ctx.workingDir)` gate 自动把 Codex 全局 ctx 关掉），等上游演进。

  **Agent A/B 量化结论**（详见 `.cindy/benchmarks/agent-ab-report.md` + `agent-ab-noisy-report.md`）：

  | 任务噪音度 | 工具调用 | 成本 | 谁赢 |
  |---|---|---|---|
  | 低（独特符号名 BaseAgent 等） | LSP 31 / baseline 15 | LSP $0.91 / baseline $0.83 | baseline +10% |
  | 高（通用名 Session 等） | LSP 10 / baseline 79 | LSP $0.78 / baseline $1.12 | **LSP +30%** |
  | 综合 20 任务 | LSP 41 / baseline 94 | LSP $1.69 / baseline $1.95 | **LSP +13%** |

  - 关键发现：**LSP 价值随符号噪音度单调上升**。低噪音独特符号（grep 一发就准）下 LSP 反而拖累；高噪音通用名（Session 在 XDMaker 里 438 hits / 156 文件 / 64% 注释字符串噪音）下 LSP 大胜，agent 不用烧几十次 Read 去过滤。
  - 推论：**codebase 越大、符号噪音越高，LSP 价值越大**。XDMaker 现在 ~100k LOC 已经勉强进入"LSP 净正向"区间，半年后 200k+ 价值会更显著。
  - Agent 实际只在 3/10 任务里用了 LSP（`lsp_hover` 最常被选，`lsp_outline` 偶尔，refs / call-hierarchy 几乎不主动选）—— 这是 Claude 内在工具选择偏好，跟 LSP 集成质量无关；Anthropic 官方 plugin 把 LSP 设为 `shouldDefer:true`（默认不在工具列表，agent 要 search 才发现），命中率应该更低。

  **关键技术细节（踩过的坑）**：
  - `relativeFilePath` 必须 `decodeURIComponent` 后再剥 leading `/` —— Windows URI `file:///d%3A/foo` 跳过 decode 会被识别失败留下 `/d:/foo` 绝对路径（fix `5dcc7df9`）
  - tsserver 的 `workspace/symbol` 和 `findReferences` 只看已 `didOpen` 文档构成的 project graph —— bench 里需要 pre-open 8 个文件才能拿到完整跨包 refs，冷启动单文件 case 直接返空
  - `LspServerPool.shutdown` 必须在 `.then(proc => ...)` 里加 `shuttingDown` guard，否则在途 spawn 完成的 proc 会泄漏回已 drained 的 pool
  - `lsp_incoming_calls` 是 LSP `prepareCallHierarchy` + `incomingCalls` 两步内联，单工具调用完成；但实测延迟 ~7s（比单查 references 慢 10×），可观察项

  **关键 commits**：
  - `3bacbdc1`：v2 per-file 工具面（v1 用 symbol-name resolution，tsserver 4+ didOpen 会崩，revert 重做）
  - `b6ce42b3`：v3 Anthropic-aligned text 输出 + 10MB cap（v2 输出 78KB 被 Claude Code 卸载，agent 退化到 grep）
  - `5dcc7df9`：Windows URI relative-path bug fix
  - `3cdea6ef`：`LIZI_LSP_DISABLED` env var（dev / bench 用）
  - `b5cea643`：admin-only Beta toggle + 文件持久（`<userData>/lsp-mode-settings.json`，默认 false）
  - `9cada418`：session.usedLsp 持久化 + CCAgentSessionView footer Braces icon

  **演进 backlog**：
  - 半年后 codebase 翻倍时复跑 `bench-agent-noisy.ts`，验证「越大越值」假设
  - Phase 2 多语言（pyright 是 npm install，跟 ts-language-server 同套 launcher 最简单；rust-analyzer / gopls 需要二进制分发）
  - Codex 解封后接入（等 codex-rs 给 MCP `tools/call` 加 thread_id `_meta` 转发）
  - 半年后复查 Anthropic 官方 plugin 是否补了 `lspServers` user-settings override + 多语言 plugin 生态，决定是否切官方

- 2026-05-26：`image_edit` 工具新增 `gemini-3-pro-image-preview` 模型选项；切入 Google 系后按任务性质二选一（pro = 最终稿/高细节，flash = 草稿/求快）；`XdproxyImageEditParams.model` 类型收口为 `XdproxyImageModel` 统一管理。

- 2026-05-27：新增 `docx_list_block_children` 工具，读取飞书 Docx 块直接子块，支持表格结构导航（table → table_cell → 文本块）；内部将 `callSheetV2` 重构为 `callOpenApi` 薄包装，`callOpenApi` 新增 `PATCH / DELETE` method 支持，新 Feishu docx 工具直接调 `callOpenApi`。

- 2026-05-27：mivo MCP server 新增 reactive auth-failure recovery——无 client 或工具返回 auth 错误签名时 fire-and-forget 调用 `MivoMcpDeps.onApiKeyAuthFailure`，触发 host 从中心服务器同步最新 key；当前 call 仍暴露错误给 agent，下次调用自动拾取新 key；限流由 host 负责。

- 2026-05-27：`feishu/client.ts` `safeCall` 改善错误诊断——lark SDK 对非 2xx 抛 axios 错误时，将 `err.response.data` 追加到 error log（`body=...`）并附入返回值 `data.response` 字段，避免所有 4xx 折叠为无意义的"Request failed with status code 400"，方便排查权限/scope/payload 问题。
