---
id: packages--maker-remote-ssh
type: module
covers:
  - packages/maker-remote-ssh/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-06T06:53:02.178Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# packages--maker-remote-ssh

## 是什么

`@lizi/maker-remote-ssh`（`packages/maker-remote-ssh`）是 XDMaker 的 SSH 远程主机管理库：连接生命周期（连接/断线重连/keepalive）、`~/.ssh/config` 的读写、凭证解析（ssh-agent / identity file）、以及在远程机器上 bootstrap agent CLI（claude-code / codex）、cc-manager 守护进程和 file-service 的安装器。零 Electron 依赖，只被 `apps/desktop` 的 main 进程消费（`apps/desktop/src/main/remote-ssh/*`、`file-browser/remote*.ts`、`maker-host/*`），供 renderer 通过 IPC 间接使用。当前是 "Phase A"（连接管理 + host 管理）+ Phase B 的一部分（exec/execStream channel、agent bootstrap）；PTY tab / sftp / session ingest 是 Phase C，未实现。

## 关键抽象 / 核心代码地标

- `RemoteHost`（`src/RemoteHost.ts`）：单台远程机器的一条 SSH 连接。状态机 `disconnected → connecting → authenticating → ready ⇄ reconnecting → failed`（见文件头注释）。核心方法：`connect()` / `disconnect()`（幂等）、`exec(cmd, opts)`（一次性命令，收集 stdout/stderr/exitCode，带超时）、`execStream(cmd, opts)`（长驱动的流式 channel，给 Claude/Codex `--input-format stream-json` 或 bootstrap 用，无超时、调用方管生命周期）。`isAuthFailure()` / `authFailureHint()` 是导出的纯函数，用于识别认证类失败（确定性、不重试）并给出可操作提示（`ssh-copy-id ...`）。
- `ConnectionPool`（`src/ConnectionPool.ts`）：按 host id（= SSH alias）管理所有 `RemoteHost` 的注册表 + 生命周期。`hydrate(configs)` 用于启动时用 `~/.ssh/config` 内容做增量对账（消失的 host 断线+移除，新增/变更的 host 注册/更新）。自身不做持久化——写 `~/.ssh/config` 是调用方（IPC 层）通过 `sshConfig.upsertHost` 做的，pool 只维护内存镜像。
- `sshConfig.ts`：`readSshConfig()` / `upsertHost()` / `updateHostFields()`（保留用户手写指令如 ProxyJump 的精确编辑）/ `removeHost()`。只枚举具体 host（跳过 `Host *` 通配符/`Match` 块）。用 `# xdt-maker:auth=agent|key` 注释标记区分"agent + 指定 pubkey"与"key 文件"两种模式（二者在磁盘上都落成 `IdentityFile` + `IdentitiesOnly yes`，靠标记复原语义）。原子写（temp file + rename，0600/0700）。
- `credentials.ts` → `resolveAuth(host)`：三条认证路径——(1) agent 不过滤全量枚举、(2) agent + `identityFile` 指定 pubkey → 走 `FilteredAgent` 只暴露匹配指纹的身份（避免撞 `MaxAuthTries`）、(3) `authMethod='key'` 直接读私钥文件字节交给 ssh2。平台差异：macOS/Linux 走 `$SSH_AUTH_SOCK`，Windows 走 OpenSSH named pipe `\\.\pipe\openssh-ssh-agent`（回退 Pageant）。
- `filteredAgent.ts` → `FilteredAgent`（`ssh2.BaseAgent` 子类）：只暴露指定 SHA256 指纹的身份，`sign()` 透传给上游 agent（passphrase 缓存留在系统 ssh-agent/Keychain，不用户重复输入）。存在原因见文件头注释：ssh2 默认枚举 agent 全部身份，多 key 场景容易撞 OpenSSH `MaxAuthTries`（默认 6）。
- `bootstrap/bootstrap-script.ts`：内联为 TS 字符串的 bash 脚本（`BOOTSTRAP_SH`），通过 stdin 管道跑在远程（不落临时文件、支持 ProxyJump）。**从不信任远程系统 Node**——始终下载固定版本（`BUNDLED_NODE_VERSION = '22.13.0'`）到 `~/.xdt-server/v1/node/`。claude-code 走 bundled-node + `npm install`；codex 走官方 `install.sh` standalone 安装（daemon 模式要求 `$CODEX_HOME/packages/standalone/current/codex` 的 managed-install 布局，npm 包做不到）。协议：脚本每行一条前缀化输出（`PROBE_START` / `NODE_CACHED` / `INSTALL_LOG` / `READY <ver>` / `ERROR <msg>` 等），退出码 0/4/5/6/7/10 各有含义（文件头注释有完整列表）。
- `bootstrap/installer.ts`：解析上述协议行的类型化 API——`probeRemoteAgent()`（只读）、`installRemoteAgent()`（跑 bootstrap，流式 `onEvent` 回调给 UI）、`uninstallRemoteAgent()`（只删 sentinel，不删 `node_modules`/bundled node）。`REMOTE_SERVER_SCHEMA_VERSION = 'v1'`，是所有远程路径的根前缀。另含 codex 专用的 `checkRemoteCodexAuth()` / `pushRemoteCodexAuth()`——只操作 XDMaker 自己隔离的 `~/.xdt-server/v1/codex-home/auth.json`，从不碰用户系统的 `~/.codex/`（bootstrap 脚本首次安装时 `cp -n` 镜像一份，之后两者独立）。
- `bootstrap/cc-manager-installer.ts`：cc-manager（`packages/maker-cc-manager` 的 esbuild 产物 `cc-mgr.mjs`，~956KB，内含 `@anthropic-ai/claude-agent-sdk`）与可选 `proxy.mjs`（anthropic-compat-proxy）的独立安装路径——不是 npm 包，直接用 `cat > path` 的 stdin 管道上传字节。**依赖 agent bootstrap 先跑过**（复用其安装的 bundled node，自身不装 node）。`probeCcManager()` / `installCcManagerBundle()` / `uninstallCcManager()`。导出的 `buildUploadScript()` 也被 `file-service-installer.ts` 复用。
- `bootstrap/file-service-installer.ts`：`packages/remote-file-service` 产物 `file-service.mjs`（~50KB）的安装路径，与 cc-manager-installer 同构（同样依赖 bundled node、同样的上传脚本）。额外探测远程 `ripgrep`（PATH 优先，回退 claude-code vendor 自带的 rg），供 file-service 的搜索/索引降级判断用。
- `constants.ts`：跨模块共享的远程路径常量（`REMOTE_CC_MGR_*`、`REMOTE_XDT_NODE_PATH`、`REMOTE_CLAUDE_SHIM_PATH`），全部基于 `$HOME/.xdt-server/v1/...`。
- `types.ts`：对外数据类型——`HostConfig`（`id` 即 SSH alias，必须与 `~/.ssh/config` 里的 `Host` 指令一致才能无损往返）、`HostSnapshot`（含 `lastAuthLabel`、`statusChangedAt`，供 renderer 展示）、`RemoteStatus`、`AuthMethod`、`HostSource`。

