---
id: packages--maker-cc-manager
type: module
covers:
  - packages/maker-cc-manager/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-06T06:52:38.315Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# packages--maker-cc-manager

## 是什么

`@lizi/maker-cc-manager`（`packages/maker-cc-manager`）是运行在远程 SSH 机器上的 NDJSON-RPC 守护进程（cc-manager daemon），把 `@anthropic-ai/claude-agent-sdk` 的 `Query` 对象包装成可跨进程/跨网络访问的 session/control RPC 服务，供本地 desktop 客户端通过 SSH exec 通道驱动远端 Claude Code 会话。包内同时导出 daemon 端（`ManagerServer` + `SessionRegistry` + `sdk-handlers`）和 client 端（`RpcClient` + `createRemoteQuery`）两套实现——daemon 侧被 esbuild 打成单文件 `dist/cc-mgr.mjs` 部署到远端主机，client 侧被 desktop 主进程直接 import 使用。支持多 session、detach/reattach（内存 ring buffer 承接同进程生命周期内的断线重连，跨进程重启不保证）。零 Electron 依赖，`package.json` 唯一运行时依赖是 SDK 本身。

## 关键抽象 / 核心代码地标

- `src/protocol.ts` — 协议正本：`PROTOCOL_VERSION`（breaking change 时手动 bump，client/server 握手时严格比对）、`CC_MGR_BUNDLE_VERSION`（daemon 功能版本号，desktop 用它判断远端是否需要 upgrade，不随 SDK patch 变化）、`METHODS`（client→manager，如 `query/start` `query/send` `session/attach` 等）、`NOTIFICATIONS`（manager→client 单向，`query/event` `session/closed` `client/replaced`）、`SERVER_METHODS`（manager→client 反向请求，目前只有 `approval/request`）、各方法的 Params/Result 类型、`RpcErrorCode` 枚举、`isRpcMessage`/`isRpcRequest`/... 类型 guard。
- `src/codec.ts` — `NDJSONDecoder`：把任意分片的字节流切成一行一个 JSON 的 `RpcMessage[]`；用 `StringDecoder` 保证多字节 UTF-8 字符跨 chunk 边界不被截断损坏；有 64MB 硬上限防止无换行流 OOM。`encodeMessage()` 是反向的单行编码。
- `src/client.ts` — `RpcClient`：包在任意 `Duplex`（unix socket / SSH exec 管道）上的 RPC 客户端。`hello()` 握手、`request()`/`notify()`、`subscribe()` 订阅通知、`subscribeClose()` 订阅流关闭（daemon 被杀/网络中断时用来兜底结束 iterator）、`setRequestHandler()` 处理 server→client 反向请求（用于权限 approval）。`dispose()` 只摘监听器、不关闭底层流（流由调用方持有）。
- `src/server.ts` — `ManagerServer`：daemon 侧 TCP/unix-socket/Windows-named-pipe 服务器骨架，只做 `protocol/hello` 内建处理；其余方法通过 `setHandler(method, handler)` 注册（由 `sdk-handlers.ts` 填入）。`sendRequest()` 支持 server→client 反向 RPC（负 ID 避免与 client 请求 ID 冲突），用于权限批准这种需要客户端响应的交互。
- `src/session-registry.ts` — `SessionRegistry`：daemon 内每 session 一个 SDK `Query` 的生命周期管理器。`SdkQueryFactory` 被注入（生产环境注入真实 SDK `query()`，测试注入 mock），保持本文件与具体 SDK 版本解耦。核心状态 `SessionState` 含 `inputQueue`（`query/send` 推入，SDK `streamInput` 消费）、内存 ring buffer（`bufferCapacity` 默认 1000，用于 reattach 时补发 `sinceSeq` 之后的事件，超出容量的历史事件不可恢复——`replayLossy` 标志告知调用方）、`attachedNotify`（单一 attach 策略，新 client attach 会顶替旧的并发 `client/replaced` 通知）。`close()` 必须先设 `alive=false` 再 `inputQueue.end()`（注释里详细说明了竞态：反了会导致后续 `query/send` 静默丢消息，UI 卡死在 streaming）。`shutdownAll()` 在 daemon 收到 SIGTERM/SIGINT 时对所有 attached client 广播 `session/closed(reason:'killed')`，避免强杀 daemon 导致 desktop UI 永远卡在 "thinking..."。
- `src/sdk-handlers.ts` — `wireSdkHandlers(server, registry)`：把 `SessionRegistry` 的方法接到 `ManagerServer` 的 RPC dispatch 表上，是 daemon 侧协议方法与业务逻辑之间唯一的粘合层。同时维护"哪个 socket 当前 attach 到哪个 session"的映射，用于把 SDK `canUseTool` 触发的权限请求路由到正确的已连接客户端（通过 `server.sendRequest` 反向 RPC）；无 client attach 时默认拒绝（deny-by-default）。
- `src/remote-query.ts` — `createRemoteQuery()`：desktop 侧的"假 SDK Query"，实现与真实 `@anthropic-ai/claude-agent-sdk` Query 相同的消费接口（`send`/`setModel`/`setPermissionMode`/`applyFlagSettings`/`getContextUsage`/`interrupt`/`close`/`detach` + `AsyncIterable`），内部把每次调用转成 NDJSON RPC。`close()` 会调 `query/close`（结束远端 session）；`detach()` 只结束本地 iterator、保留远端 session 供以后 reattach。流关闭（daemon 被杀/网络中断）会通过 `client.subscribeClose()` 兜底把 iterator 结束，避免 desktop 侧的消费循环永久挂起。
- `src/async-queue.ts` — `createAsyncQueue()`：单消费者多生产者异步队列，**逐字复制**自 `packages/maker-core/src/agents/shared/async-queue.ts`（注释里显式说明是为了让本包保持零内部依赖，因为 daemon 二进制要 esbuild 打包发到远端机器，不能拉 maker-core）。两处实现必须手动保持同步，本文件不导入 maker-core。
- `src/bin/cc-mgr.ts` — CLI 入口（`cc-mgr daemon|version|help|bridge`），是打包进 `dist/cc-mgr.mjs` 并发到远端的实际可执行文件：
  - `stripSensitiveAnthropicEnv()` 在 daemon 启动时清除远端主机 shell 里残留的 Anthropic/Claude 认证类环境变量（`ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`/…），因为 SDK spawn 子进程时用 `{ ...process.env, ...userEnv }` 合并，desktop 传来的 env 只覆盖它显式设置的 key，不清理会导致远端旧 token 泄漏进新会话。这份 key 列表与 `packages/maker-core/src/agents/claude-code/env-builder.ts` 的 `SENSITIVE_ANTHROPIC_ENV_KEYS` 必须手动保持同步（无法跨包 import，同理零依赖约束）。
  - `ensureBundledNodeOnPath()` 让 SDK 内部 spawn 的 `claude` shim（`#!/usr/bin/env node`）能找到打包内置的 node 解释器，不依赖远端主机系统 node。
  - `selfDetachAndExit()` 用 `spawn(..., { detached: true })` 实现跨平台的"脱离 SSH 会话后台常驻"（unix 上等价 setsid，模拟 Codex Rust 的 `libc::setsid()` 做法），避免依赖 shell 侧 `setsid`/`nohup`（BSD/mac 没有 setsid）。
  - `runBridge()`：`cc-mgr bridge --socket <path>` 子命令，用内置 node `net` 模块把 stdin/stdout 桥接到 unix socket，替代某些精简 Linux/BusyBox 主机上缺失的 `nc -U`。
  - `installCrashGuards()` 装 `uncaughtException`/`unhandledRejection` 兜底（历史上观测到未被任何 stream 显式 `.on('error')` 捕获的 `EPIPE` 会直接崩掉整个 daemon），故意不 `process.exit`，daemon 尽量存活。
