---
id: packages--device-link
type: module
covers:
  - packages/device-link/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-06T06:44:25.564Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# packages--device-link

## 是什么

`@lizi/device-link`（`packages/device-link`）是同账号跨设备远程控制的**客户端协议与状态机层**：relay 会解析的 envelope、连接层 payload 与错误码来自 `cindy-protocol` submodule 的 `@cindy/device-link-protocol`；本包补充端到端隧道 payload、本地错误、远程 IPC 白名单、push topic 路由和 `DeviceLinkClient`。消费者是 `apps/desktop`（控制端/被控端）与 `apps/mobile`（纯控制端），relay 位于外部 `cindy-server` 仓。本包 Electron/host-agnostic：WebSocket、鉴权 token、设备信息均由 host 注入。

## 关键抽象 / 核心代码地标

- `src/protocol.ts` — 从 `@cindy/device-link-protocol` 复用 `PROTOCOL_VERSION`、帧上限、`Envelope`、连接层 payload 与 relay 错误；本地扩展 `DeviceLinkError`、link/invoke/push payload 和 REST `DeviceView`。
- `src/client.ts` — `DeviceLinkClient`：连接生命周期 `connect → hello 握手 → online`，断线指数退避重连（1s→30s，`reconnectStableResetMs` 后才清零退避计数，防重复连接风暴顶频重连）；online 后每 20s `ping`、连续 2 周期无 `pong` 判僵死重连；请求配对（`invoke`/`link-open` 按 `id`+`expectKind` 双重匹配响应，超时 reject `INVOKE_TIMEOUT`）。`connectNow()`/`waitUntilOnline()` 是 additive opt-in API，供"用户正在等"场景（如移动端回前台）绕开默认退避立即重连，不改变桌面端默认曲线。`classifyConnectionIssue()` 把三态 `stopped/connecting/online` 之外的失败原因（401 鉴权失败、4409 顶号、4429 超限、4400 版本不符）旁路暴露成 `DeviceLinkConnectionIssue`，供 UI 展示具体原因而不打扰普通网络抖动。
- `src/allowlist.ts` — `REMOTE_INVOKE_ALLOWLIST`（`CORE_INVOKE_CHANNELS` ∪ `EXTENDED_INVOKE_CHANNELS`，默认拒绝制）是控制端能驱动被控端做的**全部**事；`PUSH_FORWARD_ALLOWLIST` 是被控端广播转发给控制端的事件白名单；`computeAllowlistHash()`（FNV-1a）在 `link-accept` 回传供双端探测 allowlist 版本差异；`INVOKE_TIMEOUT_OVERRIDES_MS` 给个别 channel（如 `desktop-cmd:run`）比默认 30s 更长的隧道超时，避免与被控端自身执行预算（30s 命令超时+5s SIGKILL）对撞而早丢结果。`DL_*_CHANNEL` 常量（`device-link:subscribe`/`media:fetch`/`voice:transcribe`/`voice:credential-sync`/`voice:dictionary-learning`）不是 `ipcMain.handle` channel，而是被控端 dispatch 在通用路由前拦截执行的特殊 channel，仍登记进 allowlist 作契约声明 + 老版本探测。
- `src/topics.ts` — `Topic`（`'sessions' | session:${string} | fs-watch:${string}`）与 `topicForPush(channel, payload)`：把一条被控端广播归到某个订阅 topic，是 push 事件 fan-out 路由的唯一依据。`sessions`（轻，列表读模型 + `SESSION_ACTIVITY_CHANNEL` 活动摘要）vs `session:<id>`（重，单会话实时流，触发被控横幅）vs `fs-watch:<workdir>`（订阅驱动，无常驻监听成本，不触发横幅）。
- `src/index.ts` — 桶导出以上四个模块，无其它逻辑。

## 模块边界

- **不依赖**：Electron、渲染层、任何 host 特定实现；不 import `apps/*` 任何模块。
- **依赖它的（消费者）**：
  - `apps/desktop`：被控端 dispatch 见 `apps/desktop/src/main/device-link/dispatch.ts`（双层校验 + 合成 event 调本机 `ipcMain.handle`），传输路由见 `apps/desktop/src/renderer/lib/makerTransport.ts`。
  - `apps/mobile`：纯控制端，见 `apps/mobile/src/device-link/*`（`DeviceLinkContext.tsx`/`rnWebSocket.ts`/`presenceDevices.ts` 等）。
  - `packages/maker-shared/src/deviceLinkContract.ts`：独立镜像了部分 channel 常量与 `DeviceLinkConnectionIssueKind`（非本包的直接依赖方，是各自维护的同名镜像，改协议需同步）。
- **对应的 server 端**：位于外部 `cindy-server` 仓，并通过同一个 `cindy-protocol` submodule 消费 `@cindy/device-link-protocol`；升级父仓 gitlink 前必须确认两仓指针与 wire protocol 兼容。
- **对外接口形态**：只导出类型/常量/纯函数 + `DeviceLinkClient` 类，无副作用（不建连接、不读环境变量）；host 必须显式 `new DeviceLinkClient(opts)` 并注入 `createWebSocket`/`getToken`/`getHello`。

## 不要做的事

- 不要往协议/客户端里加隐式的 Electron 或 Node-only 依赖（如直接用 `node:crypto` 而非 `globalThis.crypto`）——`client.ts` 的 `createRequestId()` 已示范浏览器/RN/Node 通用降级写法。
- 不要绕开 `REMOTE_INVOKE_ALLOWLIST`/`PUSH_FORWARD_ALLOWLIST` 直接放行新 channel；新增前核对 `allowlist.ts` 顶注的准入判据（无 `event.sender` 依赖、无本机 UI/shell 副作用、语义在被控端执行才正确）与永不放行类别（账号密钥、全局设置写、local-db 裸写、窗口/shell 副作用），改动需同步 `__tests__/allowlist.test.ts` 的不变式守卫。
- 不要把 `PROTOCOL_VERSION` 当作可降版本处理，或跳过 +1 递增；不兼容改动在 `cindy-protocol` 中完成，并同步升级客户端仓与 `cindy-server` 的 submodule 指针。
- 不要用 `text.length`（UTF-16 码元）判断帧大小去对比 `MAX_FRAME_BYTES`——必须按 UTF-8 字节数（`sendEnvelope` 已用 `TextEncoder` 处理），否则 CJK 内容客户端自检通过但被 server 判 `PAYLOAD_TOO_LARGE` 丢帧，`invoke` 只能等到 30s 超时而非快速失败。
- 不要在 `topics.ts` 加新 push channel 却不同步登记到 `allowlist.ts` 的 `PUSH_FORWARD_ALLOWLIST`（或反之）——两者是同源约定，缺一边会导致事件转发了却路由不到 topic，或反过来。
- 不要在父仓直接复制或重建 relay wire 类型；单一来源是 `cindy-protocol/packages/device-link-protocol`。

## 演进备忘

_仅追加。每次重大改动留一行：日期 - 做了什么 - 原因。_

- 2026-07-16 - 客户端拆仓后改为消费私有协议 submodule；relay 留在外部 `cindy-server`，两仓以 gitlink 协调版本。
