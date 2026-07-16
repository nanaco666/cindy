# Computer Use / Cua Driver 问题排查与修复计划

类型：设计 / 排查记录
状态：待评审草案

相关代码：
- `apps/desktop/src/main/mcp-integrations/computer.ts`
- `apps/desktop/src/main/mcp-integrations/__tests__/computer.test.ts`
- `packages/lizi-mcps/src/computer/**`

## 背景

Windows 上的 `lizi_computer` 由本机 `cua-driver` 支撑。XDMaker 会为每个 agent session 启动一个长连接的 `cua-driver mcp` stdio client，并把生成的 Cua driver session id 注入到需要 session 的工具调用里。

开发者经常会同时打开两个 XDMaker：

- release app：`E:\xdt-maker\xdt-maker.exe`
- remote dev app：`D:\xdt-maker\node_modules\electron\dist\electron.exe`

两者共享同一个机器级 Cua daemon，也就是 `cua-driver serve` 和命名管道 `\\.\pipe\cua-driver`。但每个 XDMaker 进程都会拥有自己的 `cua-driver mcp` 子进程和内存里的 MCP client。

## 已观察到的问题

### 1. daemon 没有自动启动

最初 `lizi_computer status` 返回：

```text
daemonRunning: false
daemonStatus: Cua Driver daemon is not running
```

PowerShell 能看到遗留的 `cua-driver.exe mcp` 子进程，但没有运行中的 `serve` daemon。

Windows 计划任务 `cua-driver-serve` 已注册，但指向了过期路径：

```text
C:\Users\XINDONG\.cua-driver\packages\releases\0.6.5-x86_64-pc-windows-msvc\cua-driver.exe
```

而 XDMaker 当前解析到的安装路径是：

```text
C:\Users\XINDONG\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe
```

执行 Cua 官方安装脚本后，Cua Driver 从 `0.6.5` 升级到 `0.6.8`，junction 被重建，计划任务也被重新注册：

```text
cua-driver-rs 0.6.8 installed
Auto-start: 'cua-driver-serve' is registered at RunLevel=Highest
```

执行 `cua-driver autostart kick` 后，daemon 状态恢复：

```text
Cua Driver daemon is running
socket: \\.\pipe\cua-driver
```

### 2. release/dev 并存会留下失效的 MCP client

当 release 和 dev 两个 XDMaker 同时打开时，其中一个实例可能重启或影响共享的 Cua daemon，而另一个实例仍持有已经失效的内存态 `cua-driver mcp` client。

现象：

```text
lizi_computer status: ok, daemon running
lizi_computer get_screen_size: Not connected
lizi_computer move_cursor: Not connected
```

这是 XDMaker 主机侧的恢复问题。原有失效 session 恢复逻辑已经处理了这些错误：

```text
transport closed
read ECONNRESET
write EPIPE
connection closed
stream closed
session ended; tool call ignored
```

但没有把 Cua 返回的 `Not connected` 视为失效的 MCP client。

### 3. Cua Driver 的窗口 / UIA 操作在本机仍会超时

修复 daemon 启动和 MCP 连接状态后，下面这些调用仍然会通过 XDMaker 和 Cua CLI 双方超时：

```text
list_windows
list_apps
get_accessibility_tree
get_window_state
launch_app
```

下面这些轻量调用可以成功：

```text
get_screen_size
get_cursor_position
move_cursor
health_report
debug_window_info
```

`debug_window_info` 能看到 release XDMaker 进程和顶层窗口：

```text
exe_path: E:\xdt-maker\xdt-maker.exe
title: XDMaker
class_name: Chrome_WidgetWin_1
```

直接运行 `cua-driver-uia.exe` 会返回：

```text
A referral was returned from the server
```

`Get-AuthenticodeSignature` 显示 `cua-driver.exe` 和 `cua-driver-uia.exe` 都是 `NotSigned`。`cua-driver-uia.exe` 内能看到 `UIAccess` / `requestedExecutionLevel` 相关 manifest 字符串，而安装位置是 `%LOCALAPPDATA%` / `.cua-driver` 下的用户目录 junction。

这更像是 Cua Driver / Windows UIAccess 兼容性或打包问题，不是 XDMaker MCP session 管理问题。Cua `health_report` 虽然显示 `UIAutomation is reachable`，但它只说明浅层 UIA COM 初始化可用，不代表真实 UIA 枚举不会卡住。

