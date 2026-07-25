# macOS Computer Use 二期:Cindy Companion Identity 方案

> **For agentic workers:** 本计划按 Task 顺序执行,Task 0 是硬门控(gate),不通过不得进入后续任务。每个 Task 完成后勾选 checkbox 并 commit。

**Goal:** 将 Computer Use 的 TCC 身份、权限传感器、原生引导 UI、引擎监督收进单一 `Cindy Computer Use.app`(bundle id `com.xd.cindy.computer-use`),与 Codex Computer Use(`com.openai.sky.CUAService`)同构。**引擎仍是 cua-driver,MCP 工具面与底层动作能力 100% 不变**——本方案只改变"谁持有权限身份、谁拉起 daemon、引导管道住在哪个进程",不改变"谁执行动作"。

**与一期的关系:** 一期(`2026-07-24-computer-use-permission-guide-research-plan.md`,Task 1–6B 已完成)继续沿用 CuaDriver 真实 TCC 身份,解决了生命周期竞态、locator 复用、observer 节流。二期在其之上做身份收敛:renderer 契约、状态语义(`ComputerDriverStatus`)、locator 对外语义(found/not-found/unavailable)全部沿用,Electron 侧从"状态机主体"退化为薄客户端。

## 0. 核心事实(调研结论,勿重复调研)

- cua-driver 来自第三方开源 `trycua/cua`(GitHub monorepo,`libs/cua-driver`,Rust),用户目前通过 curl 安装脚本自装;仓内 `tools/` pin 机制(claude/codex/ripgrep)尚无 cua-driver 条目。
- **动作真正执行在 daemon 进程里**:daemon 以 LaunchServices 启动 `/Applications/CuaDriver.app`,TCC 归因 `com.trycua.driver`(见 `apps/desktop/src/main/mcp-integrations/computer.ts:419-424` 注释)。`cua-driver mcp` / `permissions status` CLI 只是 daemon 的客户端;0.12.2 起 `permissions status` 是严格只读的 daemon query(`computer.ts:74`)。
- 因此:**CLI 客户端自身的 TCC 身份无关紧要,唯一决定能力的是 daemon 的 responsible bundle**。身份切换的最小变更 = 换掉"谁以什么身份拉起 daemon"。
- 现有 Swift helper(`apps/desktop/native/computer-permission-guide/…helper.swift`)是无 TCC 身份的裸二进制,只做贴窗/拖拽 UI;forge 已有 3 个 Swift helper 的编译先例(`forge.config.ts:952-1060`)。
- macOS TCC 归责规则:LaunchServices 启动的 .app 是自己的 responsible process;它 posix_spawn(不 disclaim)的子进程继承其归责。因此 companion .app 经 LaunchServices 启动后 spawn daemon 二进制,daemon 内的 AX / ScreenCapture 检查归因到 companion bundle。

## 1. 全局约束

- **能力验收硬门(不可协商)**:引导完成后必须真机走通端到端动作——经 agent 工具链路(`packages/lizi-mcps` computer → MCP → daemon)完成一次真实截图 + 一次真实点击。"引导完成但动作失败"= 方案失败,不许合入。每个改变运行链路的 Task 都要重新过这条门。
- 引擎 = cua-driver daemon 原版二进制,不重写、不 fork。spike 若发现必须改上游才可行,停下来向用户汇报,不得擅自 fork。
- `ComputerDriverStatus` 对 renderer 的字段与语义不变;renderer / i18n 已有文案尽量不动(新增文案按规则 18 四语言补齐)。
- locator 对外语义 `found` / `not-found` / `unavailable` 保持。
- Windows/Linux 不进入 macOS 流程(一期 Task 1 已隔离,不得回退);非 macOS 权限状态仍固定 `not_required`。
- **硬切换**:统一走新身份;检测到旧 `com.trycua.driver` 授权时引导重新授权,不做双路径兼容。TCC 清理工具只允许碰 `com.xd.cindy.computer-use`,不得触碰 CuaDriver / Codex 的 TCC 记录。
- **内嵌 + pin**:cua-driver daemon 二进制进 `tools/` pin 机制,打包时内嵌进 companion bundle 并随主应用签名;先确认上游 license 允许再分发。
- companion 安装到**稳定路径**(userData 下版本戳更新,如 `userData/computer-use/Cindy Computer Use.app`);TCC 记录对路径与签名敏感,路径不许漂移。
- dev 模式 TCC 稳定性:companion 构建按源码内容指纹缓存,源码不变不重建(避免 cdhash 变化导致 TCC 反复失效);有稳定开发者证书则用之签 dev 构建,没有则接受重授权并在文档说明。
- 遵守仓规:main 侧逻辑默认带测试(规则 14)、统一 logger(规则 12)、跨平台影响在回复/PR 说明(规则 15)、远程/手机结论写进 PR(规则 26:Computer Use 驱动的是本机桌面;SSH 远程工作区与手机版不适用,PR 里写明理由)。
- 不触碰 system prompt、maker-core prompt 组装路径(规则 10/11 不涉及,PR 里说明)。