- `build.mjs` — esbuild 编程式打包脚本，产出 `dist/cc-mgr.mjs`（单文件、带 shebang、node20 target）。内含 `normalizeEolPlugin` 强制所有源文件用 LF，保证 Windows checkout（CRLF）和 POSIX checkout 产出字节级相同的 bundle sha256（否则 desktop 侧靠 hash 判断远端是否需升级会误判）。

## 模块边界

- **不依赖** `packages/maker-core`、Electron、任何 desktop 代码——唯一运行时依赖是 `@anthropic-ai/claude-agent-sdk`。这是硬约束：daemon 二进制要单独 esbuild 打包丢到任意远程 SSH 主机上跑，不能带 Electron/desktop 运行时。
- **被谁依赖**：
  - `apps/desktop/src/main/maker-host/cc-manager-client.ts` — desktop 主进程侧，import `RpcClient`/`createRemoteQuery`/protocol 类型，是 `client.ts`/`remote-query.ts` 的实际消费者。
  - `apps/desktop/src/main/remote-ssh/cc-manager-install.ts` — 负责把 `dist/cc-mgr.mjs` 部署/升级到远端主机；读取 `PROTOCOL_VERSION`（子路径 `@lizi/maker-cc-manager/protocol`）和 `CC_MGR_BUNDLE_VERSION` 做版本比对，路径拼接里假设打包产物固定位于 `packages/maker-cc-manager/dist/cc-mgr.mjs`（打包配置需要把它作为 `extraResource` 带进 Electron app）。
  - `packages/maker-core/src/agents/base-agent.ts` — 只在注释/类型层面引用（`import('@lizi/maker-cc-manager').QueryStartParams` 等 type-only 引用），故意用 `unknown` 而不是顶层 `import`，避免 maker-core 在非远程场景也强制加载这个包。
  - `apps/desktop/package.json` / `apps/desktop/vite.renderer.config.ts` — 声明依赖 / 打包排除规则。
