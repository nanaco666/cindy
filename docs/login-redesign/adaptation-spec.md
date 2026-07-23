# Cindy 登录流程 UI 替换适配规范

> 本文是登录新设计落地的适配规范，覆盖桌面端、移动端与系统浏览器回调页。输入来源为 `docs/login-redesign/acceptance-report.md`、`figma-component-spec.md`、`DESIGN-login.md`、`current-adaptation-audit-desktop.md`、`current-adaptation-audit-mobile.md`、`callback-pages-classification.md` 与 `verify-pass2/` 复核底稿。
>
> 参数优先级：参数冲突时，以 `acceptance-report.md` §3 的 lead 仲裁结论为准；组件参数以 `figma-component-spec.md` 为准；逐屏参数以 `DESIGN-login.md` 为准。
>
> 标记规则：`〔设计稿已定义〕` 表示 Figma 与验收材料已有明确参数，实现必须照抄；`〔建议·待拍板〕` 表示设计稿没有定义，本文只给实现建议，不能当作定案。

## 0. 适配总原则

1. 〔设计稿已定义〕登录新设计的核心视觉是品牌红底〔已作废(wave4 2026-07-20)：品牌红底改白底体系,权威见 `design.md` §8;其余四要素+白面板+圆钮不变〕、Cindy 立绘、手写体 Slogan、`CINDY.` 字标、白色登录面板与第三方登录圆钮。桌面设计基准画布为 `1819 x 2098`；移动设计基准宽为 `750`，已有 `750 x 1624` 与 `750 x 1334` 两档。
2. 〔设计稿已定义〕已定义参数必须按 `figma-component-spec.md` 与 `DESIGN-login.md` 实现，不重新推导、不目测补值。Slogan 是矢量资源，不按文本排版重建。
3. 〔设计稿已定义〕移动端不实现 hover。移动端只保留 press / active / focus / disabled / busy 等触摸语义；组件库中的 hover 只用于桌面客户端和桌面浏览器。
4. 〔建议·待拍板〕设计稿未定义的横屏、平板、极端尺寸、键盘避让、最小缩放比例、桌面窗口 minHeight 调整、回调页语言来源等，全部进入本文末尾"缺口与待拍板汇总"，实现前需要用户或设计确认。
5. 〔建议·待拍板〕落地代码应把"设计坐标模型"和"状态机渲染"拆开：状态机决定显示哪个组件状态，布局模型只负责把固定设计坐标映射到当前窗口，不让某个状态的自然内容高度影响五要素坐标。

## 1. 桌面端适配模型

### 1.1 推荐模型

1. 〔设计稿已定义〕桌面端以 `1819 x 2098` 作为唯一设计 stage。核心坐标为：立绘 `443,275,934 x 934`；Slogan `1191,863,460 x 134`；字标 `570,1029,680 x 180`；登录组 `570,1229,680 x 560` 或 `680 x 440`；登录组内第三方入口在 `y=480`，面板到底部第三方入口 gap 为 `40`。
2. 〔建议·待拍板〕推荐实现为"固定设计 stage + 绝对定位 + 整体 `transform: scale(...)` + 红底全屏铺底"。〔已关闭：stage 模型/居中锚点按 demo 呈现仲裁定案（implementation-plan 附录 C §1.1）;「红底全屏铺底」已作废(wave4)——背景=白底体系（底色 `var(--surface)` + 双 `#F70121` 渐变）代码铺满,见 `design.md` §8〕不要用 flex/grid 让立绘、Slogan、字标、面板、第三方入口随窗口比例重排。
3. 〔建议·待拍板〕stage 水平锚点取设计画布中心 `x=909.5`，而不是五要素 bounding box 中心。原因是立绘、字标、面板都以 `x=910` 为主轴居中，Slogan 是右侧装饰资源；若按 bounding box 居中，会让输入面板偏离窗口中心。
4. 〔建议·待拍板〕stage 垂直锚点取设计画布中心 `y=1049`。核心可见内容包围盒按 `left=443, top=275, right=1651, bottom=1809` 计算（圆钮行底 `1789` + 20px 余量），用于缩小时判断五要素是否完整可见。〔2026-07-19 沿革〕当日曾为「SSO 文字链」临时扩到 1862——后经设计稿核实 SSO 是圆钮行内最后一颗圆钮、文字链形态不存在（见条目 9），该扩展作废。
5. 〔建议·待拍板〕缩放公式建议：〔已作废：本条 fitScale 公式与条 6 minScale 均被 demo v3.1 拍板缩放公式 `scale = min(1, viewportHeight/2098, (viewportWidth-24)/680)` 取代（`implementation-plan.md` 权威链收口项）〕

