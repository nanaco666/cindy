# 主界面布局树重构(Layout Tree)

> 状态:**Step A / Step B(B1–B3)/ Step C(C1、C2 全链路)均已落地 main**(B4 顶/底栏未启动;mac 侧多处待真机验证,见各切片记录)。C2 收官时完成 brain/ghost 代码层更名与曾用名兼容层移除(见 §7.2 C2d)。本篇只覆盖布局树本身,不展开意识运行时/清单/沙箱(下一里程碑 C3 见 runtime-sandbox.md,待成文)。

## 1. 目标与非目标

**目标**:把主界面从「写死的三栏 flex」重构为「全局一份的布局树 + 面板注册表」,使:

- 用户可以(后续版本)拖拽重排界面里的每一栏、增删行/栏;
- 任何面板都能停靠在树的任意位置、关闭、弹出为独立窗口、位置持久化;
- 未来意识面板以新 `panelKind` 的形式接入,布局引擎零改动。

**非目标(本次不做)**:意识运行时、沙箱、拖拽编辑模式 UI、顶/底栏、浮层。这些全部是后续「往树里加节点 / 加新 panelKind」的增量,见 §8。

**终局形态**(与意识系统共识对齐):主机出厂只有「会话列表 + 聊天主区」两块内置面板,其余一切 UI(包括现在的右侧边栏整体)都是意识面板叠加。

## 2. 现状(代码事实,勘察于 2026-07-05)

主界面在 `apps/desktop/src/renderer/components/layout/MainLayout.tsx` 中是明确的三块 flex 兄弟:

1. **左栏** `<Sidebar>`(`MainLayout.tsx:702`):会话列表;支持折叠、64px rail 窄轨、拖拽调宽;设置页整体隐藏。
2. **中间** `<main>`(`MainLayout.tsx:725`):`flex-1`,ContentHeader + 路由视图;最小宽 400px。
3. **右栏** `<RightSidebar>`(`MainLayout.tsx:769`):源码注释原话「主界面第三块布局,`<main>` 之后的 full-height flex sibling,与左栏对称」。在场与否由路由视图声明;折叠态/宽度按 session 分桶持久化;支持 Maximize(接管整个非左栏区域)。

**已存在的面板基因**(重构的直接素材):

- 右栏内部已是小型插件系统:`features/right-sidebar/registry.ts`(`registerTabKind`/`getTabKind`)+ `plugins/` 下 file-browser / terminal / web-browser / review 四个内置插件,统一 `TabBody({state, ctx, active})` + `defaultState()` + `hydrateState()` 接口,状态经 store + IPC 按 session 分桶持久化。
- 左栏有注入槽:`FeatureSidebarSlotProvider` + `useRegisterSidebarUpper`(`MainLayout.tsx:693`)。
- webview 嵌入 React 布局的难点(resize 时 pointer-events 穿透、可见性切换、maximize 联动)已被 `BrowserWebviewPool`(`MainLayout.tsx:847`)踩平。
- 副窗口机制已存在(`isSecondaryWindow`),是「面板弹出独立窗口」的现成地基。

## 3. 数据模型

全局**一份**布局(不随 session 变形;面板内容跟随会话,布局不跟随——与 VSCode 同策略)。

```ts
type Node =
  | Pane
  | { type: 'split'; direction: 'row' | 'column'; children: { node: Node; fraction: number }[] };

type Layout = {
  sidebar: Pane & { edge: 'left' | 'right' };  // 会话列表:全高独立柱,默认 left
  content: Node;                                // 内容区 = 递归分割树(tmux / VSCode 网格同款)
  float: FloatPanel[];                          // v1 恒为空数组,占位
};
type Pane = {
  type: 'pane';
  id: string;
  panelKind: PanelKind;      // 'chat-main' | 'session-list' | 'right-tabs' | 未来 'ghost:<id>'
  collapsed?: boolean;
  minWidth?: number;
};
```

**三条结构性规则**:

1. **侧边栏(会话列表)是树外的全高独立柱**:保留折叠 / rail / 调宽,但不被内容区的任何分割切到;默认钉最左,远期最多支持整柱镜像到最右(`edge`),**不可进入内容区**。这与现状一致(左栏通顶、承载 mac 红绿灯让位)。
2. **内容区是递归分割树**:每个节点要么是面板,要么是往某方向切一刀的分割。**谁在分割树的外层,谁就不被里层切割**——想让某个面板「通顶」不被顶/底栏夹住,把它提到与那组行并列的外层列即可;想被夹住,就待在行组里面。左栏正是这条规则的极端形式(在整棵树之外)。
3. **顶栏/底栏只是内容区里的一刀**,永远切不到侧边栏,也切不到与它同级或更外层的列。

