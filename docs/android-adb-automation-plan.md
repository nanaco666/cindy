# Android ADB 自动操作落地计划

> 状态：设计 / 实施计划。
>
> 本文按项目 PR 提交规范里的 Feature PR 结构组织：动机 / 背景、用户场景、改动范围、设计 spec、测试路径、自测确认、Breaking Change、关联任务、cindy-updater 声明和 Self-review Checklist。当前只记录方案与涉及代码范围，不代表功能已经实现。

## PR 标题建议

首个实现 PR 建议标题：

```text
feat(android-automation): 增加 ADB 安卓手机自动操作能力
```

如果先做调研 / spike，不引入产品能力，建议拆成：

```text
docs(android-automation): 补充 ADB 安卓自动操作落地计划
chore(android-automation): 增加 ADB 自动操作 spike 脚本
```

后续实现如果 diff 超过约 500 行，需要在 PR Description 顶部说明为什么必须一起提交；否则按阶段拆 PR。

## 动机 / 背景

当前项目的「自动操作」有两条已经落地的能力：

- 自动操作浏览器：`lizi_browser`，由 `@lizi/browser-control-runtime` 提供。该 runtime vendored 了 `openclaw/openclaw` 的 `extensions/browser`，通过 Playwright / CDP 驱动一个专用 Chrome profile。
- 自动操作电脑：`lizi_computer`，由外部开源 CUA Driver (`cua-driver`) 提供。desktop host 启动 `cua-driver mcp`，再把通过 schema 校验的 MCP tool call 转发给 driver。

这两条能力都不等同于「连接了 ADB 的安卓手机」：

- `lizi_browser` 只面向浏览器页面和 Chrome profile。
- `lizi_computer` 的工具模型强绑定桌面窗口：`pid`、`window_id`、desktop accessibility tree、window screenshot。
- ADB 安卓设备的真实对象模型是 `device_serial`、`package`、`activity`、screen coordinate、UIAutomator hierarchy、`adb shell input`。

因此 Android 自动操作应作为新的自动操作后端和新的 MCP 工具面落地，不应该把 Android 语义塞进 `lizi_computer` 的 `pid/window_id` 协议里。

## 用户场景

目标用户在本机连接一台开启 USB debugging 的 Android 真机或 emulator 后，可以让 agent 做低风险、可验证的手机 UI 操作：

1. 在 Settings -> 自动操作中启用 Android 自动操作。
2. agent 调用 `status` / `list_devices` 确认 ADB 和设备授权状态。
3. agent 调用 `get_device_state` 获取当前截图、屏幕尺寸、当前 app、压缩后的 UI 节点列表。
4. agent 执行一次 `tap` / `swipe` / `input_text` / `press_key` / `launch_app`。
5. agent 再次调用 `get_device_state` 验证操作结果。

首版只覆盖「观察 -> 单步动作 -> 再观察」的闭环，不做任意 shell、不做 APK 安装、不做高风险系统设置变更。

## 改动范围

### 1. `packages/lizi-mcps` 新增 Android MCP 面

新增文件：

- `packages/lizi-mcps/src/android/index.ts`
- `packages/lizi-mcps/src/android/server.ts`
- `packages/lizi-mcps/src/android/tools.ts`
- `packages/lizi-mcps/src/android/androidMcpServer.test.ts`

修改文件：

- `packages/lizi-mcps/src/types.ts`
  - 新增 `AndroidMcpDeps`。
  - 新增 Android tool name union 或局部工具定义类型。
  - 在 `LiziMcpId` 中加入 `android`，保持和现有 `browser` / `computer` 等单词 id 一致。
- `packages/lizi-mcps/src/providers.ts`
  - `CreateLiziMcpProvidersOptions` 新增 `android?: AndroidMcpDeps`。
  - 注册新 provider：`lizi_android`。
- `packages/lizi-mcps/src/index.ts`
  - 导出 `./android/index.js`。

职责边界：

