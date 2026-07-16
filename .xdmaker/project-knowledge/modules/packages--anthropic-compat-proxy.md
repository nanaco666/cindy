---
id: packages--anthropic-compat-proxy
type: module
covers:
  - packages/anthropic-compat-proxy/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-06T04:48:14.598Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# packages--anthropic-compat-proxy

## 是什么

进程内 loopback HTTP 反向代理，是 Claude Code / Codex 子进程与真实上游(Anthropic API / XD.inc gateway / litellm / ChatGPT 后端)之间的可编程中间层。核心职责已从最初的"字段兼容性" scoped 变为四件事: (1) 剥掉 Anthropic-only 请求字段避免非 Claude 模型(gpt-5.4、kimi-k2、glm-5.1 等)经 litellm/Azure 后端返回 400; (2) per-request 路由 override(按 model / session 选上游、换鉴权 header),取代原来"改 env 重 spawn 子进程"才能切供应商的模型; (3) 上游 400 的透明重试(剥坏字段重发一次,对客户端零感知)与"恢复一次后主动剥离"两层防御; (4) 只读响应观察(tee 抽取 service_tier / rate-limit header 等 metadata)与 Codex 专属的产品 system prompt 注入。代理仅监听 `127.0.0.1` 的 Fetch-safe 随机端口,Claude 模型 / 未命中任何 override 的请求字节透传,响应路径全程 `pipe`,SSE 流式延迟为零。除桌面端内嵌使用外,还打包成独立 CLI(`dist/proxy.mjs`)部署到远端 SSH 主机,作为 `cc-mgr.mjs` 的可选伴生进程。

## 关键抽象 / 核心代码地标

| 文件 | 核心导出 | 说明 |
|------|---------|------|
| `packages/anthropic-compat-proxy/src/server.ts` | `createAnthropicCompatProxy(opts): Promise<ProxyHandle>` | 启动 loopback HTTP server,返回 `{ url, dispose() }`。`url` 作为 `ANTHROPIC_BASE_URL` / Codex provider `base_url` 传给子进程 |
| `packages/anthropic-compat-proxy/src/transform.ts` | `stripNonAnthropicFields`、`stripEncryptedContentFromBody`、`stripImageGenerationItemsWithoutIdFromBody`、`stripEmptyThinkingFromBody`、`createActiveStripTransform`、`createEncryptedContentRecoveryRule`、`createImageGenerationIdRecoveryRule`、`createEmptyThinkingRecoveryRule` | 默认请求 transform + 3 类"剥离条件"的 strip 函数 + 对应主动剥离 transform 工厂 + 400 透明重试规则工厂 |
| `packages/anthropic-compat-proxy/src/types.ts` | `ProxyOptions`, `ProxyHandle`, `RequestTransform`, `RoutingTransform`, `RoutingDecision`, `ResponseObserver`, `RecoveryRule`, `ProxyLogger` | 公开类型 |
| `packages/anthropic-compat-proxy/src/headers.ts` | `DEFAULT_THREAD_ID_HEADERS`, `headerValue`, `selectedHeaderValue` | thread/session id 取 header 的共享工具,收口给 server.ts / transform.ts 用,避免字面量漂移 |
| `packages/anthropic-compat-proxy/src/instructions-injection.ts` | `createInstructionsInjectionTransform`, `createInstructionsRegistry` | Codex 专属: 按 threadId 把产品级 system prompt 追加进 Responses API 请求体顶层 `instructions` 字段 |
| `packages/anthropic-compat-proxy/src/thread-strip-controller.ts` | `createThreadStripController(): ThreadStripController` | "恢复一次后主动剥离"的 thread→model 状态机,condition-agnostic,每个剥离条件必须用独立实例 |
| `packages/anthropic-compat-proxy/src/bin/proxy.ts` | CLI entry | standalone 版本,`--upstream <url> [--host]`,监听后往 stdout 写一行 JSON `{url, upstream}`,收 SIGINT/SIGTERM 走 `dispose()` |
| `packages/anthropic-compat-proxy/build.mjs` | esbuild 打包脚本 | 把 `src/bin/proxy.ts` bundle 成自包含 ESM `dist/proxy.mjs`(零运行时依赖,~20-50KB),`pnpm --filter @lizi/anthropic-compat-proxy bundle` 触发 |
| `packages/anthropic-compat-proxy/src/index.ts` | barrel re-export | 导出上述所有工厂函数与类型 |

