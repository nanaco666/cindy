# Docs 规范索引

本索引用于发现 `docs/` 下的规范、设计与记录文档。`configuration-design-principles.md` 与 `orca-team-architecture.md` 是当前权威契约文档，对各自治理范围有约束力（见 `CLAUDE.md` 规则 20/22）；其余文档默认仅供参考。

**状态含义**：`authoritative` = 权威、对治理模块有约束力；`参考` = 设计 / 记录 / spike，非约束、仅供背景参考（不区分是否完成，要看正文）。

| 文档 | 类型 | 状态 | 治理/相关代码 | owner |
|---|---|---|---|---|
| [README.md](./README.md) | 索引 | — | `docs/` 文档目录 | — |
| [Cindy架构设计/](./Cindy架构设计/) | 设计目录 | 参考(设计中) | Cindy 插件化(意识化)整体设计;子目录 [意识系统](./Cindy架构设计/意识系统/) 含主界面布局树重构、面板协议、意识清单等 | Lizi |
| [branding-rename-checklist.md](./branding-rename-checklist.md) | 契约/清单 | authoritative | 品牌展示名单一事实源 `packages/maker-shared/src/branding.ts`、`{{appName}}` i18n 插值、改名手动清单与"不得跟随改名"的标识符边界 | — |
| [configuration-design-principles.md](./configuration-design-principles.md) | 契约/规范 | authoritative | 全项目用户可配置项、Settings UI、高级设置、隐藏配置、默认值与用户 override 模型 | Lizi |
| [desktop-release-cn-global.md](./desktop-release-cn-global.md) | 操作手册/规范 | 参考 | Desktop cn/global 双渠道发布指令矩阵、`apps/desktop/scripts/release-*` `promote-canary-*`、`scripts/shared/oss.mjs` 区域化发布目标 | — |
| [dogfooding-workflow.md](./dogfooding-workflow.md) | 工作流指南 | 参考 | 用 XDMaker 开发 XDMaker 的多 worktree 工作流、`scripts/restart-desktop-*`、`apps/desktop/src/main/worktree/**`、dev 实例拓扑与差距 backlog | xdanger |
| [orca-team-architecture.md](./orca-team-architecture.md) | 契约/规范 | authoritative | `apps/desktop` 的 `maker-ipc/orca*` 服务 + `mcp-integrations` codex MCP、`packages/lizi-mcps` 的 `orca`、`packages/orca-workflow`、`packages/maker-core` 的 codex MCP context | yuhaobo(fmfsaisai) |
| [subscription-bridge.md](./subscription-bridge.md) | 接入指南/设计 | 参考 | `packages/anthropic-responses-bridge`、`apps/desktop` maker-host bridge/grok-oauth、`shared/subscriptionModels` 计费订阅 gate | zqchris |
| [worktree-lifecycle.md](./worktree-lifecycle.md) | 设计 spike | 参考 | Worktree lifecycle、`apps/desktop` worktree pool/store/session resume、scheduler worktrees | — |