- MCP package 负责工具 schema、参数校验、错误码、结果结构和 agent workflow 指引。
- 不在 MCP package 里直接依赖 Electron、filesystem path、`child_process` 或 desktop logger。

### 2. `apps/desktop` 新增 Android host driver

新增文件：

- `apps/desktop/src/main/mcp-integrations/android.ts`
- `apps/desktop/src/main/mcp-integrations/__tests__/android.test.ts`

修改文件：

- `apps/desktop/src/main/mcp-integrations/mcp-providers.ts`
  - 注入 `getAndroidMcpDeps()`。
  - 使用 plugin registry 做启用门控。

`android.ts` 需要承担：

- 解析 `adb` 可执行文件位置。
- 通过统一 logger 输出诊断日志，不使用 `console.log`。
- 用 `child_process.spawn` 调用 ADB，设置 timeout、stdout/stderr 上限和 Windows 兼容参数。
- 解析 `adb devices -l`。
- 用 `adb exec-out screencap -p` 或等价方式截图，保存到 `app.getPath('temp')/xdt-maker-adb`。
- 用 `adb shell uiautomator dump` 拉取 / 读取 XML。
  - 优先使用不依赖 `/sdcard` 写权限的读取路径；如果设备侧 dump 到默认路径失败，需要 fallback 到 `exec-out` / 临时文件读取等兼容方案。
- 把 UIAutomator XML 压缩成 agent 可消费的节点列表。
- 将 `tap` / `swipe` / `input_text` / `press_key` / `launch_app` 映射到 `adb shell input ...`、`am start` 等确定性命令。

### 3. 插件注册、Settings 和 IPC

修改文件：

- `apps/desktop/src/main/maker-host/plugins/builtin-plugins.ts`
  - 新增 Android 自动操作 plugin metadata。
  - 将 `lizi_android` 映射到用户可见 plugin id。
  - 将 plugin id 映射到 `LiziMcpId`。
  - 在 `KnownProviderName` 和 `PROVIDER_NAME_TO_PLUGIN_ID` 中加入 `lizi_android`，避免新增 provider 后 registry 派生校验失败。
- `apps/desktop/src/main/maker-host/plugins/types.ts`
  - Android 自动操作默认关闭。
  - 建议按 `computer` 一样作为 machine-wide / global plugin，而不是 project-scoped plugin。
  - 建议放在 Settings -> 自动操作，而不是通用内置工具列表。
  - 对照 `computer` 补齐 `DEFAULT_DISABLED_PLUGIN_IDS`、`GLOBAL_PLUGIN_IDS`、`HOSTED_ELSEWHERE_PLUGIN_IDS`，避免 Android 自动操作同时出现在通用 builtin tools 列表。
- `apps/desktop/src/main/maker-host/plugins/__tests__/plugin-registry.test.ts`
  - 覆盖默认关闭、global enablement、project override 不应绕过 global 默认关闭等 case。

如果首版要在 Settings 显示 Android 状态，还需要修改：

- `apps/desktop/src/main/maker-ipc/channels.ts`
  - 新增 `ANDROID_STATUS`，必要时新增 `ANDROID_OPEN_HELP` 或类似 channel。
- `apps/desktop/src/main/maker-ipc/register.ts`
  - 注册 IPC handler。
  - 错误必须走 `throwIpcError(code, message)`。
- `apps/desktop/src/preload/preload.ts`
  - 暴露 `window.electronAPI.maker.android.status()` 等 API。
- `apps/desktop/src/renderer/components/settings/ComputerUseSection.tsx`
  - 增加 Android 自动操作卡片。
  - 如果文件过大，拆分成 Browser / Computer / Android 三个子组件。
- `apps/desktop/src/renderer/i18n/locales/{zh-CN,en,ja,ko}/common.json`
  - 所有新增 UI 文案同步四语言。

### 4. 可选 runtime package

首版不建议新增 runtime package。除非 ADB driver 逻辑明显变大或需要跨宿主复用，再拆：

- `packages/android-control-runtime/**`

MVP 阶段直接放在 desktop main 的 `mcp-integrations/android.ts` 更简单，也和当前 `computer.ts` 的 host driver 模式一致。