**默认布局 = 今天的样子**(递归树的最简实例,一刀竖切两栏):

```ts
{
  sidebar: { type: 'pane', id: 'sessions', panelKind: 'session-list', edge: 'left' },
  content: { type: 'split', direction: 'row', children: [
    { fraction: 0.73, node: { type: 'pane', id: 'chat',  panelKind: 'chat-main', minWidth: 400 } },
    { fraction: 0.27, node: { type: 'pane', id: 'right', panelKind: 'right-tabs' } },
  ]},
  float: [],
}
```

「面板通顶」的示例形态(工具面板全高,聊天被顶/底栏夹住):

```
内容区(先竖切两列)
├─ 列 A(全高):工具面板
└─ 列 B(内部再横切三行):顶栏 / 聊天主区 / 底栏
```

**持久化**:main 侧全局配置(用户级,不入 localDb 业务表),renderer 经 IPC 读写;**启动随首帧同步下发**——布局必须第一帧就位,禁止「先渲染默认再跳成用户布局」(遵守设计规范规则 7:杜绝跳变/空白帧)。

## 4. 组件结构

```
MainLayout(保留:窗口 chrome、标题栏、浮动按钮簇、全局对话框、BrowserWebviewPool)
├─ SidebarColumn     ← 树外全高独立柱(会话列表),折叠/rail 能力自带
└─ LayoutRoot        ← 新:渲染内容区递归分割树
   └─ SplitView      ← 递归:按 direction 排列 children,间隙挂通用 resize handle
      └─ PaneView    ← 尺寸/折叠(仅贴边时)/最小宽/(未来)关闭与弹出
         └─ PanelHost ← 按 panelKind 从面板注册表取组件渲染
```

**关键点:现有三个大组件一行不改**。`Sidebar` / 聊天路由视图 / `RightSidebar` 分别包装为 `session-list` / `chat-main` / `right-tabs` 三个内置面板——只是换挂载骨架,组件内部不动。右栏内部的 tab 系统整体作为一个面板搬入,内部不拆(拆分是后续可选项,见 §8)。

## 5. 现有行为在树里的表达(逐条映射,不丢功能)

| 现有功能 | 树里的表达 |
|---|---|
| 左栏折叠 / ⌘B | `pane.collapsed = true` |
| 左栏 rail 窄轨 | `session-list` 面板内部状态(不进树) |
| 右栏按 session 记忆折叠 | 面板内部保留现有 localStorage 分桶逻辑;树只管「在场」 |
| 拖拽调宽 | 分割节点 children 的 `fraction`;右栏现有 fraction 逻辑推广到所有分割 |
| 右栏 Maximize | 升级为引擎级能力:任意 pane 可临时「接管本行」,不再是右栏专属 hack |
| 设置页隐藏左栏 | 路由级布局豁免:设置页不走 LayoutRoot(维持现状特判) |

## 6. 引擎保护规则

1. `chat-main` 全局必须**恰好存在一个**、不可关闭、**不可折叠**(折叠等于隐藏,违反必须可见)、最小宽 400px;删行/删栏时自动回落到剩余空间。
2. 「重置布局」一键回默认值(等价 WoW `/resetui`)。
3. 窗口顶部 50px 是平台 chrome 领地(mac 红绿灯 + drag region / Windows 窗口控制按钮),树的渲染容器必须避让此 inset——未来「顶栏行」同样受此约束。
4. 面板内容默认 no-drag,不得吞掉窗口拖拽区。
5. **未知 `panelKind` 的树是合法树**(为意识卸载场景预设):校验器只查 kind 是格式合法的字符串,不枚举白名单——意识卸载后布局里残留的 `ghost:<id>` 节点不能导致整树被打回默认。分工:**校验器容忍它,渲染器隐藏它(pane 不渲染、空间自动回流,与「面板关闭」同一路径),编辑模式以幽灵槽位暴露它(可手动清理),重装意识时原位复活它**(位置/尺寸/折叠态全保留,对齐魔兽插件禁用/启用语义)。

### 6.0 面板标准头(pane chrome,2026-07-07 Lizi 定案)