```ts
const stage = { width: 1819, height: 2098, cx: 909.5, cy: 1049 };
const core = { left: 443, top: 275, right: 1651, bottom: 1809 }; // 圆钮行底1789+20(SSO=行内圆钮,无文字链)
const safe = 20;

const fitScale = Math.min(
  (viewportWidth / 2 - safe) / Math.max(stage.cx - core.left, core.right - stage.cx),
  (viewportHeight / 2 - safe) / Math.max(stage.cy - core.top, core.bottom - stage.cy),
  1,
);

const scale = Math.max(0.36, fitScale);
```

6. 〔建议·待拍板〕〔已作废：minScale 0.36 随条 5 一并被 demo v3.1 拍板公式取代;U-3 终裁维持 800×600、极小窗口 scale≈0.286 为已知可接受行为〕推荐桌面硬最小适配比例为 `0.36`。推导：当前主窗口最小尺寸为 `800 x 600`；若强行完整 fit 整个 `1819 x 2098` stage，比例只能到 `600 / 2098 = 0.286`，输入框会缩到约 `154 x 23`，不可用。新模型只要求红底外溢区可裁切、核心五要素完整可见，因此按核心包围盒和 stage 中心计算：高度限制为 `(600/2 - 20) / max(1049-275, 1809-1049) = 280 / 774 = 0.362`，取工程安全值 `0.36`〔2026-07-19 沿革：文字链版包围盒曾推得 0.34，随条目 9 作废，回归 0.36〕。此时登录面板约 `245 x 158`，输入框约 `194 x 29`，属于硬兜底而非舒适尺寸。
7. 〔建议·待拍板〕红底必须由外层 full-viewport 背景铺满，stage 自身允许在窗口上下溢出并被裁切。被裁切的只能是红色背景留白，不得裁切五要素。〔已作废(wave4)：红底与「外溢裁切」语义作废——背景=白底体系由代码渐变 full-viewport 铺满,天然全屏无裁切问题（`design.md` §8.2）;「不得裁切五要素」原则沿用〕
8. 〔lead 延展 · 2026-07-19 · 用户确认方向〕**窄窗 Slogan 防裁切**：当 `(viewportWidth/2)/scale < (1651-909.5)+20` 时，Slogan 相对 stage 按溢出量整体左移（`translateX(-overflow)`），保持完整清晰展示——只平移、不缩放、不裁切；允许左移后与立绘叠压（移动长屏稿本就叠压）。面板/字标/圆钮行受中轴对称保护不需此规则。
9. 〔设计稿事实 · 2026-07-19 修正〕SSO 入口为第三方圆钮行内**最后一颗圆钮**（组件 `329:243`，icon `329:248`），设计稿不存在「使用企业 SSO 登录」文字链形态（该形态来自现网旧代码，不进新皮肤）；核心包围盒 bottom 相应回归 `1789+20=1809`。
10. 〔建议·待拍板〕不推荐"按窗口宽高重排布局"的方案。理由：现状桌面审计已确认旧实现是单卡片流式居中，缩小时会裁切；新设计要求五要素相对坐标恒定，重排会破坏 Slogan 与字标、面板的 Figma 坐标关系。

### 1.2 BrowserWindow 与窗口尺寸

1. 〔设计稿已定义〕设计稿未定义 Electron `BrowserWindow` 的 `minWidth`、`minHeight`、默认窗口尺寸、最大窗口尺寸。
2. 〔建议·待拍板〕硬兜底建议沿用当前主窗口 `minWidth=800`、`minHeight=600`，并配合 `minScale=0.36`。这样不扩大桌面端全局窗口约束，同时满足五要素完整可见。〔已关闭 2026-07-20:U-3 终裁——`minWidth=800`/`minHeight=600` 维持不改,BrowserWindow 配置禁区;`minScale=0.36` 已被 demo v3.1 拍板公式取代,极小窗口 scale≈0.286 为已知可接受行为〕
3. 〔建议·待拍板〕舒适阅读建议另设登录期窗口下限 `900 x 680` 或把全局 `minHeight` 提到 `680`。按同一核心包围盒推导，`680` 高度可给到约 `0.41` 的比例，输入框约 `221 x 33`，比 `0.36` 更接近现有桌面登录按钮可读尺寸。是否调整全局窗口下限需要拍板，因为会影响登录后所有页面。〔已关闭 2026-07-20:U-3 终裁——不提高任何窗口下限,维持 800×600〕
4. 〔建议·待拍板〕默认窗口尺寸可继续沿用当前 `1280 x 800`。在该尺寸下，按推荐公式比例约 `0.49`，输入框约 `265 x 39`，比硬兜底明显更可用。
5. 〔建议·待拍板〕最大尺寸不设上限；stage `scale` 建议封顶 `1`。超大窗口只增加红底留白，不把资源放大超过 Figma 1x。〔已关闭：scale 封顶 1 已含于 demo v3.1 公式 `min(1,…)`（implementation-plan 附录 C）;「红底留白」随 wave4 改判为白底体系背景留白〕