## 设计 spec

### 工具面

首版建议工具：

| 工具 | 只读 | 说明 |
|---|---:|---|
| `status` | 是 | 检测 `adb` 是否可用，返回设备授权状态。 |
| `list_devices` | 是 | 列出已连接设备和 emulator。 |
| `get_device_state` | 是 | 返回截图路径、屏幕尺寸、当前 package/activity、压缩 UI 节点列表。 |
| `tap` | 否 | 按 element index 或绝对屏幕坐标点击。 |
| `swipe` | 否 | 按屏幕坐标滑动 / 拖拽。 |
| `input_text` | 否 | 向当前焦点输入文本。 |
| `press_key` | 否 | 发送 Android keyevent，如 BACK / HOME / ENTER。 |
| `launch_app` | 否 | 按 package/activity 或 monkey launcher 启动 app。 |

`launch_app` MVP 只接受 package 和可选 activity，不接受任意 `intent` action、data URI、extras 或 shell 片段。需要 deep link / intent extras 时必须另开高风险工具，并在执行前要求用户显式确认。

延后工具：

- `install_apk`
- `clear_app_data`
- `grant_permission`
- `logcat`
- 受限 `shell`
- 轨迹录制 / 回放
- 手机端 Accessibility / IME helper app

### `get_device_state` 返回结构

不要把原始 UIAutomator XML 直接塞给 agent。建议返回紧凑结构：

```json
{
  "device_serial": "emulator-5554",
  "screen": { "width": 1080, "height": 2400, "density": 440 },
  "current_app": { "package": "com.example", "activity": ".MainActivity" },
  "screenshot_file_path": "C:\\...\\xdt-maker-adb\\state-123.png",
  "nodes": [
    {
      "index": 1,
      "text": "OK",
      "content_desc": "Confirm",
      "class_name": "android.widget.Button",
      "resource_id": "com.example:id/ok",
      "bounds": { "x1": 10, "y1": 20, "x2": 200, "y2": 80 },
      "clickable": true,
      "enabled": true
    }
  ]
}
```

原始 XML 可以保存为临时文件用于诊断，但默认不返回给 agent，避免 token 爆炸和泄露无关信息。

截图需要同时作为 MCP image content block 返回给 agent，`screenshot_file_path` 只用于诊断和落盘追踪。否则 vision 模型在同一轮只能看到路径字符串，无法完成「观察 -> 操作 -> 再观察」闭环。

`element_index` 只对同一 agent session 的最近一次 `get_device_state` 有效。执行 `tap` / `swipe` / `input_text` / `press_key` / `launch_app` 后应失效当前 snapshot，要求 agent 再次观察，避免用动作前的旧 bounds 继续操作。

### 错误码建议

Android MCP 层建议返回业务错误码，避免裸抛内部错误：

- `ADB_NOT_FOUND`
- `NO_DEVICE`
- `MULTIPLE_DEVICES`
- `DEVICE_UNAUTHORIZED`
- `DEVICE_OFFLINE`
- `UI_DUMP_FAILED`
- `SCREENSHOT_FAILED`
- `INVALID_NODE`
- `ANDROID_DRIVER_ERROR`

desktop IPC 层仍按项目规范使用 `throwIpcError`。

### 安全和权限模型

- Android 自动操作必须默认关闭。
- 建议作为 global plugin，用户显式启用后才注入 agent 工具。
- 任意 `adb shell` 不进入 MVP。
- 安装 APK、清空 app 数据、改权限、短信 / 拨号、支付流程等高风险动作如果未来加入，必须有显式用户确认。
- 截图和 UI 文本可能包含敏感信息，临时文件应放在 app temp / userData 下，日志不要记录原始截图、完整 UI 文本或 token。
- 临时截图和 XML 需要有清理策略。MVP 可采用启动 / 写入时清理过期文件，例如保留最近 24 小时用于诊断。

## 分阶段落地

### Phase 0：ADB spike

先做最小脚本，不接 MCP：