## 2. 目标架构

```text
Electron main (thin client)
  │  控制协议(launch / status events / guide lifecycle)
  ▼
Cindy Computer Use.app  ← LaunchServices 启动,TCC 身份 com.xd.cindy.computer-use
  ├─ 权限传感器(进程内 AXIsProcessTrusted / CGPreflightScreenCaptureAccess / SCShareableContent)
  ├─ 原生引导 UI(贴窗 NSPanel + NSDraggingSession,拖拽 payload = 自身 .app)
  ├─ 开关定位(进程内 AX 读取 System Settings,保留 found/not-found/unavailable)
  └─ 引擎监督:posix_spawn 内嵌 cua-driver daemon(TCC 归责继承 → companion)
       ▲
       │ 既有 CLI/MCP 客户端通路(cua-driver mcp / permissions status)不变
Electron main mcp-integrations/computer.ts + packages/lizi-mcps computer
```

分两阶段落地,保证每一步能力连续:

- **Stage A(身份切换,Task 1–3)**:companion 只做"以正确身份拉起内嵌 daemon"+ 拖拽 payload 换成自身。Electron 全部既有探测/引导管道原样工作(daemon query 报告的就是新身份的权限)。此阶段结束即可整体验收新身份端到端。
- **Stage B(引导收敛,Task 4)**:传感器、开关定位、贴窗 UI 迁入 companion,删除 Electron 侧 MCP locator、observer 节流机器与独立 Swift helper。纯引导管道重构,不触碰运行时链路。

## 3. 分阶段实施计划

### Task 0: Spike——TCC 归责继承可行性(硬门控)

**Deliverable:** 一份 spike 结论记录(附本任务 checkbox 更新)+ 可复跑的 spike harness,明确回答:companion 拉起的 daemon 是否以 companion 身份通过 TCC 检查并真实执行动作。

- [x] 浅克隆 `trycua/cua`,精读 `libs/cua-driver` 中 daemon 启动路径:确认 (a) daemon 是否自检 bundle path / 自我 re-exec 回 LaunchServices / 注册 launchd;(b) CLI↔daemon 的通信机制(socket/port/named pipe)及 daemon 发现方式;(c) 安装脚本布局(`.app` 与 CLI 二进制的关系,daemon 可执行文件在 bundle 内的位置);(d) LICENSE 是否允许再分发。结论见 `spikes/computer-use-companion-identity/FINDINGS.md` §1a–1d。关键发现:上游提供 `CUA_DRIVER_EMBEDDED=1` 作为官方嵌入 API,设置后 daemon 跳过 disclaim re-exec、不检查宿主 bundle id,完全留在调用者的归责链里。
- [x] 构建最小 spike bundle(独立 bundle id `com.xd.cindy.computer-use.spike`,避免污染正式身份;ad-hoc 签名):LaunchServices 启动后 spawn 下载到 `engine/` 的 cua-driver 0.12.3 daemon 二进制为子进程。Harness 位于 `spikes/computer-use-companion-identity/`(build-spike.sh / run-spike.sh / stop-spike.sh)。
- [x] 真机验证(2026-07-24,用户手动在系统设置两个列表 + 添加 spike app 并开开关):① `check_permissions` 报 `accessibility: true, screen_recording: true`,`attribution: host, host_bundle_id: com.xd.cindy.computer-use.spike`;② 仅授权 spike 后真实动作全通过——`get_desktop_state` 真实全屏截图(1470×956 PNG)、`click`(cgevent_hid 通路无权限错误)、`get_window_state` 完整读取 System Settings AX 树(173 elements,即一期开关定位同款调用)、`list_windows` 返回真实窗口标题(屏幕录制实证);③ CLI 全程按 socket 路径发现非官方启动的 daemon,daemon 在屏幕录制授权变更后未被杀、pid 稳定。注意点:嵌入模式下 daemon 永不弹授权框(上游有意关闭,由 host 负责请求/引导),`permissions status` CLI 在 embedded 模式报 `daemon_running: false`(它专查 com.trycua.driver 归责),正确探针是 `cua-driver call check_permissions '{"prompt":false}'`——Task 3 改造探测路径时必须用后者。
- [x] 清理:`tccutil reset Accessibility|ScreenCapture com.xd.cindy.computer-use.spike` 已执行,spike 进程已收割无残留。
- [x] **Gate 判据**:①②③ 全通过 → **GATE PASSED**,进入 Task 1。核心机制:上游官方嵌入 API `CUA_DRIVER_EMBEDDED=1`(daemon 跳过 disclaim re-exec,留在 host 归责链)。