## 模块边界

- 零 Electron 依赖（`package.json` description 明确声明），可在 main 进程外独立单测（vitest）。依赖仅 `ssh2` / `ssh-config` / `ws`。
- 对外入口是 `src/index.ts` 的显式 re-export 清单——新增公共 API 必须在这里手动导出，不是整包裸露。
- 唯一运行时消费方是 `apps/desktop` 的 main 进程（`workspace:*` 依赖），集中在 `src/main/remote-ssh/`、`src/main/file-browser/remote*.ts`、`src/main/maker-host/{codex-remote-transport,cc-manager-client}.ts`。renderer 不直接依赖，走 IPC。
- `packages/maker-core`（`session.ts`、`agents/base-agent.ts`）和 `packages/remote-file-service` 只在**注释**里提到 `@lizi/maker-remote-ssh`（remote host alias 的语义来源说明），不是实际 import 依赖——这两个包不需要跟着 remote-ssh 的实现改动而改。
- 不做持久化：`~/.ssh/config` 的读写是本包提供的函数，但"何时调用"由 apps/desktop 的 IPC 层决定；`ConnectionPool` 只是内存注册表。
- 不做 agent 会话业务逻辑（消息编排、SDK 事件流）——那是 `packages/maker-core` 的职责（见规则 8）。本包只提供 exec/execStream 这层传输原语和远程环境 bootstrap，`maker-core` 通过 desktop main 拿到的 `RemoteHost` 实例在上面跑 claude/codex 进程。
- 远端所有 XDMaker 相关文件都收敛在 `~/.xdt-server/<schema-version>/` 一棵树下（`REMOTE_SERVER_SCHEMA_VERSION = 'v1'`），且刻意与用户系统的 `~/.codex/`、系统 Node、系统 shell profile 隔离——设计上从不污染/依赖用户已有环境。