### 1.3 缩放、DPI 与系统缩放

1. 〔设计稿已定义〕Figma 坐标均为设计 px，未定义 DPR、`srcset`、系统缩放或 Electron zoom 策略。
2. 〔建议·待拍板〕布局坐标用 CSS px 表达，DPR 只影响图片资源选择，不参与几何计算。不要把 Figma 坐标乘以 `devicePixelRatio`。
3. 〔建议·待拍板〕图片资源使用 `image-set()` 或等价机制提供 1x/2x/3x，几何盒仍按设计坐标缩放。
4. 〔建议·待拍板〕若 app 允许 `webContents.setZoomLevel`，登录 stage 的适配计算仍以浏览器报告的 CSS viewport 为准；验收需要覆盖 macOS Retina、Windows 125%/150% 缩放。

### 1.4 macOS / Windows 窗口差异

1. 〔设计稿已定义〕桌面画布左上存在三色窗口点 group：`x=20 y=20 w=84 h=20`。五要素从 `y=275` 开始，不与窗口点重叠。
2. 〔建议·待拍板〕macOS 保留 `titleBarStyle: 'hidden'`，优先使用系统 traffic lights，并将位置调到接近 `20,20`。如果 Electron 版本或平台限制无法精确控制，需要在验收中列明差距。
3. 〔建议·待拍板〕Windows 继续使用 frameless 自绘窗口控件，但控件属于系统 chrome overlay，不参与五要素 stage 坐标。Windows 右上控件没有 Figma 参数，不能自由设计为"100% 还原"。
4. 〔建议·待拍板〕拖拽区域覆盖红底顶部，不额外占用 46px 文档流高度。〔已关闭：拖拽条 overlay 化已工程定案（implementation-plan 附录 C §1.4 条4,PR2a 落码）;「红底顶部」随 wave4 改判为白底体系背景顶部〕旧登录页的 46px toolbar 若保留为普通布局，会把 stage 下推，必须移除或改成 overlay。

### 1.5 i18n 四语长度与锁死布局

1. 〔设计稿已定义〕Figma 已定义的文字框宽度包括：标题国区 `236`，国际 title group `680`，副标题 `599`，输入文字区域 `409`，按钮文字区域 `516`，错误文案 `680`，SSO 行标题/副文案 `409`。
2. 〔设计稿已定义〕中文源文案在上述框内通过验收：如 `欢迎使用 CINDY`、`选择一种方式安全登录`、`请输入手机号(含国家区号）`、`验证码已发送至 Praise@xd.com`、`通过 Example SSO 单点登录`。
3. 〔建议·待拍板〕四语 i18n 不是 Figma 已定义内容。实现必须锁定文字框坐标，不允许因英文、日文、韩文更长而移动面板、按钮或第三方入口。
4. 〔建议·待拍板〕落地前需要用 HarmonyOS Sans SC 及平台 fallback 对 zh-CN / en / ja / ko 做实际测量。建议验收阈值：标题不超过设计框宽 `236` 或国际 title group 内可用宽；副标题不超过 `599`；按钮不超过 `516`；输入 placeholder 不超过 `409`。
5. 〔建议·待拍板〕若四语超宽，优先方案是产品给短文案；次优方案是在同一文字框内做单行动态字号下限或省略。不得通过扩大框、换行撑高面板、改按钮宽度来解决。

## 2. 桌面各状态帧切换

1. 〔设计稿已定义〕桌面基础登录态 `Log_in` 为 `680 x 560`，其中白面板恒定 `680 x 440`，第三方入口在面板下方 `y=480`；验证码、登录方式选择、浏览器等待、准备、错误等中间态 `Log_in` 为 `680 x 440`，没有第三方入口。
2. 〔设计稿已定义〕`Log_in` 的左上角在所有桌面帧均为 `x=570 y=1229`。状态切换时不能把 `680 x 440` 面板重新垂直居中到原 `680 x 560` 区域。
3. 〔建议·待拍板〕实现时把白面板当作固定 `x=570 y=1229 w=680 h=440` 的绝对层；第三方入口当作固定 `x=570+225/150 y=1229+480` 的可见层。显示或隐藏第三方入口时只变 opacity / pointer-events，不改变面板坐标。
4. 〔建议·待拍板〕`560 -> 440` 与 `440 -> 560` 状态切换不做高度动画，不让父容器 natural height 参与布局。若需要过渡，只允许 compositor-friendly 的 opacity / transform，且不得产生空白帧。
5. 〔建议·待拍板〕准备态、等待态、错误态切换时，立绘、Slogan、字标、面板左上角保持完全不动；只替换面板内部组件。遵守仓库 `DESIGN.md` 视觉连续性规则：先拿到状态数据，再更新显示，避免先清空再填充。
6. 〔建议·待拍板〕loading 动画只挂在外层 wrapper 的 `transform` / `opacity` 上，不能在 SVG path 或 mask 上做 infinite 动画。