### Task 1: cua-driver pin 与分发基础设施

**Files:** `tools/cua-driver/latest.json`(新)、`scripts/ensure-agent-binaries.mjs`(扩展或平行脚本)、根 `package.json` scripts、`apps/desktop/forge.config.ts`。

**Deliverable:** `pnpm install:cua-driver` / `pnpm update:cua-driver [ver]` 与 claude/codex/ripgrep 同语义;打包时二进制就位校验。

- [x] 按 spike 摸清的 release 布局(tag 前缀 `cua-driver-rs-v*`)接入 pin/下载,仅 darwin 需要(其它平台跳过)。注意:上游**只发 prerelease**,该 kind 的 pin/bump 逻辑已去除 prerelease 过滤(commit 20c40567)。
- [x] postinstall best-effort 下载对齐现有行为;`XDT_SKIP_AGENT_BIN_INSTALL` 语义保持;该 kind 无 CDN 兜底(`noCdnFallback`)。
- [x] forge 打包遇二进制缺失硬报错(`assertCuaDriverPayload`,对齐 builtin-ghosts 缺根策略)。
- [x] 测试 + typecheck + commit(4d434672 / 20c40567 / 17ca2e91)。

### Task 2: Companion bundle 脚手架与构建链

**Files:** `apps/desktop/native/computer-use-companion/`(新,Swift 源 + Info.plist 模板)、`apps/desktop/src/main/computer-use-companion/CompanionHost.ts`(新)、`apps/desktop/forge.config.ts`、`apps/desktop/src/main/bootstrap-electron.ts`。

**Deliverable:** dev 与 packaged 都能产出 `Cindy Computer Use.app`(内嵌 daemon 二进制),安装/更新到 userData 稳定路径,LaunchServices 启动,与 Electron 建立控制协议(unix socket,userData 下 socket 文件),支持 ping/version/quit 与 daemon 生命周期事件。

- [x] Swift app scaffold:bundle id `com.xd.cindy.computer-use`,LSUIElement(无 Dock 图标),Info.plist 带 AX / ScreenCapture usage description。
- [x] 构建链:dev 用 swiftc 组装 bundle,**按源码+daemon 版本内容指纹缓存**;packaged 在 forge hook 产出并随主应用签名(embedded code);universal arch 显式报错。
- [x] 安装器:首启/版本变化时把 bundle 同步到 userData 稳定路径(原子替换;注意替换会使 TCC 失效的情形只发生在签名变化时,记录日志)。
- [x] CompanionHost:启动(NSWorkspace/`open`)、socket 握手、超时、退出收割;所有异常走统一 logger;`start()` 幂等(companion 控制 socket 为单客户端串行 accept,二次拨号会滞留 backlog 超时)。
- [x] 单测(CompanionHost 可注入依赖,内存 harness,21 用例;unix socket 路径受 104 字节 sun_path 限制,测试用 `/tmp/cpn-*` 短路径)+ typecheck + commit。
- [x] **实测发现并已修复**:daemon 绑定全局单例 socket `~/Library/Caches/cua-driver/cua-driver.sock`,supervisor 每次 spawn 前先跑 `cua-driver stop` 确定性接管(残留/外部 standalone daemon 均被清场);真机集成 smoke 全链路通过(install → hello+status 快照 → 幂等复用 → shutdown 无残留)。

### Task 3: Stage A——身份切换与能力验收

**Files:** `apps/desktop/src/main/mcp-integrations/computer.ts`、`apps/desktop/src/main/computer-permission-guide/window.ts`、`apps/desktop/src/main/computer-permission-guide/*`(拖拽 payload 相关)、renderer i18n(新增重新授权文案,四语言)。

**Deliverable:** daemon 由 companion 以新身份拉起;既有探测/引导全链路在新身份下工作;旧授权检测 → 重新授权引导;端到端能力门通过。

