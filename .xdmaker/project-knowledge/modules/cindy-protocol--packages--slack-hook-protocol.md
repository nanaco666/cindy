---
id: cindy-protocol--packages--slack-hook-protocol
type: module
covers:
  - cindy-protocol/packages/slack-hook-protocol/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-16T03:53:39.023Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# cindy-protocol--packages--slack-hook-protocol

## 是什么

`@cindy/slack-hook-protocol` 位于私有 `cindy-protocol` submodule，是外部 Slack hook server 与 desktop `hook-control` 之间双工任务协议的单一来源。它把消息类型、TypeScript 判别联合、运行时校验和发帧构造器放在同一个包里，避免客户端与服务端各自维护副本。

## 关键抽象 / 核心代码地标

- `src/types.ts`：协议版本、帧上限、hello/welcome、任务派发与收口、绑定、查询、取消、归档、交互和偏好同步的消息联合。
- `src/parse.ts`：`parseHookMessage` 对所有外部帧做不抛异常的确定性校验，错误包含字段路径。
- `src/build.ts`：`make*` 构造器统一生成版本、id、时间戳与 payload 默认值；`serializeHookMessage` 负责文本帧序列化。
- `src/__tests__/*`：锁住合法/非法帧、字段联动、构造器与序列化契约。

## 模块边界

- desktop 通过 workspace 包名消费，外部 hook server 在 `cindy-server` 仓使用同一 submodule commit。
- 包本身不建连接、不调 Slack、不访问 desktop session；它只提供协议数据与纯函数。
- `node:crypto` 只用于构造发送帧 id，因此消费者运行环境需要 Node。

## 不要做的事

- 收到原始帧必须先过 `parseHookMessage`，不能直接类型断言后进入业务。
- 发帧使用 `make*` 构造器，不要在两端手拼 envelope 或复制版本常量。
- 新增消息或字段时要同时更新类型、parse、build、测试，并确认老版本对未知字段/类型的降级策略。
- 升级父仓 submodule 指针前必须确认 desktop 与 `cindy-server` 协议兼容。

## 演进备忘

_仅追加。每次重大改动留一行：日期 - 做了什么 - 原因。_

- 2026-07-16 - 客户端从旧 `packages/hook-protocol` 切换到协议 submodule，固定 gitlink 为 `75b93a2`。
