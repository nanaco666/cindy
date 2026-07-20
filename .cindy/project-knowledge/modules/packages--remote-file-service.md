---
id: packages--remote-file-service
type: module
covers:
  - packages/remote-file-service/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-06T06:56:19.285Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# packages--remote-file-service

## 是什么

`@lizi/remote-file-service`（`packages/remote-file-service/`）是运行在远程 SSH 机器上的文件服务 daemon + desktop 侧 client + 两者共享的 NDJSON RPC 协议，让远程会话拿到与本地完全一致的文件浏览语义（忽略规则、二进制检测、路径安全）。Daemon 端把 `@lizi/file-browser-core` 的纯函数包一层 RPC 分发；desktop main 经 `maker-remote-ssh` 的 `RemoteHost.execStream` 通过 SSH exec channel 的 stdio 与之通信。零 Electron 依赖，daemon 侧代码可被 esbuild 打成单文件 bundle 推到任意 POSIX 远端。

## 关键抽象 / 核心代码地标

- `src/protocol.ts` — 线协议定义：三种帧（Request/Response/Event，全部单行 JSON）、`FsRpcMethods`（方法名 → params/result 类型表，client 与 daemon 分发共用同一份类型，编译期对齐）、`FsRpcEvents`（`search` / `fileTree` 两种事件负载）、`FS_RPC_ERROR_CODES`（`BINARY_FILE` / `SCHEMA_MISMATCH` / `BAD_REQUEST` / `RG_UNAVAILABLE` / `UNKNOWN_METHOD` / `OPERATION_FAILED`）。`FILE_SERVICE_SCHEMA_VERSION`（当前 2）是兼容性判据，client/daemon 必须严格相等；`FILE_SERVICE_BUNDLE_VERSION` 只是人读版本号，不参与兼容性判断。
- `src/server.ts` — `runFileService(input, output, opts)`：RPC 分发核心，与传输解耦（吃 Readable/Writable，生产入口接 stdio，测试用 PassThrough）。每请求独立 async 处理、响应乱序写回（靠 id 配对），无并发上限。日志走 stderr（stdout 被 NDJSON 帧独占）。持有一个 `WorkdirWatchManager` 单例和一个 lazy 初始化的 `RipgrepSearcher` 单例（无 `opts.rgPath` 时搜索/`listAllFiles` 走 `RG_UNAVAILABLE` 或纯 JS fallback `listAllFilesWalk`）。
- `src/client.ts` — `FileServiceClient`：desktop main 侧 RPC client，构造时注入 duck-typed `FileServiceStream`（形状对齐 `maker-remote-ssh` 的 `ExecStreamHandle`，故意不 import 该包，eslint 强制解耦）。`connect()` 发 handshake 并校验 schema，不匹配抛 `SCHEMA_MISMATCH`（caller 应重推 bundle 后重连）。流关闭/出错后进入 `dead` 态（`isDead`），所有 pending 请求以 `CHANNEL_CLOSED`/`CHANNEL_ERROR` reject，之后的 `request()` 立即 reject，caller 必须新建 client 而非复用。单请求默认超时 15s（`requestTimeoutMs`）。`FileServiceRpcError.code` 透传 daemon 的 `FsRpcErrorCode` 或本地传输码（`TIMEOUT`/`CHANNEL_CLOSED`/`CHANNEL_ERROR`/`DISPOSED`）。
- `src/codec.ts` — `NdjsonLineDecoder` / `encodeNdjsonFrame`：NDJSON 行编解码，chunk 边界与行边界无关、partial tail 跨 push 缓冲；`StringDecoder` 处理跨 chunk 撕裂的多字节 UTF-8（仅当输入是 Buffer；string 输入视为上游已保证边界安全直通）；坏行走 `onCorruptLine` 回调不打断流；`MAX_BUFFER_CHARS`（16MiB）OOM 兜底。与 `maker-cc-manager` 的同类 codec 是独立实现（协议不同，共享无净收益）。
- `src/watch.ts` — `WorkdirWatchManager`：daemon 端 per-workdir 文件监听，基于 Node 内建 `fs.watch(dir, { recursive: true })`（远端跑 bundled Node ≥22，Linux/macOS 均原生支持 recursive；不引 `@parcel/watcher` 之类原生依赖，因其 prebuilt `.node` 进不了 esbuild 单文件 bundle）。事件按 ignore matcher 过滤、丢弃 `.xdt-tmp` 原子写中间产物、按 `(type, relPath)` 做 50ms 窗口 coalesce。`start()`/`stop()` 处理了并发 start 竞争（`starting` map + `stopDuringStart` set）避免孤儿原生 watcher 或重复 watcher。
- `src/bin/file-service.ts` — daemon 生产入口，esbuild 打成 `dist/file-service.mjs`；`--rg <path>` 传远端 ripgrep 绝对路径，`--version` 输出 `{bundleVersion, schemaVersion}` 一行 JSON 供安装器 probe；接 `process.stdin`/`process.stdout`，stdin EOF 即自然退出。
- `build.mjs` — esbuild 打包脚本，含跨平台 EOL 归一 plugin（保证 Win/mac 构建产物 sha256 一致），产物由 `apps/desktop/scripts/build-remote-bundles.mjs` 在 dev/prepackage 阶段 stage 给 desktop。

