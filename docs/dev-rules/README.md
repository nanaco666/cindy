# 开发规则

这里存放 Cindy 客户端仓的工程约束、实现规则、开发流程和验证方法。

## 收录标准

- 规则说明“代码怎样实现、怎样验证或哪些技术操作被禁止”。
- 每条规则应写清触发条件、必须做什么、禁止做什么、验证方法和例外条件。
- 只适用于单个目录或模块的规则，优先放到对应目录的嵌套 `AGENTS.md`；需要跨目录
  复用或需要较长解释的规则放在这里。
- 可以由 lint、测试、类型检查或脚本强制的要求，应同时落实到自动化检查，不能只靠
  Agent 阅读文字。

## 当前文档

- [`environment-setup.md`](environment-setup.md)：公共开发环境、依赖安装与 submodule
  准备。
- [`desktop-development.md`](desktop-development.md)：Desktop 的 Agent 安全启动入口与
  分层验证命令。
- [`electron-security-and-process-boundaries.md`](electron-security-and-process-boundaries.md)：
  Electron 进程职责、Renderer 信任模型、BrowserWindow、preload、IPC 与远程内容安全边界。
- [`database-and-migrations.md`](database-and-migrations.md)：Desktop SQLite schema、
  append-only migration、companion script、隔离运行与异步数据库访问规则。
- [`mobile-development.md`](mobile-development.md)：Mobile 的模拟器开发、分层验证与
  专项文档入口。
- [`orca-team-architecture.md`](orca-team-architecture.md)：Orca 多 Agent 协同架构与运行时约束。

其他旧规则正在从仓库根 `AGENTS-old.md` 逐项盘点迁入。