每个面板(含未来一切意识面板)顶部由**引擎**提供一条标准 Tab 条,以现工具面板顶条为原型:

- **顶部内建 46px chrome 让位带**(2026-07-07 C1 实证补充):§6 规则 3 的"顶部 46px 系统领地"约束由标准头兜底——任何穿标准头的面板自动垫出这条带(归窗口拖动),不靠面板作者自觉,不会顶穿窗口 top bar;
- **左侧**:面板自定内容区(如工具面板的 tab pills +「+」;简单面板可以只是标题);
- **右端固定两颗系统按钮**:独立窗口(detach)+ 撑满页面(maximize)——引擎渲染,面板作者不用自己做、也不能去掉;
- **标准头同时是拖拽手柄**(直接拖转正的抓手)——由此"无头意识没地方按"的问题不复存在(编辑模式最硬的论据被标准头化解,与"不做编辑模式"的决策自洽);
- **折叠开关不在面板头上**:折叠/展开走聊天区靠缝角上的**常驻 toggle**(位置固定、目标按位置解析,见下方 6.1 修订);
- **例外**:`chat-main` 不用标准头(它有自己的 ContentHeader,且不可关闭/折叠;maximize 语义暂不适用主区)。

实施排期:现在唯一的真面板(工具面板)已天然符合此形态;标准头组件化(供任意 panelKind 复用)排在意识面板接入前(Step C 门槛)。

### 6.1 去方位化原则(Step B 前提)

pane 可换位后,代码里**不允许再用「左/右」方位词当身份**,只允许 panelKind + 树上的位置。三条落地规则:

- **折叠是位置赋予的能力,不是面板固有属性**:只有**贴内容区边缘的 pane** 拥有折叠,方向朝所贴边缘,**四个方向通用**(贴右缘向右收、贴左缘向左收、顶栏向上收、底栏向下收);中间的 pane 没有折叠、只有关闭。面板被拖到中间即失去折叠、拖回边缘自动恢复。左栏 rail 窄轨同为边缘专属能力。`chat-main` 例外:既不可关闭也不可折叠,任何位置都只能调宽;**它贴边时对应方向的折叠按钮直接不渲染**(不是渲染一个不可用的按钮)。
- **控件分两类,归属不同**(2026-07-07 修订,取代原「面板控件跟 pane 走,不钉窗口角」):
  - **面板自属控件**(detach / maximize):长在面板标准头右端(§6.0),跟着面板走;
  - **折叠/展开是位置的控件**:**常驻 toggle 钉在聊天区靠缝的角上,位置固定不跟面板跑**,目标 = 贴该缘的可折叠面板(位置寻址);贴该缘的是 `chat-main`(不可折叠)时该角**不渲染**任何折叠控件。按钮位置恒定(肌肉记忆)优先于「控件随面板」——Lizi 实测"按钮跟面板跑"方案后拍板推翻。
- **折叠/展开按钮的锚定从现右栏方案推导,双平台各自沿用既有惯例**(不发明新位置):
  - **右缘**:mac = 窗口右上 50px 浮层(该角无系统按钮,现行方案直接沿用);Windows = 该角被窗口控制按钮(min/max/close)占用,按钮放面板自身头部右端(现 TabBar 内置方案推广)。
  - **左缘**:沿用 ChromeActions 左上按钮簇惯例(mac 让位红绿灯、随栏宽平移)。
  - **上/下缘**:**仅当存在贴上/下缘的可折叠面板时才渲染**,锚在该面板头部右端(左右两角是平台 chrome 领地,不得占用);无顶/底面板时界面上不出现任何上下折叠控件。
  - **展开入口就是折叠按钮本身,不引入细条**:面板收起后,折叠按钮留在原锚点不消失(toggle 语义:再点一下展开)——即现状左右栏的行为(左上 ChromeActions 簇 / mac 右上浮层 / Windows 折叠态按钮回流 ContentHeader)原样推广到四个方向;顶/底栏收起后其按钮同样回流到所贴边缘的 chrome 带保持可见。
- **开关入口按位置寻址**(2026-07-07 修订,取代原「按 panelKind 寻址」):常驻 toggle 管「贴这条缘的面板」,不绑定特定 kind——换了哪块面板贴这条缘,按钮就管谁。文案随之中性化(说「面板」不说「右栏」,四语言同步)。

## 7. 实施切片:Step A(本篇立项范围)