## 3. 移动端适配模型

### 3.1 基准与两档规则

1. 〔设计稿已定义〕移动设计稿只有 `750 x 1624` 与 `750 x 1334` 两档；按移动实现可先用 `Figma px / 2` 映射到 375pt 设计宽。
2. 〔设计稿已定义〕两档中 `Log_in` 始终 `680 x 560`，白面板始终 `680 x 440`，输入框 / 按钮始终 `540 x 80`，第三方圆钮始终 `80 x 80`，面板到第三方入口 gap 始终 `40`。这是"功能区刚性"。
3. 〔设计稿已定义〕两档中上方视觉区发生缩放和位移：立绘约 `0.8x`，Slogan 约 `0.79x`，字标 `0.88x`。这是"视觉区弹性"。
4. 〔设计稿已定义〕国区和国际区短屏 `750 x 1334` 的五要素几何一致；国际区多 `Global` pill 和 Google 圆钮。长屏 `750 x 1624` 的立绘 y 存在国区 `116` 与国际区 `96` 的设计稿内部不一致，见缺口 #1。

### 3.2 两档之间线性插值

1. 〔建议·待拍板〕移动布局引擎建议在 750 设计宽坐标系内计算。先按实际可用宽度得到 `widthScale = viewportWidth / 750`，再把可用高度反投影为 `designHeight = viewportHeight / widthScale`。
2. 〔建议·待拍板〕当 `1334 <= designHeight <= 1624` 时，使用线性插值：

```ts
const t = (designHeight - 1334) / (1624 - 1334);
const lerp = (shortValue: number, longValue: number) => shortValue + (longValue - shortValue) * t;
```

3. 〔建议·待拍板〕视觉区元素按两档坐标插值：`CINDY_mobile`、`SLOGAN`、`WORD_MARK` 的 `x/y/w/h` 都插值。功能区只插值 `Log_in.y`：`734 -> 973`；`Log_in.w/h`、面板、输入、按钮、圆钮尺寸不缩放。
4. 〔建议·待拍板〕第三方入口不单独插值。它始终跟随 `Log_in` 内部坐标：国区 `x=225 y=480 w=230 h=80`；国际区 `x=150 y=480 w=380 h=80`。
5. 〔已拍板 2026-07-19〕长屏立绘 y **双区统一为 116**：缺口 #1 的两帧不一致（国区 116 / 国际区 96）以最新批次帧 `358:434`（y=116）为仲裁基准收口，消除切区跳动；国际区旧帧 `347:2857`（y=96）待设计回写。插值公式不再保留地区变量。

### 3.3 1334 以下与 1624 以上

1. 〔设计稿已定义〕设计稿没有提供 `750 x 1334` 以下或 `750 x 1624` 以上行为。
2. 〔建议·待拍板〕`designHeight > 1624` 时建议冻结 1624 档五要素尺寸和相对坐标，把多余高度作为红底留白分配到 stage 上下。不要继续放大立绘或面板。〔已关闭：U-8a 裁决照 demo（两档外行为按 demo 已验收实现落码）;「红底留白」随 wave4 改判为白底体系背景留白〕
3. 〔建议·待拍板〕`designHeight < 1334` 时建议优先保护功能区：白面板、80px 输入框、80px 主按钮、80px 第三方圆钮不缩放；视觉区可继续缩小、上移或淡出。低于能完整放下 `Log_in 560` 与底部 safe area 的尺寸时，是否启用整体缩放或滚动需要拍板。
4. 〔建议·待拍板〕建议建立小屏测试档：`320 x 568pt`、`360 x 640pt`、`375 x 667pt`、`375 x 812pt`、`390 x 844pt`、`430 x 932pt`。

### 3.4 Safe Area

1. 〔设计稿已定义〕Figma 的 iPhone Status Bar 是视觉 mock，`x=0 y=0 w=750 h=115.672`，不是运行时真实 safe area 规则。
2. 〔建议·待拍板〕红底延伸到物理屏幕边缘；交互元素使用 `useSafeAreaInsets()` 保护。〔已关闭(工程定案)：沿现网 SafeAreaView 机制（implementation-plan 附录 C §3.4）;「红底」随 wave4 改判为白底体系背景 edge-to-edge 铺满,insets 保护规则沿用〕底部第三方入口到屏幕底部的视觉参考为短屏 `40`、长屏 `91`。
3. 〔建议·待拍板〕当底部安全区大于设计底部留白时，优先上移整个 `Log_in`，不得压缩输入框和按钮。
4. 〔建议·待拍板〕Android 三键导航与手势导航都需要实测；导航条侵占空间时按真实 `bottomInset` 计算，不按固定机型表。

