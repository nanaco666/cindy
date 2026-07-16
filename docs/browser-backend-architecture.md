# Browser Backend Abstraction

> Owner: 浏览器自动化 / RSB 协作
> Phase 状态: 1 / 2 / 3 / 5 已合 + Phase 4-lite (evaluate) — 高复杂度 CDP action (snapshot / act:click etc. / extract / requests / responseBody / upload) 在后续 PR。
> 修改 host 端 `mcp-integrations/browser-backend/`、`mcp-integrations/browser.ts`、`rsb-browser-bridge/` 之前先读这里。

## 背景

`@lizi/browser-control-runtime` 是 vendored Playwright runtime，控制独立 Chrome（XDMaker profile, CDP 端口 18800）。它是产品最初的"agent 专用浏览器"路径。

新需求："agent 自动化操作时不再额外弹 Chrome 窗口，直接在 RSB 侧边栏的内置 webview 里跑。"

约束：
- **现有外部 Chrome 路径必须零行为变化** — 缓存 / 性能 / 行为对齐都不能动（AGENTS.md 规则 10）。
- **vendored runtime 不改** — 跟上游同步路径必须保持干净。
- **MCP tool 接口完全不变** — `packages/lizi-mcps/src/browser/` 拿到的 runtime 看着跟之前一样，零侵入。

## 架构

```
MCP `browser` tool handler  (packages/lizi-mcps/src/browser/tools.ts)
       │
       │  deps.getRuntime().call(req)         ← lizi-mcps 视角永远是 BrowserControlRuntime
       │
       ▼
[host] BackendRouter           ← 进程单例，根据 Settings 持久化值选 backend
   ├─→ ExternalChromeBackend   ← 包装 vendored runtime.call，零逻辑
   └─→ RsbWebviewBackend       ← 主进程，通过 TabRegistry 拿 WebContents
                                   │
                                   ▼
                                 Electron API (loadURL / capturePage /
                                                printToPDF / executeJavaScript / ...)
                                 + main↔renderer bridge (open/focus/close)
```

`BrowserBackend` 接口（`mcp-integrations/browser-backend/types.ts`）：
- `kind: 'external' | 'rsb-webview'` — 用于 Settings UI + 诊断
- `call(req): Promise<BrowserControlResult>` — 与 vendored runtime 字节级兼容
- `dispose(): Promise<void>` — quit-time 清理 / backend 切换时清理 outgoing

router 自己实现 `BrowserControlRuntime`（只需 `.call`），所以 lizi-mcps 不需要任何 adapter shim。

## Phase 1 — 抽象层（零行为变化）

`mcp-integrations/browser-backend/`:
- `types.ts` — 接口
- `external-chrome-backend.ts` — 包装 vendored runtime
- `router.ts` — `BackendRouter`（实现 BrowserBackend + 同时实现 BrowserControlRuntime）

`mcp-integrations/browser.ts`：
- 模块级 `vendoredRuntime` → `externalBackend` → `router` 三层
- `getBrowserMcpDeps().getRuntime()` 返回 router；lizi-mcps 整套行为不变

零侵入 lizi-mcps（package 没改任何代码）。

## Phase 2 — IPC 通道：main ↔ RSB webview

**目的**：让 main 进程能拿到 RSB `<webview>` 的 `WebContents` 句柄，以便后续 backend 操作。

新增模块 `main/rsb-browser-bridge/`：
- `registry.ts` — `TabRegistry`：维护 `tabId → {sessionId, webContentsId}` 映射 + 自动化 pin set
- `ipc.ts` — handler 注册：
  - `rsb-browser-bridge:report` (renderer→main): webview attach 后 `dom-ready` 上报。**关键安全闸**：校验 `target.getType()==='webview'` + `target.hostWebContents.id === event.sender.id`，防伪造 webContentsId 劫持。
  - `rsb-browser-bridge:release` (renderer→main): pool 释放时通知清理
  - `rsb-browser-bridge:snapshot` (renderer→main): Shell mount 时全量 reconcile（drop-only），回传 `pinnedTabIds` 让 renderer 重 mirror（防 renderer reload 后 pin 丢失）
  - `rsb-browser-bridge:pin` / `:unpin` (main→renderer): pin 状态变化广播