### 请求处理流水线

1. 非 POST/PUT/PATCH(如 codex models-manager 轮询 `GET /models`)→ 不缓冲 body,仍跑一次 `routingTransform(undefined, ctx)` 做控制面请求路由,再直转上游
2. POST/PUT/PATCH → `collectRequestBody` 缓冲完整 body(上限 32MB,超出 413)
3. 基于**原始** body(未经 transform 链改写)跑一次 `routingTransform` 决定本次上游 override / header override / header delete —— 提前到 transform 链之前算,因为路由要看得到 transform 会删掉的原始字段(例: 去前缀前的 `codex/` model id),且 inbound debug 日志能据此打出"最终真实发往哪个上游"
4. `runTransforms` 跑请求体 transform 链(默认 `[stripNonAnthropicFields]`);任一 transform 抛错或全部返回 null → 退化字节透传
5. `forward` 转发到(可能被 override 后的)上游;响应用 `upstreamRes.pipe(clientRes)` 字节级透传,`responseObserver` 若配置则并行 tee

### Fetch-safe 端口绑定

`url` 会作为 `ANTHROPIC_BASE_URL` 交给可能走浏览器 `fetch` 语义的 SDK,因此不能绑定 Fetch 标准的 bad ports 列表(`FETCH_BLOCKED_PORTS`,`isFetchBlockedPort`)。`listenOnFetchSafeLoopbackPort` 主动从高位私有端口区间(49152-65535)随机起点顺序探测,跳过 blocked port,遇 `EADDRINUSE`/`EACCES` 重试,最多 32 次;不依赖"OS 随机分配后再补漏"。

### 上游连接超时(Happy Eyeballs)

Node 20+ 默认开 `autoSelectFamilyAttemptTimeout`(双栈并竞),但单地址握手默认仅 250ms;高延迟网络下到 Cloudflare 系上游(如 chatgpt.com)握手常 >250ms,会导致所有解析地址被逐个砍掉、连接抛 `AggregateError`、客户端收到 502(2026-07 实踩,curl/浏览器没有这么激进的 per-attempt 超时所以不复现)。`forward()` 显式把 `autoSelectFamilyAttemptTimeout` 放宽到 `UPSTREAM_CONNECT_ATTEMPT_TIMEOUT_MS = 2500ms`,只拉长新建连接的地址争抢窗口,不影响整体请求超时(仍由 `UPSTREAM_SOCKET_TIMEOUT_MS = 10min` 管)。回归测试见 `server-connect-options.test.ts`(mock `node:http.request` 断言转发 options 带这两个值)。

### per-request 路由 override(RoutingTransform / RoutingDecision)

与 `RequestTransform`(改 body)职责分离,只读、只决定路由:`upstreamOverride`(整段上游 URL)、`headerOverride`(合并进 outbound headers,典型换 `authorization`)、`headerDelete`(在 `headerOverride` 合并**之后**应用,用于抹掉客户端已带上但目标上游不认的 header,如把订阅专属的 `anthropic-beta: oauth-2025-04-20` 从换网关的请求里删掉)。`decisionToOverrides` 把 decision 翻译成 `forward()` 的三件套,GET 等无 body 路径与 POST 路径共用同一段逻辑。Host 侧用它实现"同一 loopback endpoint 上按 model / per-session 选定的供应商 / spawn 时冻结的鉴权形态分流",取代了历史上"切供应商就要重 spawn 子进程换 env"的做法(见 `anthropic-compat-proxy-host.ts` 的 `createModelRoutingTransform` / `codex-proxy-host.ts` 的 `decideCodexRoute` + `createModelRoutingTransform`)。

