# macOS Computer Use 权限引导调研与实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Settings → Computer Use 的 macOS 双权限引导改造成稳定、轻量、可恢复的原生流程，并保持 Windows/Linux 与 macOS 权限逻辑彻底隔离。

**Architecture:** 一期继续使用真实 CuaDriver 作为运行时与 TCC 权限身份。Electron main 负责流程状态、System Settings 页面推进和生命周期；Swift AppKit helper 负责贴附系统设置窗口与原生拖拽 UI；CuaDriver MCP 仅在用户确认拖拽后用于读取真实开关位置。所有异步刷新、locator 调用和 helper callback 必须受同一引导生命周期约束。

**Tech Stack:** Electron、TypeScript、React、Vitest、Swift/AppKit、macOS TCC、Model Context Protocol、CuaDriver。

## Global Constraints

- 本轮权限引导只针对 macOS；Windows/Linux 不得进入 macOS 权限流程。
- 一期继续使用 CuaDriver 的真实 runtime 和 TCC 身份，不替换为新的 Cindy companion identity。
- macOS 必须处理 Accessibility 与 Screen Recording 两项权限。
- 每项权限区分“应用已加入系统列表”和“对应开关已打开”两个阶段。
- locator 必须惰性启动；用户完成当前权限的拖拽前，不得启动 CuaDriver MCP。
- 必须保留 locator 的 `found`、`not-found`、`unavailable` 对外语义。
- native AppKit coach 接管时只关闭隐藏的 Electron fallback，不得结束 locator 或 observer。
- 完整引导关闭、取消、完成或超时后，必须释放 locator client、transport 和子进程。
- 清理 TCC 状态时只允许处理 `com.xd.cindy.computer-use`；不得触碰 Codex Computer Use 或 CuaDriver 的 TCC identity。
- 真机验收必须在 `apps/desktop` 使用 `dev:remote`，并核对 endpoint、进程路径和前台窗口，避免验收到正式版或旧实例。
- Automation 页面首屏是否改为“先渲染、后补 Computer Use 状态”不在本计划内，必须单独获得产品确认。

---

## 1. 原始需求

Computer Use 开启需要 macOS 两项系统权限：

1. Accessibility / 辅助功能
2. Screen Recording / 屏幕录制

每项权限都存在两个用户可感知阶段：

1. CuaDriver 是否已出现在 System Settings 对应权限列表中。
2. 列表中 CuaDriver 的开关是否已打开。

目标体验：

- 根据真实状态展示“拖入应用”或“打开开关”的不同原生引导。
- 引导贴附在 macOS System Settings 窗口上。
- 支持原生拖拽、开关状态回传和 Accessibility → Screen Recording 自动推进。
- 启动稳定、反馈轻量，不出现旧弹窗闪现、数秒延迟、无故关闭或多进程抖动。
- 参考 Codex Computer Use 的真实实现，而不是简单沿用 CuaDriver 默认授权弹窗。

## 2. 初始代码架构

### 2.1 Renderer

`apps/desktop/src/renderer/components/settings/ComputerUseSection.tsx`

- 展示 Computer Use 开关和权限状态。
- 原实现同时承担部分 System Settings URL 打开和页面推进职责。
- 非 macOS 权限行虽然有条件判断，但权限区块外壳仍可能在 Windows/Linux 显示。
- 非 macOS `ComputerPermissionGuideDialog` 实际无法打开，属于死 UI。

`apps/desktop/src/renderer/components/settings/computerPermissionFlow.ts`

```ts
export function isComputerPermissionReady(
  status: ComputerDriverStatus | null,
): boolean;

export function shouldStartComputerPermissionGuide(
  enabling: boolean,
  status: ComputerDriverStatus | null,
): boolean;
```

### 2.2 Electron main

`apps/desktop/src/main/computer-permission-guide/window.ts`

负责：

- native helper 生命周期。
- Electron guide/backdrop fallback。
- System Settings 窗口定位。
- drag state。
- switch observer。
- 状态广播和权限页面推进。

原始高风险点：

- switch observer 每 900ms 调用 locator。
- observer 与显式 refresh 可并发修改 `lastSwitchLocation`、drag state 和 native state。
- paused/no-drag 分支会把 `lastSwitchLocation` 清空。
- locator 观察变化会触发 `bypassPermissionProbeCache` 全量权限探测，缺少节流。
- native helper attach 前后的 Electron fallback 生命周期容易互相干扰。

