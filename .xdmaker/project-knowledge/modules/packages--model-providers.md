---
id: packages--model-providers
type: module
covers:
  - packages/model-providers/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-06T06:54:24.992Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# packages--model-providers

## 是什么

`@lizi/model-providers`（`packages/model-providers/`）是模型供应商目录 + 路由抽象的纯逻辑包，零 Electron / maker-core 运行时依赖，被 `apps/desktop`（main + renderer）与 `apps/mobile` 同时引用。它把「有哪些供应商、每个供应商在哪个 agent（`claude-code` / `codex`）下提供哪些模型、请求最终该怎么路由到上游」这三件事从各处硬编码（`CLAUDE_MODELS` / `CODEX_MODELS`、host 里的 `decideXxxRoute`）收敛成一份数据驱动的目录（`catalog/providers.json`）+ 一组纯函数，作为 per-agent 模型清单的**唯一来源(SSoT)**：host 从目录派生 maker-core 的 `capabilities.availableModels`，桌面模型选择器分段列表、IM `/model` 卡片、手机端模型选择器都调同一套函数保证两端口径一致。

## 关键抽象 / 核心代码地标

- `src/types.ts` — 核心类型：`Provider`（id / agents / auth.method / routing / models，按 agent 分组）、`CatalogModel`（id / contextWindow / efforts / defaultEffort / supportsFastMode / defaultEnabled 等，per-(provider,agent) 粒度）、`RoutingDescriptor`（upstream / authStrategy / modelIdRewrite / headerDelete / headerOverride，供 host 通用路由器消费）、`Catalog`、`CustomProviderConfig` / `CustomProviderRuntimeConfig`（用户自定义供应商持久化配置，不含密钥）。`AgentKind` / `Effort` 在此就地定义（与 maker-core 同名联合对齐但不 import maker-core）。
- `catalog/providers.json` — 内置目录快照（打包进 App 的离线兜底 + 上传 OSS `cfg/providers.json` 作线上最新版 + dev 直接读的仓库文件）。当前三个 provider：`anthropic`（claude-code，oauth）、`openai`（codex，oauth）、`xd`（claude-code + codex，managed 网关）。
- `src/catalog.ts` — `BUNDLED_CATALOG`（import 该 json）+ `parseCatalog(input)`：校验必需字段、`provider.agents` 每项都要有对应 `routing[agent]` 与 `models[agent]`、`titleModel` 若声明必须存在于本供应商模型清单、以及跨供应商同 (agent, modelId) 的元数据一致性校验（`modelSignature`，故意排除 `supportsFastMode` / `defaultEnabled` 以放行 per-provider 分叉）。
- `src/source.ts` — `loadCatalog(cfg, io)`：目录加载优先级 dev `localPath`（不联网）→ 远端 OSS 拉取 → 内置 bundled；`mergeWithBundled` 保证远端裁剪了某 provider 时不丢内置能力；IO（`fetchText` / `readFile` / `log`）由 host 注入，本模块不碰文件系统/网络。目录每进程加载一次、存内存、无 TTL、无磁盘缓存。
- `src/registry.ts` — `buildRegistry`（合并连接状态）、`providersForAgent` / `connectedProvidersForAgent`、`providerOffersModel` / `getModel` / `sourcesForModel`、`nativeDefaultSourceId`（codex 优先 openai 再 xd；其余优先 xd）、`modelSupportsFastMode` / `sessionModelSupportsFastMode`（Fast 能力的唯一真相，必须按当前生效来源现查，不能用跨 provider 拍平去重的列表）、`resolveRoute`（`{providerId, modelId, agent}` → `{provider, model, routing}`，供 host 路由器落地）。
- `src/sections.ts` — `isModelVisible(override, defaultEnabled)`：可见性决策唯一真相（override ?? defaultEnabled !== false）。`buildProviderSections`：按已连接供应商顺序、逐个供应商取其 `models[agent]`（不二次排序）产出「按供应商分段」的模型列表，renderer 选择器与 main 侧 IM `/model` 卡片共用此函数。
- `src/effortResolution.ts` — `resolveEffort` / `resolveProviderSwitchEffort`：从桌面 renderer `sourceSwitch.ts` 下沉的纯逻辑，决定切模型/切来源后应落到哪一档 effort；`resolveProviderSwitchEffort` 严格 per-(供应商,模型)，不继承当前来源的当前档（修复过跨来源串档 bug）。
- `src/user-provider.ts` — `buildUserProvider(config)`：把用户自定义 `CustomProviderConfig` 展开成标准 `Provider`（`source: 'user'`、`auth.method: 'apiKey'`），与内置供应商同形状进同一 active-catalog；API key 不在此注入（存 safeStorage，host 路由 resolve 时按 `provider_key_<id>_<agent>` 读出）。
- `src/index.ts` — 唯一导出入口；`package.json` 的 `exports` 额外单独暴露 `./catalog`（指向 json 本身）、`./sections`、`./registry`、`./types`、`./effort-resolution` 子路径。

## 模块边界

- 零运行时依赖（不依赖 Electron / Node fs·net / maker-core），文件 IO 与网络拉取全部通过 `CatalogIO` 由调用方注入；连接状态（是否已连某供应商）也由 host 注入，本包不读任何存储。
- 被依赖方：`apps/desktop`（main 侧 `maker-host/active-catalog.ts`、`catalog-to-descriptors.ts`、`provider-route.ts`、`provider-service.ts`、`custom-provider-store.ts`、`title-one-shot.ts`；IM `main/im/shared/*`；renderer `hooks/useProviders.ts` 等）与 `apps/mobile`（`device-link/useDeviceProviders.ts`、`session/*ModelPicker*`）。二者都把目录/registry 结果通过各自 IPC 或 device-link 协议同步给前端。
- 对外接口即 `src/index.ts` 导出的类型 + 纯函数；不提供 class / 单例，调用方自行持有 `Catalog` / `ProviderView[]` 并传参调用。
- `catalog/providers.json` 三处复用：桌面打包兜底、OSS `cfg/providers.json` 线上最新版、dev 本地直读；desktop 侧的 `catalogDerivedModels.test.ts` 守派生结果 no-break。

## 不要做的事

- 不要绕过 `parseCatalog` 直接吃未校验的目录文本/对象——远端或本地文件格式错误必须走 parse 失败 → 调用方回退 bundled 的路径，不要静默接受半校验数据。
- 不要给 `modelSignature` 加入 `supportsFastMode` / `defaultEnabled` 之类故意允许 per-provider 分叉的字段做跨供应商一致性校验（会误伤合法差异）。
- 读某模型的 Fast 支持情况时不要用「跨 provider 拍平去重后」的模型列表——只保留了第一个 provider 的值，遇到分叉会读错；必须用 `sessionModelSupportsFastMode` 现查当前生效来源。
- 不要在本包内加磁盘缓存层——目录加载策略是 OSS 为运行时真源、bundled 为兜底，刻意无 TTL/无缓存，加缓存会让「重启即拉最新」失效。
- 不要在本包引入 Electron / Node 专属 API 或直接 import maker-core——所有 host 特定能力必须经调用方注入的 IO/回调传入，保持包可独立单测、可被 desktop 与 mobile 同时复用。
- 新增/修改供应商数据只改 `catalog/providers.json`（+ 必要时 `parseCatalog` 校验规则），不要为单个供应商特例在路由器代码里写死分支——加新供应商的设计目标就是「加数据不改路由器代码」。

## 演进备忘

_仅追加。每次重大改动留一行：日期 - 做了什么 - 原因。_