**做**:布局树模型 + main 侧持久化 + IPC + LayoutRoot 渲染链 + 三个内置面板包装。

> **实施期范围修正**:原计划中的「通用 resize(fraction 制)」推迟到 Step B——实勘 MainLayout 后确认左右两套 resize hook 满身实战补丁(rail 磁吸、webview 穿透、maximize 联动),Step A 强行接管风险过高。Step A 只让树驱动 pane 的**顺序与在场**;尺寸与折叠仍由既有组件 props 驱动,树上 fraction 只持久化不渲染。

**验收标准:用户看不出任何变化。** 重构策略是绞杀式——统一「图纸」(面板接口)今天就定,房间以后按需盖,不给旧布局安排大手术。

**不做/不动**:三个大组件内部、右栏 tab 系统、BrowserWebviewPool、灵动岛、副窗口、拖拽编辑 UI。

**回归清单**(风险集中区,来自 MainLayout 现有战场注释;**macOS / Windows 两端都必须实测**,不允许「Mac 上好了就算过」):

- [ ] 三栏拖拽调宽,含 webview 区域上拖拽(pointer-events 穿透方案不回归)
- [ ] 左栏折叠 / rail 进出 / ⌘B
- [ ] 右栏 per-session 折叠记忆、跨 session 切换不串扰
- [ ] 右栏 Maximize 进出(main hidden 时宽度计算)
- [ ] 设置页 ⇄ 聊天页切换(左栏隐藏/恢复)
- [ ] 副窗口默认折叠行为
- [ ] 窗口缩放时 fraction 重算、ResizeObserver 无死循环
- [ ] Windows:窗口控制按钮不被挤位;mac:浮动折叠按钮与右栏对齐、红绿灯让位不变

**平台差异说明**:上述 chrome 差异(窗口按钮 / 红绿灯 / drag region / 缩放快捷键 / 灵动岛)全部留在 MainLayout 树外层,Step A 不新增任何平台分支,现有适配原样保留。

### 7.1 实施结果(2026-07-07,落地于 main)

五步全部完成,提交链(hash 以 main 现行历史为准):shared 模型(1/5,含 review 修复:fraction-sum 校验、childIndex 整数检查)→ main 持久化+IPC(2/5)→ 面板注册表+内置包装(3/5)→ LayoutRoot 接管骨架(4/5)→ dev 调试工具(5/5)。

- **代码验证**:布局相关单测 59 例全绿(树 33 + Store 11 + 注册表/包装 6 + 引擎 5 + dev 工具 3 + review 补充);全量 typecheck 通过。
- **黑盒验证**(Windows 真机):三栏外观与重构前一致,九项回归通过;直接改 `layout.v1.json` 交换 children → 重启后首帧即交换布局(无跳变)、工具面板移至聊天区左侧、还原后复原——顺序由存档驱动 + round-trip 均实证。macOS 端待验证。
- **dev 调试入口**(dev 构建 only):DevTools console `__cindyLayout.get()/swap()/reset()`;DevTools 不可用时可直接编辑 userData/layout.v1.json 后重启(读路径自愈保证改坏也安全)。
- **实证病灶(Step B 去方位化的第一张工单)**:交换态下展开工具面板动画明显卡顿。根因:`useRightSidebarResize` 的可用宽度测量以「main 左边界」为锚,隐含"工具面板在最右"假设——面板移到聊天区左侧后,展开动画每帧推动 main 左边界 → ResizeObserver 每帧触发 → MainLayout 每帧重渲染,且老代码刻意规避的「右栏宽→可用宽→右栏宽」反馈环重新出现。默认布局不触发、零回归;**已由 B1a 修复**(见 §7.2)。

### 7.2 Step B:对齐结论与切片(2026-07-07)

与 Lizi 对齐后的三条结论:

1. **B1(去方位化 + 尺寸接管)先做**,再谈编辑模式。
2. **折叠记忆的作用域按面板各自声明**:面板注册表元数据增加 `collapseMemory: 'global' | 'per-session'`,两种都支持、由每种面板自己配置。内置面板对齐现状:`session-list` = global(左栏折叠全局一份)、`right-tabs` = per-session(右栏按会话分桶记忆)、`chat-main` 无折叠不适用。
3. **编辑模式交互形态**(2026-07-07 已决,原型体感后 Lizi 拍板):**直接拖转正,不做编辑模式**——标题条即按即拖 + 长按窗体 600ms 兜底,落点高亮(目标面板真实矩形)松手才交换。编辑模式延后:等未来网页类/无头意识真的撞上"没有可按压面"再补,不预先造机制(与 B4 同原则)。已知取舍:(a) 标题条从窗口拖拽区划给面板(dev 实测 Windows 左栏顶行足以承担窗口拖动;mac 待实测再定平台口径);(b) 网页区域长按无效(平台机制:webview 事件宿主不可见)长期存在。
   决策载体:`renderer/layout/PanelDragPrototype.tsx`(dev-only 已合入),**转正排在 B2 之后**——拖拽转正意味着正式用户可进入交换态,必须先由 B2 把交换态的折叠/控件/开关入口全部去方位化,避免把半成品交付。

流程沿用 Step A 的步进门禁:每个切片都要过「代码验证(typecheck + 单测)+ 黑盒 QA」并经确认后才进下一片。

#### B1a:修测量方位假设(已落地,2026-07-07)

§7.1 实证病灶的修复。改法不是「按 pane 实际位置计算」,而是釜底抽薪——**测量锚从内容区挪出去**:

- `MainLayout` 把左侧「pinning 占位条 + Sidebar」包进一个透传 wrapper(`flex shrink-0`,布局零变化;peek 期间 aside 脱离文档流,wrapper 宽度自然等于占位宽,语义正确);
- 可用宽度 = row 宽 − 该 wrapper 宽,ResizeObserver 直接观测 row + wrapper,**不再看 main 的位置**——左栏折叠/rail/peek/拖宽照常触发重算,而内容区里任何面板的动画都不会再反哺测量,与面板停在哪一侧彻底无关;
- 附带收益:Maximize 期间 main 隐藏时的测量也不再依赖 main 在场。

验证:typecheck 通过、布局相关单测 59 例全绿;Windows 真机默认布局九项回归通过,交换态展开工具面板动画卡顿消除(实证)。macOS 待验证。

#### B1b-1:宽度数据源切到布局树(已落地,2026-07-07)

树上 `fraction` 从「只持久化」升级为「驱动渲染」的第一半:**持久化真身搬家,拖拽手感不动**。

- `useRightSidebarResize` 不再读写 localStorage,fraction 的真身是树上 right-tabs child 的 fraction:mount 同步读树(首帧就位)、松手/双击复位写回树(`layout.set`)、订阅 `layout:changed` 跟随外部写方;拖动过程仍走本地 state 每帧渲染,不写 IPC。
- **per-session 宽度记忆移除**(Lizi 2026-07-07 拍板"简化"):宽度全局一份,任何会话拖宽到处生效,与 VSCode 同策略。hook 不再收 sessionId。
- **寻址按 panelKind 不按方位**(§6.1):新增 `findSplitChildByPanelKind`,面板换到哪一侧都能找到自己的 fraction。
- **旧键一次性迁移**:首次 mount 把 `right-sidebar-fraction:last` 迁入树、清掉全部 `right-sidebar-fraction:*` 键;迁移值同步用于首帧,无跳变(规则 7)。迁移结果模块级 memo,StrictMode 双跑安全。
- **默认树占比修正 0.73/0.27 → 0.5/0.5**:对齐 hook 一直生效的 50/50 默认,新用户零变化。
- 左栏(树外全高柱)的像素宽 + rail 磁吸**不在收编范围**——它本就不是内容区分割,保持 useSidebarResize 不动是设计而非欠账。

验证:typecheck 干净;布局单测 59 → 76 例全绿(新增迁移/订阅/寻址用例);Windows 真机黑盒过(迁移无跳变、拖宽/双击复位/缩放等比、全局宽度跨会话生效、重启 round-trip)。macOS 待验证。

#### B1b-2:把手边缘去方位化(已落地,2026-07-07;范围较原计划收窄)

> **范围修正**:原计划「把手挪进引擎(LayoutRoot 渲染通用分割把手)」会提前撞上折叠/Maximize 的接管——把手显隐与折叠态绑死,而折叠接管是 B2 的事,强行做等于把 B2 手术拖进本片。故收窄为:**把手仍由 RightSidebar 渲染,但长在哪条边、往哪边拖变宽由树上位置推导**;引擎级通用把手并入 B2,与折叠/宽度渲染接管同刀(那时 BuiltinPanelBridge 撤走,引擎全权渲染,把手跟随宽度所有权走才干净)。