`apps/desktop/src/main/computer-permission-guide/switch-target.ts`

原实现每次 `locateComputerUseSwitchTarget()` 都执行：

1. 创建 `StdioClientTransport`。
2. 启动 `cua-driver mcp`。
3. 创建 MCP `Client`。
4. connect。
5. 调用 `list_windows`。
6. 调用 `get_window_state`。
7. close。

原始超时：

```ts
const CONNECT_TIMEOUT_MS = 4_000;
const TOOL_TIMEOUT_MS = 8_000;
```

这会把每 900ms 的观察变成反复拉起 CuaDriver MCP 子进程，是延迟和不稳定的重要来源。

`apps/desktop/src/main/mcp-integrations/computer.ts`

- 负责 CuaDriver 状态、daemon、自愈、权限探测和 grant 流程。
- 非 macOS 权限状态固定为 `not_required`，证明 Windows/Linux 不应进入 macOS 引导。
- fresh/bypass probe 可能停止或重启共享 daemon，因此双实例会放大问题。

### 2.3 Native helper

`apps/desktop/native/computer-permission-guide/macos-computer-permission-guide-helper.swift`

- 使用非激活 `NSPanel` 贴附 System Settings。
- 使用 `NSDraggingSession` 实现应用拖拽。
- 通过 stdin/stdout JSON 与 Electron 通信。
- 每 0.16 秒跟踪 System Settings 窗口。

原始缺陷：helper 启动后如果 4 秒内从未看到 System Settings 窗口，会直接发送 `close-requested` 并退出。System Settings 启动慢、窗口枚举慢或 Electron/正式版并行运行时，这会表现为弹窗随机消失。

`apps/desktop/src/main/computer-permission-guide/MacComputerPermissionGuideNativeHost.ts`

- dev 环境通过 `swiftc` 编译 helper。
- packaged 环境使用预编译资源。
- 原实现实例级 binary promise 可能导致并发编译同一输出文件。

## 3. Codex Computer Use 实机调研

本机真实应用：

```text
~/.codex/computer-use/Codex Computer Use.app
```

确认信息：

```text
CFBundleIdentifier: com.openai.sky.CUAService
Executable: SkyComputerUseService
```

通过 Info.plist、binary strings 和符号表确认其包含：

- `CUAServicePermissionsWindow`
- `SystemSettingsAccessoryWindow`
- `SystemSettingsAccessoryWindowDragDelegate`
- `SystemSettingsAccessoryTransitionOverlayWindow`
- `CUAServicePermissionRowRegistry`
- `CUAServicePermissionRowTransitionSourceProbe`

同时确认使用：

- `AXIsProcessTrusted`
- `CGPreflightScreenCaptureAccess`
- `CGRequestScreenCaptureAccess`
- `CGWindowListCopyWindowInfo`
- `SCShareableContent`

结论：Codex 确实存在原生贴窗、拖拽和权限状态引导。其稳定性的关键不是某一个 UI 组件，而是 TCC identity、权限传感器和原生 UI 都位于同一个 native service 内。

Cindy 一期的现实架构不同：

```text
CuaDriver TCC identity
        ↓
CuaDriver permission/MCP probe
        ↓
Electron main lifecycle
        ↓
Swift helper / Electron fallback UI
```

因此 Cindy 必须额外解决跨进程生命周期、探测副作用、异步结果顺序和连接复用问题。

## 4. 根因分析

### 4.1 helper 首次 attach 失败即退出

System Settings 首次出现超过 4 秒时，Swift helper 会误判为窗口被关闭并结束流程。

### 4.2 locator 反复拉起 MCP 子进程

900ms observer 周期与每次 connect/call/close 组合，使 UI 延迟取决于重复进程启动和 MCP handshake。

### 4.3 状态刷新竞态

`observePermissionSwitch()`、`refreshElectronPermissionGuideState()`、drag callback、re-show 和 close/reopen 可能交叉执行：

- 旧 locator 结果覆盖新状态。
- paused/no-drag 清掉已知位置。
- 旧 lifecycle 的 helper callback 操作新 lifecycle。
- 延迟 `BrowserWindow.closed` 事件关闭新 backdrop。
- 第一次 `show()` 的旧 `initialStatus` 覆盖同生命周期后续 re-show 的新状态。