## 研究结论

目前最可能的根因是：Cua Windows 的窗口 / 应用枚举卡在 UI Automation 枚举路径里；同时可选的 `cua-driver-uia.exe` UIAccess helper 因为未签名且安装在用户可写目录下，不能被 Windows 正常启动。

判断依据：

- Cua `list_windows` 实现会先走 Win32 `EnumWindows`，再无条件做 UIA desktop root `FindAll(TreeScope_Children)` 增强。
- Cua `list_apps` 会先调用 `list_windows`。
- `debug_window_info` 能看到窗口，说明轻量 Win32 路径并非完全不可用。
- `health_report` 的 Windows UIA 检查只是 `CoCreateInstance(CUIAutomation)` 级别的浅层探测，不会执行 root walk 或枚举 children。
- `cua-driver-uia.exe --help` 触发 `A referral was returned from the server`，符合 Windows UIAccess 可执行文件未签名 / 非安全安装路径被拒绝启动的特征。

公开资料依据：

- Microsoft 文档要求 UIAccess 应用必须 Authenticode 签名、可信，并安装在安全位置，例如 `Program Files`、`Program Files (x86)` 或 `Windows\System32`。
- `EnableSecureUIAPaths = 1` 时，Windows 会限制 UIAccess 应用从安全目录启动；即使关闭该策略，签名检查仍然存在。
- Cua 公开 issue `trycua/cua#1602` 讨论过 Windows `uiAccess=true`、签名和安全安装路径问题，当前用户目录安装和未签名二进制不满足完整 UIAccess 要求。

结论：

- XDMaker 可以修复失效 MCP client、超时恢复和降级兜底。
- XDMaker 不应该尝试通过移动 unsigned Cua binary、关闭 `EnableSecureUIAPaths` 等方式绕过 Windows 安全模型。
- Cua 的 UIA 枚举超时应作为上游问题反馈，同时 XDMaker 需要提供本地兜底逻辑，避免 agent 完全失去窗口上下文。

## 已实现的 XDMaker 修复

相关文件：`apps/desktop/src/main/mcp-integrations/computer.ts`

### 失效连接的 `Not connected` 恢复

已实现：

1. 把 `Not connected` 视为已失效的 Cua MCP client。
2. 旋转生成的 driver session id。
3. 清理失效的 stdio client。
4. 重新创建新的 `cua-driver mcp` client。
5. 自动重试一次。

这个修复针对 release/dev 并存时，一个 app 因共享 daemon 或另一个 XDMaker 实例变化而持有失效 MCP client 的问题。

这里的 `Not connected` 指 Cua MCP server 快速返回的失效连接信号，可能以三种形态出现：

- thrown error
- `isError` MCP result
- plain text result

该修复会将这三种形态统一归为失效连接，重建本地 MCP client 后重试一次。

它不处理 Cua 在执行 UIA / window 工作时的长时间超时，例如：

```text
list_windows
list_apps
get_window_state
get_accessibility_tree
launch_app
```

这些仍被视为 Cua Driver / Windows UIAccess 上游问题。

### 轻量工具超时恢复

第二类问题出现在 release/dev 并存测试中：长时间 Cua MCP 调用超时后，dev Electron 进程下会堆积多个 `cua-driver.exe mcp` 子进程；同时 XDMaker 内的轻量状态读取也开始超时。但直接通过 Cua CLI 调用同类能力仍能成功。

这说明共享 daemon 可以是健康的，但某个 XDMaker 进程持有的 stdio MCP child 已经卡住。

为避免外层 `lizi_computer` MCP 调用在 XDMaker 还没清理完成前就超时，轻量工具现在使用更短的内部 timeout。

具备可靠一次性 CLI 等价能力的基础状态工具，在 MCP 超时或失效连接后直接兜底调用：

```text
cua-driver call <tool>
```

CLI 兜底调用会向 stdin 写入空 JSON 参数 `{}`，并使用独立的短 timeout，避免依赖状态检查的 3 秒 timeout，也避免在 Windows 上因为缺少 stdin 参数而退化回 MCP 重试。

覆盖工具：

```text
get_screen_size
get_cursor_position
```

其它轻量 session / cursor 工具则在超时后重建 Cua MCP client 并重试一次：

```text
get_agent_cursor_state
move_cursor
```

