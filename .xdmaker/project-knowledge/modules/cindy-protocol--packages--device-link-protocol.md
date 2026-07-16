---
id: cindy-protocol--packages--device-link-protocol
type: module
covers:
  - cindy-protocol/packages/device-link-protocol/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-16T03:53:39.023Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# cindy-protocol--packages--device-link-protocol

## 是什么

`@cindy/device-link-protocol` 位于私有 `cindy-protocol` submodule，是客户端与外部 device-link relay 共用的中继层 wire protocol 单一来源。它只定义 relay 必须理解的信封、路由集合、错误码、连接握手与 presence payload；端到端隧道内容继续留在客户端 `packages/device-link`。

## 关键抽象 / 核心代码地标

- `src/protocol.ts`：`PROTOCOL_VERSION`、帧大小上限、`Envelope` / `EnvelopeKind`、`ROUTED_KINDS`、`CONTROL_KINDS` 与 `RelayErrorCode`。
- `HelloPayload` / `HelloAckPayload` / `PresenceSetPayload` / `PresenceSnapshot`：relay 会解析的连接层数据。
- `src/index.ts`：无副作用地导出完整协议面。

## 模块边界

- 零运行依赖，不包含 WebSocket 状态机、REST、Electron 或数据库代码。
- 客户端 `packages/device-link/src/protocol.ts` 复用本包后再扩展 invoke、push、link 与本地错误类型。
- relay 服务端也必须固定同一个 `cindy-protocol` commit；父仓升级 submodule 前要与 `cindy-server` 同步确认。

## 不要做的事

- 不要把 relay 不解析的业务 payload 放进本包，避免协议层反向依赖客户端业务。
- 不兼容变更必须递增 `PROTOCOL_VERSION`，并同时验证 client 与 relay；不能只改单边 submodule 指针。
- 帧大小按 UTF-8 字节计算，不能用 JavaScript 字符串长度代替。
- 不要在父仓直接修改 submodule 工作区后漏提交协议仓 commit；父仓只记录 gitlink。

## 演进备忘

_仅追加。每次重大改动留一行：日期 - 做了什么 - 原因。_

- 2026-07-16 - 客户端新仓固定协议 submodule 到 `75b93a2`，desktop/mobile 通过 `packages/device-link` 消费本协议。