### 4.4 全量权限探测过于频繁

AX tree 可能因窗口虚拟化或瞬态状态在 `found`、`not-found`、`unavailable` 之间抖动。每次变化都 bypass cache，会放大 CuaDriver daemon 自愈成本。

### 4.5 Electron dev 与正式版双开

双开不是唯一根因，但会放大问题：

- 两个实例共享 CuaDriver 单例 daemon。
- 一个实例 fresh probe 可能停止 daemon，影响另一个实例。
- permission probe pause flag 是进程内状态，一个实例 pause 不会阻止另一个实例探测。
- 非 isolated dev 可能共享 userData。
- 各进程的 drag-state 内存缓存彼此独立。

## 5. Windows/Linux 结论

`apps/desktop/src/main/mcp-integrations/computer.ts` 对非 macOS 返回：

```ts
{
  required: false,
  status: 'not_required',
  accessibility: 'not_required',
  screenRecording: 'not_required',
  screenRecordingCapturable: 'not_required',
  canGrant: false,
}
```

因此：

- Windows/Linux 当前不需要复用 macOS 权限卡片或引导窗口。
- Windows 页面只显示 Computer Use runtime 自身状态。
- 如果未来 Windows 有独立授权模型，应单独设计页面和流程，不应复用 macOS 文案与状态机。

## 6. 目标数据流

```text
Renderer toggle / permission badge
              ↓ IPC
Electron main opens exact System Settings pane
              ↓
Guide lifecycle begins with generation token
              ↓
Swift AppKit coach starts; Electron fallback stays hidden
              ↓
User completes drag for active permission
              ↓
Persistent lazy CuaDriver MCP locator starts
              ↓
Serialized observer/refresh state update
              ↓
CuaDriver row + switch state confirmed
              ↓
Permission probe resumes / pane advances
              ↓
Accessibility → Screen Recording → complete
              ↓
Whole-guide close releases locator/helper/timers
```

## 7. File Map

| File | Responsibility |
|---|---|
| `apps/desktop/src/renderer/components/settings/ComputerUseSection.tsx` | 设置页展示、toggle/badge 用户入口 |
| `apps/desktop/src/renderer/components/settings/computerPermissionFlow.ts` | 权限是否 ready、是否启动引导的纯逻辑 |
| `apps/desktop/src/main/maker-ipc/register.ts` | Renderer → main grant/cancel/status IPC |
| `apps/desktop/src/main/computer-permission-guide/window.ts` | 权限引导状态机、生命周期、observer、System Settings 推进 |
| `apps/desktop/src/main/computer-permission-guide/switch-target.ts` | CuaDriver MCP 长连和 AX 开关定位 |
| `apps/desktop/src/main/computer-permission-guide/placement.ts` | System Settings 窗口识别和 fallback 位置计算 |
| `apps/desktop/src/main/computer-permission-guide/MacComputerPermissionGuideNativeHost.ts` | Swift helper 编译、启动、JSON 协议、取消 |
| `apps/desktop/native/computer-permission-guide/macos-computer-permission-guide-helper.swift` | 原生贴窗、拖拽、窗口跟踪与动画 |
| `apps/desktop/src/main/mcp-integrations/computer.ts` | CuaDriver daemon、权限探测和 grant runtime |
| `apps/desktop/src/main/bootstrap-electron.ts` | app ready 后 helper 预热 |
| `apps/desktop/src/main/computer-permission-guide/__tests__/electron-window.test.ts` | Electron/native 生命周期与竞态测试 |
| `apps/desktop/src/main/computer-permission-guide/__tests__/switch-target.test.ts` | locator 解析、连接复用、错误恢复测试 |
| `apps/desktop/src/main/computer-permission-guide/__tests__/MacComputerPermissionGuideNativeHost.test.ts` | dev helper 编译、取消和重试测试 |

## 8. 分阶段实施计划

### Task 1: macOS UI 隔离

**Files:**

- Modify: `apps/desktop/src/renderer/components/settings/ComputerUseSection.tsx`
- Modify: renderer i18n locale files
- Test: `apps/desktop/src/renderer/components/settings/__tests__/ComputerPermissionGuideWindow.test.ts`