### 上游 400 透明重试(RecoveryRule)与主动剥离(ThreadStripController)

两层防御,共享同一组 strip 函数:
- **Layer 1(反应式)**: `forward()` 收到上游 400 且有 `enabled()` 的 `RecoveryRule` 时,先把(通常很小的)错误体完整缓冲、按 `content-encoding` 解压后跑 `match(text)` regex,命中第一条且 `strip(body)` 有效果的规则,剥字段后用 `canRetry=false` 重发一次(防循环);同一次重试会顺手把其它可安全 strip 的规则也应用掉,避免恢复一类 400 后立刻撞另一类。命中的规则通过 `onRetry(threadId, model)` 回调触发 Layer 2 的 `markActive`。当前已注册三条规则: `encrypted_content`(`invalid_encrypted_content` / "Encrypted content could not be decrypted")、`image_generation_id`(Azure/LiteLLM "Image generation items without `id`")、`empty_thinking`(Anthropic "each thinking block must contain thinking",默认 always-on)。
- **Layer 2(主动剥离)**: `ThreadStripController`(`thread-strip-controller.ts`)是 thread→model 的 in-memory 标记;某 thread 因某条件恢复过一次后,`createActiveStripTransform` 在请求发出**前**就提前剥,省掉每轮重撞同一个 400。`reconcile(threadId, model)` 在每个请求周期先调用一次做状态收敛(model 变了 = 切了供应商/模型 → 清除标记)。**每个独立剥离条件必须用自己的 controller 实例**(host 侧 `thread-strip-controllers.ts` 为 encrypted/image-generation/empty-thinking 各建一个单例)——共用会交叉污染: A 条件的恢复会让 B 条件的主动剥离误触发(例如无谓剥掉 `encrypted_content`,代价是模型丢失推理链)。

### 只读���应观察器(ResponseObserver)

`responseObserver` 在 `upstreamRes` 上与 client pipe 并行挂一个 tee sink(`onData`/`onEnd`/`onError`),用于抽取低风险 metadata(如 `anthropic-ratelimit-unified-*` header、Responses SSE 里的 `service_tier`),**不得**改写响应或阻塞流式 pipe;sink 内部抛错只 warn 一次并置空,不影响主路径。Host 侧用 `composeResponseObservers` 组合多个互不感知的 observer(见 `claude-rate-limit-headers-observer.ts` / `claude-fast-mode-log.ts` / `codex-proxy-host.ts` 的 service-tier observer)。

### Codex 产品 system prompt 注入(instructions-injection.ts)

`createInstructionsInjectionTransform` 只对匹配 `pathMatch`(默认 URL 以 `/responses` 结尾)的请求生效: 按 `headerNames`(默认 `thread-id` / `x-client-request-id`)取 threadId,从调用方持有的 `InstructionsRegistry` 查已注册的产品 prompt 文本,幂等追加到请求体的 `instructions` 字段末尾(从不替换、从不重复追加)。查不到 threadId header 或 registry 未命中 → 直接跳过,**绝不**回退到"最后一个/唯一一个" registry 条目(会跨会话污染)。`createInstructionsRegistry()` 只是一个隔离的 `Map` 工厂,单例归属权在 host(desktop 的 `codex-proxy-host.ts` 持有唯一实例并按 sessionId↔threadId 双向 map 维护注册/注销)。命中 registry 但请求体非法(非 object / `instructions` 字段类型不对)会走 `logger.error`(P0 信号,不静默 passthrough)。

### dispose 语义

