# Docs 规范索引

本索引用于发现 `docs/` 下仍保留的产品规则、设计规则、开发规则、运维与合规文档。

**状态含义**：`authoritative` = 权威、对治理模块有约束力；`参考` = 设计 / 记录 / spike，非约束、仅供背景参考（不区分是否完成，要看正文）。

| 文档 | 类型 | 状态 | 治理/相关代码 | owner |
|---|---|---|---|---|
| [README.md](./README.md) | 索引 | — | `docs/` 文档目录 | — |
| [product-rules/README.md](./product-rules/README.md) | 产品规则索引 | authoritative | Cindy 产品行为、体验与边界 | — |
| [core-product-principles.md](./product-rules/core-product-principles.md) | 产品原则 | authoritative | Cindy Core、Agent、Skill、插件与多端产品边界 | — |
| [design-rules/README.md](./design-rules/README.md) | 设计规则索引 | authoritative | Cindy UI 视觉、交互与内容设计 | — |
| [DESIGN.md](../DESIGN.md) | 设计规范 | authoritative | Desktop 与 Mobile 的视觉语言、Token、组件和交互约定 | — |
| [dev-rules/README.md](./dev-rules/README.md) | 开发规则索引 | authoritative | Cindy 客户端工程规则 | — |
| [environment-setup.md](./dev-rules/environment-setup.md) | 开发环境 | authoritative | 公共依赖、submodule 与首次安装 | — |
| [desktop-development.md](./dev-rules/desktop-development.md) | Desktop 开发规则 | authoritative | Desktop 启动、重启与验证 | — |
| [electron-security-and-process-boundaries.md](./dev-rules/electron-security-and-process-boundaries.md) | Electron 安全规则 | authoritative | Renderer、preload、BrowserWindow、WebView、IPC、CSP 与进程边界 | — |
| [credentials-and-local-storage.md](./dev-rules/credentials-and-local-storage.md) | 本地数据安全规则 | authoritative | 凭证、用户持久数据、临时文件与测试目录 | — |
| [media-storage-and-protocols.md](./dev-rules/media-storage-and-protocols.md) | 媒体存储规则 | authoritative | Desktop 媒体入库、协议、引用与回收 | — |
| [database-and-migrations.md](./dev-rules/database-and-migrations.md) | 数据库规则 | authoritative | Desktop SQLite schema、migration、companion 与运行期访问 | — |
| [mobile-development.md](./dev-rules/mobile-development.md) | Mobile 开发规则 | authoritative | Mobile 模拟器、验证与专项入口 | — |
| [orca-team-architecture.md](./dev-rules/orca-team-architecture.md) | 契约/规范 | authoritative | `apps/desktop` 的 `maker-ipc/orca*` 服务 + `mcp-integrations` codex MCP、`packages/lizi-mcps` 的 `orca`、`packages/orca-workflow`、`packages/maker-core` 的 codex MCP context | yuhaobo(fmfsaisai) |
| [maker-core-and-agent-behavior.md](./dev-rules/maker-core-and-agent-behavior.md) | maker-core 规则 | authoritative | `packages/maker-core` 的 Agent 编排、prompt 组装、translator、model 映射、缓存率/性能/准确性指标与 system prompt 门禁 | Lizi |
| [legal/README.md](./legal/README.md) | 法律/合规索引 | authoritative | 法律合规资料归档边界与固定路径例外 | — |
| [legal/wechat-open-sdk-compliance.md](./legal/wechat-open-sdk-compliance.md) | 合规记录 | restricted-review-required | Mobile 微信 Open SDK 版本、隐私披露和发布前签核 | — |
| [legal/notices/README.md](./legal/notices/README.md) | 第三方许可/SBOM | generated | `pnpm licenses:generate`、Desktop/Mobile 随包声明 | — |