**Deliverable:** Windows/Linux 不显示空的 macOS 权限区块，删除永远无法打开的非 macOS dialog。

- [x] 写失败测试，验证非 macOS 不渲染权限引导区块。
- [x] 将权限区块整体放入 darwin gate。
- [x] 删除无使用方的 dialog 状态和 i18n 文案。
- [x] 运行 renderer focused tests、typecheck、ESLint、`git diff --check`。
- [x] Commit: `62231f8a fix(computer-use): hide macOS permission UI elsewhere`

### Task 2: Native helper attach 生命周期

**Files:**

- Modify: `apps/desktop/native/computer-permission-guide/macos-computer-permission-guide-helper.swift`
- Modify: `apps/desktop/src/main/computer-permission-guide/window.ts`
- Test: `apps/desktop/src/main/computer-permission-guide/__tests__/electron-window.test.ts`

**Deliverable:** helper 从未 attach 时保持隐藏等待；只有 attach 后 System Settings 真正关闭才退出；Electron 提供 30 秒安全超时。

- [x] Swift 只在 `hasActivatedSettings === true` 后使用 0.6 秒 missing grace。
- [x] Electron 增加 `NATIVE_ATTACH_TIMEOUT_MS = 30_000`。
- [x] attach、locator 看到窗口或 guide close 时清理 timeout。
- [x] 运行 `xcrun swiftc -typecheck`、focused tests、desktop typecheck。
- [x] Commit: `d9d08b44 fix(computer-use): defer native guide dismissal until attached`

### Task 3: System Settings 页面打开职责收口到 main

**Files:**

- Modify: `apps/desktop/src/main/computer-permission-guide/window.ts`
- Modify: `apps/desktop/src/main/maker-ipc/register.ts`
- Modify: `apps/desktop/src/preload/preload.ts`
- Modify: `apps/desktop/src/renderer/vite-env.d.ts`
- Modify: `apps/desktop/src/renderer/components/settings/ComputerUseSection.tsx`
- Test: main permission-guide tests

**Interfaces:**

```ts
export function getComputerPermissionPaneUrl(
  status: ComputerStatus | null,
): string | null;

export function seedOpenedPermissionPane(url: string): void;

export async function openComputerPermissionPaneForStatus(
  status: ComputerStatus | null,
): Promise<void>;
```

Grant options：

```ts
{
  openedPaneUrl?: string;
}
```

**Deliverable:** toggle、badge 和自动推进都由 main 统一打开对应 pane，并按 lifecycle 去重。

- [x] Renderer badge 先打开 URL 后通过 `openedPaneUrl` seed main。
- [x] Toggle 流程在 helper 前由 main 打开 pane。
- [x] Renderer status listener 不再自行推进下一个 pane。
- [x] 运行 typecheck、focused tests、ESLint、`git diff --check`。
- [x] Commit: `1ee89de2 refactor(computer-use): open permission panes from main`

### Task 4: Dev helper 编译预热与并发合并

**Files:**

- Modify: `apps/desktop/src/main/computer-permission-guide/MacComputerPermissionGuideNativeHost.ts`
- Modify: `apps/desktop/src/main/bootstrap-electron.ts`
- Test: `apps/desktop/src/main/computer-permission-guide/__tests__/MacComputerPermissionGuideNativeHost.test.ts`

**Interface:**

```ts
export function prewarmMacComputerPermissionGuideHelper(): void;
```

**Deliverable:** dev app ready 后 3 秒低优先级预编译；并发调用复用同一模块级 build promise；失败后允许重试。

- [x] 将 helper binary promise 提升到模块级。
- [x] 添加并发 join 和失败后重试测试。
- [x] `createWindow()` 后 3 秒执行 prewarm，仅 darwin + dev 生效。
- [x] Commit: `e314b204 chore(computer-use): prewarm macOS permission helper`

### Task 5: Persistent MCP locator

**Files:**

- Modify: `apps/desktop/src/main/computer-permission-guide/switch-target.ts`
- Modify: `apps/desktop/src/main/computer-permission-guide/window.ts`
- Test: `switch-target.test.ts`
- Test: `electron-window.test.ts`

**Interface:**

```ts
export function closeComputerUseSwitchLocator(): Promise<void>;
```

**Deliverable:** guide lifecycle 内复用一个惰性 MCP client/transport/session，操作串行，失败重建，完整关闭时释放。