长时间 UIA / window 操作超时后仍不做第二次 Cua 重试，避免一个已知会卡住的 Cua UIA 调用让用户等待两倍时间。当前行为是：

- Windows `list_windows` / `list_apps`：触发清理后进入本地 Win32 降级兜底。
- 非 Windows `list_windows` / `list_apps`：保持原始 timeout / error 行为。
- `get_accessibility_tree` / `get_window_state` / `launch_app`：保持清晰失败，不伪造 UIA 结果。

```text
list_windows
list_apps
get_accessibility_tree
get_window_state
launch_app
```

### Windows `list_windows` / `list_apps` 降级兜底

已实现：

1. Cua `list_windows` / `list_apps` 成功时仍优先返回 Cua 结果。
2. 仅 Windows 上 Cua `list_windows` / `list_apps` 超时后，调用 XDMaker 本地 Win32 fallback；参数错误、权限错误、transport 错误等非 timeout failure 继续返回原始错误。
3. fallback 使用 PowerShell + `Add-Type` 调用 Win32 API：
   - `EnumWindows`
   - `IsWindowVisible`
   - `GetWindowTextW`
   - `GetWindowThreadProcessId`
   - `GetWindowRect`
   - `IsIconic`
4. fallback helper 有独立短 timeout，避免 Cua 超时后再引入新的长时间卡点。
5. fallback window record 显式标记为降级结果：
   - `source: "xdmaker_win32_fallback"`
   - `accessibility_unavailable: true`
   - 不包含 `element_index`
6. `list_windows` fallback 保留本地过滤：
   - `pid`
   - `process_name`
   - `workspace_root`（需要额外 process snapshot）
   - `query`
   - `on_screen_only`
7. `list_apps` fallback 只返回 running apps，并显式标记：
   - `running_apps_only: true`
   - `installed_app_metadata_unavailable: true`

这部分不修改 Cua Driver binary、installer、daemon autostart 或 UIAccess packaging；也不建议关闭 `EnableSecureUIAPaths` 或移动 unsigned binary 到安全目录。

## 已有回归测试

相关文件：`apps/desktop/src/main/mcp-integrations/__tests__/computer.test.ts`

新增 / 更新测试覆盖：

```text
rotates the driver session and retries once when cua-driver reports not connected
rotates the driver session and retries once when cua-driver returns Not connected as an error result
falls back to one-shot CLI when cua-driver returns Not connected as plain text on a basic state tool
falls back to one-shot CLI for basic state tools after a cua-driver MCP timeout
ignores stdin stream errors while the one-shot CLI fallback process resolves normally
falls back to one-shot CLI for get_cursor_position after a cua-driver MCP timeout
falls back to one-shot CLI when get_screen_size returns Not connected as an error result
retries lightweight non-CLI tools once after a cua-driver MCP timeout
retries move_cursor once after a cua-driver MCP timeout and reapplies cursor style
does not retry long window enumeration tools after a cua-driver MCP timeout
does not invoke Win32 fallback when Cua list_windows succeeds on Windows
does not use the reserved PowerShell $PID variable in the Win32 fallback script
returns degraded Win32 list_windows data when Windows Cua list_windows times out
does not invoke Win32 fallback for stale, transport, permission, or non-timeout list_windows failures on Windows
does not invoke Win32 fallback when non-Windows Cua list_windows times out
applies process name, query, on-screen, and workspace filters to Win32 list_windows fallback
keeps Win32 list_windows fallback process metadata when the workspace process snapshot fails
keeps Win32 list_windows fallback process fields when the workspace process snapshot is partial
returns the original list_windows failure when Win32 fallback fails
does not hang when Win32 list_windows fallback times out
does not invoke Win32 fallback when Cua list_apps succeeds on Windows
returns degraded running-app data when Windows Cua list_apps times out
```

验证命令：

```text
pnpm --filter desktop exec vitest run src/main/mcp-integrations/__tests__/computer.test.ts
```

当前结果：

```text
64 passed
```

## 后续验证与未来工作

Windows `list_windows` / `list_apps` 降级兜底已在 XDMaker 主机侧实现。剩余工作主要是受影响 Windows 机器上的人工验证、上游 Cua Driver 反馈，以及产品是否需要在 renderer 层展示“当前为降级模式”的提示。

### 已完成目标

