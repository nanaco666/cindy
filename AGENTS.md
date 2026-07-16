# Cindy 客户端仓 Agent 规则

本仓只负责 desktop、mobile 及其共享 packages。服务端位于独立的 `cindy-server`
仓库；除非用户明确要求，不要跨仓修改服务端。

## 工作流

- 默认直接在当前分支工作，不主动开分支。
- 先保留用户已有改动，禁止用破坏性 Git 命令覆盖工作区。
- 功能完成后跑与风险匹配的验证，提交前对整体 diff review 一次。
- 验证和 review 通过后创建本地 commit，把结果与 commit 信息交给用户确认；只有用户
  明确确认后才能 push。
- Node.js 使用 22，pnpm 使用 10。首次安装或遇到依赖问题时先检查版本。

## 桌面端启动

Agent 只允许使用以下两个入口：

- 默认远程 API：`pnpm restart:desktop:remote`
- 只有用户明确要求连接本地服务端时：`pnpm restart:desktop:local`

不要直接运行 `dev:desktop`、`dev:desktop:remote` 或 Electron Forge 底层命令。
普通 dev 必须沿用 `xdt-maker` userData 以读取历史数据；用户未明确要求隔离时，不加
`--isolated`，不设置 `XDT_USER_DATA_DIR`。

## SQLite migration

- `apps/desktop/drizzle` 的历史 migration、meta 与 scripts 是用户数据库升级链，禁止
  squash、改名、改内容或删除。
- 从旧仓迁入的 SQL 由 `drizzle/migration-baseline.json` 固定 SHA256；数据库变化只能
  追加新 migration，并运行 `pnpm --filter desktop db:validate` 与 migration replay。
- 本地数据库查询必须使用异步 API；不要对异步 DB client 使用同步 `.all()`。

## 架构与实现

- renderer 只负责界面；业务、网络和存储放 main，通过 IPC 连接。
- 可复用能力放 `packages/*`，不要让 package 直接依赖 Electron renderer/main。
- agent 编排功能放 `packages/maker-core`。修改 prompt、tool 暴露、translator、事件热路径、
  model 映射或 token 计量时，必须评估缓存率、性能、响应速度和内容准确性。
- 不得擅自修改随会话下发的 system prompt；需要先和 Lizi 明确确认。
- main 进程禁止运行时动态 `import()`；依赖使用顶层静态 import。
- main IPC 错误使用 `throwIpcError`；修改 main 业务逻辑默认同步补测试。
- 日志走统一 logger，不使用 `console.log`。
- 新增媒体落盘必须使用 `apps/desktop/src/main/cindy-media` 的 blobStore、ledger 与
  `cindy-media://` 协议，不新建业务专用媒体缓存。

## UI 与跨平台

- 修改 UI 前先读根目录 `DESIGN.md`，颜色与样式使用现有设计 token。
- 数据异步加载期间保持原界面，避免空白帧和视觉跳变。
- 常驻简单动画只用外层 HTML 元素的 `transform` / `opacity`。
- 所有桌面改动同时考虑 Windows 与 macOS：路径用 `path` API，原生二进制按平台和
  架构选择，进程终止、文件锁、快捷键和系统集成都要分别处理。

## 协议 submodule

- `cindy-protocol` 是协议权威来源。desktop 使用 `@cindy/slack-hook-protocol`，客户端
  device-link 包复用 `@cindy/device-link-protocol` 的 relay 层定义。
- 客户端重连、IPC allowlist 与隧道 payload 留在 `packages/device-link`。
- 升级 submodule 指针前必须确认 `cindy-server` 同步升级，避免两端 wire protocol 漂移。

## Mobile

手机版完整开发、测试和发版规则以 `apps/mobile/docs/dev-and-release-workflow.md`、
`apps/mobile/docs/simulator-debugging.md` 与 `apps/mobile/RELEASING.md` 为准。
不要绕过仓库脚本直接拼 EAS 写操作命令。