### 3.5 键盘避让

1. 〔设计稿已定义〕设计稿没有给键盘打开状态。
2. 〔建议·待拍板〕键盘打开时，白面板内当前输入框、主按钮、错误提示必须可见；功能区控件不缩放。
3. 〔建议·待拍板〕推荐策略是"面板优先"：计算键盘顶部与面板底部的 overlap，整体 stage 向上平移；若仍不足，再只对视觉区立绘、Slogan、字标做淡出或进一步缩小。不要让键盘把输入框盖住。
4. 〔建议·待拍板〕是否允许键盘态隐藏 Slogan 或裁切部分立绘，需要设计拍板；当前不能写成定案。

### 3.6 横竖屏、平板与折叠屏（2026-07-19 wave3 重写 · iPad 稿已补，本节替换旧「无 iPad 稿」前提）

1. 〔设计稿已定义〕iPad 稿已补两帧：竖屏 `iPad mini 8.3 - 1`（358:473，744×1133）与横屏 `Log in_iPad_1133×744`（358:833，**实测画布 1180×820**——帧名与实际尺寸不符，以实测为准）。精确几何见 `DESIGN-login.md` wave3 追加节。
2. 〔lead 细化〕**iPad 竖屏 stage**：基准 744×1133（mini 档）。设计稿控件为手机 750 稿的 ≈0.794117 等比缩放（panel 540×349.41 r28.588、input/button 428.824×63.529、圆钮行 gap 55.588）。其余竖屏档位（820×1180 / 834×1210 / 1032×1376）以 744×1133 为基准整体等比缩放 `scale = min(w/744, h/1133)`，缩放后水平垂直居中，背景铺满〔wave4 改判：白底体系,原「红底铺满」已作废（`design.md` §8.2）〕，不重排、不单独出稿。
3. 〔lead 细化〕**iPad 横屏 stage（左右构图）**：基准 1180×820（标准档）。左列 = 立绘（x86,y73,481.43×579）+ SLOGAN（x279.54,y478.53,339.16×97.2；〔PR5 回写〕demo 仲裁 cindy-login-hifi.html:2148,设计稿原值 x176,y450,486.02×141.58 已按 demo 呈现收口）；右列 = WORD_MARK（x736.73,y192.57,297.32×101.55；〔PR5 回写〕demo 仲裁 cindy-login-hifi.html:2149,设计稿原值 x607,y177,556×133.44 已按 demo 呈现收口）+ Log_in 组（x662,y328,445.64×367；内含 panel 445.64×288.36 r23.593、input/button 353.893×52.429、圆钮行 gap 45.875）。五要素相对基准帧绝对锁定，整体 `scale = min(w/1180, h/820)`，clamp 到 [0.85, 1.30]〔已关闭：clamp 上限 1.30 与 demo 冲突,按 demo 呈现仲裁收口为 `max(0.85, min(w/1180, h/820))`（仅下限 0.85、无上限,implementation-plan 权威链收口项）〕，缩放后水平垂直居中，背景铺满〔wave4 改判：白底体系,原「红底铺满」已作废（`design.md` §8.2）〕。各真机档位落点：mini 横屏 1133×744 → 0.9073；标准 1180×820 → 1.0；Pro11 1210×834 → 1.0171；13 寸 1376×1032 → 1.1661（clamp 内，无档位触界）。
4. 〔lead 细化〕**构图切换断点**（与 `responsiveViewportLayout` 现有 700pt 线对齐）：
   - `landscape && w ≥ 1000pt && h ≥ 690pt` → 横屏左右构图 stage（条目 3）；
   - `landscape` 但不满足上行（手机横屏、横向分屏窄窗）→ 回退竖排手机 stage 弹性规则（§3.1–§3.3，含矮视口压缩）；
   - `portrait && w ≥ 700pt` → iPad 竖屏 stage（条目 2）；
   - `portrait && w < 700pt`（手机、Split View / Slide Over 最窄 320pt、Stage Manager 窄窗）→ 手机两档插值规则（§3.1–§3.3）。
5. 〔lead 细化〕原「首版 auth route 锁竖屏」建议**作废**（横屏已有专门稿）；折叠屏与超宽异形屏不单独出稿，按条目 4 断点自动落入对应 stage。
6. 〔建议·待拍板〕iPad 横屏下软键盘/悬浮键盘弹起行为，并入 §7-B 键盘态拍板项一并决策。

### 3.7 fontScale、Android / iOS 差异