1. `adb devices -l`
2. `adb shell wm size`
3. `adb exec-out screencap -p`
4. `adb shell uiautomator dump`
5. `adb shell input tap`

验收标准：

- Windows 和 macOS 至少各验证一端；没有设备的一端要在 PR 里说明未测原因。
- 至少一个真机或 emulator 跑通 observe / tap / verify。
- 记录截图耗时、UI dump 耗时、中文输入是否可接受。
- 记录 `current_app.activity` 的解析方式和稳定性；跨 Android 版本不稳定时按 best-effort 字段处理。

### Phase 1：MCP MVP

落地 `lizi_android`：

1. 新增 MCP server 和工具 schema。
2. 新增 desktop ADB host driver。
3. 接入 plugin registry，默认关闭。
4. Phase 1 backend/MCP 骨架可先不做 Settings UI；完整产品路径再补 Settings 最小状态展示和 enable / disable。
5. 补单测覆盖 schema validation、ADB command mapping、设备状态解析。

验收标准：

- agent 能发现工具。
- agent 能读取设备状态。
- agent 能点击一个节点或坐标。
- agent 能再次读取状态验证结果。
- `lizi_computer` / CUA Driver 原行为不变。

### Phase 2：产品化加固

1. 优化 UI 节点排序、去噪和压缩。
2. 多设备连接时做明确选择，不自动猜设备。
3. 增加常见 ADB 错误的用户引导。
4. 评估是否需要受限 `logcat`。
5. 评估是否需要 helper IME 解决中文 / 特殊字符输入。

验收标准：

- 大 UI tree 不超过 MCP 响应上限。
- 常见错误有明确可行动提示。
- 多设备不会误操作默认设备。

### Phase 3：可选 companion app

只有 ADB-only 路线无法满足时再考虑手机端 companion app：

- Accessibility service 获取更稳定 UI tree 和直接 action。
- IME 提供可靠多语言输入。
- 本地 socket / WebSocket 降低延迟。

这会引入安装、签名、升级、隐私和信任成本，不作为首版路径。

## 测试路径

### 自动化测试

1. `packages/lizi-mcps`
   - Android MCP `list_tools` / `call_tool`。
   - 参数校验失败返回 schema。
   - unknown tool / invalid args / driver error。
2. `apps/desktop/src/main/mcp-integrations`
   - mock `child_process.spawn`。
   - `adb devices -l` 解析。
   - no device / unauthorized / offline / multiple devices。
   - screenshot 输出路径。
   - UI node compaction。
   - `tap` / `swipe` / `input_text` / `press_key` / `launch_app` 命令参数。
3. plugin registry
   - Android 默认关闭。
   - global enablement 生效。
   - project override 不能绕过默认关闭策略。
4. Settings / IPC
   - IPC 错误走 `throwIpcError`。
   - renderer 文案四语言 key 齐全。

### 手工测试

#### 前置条件

- Windows Phase 1 backend 已内置 `apps/android-platform-tools-bin/win32-x64/adb.exe`；仍允许用 `XDT_ANDROID_ADB_PATH` 显式覆盖。
- macOS 暂不内置 platform-tools，本机需安装 Android platform-tools，且 `adb --version` 可执行。
- 至少准备一台 Android 真机或一个 emulator。
- 真机已开启 Developer options 和 USB debugging。
- 测试前记录平台：Windows / macOS、设备型号、Android 版本、连接方式（USB / emulator）。
- 如果测试的是完整产品路径，先启动 XDMaker，并确认 Android 自动操作默认关闭；当前仅测试 backend/MCP 骨架时，可用 driver harness 直接调用工具。

#### TC-01：默认关闭，不向 agent 暴露 Android 工具

步骤：

1. 保持 Android 自动操作处于默认关闭状态。
2. 新建一个 agent 会话。
3. 让 agent 列出可用自动操作 / MCP 工具。

预期：

- agent 看不到 `lizi_android` 或 Android 自动操作工具。
- 浏览器自动操作和电脑自动操作的原有可见性不受影响。
- Settings 中 Android 自动操作显示为关闭。

