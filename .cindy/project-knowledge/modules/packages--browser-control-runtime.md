---
id: packages--browser-control-runtime
type: module
covers:
  - packages/browser-control-runtime/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-06T07:18:19.290Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# packages--browser-control-runtime

## 是什么

`@lizi/browser-control-runtime`（`packages/browser-control-runtime/`）是浏览器自动化能力的 L1 层：一个中性、进程内的 `BrowserControlRuntime` 契约（`src/types.ts`），把 vendored 上游（代号见 `sync.mjs`，实际上游是 openclaw/openclaw 的 `extensions/browser`）浏览器内核包在后面，供 `packages/lizi-mcps/src/browser/`（L2，`lizi_browser` MCP）和 `apps/desktop/src/main/mcp-integrations/browser.ts`（L3，desktop host）消费。核心不是重写浏览器自动化逻辑，而是**整体 vendor 上游代码**（经 `pnpm sync:browser-runtime` = `scripts/browser-runtime/sync.mjs` 同步）并用一层薄 shim 替换其 `plugin-sdk` 依赖面，以便持续跟随上游更新而不失去可维护性。底层驱动是 `playwright-core`，默认启动一个专属、持久、headed 的自动化浏览器（profile 名 "XDMaker"），登录态长期保留、与用户日常 Chrome 隔离。三层架构、踩坑清单与不变量的权威文档是 `upstream/MAINTAINING.md`——改这块代码前必读，本文件只是它的摘要。

## 关键抽象 / 核心代码地标

- `src/types.ts` — 中性契约：`BrowserControlRuntime.call(request)`、`BrowserControlAction`（17 个 action，含新增的 `requests`/`responseBody` 网络原语）、`BrowserActKind`、`BrowserControlRequest`/`Result`/`ErrorCode`。这是本包对外唯一稳定接口。
- `src/runtime.ts` — `createBrowserControlRuntime(options)`：真实实现。`planDispatch(req)`（纯函数，已单测防回归）把扁平的 `BrowserControlRequest` 翻译成 vendored dispatcher 期望的 `(method, path, query, body)` HTTP 形状，再调 `dispatchBrowserControlRequest`（`_generated/extension/src/browser/local-dispatch.runtime.ts`，进程内、无 socket）。响应做**action-aware 品牌脱敏**：`DIAGNOSTIC_ACTIONS`（`status`/`profiles`/`doctor`）成功时也要 `sanitizeNaming`，因为这些是 runtime 自身诊断文本；页面/网络类 action（snapshot/extract/responseBody/navigate 等）成功时**原样返回**，脱敏会破坏页面本身合法包含上游名的内容；失败响应永远脱敏。
- `src/unavailable.ts` — `createUnavailableBrowserRuntime()`：host 未配置时的安全 stub，`call()` 永远返回 `BROWSER_RUNTIME_NOT_CONFIGURED`。
- `src/index.ts` — 包的唯一导出面；把 vendored `OpenClawConfig` 类型 re-export 为中性名 `BrowserRuntimeConfig`，把 `setBrowserRuntimeConfig` re-export 为 `setBrowserControlRuntimeConfig`——host 代码不接触上游标识符。
- `src/shim/` — 手写替换上游 `plugin-sdk` 表面（导出契约见 `upstream/shim-spec.md`）：
  - `runtime-config-snapshot.ts` — `setBrowserRuntimeConfig`/`getRuntimeConfigSourceSnapshot`。**`getRuntimeConfigSourceSnapshot()` 必须返回 `OpenClawConfig | null`**（见下方「不要做的事」）。
  - `config-contracts.ts` — `OpenClawConfig`/`BrowserConfig`/`BrowserProfileConfig` 类型定义。
  - `sanitize-naming.ts` — `sanitizeNaming`/`sanitizeNamingString`：产品中性脱敏（去除上游名/🦞），供 `runtime.ts` 的诊断响应与错误消息调用。
  - `ssrf-runtime.ts` / `ssrf-runtime-internal.ts` — fetch 外壳，组合 vendored SSRF 原语（`isBlockedHostnameOrIp`/`resolvePinnedHostnameWithPolicy`/`createPinnedDispatcher`），**不重新实现拦截决策逻辑本身**。
  - `_local/` — 小型自包含上游 helper 的忠实移植：`errors.ts`/`ports.ts`/`redact.ts`/`tmp-dir.ts`/`browser-cdp.ts`/`text-utils.ts`（含坑 #2 提到的模块加载即求值的 `CONFIG_DIR`）。
  - 其余文件（`logging-core.ts`/`routing.ts`/`security-runtime.ts`/`plugin-*.ts`/`media-*.ts` 等）是上游 `plugin-sdk` 各子面的对应替身，具体导出面对照 `upstream/shim-spec.md`。