- [x] `computer.ts` daemon 自愈/autostart 从"LaunchServices 启动 /Applications/CuaDriver.app"改为"经 CompanionHost 启动 companion → companion spawn 内嵌 daemon";探测、缓存、fresh/bypass 语义不变。(commit e3088167:`getSharedCompanionHost()` 单例 + `tryAutostartCuaDaemonOnce` 走 `host.start()`;daemon-status 事件清权限探针缓存并实时刷新设置面板)
- [x] **全局 daemon socket 归属(硬性要求)**:① supervisor spawn 前 `cua-driver stop` 接管 + stop 失败后兜底清除陈旧 sock/pid(commit d4c42a62,真机复现残留文件阻塞后回归验证);② 所有 Electron 侧 engine CLI 调用注入 `CUA_DRIVER_EMBEDDED=1` + `CUA_DRIVER_HOST_BUNDLE_ID`(`resolveDriverInvocation` darwin 分支 + switch-target 定位器子进程);③ 探针校验 `attribution.host_bundle_id === com.xd.cindy.computer-use`,旧/外来身份 → `grantsBelongToCompanion=false` 照实报未授权,reason code `legacy-identity-migration` / `foreign-daemon-identity`。
- [x] 驱动分发检测:darwin 候选路径只剩 XDT_CUA_DRIVER_PATH 覆写 + companion 内嵌 engine;不再探测用户自装路径。
- [x] 引导拖拽 payload:`getComputerDriverAppBundlePath()` 改为 `<userData>/computer-use/Cindy Computer Use.app`,native helper 与 Electron fallback 共用。开关定位器行匹配同步硬切换为 "Cindy Computer Use"(不留旧行 fallback)。
- [x] 旧身份迁移:reason code 在设置面板渲染为迁移提示(`getComputerPermissionIdentityHintKey`,i18n 四语言 `legacyIdentityMigrationHint` / `foreignDaemonIdentityHint`)。
- [x] TCC 清理/重置:全仓无 tccutil 引用,无需改动;`com.trycua.driver` 仅存于旧身份检测常量。
- [x] 回归:switch-target 20 通过、computer.ts 123 通过、permission-guide + companion 全套 300/300(唯一失败文件是既有 device-link submodule 基线问题,与本改动无关)。
- [x] **能力门(2026-07-24 真机)**:probe `attribution: host, host_bundle_id: com.xd.cindy.computer-use`;`get_desktop_state` 真实截图 2940×1912(内容非黑帧);CGEvent 双击选词可见高亮、⌘N 真实建窗、AX `type_text` effect=confirmed、AX 点击"删除"按钮窗口实关。注意:能力证据取自 fingerprint b8971943 构建;之后 supervisor 修复重建(39194fab)使 ad-hoc cdhash 变化、TCC 授权失效——**dev 下每次 Swift 变更都会作废授权**,统一在 Task 5 最终验收时重新授权并重跑"完整引导 + agent 工具链"端到端(本次硬门经 engine CLI 直连验证,in-app 引导全流程归入 Task 5 全量验收)。

### Task 4: Stage B——引导管道收敛进 companion

**Files:** companion Swift(迁入现有 helper 的贴窗/拖拽/窗口跟踪代码 + 新增传感器与 AX 开关定位)、`apps/desktop/src/main/computer-permission-guide/window.ts`(瘦身)、`switch-target.ts`(删除)、`MacComputerPermissionGuideNativeHost.ts`(由 CompanionHost 取代)、对应测试。

**Deliverable:** 引导期间零 MCP locator 子进程;探测为进程内调用;Electron 只保留 IPC 桥、System Settings pane 打开与 renderer 状态广播;一期语义与稳定性结论全部保持。