- [x] 第一次 locate 时才 connect。
- [x] 同一成功连接复用 client、transport、子进程和 session id。
- [x] locate/close 使用同一 promise queue 串行。
- [x] rejected、timeout 和 `CallToolResult.isError === true` 都丢弃连接。
- [x] close 幂等、吞 close error、清空缓存。
- [x] native handoff 不关闭 locator；whole-guide close 关闭 locator。
- [x] 完成 lazy import、复用、串行、错误重连和生命周期测试。
- [x] Commits: `9c928ab1`, `c9a6fdb6`, `18e0fdbc`, `c9df1ce0`

### Task 6A: 状态更新串行化与 lifecycle ownership

**Files:**

- Modify: `apps/desktop/src/main/computer-permission-guide/window.ts`
- Modify: `apps/desktop/src/main/computer-permission-guide/MacComputerPermissionGuideNativeHost.ts`
- Test: `electron-window.test.ts`
- Test: `MacComputerPermissionGuideNativeHost.test.ts`

**Deliverable:** observer、显式 refresh、drag callback 和 re-show 通过同一 serializer；旧生命周期结果和 callback 不得影响新生命周期。

- [x] 添加 module-owned Promise serializer。
- [x] 添加 guide lifecycle generation。
- [x] observer 已获得 location 时直接复用，避免二次 locator。
- [x] paused/no-drag 和 `unavailable` 保留有效 location。
- [x] `not-found` 仍清理当前权限的 stale drag hint。
- [x] helper dismiss 在 binary preparation 期间也具有终止语义。
- [x] native callback、attach timeout、BrowserWindow event 绑定 generation 和 owner instance。
- [x] active permission 未拖拽时，无论 probe pause 状态如何都不得启动 locator。
- [x] re-show status 写入 serializer；native host 初始状态读取最新 `guideStatus`。
- [x] 完成 close/reopen、旧 callback、延迟 closed、第二权限 drag gate 和 same-lifecycle re-show 测试。
- [x] Commits: `516ba517`, `4a014f3d`, `15f79870`, `5f5ffc61`, `26e88cb5`

### Task 6B: observer 全量探测节流

**Files:**

- Modify: `apps/desktop/src/main/computer-permission-guide/window.ts`
- Test: `apps/desktop/src/main/computer-permission-guide/__tests__/electron-window.test.ts`

**Required constant:**

```ts
const PERMISSION_PROBE_BYPASS_MIN_INTERVAL_MS = 2_000;
```

**Deliverable:** observer AX 状态抖动不会连续触发 full bypass probe；显式用户动作保持立即执行。

- [x] 首次 observer bypass 立即执行。
- [x] 2 秒窗口内 observer 立即执行普通缓存 refresh，并合并一个 trailing full bypass。
- [x] explicit preflight/drag bypass 立即执行并覆盖 pending trailing work。
- [x] trailing callback 使用当前 lifecycle state，不捕获旧 status/location。
- [x] close/reopen 清理 timer、timestamp 和 lifecycle ownership。
- [x] 修复 review 发现的队列顺序竞态：显式 bypass 在串行执行边界再次失效 trailing token。
- [x] 覆盖 fired-but-queued trailing callback 被 explicit 或 close/reopen 失效的确定性测试。
- [ ] 在另一台设备完成最终 simplify 和独立 review。

当前已提交：

- `7382fe64 fix(computer-use): throttle observer permission probes`
- `cd7027d7 refactor(computer-use): simplify permission probe throttle`
- `ea84bc55 fix(computer-use): invalidate queued observer probes`

### Task 7: 小修与回归收尾

**Files:**

- Modify: `apps/desktop/src/main/computer-permission-guide/window.ts`
- Modify: `apps/desktop/src/main/computer-permission-guide/placement.ts`
- Test: permission-guide focused tests

**Deliverable:** 删除死分支、统一 guide 尺寸常量、确认 fallback drag-state 写入和回滚语义。

- [ ] 为重复 guide width/height 和死分支写回归/结构测试。
- [ ] 从 `window.ts` 删除不可达逻辑。
- [ ] 将 `GUIDE_WINDOW_WIDTH`、`GUIDE_WINDOW_HEIGHT` 收口到一个共享来源。
- [ ] 验证 Electron fallback 只在确认 copy drag 后写入 drag state。
- [ ] 验证取消、失败和 restore timeout 不留下错误 drag state。
- [ ] 运行 permission-guide tests、ESLint、desktop typecheck、`git diff --check`。
- [ ] 提交并独立 review。