1. 〔设计稿已定义〕移动端字体参数来自组件规范：标题 `32`、副标题 `20`、输入 / 按钮 `24` 等；未定义系统 fontScale 行为。
2. 〔建议·待拍板〕沿用移动端现状 `maxFontSizeMultiplier = 1.2`。图片资源如立绘、Slogan、字标不响应 fontScale。
3. 〔建议·待拍板〕fontScale 1.2 下，标题、副标题、错误提示、按钮文案必须在既有框内测量；超宽不推动控件位置。
4. 〔建议·待拍板〕iOS 用 `KeyboardAvoidingView` 或键盘高度 hook；Android 需确认 `windowSoftInputMode` / Expo 行为，避免系统 resize 与自定义 stage 平移叠加。

## 4. 浏览器回调页响应式

1. 〔设计稿已定义〕回调卡为 `680 x 680`，圆角 `36`。White 卡为 `#FBFBFB` + `#D4D4D4` 边框；Dark 卡为 `#312F2F` + `#434343` 边框。卡内表情 `280 x 280`，标题 `42,352,598 x 38`，副文案 `41,396,599 x 23`，CTA `70,529,540 x 80`。
2. 〔设计稿已定义〕桌面浏览器页壳 `1831 x 1831` 中卡片位置为 `x=576 y=226`，即水平居中；扣除浏览器 chrome 内容区起点 `y=146.63` 后，文档内容内 top offset 约 `79`。
3. 〔设计稿已定义〕移动 Chrome 页壳 `750 x 1623` 中卡片位置为 `x=35 y=251`，即水平居中；扣除内容底色起点后，White top offset 约 `91`，Dark top offset 约 `80`。
4. 〔建议·待拍板〕真实系统浏览器页面无法控制浏览器 chrome，只控制 document viewport。推荐文档内卡片水平居中，竖向使用 top-biased anchor：桌面 top offset `80px`，移动 top offset `88px` 作为统一初值。
5. 〔建议·待拍板〕小窗和移动浏览器使用缩放适配：

```css
/* 伪代码，具体实现需避免 transform 后布局空洞 */
scale = min(
  1,
  (viewportWidth - safeLeft - safeRight - 32px) / 680,
  (viewportHeight - topOffset - safeBottom - 24px) / 680
);
```

6. 〔建议·待拍板〕当卡片缩放后仍放不下时，浏览器页允许纵向滚动；不得裁切 CTA。
7. 〔建议·待拍板〕生产环境 light/dark 跟随 `prefers-color-scheme`，preview 可继续用 query 或 data attribute 强制主题。系统浏览器不能依赖 Electron renderer token、`cindy-media://` 或 app 内主题上下文。
8. 〔建议·待拍板〕回调页语言来源仍待拍板：登录页跟 app locale，provider/Ghost/Claude/xAI/generic 当前部分跟浏览器 `Accept-Language`，见缺口 #12。

## 5. 资源规格与加载约束

1. 〔设计稿已定义〕桌面立绘使用 `CINDY_Client`，设计盒 `934 x 934`；移动立绘使用 `CINDY_mobile`，source 外框 `750 x 902`，内部 mask/crop 见 `figma-component-spec.md` §4.11 与 `verify-pass2/screens-mobile-callback.md`。
2. 〔设计稿已定义〕Slogan 是资源图层，外框 `460 x 134`；字标外框桌面 `680 x 180`，移动长屏 `750 x 180`，短屏 `660 x 158.4`。
3. 〔设计稿已定义〕回调页三类表情为成功、失败、中性/Warning 三张资源。成功和 Warning 有明确裁切百分比；失败为 `280 x 280` object-cover。
4. 〔建议·待拍板〕桌面 renderer 资源建议导出透明 PNG/WebP：`CINDY_Client` 至少 `934 x 934 @1x` 与 `1868 x 1868 @2x`；Slogan 至少 `460 x 134 @1x` 与 `920 x 268 @2x`；字标至少按最大外框导出 `750 x 180 @1x` 与 `1500 x 360 @2x`。
5. 〔建议·待拍板〕移动端资源建议提供 RN 可直接加载的 `@2x` / `@3x` PNG 或 WebP，保持透明背景。若使用 SVG，需要先确认移动工程依赖与打包链路。
6. 〔建议·待拍板〕回调页表情建议导出已经按 Figma 裁切好的 `280 x 280`、`560 x 560`、`840 x 840` 透明 PNG/WebP，避免系统浏览器 HTML 里复刻复杂 object-position 百分比。
7. 〔建议·待拍板〕系统浏览器回调页资源必须由 loopback server 同源提供，或内联 data URI。不能依赖 renderer bundle 相对路径、Electron 私有协议、`cindy-media://`、`xdt-image://`。
8. 〔建议·待拍板〕所有图片盒在加载前必须占位固定尺寸，避免布局跳变；失败时保留文字和 CTA 可用。

