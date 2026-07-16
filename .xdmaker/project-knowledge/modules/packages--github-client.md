---
id: packages--github-client
type: module
covers:
  - packages/github-client/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-06T05:34:51.175Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# packages--github-client

## 是什么

零依赖的 GitHub REST API v3（+ 部分 GraphQL）客户端（`@lizi/github-client`），封装仓库级 Issue / PR / Label / Branch / Actions / Release / Git Data 等操作，仅使用全局 `fetch`（Node 18+ / Electron 28+），供 desktop main / lizi-mcps 进程直接调用。认证方式为 `Authorization: Bearer <token>` header（Personal Access Token，classic 或 fine-grained）。默认目标 GitHub 实例为 `https://api.github.com`，可通过 `baseUrl` 改为 GHE 自建实例（如 `https://<host>/api/v3`）。已从"迁移后的最小骨架"成长为覆盖面很广的全功能客户端（`src/client.ts` 近 1800 行），远超旧版仅 Issue/PR/Label 的范围。

## 关键抽象 / 核心代码地标

- **`GithubClient`** (`src/client.ts`) — 唯一的运行时类。构造时接收 `GithubClientConfig = { baseUrl?, token, owner?, repo? }`。`owner`/`repo` 现在是**可选**的：user-scope / search / cross-repo 调用（`getCurrentUser`、`searchRepos`、`listUserOrgs`、`getUser` 等）可以不传;仓库级方法通过 `private requireRepo()` 在缺失时 fail-fast 抛 `Error`，而非静默产出错误 URL。
- **`private request<T>()`** — 统一处理 GET/POST/PUT/PATCH/DELETE 和错误转换，自动带 `Accept: application/vnd.github+json` + `X-GitHub-Api-Version: 2022-11-28`。对 204/205 及 `Content-Length: 0` / 空 body 短路返回 `undefined`，不去 `JSON.parse` 空字符串（GitHub 在 201/202/205 等多种成功状态码上也可能返回空体，硬解析会误报失败）。
- **GraphQL 支路**：`graphql<T>()` 方法 + 构造时预算好的 `graphqlUrl`（github.com 上是 `${baseUrl}/graphql`；GHE 上把 baseUrl 末尾 `/api/v3` 换成 `/api` 再拼 `/graphql`，因为 REST 和 GraphQL 前缀不同，**不能**复用 `request()`）。用于 REST 缺口场景：review thread 的 `isResolved`/`isOutdated` 状态（`listPullRequestReviewThreads`）、`resolveReviewThread` / `unresolveReviewThread`、pending review 追加 inline comment（`addPendingPullRequestReviewComment`，通过 `addPullRequestReviewThread` mutation，**不能**复用 `POST /pulls/{n}/comments`——那个端点会立即发布独立评论而不是挂到 pending review）。
- **`GithubApiError`** (`src/types.ts`) — 所有非 2xx 响应及 GraphQL `errors` 非空时统一抛出，携带 `status` 和原始 `body`。`ensureLabels` 显式吞掉 422（label 已存在）；`listPullRequestReviewThreads` 对 GraphQL 返回 `pullRequest: null`（无效 PR 号）主动包装成 `GithubApiError(404)`，让上层统一走 404→NOT_FOUND 映射而不是裸 TypeError。
- **覆盖范围（按 client.ts 内分区注释）**：Issues（含 assignees/labels 增删、sub-issues）、Pull Requests（含 pending review 全流程：create → 追加 inline comment（GraphQL）→ submit/dismiss、requested reviewers、`requestCopilotReview` 封装 `copilot-pull-request-reviewer[bot]` magic name、`updatePullRequestBranch`）、Labels、Repository（topics/languages/contributors/forks/collaborators/hooks/branch protection）、Commits/Compare、Events（user/org/repo 四种视角，注意 `listAuthenticatedUserOrgEvents` 与 `listOrgEvents` 的数据源差异：前者含私有 repo 活动）、Search（repos/issues+PRs/commits/code/users）、Users/Orgs/Teams/Gists、Actions（workflows/runs/jobs/artifacts/logs，产物走 `requestRedirectUrl` 手动跟一次 302 拿 Location 而不让 fetch 自动跟——避免把 auth header 带到 S3 签名 URL 上）、Releases（含 assets）、Checks、Deployments、Reactions（issue/comment/review-comment 三种目标）、Git Data 原语（`getRef`/`createRef`/`getTree`/`createTree`/`createCommit`/`updateRef`/`createBlob`）与基于其组合的 `pushFiles`（tree→commit→ref 三步走的原子多文件提交,含 base64/utf-8 两种文件编码分支）。
- **类型定义** (`src/types.ts`) — 每个方法对应的 params/返回类型（`GithubIssue` 用 `number` 而非 GitLab 的 `iid`，`GithubPullRequest` 含 `merged`/`merged_at`/`draft` 供状态展示）。`GithubContent` 是 discriminated union（`GithubFileContent | GithubDirContent[]`）供 `getContents` 区分文件/目录。
- **`src/index.ts`** — barrel re-export，两个 export 路径：`@lizi/github-client`（类 + error + 主要类型）和 `@lizi/github-client/types`（纯类型，`package.json` 的 `exports["./types"]`）。注意 index.ts 的类型导出列表不是 types.ts 全量镶入（例如部分较新增的类型可能未进 barrel，消费方需要时直接从 `./types.js` 导入或补充 index.ts 导出）。