#### TC-02：ADB 未安装或不可执行

步骤：

1. 在测试环境中临时移除 `adb` 所在目录的 PATH，或配置一个不存在的 `XDT_ANDROID_ADB_PATH` 路径；Windows 内置 ADB 存在时，需临时移走内置目录或用测试 harness mock。
2. 在 Settings 打开 Android 自动操作。
3. 调用 Android `status`。

预期：

- `status` 返回 `ADB_NOT_FOUND` 或等价状态。
- Settings 给出安装 Android platform-tools 或配置 ADB 路径的引导。
- 不注入可执行动作工具，或动作工具调用时明确拒绝执行。

#### TC-03：ADB 可用且单设备已授权

步骤：

1. 连接一台已授权 Android 设备。
2. 命令行执行 `adb devices -l`，确认只有一个 `device` 状态的设备。
3. 在 Settings 打开 Android 自动操作。
4. 调用 Android `status` / `list_devices`。

预期：

- Settings 显示 ADB 可用、设备已连接且已授权。
- `status` 返回 `adb` 路径、版本或可用状态。
- `list_devices` 返回唯一设备，包含 `device_serial` 和 `state: "device"`。
- 不需要用户选择设备。

#### TC-04：读取设备状态

步骤：

1. 保持设备解锁并停留在一个普通 app 页面。
2. 调用 `get_device_state`。
3. 打开返回的 `screenshot_file_path` 检查截图。
4. 检查返回的 `nodes`。

预期：

- 返回屏幕尺寸、当前 package/activity。
- 截图文件存在且能打开。
- `nodes` 是压缩后的节点列表，不包含完整原始 XML。
- 可点击控件包含 `bounds`、`clickable`、`enabled` 等字段。
- 单次返回体不超过 MCP 响应上限。
- 同一轮 MCP result 包含截图 image content block，不只是 `screenshot_file_path`。
- 该 snapshot 仅对当前 agent session 生效，不会被其它会话或 worker 的同设备 snapshot 覆盖。

#### TC-05：按节点点击并验证

步骤：

1. 打开一个有明确按钮的测试页面，例如系统 Settings 首页或示例 app。
2. 调用 `get_device_state` 找到目标按钮节点。
3. 用 `tap` 按 `element_index` 点击。
4. 再次调用 `get_device_state`。

预期：

- 点击发生在目标节点 bounds 中心或合理位置。
- 页面状态发生符合预期的变化。
- 第二次 `get_device_state` 能反映变化。
- 如果节点 index 已过期或不存在，返回 `INVALID_NODE`，不执行误点击。

#### TC-06：按坐标点击

步骤：

1. 调用 `get_device_state` 获取屏幕尺寸。
2. 选择一个安全坐标，例如空白区域或测试按钮中心。
3. 调用 `tap`，传入绝对屏幕坐标。
4. 再次观察设备状态。

预期：

- 坐标在屏幕范围内时正常执行。
- 坐标越界时返回参数错误或业务错误，不调用 ADB 点击。

#### TC-07：滑动 / 滚动

步骤：

1. 打开一个可滚动页面。
2. 调用 `get_device_state` 记录当前首屏节点。
3. 调用 `swipe` 从屏幕下方向上滑动。
4. 再次调用 `get_device_state`。

预期：

- 页面产生滚动。
- 返回节点列表对应新视口内容。
- 过短、越界或无效坐标应被拒绝或返回明确错误。

#### TC-08：文本输入

步骤：

1. 打开一个普通文本输入框。
2. 点击输入框。
3. 分别调用 `input_text` 输入：
   - `hello world`
   - `a+b=1`
   - `100% ready`
   - `中文测试`
   - `a&b`
4. 读取设备状态或人工观察输入结果。

预期：

- MVP 只支持白名单 ASCII：字母数字、空格和少量不会被设备端 shell 解释的标点。
- 空格正确 escaping；`%s`、shell 元字符、不支持标点和中文应返回明确错误，不应静默删除字符或假装完全支持。
- 中文 / 复杂特殊字符输入留到 Phase 2 helper IME 或其它可靠通道解决。

