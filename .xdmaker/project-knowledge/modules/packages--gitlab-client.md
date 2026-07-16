---
id: packages--gitlab-client
type: module
covers:
  - packages/gitlab-client/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-06T04:49:15.781Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# packages--gitlab-client

## 是什么

零依赖的 GitLab REST API v4 客户端（`@lizi/gitlab-client`），源码直发（无编译产物，`exports` 直接指向 `.ts`），封装 GitLab 项目 / 用户 / 全局 scope 的绝大部分常用 API,供 Node/Electron 环境通过全局 `fetch` 调用（Node 18+ / Electron 28+）。认证方式为 `PRIVATE-TOKEN` header（Personal Access Token）。当前唯一消费方是 `packages/lizi-mcps` 的 GitLab MCP 工具集（`gitlab_lizi`），供 agent 会话操作用户通过 desktop connectors 连接的 GitLab 账号。

## 关键抽象 / 核心代码地标

- **`GitlabClient`** (`src/client.ts`) — 唯一运行时类。构造 `{ baseUrl, token, projectPath? }`；`projectPath` 现为**可选**，省略时只能调用 user-scope / 跨项目端点（`getCurrentUser`、`listProjects`、`searchGlobally`、`listMergeRequestsGlobally`、`createProject`、`listGroupProjects` 等）。project-scoped 方法统一经 `private requireProject()` 取 URL-encoded 项目 id，未配置 `projectPath` 时 fail-fast 抛错——新增 project-scoped 方法必须走这个 helper，不要直接拼 `this.projectId`。
- **方法覆盖面**（远超「Issue / MR / Label / Branch」）：Issues（list/get/create/update/comments/labels/links/award emoji）、Merge Requests（create/list/get/update/merge/rebase/commits/changes/discussions/approvals/draft notes/pipelines/related-issues/award emoji）、Labels（list/get/ensure）、Branches（list/get/create/delete）、Commits（list/get/diff）、Compare（`compareRefs`）、Tags（list/get/create/delete）、Events（`listEvents`/`listUserEvents`/`listProjectEvents`）、Search（`searchGlobally`/`searchInProject`）、Projects（list/get/create/fork/star/unstar，含 group projects）、Users（search/getByUsername/getCurrentUser）、Pipelines & Jobs（list/get/retry/cancel/获取 job trace 日志）、Milestones（project + group）、Members（project + group）、Project Hooks、CI/CD Variables、Environments、Deployments、Pipeline Schedules、Repository Files（create/update/delete + `commitMultipleFiles` 单 commit 批量 action）、Repository Archive URL、Group-level Issues/MRs、Wiki Pages、Snippets、Releases、Protected Branches、Issue Links、Award Emoji（issues/MRs/notes 共用）。
- **`private qs()`** (`src/client.ts`) — 查询参数序列化 helper。GitLab 数组参数（`assignee_username[]`、`approved_by_usernames[]` 等）必须序列化为多次 `k[]=v` 而非逗号拼接；key 已带 `[]` 原样 append，否则自动补。
- **`listUserEvents`** — 自动识别非数字 username，先经 `/users?username=` 解析成数字 user id 再拼路径，因为 GitLab 官方 `GET /users/:id/events` 的 `:id` 只接受数字 id。
- **`private request()`** — 统一 HTTP 层。304 视为幂等写操作（如 star 已 star）的成功语义、204/205/`content-length: 0`/空 body 短路为 `undefined`（避免 `JSON.parse('')` 抛 `SyntaxError`），避免上层误报失败。
- **`getRepositoryArchiveUrl`** — 只返回 archive 下载 URL + 占位 header（`'PRIVATE-TOKEN': '***'`），不下载、不把真实 token 塞进返回值；调用方拿到 URL 后自行带上真 token 请求，避免 token 意外流入 log。
- **`ensureLabels`** — 唯一显式吞掉特定错误码（409 = label 已存在）的方法。
- **`GitlabApiError`** (`src/types.ts`) — 所有非 2xx（304/204/205/empty-body 除外）响应统一抛出，携带 `status` 和原始 `body`。
- **类型定义** (`src/types.ts`) — 与方法覆盖面同步扩展的完整参数/返回类型集（`ListIssuesParams`、`ListMergeRequestsParams`、`GitlabMergeRequestChanges`、`GitlabDiscussion`、`GitlabDraftNote`、`CommitActionsParams` 等）。
- **`src/index.ts`** — barrel re-export，两个 export 路径：`@lizi/gitlab-client`（类 + error）和 `@lizi/gitlab-client/types`（纯类型）。

