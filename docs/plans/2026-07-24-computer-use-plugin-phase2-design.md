# Computer Use 插件化(Phase 2)设计

> 状态:设计定稿,待 Phase 1(companion 身份切换,见 `2026-07-24-computer-use-companion-identity-plan.md`)完成后派发执行。
> 目标(用户原话):最终可以把 Computer Use 打包成一个 Cindy 插件,安装卸载、可视化的引导授权,并且真实可用;正确安装注册为插件后,对话时自动启用;没有权限时先提示授权,走完全流程。
> 硬约束沿用 Phase 1:**底层能力不变**——插件化只改管理面与引导面,截图/点击/定位的真实能力链(agent → MCP → CompanionHost → cua-driver daemon)一根毛都不能少。每个触及运行链的任务都必须重跑能力硬门(真实截图 + 真实点击)。

## 1. 调研结论(file:line 证据)

| 事实 | 证据 |
|------|------|
| Ghost 插件模型:kind='chip'、schemaVersion 2,slots = subscribe/tool/card/panel/cindy/network/notify/fs | `apps/desktop/src/shared/ghost.ts` L75, L600-692 |
| Gateway 模型:agent 工具面永远只有 `ghost_list`+`ghost_call`,cindy MCP server 常驻注册 → 工具面稳定、prompt cache 安全 | `shared/ghost.ts` L112-114;`mcp-providers.ts` L362-373 |
| Ghost 安装目录即注册表(userData/cindy-brain/<id>/),`.disabled` 标记 + tombstone;安装默认禁用(initiallyEnabled: false) | `cindy-brain/GhostManager.ts` L72+;`builtinGhostProvisioner.ts` L276 |
| .cindy 包上限 8MB/32MB/256 entries —— **无法携带原生二进制**(companion + engine ≈ 51MB) | `GhostManager.ts` L17/23/26 |
| Ghost 无生命周期钩子(无 onInstall/onEnable) | `shared/ghost.ts` 模型全文 |
| `computer` 已在插件注册表:GLOBAL + DEFAULT_DISABLED + HOSTED_ELSEWHERE | `plugin-registry` types.ts L73-94 |
| 工具开关 gate 文件 userData/builtin-tools-settings.json;isEnabled(ctx) 在会话建立时快照 | `plugin-registry.ts` L54 |
| 现有 callTool 硬 gate:disabled 时 throw 'Computer Use is disabled in Settings.' | `mcp-integrations/computer.ts` L3144-3153 |
| 插件页已有 setup-gate 交互:使用前 `ghosts.setupStatus(id)` + 引导弹窗 | `GhostPluginPage.tsx` L337-349 |
| 管子(pipe)派发通道 | `cindy-brain/pipeDispatcher.ts` L92-102 |

## 2. 关键决策:混合架构(Ghost 管理壳 + 原生 MCP 工具链)

两条候选路线的裁决:

- **纯 Ghost gateway 路线(否决)**:把截图/点击做成 `ghost_call` 工具。否决理由:① 截图必须以 image block 形式回给 LLM,pipe/gateway 的 JSON 消息链路不承载图片工具结果;② CU 是"截图→点击"高频循环的热路径,多一跳 gateway + JSON-blob schema 直接劣化延迟与工具调用工效(仓规 10 热路径);③ 8MB 包上限决定原生资产反正进不了 .cindy,"纯插件"名不副实。
- **混合路线(采用)**:
  - **能力链保持原生不动**:`computer` MCP server(packages/lizi-mcps)继续常驻注册 → 工具面跨会话字节稳定,prompt cache 无扰(仓规 10);工具 schema、图片回传、延迟全部保持现状。
  - **Ghost 插件 = 管理与引导壳**:官方内置插件子仓新增 `cindy-computer` ghost(chip),提供插件目录里的安装/卸载/启停、card 实时状态(权限 + daemon 运行态)、panel 可视化授权引导。
  - **联动语义用代码保证(仓规 9)**:callTool gate 依次判 ①ghost 已安装且启用 ②companion 权限已授予(`check_permissions {"prompt":false}` 探针)。任一不满足 → 返回**结构化、LLM 可读**的工具结果(告诉模型该引导用户做什么),同时 main 推事件让 renderer 弹出授权引导 UI;用户完成后模型重试即通。"正确安装注册 → 对话自动启用;无权限 → 先提示授权走完全流程"整条闭环全部落在代码分支,不依赖 prompt。

