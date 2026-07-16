---
id: apps--desktop
type: module
covers:
  - apps/desktop/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-06T04:52:55.806Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
## 是什么

`apps/desktop` 是 XDMaker 的 Electron 桌面客户端，包含 main 进程、renderer 进程（React/Vite）、preload 桥接层，以及多语言 i18n 资源。通过 Feishu OAuth 登录，支持 remote API 模式和本地全栈模式。

除核心的 agent 会话（Claude Code / Codex）界面外，桌面端还承载：主题/设计 token 系统（多套内置主题 + 本地主题扩展）、内置工具（builtinTools/plugin）开关体系、Help Assistant（AI 知识库助手）、worktree 池化（供自动化/协同复用干净 worktree）、语音输入（多 ASR provider）、Markdown 文档编辑器、IM（飞书/Slack）会话集成、定时任务/自动化调度、Android ADB 自动化、聊天记录跨会话向量检索等子系统。这些子系统各自有独立目录（见「模块边界」），通过 main 进程统一编排、经 IPC 暴露给 renderer。

## 关键抽象

### 进程与基础设施

- **main / renderer / preload 三层分离**：业务逻辑、网络、存储在 main；renderer 仅负责渲染；preload 暴露受控 IPC 接口。
- **i18n**：`apps/desktop/src/renderer/i18n/locales/{en,zh-CN,ja,ko}/common.json`，key 路径即命名空间，单 namespace `common`，`fallbackLng='en'`（缺 key 静默回退英文、无校验脚本拦截，全靠改动者自觉四语言同步）。
- **环境配置**：`apps/desktop/.env`（gitignored），由 `pnpm restart:desktop:remote` / `pnpm restart:desktop:local` 自动创建/修补。
- **MCP providers**：maker-host 的 `mcpProviders` 数组汇聚所有 MCP 桥接器（desktop MCP providers、`orcaBridgeProvider`、`orcaWorkerBridgeProvider` 等），统一注入给 Maker 实例；具体哪些 provider 对用户可见/可关，由下方「内置工具」体系控制。

### 主题 / 设计 token 系统

- **`apps/desktop/src/renderer/themes/`**：`registry.ts`（内置主题列表 + 旧 id 迁移别名，如 `taptap-dark` → `eclipse`）、`colors.ts`（`registerColor(id, {light, dark}, description)` token 注册表，当前约 370+ 条）、`color-registry.ts`（重复注册即抛错）、`families.ts`（主题"家族化"）、`theme-service.ts` / `event.ts`（运行时切换）、`local-themes*.ts`（用户本地 JSON 主题扩展 + 一键导出）、`builtin/*.ts`。
- **主题家族（family）**：`ThemeFamily { id, name, light, dark }`，每个家族最多一个 light + 一个 dark 变体；`BUILTIN_FAMILIES` 收纳内置家族（default / atom-one / solarized-light / eclipse / monokai-pro / github / material-ocean-hc 等），本地主题通过 `buildLocalFamilies()` 追加。设置页由"双 dropdown（light+dark 分选）"改为单 dropdown 选家族，存储 key 由 `theme.lightId+darkId` 改为单一 `theme.familyId`；`resolveFamilyVariant` 在家族缺少请求方向变体时回退到另一变体并标记 `fallback: true`。
- **token 三层架构**：semantic slot（跨组件复用，如 `--surface` / `--text-primary` / `--border-default`）+ component-scoped alias（如 `--cmd-palette-bg`）+ singleton（单一用途）。历史重构（P3.2）把 312 个原始 token 收敛为 39 slot + 84 singleton，原则是"raw 默认值相同 ≠ semantic 相同"——两个 token 即便默认 hex 相同，只有当真实主题（如 Eclipse）对它们有不同 override 时才不合并；后续新增 token 已让总数增长到 370+，39/84 只是历史快照，非当前值。
- **HSL vs hex**：喂给 Tailwind/shadcn 的 token（`background` / `border` / `ring` 等）用无单位 HSL 三元组字符串存储，消费时 `hsl(var(--x))` 包裹；design-system 的 raw token 是 hex，且很多都手动维护一个 `-hsl` 后缀的平行双胞胎（如 `surface` / `surface-hsl`）。格式 wrap 错了（hex 塞进 `hsl()`）会产生非法 CSS，整条 declaration 被忽略，表现像"主题失效"。
- **语义豁免色**：focus ring、error、destructive、thinking-orange、warning alpha、diff red/green、overlay、shadow、Toast 三色等跨主题保持一致，不被主题 override，但仍走 token（在 `colors.ts` 中有专门注释标注为 sanctioned hue exception）。

