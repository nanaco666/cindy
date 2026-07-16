---
id: packages--embedding-client
type: module
covers:
  - packages/embedding-client/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-06T06:44:13.662Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# packages--embedding-client

## 是什么

`@lizi/embedding-client`（`packages/embedding-client/`）是一个零运行依赖的 OpenAI `/v1/embeddings` 兼容客户端，专门对接 xdproxy 网关（`https://llm-proxy.tapsvc.com`）来做文本向量化。它只做单次同步调用语义（调方传 N 条文本 → 一次 HTTP 请求）、进程内 LRU 缓存、指数退避重试和统一错误码，不做拆批、不做持久化缓存、不做自动 model fallback——这些留给上层 consumer（目前是 `apps/desktop` 的 embedding-host）决策。

## 关键抽象 / 核心代码地标

- `EmbeddingClient`（`src/client.ts`）：唯一的对外入口类。构造时传 `EmbeddingClientOptions`（`baseUrl` / `getApiKey` / `fetchImpl` / `cacheSize` / `logger`）。
  - `embed(req: EmbedRequest): Promise<EmbedResponse>`：先按 `sha256(model + '\0' + text)` 查 LRU 缓存拆出 miss 索引，全命中直接返回不打网络；否则调 `callWithRetry` 打 xdproxy，用响应里的 `.index` 显式定位结果（不假设 data 顺序与 input 一致），写回结果数组并回填缓存。
  - `callWithRetry` / `callOnce`：`callOnce` 单次 POST，fetch 抛错 → `NETWORK_ERROR`；非 2xx 按状态码走 `mapStatusToCode`。`callWithRetry` 在 `NETWORK_ERROR` / `RATE_LIMITED` / `SERVER_ERROR` 时走 `RETRY_DELAYS_MS = [1s, 5s, 15s]` 指数退避，最多 4 次尝试（initial + 3 retries）；`AUTH_FAILED` / `INVALID_MODEL` 立即抛不重试。
  - `listModels()`：re-export `catalog.ts` 的 `listEmbeddingModels()`，给 consumer 做 UI 选择。
- `catalog.ts`：硬编码的 7 个模型元信息表（`text-embedding-3-small/large`、`gemini-embedding-2-preview`、`voyage/voyage-4` 系列等），每项含 `dim` / `maxTokens` / `pricePerMTokens` / `preview` 标记。`getEmbeddingModel(id)` / `isKnownEmbeddingModel(id)` / `listEmbeddingModels()` 是唯一查询入口；新增模型需同步 `types.ts` 的 `EmbeddingModelId` 联合 + 本表追加一行。
- `types.ts`：`EmbeddingModelId`（字面量联合）、`EmbeddingModelMeta`、`EmbeddingClientOptions`、`EmbedRequest` / `EmbedResponse`、`EmbeddingError`。`EmbeddingError.code` 是 `AUTH_FAILED | RATE_LIMITED | INVALID_MODEL | NETWORK_ERROR | SERVER_ERROR` 联合，供上层 Worker 按 code 决定是否计入重试次数——这是本包与 consumer 之间最重要的契约面。
- `lruCache.ts`：`LruCache<K,V>`，基于 `Map` 插入顺序实现（命中 delete+set 挪到末尾），`capacity <= 0` 时退化为 no-op（对应 `cacheSize: 0` 关闭缓存）。
- `index.ts`：包的唯一公开导出面，重导出 `EmbeddingClient` / `EmbeddingError` / catalog 工具函数与全部类型。`package.json` 的 `exports` 额外开了 `./types` 和 `./catalog` 子路径。

## 模块边界

- 零运行依赖，只用全局 `fetch`（要求 Node 18+ / Electron 28+），无 Node-only API 之外的第三方包依赖。
- 不依赖 `apps/desktop` 或任何其它 package；`getApiKey` 通过回调注入（避免写死 key，切账号即时生效，返回 `undefined`/空字符串代表未登录），`fetchImpl` 可注入用于单测。
- 唯一已知消费者是 `apps/desktop/src/main/embedding-host/`（`EmbeddingWorker.ts` / `EmbeddingService.ts` / `index.ts`）及其 dev-only IPC（`apps/desktop/src/main/ipc/dev/embedding.ts`）；embedding-host 负责拆批、并发/速率控制、按 `EmbeddingError.code` 做业务级重试决策——这些都是本包明确声明"不做"的部分。
- 对外接口只有 `EmbeddingClient` 类 + catalog 查询函数 + 类型；不暴露 HTTP 细节（如 header 名、原始响应结构）给 consumer。

## 不要做的事

- 不要在本包内做批量拆分（chunking）——`maxTokens` 校验/切分是调方职责，client 只按 `req.texts` 原样发送一次请求。
- 不要引入运行依赖（如 axios、其它 HTTP 库）——设计上刻意保持"零运行依赖，仅用全局 fetch"，加依赖会破坏这个不变量。
- 不要在 `callOnce`/`callWithRetry` 里为 `AUTH_FAILED` / `INVALID_MODEL` 加重试——这两类是确定性失败（未登录、模型名不在 catalog 或 xdproxy 判定 400），重试没有意义且会拖慢失败反馈。
- 新增/修改模型时不要只改 `catalog.ts` 或只改 `types.ts` 的 `EmbeddingModelId`——两者必须同步，否则 `isKnownEmbeddingModel` 与类型系统会不一致。
- 不要假设 xdproxy 响应的 `data` 数组顺序与 `input` 一致去做位置映射——现有实现按 `.index` 显式定位（`src/client.ts` 的 `byIndex` Map），这是刻意的防御性设计，修改时不要退化为直接按下标对应。
- 不要给 LRU 缓存加持久化——当前明确是"进程内"缓存，跨进程/磁盘缓存属于后续 Phase 范围外的工作，不要在本包内 silently 加。

## 演进备忘

_仅追加。每次重大改动留一行：日期 - 做了什么 - 原因。_