## 6. 状态到组件映射总表

> 组件状态参数引用 `figma-component-spec.md` §4。表中 `hover` 仅桌面端；移动端同状态不输出 hover 视觉。

| 区域 | 界面状态 | 组件映射 |
|---|---|---|
| 桌面国区 | 手机号默认 | `input_2/default` + `log_in_button/normal` + 第三方 Apple/SSO 圆钮 normal |
| 桌面国区 | 手机号输入中 | `input_2/focus` + `log_in_button/normal` + 第三方 Apple/SSO 圆钮 normal |
| 桌面国区 | 手机号登录中 | `input_2/filled` + `log_in_button/load` + spinner |
| 桌面国区 | 手机号报错 | `input_2/error` + `error_text/visible` + `log_in_button/normal` + 第三方 Apple/SSO 圆钮 normal |
| 桌面国区 | 验证码空 | `back/normal` + `input_验证码/default` + `Text_link/countdown` + `log_in_button/Disable` |
| 桌面国区 | 验证码填完 | `back/normal` + `input_验证码/focus` + `Text_link/resend` + `log_in_button/normal` |
| 桌面国区 | 验证码登录中 | `back/normal` + `input_验证码/filled` + `Text_link/countdown 或当前倒计时状态` + `log_in_button/load` |
| 桌面国区/国际区 | 浏览器等待 | 面板标题 + `loading_icon` + `log_in_button/normal`，文案 `取消` |
| 桌面国区/国际区 | 准备态 | 面板标题/副标题 + `loading_icon`，无 CTA |
| 桌面国区/国际区 | 错误态 | 面板标题/副标题 + `error_text/visible` + `log_in_button/normal`，文案 `重试` |
| 桌面国际区 | 邮箱默认 | `Global` pill + `input_2/default` + `log_in_button/normal` + Apple/Google/SSO 圆钮 normal |
| 桌面国际区 | 邮箱输入中 | `Global` pill + `input_2/focus` + `log_in_button/normal` + Apple/Google/SSO 圆钮 normal |
| 桌面国际区 | 邮箱继续中 | `Global` pill + `input_2/filled` + `log_in_button/load` + spinner |
| 桌面国际区 | 邮箱错误 | `Global` pill + `input_2/error` + `error_text/visible` + `log_in_button/normal` + Apple/Google/SSO 圆钮 normal |
| 桌面国际区 | 选择登录方式 | `back/normal` + 两个 `SSO 登录_企业/Normal` 行；桌面可用 Hover/Pressed，移动不用 Hover |
| 桌面国际区 | 个人验证码空 | `back/normal` + `input_验证码/default` + `Text_link/countdown` + `log_in_button/Disable` |
| 桌面国际区 | 个人验证码填完 | `back/normal` + `input_验证码/focus` + `Text_link/resend` + `log_in_button/normal` |
| 桌面国际区 | 个人验证码登录中 | `back/normal` + `input_验证码/filled` + `log_in_button/load` + spinner |
| 移动国区 | 初始登录 | 同桌面国区默认，但无 hover；圆钮只响应 press/active/disabled |
| 移动国际区 | 初始登录 | 同桌面国际区默认，但无 hover；国际移动 placeholder 文案待拍板 |
| 移动通用 | 输入 / 错误 / busy / disabled | 使用同名组件状态的触摸语义：focus、error、load、Disable；不实现 hover |
| 回调页 White 成功 | `login-success` 等成功类 | White 卡 + 成功表情 + `log_in_button/normal`，CTA `回到 CINDY` |
| 回调页 Dark 成功 | `login-success` 等成功类 | Dark 卡 + 成功表情 + `white_button/normal`，CTA `回到 CINDY` |
| 回调页 White 失败 | `login-error` 等失败类 | White 卡 + 失败表情 + `log_in_button/normal`，CTA `回到 CINDY` |
| 回调页 Dark 失败 | `login-error` 等失败类 | Dark 卡 + 失败表情 + `white_button/normal`，CTA `回到 CINDY` |
| 回调页 White 中性 | `warning` / 需继续操作 | White 卡 + Warning 表情 + `log_in_button/normal`，CTA `返回 CINDY` |
| 回调页 Dark 中性 | `warning` / 需继续操作 | Dark 卡 + Warning 表情 + `white_button/normal`，CTA `返回 CINDY` |

## 7. 缺口与待拍板汇总

### A. 继承 `acceptance-report.md` §5 十二项

**A. 设计稿内部不一致（双波独立复现，建议设计侧修稿）**
1. 移动 750×1624 立绘 y：国区 `132:2741`=116，国际区 `347:2857`=96（差 20px）——哪个为准？
2. 国际区移动帧 placeholder 仍为手机号文案（应为邮箱？桌面国际区是 `请输入邮箱`）

