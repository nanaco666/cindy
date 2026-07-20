---
id: packages--heartbeat-client
type: module
covers:
  - packages/heartbeat-client/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-06T06:48:41.736Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# packages--heartbeat-client

## 是什么

`@lizi/heartbeat-client`（`packages/heartbeat-client/`）是一个零依赖、环境无关（Electron-agnostic）的客户端在线心跳模块：启动后立刻发一次心跳，随后按固定间隔周期性地向 `apps/heartbeat-server` 的 `POST {endpoint}/heartbeat` 上报 `{ uid, platform?, version? }`，用于维持“App 在线状态”的统计。当前唯一消费方是 `apps/desktop/src/main/heartbeatService.ts`，在 Electron 主进程里创建实例。

## 关键抽象 / 核心代码地标

- `src/client.ts` `createHeartbeatClient(opts: HeartbeatClientOptions): HeartbeatHandle` — 唯一入口。内部用 `setInterval` 驱动 `tick()`，调用时立即 fire 一次（不等第一个 interval），随后每 `intervalMs` 触发一次。
- `tick()`（`client.ts` 内部函数，未导出）— 每次心跳的核心流程：`host.getUid()` 为空则跳过（不计失败）→ 组装 body → 先调用可选的 `opts.onTick(payload)`（同步捕获异常、不影响后续上报）→ 再用 `fetch` + `AbortSignal.timeout(timeoutMs)` POST 到 `${endpoint}/heartbeat`；网络错误 / 非 2xx / 超时统一走 `log?.warn`，绝不 throw。
- `src/types.ts`：
  - `HeartbeatHost` — 依赖注入接口，宿主实现 `getUid()`（必需，可返回 `null` 表示暂时跳过）、可选 `getPlatform()` / `getVersion()` / `logger`。
  - `HeartbeatLogger` — 只要 `debug/info/warn` 三档，无 `error`（契约：心跳失败永远不是 error 级别）。
  - `HeartbeatTickPayload` — 传给 `onTick` 回调的 `{ uid, platform?, version? }`，用于让宿主复用心跳节拍做本地轻量任务（如 `heartbeatService.ts` 里的 TapDB 日活广播）。
  - `HeartbeatClientOptions` — `{ endpoint, intervalMs, timeoutMs?=5000, host, onTick? }`。
  - `HeartbeatHandle` — `{ stop(), get running }`；`stop()` 只清 timer，飞行中的请求不会被 abort。
- `src/index.ts` — barrel export，对外只暴露 `createHeartbeatClient` 与上述类型。

## 模块边界

- **不依赖**：无运行时依赖（`package.json` 里只有 `typescript` / `@types/node` 作为 devDependencies），不 import Electron / Node 专有 API，只用 `globalThis.fetch` 与 `globalThis.AbortSignal.timeout`——因此可在浏览器 / Node / Electron 主进程任意环境跑。
- **被谁依赖**：`apps/desktop`（`package.json` 声明 workspace 依赖），具体消费点是 `apps/desktop/src/main/heartbeatService.ts`，它是唯一的 host 适配层，负责从 `authManager` 取 `uid`（已登录用 `user.id`，未登录回落 `deviceId`）、从 `import.meta.env.VITE_HEARTBEAT_URL` 取 `endpoint`、注入主进程统一 `logger`，并在 `onQuit` 生命周期钩子里调用 `handle.stop()`。
- **对外接口形态**：纯函数式工厂 `createHeartbeatClient(opts) -> handle`，无 class、无全局状态、无单例限制（但 `heartbeatService.ts` 用模块级 `handle` 变量保证只初始化一次）。
- **配套 server**：`apps/heartbeat-server`，唯一 endpoint `POST /heartbeat`，不需要鉴权，返回 `{ ok: true }`。心跳间隔（生产用 60_000ms）与 server 的 `ONLINE_TTL_SEC=90` 配合，留 30s 容错窗口——改 `intervalMs` 时要连带考虑 server 侧 TTL。

## 不要做的事

- 不要在 `client.ts` 里加 retry / backoff / jitter——设计上认为“反正下一个 tick 还会再来”，重试只会浪费电，这是有意为之的简化，不是遗漏。
- 不要把网络失败、超时、非 2xx 升级成 `error` 或让其 throw 出 `tick()`——心跳统计场景的契约是“失败不算事故”，调用方（尤其 Electron 主进程 init 路径）依赖这个静默保证不会因心跳挂了影响 App 启动或其它业务。
- 不要引入 Electron / Node 专属 API（如 `net` 模块、`child_process`）到这个包——会破坏其 Electron-agnostic 的定位，让它无法在浏览器等场景复用。
- 不要假设 `host.getUid()` 返回值稳定不变——它在每次 tick 都会被重新调用，必须允许登录态切换期间动态返回不同值或 `null`。
- 不要在 `onTick` 回调里做假设“网络请求已成功”——`onTick` 在 fetch 之前就触发，且其异常被内部 catch 吞掉，不能作为“心跳上报成功”的信号。

## 演进备忘

_仅追加。每次重大改动留一行：日期 - 做了什么 - 原因。_