- hook 新增 `resizeEdge`(树推导:面板是所在分割首个 child(在最左)→ 把手在其右边缘,否则左边缘),订阅 `layout:changed` 即时跟随;拖拽方向按边缘取号(把手左缘=指针左移变宽,右缘=右移变宽)。
- RightSidebar 的把手 / hover 高亮线 / 1px 分割线按 `resizeEdge` 两侧渲染,永远长在朝聊天区的分界边上。
- 修复的实证病灶:交换布局下把手错边(长在贴左栏侧的固定边,拖起来指针与缝脱节)+ 拖拽方向反。
- 未动:webview 穿透(body `resizing-pane`)与 maximize 联动补丁原样保留(本片没动拖拽骨架);mac 右上浮层折叠按钮仍钉窗口角(§6.1 控件随 pane 走属 B2)。

验证:typecheck 干净;布局单测 76 → 79 例全绿(+边缘推导/广播跟随/缺面板兜底);Windows 真机黑盒过(默认布局把手回归一致;交换态把手/分割线在右缘、右拖变宽、双击复位均正常)。macOS 待验证。

#### B2:折叠与控件去方位化(已落地,2026-07-07,Windows)

三片全部完成(a=`bf460a8bf` / b=`283e7c0fc` / c=`b2c1b6894`):

- **B2a**:注册表 `collapseMemory` 声明(global / per-session / none)+ collapsePrefs 统一读写按声明分发;左栏折叠态迁入树 `sidebar.collapsed`(旧键一次性迁移,首帧无跳变,存档实证);右栏会话分桶保留、经统一入口。
- **B2b**:折叠/展开定为**位置的控件**——常驻 toggle 钉聊天区靠缝角上(收/开同一颗,面板贴右在右上、贴左镜像左上并翻转图标;贴缘是 chat-main 则该角不渲染);Win TabBar 收起按钮撤掉(detached 子窗口不受影响)。中途实证推翻过一版"按钮跟面板跑"方案(Lizi:按钮位置恒定优先),§6.1 已同步修订;§6.0 面板标准头(右端固定 detach+maximize、标准头即拖拽手柄)同轮定案。
- **B2c**:开关文案改纯动作词「折叠/展开」(按状态二分),删除 `toggleRightSidebar` 旧键,四语言同步,check:i18n 全过。

待办遗留:mac 交换态的控件锚定(右上浮层 → 按位置解析 / 左上挤 ChromeActions 簇)待 mac 真机实测再做;上下缘折叠等顶/底栏(B4)启动时按 §6.1 同规则实现。

#### B3:直接拖换位转正(已落地,2026-07-07,Windows;mac 关闸待真机)

原型(PanelDragPrototype)更名为正式组件 `renderer/layout/PanelDragController.tsx`,去掉 dev 门:

- **Windows 转正**:拖面板手柄 + 长按窗体 600ms 两种起拖、落点高亮松手交换,对正式用户开放。**拖拽区口径定稿**(Lizi 两轮实测后修订):46px 顶带**整条归窗口拖动**(第一版把顶带划给面板后窗口没了顺手抓握区,实测难受,推翻);面板手柄 = **36px Tab 条空白**(在面板身上,语义准;即 §6.0 标准头本体)+ 长按窗体兜底;聊天面板无 Tab 条,仅长按。
- **mac 暂不启用**(挂载方 `!isMac` 关闸):交换态控件锚定(B2b 遗留)未适配、顶栏拖窗习惯优先 —— ContentHeader 在 mac 维持窗口拖拽区;待 mac 真机轮一并开闸。
- **detached 子窗口不受影响**:TabBar 的窗口拖拽属性改为宿主显式声明(`chromeWindowDrag`,主窗口内嵌传 false、子窗口默认 true),子窗口 Tab 条保留经典拖窗行为。

#### C1:面板标准头 + 示例意识 + 缝即把手(已落地,2026-07-08,Windows)

Step C 开局片,三层交付(全部经 Lizi 真机逐轮验收):