**B. 设计稿未提供（实现无据，需补稿或拍板）**
3. hover 缺口：输入框、Text_link、第三方圆钮、Global pill 无 hover 节点（桌面端这些控件 hover 行为无据）
4. 第三方圆钮无 pressed 节点
5. 桌面窗口外阴影 effect 参数 MCP 不暴露（两波均拒绝目测）
6. 所有文本行高仅返回 `normal`、字间距不暴露；loading 图标为静态 asset，无动画时长/easing 标注
7. Slogan 为矢量资源，无文本图层（实现按资源图直出，不排字）
8. 横屏/平板、750×1334 以下、750×1624 以上的移动端行为设计稿未定义（现有建议均标注「待用户确认」）
9. 桌面窗口极限缩小的最小适配比例数值未定义（同上）
10. `white_button/Disable` 变体存在但回调页未使用；WeChat 圆钮存在但登录帧未使用——是否保留实现？

**C. 语义确认项**
11. `login-success`/`ghost-success` 当前在 token exchange 前渲染，「登录成功」文案存在部分成功窗口（见 `callback-pages-classification.md` 改造点 6）
12. 浏览器页文案语言跟 app locale 还是浏览器 Accept-Language（改造点，现状两者并存）

### B. 本文新增待拍板项

13. 〔建议·待拍板〕桌面硬最小适配比例是否采用 `0.36`，以及是否接受这是"完整可见兜底"而非舒适阅读尺寸。〔已关闭 2026-07-20:U-3 终裁——`0.36` 随 demo v3.1 公式作废,接受完整可见兜底,极小窗口 scale≈0.286 已知可接受〕
14. 〔建议·待拍板〕是否把登录期或全局 `BrowserWindow minHeight` 从 `600` 提到 `680` 或更高，以换取约 `0.41+` 的可读比例。〔已关闭 2026-07-20:U-3 终裁——不提,维持 800×600,BrowserWindow 配置禁区〕
15. 〔建议·待拍板〕桌面超大窗口是否把 stage scale 封顶为 `1`，还是允许继续放大资源。
16. 〔建议·待拍板〕macOS traffic lights 与 Windows 自绘窗口控件如何对齐 Figma 左上窗口点；Windows 没有设计稿参数。
17. 〔建议·待拍板〕四语 i18n 超宽时采用短文案、动态字号、截断还是换行；本文建议不改变框尺寸和控件坐标。
18. 〔建议·待拍板〕移动端 1334 到 1624 之间是否确认使用线性插值模型。
19. 〔建议·待拍板〕移动端 1334 以下是否允许进一步缩小、淡出或隐藏视觉区，以及最低可接受整体比例。
20. 〔建议·待拍板〕移动端 1624 以上是否冻结五要素并增加红底留白。〔已关闭：U-8a 裁决照 demo;「红底留白」随 wave4 改判为白底体系背景留白〕
21. 〔建议·待拍板〕移动端 auth route 是否锁竖屏；平板是否使用居中手机舞台。
22. 〔建议·待拍板〕键盘打开时是否允许隐藏 Slogan 或裁切立绘；本文仅建议保护白面板和控件。
23. 〔建议·待拍板〕登录页暗色模式策略：红底是否恒定，白面板是否永远 White，还是提供 Dark 登录面板。〔已关闭(wave4)：登录页恒白底体系+浅色面板（原「红底恒定」问题随 wave4 作废）;回调卡跟系统深浅（implementation-plan 附录 C #23）〕
24. 〔建议·待拍板〕浏览器回调页是否从当前垂直居中改为 Figma 页壳对应的 top-biased anchor，桌面约 `80px`，移动约 `88px`。〔已关闭 2026-07-20:U-10 裁决照 demo——回调卡恒定 680×680 组合,内部组件零响应式变化;适配仅卡外纯色背景铺满 + 放不下时整卡等比缩放(top-biased anchor 80/88px + `scale = min(1,(w-32)/680,(h-topOffset-24)/680)`,demo:2652-2657 呈现仲裁),不得裁切 CTA〕
25. 〔建议·待拍板〕回调页资源交付方式选择 loopback 同源静态文件还是 data URI；需要确保系统浏览器可加载。〔已关闭 2026-07-20:U-7 裁决 data URI 内嵌——预裁切 280×280@2x webp ≤120KB/张,占位固定尺寸 + 失败降级〕
26. 〔建议·待拍板〕回调页失败 detail 是直接展示、折叠展示还是限制长度后展示。〔已关闭:demo missing-five ③(2026-07-19)——回调失败卡增设 detail 错误码行,monospace 沿共享页壳规格直接展示〕

待拍板项总数：`26`。
