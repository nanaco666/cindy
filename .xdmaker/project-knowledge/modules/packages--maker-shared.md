---
id: packages--maker-shared
type: module
covers:
  - packages/maker-shared/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-06T07:15:35.574Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# packages--maker-shared

## 是什么

`@lizi/maker-shared`（`packages/maker-shared`）是 desktop（`apps/desktop`）与 mobile（`apps/mobile`）共用的**纯逻辑/展示模型层**：session、消息、schedule、file-browser、device-link 等领域的归一化、分组、排序、状态机与文案决策，全部以「输入 plain object → 输出 plain object/字符串」的纯函数 + 接口形式实现，**零 React / Electron / Expo 运行时依赖**（package.json 明确声明），也没有 IO（网络/文件系统）。目的是让两端在协议解析、折叠状态机、排序规则、安全判定等确定性逻辑上保持字节级一致，避免各端各写一套导致行为漂移（对齐 `AGENTS.md` 规则 9：能用代码保证确定性的就不依赖 prompt/各端各自实现）。`eslint.config.mjs` 用 `no-restricted-imports` 硬性禁止引入 `electron`/`electron-*`，是唯一的自动化边界检查。

模块内绝大多数文件是"某个 UI 概念的纯展示模型"：给定 `*Like` 输入接口（对源数据做最小类型约束，desktop/mobile 各自的真实类型只需结构兼容即可传入），产出 `*View`/`*Presentation`/`*Summary` 等纯数据，由两端各自套壳（React hook / RN 组件）渲染与套 i18n。少数文件（`toolUseDescriptor.ts`、`commandIntent.ts`）刻意**只输出结构化数据、不拼最终文案**，因为桌面走 4 语言 i18n、手机是中文硬编码（`messagePresentation.ts` 里的手机中文格式化函数是消费方例外，见下）。

## 关键抽象 / 核心代码地标

- `index.ts`：barrel export，`package.json` 的 `exports` 字段同时给每个文件单独开了子路径（如 `@lizi/maker-shared/message-render`），两端可以按需子路径 import 而不拉全量。
- **消息渲染管线**（互相依赖，按顺序理解）：`messageNormalize.ts`（tool_use/tool_result 配对、`shouldHideToolResult` 过滤）→ `messageRender.ts`（`MessageRenderNormalizedMessage` 归一化消息模型，消费 `agentTask.ts` 的 `agent_task_update` 关联）→ `messagePresentation.ts`（折叠头部展示决策 + 手机版中文文案格式化，对齐桌面 `AgentActionRow`）→ `messageSearch.ts` / `messageWindow.ts`（搜索匹配、滚动到底判定/自动跟随）。
- **工具调用人话摘要**（issue #450）：`toolUseDescriptor.ts`（`ParsedToolName` 拆解 plain/mcp/dynamic/collab 工具名 + `describeToolUse`）与 `commandIntent.ts`（`commandIntentFromActions` 消费 codex `commandActions`、`commandIntentFromCommand` 本地规则表兜底 Claude 缺 description 场景）。两者共享同一条安全不变量：`analyzeCommandShape` 统一拦截命令链/管道/写重定向/子命令替换等形态，**命中即整体放弃解析、回退原文**，`rm` 等破坏性命令刻意不进规则表——防止「有副作用命令被贴无害人话动词」。
- **Session 列表与身份**：`sessionList.ts`（`RemoteSessionListSessionLike` → 分组/预览/自动化项）、`sessionListCollapse.ts`（列表折叠阈值 + 24h 活动豁免窗口）、`sessionIdentity.ts`（协作角色/worktree 标签）、`sessionSelection.ts`（批量操作候选与文案）、`sessionOperation.ts`（composer 状态机：slot/history mode/primary action）、`sessionControls.ts` / `sessionActionStrip.ts`（overview 卡片、操作条展示）、`systemCard.ts`（`/help` `/cost` `/status` 等系统卡片）。
- **Schedule 域**：`scheduleTypes.ts`（`RemoteSchedule*` 协议类型，唯一无运行时代码的纯类型文件，index.ts 用 `export type *` 引入）、`scheduleModel.ts`/`scheduleForm.ts`（摘要与手机端草稿模型）、`scheduleEvents.ts`（`SchedulerEvent` 判别联合 → 刷新意图/未读影响）、`scheduleDelete.ts`（删除预览与关联会话处置）。
- **文件浏览与预览**：`fileBrowser.ts`/`fileBrowserGrid.ts`（远程目录项 → 面包屑/网格展示项，数据源是桌面 `file-browser:remote-op`/`workdir-browse` 的 `DirEntry`）、`filePreview.ts`（按扩展名判定 text/pdf/office/binary 预览类型，扩展名表镜像桌面 `shared/textFileExts.ts`，**改一处要同步改另一处**）、`pathText.ts`（`stripTrailingPathSeparators`：线性扫描实现，故意不用正则——CodeQL 标记过正则版本在不可控路径输入上多项式回溯）。
- **Device-link 与 Agent 能力**：`deviceList.ts`（设备可控性判定 `isControllableDevice`、状态文案）、`deviceLinkContract.ts`（`device-link:*` IPC channel 常量 + 语音凭证同步协议类型，含 legacy 兼容形状）、`agentCapabilities.ts`（`MobileAgentCapabilities`/`planModeSupported` 新旧协议兼容判定）、`agentTask.ts`（Claude `Task`/Codex `collab:*` 子任务卡片状态模型，从桌面 `makerChatStore` 逐行移植保持行为一致）。
- `interaction.ts`：`PendingInteractionLike`/`AskQuestion`/`IssueDraft` 等交互请求（ask_user、权限审阅、issue 上报）的展示模型。
- `mathMarkdown.ts`：LaTeX 定界符归一化（`\(...\)`/`\[...\]` → `$...$`/`$$...$$`，必须在 markdown parse **前**做字符串级处理，因为 CommonMark 转义会吃掉原始反斜杠导致 AST 后处理看不到）+ 无 KaTeX 渲染面场景下的 Unicode 近似转换。
- `queue.ts`：steering 队列面板的行级动作可用性判定（moveUp/moveDown/steer/edit/remove）。
- `payloadSummary.ts`：tool payload（diff/media/mermaid/file）的种类判定与摘要。
- `fixtures.ts`：跨端共用的测试/mock 数据构造（`RemoteControlSessionFixture` 等），供两端测试与开发态假数据复用，非生产路径。
- `mobileHome.ts`：手机端首页设备筛选 + 会话列表整合（依赖 `sessionList.ts`、`pathText.ts`）。