- **C1a 扩展协议实证**:`PanelChrome` 标准头(§6.0,含 46px chrome 让位带 + 36px 头,头即拖拽手柄,按下即浮起)+ dev-only 示例意识面板 `ghost:hello` + 树加装/卸载底层操作(`insertRootSplitPane` / `removeRootSplitPaneByKind`,C2 装载器复用)+ `__cindyLayout.addDemo()/removeDemo()`。生产不注册示例面板,存档残留按"未安装意识"隐藏(§6 规则 5 预演)。
- **C1b N 面板拖拽**:两块互换模型升级为"拖到谁身上就和谁换位"(`swapRootSplitChildrenByKind`,fraction 随面板走);长按对一切可交互元素统一让路。
- **C1c 缝的宪法**:相邻可见面板之间**有且仅有一条**引擎分割线(面板自画侧边框全拆;隐藏面板不留孤线;折叠/隐藏面板的两条缝**单侧合并**为一条);**每条缝都是拖宽把手**(7px 抓握区、hover 高亮同左栏把手、拖动实时跟手零写盘、松手经 `transferSplitFraction` 只动两侧邻居、双击均分);非 chat 面板像素宽 = fraction × 可用宽经 `PaneWidthContext` 下发,chat 弹性吸收;RSB 私有把手拆除,`useRightSidebarResize` 瘦身为宽度兜底 + 所在侧推导。

实测修正记录:hover 高亮曾因 HSL 三元组 token 裸引用而透明(规则 16 点名坑);隐线规则曾双侧全藏导致收起中间面板后剩余两块间无线。macOS 全部待验证。

#### C2a/C2b:意识管家 + 面板装卸闭环(已落地,2026-07-08,Windows)

> 本节内的标识符(`cart.json` / `shared/cartridge.ts` / `CartridgeManager` / `cartridges:*` / `userData/cartridges` / `__cindyCarts` 等)是**落地当时的名字**,同日晚间已由 C2d 全量更名(brain / Ghost / ghost.json / `ghosts:*` / `__cindyGhosts`),此处保留历史原貌不改写。

意识第一次成为真文件(后缀 `.cindy`,zip 包内 `cart.json` 身份卡;品牌定名 Cindy 后由 `.liz` 整体更名,无存量兼容包袱):

- **C2a 主机侧管家**:清单模型/校验在 `shared/cartridge.ts`(main/renderer 共用);`main/cartridges/CartridgeManager` 目录即注册表(userData/cartridges/<id>),装 = 解压 staging 全过才切正式目录(防 zip-slip / zip bomb / 超限),卸 = 仅限仓库直接子目录;IPC `cartridges:list(sendSync)/install/uninstall/changed`,dev 走 `__cindyCarts` 控制台通道。
- **C2b 面板装卸闭环**:LayoutRoot 首帧前同步注册已装意识面板(与内置面板同帧,规则 7);声明卡面板 = `PanelChrome` 标准头 + 清单正文(`cartridgePanels.tsx` 通用组件,注册表新增 `unregisterPanelKind`);**装入即停靠**(main 随 install 调 `layoutWithCartridgePanel`:树上已有同 kind 则不动 → 原位复活;否则停聊天区右侧,fraction/minWidth 取清单)——广播顺序刻意为 cartridges:changed(先注册组件)→ layout:changed(pane 才出现);**卸下只注销组件**,树数据保留即"重装原位复活"的记忆来源(§6 规则 5 正式生效)。C1a 的写死示例面板与 `addDemo/removeDemo` 退役(换 `removePane(kind)`),`ghost:hello` 自此由真意识驱动。
- **顺手修正**:拖面板换位总开关曾绑死"右栏展开"(B3 双面板遗产),右栏一折叠连意识面板也不能拖 —— 改为落点现场过滤(`isDroppableRect`:折叠 w-0 / 隐藏面板无身体不算落点;落点为空不浮起拖影)。

#### C2c-1:设置页总览 + 三入口统一确认(已落地,2026-07-08,Windows;`ae32441fd`)

- **设置页「意识」tab**(导航位在模型供应商之下,Lizi 定位):已装清单卡片列表(名称/版本/声明型徽标/唤醒开关/抽离),空态引导装入;设置页地址 `?tab=ghosts`。
- **三入口统一装入流程**(Lizi 定案"安装都要统一弹窗"):设置页选文件(`ghosts:pick-file`,过滤 `.cindy`)/ 窗口拖入(GlobalDropImportListener 分支)/ 双击 `.cindy` 文件(argv / second-instance / open-file → main 侧 pending 缓冲 → `ghosts:install-requested` 信号 → renderer 取走),三条路全部汇入 renderer 侧同一条 `installFlow`:**inspect(只验不装)→ 应用内确认弹窗 → install**。`inspect` 为此从 install 中拆出共用前半程。
- **宽度自愈** `normalizeSubMinFractions`:装入面板首帧"先窄后跳大"的实证病灶——树上 fraction 与渲染 clamp 失配;自愈 effect 把低于最小宽的份额抬到位、chat 捐差额(250ms 防抖;拖动中 / 接管态 / 可用宽未知不动;chat 触底放弃)。
- **设置页接管**:LayoutRoot 新增 `suppressNonChatPanels`(设置页只渲染 chat-main 那格,意识面板不再冒进设置页)。
- **Windows 文件关联**:HKCU 自注册 `XDMaker.CindyGhost`(packaged-only);mac `CFBundleDocumentTypes` 已配(forge.config.ts),真机待验。dev 调试:F12 开 DevTools(dev 全局白名单)。