### 内置工具 / 插件（builtinTools / plugin）系统

- **`apps/desktop/src/main/maker-host/plugins/{types.ts,builtin-plugins.ts,plugin-registry.ts,settings-reader.ts}`**：每个"内置工具"是一个 `Plugin` 描述符，包装 `lizi-mcps` 包里约 20 个内置 MCP provider（`android` / `browser` / `computer` / `feishu` / `art` / `mivo` / `web_search` / `google` / `slack` / `jira` / `confluence` / `github` / `gitlab` / `feishu_bot` / `slack_bot` / `scheduler` / `memory` / `xdt_helper` / `collab` / `lsp` / `xd_service`）。`PROVIDER_NAME_TO_PLUGIN_ID` 是穷举 `Record`（非 `Partial`），强制新 provider 必须显式映射 plugin id，否则 typecheck 报错。
- **`PluginRegistry.isEnabled()` 四层决策**（`plugin-registry.ts`）：(1) 未知 plugin id → fail-open 视为启用；(2) `ESSENTIAL_PLUGIN_IDS`（`memory`/`xdt_helper`/`scheduler`/`lsp`）→ 永远启用、Settings 不可见不可关；(3) `GLOBAL_PLUGIN_IDS`（`android`/`computer`，涉及本机 OS 级驱动）→ 机器级设置；(4) 其余按 `<workingDir>/.claude/settings.json` 的 `xdtMaker.builtinTools.{id}.enabled` 逐项目 override，缺省回退 `DEFAULT_DISABLED_PLUGIN_IDS`（`android`/`computer` 默认关，因为它们能操作本机应用）。`HOSTED_ELSEWHERE_PLUGIN_IDS`（`android`/`browser`/`computer`）可切换但因为已有专属 Settings 分区，从通用内置工具列表中隐藏。
- **Settings 独立 tab**：内置工具面板已从 Settings → Connections 拆成独立侧边栏 tab（`BuiltinToolsSection.tsx`），支持通过项目下拉切换要编辑哪个项目的 `.claude/settings.json`。
- **`lizi_collab` 独立 MCP server**：`enable_collab_mode` / `disable_collab_mode` / `send_to_session` 已从 `lizi_xdt_helper`（essential）拆到独立 `collab` plugin（非 essential，项目可关），保持 essential 集合语义纯粹（纯基础设施，不含可选功能开关）。

### Help Assistant（AI 知识库助手）

- **`apps/desktop/src/main/maker-ipc/help.ts`**：两阶段 LLM 路由问答，取代旧关键词匹配器。阶段一把仅含 22 篇文档 id/title/summary 的 `HELP_INDEX` 喂给 utility model，返回 0-2 个文档 id（`MAX_ROUTED_DOCS=2`）；阶段二只加载被路由到的文档全文拼进 prompt，路由失败/未命中时降级为仅用 index 摘要。模型输出的 `<action tab="..." />` 必须经 `parseAssistantOutput` 校验落在硬编码 `ALLOWED_TABS` 白名单内，不信任模型直接跳转任意 tab。
- **`helpKnowledge.generated.ts`**：由 `apps/desktop/help-knowledge/*.md`（22 篇）经 `scripts/gen-help-kb.mjs` 生成；`scripts/help-kb-guard.mjs` 在内存中重新渲染并 diff 已提交的生成文件，CI（`help-kb-guard` job）拦截"改了 .md 未重新生成"或"手改生成文件"。
- **反馈草稿本地化**：`help-feedback.ts` 的用户反馈草稿 Phase 1 只本地落盘（`<userData>/help-feedback-drafts.json`，原子写 + 写锁串行化 + 损坏文件隔离为 `.corrupted-<timestamp>`），不发 GitLab；schema 预留 Phase 2 的 `submittedIssueUrl?` 字段。