#### TC-09：Android keyevent

步骤：

1. 打开任意非 Home 页面。
2. 调用 `press_key` 发送 `BACK`。
3. 调用 `press_key` 发送 `HOME`。
4. 调用 `get_device_state`。

预期：

- `BACK` 返回上一页或关闭当前页面。
- `HOME` 回到 launcher。
- 不支持的 key name 返回参数错误，不执行任意 shell。

#### TC-10：启动 app

步骤：

1. 选择一个确定存在的 package，例如系统 Settings。
2. 调用 `launch_app`。
3. 调用 `get_device_state`。

预期：

- app 被启动到前台。
- `current_app.package` 和预期一致。
- package 不存在时返回明确错误。
- `launch_app` 不接受任意 data URI、extras 或 shell 片段。

#### TC-11：未授权设备

步骤：

1. 连接一台未授权设备，或在手机上撤销 USB debugging 授权后重新连接。
2. 执行 `adb devices -l` 确认状态为 `unauthorized`。
3. 调用 `status` / `list_devices`。
4. 尝试调用 `get_device_state`。

预期：

- `status` / `list_devices` 明确返回 `DEVICE_UNAUTHORIZED` 或等价状态。
- 用户提示包含「需要在手机上确认 USB debugging 授权」。
- `get_device_state` 不继续执行截图 / dump。

#### TC-12：offline 设备

步骤：

1. 构造或等待设备出现在 `offline` 状态。
2. 调用 `status` / `list_devices`。
3. 调用任意动作工具。

预期：

- 状态明确为 `DEVICE_OFFLINE`。
- 动作工具拒绝执行，并提示重新插拔设备或重启 adb server。

#### TC-13：无设备

步骤：

1. 断开所有 Android 设备和 emulator。
2. 调用 `status` / `list_devices`。
3. 调用 `get_device_state`。

预期：

- 返回 `NO_DEVICE` 或等价状态。
- UI 给出连接设备和开启 USB debugging 的引导。
- 不产生截图临时文件。

#### TC-14：多设备连接

步骤：

1. 同时连接两台设备，或一台真机 + 一个 emulator。
2. 调用 `list_devices`。
3. 在未指定 `device_serial` 时调用 `get_device_state`。
4. 指定其中一个 `device_serial` 后再次调用。

预期：

- `list_devices` 返回所有设备。
- 未指定设备时返回 `MULTIPLE_DEVICES`，不猜默认设备。
- 指定 `device_serial` 后只操作对应设备。

#### TC-15：UI dump 失败或为空

步骤：

1. 打开可能无法 dump UI 的页面，例如游戏、自绘 Canvas、受保护页面，或通过 mock / 断开方式制造 dump 失败。
2. 调用 `get_device_state`。

预期：

- 截图如果可用仍返回截图。
- UI dump 失败时返回 `UI_DUMP_FAILED` 或 `nodes: []` 加明确原因。
- agent 不应基于空节点执行 element-indexed 点击。

#### TC-16：截图失败

步骤：

1. 构造 screenshot 失败，例如设备断开、ADB 返回非 PNG、权限 / secure screen 限制。
2. 调用 `get_device_state`。

预期：

- 返回 `SCREENSHOT_FAILED` 或明确错误。
- 不返回损坏的 `screenshot_file_path`。
- 日志只记录诊断摘要，不记录敏感截图内容。

#### TC-17：跨平台回归

步骤：

1. 在 Windows 跑 TC-03 到 TC-07 的主路径，确认优先使用内置 `adb.exe`，且可用 `XDT_ANDROID_ADB_PATH` 覆盖。
2. 在 macOS 跑 TC-03 到 TC-07 的主路径，确认走本机 SDK / PATH ADB。
3. 对比 ADB path、临时文件路径、spawn 参数、截图文件可读性。

预期：