- `active-session.ts` — module singleton 维护"当前 focused RSB sessionId"
- `renderer-bridge.ts` — main→renderer 请求/响应桥（带 reqId 关联），Phase 3 backend 的 `open` / `focus` / `close` 走这条

renderer 端 `features/right-sidebar/lib/`：
- `browserWebviewPool.ts` 增 `pinForAutomation` / `unpinForAutomation` / `onPinChange` / `onRelease`。LRU evict 跳过 pinned tab；全 pinned 时兜底 evict 最旧（保 pool 有界）。
- `rsbBrowserBridge.ts` — renderer helper：
  - 绑定 `pool.onRelease` → ipc.release
  - 监听 main 的 pin/unpin → 同步到 pool
  - 监听 main 的 tab-op-request → 调 store action → 回报结果
  - init 时自动跑一次 snapshot reconcile

`destroyedCleanup` 用 `tabId` 当 key（不是 webContentsId）—— 两个 tab 别名同 wcid 的边界各自正确清理。

## Phase 3 — RsbWebviewBackend：低复杂度 action

实现 `BrowserBackend.call` 路由：
- **诊断**：`status` / `start` / `stop` / `profiles` / `doctor` — 静态返回 + 从 registry 读元信息
- **tab 列举**：`tabs` — 从 `TabRegistry.listBySession(activeSessionId)`，附 url/title（从 webContents.getURL/Title 拿）
- **tab 管理**：`open` / `focus` / `close` — 走 `dispatchTabOp` 到 renderer，renderer 调 store 后回报 tabId
- **navigation**：`navigate` — webContents.loadURL
- **媒体**：`screenshot` (capturePage 转 base64 PNG) / `pdf` (printToPDF 转 base64 PDF)
- **诊断 console**：`console` — `console-message` 事件订阅 + 200 条循环 buffer（Electron 36+ 与老版本签名都兼容）

**`getActiveSessionId` 注入**：host 通过 `active-session.ts` 单例，renderer Shell 在 mount + sessionId 切换时通过 `setActiveSession` IPC 上报。null 也会推（清掉 stale 引用）。

**未实现的 action**（Phase 4 + 6）：snapshot / act:click 等 / extract / requests / responseBody / upload / dialog — 返回 `BROWSER_RUNTIME_ACTION_FAILED` + 明确"not yet supported"消息。

## Phase 4-lite — act:evaluate

唯一一个 Phase 4 范围的 action 已经接入：`act:evaluate` 直接走 `webContents.executeJavaScript`，`recipe-runner` 中绝大多数 cookie / 反爬站的 evaluate 步骤都能跑。

`act:click` / `type` / `press` / `hover` / `drag` / `select` / `wait` / `clickCoords` / `resize` / `fill` 需要 CDP Input domain + ARIA snapshot 子系统，单独 PR。

## Phase 5 — Settings UI + 持久化

- `browser-backend-settings-store.ts` — 用 `createOverrideSettingsFile`，遵守 AGENTS.md 规则 20（系统默认 vs 用户 override；reset = 清 override）
  - 默认值：`kind: 'rsb-webview'`（新默认是内置 webview）
- `mcp-integrations/browser.ts::registerBrowserBackendIpc()` — 3 个 IPC：
  - `browser-backend:get-state` 返回 `{ active, systemDefault, isOverride }`
  - `browser-backend:set-kind` 切换 + 持久化
  - `browser-backend:reset` 清 override + 应用当前默认
- `components/settings/BrowserBackendSubsection.tsx` — UI（双卡片切换 + reset 按钮），渲染在 ComputerUseSection 内
- i18n: zh-CN / en / ja / ko 4 语言对齐（按 AGENTS.md 规则 18）

切换流程：用户点卡片 → IPC `set-kind` → main 端 `setActiveBrowserBackendKind()`：
1. `router.setBackend(newBackend)` — 走 `BackendRouter` 现有 swap 流程（已 dispose 旧 backend）
2. `writeBrowserBackendKind(kind)` 持久化