### Worktree 池化

- **`apps/desktop/src/main/worktree/WorktreePool.ts`**：按 baseRepo 路径（`repoKey`）缓存干净、ephemeral 的 worktree（主要服务 scheduler/自动化会话），跳过完整 10 步 `createWorktree` 流程；全局上限 `MAX_WORKTREES=5`，超限按 `createdAt` 淘汰最旧的，且允许因历史脏残留暂时超限（不能因此拒绝新工作）。
- **活跃 session 保护**：`hasLiveSessionReference` 查询 `sessions` 表（排除 `status='deleted'`）判断某 worktree 是否仍被存活 session 引用，命中则永不池化/淘汰，只标记 `'preserved'`；DB 查询失败时 fail-safe（视为仍被引用，宁可多保留）。
- **`pathKey`**：`path.resolve` 归一化、仅 win32 小写化，专用于"活跃 session 引用"��断，与 `safety.ts` 的 `isManagedWorktreePath`（大小写敏感的删除三闸门：路径在 `baseRepo/.xdt-worktrees/` 下、在 store 中登记、非 symlink）刻意独立——两者都偏向"宁可多保留"，不构成风险。
- **非 ephemeral 跳过**：`meta.ephemeral !== true` 的 entry 在淘汰逻辑中永远跳过——它们属于用户自己的会话生命周期，不是池资源。

### 语音输入

- **`apps/desktop/src/main/voice-input/`**：多 ASR provider（`RealtimeAsrWebSocketProvider` / `LiteLlmTranscriptionProvider` / `ElevenLabsScribeProvider` / `VolcengineSaucAsrProvider` / `FallbackAsrProvider`）+ 文本精修 client（`CodexResponsesTextModelClient` / `LiteLlmTextModelClient`），经 `VoiceInputProviderHealth` / `VoiceInputRefinerRouting` 路由；实时识别已迁移到 "XD LiteLLM realtime"。权限检查在 `permissions.ts`。
- **renderer 侧**：`WebMicAudioEngine.ts`（含预热 `prewarmVoiceInputMicrophone*`）、`workletUrl.ts`（区分 dev/packaged 下 AudioWorklet 资源路径解析）、词典 CSV 导入（`shared/voiceInputData.ts`）。

### Markdown 编辑器

- **`apps/desktop/src/renderer/components/markdown/`**：`PlaintextEditor.tsx`（CodeMirror-based，支持 markdown marker widget、`toggleMarkdownStrong` 等）、`markdownTableLivePreview.ts`（表格单元格 contentEditable 实时预览，`renderActiveCell` / `isNavigationKey`）、`markdownImageLivePreview.ts`、`markdownMermaidLivePreview.ts`、`codemirrorGithubTheme.ts`；由 `MarkdownEditor.tsx` 包装，消费方如 `FileBodyView.tsx`。

### IM（飞书/Slack）会话集成

- **`apps/desktop/src/shared/sessionSource.ts`**：`SESSION_SOURCES` 含 `'feishu' | 'slack'`；`DESKTOP_VISIBLE_SESSION_SOURCES` 是侧边栏可见来源白名单，`sessions:list` IPC 按此过滤。
- **IM 自动建会话**：飞书/Slack 消息到达时经 `apps/desktop/src/main/im/shared/sessionRepo.ts` 的 `createSession` 落库；`broadcastSessionCreated`（`im/shared/sessionBroadcast.ts`）向所有窗口 + device-link 广播 `local-db:sessions:created`。
- **draft 误判窗口修复**：`createSession` 在 INSERT 时即设 `userSendAt: now`（而非仅依赖后续 `touchUserSent`），避免广播触发的 renderer 重拉在 `userSendAt` 尚为 null 的窗口内把 IM 会话误判为 draft 分组。

## 模块边界

