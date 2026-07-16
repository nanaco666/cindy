# 第三方模型供应商接入体系 · 分阶段方案

> Status: In Progress（Phase 1-3 实现中） · Owner: DavidShen · 2026-07-08
>
> 目标一句话：**把「接入一个第三方供应商」的成本，从"一个 feature"降到"一段目录数据 + 一次联调"**，
> 覆盖 API key 与授权（OAuth）两种形态、Claude Code 与 Codex 两个 harness 入口。

## 背景与结论摘要

XDMaker 的供应商架构是三层：`@lizi/model-providers` 目录（OSS 热更 SSoT）→ desktop maker-host
接线（active-catalog / provider-route / safeStorage）→ `@lizi/anthropic-compat-proxy` loopback 代理
（per-request 路由 override）。对比 CodePilot（env 注入 + 诊断中心）与 Codex Desktop（config.toml
`model_providers` 下沉 Rust 内核）后的结论：

- **核心路由架构不动**——per-request 代理路由优于两者（会话中途切换、不重 spawn、缓存前缀稳定）；
- **不新增第三入口**——第三方模型的价值来自「模型 × harness」组合，单独入口只有成本没有收益；
- 要补的是：接入摩擦（预设/测试连接）、失败可解释性（结构化错误）、授权形态规模化（OAuth 描述符）。
- 经查证（2026-07）：OpenRouter 等主流聚合商已同时提供 Anthropic 兼容与 Responses 兼容端点，
  「wire 缺口」主要剩自托管场景（Ollama / LM Studio / 旧版 vLLM），wire 翻译降级为按需项（Phase 4）。

## 总原则

1. 不新增第三入口；所有第三方模型挂在 cc / codex 两个 harness 上（规则 8）。
2. 目录（OSS `providers.json`）始终是 SSoT，「加供应商 = 加数据不改路由器代码」。
3. 代理热路径（routingTransform / 剥离 / pipe）现有行为不动，新能力只做只读挂载或新增分支（规则 10）。
4. 密钥只进 safeStorage，不进目录、不进 localDb、不回传 renderer（规则 23）。
5. 分类、校验、探测全部代码实现，不依赖 prompt（规则 9）。
6. 每阶段独立可交付；一个 PR 一个目的。

## Phase 1：接入体验基线 —— 预设模板 + 测试连接

**解决**：主流供应商今天就能接（Anthropic 兼容端点 + `api-key-header` 路由），摩擦在于用户要
自己查 baseUrl / 猜模型 id / 配错无反馈。

- **目录 `presets` 段**（`packages/model-providers`）
  - 新类型 `ProviderPreset`：`{ id, name, docsUrl?, runtimes: { [agent]: { baseUrl, suggestedModels, headers? } } }`；
  - `Catalog.presets?: ProviderPreset[]`（顶层可选字段，旧客户端 parse 忽略未知字段，天然向后兼容）；
  - `parseCatalog` 增加轻量校验；`mergeWithBundled` 保留远端 presets（远端缺失回落 bundled）；
  - 首批预设（数据可经 OSS 随时修订）：OpenRouter / DeepSeek / 智谱 GLM / Kimi (Moonshot) / MiniMax，
    均走各家 Anthropic 兼容端点（cc runtime）；OpenRouter 另配 codex runtime（Responses 兼容）。
  - **区域区分（产品定位为全球公开产品）**：双端点厂商（智谱/Moonshot/MiniMax）拆 cn / global
    两条预设并标 `regionHint`；UI 按应用语言智能排序（`sortPresetsForLocale`，zh 用户 cn 靠前、
    其它语言 global 靠前），**只排序不过滤、无用户可见的地区开关**，可达性由测试连接实测裁决。
- **创建对话框「从模板创建」**（`CustomProviderDialog`）
  - 新建态顶部预设 chips；选中即预填显示名 / baseUrl / 模型清单 / headers，用户只填 key；
  - 预设是创建时快照，之后与预设脱钩（override 语义，规则 20）。
  - presets 经 `PROVIDER_LIST` IPC 附带下发（目录数据非密钥，只读）。
- **测试连接**（host 新模块 `provider-diagnostics.ts`）
  - 复用 `buildRouteDecision` 产出的 upstream + headers 构造**与真实会话同路由**的最小探测请求
    （cc wire：`POST /v1/messages` max_tokens=1；codex wire：`POST /responses` 最小体），10s 超时；
  - 支持两种入参：已保存的 `{providerId, agent}`（key 从 safeStorage 读）与表单态 adhoc
    `{baseUrl, modelId, apiKey?, headers?}`（未保存也能测；key 仅在内存中透传，不落任何盘）；
  - 结果走 Phase 2 的同一分类器（`ok | AUTH_INVALID | MODEL_NOT_FOUND | UPSTREAM_UNREACHABLE | ...`）；
  - IPC 采用 `{ok, ...data}` 查询型返回（规则 13 的例外条款：renderer 需要结构化结果渲染）；
  - UI：对话框内当前 runtime Tab 的「测试连接」按钮，结果内联徽标 + toast。

## Phase 2：失败链路可解释 —— 结构化错误分类

**解决**：能接通 ≠ 能用好。兼容层行为暗差 / 限流 / 欠费 / 上下文超限，现在以上游原始 JSON 形态
砸在会话里，用户无从行动。

