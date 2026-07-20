---
id: packages--lizi-im
type: module
covers:
  - packages/lizi-im/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-06T15:32:10.000Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# packages--lizi-im

## 是什么

纯 IM 传输层包。抽象出 `BaseIM` 基类和 `createIM` 聚合工厂，当前唯一实现为 `FeishuIM`（飞书长连接 WebSocket 通道）。包通过 `IMHost` 接口与宿主（`apps/desktop`）解耦——宿主注入加密存储、IPC 桥、文件路径等能力适配器，lizi-im 不依赖 Electron/Drizzle/maker 任何内部模块。唯一外部依赖是 `@larksuiteoapi/node-sdk`。

对外职责：
- **入站**：通过 Lark WSClient 长连接接收 `im.message.receive_v1` 和 `card.action.trigger` 事件，解析内容 + 下载附件 → 发射 `IMMessageEvent` / `IMCardActionEvent`。仅处理 p2p 会话，群聊消息在 wsClient 入口处直接丢弃。
- **出站**：发送纯文本 / markdown 卡片 / 交互卡片（带按钮）/ 流式文本（带节流 patch）/ 文件消息 / emoji 表情回复。
- **身份绑定**：通过 `binding/` 子目录提供 channel-agnostic 的 `BindingStore<TValue>` 接口（类型定义 only），宿主自行注入实现（典型 SQLite），用于"IM 用户 → desktop session"映射。
- **凭证 + TOFU owner**：用宿主的 `secrets` 加密存储 appId/appSecret 和 owner open_id。

## 关键抽象 / 核心代码地标

| 文件 | 用途 |
|------|------|
| `src/BaseIM.ts` | 抽象基类，定义 `init()` / `dispose()` / `registerIpc()` 生命周期合约 |
| `src/createIM.ts` | 聚合多 channel 为单一 `IM` facade，各 channel 错误隔离（`Promise.allSettled`） |
| `src/types.ts` | 公开类型：`IMHost`（宿主能力合约）、`IMMessageEvent`、`IMCardActionEvent`、`IMStatus`、`InteractiveCardSpec`、`StreamingTextHandle`、`SendFileResult` |
| `src/binding/types.ts` | `IdentityKey`（channel + botContextId + userId 三元组）、`BindingStore<TValue>` 接口；仅类型，无实现 |
| `src/feishu/index.ts` | `FeishuIM` — BaseIM 的飞书实现；对外暴露 `onMessage` / `onCardAction` / `onStatusChange` 订阅 + 出站方法 |
| `src/feishu/wsClient.ts` | Lark WSClient + EventDispatcher 封装；通过劫持 SDK logger 输出来检测连接状态（SDK 不暴露生命周期 callback） |
| `src/feishu/conflictDetector.ts` | 多设备冲突启发式判定：readyTimeout + reconnect 次数阈值 → connected / conflict / error 裁决 |
| `src/feishu/ownerGuard.ts` | TOFU 白名单：首个 p2p 发送者自动成为 owner，后续只接受同一 open_id |
| `src/feishu/storage.ts` | 加密持久化 appId / appSecret / owner open_id，读写均同步（走 `host.secrets`） |
| `src/feishu/incomingContent.ts` | 解析各种 msg_type（text / image / file / post / audio / media）为统一 `{ text, attachments, unsupported }` |
| `src/feishu/attachmentDownloader.ts` | 通过 `im.v1.messageResource.get` 下载附件到 `feishuMediaDir`，30MB 上限 |
| `src/feishu/mediaStore.ts` | 本地文件系统 media 缓存，key 为 feishu image_key/file_key，命中则跳过网络 |
| `src/feishu/mediaCache.ts` | `xdt-image://feishu-media-{images,files}/<filename>` URL 解析 → 绝对路径，含路径遍历防护 |
| `src/feishu/outbound.ts` | 出站原语：sendText / sendInteractive / updateInteractive / sendFile / uploadImage / addReaction / removeReaction；所有调用以 `open_id` 为 receive_id |
| `src/feishu/streamingText.ts` | 流式文本卡片：throttled patch（1.5s）+ finalize 时并行 upload xdt-image → image_key + 拆分 xdt-file 为独立文件消息 |
| `src/feishu/cards.ts` | 飞书卡片 JSON 模板：v1（带按钮交互）+ v2（纯 markdown，流式用） |
| `src/feishu/ipc.ts` | 注册 `feishuBot:*` IPC 通道（get-state / save / clear / registration-begin / registration-cancel），连接 renderer Settings UI |
| `src/feishu/appRegistration.ts` | 飞书 OAuth device-code 流程：begin → poll → 获取 clientId/clientSecret/ownerOpenId |
| `src/feishu/messages.ts` | 传输层用户面文案（上线/下线通知、TOFU 欢迎、流式占位符），业务域文案不在此处 |
| `src/feishu/events.ts` | 模块内部 EventBus（typed EventEmitter），status/conflict/message/cardAction/imStatus |
| `src/feishu/moduleScope.ts` | 模块级单例持有 `IMHost` 和 `Logger`，`getHost()` / `getLog()` 供内部 helper 免参数传递 |
| `src/feishu/cardActionParser.ts` | 解析 `card.action.trigger` payload，兼容 v1/v2 schema 位置差异，白名单校验 |