- renderer 不直接访问 Node/系统 API，统一走 preload IPC。
- package 层（maker-core 等）与 main/renderer 解耦，通过初始化配置/回调注入依赖；agent（claude/codex）具体逻辑放在 `packages/maker-core`，main 只通过 maker 调用。
- i18n locale 文件只存放翻译字符串，不含业务逻辑。
- 主题 token 只在 `apps/desktop/src/renderer/themes/colors.ts` 注册一处；家族/内置主题/本地主题都是对同一 token 集合的 override 集合，不重新定义 token id。
- `PluginRegistry.isEnabled()` 是内置工具启停的唯一决策入口，per-project override 存于目标工作目录的 `.claude/settings.json`（`xdtMaker.builtinTools.*`），机器级（`GLOBAL_PLUGIN_IDS`）走独立 settings store，二者互不覆盖。
- Help Assistant 的知识库内容只能通过编辑 `apps/desktop/help-knowledge/*.md` + 重新生成得到，`helpKnowledge.generated.ts` 是生成产物，不接受手改（CI guard 拦截）；反馈草稿是本地文件，不接入任何远端服务。
- Worktree 池只服务"可复用、可丢弃"的自动化/临时会话；用户自己创建并持续使用的 worktree（非 ephemeral）不进入池的淘汰逻辑，池代码也不负责它们的生命周期。
- 语音输入 provider 选择/降级逻辑封装在 main 的 `voice-input/`，renderer 侧只通过 `useVoiceInput.ts` / `VoiceInputOverlay.tsx` 消费结果，不直接感知具体 ASR 供应商切换。
- IM 会话的"来源"（`sessionSource`）只在写入时由 `im/` 模块设置，其余业务代码（侧边栏过滤、分组排序）只读该字段做展示决策，不重新推断来源。
- `mivoAbortedToolUseIds` 仅由 `stopSession` 写入，`clearSession` 重置；`useInflightCustomIds` 只读不写。
- `forceFinalizeOnSessionClosed` 仅由 `onStatusChanged` 的 `status==='closed'` 分支调用。
- ProjectNode 的 More 菜单与右键菜单共用同一份 DropdownMenu items，`menuPos` state 驱动锚点位置。
- `SessionTabsBar` / `TaskListCell` 的单击用 `e.detail > 1` 跳过双击产生的第二次 click；`SessionItem` 走另一套机制（见「不要做的事」），两者互不影响、不共享 timer。

## 不要做的事