退出场景下客户端(Claude Code / Codex 子进程)也即将被 SIGTERM,保留 in-flight 请求无意义。`dispose()` 立即 `destroy` 所有 in-flight socket,`server.close()` 的 keep-alive 等待因此立即满足,整个 dispose 从原来的 ~2s grace 降到 ~10ms。副作用:in-flight 请求那侧会收到 ECONNRESET,`bootstrap-electron` 的 `onQuit` 注释已显式接受此语义(session 本来就在 close 路径上,error 直接被吞)。`DISPOSE_GRACE_MS` 常量已删除。

实现为:先 `for...of inflightSockets` 逐个 `s.destroy()`,再 `await new Promise<void>((resolve) => server.close(() => resolve()))`,无 race / 无超时。(注: `types.ts` 里 `dispose()` 的 doc 注释仍写着旧版"2s 超时强关"措辞,与实现不一致,是文档漂移,行为以此文件描述为准。)

### per-model handler 注册方式

在 `transform.ts` 中:写一个 `ModelStripHandler` 函数 + 在 `STRIP_HANDLERS` 字典里以 model id 为 key 登记。目前已注册:`gpt-5.4`、`gpt-5.4-mini`(均只删 `output_config`)、`codex/gpt-5.4`(复用 `stripGpt54`,"骨折GPT"低价路由与 gpt-5.4 打同一个 Azure 后端,同样因 `output_config` 报 400)。字典外的 model 一律字节透传,proxy 零干预。

### debug 日志中的 upstreamBase

`server.ts` 在 `createAnthropicCompatProxy` 启动时预拼 `upstreamBase`(`protocol//hostname[:port]basePath`,默认端口省略),每条 `▶ inbound request from client` debug 日志按**本次请求最终 override 后**的目标(而非静态默认上游)输出,POST 路径下会用 routingTransform 算出的 `overrideTarget` 覆盖。错误响应(status ≥ 400)body 会按 `content-encoding` 解压后再 dump,避免日志里出现 gzip/br 乱码;仅 dump 前 16KB,超出加截断提示。

### CLI 入口(bin/proxy.ts)

`anthropic-compat-proxy --upstream <url> [--host 127.0.0.1]`:启动后往 **stdout** 写恰好一行 JSON `{"url":"...", "upstream":"..."}`(parent process 靠这行解析代理地址),所有日志走 **stderr**;收到 SIGINT/SIGTERM 后 `await handle.dispose()` 再 `process.exit(0)`。通过 `build.mjs`(esbuild,`normalizeEolPlugin` 强制 LF 保证跨平台 bundle 字节确定性)打包成零依赖 ESM `dist/proxy.mjs`,由 `apps/desktop/src/main/remote-ssh/cc-manager-install.ts` 与 `packages/maker-remote-ssh/src/bootstrap/cc-manager-installer.ts` 经 SSH stdin pipe 部署到远端主机,作为 `cc-mgr.mjs` 的可选伴生进程(`installProxyOnDemand`)。

## 模块边界

**依赖**:仅 Node.js 内置模块(`node:http`、`node:https`、`node:net`、`node:url`、`node:zlib`),零运行时依赖(`esbuild` 只是打包用的 devDependency)。

**被依赖**:
- `apps/desktop/src/main/maker-host/anthropic-compat-proxy-host.ts` — Claude Code 本地代理生命周期管理:per-model/per-session 路由(`createModelRoutingTransform`)、fast-mode/rate-limit 响应观察器组合、encrypted-content 与 empty-thinking 两条主动剥离链的接线
- `apps/desktop/src/main/maker-host/codex-proxy-host.ts` — Codex Responses API 本地代理生命周期管理:产品 system prompt 注入 registry、env-key/oauth-bearer 路由决策(`decideCodexRoute`)、encrypted-content 与 image-generation 两条主动剥离链、service-tier 响应观察器
- `apps/desktop/src/main/maker-host/thread-strip-controllers.ts` — 三个 `ThreadStripController` 单例(encrypted / image-generation / empty-thinking,各自独立实例)
- `apps/desktop/src/main/maker-host/provider-route.ts`、`claude-gateway-config.ts`、`claude-rate-limit-headers-observer.ts`、`claude-fast-mode-log.ts`、`runtime-configs.ts`、`auth-adapters.ts`、`logger-adapter.ts` — 路由决策 / observer / logger 适配等支撑代码
- `apps/desktop/src/main/bootstrap-electron.ts` — splash 阶段启动、`onQuit('anthropic-compat-proxy', ...)` 注册 dispose
- `apps/desktop/src/main/remote-ssh/cc-manager-install.ts` + `packages/maker-remote-ssh/src/bootstrap/cc-manager-installer.ts` — 把打包后的 `dist/proxy.mjs` 作为远端 SSH 会话的伴生进程部署/探测
- `packages/model-providers/src/user-provider.ts`、`packages/maker-core/src/session.ts` — 仅文档性引用(说明自定义 model id 字节透传 / per-session 路由的实现位置),无运行时耦合