## 不要做的事

- 不要信任远程系统 Node——任何新的远程执行逻辑都应复用 `~/.xdt-server/v1/node/bin/node`（bundled），不要假设 `node`/`npm` 在远程 PATH 上可用或版本够新。
- 不要在 `exec()` 的错误消息里回显原始 `cmd` 字符串——调用方经常把密钥（如 `ANTHROPIC_API_KEY=...`）内联在 env 注入或 wrapper 脚本里，回显会通过统一 IPC 错误路径落进 XDMaker 日志。需要上下文时用 `ExecOpts.label`。
- 不要假设 `channel.signal()` 能杀死远程进程——OpenSSH server 的 `PermitSignal`/`AcceptEnv` 配置经常静默拒绝；`kill()` 的实现总是同时 `close()` channel 作为兜底（触发 SSH session teardown 发 SIGHUP）。
- 不要把认证失败（`isAuthFailure()` 判定为 true 的场景）纳入自动重连——认证失败是确定性的，重试不会改变结果；`handlePostReadyClose()` 已经显式跳过这类重连，新代码不要绕过这个判断引入无意义的重试风暴。
- 不要用 `upsertHost()` 做"编辑现有 host 的一两个字段"——它整段替换会丢失用户手写的 `ProxyJump`/`ServerAliveInterval`/注释等；这种场景用 `updateHostFields()`（只动它显式管理的字段）。
- 不要跳过 `# xdt-maker:auth=` 标记的读写——`agent+pinned-key` 和 `key` 两种模式在磁盘上是同一组指令（`IdentityFile` + `IdentitiesOnly yes`），丢了标记会在下次 `readSshConfig()` 时把"agent 模式"误判成"key 模式"。
- 不要往 `applyDirective`/`applyAuthMarker` 之外的路径手写 ssh-config AST 节点而不设置 `separator` 字段——序列化器缺省会输出 `KeyundefinedValue`，损坏整份 `~/.ssh/config`。
- 不要修改 `constants.ts` 里的远程路径常量却不同步 `bootstrap-script.ts` / `installer.ts` 里对应的 `BIN_PATH` 分支（`binaryPathFor()`）——两处路径必须一致，否则已安装的 agent 会被判定成路径不存在。
- 不要在没有先跑过 `installRemoteAgent()`（bootstrap bundled node）的远程机器上直接调用 `installCcManagerBundle()` / `installFileServiceBundle()`——两者都硬依赖 bundled node 已存在，probe 会显式报错拒绝而不是自己装 node。
- 不要往用户系统的 `~/.codex/` 或 `~/.ssh/`（除了我们管理的 host 块）写入内容——codex 凭证走隔离的 `~/.xdt-server/v1/codex-home/`，`~/.ssh/config` 的写入范围严格限制在我们自己创建/管理的 `Host` 块。

## 演进备忘

_仅追加。每次重大改动留一行：日期 - 做了什么 - 原因。_