- 不要在 renderer 层实现业务逻辑或网络请求。
- 不要硬编码路径分隔符（`/` 或 `\\`），一律用 `path.join`。
- 不要直接 `console.log`，走统一 logger 模块。
- 不要跳过 `pnpm restart:desktop:remote` / `pnpm restart:desktop:local` 直接在非交互 shell 启动 Electron Forge。
- 不要在未阅读 `DESIGN.md` 的情况下新增或修改 UI 组件；涉及颜色一律走主题 token（`colors.ts` 已注册的 slot/alias/singleton），禁止 `bg-[#xxx] dark:bg-[#xxx]` 硬编码 hex pair（这种写法只认 `.dark` 一个开关，任何非默认主题都无法 override）。
- 主题 token 注册时不要把 hex 值塞进 `hsl(var(--x))` 消费，也不要把 HSL 三元组当 hex 直接用——格式 wrap 错误会产生非法 CSS 被静默忽略，表现像"主题失效"。
- 不要给 semantic slot 做"raw 默认值相同就合并"的简化——只有当真实主题对两个 token 有不同 override 时才不能合并；合并前应模拟所有已注册主题的 resolved 颜色确认零 mismatch。
- `PluginRegistry.isEnabled()` 不要假设未知 plugin id 应该拒绝——设计上是 fail-open（视为启用），避免新 provider 因遗漏映射静默消失；但新增 provider 时仍必须补齐 `PROVIDER_NAME_TO_PLUGIN_ID` 映射，否则 typecheck 会拦。
- 不要给 `lsp` 单独加内置工具面板的开关——它是 essential plugin，已由 Settings → Experimental 的 LSP Mode Beta 开关管理，重复开关会冲突。
- Help Assistant 的 `helpKnowledge.generated.ts` 不要手改——改 `apps/desktop/help-knowledge/*.md` 后必须跑生成脚本，CI 的 `help-kb-guard` 会 diff 拦截手改和漏生成。
- Help Assistant 反馈草稿读文件遇权限错误时不要静默降级为覆盖写——应直接抛错，避免覆盖一个当前不可读但可能仍有效的文件。
- Worktree 池不要对仍被存活 session（`status != 'deleted'`）引用的 worktree 做池化或淘汰——即使看起来"干净"也要先查 `hasLiveSessionReference`；DB 查询失败时不要放行删除，应 fail-safe 保留。
- Worktree 池的 `drainEntry` 不要在 `isManagedWorktreePath` 三闸门未全部通过时执行 `fs.rm -rf`——闸门不过应直接抛错而非静默删除。
- 语音输入的 AudioWorklet 资源不要以 `?url` 方式 import 后直接假设打包环境路径与 dev 一致——packaged 构建下需要走 `resolveVoiceInputWorkletUrl` 的 file-protocol 分支，否则预热会静默失败。
- 语音输入功能验证不要仅凭本地 `.app` 构建"能跑起来"判断录音是否真的工作——非正式签名的本地包缺少音频输入 entitlement，麦克风在代码层"启动"但系统层未真正激活，会产生静默无声的 ASR 结果。
- Markdown 表格实时预览的 cell keydown handler 不要对导航键（Arrow/Home/End/PageUp/PageDown）也触发 `renderActiveCell` 重建——重建会重置浏览器原生选区锚点，导致 Shift+Arrow 只能选中一个字符；导航键应直接跳过重建（`isNavigationKey` 判断）。
- IM（飞书/Slack）自动建会话不要只在 `sessionRepo.createSession` 广播 `sessions:created` 而不设置 `userSendAt`——广播与 renderer 重拉之间存在竞态窗口，`userSendAt` 为 null 会被 `projectGrouping` 误判为 draft；`userSendAt` 必须在 INSERT 时就设好。
- 不要忘记同步 `DESKTOP_VISIBLE_SESSION_SOURCES`——新增 IM 来源或调整可见性时，DB 里的 session 行即使广播了创建事件，renderer 重拉过滤不掉的来源会导致"创建了但侧边栏看不到"。
- `SessionItem` 不要重新引入 `e.detail > 1` 或 `setTimeout` 防抖——它走的是"单击立即导航 + 浏览器原生 dblclick 进入重命名"机制，首击因 `id===activeSessionId` 在 `handleSessionClick` 早 return 自然避免重复导航；`SessionTabsBar` / `TaskListCell` 才是 `e.detail > 1` 机制，两套不要混用。
- SessionItem 的"复制 Session ID"相关菜单项已简化为单一「复制深度链接」项——不要再按旧文档假设它是深度链接/仅 ID/Agent(debug) 三项子菜单去改代码或写测试。
- Mermaid 渲染中不要为 SVG 设置 `width="100%"`（即不要开启 `useMaxWidth`），否则小图会被拉伸、高度异常膨胀；应以自然尺寸渲染，超大图由 CSS 双轴 max 限制。
- 不要在 `loadSqliteVec` 之前调用 `runMigrations`，否则用到 `vec0` 的迁移 SQL 会因模块未加载而失败。
- `chat-embedding` 设置为 OFF 时不要仅调 `setChatEmbeddingEnabled(false)`——必须同时 `stopEmbeddingHost` + `resetChatEmbedderCache`，否则 Worker setInterval 仍在轮询。
- `ChatInput` 的 `onUpdate` 中不要在 `hasHydratedRef.current` 为 `false` 时写 `composerDraftStore`——mount 期间 Tiptap 触发的初始 `onUpdate` 持有空 doc，直接写会覆盖草稿。
- `ChatInput` 的 unmount cleanup 不要在「editor 为空且无已有草稿」时写 store——空编辑器 + 无草稿才是真正的 no-op。
- `VoiceInputOverlay` 的 `startRecording` 中不要省略开头的 `await stopEngine()`——缺失会导致旧引擎状态残留，引发录音异常（曾在一次 merge 中意外丢失此调用）。
- **不要给 `mivoButtonPending` 加任何 `setTimeout` 超时兜底**——mivo MJ 任务可跑分钟级，renderer 端超时会假解锁让用户连点踩 rate limit；正确的释放路径是 tool_use reducer / IPC 失败 / stopSession / clearSession。
- **不要在 `stopSession` 后忘记同时清 `mivoButtonPending` 并写 `mivoAbortedToolUseIds`**——仅清 pending 不够，已经飞出去的 tool_use 没有 tool_result 会让按钮永久转。
- **`forceFinalizeOnSessionClosed` 不要改为依赖 `done` 事件**——此护栏存在的意义就是覆盖 `done` 因 race 未能在 `close` 之前到达 renderer 的场景。
- **不要在 `onStatusChanged` listener 中对非 `closed` 状态调用 `forceFinalizeOnSessionClosed`**——对中间状态调用会错误清除进行中的 streaming 标记。
- **`PinnedSection` 目前只有 collapsed/expand 折叠 toggle，没有 `shownCount` 渐进展开/"More"机制**——不要假设存在分页展开逻辑去改代码；如需要该行为需新实现，且不应持久化 collapsed 状态（刷新回默认是既有设计意图）。
- **ProjectNode Header 中不要将 Search / ShowFiles / OpenInExplorer 还原为三个独立图标按钮**——已整合进 More（⋮）下拉菜单；「新建」按钮是唯一保留的独立 primary 操作。
- **`.xdt-sortable-row` 上严禁加 `will-change / transform / filter / perspective`**——会让该元素成为 containing block，导致 SessionItem / ProjectNode 内部 `position:fixed` 右键菜单漂移；让位动画由 SortableJS 自带 transform 过渡负责。
- **`ProjectNode` 展开容器上不要移除 `data-no-drag` 属性**——是 SortableList filter 的唯一拦截点，缺失后鼠标在子 SessionItem（`role="button"`）上按下会被误识别为拖动整个 ProjectNode 的起点。
- **`PendingQueuePanel` 展开态提示文字使用的 i18n key 是 `newChat.pendingQueue.pausedFooter`**——不要沿用更早的 `dispatchPaused` 或中间版本的 `pausedExplain`，均已废弃；颜色走 `var(--warning-fg)`，不要改回灰色。