**对外接口形态**:两种消费方式——(1) 纯库,桌面端 main 进程 `await createAnthropicCompatProxy({ upstream, ... })` 拿到 `ProxyHandle`,`.url` 设为子进程的 base URL,退出时 `await handle.dispose()`;(2) 独立 CLI(`dist/proxy.mjs`),SSH 部署到远端主机后作为子进程运行,靠 stdout 单行 JSON 协议与父进程通信。

## 不要做的事

- 不要把 `host` 改成 `0.0.0.0` — 安全边界
- 不要对响应做 transform — 会破坏 SSE 零延迟;需要读响应内容用 `responseObserver` 的只读 tee,不能改写
- 不要凭推测给 `STRIP_HANDLERS` 加新 model — 需实际 400 日志为证
- 不要在包内 `console.log` — 走 `ProxyLogger` 接口
- compat 模式切换只对新建 session 生效(`ANTHROPIC_BASE_URL` 是子进程 spawn 时的 env,已存在 session 不受影响)
- 不要恢复 grace 等待逻辑(即重新引入 `DISPOSE_GRACE_MS`)— dispose 快速路径是有意为之,已在 `bootstrap-electron` 注释里接受 ECONNRESET 副作用
- 不要给两个不同的剥离条件共用同一个 `ThreadStripController` 实例 — 会交叉污染(一个条件的恢复会误触发另一个条件的主动剥离)
- 不要假设 400 透明重试可以链式无限重试 — `canRetry=false` 只保证重试一次,防止 recovery rule 与坏上游之间死循环
- Codex instructions injection 找不到 threadId / registry 未命中时不要回退到"最后一个/唯一一个"注册条目 — 会把产品 prompt 串给别的会话
- 不要假设 loopback 端口可以随便绑 — 必须避开 `isFetchBlockedPort` 覆盖的 Fetch 标准禁用端口,否则调用方用 `fetch` 语义访问代理会直接失败
- 不要在 `forward()` 里去掉放宽后的 `autoSelectFamilyAttemptTimeout` — 会在高延迟网络下退回 250ms 默认值,复现 502 AggregateError 回归

## 演进备忘

_仅追加。每次重大改动留一行:日期 - 做了什么 - 原因。_

- 2026-05-27 - `server.ts` inbound debug 日志新增 `upstreamBase` 字段(省略默认端口),方便 debug 时直接看请求流向哪个上游
- 2026-06-03 - `dispose()` 去掉 2s grace,改为立即 destroy 所有 in-flight socket 后等 `server.close` 回调(~10ms),退出路径提速;`DISPOSE_GRACE_MS` 常量一并删除;客户端 ECONNRESET 已在 `bootstrap-electron` 注释里显式接受
- 2026-06-04 - 同步更新 `server.ts` 文件头注释,使 dispose 行为描述与实现��致(去掉"2s 超时强关 socket"旧说法,改为描述立即 destroy + server.close 语义);dispose 实现简化为先 destroy 所有 socket 再单独 await server.close,去掉 Promise.race 结构