#### C2c-2:导航子项 + 单意识独立设置页(已落地,2026-07-08,Windows;`031e4414e`)

- 设置导航「意识」下每段已装意识一个**展开子项**,点击进独立设置页(`?tab=ghosts&ghost=<id>`;意识消失时守卫自动退回总览)。
- 单意识页三段式:头部(身份 + 唤醒开关)/ 信息卡(标识 / 面板停靠态 / 注入位置——后补打开按钮直达文件夹)/ **意识自定义设置区占位**(芯片型意识 C3 在此渲染自己的设置界面)/ 危险区(抽离)。
- **启用/停用(唤醒·沉睡)**:`setEnabled` 以安装目录内 `.disabled` 标记文件为真身;停用 = 面板注销、布局 pane 隐藏休眠,重启用走"重装原位复活"同一路径(§6 规则 5 语义复用)。
- 用户层文案全面切**攻壳语系**(意识 / 注入 / 抽离 / 唤醒·沉睡,四语言,典据与政治宗教风险已核),同轮定案见意识系统 README 命名体系节。

#### C2d:brain/ghost 代码层更名 + 兼容层移除(已落地,2026-07-08,Windows;`9b79f51db`)

命名终态(Lizi 拍板"意识在大脑里"):模块目录 `cartridges` → **brain**(main / renderer / userData 三处),实体与 API 全面 **Ghost** 化——`GhostManager`、`shared/ghost.ts`、清单 `ghost.json`、IPC `ghosts:*`、panelKind 前缀 `ghost:`、tab id `ghosts`、dev 工具 `__cindyGhosts`、错误码 `GHOST_FILE_INVALID`。

**曾用名兼容层不保留**(更名早于任何发布,Lizi 定案不留):曾短暂写过的四处兼容(布局存档 `cartridge:` 前缀读档归一 / `userData/cartridges` 启动搬家 / `cart.json` 读取兼容 / `?tab=cartridges` 重定向)同日全部移除,对应测试用例一并删除;开发机存量数据手工洗成新格式。**今后不存在任何 cartridge 时期的合法存档**——§6 规则 5 的"未知 panelKind 容忍"依旧成立,但它服务的是"意识卸载后的残留",不是旧前缀。

#### B4(未启动)

- 顶/底栏与浮层——等真实面板需求出现再启动,不预先造机制。

## 8. 未来拓展方式(全部是「往树里加数据」,不改引擎)

| 扩展 | 做法 | 阶段 |
|---|---|---|
| 用户拖拽重排 | 编辑模式:拖 pane 换位/跨行、增删行,写回树 | Step B |
| 顶栏/底栏 | 内容区树里加一刀横切——**只切自己所在的列,不切侧边栏与外层列**(并避让 chrome inset) | Step B |
| 面板通顶(逃出顶/底夹层) | 把该面板提到与行组并列的外层列(递归树天然支持,零新机制) | Step B |
| 面板关闭/弹出独立窗口 | PaneView 通用能力 + 副窗口宿主(pane / float / window 三种宿主形态) | Step B |
| 浮层面板(WoW 式) | 启用 `float[]`:位置/尺寸/z-index,渲染进全局 portal | Step B/C |
| 拆右栏 | right-tabs 内部插件逐个提干为顶级 panelKind,可被拖成独立栏 | 可选,渐进 |
| **意识面板** | 面板注册表接受 `ghost:<id>`,意识面板停任意 pane/浮层/窗口——引擎无感知 | Step C |
| 布局预设/分享 | 树即 JSON,导入导出天然免费 | 远期 |

核心回报一句话:**引擎只认识「树 + 面板注册表」;Step A 之后,所有新花样(包括意识)都只是新的 panelKind 或新的树节点,布局引擎不再动刀。**