## 模块边界

- **不依赖**：React、Electron、Expo/React Native、Node.js 专属 API（fs/path 等）、任何网络/数据库客户端。文件内允许的是纯 TS/JS 标准库。`eslint.config.mjs` 只硬拦 Electron，其余边界靠约定与 review（不是 CI 强制）。
- **被谁依赖**：`apps/desktop`（`apps/desktop/package.json` 的 `@lizi/maker-shared: workspace:*`）与 `apps/mobile`（同样 `workspace:*`）。目前只有这两个消费方；未来任何新增桌面/手机之外的客户端如果要复用同一套逻辑，也应挂在这里而不是拷贝。
- **对外接口形态**：`package.json` 的 `exports` 逐文件开子路径（`./message-render`、`./session-list` 等）+ 顶层 `.` barrel（`index.ts`）。新增文件要同时在 `index.ts` 加 `export *` 和 `package.json.exports` 加子路径，否则消费方拿不到。
- **输入契约用 `*Like` 接口而非直接 import 真实类型**：如 `DeviceListDeviceLike`、`RemoteSessionListSessionLike`、`SessionControlsSessionLike`。这样桌面/手机各自的真实数据类型（Prisma 模型、device-link 协议类型等）只要结构兼容就能直传，不用互相 import 对方的类型定义，也不会把 desktop 的 Prisma/Electron 类型污染进本包。
- 内部文件间允许互相 import（如 `messagePresentation.ts` 依赖 `messageRender.ts`/`toolUseDescriptor.ts`/`commandIntent.ts`），但都是同层级的纯逻辑依赖，没有反向依赖 apps。
- 测试在 `src/__tests__/*.test.ts`（35 个文件，`vitest run`），基本每个源文件对应一个测试文件，是校验"两端行为一致"的主要手段——改动本包任意文件前先看有没有同名测试。

## 不要做的事

- 不要往这里加 React hook、Electron API、Node fs/path 或任何运行时 IO——这是本包存在的唯一理由（跨端复用），破了零依赖约定就失去意义，且 mobile（Expo/RN）打包会直接炸。
- 不要在 `toolUseDescriptor.ts`/`commandIntent.ts` 里拼接面向用户的最终句子——它们的契约是只出结构化数据，两端各自套 i18n/中文文案；违反会让两端文案不一致且没法各自适配语言。
- 不要在 `commandIntent.ts` 的规则表里加 `rm` 等破坏性命令的"人话动词"识别——这是刻意的安全设计，任何有副作用的命令必须回退显示原文，不能被误标成"读取/搜索"这类无害描述。改 `analyzeCommandShape` 的形态检查前先理解为什么当前几类（命令链、管道尾、写重定向、子命令替换/heredoc/多行）命中即整体放弃解析。
- 不要用正则处理不可控长度的路径/命令字符串做 trailing 匹配之类操作（参考 `pathText.ts` 放弃正则的理由：CodeQL 会标记多项式回溯风险）；类似场景优先手写线性扫描。
- 改 `filePreview.ts` 的扩展名支持列表时不要忘记同步桌面 `apps/desktop` 的 `shared/textFileExts.ts`（两处是刻意保持镜像的独立副本，不是同一份文件）。
- 不要假设这里的 `*Like` 输入接口就是完整协议——它们只声明当前函数实际读取的字段，扩充字段时优先看调用方真实类型是否已有对应字段，而不是想当然加字段。
- `expandedBlockMemory.ts` 的展开状态被设计为**不跨进程重启持久化**（进程内 Map，重启即丢）——这是产品决策（持久化会让工具卡片在下次打开时"莫名已展开"，体验嘈杂），不要为了"体验优化"加持久化。
- `scheduleTypes.ts` 是纯类型文件（`index.ts` 用 `export type *` 引入），不要往里加运行时代码/常量，否则 `export type *` 语义会失真，两端 tree-shaking 预期也会被打破。

## 演进备忘

_仅追加。每次重大改动留一行：日期 - 做了什么 - 原因。_