## 模块边界

- **零运行时依赖**，不依赖仓库内其他 workspace 包。
- **被依赖方**：
  - `packages/lizi-mcps/src/github/mcp/tools.ts`（2500+ 行，GitHub MCP 工具集的主要消费方，`new GithubClient({ baseUrl, token, owner, repo })`）及其测试 `src/__tests__/githubReviewThreads.test.ts`。
  - `apps/desktop/src/main/git-context/ipc.ts`（PR 状态查询场景，`fetchUnresolvedCount` 等）。
  - `apps/desktop/package.json` / `packages/lizi-mcps/package.json` 声明依赖。
  - desktop renderer **不直接消费**（符合"main/package 解耦"规则，走 IPC）。
- **对外接口形态**：纯 TypeScript 源码，无编译产物（`main`/`types`/`exports` 都指向 `.ts`），由消费方 bundler 直接处理；`package.json` 的 `build` 脚本仅 `tsc --noEmit` 类型检查，不产出 dist。
- **与 `@lizi/gitlab-client` 关系**：两者接口形状刻意对齐，差异点：`iid` → `number`、URL 路径 `/projects/:id/merge_requests/:iid` → `/repos/:owner/:repo/pulls/:number`、Auth header `PRIVATE-TOKEN` → `Authorization: Bearer`、MR → PR 概念。两包并存以支持用户连接自有 GitLab 实例；GitHub 侧因平台能力更丰富（GraphQL review thread、sub-issues、Copilot review 等）已明显超出 GitLab 客户端的方法数量，不必强行对齐每个新增方法。

## 不要做的事

1. 不要加运行时依赖（零依赖是刻意设计）
2. 不要在包内处理 token 获取 / 存储（由调用方注入）
3. 不要在 renderer 进程直接 import（应走 IPC）
4. 除 `ensureLabels` 的 422 外不要吞掉 `GithubApiError`
5. 分页默认 `per_page=100`（GitHub 单页上限）；GraphQL 分页（`listPullRequestReviewThreads`）默认 `first=50`，需要翻页时用返回的 `pageInfo.endCursor` 作为下次 `after`，不要假设一页能拿全
6. 不要让 `graphql()` 走 `request()` 的 baseUrl 拼接逻辑——REST 与 GraphQL 在 GHE 上路径前缀不同（`/api/v3` vs `/api/graphql`），已在构造时算好 `graphqlUrl`，复用 `request()` 会在 GHE 上 404
7. 不要让 artifact/log 下载类请求（`requestRedirectUrl`）走自动跟随重定向的 `fetch`——302 目标是短时效 S3 签名 URL，带着 GitHub auth header 跟过去会被拒绝；调用方拿到 `Location` 后应自行发起新请求下载
8. `addPendingPullRequestReviewComment` 需要的是 `createPendingPullRequestReview` 响应的 `node_id`（`PRR_...`），不是数字 `id`；不要传数字 id 给它
9. `pushFiles` 的 ref 更新是 `force=false`（仅允许 fast-forward），不要为了"图方便"改成强制覆盖——那会静默丢弃 base 上已有的新 commit