## 模块边界

- **依赖**：只依赖 `@lizi/file-browser-core`（workspace），零 Electron / Node 原生扩展依赖（`fs.watch` 而非 `@parcel/watcher`，保证可被 esbuild 单文件打包）。
- **不依赖**：不 import `maker-remote-ssh`（`FileServiceStream` 是 duck-typed 接口，eslint 强制解耦，避免 daemon bundle 意外拉入 SSH/Electron 相关代码）。
- **被谁依赖**：`apps/desktop/src/main/file-browser/{remote.ts,remote-deps.ts,device-op.ts}` 消费 `FileServiceClient`；`packages/maker-remote-ssh/src/bootstrap/file-service-installer.ts` 负责把 `dist/file-service.mjs` 推到远端并做版本 probe/重装；`apps/desktop/forge.config.ts` 和 `scripts/build-remote-bundles.mjs` 负责构建期 staging。
- **对外接口形态**：三个 export 面——`.`（`runFileService`/`WorkdirWatchManager`/codec/protocol 全量 re-export，daemon 侧用）、`./client`（`FileServiceClient` 等，desktop main 用）、`./protocol`（纯类型 + 常量，双端共用）。
- **daemon 生命周期 = SSH exec channel 生命周期**：无常驻状态需要跨连接迁移，断线后重新 exec 一个新进程即可，不做会话恢复。

## 不要做的事

- 不要在改动任何 `FsRpcMethods` 请求/响应形状后忘记 bump `FILE_SERVICE_SCHEMA_VERSION`——协议不做向后兼容协商，版本不等即视为不兼容，client 应重推 bundle；忘记 bump 会导致新老 daemon/client 混跑时静默返回错误结果的形状不匹配。
- 不要给 `FileServiceStream` 实现直接 import `maker-remote-ssh` 的类型（哪怕只是类型引用）——eslint 配置会拦，这是有意的传输层解耦，改动前先确认是否真的需要打破边界。
- 不要假设 `stream.onStdout` 的文本流对多字节 UTF-8 边界安全；有 `onStdoutBytes` 时必须优先用它（`consumeChunk` 已经这样写），否则中文文件名/内容会被 per-chunk toString 的 U+FFFD 替换静默损坏。
- 不要在 `WorkdirWatchManager` 之外自己包一层去重/节流逻辑——`start`/`stop` 已经处理了启动期竞争（并发 start 复用同一个 promise、启动窗口内的 stop 会在 startInner 完成时自拆），重复实现容易踩到孤儿 watcher 或双份事件。
- 不要给 daemon 引入原生扩展依赖（如 `better-sqlite3`、`@parcel/watcher`）——esbuild 单文件 bundle 打不进 prebuilt `.node`，这也是选 `fs.watch` 而非更强的第三方 watcher 的原因。
- 不要在 `runFileService` 的 handler 里做同步阻塞 IO 或跳过 `assertInsideWorkdir`/realpath 校验——daemon 以 SSH 登录用户权限跑，路径安全完全依赖 `file-browser-core` 的 scanner 层复用，不要在这一层另起校验逻辑。

## 演进备忘

_仅追加。每次重大改动留一行：日期 - 做了什么 - 原因。_