1. Cua Driver 正常时，仍优先使用 Cua 的结果。
2. Windows 上 Cua 窗口 / 应用枚举超时时，XDMaker 返回可用兜底结果，而不是只返回错误。
3. 兜底结果显式标记为降级结果，避免 agent 误以为存在 UIA element index 或完整 accessibility tree。
4. 不延长已知会卡住的 Cua UIA 调用等待时间：Cua 只等待一次，失败后进入短 timeout Win32 fallback。

### 仍需人工验证

- 在受影响 Windows 机器上，确认 Cua `list_windows` / `list_apps` timeout 后能返回 Win32 fallback data。
- 确认 fallback 后 `get_screen_size` / `get_cursor_position` 仍保持可用。
- 确认失败的 `cua-driver.exe mcp` 子进程会被清理，不持续堆积。
- 确认 release/dev 并存时，一个 app 的 UIA 枚举失败不永久破坏另一个 app 的轻量状态读取。

### 未来可选工作

- 如果 PowerShell + `Add-Type` fallback 在部分 Windows 环境不稳定，再评估小型 native helper 或 Node-side Windows helper。
- 如果产品决定展示降级模式提示，再单独设计 renderer UI；本阶段不改 renderer。
- 继续把 Cua UIA timeout / `cua-driver-uia.exe` UIAccess 问题反馈给上游。

## 已完成实施记录

### 目标

1. Cua Driver 正常时，仍优先使用 Cua 的结果。
2. Windows 上 Cua 窗口 / 应用枚举超时时，XDMaker 返回可用兜底结果，而不是只返回错误。
3. 兜底结果必须显式标记为降级结果，避免 agent 误以为存在 UIA element index 或完整 accessibility tree。
4. 不延长已知会卡住的 Cua UIA 调用等待时间。

### 实际改动范围

#### 范围内

`apps/desktop/src/main/mcp-integrations/computer.ts`

- 为 Windows `list_windows` 增加兜底逻辑。
- 兜底逻辑只在 Cua `list_windows` 超时后触发，非 timeout 的真实执行失败继续返回原始错误。
- 尽量复用或扩展现有 process snapshot helper。
- 兜底 window record 至少包含：
  - `window_id` / HWND
  - `pid`
  - `app_name` 或进程名
  - `title`
  - `bounds`
  - `is_on_screen`
  - `source: "xdmaker_win32_fallback"`
  - `accessibility_unavailable: true`
- 尽可能保留现有本地过滤：
  - `pid`
  - `process_name`
  - `workspace_root`
  - `query`
  - `on_screen_only`
- 为 Windows `list_apps` 增加兜底逻辑。
- Cua timeout 后仍继续清理失效 MCP client，避免卡住的 `cua-driver mcp` 子进程堆积。

`apps/desktop/src/main/mcp-integrations/__tests__/computer.test.ts`

- 增加 `list_windows` 兜底回归测试。
- 增加 `list_apps` 兜底回归测试。
- 覆盖兜底结果的降级标记。
- 覆盖 Cua 成功时不触发兜底逻辑。

`docs/computer-use-cua-driver-investigation.md`

- 随实现同步更新兜底行为、测试结果和人工验证记录。

#### 已采用方案

- 在 `computer.ts` 中新增 Windows 专用窗口快照 helper。
- 使用 PowerShell + `Add-Type` 调 Win32 API：
  - `EnumWindows`
  - `IsWindowVisible`
  - `GetWindowTextW`
  - `GetWindowThreadProcessId`
  - `GetWindowRect`
  - `IsIconic`

兜底行为：

- 只在 Cua `list_windows` / `list_apps` 超时后调用。
- 不在 macOS / Linux 上调用。
- helper 自身必须有短 timeout，避免产生新的长时间卡死。

未采用 / 未来备选方案：

- 如果 PowerShell / Add-Type 原型不稳定，再考虑新增小型 native helper 或 Node-side Windows helper。
- 本次未引入 native helper。

#### 范围外

- 不修改 Cua Driver binary、installer、daemon autostart 或 UIAccess packaging。
- 不建议用户关闭 `EnableSecureUIAPaths`。
- 不把 unsigned Cua binary 移到 `Program Files` 当作 workaround。
- 不从兜底 window record 伪造 UIA `element_index`。
- 不对 `get_window_state` / `get_accessibility_tree` 的 Cua UIA timeout 做自动重试。
- 不修改 click/type/keyboard 行为。
- 本阶段不改 renderer UI；如果之后产品决定展示降级模式提示，再单独设计。

