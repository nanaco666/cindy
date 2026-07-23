# Desktop 开发、启动与验证

> **读取时机**：安装、启动、重启、调试或验证 `apps/desktop` 及其共享 packages 时

本文是 Desktop 开发命令及其使用条件的权威说明；可执行脚本以当前 checkout 的根
`package.json` 与 `apps/desktop/package.json` 为代码事实源。

## Agent 启动入口

Agent 启动 Desktop 只使用仓库根的安全包装命令，并显式选择目标区域：

```bash
pnpm restart:desktop:remote --region=cn
pnpm restart:desktop:remote --region=global
```

只有用户明确要求连接其已经准备好的本地 server 时，才使用：

```bash
pnpm restart:desktop:local
```

这与登录页中免 Cindy 账号的“本地模式”不是同一个概念。Agent 不负责启动相邻服务端
仓库，也不得自行改用 `pnpm dev:desktop`、`pnpm dev:desktop:remote` 或
`pnpm dev:server` 绕过包装脚本。

启动包装可能停止已有 Desktop dev 进程。必须尊重宿主提供的并行或保活工作流；如果
脚本因为当前 Agent 运行在 Cindy 内部而拒绝重启，不要换命令绕过，应把提示交给用户。

## 何时需要重启

- 修改 main、preload、MCP、原生依赖或 package 运行时代码后需要重启。
- 只修改 renderer 时优先使用现有实例的热更新，不重复重启。
- 不确定运行实例来自哪个 checkout 时，先运行 `pnpm desktop:whoami -- --all` 核对。

## 分层验证

根据实际改动选择最小但充分的检查：

```bash
pnpm --filter desktop typecheck
pnpm --filter desktop lint
pnpm --filter desktop exec vitest run <测试文件路径>
pnpm --filter desktop test
pnpm build
pnpm test:unit
```

- 改 TypeScript 至少运行相关类型检查和定向测试。
- 跨模块、共享 package、构建链或广泛重构再扩大到 Desktop 全量测试、构建或根级单测。
- 数据库 migration、协议、更新器、权限与用户数据另有高风险专项规则；命中时先读取
  对应规则，不以本页命令替代专项验证。
- 记录实际执行和结果；未执行的高相关检查必须说明原因。