- **对外接口形态**：两条线——(a) NDJSON-over-Duplex 的 wire 协议（`protocol.ts` 是唯一权威定义，版本号必须双端一致）；(b) `package.json` 的多入口 exports（`.`、`./client`、`./protocol`、`./codec`），desktop 端按需 import 子路径避免拉入不必要的 daemon-only 代码（如 `server.ts`/`session-registry.ts`）。
- MCP server 配置只接受 `stdio`/`sse`/`http` 三种可序列化 transport；带 `instance` 字段的 in-process MCP 配置在协议边界（`sdk-handlers.ts` 的 `queryStart` 与 `session-registry.ts` 类型层面）被拒绝，因为 `McpServer` 实例对象不能跨 RPC 序列化。

## 不要做的事

- 不要让 `src/async-queue.ts` 反向 import `packages/maker-core`，也不要让本包任何文件 import maker-core / Electron API——会破坏"daemon 单文件打包发远端"的前提。修改 `maker-core/src/agents/shared/async-queue.ts` 时记得同步手改这份复制体。
- 不要绕过 `PROTOCOL_VERSION` 做兼容性判断；协议不兼容必须靠握手时的版本号比对短路失败（`INVALID_PROTOCOL_VERSION`），不要指望字段层面的宽松解析。
- 不要在 `SessionRegistry.close()` / `kill()` 里把 `alive=false` 的设置延后到 consume loop 自然退出之后——见 `session-registry.ts` 内详细注释的竞态场景（`query/close` 后立即 `query/send` 会静默丢消息）。
- 不要往 `SENSITIVE_ANTHROPIC_ENV_KEYS`（`bin/cc-mgr.ts`）加新 key 却不同步 `packages/maker-core/src/agents/claude-code/env-builder.ts` 的对应列表，反之亦然。
- 不要手改 `build.mjs` 产出的 `dist/cc-mgr.mjs`，也不要跳过 `normalizeEolPlugin` 的 LF 归一化逻辑，否则 desktop 侧基于 sha256/`CC_MGR_BUNDLE_VERSION` 的升级判定会在跨平台开发机之间不一致。
- 不要假设 ring buffer 能无限回放历史事件——`bufferCapacity`（默认 1000）超限后最老事件被丢弃，`replayLossy` 是唯一的信号，调用方（desktop `RemoteQuery`）遇到该标志应放弃 reattach、开新 session，不要静默忽略。
- 不要在 `RpcClient`/`ManagerServer` 的 `dispose()`/`stop()` 里去关闭调用方传入的底层 stream/socket——所有权约定是调用方创建、调用方销毁。

## 演进备忘

_仅追加。每次重大改动留一行：日期 - 做了什么 - 原因。_