- **分类器**（`apps/desktop/src/shared/providerErrors.ts`，纯函数，main / renderer 共用）
  - `ProviderErrorCode`：`AUTH_INVALID(401) / AUTH_FORBIDDEN(403) / RATE_LIMITED(429,retryable) /
    MODEL_NOT_FOUND / CONTEXT_TOO_LONG / QUOTA_EXCEEDED / UPSTREAM_UNREACHABLE(retryable) /
    WIRE_INCOMPATIBLE(400 已知 pattern) / UNKNOWN`；
  - 输入 `{status?, bodyText?, networkError?}` → `{code, retryable, detail}`；模式匹配基于
    Anthropic / OpenAI / 常见网关（litellm / OpenRouter）的错误体形状。
- **代理挂载**（`anthropic-compat-proxy-host.ts` / `codex-proxy-host.ts`）
  - 经 `composeResponseObservers` 新增只读 observer：status ≥ 400 时缓冲错误体（≤16KB）→ 分类 →
    结构化日志 + 广播 `PROVIDER_UPSTREAM_ERROR`（含 providerId/agent/code/status）；
  - **不改写响应、不阻塞 pipe**（包红线）；同 (provider, code) 30s 节流防刷屏。
- **renderer 呈现**
  - 订阅事件 → toast（i18n 四语言人话 + 行动建议：去测试连接 / 检查模型 id / 稍后重试）。

## Phase 3：授权形式规模化 —— OAuth 描述符 + 通用 Runner

**解决**：订阅制供应商（Anthropic / OpenAI / SuperGrok）现全是 bespoke 手写，每接一家 = 一个 feature。

- **目录 schema**：`Provider.auth` 扩展为 `{ method, oauth?: OAuthProviderDescriptor }`：
  `{ authorizeUrl, tokenUrl, clientId, scopes, redirectPort?, extraAuthParams?, tokenAuthStyle?,
    modelsDiscoveryUrl? }`；`AuthStrategy` 新增 `'oauth-token'`（resolve 时从 token store 注入
    `Authorization: Bearer <access_token>`）。
- **通用 Runner**（host `generic-oauth.ts`，泛化自 `grok-oauth-login.ts` 的五件同构事）
  - PKCE 授权页拉起 → 回环回调捕获（state 校验）→ form-encoded token 交换 → safeStorage 存
    `provider_oauth_<id>` blob → 临期单飞刷新（refresh chain mutex + 超时 + 登出竞态复核）；
  - 深度定制（OpenAI spawn-CLI 登录、Anthropic 订阅刷新等）**保持 bespoke**，不纳入 Runner；
    描述符只覆盖「标准 authorization-code + PKCE」形态（规则 9：同构部分才进数据）。
- **路由接线**（`provider-route.ts`）
  - 与 `customProviderKeyReader` 同模式注入 `oauthTokenReader(providerId)`（同步读内存缓存，
    刷新在后台/请求前异步完成，不阻塞热路径）；`buildRouteDecision` 新增 `oauth-token` 分支。
- **通用连接 UI**：`auth.method === 'oauth'` 且带描述符且非 bespoke id 的供应商，设置页显示
  通用「登录 / 退出」（IPC `PROVIDER_OAUTH_LOGIN / LOGOUT`）。
- **动态模型发现**：登录成功后拉取模型发现端点（描述符显式声明的 `modelsDiscoveryUrl` ??
  由 runtime baseUrl 推导的 `…/v1/models`），经 active-catalog 的 additions-only merge
  （泛化 discoveredChatgpt 机制：静态条目 first-wins、发现条目只增不改）。自定义供应商的
  发现结果 additions-only **持久化进配置**（重启后仍在）；内置供应商走内存 augment。
- **自定义 OAuth 表单收敛（配置项最小化）**：OAuth 模式只暴露 显示名 + 四个 OAuth 字段 +
  每 runtime 的基础 URL；模型不再必填（授权后自动发现），模型 / 请求头收进默认折叠的
  「高级配置」。目标：自定义订阅供应商的体验路径与内置订阅（保存 → 点授权 → 模型自动出现）
  完全一致，唯一多出的成本是填 OAuth 参数——而这部分未来可由预设模板 / OSS 目录代填。

## Phase 4（按需触发，本轮不实现）：wire 长尾

自托管/本地端点（Ollama / LM Studio / 旧版 vLLM，仅 Chat Completions）：

- codex 侧：spawn 时 config override 注入 `model_providers.<id> = { base_url, wire_api: "chat" }`
  （Codex Desktop 的 Copilot 桥接同款机制，让 Rust 内核原生做协议适配）；
- cc 侧：把 Messages↔Responses bridge 从「`chatgpt/`、`xai/` 前缀触发」泛化为「按描述符 wire 字段
  触发」，并补 Messages→Chat 变体；
- 两条都改变送模型请求形态，PR 按规则 10 附实测。

## Backlog（记录待议）

- 管理员策略层：目录 policy 段（强制/禁用供应商、锁定网关），借鉴 Codex Desktop managed 配置层；
- 脱敏诊断导出：key 留 last4、URL 留 hostname 的一键导出（借鉴 CodePilot scrub 规则）。

## 验收标准

| 阶段 | 验收 |
|---|---|
| P1 | 从零接入 OpenRouter ≤1 分钟；baseUrl/key/model id 三类配置错误在设置页有明确结论 |
| P2 | 第三方供应商常见失败在 UI 呈现分类文案而非原始 JSON；retryable 有标记；流式延迟无回退 |
| P3 | 新增一家标准 OAuth 供应商 = 目录数据 + 联调，host 零代码；token 刷新/失效/换账号有回归测试 |