## 9. 测试与验收

### 9.1 自动测试

```bash
cd apps/desktop
pnpm exec vitest run src/main/computer-permission-guide/__tests__
pnpm exec eslint \
  src/main/computer-permission-guide/window.ts \
  src/main/computer-permission-guide/switch-target.ts \
  src/main/computer-permission-guide/MacComputerPermissionGuideNativeHost.ts \
  src/main/computer-permission-guide/__tests__/electron-window.test.ts \
  src/main/computer-permission-guide/__tests__/switch-target.test.ts \
  src/main/computer-permission-guide/__tests__/MacComputerPermissionGuideNativeHost.test.ts
pnpm typecheck
cd ../..
git diff --check
```

Swift：

```bash
xcrun swiftc -typecheck \
  apps/desktop/native/computer-permission-guide/macos-computer-permission-guide-helper.swift
```

### 9.2 macOS 真机验收

启动：

```bash
cd apps/desktop
pnpm dev:remote
```

必须核对：

1. 当前 endpoint 是 remote auth endpoint，不是 localhost 登录链路。
2. Electron 进程路径来自当前 `feat/computer-use` checkout。
3. 前台窗口是当前 dev 实例，不是正式版或旧 dev 进程。
4. 当前 userData 是否按预期 isolated；避免与正式版共享数据库和实例锁。

状态矩阵：

| Accessibility | Screen Recording | 期望引导 |
|---|---|---|
| 未加入列表 | 任意 | Accessibility 拖入应用 |
| 已加入、开关关闭 | 任意 | Accessibility 开关定位 |
| 已开启 | 未加入列表 | 自动打开 Screen Recording，并显示拖入应用 |
| 已开启 | 已加入、开关关闭 | Screen Recording 开关定位 |
| 已开启 | 已开启但不可捕获 | 保持 Screen Recording 修复状态，不误判完成 |
| 已开启 | 已开启且可捕获 | 引导完成并释放 helper/locator |

稳定性检查：

- System Settings 慢启动超过 4 秒，native helper 不应自杀。
- helper 30 秒始终无法 attach，Electron 应取消并广播，而不是永久空等。
- native attach 后关闭 System Settings，0.6 秒 grace 后结束。
- native 接管时不显示旧 Electron dialog 闪屏。
- observer 轮询期间只存在一个 locator MCP 子进程。
- 切换权限页面时，当前权限未拖拽前不会重新启动 locator。
- 快速 close/reopen 后，旧 helper callback、旧 timer、旧 window closed event 不影响新引导。
- 双开正式版与 dev 时，明确只验收当前 dev；记录 daemon 互相影响但不把双开当作唯一根因。

## 10. 另一台设备继续开发

当前仓库关系：

```text
upstream: https://github.com/xindong/cindy-moved.git
fork:     https://github.com/nanaco666/cindy-moved.git
branch:   feat/computer-use
```

当前设备将分支推到 fork：

```bash
git remote add fork https://github.com/nanaco666/cindy-moved.git
git push -u fork feat/computer-use
```

另一台设备：

```bash
git clone https://github.com/nanaco666/cindy-moved.git
cd cindy-moved
git switch --track origin/feat/computer-use
pnpm install
cd apps/desktop
pnpm dev:remote
```

功能尚未完成时建议在 fork 内创建 Draft PR：

```bash
gh pr create \
  --repo nanaco666/cindy-moved \
  --base main \
  --head feat/computer-use \
  --draft \
  --title "feat(desktop): stabilize macOS Computer Use permission guide"
```

## 11. 当前快照

截至本文档创建时：

- Branch: `feat/computer-use`
- 最新功能提交: `ea84bc55`
- Task 1–5: 完成并 review clean。
- Task 6A: 完成并最终 review `PASS / APPROVED`。
- Task 6B: queue race 已修复，53 个 permission-guide tests 通过；最终 simplify/re-review 留给另一台设备继续。
- Task 7: 未开始。
- Draft PR / fork push: 本次交接创建。
- Live `dev:remote` final acceptance: 尚未执行。