## 模块边界

**依赖**：
- `@larksuiteoapi/node-sdk` — Lark WSClient / Client / EventDispatcher

**被依赖**：
- `apps/desktop/src/main/im/` — 宿主层：提供 `IMHost` 实现、注册 `onMessage` / `onCardAction` 回调编排 agent turn
- `apps/desktop/src/main/scheduler-host/` — 通过 `FeishuIM.getOwnerOpenId()` + 出站方法向 owner 推送通知

**对外接口形态**：
- TypeScript ESM（`"type": "module"`），monorepo 内直接指向源码 `./src/index.ts`（无构建产物）
- 运行时合约：宿主必须先 `createFeishuIM(host)` 构造实例，再调 `init()` → `registerIpc()`；退出时 `dispose()`
- IPC 通道名与 renderer 硬编码耦合：`feishuBot:get-state` / `feishuBot:save` / `feishuBot:clear` / `feishuBot:status-change` / `feishuBot:conflict` / `feishuBot:registration-*`

**不依赖**（显式边界）：
- Electron API（通过 `IMHost.ipc` / `IMHost.secrets` 抽象）
- Drizzle / 数据库（binding 层纯类型，实现在宿主）
- maker-core / maker-scheduler / 任何业务逻辑

## 不要做的事

1. **不要在 lizi-im 内引入 Electron 或 apps/desktop 的任何 import** — 所有宿主能力必须通过 `IMHost` 注入。这是包可独立复用的核心约束。
2. **不要在此包内决定"unsupported 消息怎么回复用户"** — `IMMessageEvent.unsupported` 只是原始分类，回复措辞和是否跳过 agent 调用由宿主编排层决定。
3. **不要在此包处理 `xdt-image://` namespace 解析** — streamingText.finalize 时的 `xdt-image://feishu-media-*` 路由仅限飞书 media 下载目录；其它 host namespace（如 `xdt-image://art-*`）由宿主主进程 `imageCacheStore.resolveSafe` 处理后以 absPath 传入 `addExtraImageAbsPath`。
4. **不要在非 v1 schema 卡片上放按钮** — 飞书 2026-04 起 v2 schema + action tag 报错（230099/200861），交互按钮必须走 v1 `buildInteractiveCardV1`。
5. **不要假设 SDK 有连接生命周期 callback** — Lark WSClient 不暴露 ready/disconnect 事件，wsClient.ts 通过劫持 SDK 内部 logger 输出的关键字触发 ConflictDetector。**SDK 升级后必须重新 grep SDK 源码确认日志字符串未变**。
6. **不要把业务域文案放在 `messages.ts`** — 那里只放传输层通知（上线/下线/TOFU/流式占位），agent 错误/API key 缺失等归宿主编排层。
7. **不要在 `BindingStore` 类型文件里提供实现** — binding 子目录只定义接口，具体实现（SQLite 等）由宿主注入。
8. **IPC 通道名不要随意改** — `feishuBot:*` 前缀与 renderer Settings UI 硬编码耦合，修改需同步 renderer。

## 演进备忘

_仅追加。每次重大改动留一行：日期 - 做了什么 - 原因。_