- `src/_generated/` — **生成物，禁止手改**。由 `scripts/browser-runtime/sync.mjs`（`pnpm sync:browser-runtime`）整体重生成，含 `extension/`（vendored 浏览器核心，133 个文件见 `upstream/vendor-manifest.txt`）、`leaf/`（SSRF/安全叶子闭包）、`packages/`（net-policy + normalization-core）、`vendor/fs-safe/`（`@openclaw/fs-safe` dist，version-pinned）。改行为要改 `sync.mjs` 或 `src/shim/*`，不改这里。
- `upstream/` — 元数据与文档：`MAINTAINING.md`（权威，见上）、`browser-runtime.lock.json`（pinned commit + fs-safe 版本 + content hash，当前 pin 到 `openclaw/openclaw` commit `b972feb3f791ed38dafc27c1961dc87f2e30b210`）、`shim-spec.md`（每个 shim 必须提供的具名导出）、`vendor-manifest.txt`（133 个核心文件清单）、`STATUS.md`/`BUILD-PLAN.md`（现状/历史设计笔记）。
- `src/__tests__/` — 契约与安全回归测试：`runtime.test.ts`、`runtime-config-application.test.ts`（守护配置注入不变量，见下）、`runtime-sanitize.test.ts`、`sanitize-naming.test.ts`、`redact.test.ts`、`ssrf-guard.test.ts`/`ssrf-redirect.test.ts`（断言仍拦截 cloud-metadata 与私网 IP）。
- `scripts/smoke.mjs` — 独立 headless 驱动 runtime 的烟测脚本（不经 MCP/host）。

## 模块边界

- **依赖**：`playwright-core`、`undici`、`ws`、`ipaddr.js`、`sharp`、`@modelcontextprotocol/sdk`、`typebox`、`zod`（见 `package.json`）。不依赖 `apps/desktop`、`packages/lizi-mcps` 或任何 host/render 代码——纯 Node 侧运行时。
- **被依赖**：
  - `packages/lizi-mcps/src/browser/`（L2，`tools.ts`/`index.ts`/`recipe-runner.ts`）——通过 `BrowserMcpDeps.getRuntime()` 拿到本包创建的 runtime 实例，`extract`/`recipe`/`siteguide` 等提效能力都是在 L2 组合 `act:evaluate` 实现的，**不修改本包**。
  - `apps/desktop/src/main/mcp-integrations/`（L3，`browser.ts`/`browser-runtime-env.ts`/`browser-dispose.ts`/`browser-backend/*`）——host 在模块求值时调 `createBrowserControlRuntime({ config: buildManagedConfig() })` 造单例，并通过 `setBrowserControlRuntimeConfig` 热切配置（无需重建 runtime）。
- **对外接口形态**：唯一契约是 `BrowserControlRuntime.call(request): Promise<BrowserControlResult>`；host/MCP 层只能通过这个方法与扁平的 `BrowserControlRequest`/`Result` 类型交互，不直接触达 `_generated/**` 或 vendored 内部类型。
- **产品中性边界（硬约束）**：上游名/🦞 只允许出现在 `_generated/**`、`upstream/**`、`scripts/browser-runtime/sync.mjs`、shim 内部实现细节；任何产品可见面（Chrome profile UI、日志、报错文案、喂 agent 的 rules、Settings、i18n）禁止出现。`MANAGED_DRIVER = 'openclaw'`（定义在 `apps/desktop/.../browser.ts`）是 vendored 要求的内部 enum 值，例外保留。

## 不要做的事

- 不要手改 `src/_generated/**` 任何文件——下次 `pnpm sync:browser-runtime` 会整体覆盖，改动会静默丢失；要改行为改 `sync.mjs`（vendor 集合/import 重写）或 `src/shim/*`。
- 不要让 `src/shim/runtime-config-snapshot.ts` 的 `getRuntimeConfigSourceSnapshot()` 返回 `{config, source}` 之类的 wrapper——它必须是 `OpenClawConfig | null`。`runtime.ts`/`_generated` 侧消费处是 `getRuntimeConfigSourceSnapshot() ?? getRuntimeConfig()`，一旦返回非 null 的 wrapper，`??` 永远短路命中它、host 注入的整份 config 被静默丢弃，runtime 退化成纯 vendored 默认值（profile 显示上游默认名、颜色/目录全错）。`src/__tests__/runtime-config-application.test.ts` 专门守护这条，别删。
- 不要在 `runtime.ts` 里对页面/网络类 action（snapshot/extract/responseBody/navigate 等）的成功响应做 `sanitizeNaming`——那是用户页面内容，脱敏会破坏合法包含上游名的页面；只有 `DIAGNOSTIC_ACTIONS`（status/profiles/doctor）和所有失败响应需要脱敏。
- 不要重新实现或削弱 SSRF/路径包含的决策逻辑——那部分是 vendored 上游代码，`src/shim/ssrf-runtime.ts` 只应组合既有原语（`isBlockedHostnameOrIp`/`resolvePinnedHostnameWithPolicy`/`createPinnedDispatcher`）成 fetch 外壳。`ssrf-guard.test.ts`/`ssrf-redirect.test.ts` 会在 CI 拦下削弱这层的改动。
- 不要新增 `BrowserControlAction` 却不同步 `packages/lizi-mcps/src/browser/tools.ts` 的 `ACTIONS`——两端 exhaustive switch 会强制对齐（漏一处 typecheck 报错），但**语义**上仍需人工核对两侧行为一致。
- 不要指望改本包代码能热更新到运行中的桌面端——main/package 层代码改动需要重启桌面端（走 `pnpm restart:desktop:remote`，不要直接调 `dev:desktop*`）。
- 涉及浏览器自动化功能的任何改动，动手前先读 `upstream/MAINTAINING.md` 第 4 节踩坑清单（含 cdpPort 分配、profile color 是 Material-You 种子色而非字面色、`openBrowserForLogin` 绝不能调 `open` 等具体不变量），本文件只是摘要，不替代它。

## 演进备忘

_仅追加。每次重大改动留一行：日期 - 做了什么 - 原因。_