原生资产(companion .app + engine)继续随 app resources 分发(Phase 1 产物),Ghost 只持引用不持字节。远期若 Ghost 体系支持原生资产扩展(Path C)再迁移,不在本期。

## 3. 架构与数据流

```
安装/卸载/启停:插件页(GhostPluginPage) ⇄ GhostManager(cindy-computer)
状态回传:CompanionHost(daemon-status / 权限探针) → main 状态桥 → pipe host 消息 → ghost card/panel 实时刷新
对话链路:agent → lizi_computer MCP tools → callTool gate
    gate 通过 → CompanionHost → cua-driver daemon(能力不变)
    gate 拦截 → 结构化错误(LLM 引导文案)+ renderer 授权引导事件 → 用户授权 → 重试通过
```

授权引导 UI 复用 Phase 1 Stage A 的设置页引导组件(拖拽 companion.app 进系统设置 + 实时探针回传),插件 panel 与对话内弹层共用同一组件与状态源,不做第二套。

## 4. 任务分解(全部派发 Sonnet 4.6,我验收)

**P2-T1 主进程状态桥 + gate 改造**(先行,不依赖子仓)
- computer.ts callTool gate 从"读 Settings 开关"切为"读 ghost 安装/启用态 + 权限探针缓存";结构化错误文案(LLM 可读,四语言无关——工具结果用英文);gate 拦截时向 renderer 推授权引导事件。
- CompanionHost 状态(daemon-status、权限探针结果)聚合成单一状态源,供 IPC 与 pipe 双向消费。
- 验收:单测覆盖 gate 三分支;能力硬门重跑(gate 通过路径真实截图+点击)。

**P2-T2 cindy-computer ghost(官方子仓 PR + 主仓指针 bump)**
- manifest(chip):card slot 实时状态、panel slot 授权引导、cindy slot 收 host 状态消息。
- 若新增 pipe host 消息 kind:**同一改动内同步 FORGE_GUIDE 手册**(仓规 24,漏同步 = P1)。
- 验收:安装/卸载/启停在插件页全流程可用;card 状态与真实权限/daemon 态一致且实时。

**P2-T3 对话内授权闭环 UX**
- renderer 收 gate 事件 → 弹授权引导(复用 Stage A 组件);完成后状态源刷新,模型重试即通。
- i18n 四语言(zh-CN/en/ja/ko)全部补齐(仓规 18)。
- 验收:冷启动无权限 → 对话触发 CU → 引导 → 授权 → 同一会话内重试成功(硬门)。

**P2-T4 验收矩阵 + 用户真实体验脚本**
- 全矩阵:未安装/已装未启用/已启用未授权/全通,×(设置页入口 / 插件页入口 / 对话内触发)。
- 产出一页用户体验验收脚本,交用户做最终真实验收。

**依赖序**:P2-T1 → {P2-T2, P2-T3 可并行} → P2-T4。

## 5. 仓规遵从声明(PR 门禁预答)

- **规 9/10**:联动语义全代码分支;工具面与 prompt 前缀零改动,PR 需附 cache hit rate 前后对比确认无扰。
- **规 11**:不触碰 system prompt;引导文案只走工具结果与 UI。
- **规 24**:P2-T2 若加 host 消息 kind,手册同步为硬性验收项。
- **规 26**:CU 为本地 macOS 桌面专属能力——SSH 远程工作区/手机版不适配本功能,gate 在非 darwin/远程场景返回明确 not-supported 结构化结果;PR Description 按此说明,新增 IPC 事件不进 device-link allowlist(手机不驱动本地屏幕)。
- **规 15**:Windows 侧所有入口隐藏 + gate 返回 not-supported,不留半成品 UI。
