---
id: packages--anthropic-responses-bridge
type: module
covers:
  - packages/anthropic-responses-bridge/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-16T03:53:39.019Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# packages--anthropic-responses-bridge

## 是什么

`@lizi/anthropic-responses-bridge` 是插在 `anthropic-compat-proxy` 路由槽里的协议翻译 handler，让只会调用 Anthropic Messages API 的 Claude Code SDK 可以使用 ChatGPT / xAI 订阅凭证访问原生 OpenAI Responses API。它在同一个 loopback 代理进程里完成请求重组和 SSE 逐事件翻译，不是独立服务。

## 关键抽象 / 核心代码地标

- `src/handler.ts`：`createResponsesHandler` 按模型前缀选择 provider，获取最新 OAuth header，调用上游 `/responses`，并把限流、错误和流式响应翻译回 Anthropic 形态。
- `src/translate-request.ts`：把 system、message block、tool、tool_result、image 与 reasoning 状态转换成 Responses input；reasoning 回放按 provider 前缀隔离。
- `src/translate-sse.ts`：`SseTranslator` 把 Responses SSE 映射成 Anthropic 的 message/content block 生命周期，保持事件顺序和流式输出。
- `src/usage.ts`：统一 usage 字段映射；`src/types.ts` 保存两套 wire protocol 的最小类型。
- `src/__tests__/*`：覆盖请求、SSE、handler 与真实 bridge 冒烟路径。

## 模块边界

- 对外只导出 handler、翻译器、usage 映射和类型；不监听端口，也不持有 Electron 状态。
- host 通过 provider 配置注入模型前缀、上游地址、鉴权 header、reasoning 能力与限流回调；会话 effort / Fast 通过 handler 闭包传入。
- `anthropic-compat-proxy` 负责接收请求和字节透传，本包只处理命中订阅模型的 `localHandler` 路径。

## 不要做的事

- 不要把它另起成第二层 HTTP 服务，否则会增加消息流跳数和故障面。
- 不要把会话偏好塞进伪 header；在路由决策处通过 `prefs` 注入。
- 不要在 SSE 热路径做整流缓冲、同步 I/O 或大对象反复拷贝；事件必须无丢失、无错序。
- 不要把一个 provider 的 encrypted reasoning 回放给另一个 provider，上游会拒收或污染上下文。

## 演进备忘

_仅追加。每次重大改动留一行：日期 - 做了什么 - 原因。_

- 2026-07-16 - 随 Cindy 客户端拆仓建立模块索引；该包继续作为 desktop 本地代理的 Responses 协议插槽。