## 演进备忘

- 将 scheduler 模板 tab 标签由"使用模板/Use template"改为"新手帮助/Getting Started"，同步更新 zh-CN / en / ja / ko 四个 locale 文件，提升新用户引导辨识度。
- 在 maker-host `mcpProviders` 中补充注入 `orcaBridgeProvider`（位于 `orcaWorkerBridgeProvider` 之前），使 orca 主桥接器也参与 MCP 服务注册。
- `enableOrcaInternal` 增加 `delegateTask` 可选参数，支持"启动协同模式同时派发任务"一句话连发场景；返回新增 `dispatched` 字段；worker 初始状态、label、占位消息均随是否携带 `delegateTask` 分支处理；`enableCollabMode` MCP tool 透传该参数。
- SessionItem 右键「复制 Session ID」拆分为二级菜单（XDMaker / Agent），原单项仅在 `sdkSessionId` 存在时渲染改为始终渲染（无值时 disabled），三种状态变体共用同一 `copySessionIdSubmenu` 片段，同步更新四语言 i18n key。
- `MarkdownMermaidBlock` 对所有图表类型设 `useMaxWidth: false`，SVG 按自然尺寸渲染；容器 CSS 改为双轴限制（`max-w-full` + `max-h-[60vh]` + `w-auto`），修复小图被撑满容器导致高度异常的问题。
- `copySdkSessionId` i18n key 在 zh-CN / en / ja / ko 四个 locale 中追加"debug 用途"标注，明确该子菜单项仅供调试使用。
- chat-embedding setting OFF 时彻底停止 host：`attemptStartEmbeddingHost` 提前读设置短路；`CHAT_EMBEDDING_SET` IPC OFF 路径改为 `setChatEmbeddingEnabled(false)` → `stopEmbeddingHost` → `resetChatEmbedderCache`，消除残留 Worker 轮询；`localDb.ensureReady` 中 `loadSqliteVec` 调序到 `runMigrations` 之前，修复 vec0 迁移因模块未加载报错的问题。
- `ChatInput` 引入 `hasHydratedRef` 修复协同/普通 session 切换时草稿丢失问题（issue #40）：mount 期间 Tiptap decoration 扩展触发的初始 `onUpdate` 被守卫拦截不写 store，hydration effect 尾部翻 `true` 放行真实用户输入；新增回归测试 `composerDraftMountRace.test.ts` 覆盖修复前/后路径及 cross-session 污染场景。
- `VoiceInputOverlay.startRecording` 恢复 `await stopEngine()` 前置调用（MR !89 合并时意外丢失），确保每次录音启动前旧引擎状态已清理，避免引擎残留导致录音异常。
- SessionItem Archived 状态菜单新增红色「删除」项（`handleDeleteSelect`，i18n key `ccAgent.sidebar.sessionMenu.delete`），插入位置在「归档」之后、`copySessionIdSubmenu` 之前，仅对已归档 session 开放直接删除入口。
- `checkWorkDirExists` ENOENT 时新增 `findSimilarDirOnDisk` 兜底扫描：匹配 trim 相等或大小写不敏感的同名目录，命中后 `emitWorkDirMissingError` 在错误消息追加 JSON.stringify 路径 hint，帮助用户识别 Finder 目录名末尾不可见空格导致 DB 路径与磁盘不一致的问题。
- 全局禁用 Electron 拼写检查：主窗口、OAuth 窗口、语音输入 toast 窗口的 `webPreferences` 统一加 `spellcheck: false`，消除界面文本输入框的红色波浪下划线干扰。
- zh-CN locale 中权限模式 `acceptEdits.label` 由"自动接受编辑"改为"允许编辑"，措辞更简洁准确。
- `copySessionIdSubmenu` 新增「深度链接」子项（`handleCopyDeepLinkSelect`，`xdt-maker://` protocol），原各状态变体内联的独立 `copyDeepLink` 菜单项全部移除并并入此子菜单；子菜单现共三项：深度链接 / 仅 ID / Agent（debug）；四语言 label 同步缩短（如"复制深度链接"→"深度链接"，"XDMaker"→"仅 ID"，zh-CN `copySessionId` 改为"复制会话 ID"）。
- 新增 `remarkTruncateCjkUrls` remark 插件，修复 GFM autolink literal 将裸 URL 后紧跟的 CJK／全角字符误吞进 `href` 导致链接 404 的问题；在 AST 层截断并把尾巴还原为 text 节点，排在 `remarkGfm` 之后注入 `REMARK_PLUGINS`。
- dialogue 模式工作目录芯片优化：`workspaceKind === 'dialogue'` 时显示 `dialogueLabel + UUID 前 8 位`（取代原始 UUID 末段），保持语义可读性与跨 session 可区分性；新增 i18n key `ccAgent.layout.dialogueLabel` 同步到四语言。
- `ModelLightbox` 移除 `auto-rotate` 和 `auto-rotate-delay` 属性，3D 模型 lightbox 改为静止展示，避免用户查看时模型自动旋转带来干扰。
- `ChatInput` 新增 unmount cleanup effect（`[editor, storageKey]` 依赖）：Chat �� Settings 等路由切换直接卸载 composer 时，将当前 editor JSON 快照写入 `composerDraftStore`（`silent: true`），补捉 `onUpdate` 来不及写入的最后一帧草稿；同步在 `composerDraftMountRace.test.ts` 追加该场景的回归测试。
- mivo 按钮 Stop 解锁 + 移除 30s 超时：新增 `SessionChatState.mivoAbortedToolUseIds`（`ReadonlySet<string>`），`stopSession` 扫描 messages 把无 tool_result 的 mivo tool_use id 写入该 Set，`useInflightCustomIds` 读到即跳过视为已结算；同时 `stopSession` 清空 `mivoButtonPending`；移除 `MIVO_BUTTON_PENDING_TIMEOUT_MS` 常量和 `markMivoButtonPending` 内的 `setTimeout`（mivo MJ 任务可跑分钟级，超时假解锁会让用户连点踩 rate limit）；`sendUiTrigger` 补全 `createOpts` 拼装，修复 app 重启后 main 进程 in-memory session 不存在导致按钮报 NOT_FOUND 的问题。
- 新增 `forceFinalizeOnSessionClosed` 兜底护栏：监听 `maker.onStatusChanged` 中 `status==='closed'` 事件，强制清掉 `isRunning`/`startedAt`/`streamingClientId` 及所有 `isStreaming` 标记，pending 交互标为 `expired`，修复 close 与 turn-end done 事件 race 导致 UI 永久卡 "Generating..." 的 Bug-B。
- `PinnedSection` 新增折叠/展开 chevron（hover 浮现，与 DialogueSection 同款）及渐进"More"行（初始显示 5 条，每次展开 10 条），两种状态均不持久化；同步新增 `pinnedToggleExpand` / `pinnedToggleCollapse` / `pinnedShowMore` i18n key 到四语言，并微调 `pinned` label（zh-CN "已置顶"→"置顶"，ja/ko 同步精简）。
- ProjectNode Header 三个独立按钮（Search / ShowFiles / OpenInExplorer）整合为单个 More（`EllipsisVertical`）下拉菜单，与 SessionItem ⋮ 模式对齐；移除 `MarkdownMark` 内联 SVG 组件；菜单分三组（归档全部 / 浏览操作 / 元数据+集成），右键与 More 按钮共用同一份 items；`ProjectAction.onClick` 签名改为透传 `MouseEvent` 以支持 `getBoundingClientRect` 锚定菜单位置。
- `SessionItem` 单击改为立即导航，移除 200ms 防抖 timer；双击仍触发重命名，依赖浏览器原生 dblclick，首击因 `activeSessionId` 匹配在 `handleSessionClick` 早 return 不重复导航，两路自然隔离无需 timer 协调，消除点击卡顿感。
- 将 `SessionTabsBar` / `TaskListCell` 的单击防抖 timer（200ms setTimeout）统一替换为 `e.detail > 1` 守卫；`SkillhubSidebarUpper.EntryRow` 的 `onClick` 改为同步立即导航，prefetch 降级为后台 `void Promise.all` 不阻塞路由，移除 `pending` state 和 `opacity-60` 视觉反馈，消除点击卡顿感并统一全局单击即时响应模式。
- 为 `remarkTruncateCjkUrls` 补充专项回归测试（`remarkTruncateCjkUrls.test.ts`）：直接构造 mdast AST 调用 transformer，覆盖全角括号、直接跟汉字、日文假名、全角感叹号四种截断场景及纯 ASCII / 显式链接两种不截断场景；同步引入 `unist-util-visit` + `@types/mdast` 依赖。
- 移除 `.xdt-sortable-row` 的常驻 `will-change: transform`：该属性使行 wrapper 成为 containing block，导致 SessionItem / ProjectNode 内部 `position:fixed` 右键菜单漂移；改为依赖 SortableJS 自带动画，浏览器在拖动开始时自动做层提升，并在注释中明确禁止在此 wrapper 上添加同类属性。
- `ProjectNode` 展开后子 session 列表容器加 `data-no-drag`，修复鼠标落在 `role="button"` 的 SessionItem 上按下被父层 ProjectsSection SortableList 误识别为拖动整个 ProjectNode 的起点（SortableJS 默认 filter 不拦 `role="button"` 元素）。
- `PendingQueuePanel` 展开态暂停提示优化：i18n key 由 `dispatchPaused` 重命名为 `pausedExplain`，文案改为更完整的"展开中，新消息会排队，收起后才会继续执行"语义，颜色从灰色改为 Toast Warning 橙色（`#F59E0B`），新增 `min-w-0 truncate` 防止长文溢出；四语言 `expandedToast` 文案同步更新，提升用户对队列展开行为的感知。
