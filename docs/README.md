# Docs 规范索引

本索引用于发现 `docs/` 下仍保留的运维、合规与开发规则文档。Orca 文档是当前权威开发契约；配置设计原则见 `AGENTS.md` 规则 20。

**状态含义**：`authoritative` = 权威、对治理模块有约束力；`参考` = 设计 / 记录 / spike，非约束、仅供背景参考（不区分是否完成，要看正文）。

| 文档 | 类型 | 状态 | 治理/相关代码 | owner |
|---|---|---|---|---|
| [README.md](./README.md) | 索引 | — | `docs/` 文档目录 | — |
| [desktop-release-cn-global.md](./desktop-release-cn-global.md) | 操作手册/规范 | 参考 | Desktop cn/global 双渠道发布指令矩阵、`apps/desktop/scripts/release-*` `promote-canary-*`、`scripts/shared/oss.mjs` 区域化发布目标 | — |
| [orca-team-architecture.md](./dev-rules/orca-team-architecture.md) | 契约/规范 | authoritative | `apps/desktop` 的 `maker-ipc/orca*` 服务 + `mcp-integrations` codex MCP、`packages/lizi-mcps` 的 `orca`、`packages/orca-workflow`、`packages/maker-core` 的 codex MCP context | yuhaobo(fmfsaisai) |
| [legal/README.md](./legal/README.md) | 法律/合规索引 | authoritative | 法律合规资料归档边界与固定路径例外 | — |
| [legal/wechat-open-sdk-compliance.md](./legal/wechat-open-sdk-compliance.md) | 合规记录 | restricted-review-required | Mobile 微信 Open SDK 版本、隐私披露和发布前签核 | — |
| [legal/notices/README.md](./legal/notices/README.md) | 第三方许可/SBOM | generated | `pnpm licenses:generate`、Desktop/Mobile 随包声明 | — |
