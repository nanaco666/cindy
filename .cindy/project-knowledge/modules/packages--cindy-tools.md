---
id: packages--cindy-tools
type: module
covers:
  - packages/cindy-tools/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-16T03:53:39.022Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# packages--cindy-tools

## 是什么

`cindy-tools` 是 Cindy 意识系统的新工具集合，当前提供名为 `cindy` 的进程内 MCP server：让 agent 查询、调用已唤醒意识，并获取意识编写手册、校验打包 `.cindy`。host 注入实际的意识注册表、权限过户、打包与日志能力；本包只负责稳定工具契约和结果整形。

## 关键抽象 / 核心代码地标

- `src/ghost/mcpServer.ts`：`createCindyGhostsMcpServer` 注册 `ghost_list`、`ghost_call`、`ghost_forge_guide`、`ghost_forge_pack` 四个工具。
- `handleGhostCall`：把附件、目录、保存目录和批量预授权参数交给 host，并把可信媒体字段提升到工具结果顶层供聊天气泡渲染。
- `formatGhostRoster`：把会话建立时的意识花名册压缩进工具描述，限制数量和长度以保持缓存前缀稳定。
- `extractAgentToolUseId`：best-effort 读取 Claude tool_use id，供意识卡片配对；拿不到时不影响正确性。
- `src/types.ts`：定义 host 依赖、意识信息、调用结果和结构化错误码。

## 模块边界

- package 不读取 Electron、数据库或意识文件，所有副作用都由 `CindyGhostsMcpDeps` 注入。
- desktop main 在组装 agent MCP provider 时创建 server；意识执行、路径确认、文件过户和安装确认仍由 host 守门。
- `lizi-mcps` 是待迁移的老工具集合；新增 Cindy 意识工具默认进入本包。

## 不要做的事

- 不要在本包绕过 host 直接读用户文件或媒体字节；附件、`dir`、`save_dir` 必须走票据与确认流程。
- 不要把第三方意识返回的任意对象直接提升到顶层，只允许代码里的媒体/卡片白名单字段并做类型净化。
- 不要让动态花名册无限增长或每轮变化；工具描述属于 prompt cache 稳定前缀。
- 打包成功不等于安装成功，安装必须继续由 desktop 的用户确认弹窗决定。

## 演进备忘

_仅追加。每次重大改动留一行：日期 - 做了什么 - 原因。_

- 2026-07-16 - 随 Cindy 客户端拆仓建立模块索引；意识工具继续由 desktop host 注入和守门。