- [x] 传感器进程内化:companion `PermissionWatcher`(AXIsProcessTrusted + CGPreflightScreenCaptureAccess,~900ms 边沿触发,enable 时立即推初始快照),经 `permission-state` 消息推送;window.ts 消费该事件作为「何时刷新」触发器,真值仍走 daemon `check_permissions`(授权归属校验只有 daemon 能给)。commit 53efbbb7 + 01582e02。
- [x] 开关定位进程内化:companion `locateSwitchInSystemSettings`(自身 AX 遍历 System Settings,无 AX 照实报 `unavailable`);CompanionHost `locateSwitch()` Promise API(8s 超时);`switch-target.ts` 与 persistent MCP locator 整体删除。
- [x] 贴窗/拖拽 UI 迁入 companion(NSPanel/drag/tracking 移植,0.6s grace、30s attach 超时保留在 Electron 侧,未 attach 不自杀——`NSApp.terminate` 仅出现在 shutdown/SIGTERM/SIGINT,guide-dismiss 只拆面板;客户端断连自动拆面板+停 watcher);旧 helper Swift、`MacComputerPermissionGuideNativeHost.ts`、forge `buildMacComputerPermissionGuideHelper` 全部删除。
- [x] Electron `window.ts` 瘦身 997→459 行:observer 900ms 轮询、`PERMISSION_PROBE_BYPASS_MIN_INTERVAL_MS` 节流、serializer 队列随源头消失删除;lifecycle generation 保留。**review 发现并修复 P0**:`guide-attached` 关闭 Electron fallback 后 `hasPermissionGuide()` 恒 false 导致后续事件全被闸门丢弃——补 `companionGuideActive` 标志镜像旧版 `nativeHost ||` 语义,并补 attach 后 close/complete/permission-state 三条回归测试。
- [x] 一期测试迁移:旧用例→去向映射已逐条核对(serializer/节流/helper spawn 类删除,generation 防竞态/CHANGED-CANCELLED 时机/attach 超时/拖拽标记类迁移);electron-window.test.ts 重写为 20 用例,guide 全套 56/56 绿。
- [x] typecheck(仅既有 submodule 基线失败)、`xcrun swiftc -typecheck` 绿、companion 构建绿(fingerprint f1151a55)、`git diff --check` 干净;真机协议冒烟:`open -na` 拉起构建产物→hello protocolVersion 2+指纹匹配→daemon-status running→watch-permissions 立即回快照→locate-switch 回 unavailable(无 AX,符合预期)→shutdown 干净退出。commits 53efbbb7(4A)、01582e02(4B)。注意:4A 重建再次作废 TCC 授权,in-app 引导全流程与能力门重跑仍归 Task 5 一次性授权后执行。

### Task 5: 清理、文档与最终验收

- [x] 删除死代码:darwin 安装链收口到 companion `ensureInstalled()`(装错身份 trycua 构建的路径全部封死);`runInstallCommand` darwin 直接抛错;`getInstallCommand()` darwin 返回文档 URL;`UNIX_INSTALL_*` 更名 `LINUX_INSTALL_*`;CuaDriver.app 相关注释改为 companion bundle 口径(`XDT_CUA_DRIVER_PATH` 调试覆写保留)。computer.test.ts 拆分 darwin/非 darwin 用例,123/123 绿。commit e53e0bac。
- [x] 文档:本计划快照节已更新;`docs/` 全文检索仅 `mcp-to-ghost-migration.md` 一处 computer-use 提及(迁移清单"不迁"标注,与安装方式无关),无需改动。
- [ ] 全量验收:重跑一期 §9.2 状态矩阵 + 稳定性检查(以新架构等价项为准),再过一遍端到端能力门(引导完成 → agent 真实截图+点击),dev 与(可行时)packaged 各一遍。
- [x] 仓库根 `pnpm test:unit` 全绿(desktop 1011 文件/10691 用例、mobile 221 文件/2068 用例全过)。过程中修复三个与本分支无关的本机环境问题:better-sqlite3 原生绑定重建、electron 二进制补装、mobile vitest 别名对非 ASCII 路径的 `URL.pathname` 编码 bug(改 `fileURLToPath`,随本分支提交)。
- [ ] PR:按模板写明——系统提示词不涉及、maker-core 指标不涉及(理由)、远程/手机结论(规则 26)、跨平台说明(规则 15)、风险节写 TCC 硬切换与签名敏感性。

## 4. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| daemon 拒绝在非官方 bundle 下运行 | Task 0 硬门控;pivot 选项见 Task 0 |
| dev ad-hoc 签名变化导致 TCC 反复失效 | 内容指纹缓存少重建;有证书用稳定证书;文档化 |
| packaged 签名/notarization 影响 TCC 识别 | Task 5 packaged 验收;companion 随主应用签名 |
| 上游 cua-driver 升级破坏 daemon 协议 | pin 机制锁版本,升级走显式 `update:cua-driver` + 重跑能力门 |
| 存量已授权用户被硬切换打断 | 产品决策已确认(功能开发期存量极少);引导重新授权即本次交付物 |

## 5. 当前快照

- 2026-07-24:方案与三项产品决策(内嵌 pin / 硬切换 / spike 通过自动继续)已与用户确认;Task 0 待执行。
- 2026-07-24(后):Task 0–4 全部完成——companion 身份继承真机验证通过(能力门:真实截图+CGEvent/AX 点击均实测),引导管道(贴窗/拖拽/传感器/开关定位)全部收敛进 companion 进程,协议 v2 真机冒烟通过;darwin 安装链收口(e53e0bac)。剩余:`pnpm test:unit` 全绿门禁、一次性 TCC 重授权后的全量验收(引导全流程 + agent 端到端能力门,dev/packaged)、PR。注意:dev 下每次 Swift 重建都会因 ad-hoc cdhash 变化作废 TCC 授权,验收统一在最终构建(当前 fingerprint f1151a55)上一次性授权执行。