## Phase 6 — Recipe / Siteguide

**recipe-runner 零代码改动**。它只依赖 `deps.call`：

```
recipe step → recipe-runner.stepToRequest → deps.call(req) → router.call → 活的 backend
```

切到 rsb-webview backend 后：
- evaluate 步骤直接走 `webContents.executeJavaScript`，与 vendored Playwright 等价
- click / type / select / press 等 act 步骤目前**未支持**，Phase 4 完整 act 上线后自动激活
- navigate / extract（编译成 evaluate） / wait / requests / responseBody — 部分已支持，部分待 Phase 4

siteguide 是纯数据，与 backend 无关。

## Phase 7 — 测试覆盖

- main 单测（vitest）：`browser-backend/__tests__/` + `rsb-browser-bridge/__tests__/` — 137 个测试覆盖
  - router 双 backend swap、in-flight call 不被 retarget、dispose 错误吞掉
  - external backend 1:1 包装
  - registry: report/release/reconcile/aliased webContentsId、pin set transition、destroyed 自清
  - RsbWebviewBackend: 所有 12 个支持 action + 不支持 action 的错误返回 + 异常吞掉
  - act:evaluate: 入参 / 返回 / 错误传播
- renderer 单测：`features/right-sidebar/lib/__tests__/rsbBrowserBridge.test.ts` — 18 个测试覆盖
  - report / release / snapshot 转发 + 失败吞掉
  - tab-op 请求/响应桥
  - init idempotent
- e2e: Phase 4 完整后接

## 跨平台 (AGENTS.md 规则 15)

所有改动 IPC-纯逻辑，无 fs 路径 / 子进程相关操作:
- macOS / Windows 上 `webContents.fromId` / `capturePage` / `printToPDF` / `executeJavaScript` 行为对齐
- `<webview>` tag 在两端行为一致（partition 隔离、attach 时序）
- 没有平台特定分支

## 安全姿态

- `report` IPC 三道闸门：`fromId` 解析 + `getType()==='webview'` + `hostWebContents === sender`。无效请求 throw `INVALID_PARAMS`，攻击者拿不到主窗 webContents。
- `act:evaluate` 通过 `executeJavaScript` 在 guest webContents 跑 author/agent JS — 与 vendored runtime 在 Chromium 内的 same-origin fetch 同等暴露面，**这是设计** 而非回退。recipe `evaluate` 步必须用 `|js` 转义修饰符（在 recipe-runner 已强制）。
- partition `persist:xdmaker-browser-app` 与外部 Chrome 完全隔离 — 切换 backend 后**登录态不共享**（产品决策：Settings UI 明示）。

## 已知限制 / 待办

1. **CDP debugger**（Phase 4 主体）尚未接入：snapshot / act:click 等 / requests / responseBody / upload 不可用。
2. **active session race**：renderer 端 session 切换有 1 帧 window 期间 main 端 sessionId 不同步；backend 一律以 TabRegistry 做 targetId validation，所以最多"上一会话的 tab 列表被显示"，不会跨会话错误操作。
3. **DevTools 冲突**：用户对 RSB tab 开了 DevTools 时，未来的 CDP debugger.attach 会失败。Phase 4 实现时要 graceful error + Settings UI 提示。
4. **多窗口未来**：目前主进程只有一个主窗，`getHostWebContents()` 单一 accessor 足够；未来加多窗口时需要按 fan-out 模式重设。

## 修改本模块前的硬要求

- 改 `mcp-integrations/browser.ts` / `browser-backend/`：跑 `pnpm --filter desktop exec vitest run src/main/mcp-integrations/browser-backend src/main/rsb-browser-bridge src/renderer/features/right-sidebar`，确保 137 个测试全过。
- 任何改动如果改了 prompt 拼接 / vendored runtime 调用形态 / runtime cache 行为，必读 AGENTS.md 规则 10 + 在 PR 里写实测数据。
- 加新 action 实现时：在 RsbWebviewBackend + 单测里同步加，**外部 Chrome 行为零变化**是默认要求。