### 当前行为

`list_windows`：

- Cua 成功时，返回 Cua 结果，保持现有 XDMaker enrich/filter 行为。
- Windows 上 Cua 超时时，返回 XDMaker Win32 兜底 windows。
- 兜底 records 必须显式标记为降级结果。
- 兜底 records 不能包含 `element_index`，也不能声称支持 accessibility tree。

`list_apps`：

- Cua 成功时，返回 Cua 结果。
- Windows 上 Cua 超时时，基于运行中进程和窗口归属返回降级 app list。
- 如果兜底逻辑不能可靠覆盖 installed apps，只返回 running apps，并标记该限制。

`get_window_state` / `get_accessibility_tree`：

- Cua UIA 路径超时时继续清晰失败。
- 不从兜底窗口枚举结果伪造 accessibility tree。

## 自动化测试覆盖

### 自动化自测

本次运行定向测试：

```text
pnpm --filter desktop exec vitest run src/main/mcp-integrations/__tests__/computer.test.ts
```

已覆盖的单测 / 回归用例：

1. Cua `list_windows` 成功。
   - 断言不调用兜底 helper。
   - 断言保留现有 Cua result shape。

2. Windows 上 Cua `list_windows` 超时。
   - 断言触发失效 Cua MCP client cleanup。
   - 断言调用兜底 helper。
   - 断言返回窗口包含 HWND / pid / title / bounds。
   - 断言兜底 metadata 包含 `source: "xdmaker_win32_fallback"` 和 `accessibility_unavailable: true`。

3. 非 Windows 上 Cua `list_windows` 超时。
   - 断言不调用兜底逻辑。
   - 断言保留原始 timeout / error 行为。

4. 兜底 `list_windows` 支持过滤：
   - `pid`
   - `process_name`
   - `query`
   - 有 process snapshot 时支持 `workspace_root`

5. Cua `list_apps` 成功。
   - 断言不调用兜底 helper。

6. Windows 上 Cua `list_apps` 超时。
   - 断言基于运行中进程 / 窗口数据返回兜底 app list。
   - 断言带降级 metadata。

7. 兜底 helper 自己失败或超时。
   - 断言 XDMaker 不挂起。
   - 断言返回原始 Cua failure。

8. 现有恢复测试继续通过：
   - `Not connected` thrown error
   - `Not connected` `isError` result
   - `Not connected` plain text
   - 基础状态 CLI 兜底
   - 轻量 MCP retry
   - 长 UIA timeout no-retry
   - 非 timeout 的 `list_windows` failure 不触发 Win32 fallback
   - workspace process snapshot 失败时保留 Win32 fallback 自带 process metadata
   - workspace process snapshot 局部缺字段时保留 Win32 fallback 已有 process fields

可选更广检查：

```text
pnpm --filter desktop typecheck
```

### 人工测试

#### 准备

1. 启动 release XDMaker。
2. 启动 remote dev XDMaker：

```text
pnpm restart:desktop:remote
```

3. 确认 Cua daemon：

```text
cua-driver status
```

4. 确认直接 CLI 基础能力正常：

```text
'{}' | cua-driver call get_screen_size
'{}' | cua-driver call get_cursor_position
```

#### 人工测试 A：基础状态读取必须稳定

在 dev app agent session 中调用：

```text
status
get_screen_size
get_cursor_position
```

预期：

- `status` 成功。
- `get_screen_size` 成功。
- `get_cursor_position` 成功。
- 失败后不会持续堆积 `cua-driver.exe mcp` 子进程。

#### 人工测试 B：`list_windows` 降级兜底

在 dev app agent session 中调用：

```text
list_windows
```

当 Cua 仍然超时时，预期：

- 用户可见调用返回兜底 window list，而不是只返回 timeout。
- 至少能看到 XDMaker release/dev 窗口。
- record 包含 pid / title / window_id / bounds。
- record 标记为降级结果 / `accessibility_unavailable`。

用进程列表辅助核对：

```text
Get-Process -Name xdt-maker,electron,cua-driver -ErrorAction SilentlyContinue |
  Select-Object Id,ProcessName,Path,MainWindowTitle
```

#### 人工测试 C：`list_apps` 降级兜底

在 dev app agent session 中调用：

```text
list_apps
```

当 Cua 仍然超时时，预期：