## 模块边界

- **零运行时依赖**（仅 devDependencies: `@types/node`、`typescript`），不依赖仓库内其他 workspace 包。
- **唯一消费方**：`packages/lizi-mcps`。`src/gitlab/mcp/tools.ts` 的 `makeClient(deps, projectPath)` 按次调用现构造 `GitlabClient`（`token`/`baseUrl` 由外部注入的 `GitlabMcpDeps` 提供），封装进约 20 个分类（`issues`/`merge_requests`/`repo`/`meta`/`events`/`commits`/`search`/`projects`/`users`/`pipelines`/`discussions`/`approvals`/`wiki`/`snippets`/`releases`/`environments`/`jobs`/`groups`/`draft_notes`/`reactions`，见 `src/gitlab/mcp/toolRegistry.ts`）的 MCP tool，通过 `src/gitlab/mcp/server.ts` 暴露为 `gitlab_lizi` MCP server。
- **desktop 侧不直接 import 本包**：`apps/desktop/src/main/mcp-integrations/gitlab.ts` 只做 PAT 存取（safeStorage 加密、单账户设计）与 token 校验，校验请求走 Electron `net.fetch` 直连 `/api/v4/user`，不经 `GitlabClient`。`apps/desktop/src/main/mcp-integrations/mcp-providers.ts` 把 `getAccessToken`/`getBaseUrl`/`getDefaultProjectPath` 注入给 `lizi-mcps` 的 `GitlabMcpDeps`，真正的 `GitlabClient` 实例化发生在 `lizi-mcps` 内部。
- **对外接口形态**：纯 TypeScript 源码，无编译产物，由消费方 bundler / tsc 直接处理源文件。

## 不要做的事

1. 不要加运行时依赖（零依赖是刻意设计）
2. 不要在包内处理 token 获取/存储（由调用方经 `GitlabClientConfig.token` 注入；desktop 侧的 PAT 加密存储在 `apps/desktop/src/main/mcp-integrations/gitlab.ts`，不属于本包职责）
3. 不要在 renderer 进程直接 import（应走 IPC → main → lizi-mcps MCP tool）
4. 除 `ensureLabels` 的 409 和 `request()` 里 304/204/205/空 body 的既有短路外，不要吞掉 `GitlabApiError` 或其他非 2xx 状态
5. 不要把"安全过滤"逻辑（如剥离 CI/CD Variable 的 `value` 字段）下沉进本包——client 保持对 GitLab API 响应的如实透传，过滤逻辑属于调用方（当前在 `lizi-mcps` 的 `stripVariableValues`）
6. `getRepositoryArchiveUrl` 不要改成直接下载或把真实 token 写入返回值
7. 新增 project-scoped 方法必须经 `private requireProject()` 取项目 id，不要绕过直接拼 `this.projectId`
8. 少数方法仍硬编码 `per_page=100` 且无 pagination 参数（如 `listLabels`、`listBranches`、`listProjectHooks`、`listProjectVariables`、`listPipelineSchedules`、`listSnippets`、`listProjectProtectedBranches`、`listMergeRequestDiscussions`）——如需分页应补 `per_page`/`page` 参数对齐其余 list 方法的做法，而非改变已有方法签名的默认行为

## 演进备忘

- 初版仅封装 Issue / Label / Branch，MR 只有 `createMergeRequest`。
- pr-review v2 扩展：新增完整 MR 读写方法集（list / get / changes / notes / comment / inline discussion / label / approve / merge），同步扩展 `GitlabMergeRequest` 类型（labels、diff_refs、draft 等字段）并新增 `GitlabMrFileChange` / `GitlabMrChangesResponse` / `GitlabMrPosition` / `ListMergeRequestsParams` 类型，支撑 mr-review runner 的 inline code review 流程。
- mr-review v2 方法集回退：移除 `listMergeRequests` / `getMergeRequest` / `getMergeRequestChanges` / `getMergeRequestNotes` / `addMergeRequestComment` / `addMergeRequestInlineDiscussion` / `updateMergeRequestLabels` / `approveMergeRequest` / `unapproveMergeRequest` / `mergeMergeRequest` 及配套类型（`GitlabMrFileChange`、`GitlabMrChangesResponse`、`GitlabMrPosition`、`ListMergeRequestsParams`），`GitlabMergeRequest` 精简回核心字段；MR 扩展能力改由上层调用方自行实现。
