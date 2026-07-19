# Docs 规范索引

本索引用于发现 `docs/` 下的规范、设计与记录文档。`configuration-design-principles.md` 与 `orca-team-architecture.md` 是当前权威契约文档，对各自治理范围有约束力（见 `CLAUDE.md` 规则 20/22）；其余文档默认仅供参考。

**状态含义**：`authoritative` = 权威、对治理模块有约束力；`superseded` = 已被其他文档取代、不再生效；`参考` = 设计 / 记录 / spike，非约束、仅供背景参考（不区分是否完成，要看正文）。

| 文档 | 类型 | 状态 | 治理/相关代码 | owner |
|---|---|---|---|---|
| [README.md](./README.md) | 索引 | — | `docs/` 文档目录 | — |
| [Cindy架构设计/](./Cindy架构设计/) | 设计目录 | 参考(设计中) | Cindy 插件化(意识化)整体设计;子目录 [意识系统](./Cindy架构设计/意识系统/) 含主界面布局树重构、面板协议、意识清单等 | Lizi |
| [android-adb-automation-plan.md](./android-adb-automation-plan.md) | 设计 spike | 参考 | Android ADB 自动操作计划、`packages/lizi-mcps` providers、`apps/desktop/src/main/mcp-integrations`、Settings 自动操作 | — |
| [branding-rename-checklist.md](./branding-rename-checklist.md) | 契约/清单 | authoritative | 品牌展示名单一事实源 `packages/maker-shared/src/branding.ts`、`{{appName}}` i18n 插值、改名手动清单与"不得跟随改名"的标识符边界 | — |
| [builtin-tools-system.md](./builtin-tools-system.md) | 设计 spike | 参考 | `apps/desktop` builtin MCP 开关、`packages/lizi-mcps` providers、Settings connections UI | — |
| [codex-system-prompt-persistence.md](./codex-system-prompt-persistence.md) | 设计 spike | 参考 | `packages/maker-core` Codex developerInstructions、`apps/desktop/src/main/maker-host/codex-proxy-host.ts`、`packages/anthropic-compat-proxy` | — |
| [configuration-design-principles.md](./configuration-design-principles.md) | 契约/规范 | authoritative | 全项目用户可配置项、Settings UI、高级设置、隐藏配置、默认值与用户 override 模型 | Lizi |
| [desktop-release-cn-global.md](./desktop-release-cn-global.md) | 操作手册/规范 | 参考 | Desktop cn/global 双渠道发布指令矩阵、`apps/desktop/scripts/release-*` `promote-canary-*`、`scripts/shared/oss.mjs` 区域化发布目标 | — |
| [desktop-db-subprocess-callsites.md](./desktop-db-subprocess-callsites.md) | 历史/记录 | 参考 | Desktop localDb 调用点审计、`apps/desktop/src/main/localDb/**`、main 进程 DB callsites | — |
| [desktop-db-subprocess-mr0-spike.md](./desktop-db-subprocess-mr0-spike.md) | 设计 spike | 参考 | Desktop DB worker thread spike、`apps/desktop/src/main/localDb/client/**`、`apps/desktop/src/main/localDb/worker/**` | — |
| [desktop-db-subprocess-mr1-cut.md](./desktop-db-subprocess-mr1-cut.md) | 设计 spike | 参考 | Desktop DB worker thread MR1 切片、DbClient/transport skeleton | — |
| [desktop-db-subprocess-mr2.2-cut.md](./desktop-db-subprocess-mr2.2-cut.md) | 设计 spike | 参考 | Desktop DB callsite 迁移、DbClient rollback flag、main 进程持久化调用点 | — |
| [desktop-db-subprocess-tx-migration.md](./desktop-db-subprocess-tx-migration.md) | 设计 spike | 参考 | Desktop DB transaction RPC 搬迁、localDb worker named tx、embedding DB writes | — |
| [desktop-db-subprocess.md](./desktop-db-subprocess.md) | 设计 spike | 参考 | Desktop DB worker thread 主方案、`apps/desktop/src/main/localDb/**`、better-sqlite3/Drizzle 持久化边界 | — |
| [dogfooding-workflow.md](./dogfooding-workflow.md) | 工作流指南 | 参考 | 用 XDMaker 开发 XDMaker 的多 worktree 工作流、`scripts/restart-desktop-*`、`apps/desktop/src/main/worktree/**`、dev 实例拓扑与差距 backlog | xdanger |
| [feature-cross-profile-history-reader.md](./feature-cross-profile-history-reader.md) | 设计 spike | 参考 | `packages/lizi-mcps` xdt-helper history tools、desktop localDb readonly history reader | — |
| [feature-orca-worker-service-unification.md](./feature-orca-worker-service-unification.md) | 历史/记录 | superseded | 被 [orca-team-architecture.md](./orca-team-architecture.md) 吸收 | — |
| [feature-slack-bot.md](./feature-slack-bot.md) | 契约/规范 | 参考 | Slack Bot shared app、`apps/desktop/src/main/im/**`、`packages/lizi-im`、`apps/server/src/services/slack*`、`packages/lizi-mcps` slack bot provider | — |
| [feature-worker-idle-autoarchive.md](./feature-worker-idle-autoarchive.md) | 历史/记录 | superseded | 被 [orca-team-architecture.md](./orca-team-architecture.md) 吸收 | — |
| [font-settings.md](./font-settings.md) | 设计/记录 | 参考 | `apps/desktop` renderer 字体、代码字号、系统字体枚举与设置页入口 | — |
| [help-assistant-redesign.md](./help-assistant-redesign.md) | 历史/记录 | 参考 | Help Assistant AI thread redesign、`apps/desktop` help main/renderer/preload | — |
| [linux-desktop-release-plan.md](./linux-desktop-release-plan.md) | 设计/计划 | 参考 | Linux desktop release、`apps/desktop` packaging/release、runtime native assets、updater、voice input | — |
| [orca-team-architecture.md](./orca-team-architecture.md) | 契约/规范 | authoritative | `apps/desktop` 的 `maker-ipc/orca*` 服务 + `mcp-integrations` codex MCP、`packages/lizi-mcps` 的 `orca`、`packages/orca-workflow`、`packages/maker-core` 的 codex MCP context | yuhaobo(fmfsaisai) |
| [review-panel-git-architecture.md](./review-panel-git-architecture.md) | 架构/规范 | 参考 | `apps/desktop` 审查面板 git-review main 服务与 renderer review 插件 | Lizi 团队 |
| [send-to-session-call-tool-migration.md](./send-to-session-call-tool-migration.md) | 迁移指引/记录 | 参考 | `packages/lizi-mcps` xdt-helper `send_to_session` → `handoff` 类目/`call_tool`、`maker-github-issue` skill 调用方迁移 | — |
| [subscription-bridge.md](./subscription-bridge.md) | 接入指南/设计 | 参考 | `packages/anthropic-responses-bridge`、`apps/desktop` maker-host bridge/grok-oauth、`shared/subscriptionModels` 计费订阅 gate | zqchris |
| [session-workspace-kind.md](./session-workspace-kind.md) | 契约/规范 | 参考 | `sessions.workspace_kind`、Codex/Claude import、sidebar Projects grouping、local DB migration | — |
| [voice-input-asr-benchmark.md](./voice-input-asr-benchmark.md) | 历史/记录 | 参考 | Voice input ASR/refine benchmark script、`packages/voice-input-core` provider evaluation | — |
| [worktree-lifecycle.md](./worktree-lifecycle.md) | 设计 spike | 参考 | Worktree lifecycle、`apps/desktop` worktree pool/store/session resume、scheduler worktrees | — |