- 用户可见调用返回 running-app 兜底数据，而不是只返回 timeout。
- XDMaker release/dev 应可被发现。
- 如果兜底逻辑只覆盖 running apps，结果需要说明 installed-app 覆盖范围已降级。

#### 人工测试 D：UIA 工具仍然清晰失败

调用：

```text
get_accessibility_tree
get_window_state
```

在受影响机器上，预期：

- 这些工具可能仍会 timeout / fail，因为它们依赖 Cua UIA tree / screenshot state。
- 它们不应污染后续 `get_screen_size` / `get_cursor_position`。
- 它们不应留下多个 stuck `cua-driver.exe mcp` 子进程。

#### 人工测试 E：release/dev 并存

同时打开 release 和 dev：

1. 在 dev 触发 `list_windows`。
2. 在 dev 触发 `get_screen_size`。
3. 在 dev 触发 `get_cursor_position`。
4. 如果条件允许，在 release 里重复同样测试。

预期：

- 一个 app 的 Cua UIA enumeration 失败，不应永久破坏另一个 app 的基础状态读取。
- 失效的本地 MCP child 应被清理，或被兜底逻辑绕过。

### 验收标准

- 定向单测通过。
- 在受影响 Windows 机器上，`list_windows` / `list_apps` 失败后，`get_screen_size` 和 `get_cursor_position` 仍保持可用。
- Windows 上 Cua 超时时，`list_windows` 返回兜底 window data。
- Windows 上 Cua 超时时，`list_apps` 返回兜底 running-app data。
- 降级兜底结果有明确标记，agent 不会误以为具备 UIA / element-index 支持。
- 不需要新增破坏系统安全模型的 Windows 配置步骤。

## 现有验证计划

### 主机侧失效连接恢复

1. 启动 release XDMaker。
2. 启动 remote dev XDMaker：

```text
pnpm restart:desktop:remote
```

3. 确认 release 和 dev 两个窗口都打开。
4. 重启或 kick Cua daemon：

```text
cua-driver stop
cua-driver autostart kick
```

5. 在每个 app 中调用轻量 `lizi_computer` 工具：

```text
status
get_screen_size
get_cursor_position
move_cursor
```

修复后的预期：

- 第一次非 status 调用可能遇到 `Not connected`。
- XDMaker 应关闭并重建本地 `cua-driver mcp` client。
- 用户可见工具调用应在一次重试后成功。

### Cua Driver UIA timeout

用 Cua CLI 直接验证，避免 XDMaker wrapper 干扰：

```text
'{}' | cua-driver call get_screen_size
'{}' | cua-driver call get_cursor_position
'{"pid":<xdt-maker-pid>}' | cua-driver call debug_window_info
'{"pid":<xdt-maker-pid>}' | cua-driver call list_windows
'{"pid":<xdt-maker-pid>,"window_id":<hwnd>,"capture_mode":"vision"}' | cua-driver call get_window_state
```

受影响机器上的当前预期：

- screen / cursor 基础调用成功。
- `debug_window_info` 成功。
- `list_windows` / `get_window_state` 可能继续超时。

如果 Cua Driver `0.6.8` 上仍然复现，应给 Cua 上游提交 issue，附带：

- Windows 版本：`10.0.19045.6456`
- Cua Driver 版本：`0.6.8`
- `health_report` 显示 ok
- `debug_window_info` 能看到 XDMaker 窗口
- `list_windows`、`list_apps`、`get_window_state`、`launch_app` 超时
- 直接运行 `cua-driver-uia.exe --help` 返回 `A referral was returned from the server`
- `Get-AuthenticodeSignature` 显示两个 binary 都是 `NotSigned`

## 待评审问题

1. `Not connected` retry 是否应限制为精确 Cua error，还是当前沿用大小写不敏感 substring 匹配即可？
2. 轻量工具 timeout 后是否都应该立即 retry，还是只对当前列出的工具开放？
3. `status` 是否应默认包含 `doctor`？排查中发现 daemon 和基础调用可用时，`doctor` 仍可能 timeout。当前方向是只在显式 deep status 时运行。
4. release/dev 实例是否需要通过机器级 lock 协调 daemon restart，还是本地 MCP client 自愈已经足够？
5. Settings 是否需要提供“Reset Computer Use connection”按钮，用于不重启 app 的情况下强制清理本地 MCP client？