- 两端都能完成主路径。
- 路径处理不依赖硬编码 `/` 或 `\\`。
- Windows 下不会弹出额外命令行窗口。
- Windows 未安装 Android SDK / PATH 无 `adb` 时，内置 ADB 仍可完成主路径。

#### TC-18：现有自动操作能力不回退

步骤：

1. 启用 / 关闭 Android 自动操作。
2. 检查 `lizi_browser` 的 Settings 状态和打开 agent browser 行为。
3. 检查 `lizi_computer` 的 status 和 CUA Driver 可见性。

预期：

- Android 开关不影响浏览器自动操作。
- Android 开关不影响 CUA Driver status、权限检查和既有工具注入策略。
- 原有 `computer` 默认关闭策略不被改变。

### 回归命令

按实际改动范围选择：

```bash
pnpm --filter lizi-mcps test
pnpm --filter desktop test
pnpm check:i18n
```

如果只提交文档计划，不需要跑上述命令，但 PR Description 里要说明「仅文档变更，未运行测试」。

## 自测确认

实现 PR 需要按项目 PR 规范填写：

- [ ] 主路径已自测通过：`status -> get_device_state -> tap -> get_device_state`。
- [ ] 已覆盖边缘 case：无设备、未授权、offline、多设备、UI dump 失败、截图失败。
- [ ] 未测部分已列出原因，例如缺 Windows 真机或 macOS 真机。
- [ ] macOS / Windows 双端路径和子进程行为已分别考虑；未实测平台已标注。
- [ ] main IPC 错误走 `throwIpcError`。
- [ ] 日志走统一 logger，无 `console.log` 和临时排查日志。
- [ ] 新增 UI 文案已同步 `zh-CN` / `en` / `ja` / `ko`。
- [ ] Android 自动操作默认关闭，需要用户显式启用。

## Breaking Change

计划方案本身不引入 Breaking Change。

实现时也不应影响：

- 现有 `lizi_browser`。
- 现有 `lizi_computer`。
- CUA Driver 安装、权限和 MCP session 生命周期。
- 现有 plugin id 的含义。

如果后续为了统一 Settings 文案或 plugin 分组改动可见行为，需要在 PR 中单独说明。

## 关联任务

当前来自 2026-06-24 的调研结论：评估项目自动操作功能和对应开源项目，判断能否迁移到连接了 ADB 的 Android 手机。

若后续进入实现，建议先建一个 Jira / GitHub issue 绑定 Phase 0 spike，再按 Phase 1 / Phase 2 拆任务。

## cindy-updater 改动声明

不涉及 `cindy-updater`。

## 风险

- UIAutomator XML 体积大、噪声多，必须做节点压缩和排序。
- `adb shell input text` 对中文、空格和特殊字符不稳定。
- WebView、游戏、自绘 Canvas、`FLAG_SECURE` 页面可能拿不到完整 UI tree 或截图。
- Windows ADB driver、USB 授权和设备 offline 状态较容易不稳定。
- 多设备连接时必须明确选择设备，不能默认猜。
- 手机自动操作比浏览器自动操作更敏感，必须默认关闭并限制高风险动作。

## Self-review Checklist

实现 PR 末尾应追加项目统一 Self-review Checklist，并特别关注：

- [ ] Title / Description 主体为中文，仅技术术语和专有名词保留英文。
- [ ] Description 按 feature 模板填写，无空白小节。
- [ ] macOS / Windows 双端均已验证，或注明只测一端和原因。
- [ ] UI 改动已遵守 `DESIGN.md` 和主题 token 规则。
- [ ] main IPC 错误走 `throwIpcError`。
- [ ] 日志走统一 logger。
- [ ] 跨平台路径用 `path.join` / `path.resolve`，子进程兼容 Windows。
- [ ] typecheck / lint / 相关测试已运行，或注明未运行原因。
- [ ] 不涉及 `maker-core` prompt / tool 注册热路径；如果涉及，按规则 10 评估缓存率、性能、返回速度和准确性。
- [ ] 不涉及系统提示词；如果涉及，已先和 Lizi 确认。
