# Cindy 登录新皮肤 · 设计遵循与延展总纲（design.md）

> 读者：后续做登录新皮肤**实现**或**补设计**的 AI / 工程师。
> 范围：仅登录新皮肤（品牌红底 + 五要素）的「遵循规则」与「延展决策」。回调页、迁移弹窗、设置页 provider 行等非登录皮肤主题不在本文展开。
> 基线：`origin/main@643c3dc`（与 `landing-plan.md` final v2、`adaptation-spec.md`、`figma-component-spec.md` 同基线）；现网 UI / 文案盘点基线为 `main@f8760bed`（`login-ui-inventory-f8760bed.md`）。
> 性质：本文是**延展决策权威**——记录用户已拍板的交互态延展、动画/阴影、横屏/平板、WeChat 入口四类决策，以及 demo 打磨阶段的全部拍板（§7）。设计稿已定义参数不在此重复抄全表，一律指向 `figma-component-spec.md`。
> **交互验收基准**：`docs/cindy-login-hifi.html`（自包含分享版 `cindy-login-hifi-standalone.html`）。用户已于 **2026-07-20 验收该 demo「无遗漏、设计准确」**——demo 呈现的界面、状态、文案、动画即为落地实现的验收标准；文档条目与 demo 冲突时，先按 demo 复核，再回改文档。
> **⚠ §8 五维例外（wave4 白底体系,2026-07-20）**：背景 / 字标 / SLOGAN / 面板描边 / Splash 呈现五个维度,demo 已过期,验收基准以 §8 的 wave4 新帧为准;demo 仅在其余维度（布局、状态覆盖、交互、动画时序、文案、语言）保持基准地位。详见 §8.2「demo 基准分层」。

## 0. 阅读口径与标记规则（先读）

本文每个带数值 / 参数的条目都按下列三类标记区分来源，**绝不混写**：

| 标记 | 含义 | 证据要求 |
|---|---|---|
| `〔设计稿实测〕` | Figma 设计稿已定义、经 MCP 读取确认的参数 | 必须带 `nodeId`，逐字引用 `figma-component-spec.md` 对应章节 |
| `〔延展·lead 判断〕` | 设计稿未定义、由 lead 基于已设计组件态归纳推导的延展规则 | 显式标注「非设计稿实测」，并指明照抄自哪个已设计态 |
| `〔用户拍板〕` | 用户明确指示某组件态参数「一模一样照抄」某已设计态（非 figma 实测、非 lead 归纳，用户直接拍板照抄） | 标注「用户拍板 YYYY-MM-DD」+ 照抄来源态 nodeId |
| `〔lead 决策〕` | 用户已拍板的处置结论（覆盖原缺口标注） | 标注决策编号 + 覆盖了哪个原缺口 |

**冲突仲裁**：任何条目若与 `figma-component-spec.md` 实测参数冲突，**以 `figma-component-spec.md` 实测为准**；本文延展规则仅在 `figma-component-spec.md` 已明确标注为「缺口 / 未定义」的点位上生效。`figma-component-spec.md` §8「异常 / 不一致 / 待设计确认」列出的 7 项缺口，是本文延展决策的输入清单。

---

## 1. 设计语言总纲

### 1.1 品牌底色与五要素

登录新皮肤的视觉骨架是「品牌红全屏底 + 五要素竖排」〔wave4 改判 2026-07-20：「品牌红全屏底」已作废,背景改白底体系,见 §8;五要素竖排骨架不变〕：

- `〔设计稿实测〕` 品牌红底 `#DF0C27` / 100%（swatch `228:1042`；文本 `228:1051`, `228:1058`；见 `figma-component-spec.md` §1.1）。全屏铺底，移动端画板背景同为 `#DF0C27`（移动帧 `132:2741`, `347:2662`, `347:2857`, `347:2884`）。〔已作废(wave4 2026-07-20)：红底全屏铺底改白底体系,见 §8;`#DF0C27` 语义限定为 accent（Global pill/字标红元素等）,禁止表达页面背景;本行保留作历史实测记录〕
- 五要素（来源 `figma-component-spec.md` §3 组件索引、§4.11 立绘/字标/签名素材、§5.1 桌面画板坐标）：
  1. **Cindy 立绘** — 桌面 `CINDY_Client`（source `347:971`，934×934）；移动 `CINDY_mobile`（source `347:2707`，750×902）。
  2. **SLOGAN** — 手写签名 `Dream it Create it`（`347:1276`, `347:1485`，外框 460×134）。矢量资源，不按文本排版重建。
  3. **`CINDY.` 字标** — 白色 WORD_MARK（`347:1274`, `347:1483`，外框 680×180）。
  4. **白色输入面板** — `Log_in_bg`（`347:1279`, `347:1488`, `347:1964`，680×440，fill `#FBFBFB`，radius 36）。
  5. **第三方圆钮行** — `247:1710` 组件集，单钮 80×80，fill `#2A2828`，stroke 1px `#434343`，radius 50（§4.5）。

`〔设计稿实测〕` 桌面五要素坐标（`figma-component-spec.md` §5.1，stage 1819×2098）：立绘 `443,275,934×934`；SLOGAN `1191,863,460×134`；字标 `570,1029,680×180`；登录组 `570,1229`（常规 680×560 / 中间态 680×440）；面板 680×440；第三方入口在面板下方 `y=480`，面板到第三方入口 gap=40。

### 1.2 调色板

调色板权威为 `figma-component-spec.md` §1 Color System（含 §1.1 登录语义色板、§1.2 状态/Toast 色板、§1.3 登录帧额外面色、§1.4 透明度/渐变/阴影）。**本文不重复抄全表**，实现时一律查 `figma-component-spec.md` §1。

### 1.3 平台差异硬规则

`〔设计稿实测〕` 客户端与移动端共用同一套设计与组件；**hover 状态仅桌面客户端 / 桌面浏览器生效，移动端不需要也不应实现 hover 视觉差异**；其余 `default` / `focus` / `filled` / `error` / `disabled` / `loading` / `pressed` 双端通用（`figma-component-spec.md` §0.1）。本文 §2 交互态延展规则在移动端只取 `pressed` / `active` / `focus` / `disabled` / `busy` 语义，不输出 hover。

---

## 2. 交互态系统

本节是 D-b 决策的完整落地。设计稿已为四类组件实测了 hover/pressed 叠层参数（§2.1 引用表）；设计稿未定义的第三方圆钮 / Global pill / 输入框 / 浅底图标钮 / Text_link 的态参数，由 §2.2 延展规则照抄已设计态归纳得出。两表分开，**实测与延展不混写**。

### 2.1 已设计实测态引用表

下表全部为 `〔设计稿实测〕`，参数逐字引用自 `figma-component-spec.md` §1.4（透明度 / 渐变 / 阴影表）与 §4（核心组件规格），每行带 nodeId。**移动端不实现 hover 列；pressed 列双端通用。**

| 组件 | 状态 | 叠层参数（over 底色） | nodeId | 底色 | 来源 |
|---|---|---|---|---|---|
| 主按钮 `log_in_button` | hover（仅桌面） | `linear-gradient(90deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.08) 100%)` over `#2A2828` | `247:1540` | `#2A2828` | figma §1.4 + §4.3 |
| 主按钮 `log_in_button` | pressed（双端） | `rgba(0,0,0,0.5)` over `#2A2828` | `247:1542` | `#2A2828` | figma §1.4 + §4.3 |
| 白按钮 `white_button` | hover（仅桌面） | `rgba(0,0,0,0.05)` over `#EEEEEE` | `347:2529` | `#EEEEEE` | figma §1.4 + §4.4 |
| 白按钮 `white_button` | pressed（双端） | `rgba(0,0,0,0.1)` over `#EEEEEE` | `347:2531` | `#EEEEEE` | figma §1.4 + §4.4 |
| 返回按钮 `back` | hover（仅桌面） | `rgba(255,255,255,0.7)` over `#EEEEEE` | `247:1637` | `#EEEEEE` | figma §1.4 + §4.6 |
| 返回按钮 `back` | pressed（双端） | `rgba(0,0,0,0.08)` over `#EEEEEE` | `247:1645` | `#EEEEEE` | figma §1.4 + §4.6 |
| SSO 选项行 | hover（仅桌面） | `rgba(255,255,255,0.08)` over `#EEEEEE` | `329:991` | `#EEEEEE` | figma §1.4 + §4.9 |
| SSO 选项行 | pressed（双端） | `rgba(0,0,0,0.08)` over `#EEEEEE` | `329:1009` | `#EEEEEE` | figma §1.4 + §4.9 |

> 注：`figma-component-spec.md` §1.4 与 §4 两处对上述参数表述一致；§4 各组件表另给出 stroke、radius、文本等完整规格，实现时一并查 §4。

### 2.2 延展规则表（lead 判断 · 非设计稿实测）

下表分两类来源：第三方圆钮（Apple / Google / SSO / WeChat 绿钮）的 hover / pressed 态为 `〔用户拍板 2026-07-19〕`——用户明确指示一模一样照抄 `log_in_button` 大黑钮对应态参数（loading / disabled 态原为同源 2026-07-19 拍板，**已被 §10 拍板 2026-07-21 移除·作废**，见下表对应行标注与 §10）；其余组件（Global pill、输入框、浅底图标钮）为 `〔延展·lead 判断〕`——设计稿未为这些组件提供 hover/pressed 节点（见 `figma-component-spec.md` §4.1 / §4.2 / §4.10 的 hover 行均标注「未提供独立 hover node」、§8 #7 也列为缺口），lead 基于已设计组件态归纳出叠层系统。`Text_link` 因用户已补 hover 设计稿，移出本表，见下方专项说明。**照抄来源列必须明确指向 §2.1 的哪一行已设计态。**

| 组件 | 延展态 | 延展参数（照抄来源） | 照抄自 §2.1 | 备注 |
|---|---|---|---|---|
| 第三方圆钮（Apple / Google / SSO / **WeChat 绿钮**） | hover（仅桌面） | 白 8% 叠层 over `#2A2828` | 主按钮 hover（`247:1540`） | `〔用户拍板 2026-07-19〕`；圆钮底色 `#2A2828` 为 `〔设计稿实测〕`（figma §4.5） |
| 第三方圆钮（含 WeChat 绿钮） | pressed（双端） | 黑 50% 叠层 over `#2A2828` | 主按钮 pressed（`247:1542`） | `〔用户拍板 2026-07-19〕`；**绿钮同样只叠遮罩、不改图标色**；图标 `#FFFFFF` 保持 |
| 第三方圆钮（含 WeChat 绿钮） | loading（双端） | 照抄主按钮 loading：spinner 24×24（`247:1546`）居中替换图标 | 主按钮 loading（`247:1544`） | ⚠️**〔已被 §10 拍板 2026-07-21 覆盖·作废〕** 原 `〔用户拍板 2026-07-19〕`；圆钮移除 loading 态；落码侧圆钮从不曾实现 loading（无 prop），无代码回退 |
| 第三方圆钮（含 WeChat 绿钮） | disabled（双端） | `rgba(255,255,255,0.7)` over `#2A2828` + stroke `#B4B4B4` + 图标 opacity 0.8 | 主按钮 disabled（`329:1226`） | ⚠️**〔已被 §10 拍板 2026-07-21 覆盖·作废〕** 原 `〔用户拍板 2026-07-19〕`；圆钮移除 disabled 态；落码侧删除 disabled 渲染路径（桌面 `LoginControls.LoginSocialButton` / 移动 `LoginSkinControls.LoginSocialButton` + 调用方 `disabled=` 绑定） |
| `Global` pill | hover（仅桌面） | 黑 5% 叠层 over `#EEEEEE` | 白按钮 hover（`347:2529`） | `〔延展·lead 判断〕`；pill 底色实为 `#DF0C27`（figma §4.10）；按「浅底圆角控件」归类照抄白按钮——见下方说明 |
| 输入框 `input_2` / `input_验证码` | hover（仅桌面） | 黑 5% 叠层 over `#EEEEEE` | 白按钮 hover（`347:2529`） | `〔延展·lead 判断〕`；输入框底色 `#EEEEEE` 为 `〔设计稿实测〕`（figma §4.1 / §4.2） |
| 输入框 `input_2` / `input_验证码` | pressed（双端） | **不适用** | — | 输入框已有 `focus` 态（stroke `#2A2828`），pressed 不额外叠层 |
| 密码可见 toggle 等浅底图标钮 | hover（仅桌面） | 白 70% 叠层 over `#EEEEEE` | 返回按钮 hover（`247:1637`） | `〔延展·lead 判断〕`；浅底图标钮归类同 `back`；底色 `#EEEEEE` |
| 密码可见 toggle 等浅底图标钮 | pressed（双端） | 黑 8% 叠层 over `#EEEEEE` | 返回按钮 pressed（`247:1645`） | `〔延展·lead 判断〕`；同上 |

> **`Global` pill 延展归类说明**：pill 底色实测为 `#DF0C27`（品牌红，figma §4.10），并非 `#EEEEEE`。lead 把它归入「白按钮参数族」是因为它属于「浅感圆角小控件」的视觉一致性归类；实现时若发现品牌红底上叠黑 5% 视觉不明显，可回退为「hover 仅 `opacity: 0.9`、不引入新色」的更保守延展——此条标注为延展规则里对深底 pill 的边界，后续实测时复核。

#### Text_link 说明（设计稿已补 hover · wave3 追加中）

`Text_link` 的两个已实测态为：resend `重新发送`（`#2A2828` + underline，`247:1612`）、countdown `42 秒后可重新发送`（`#D4D4D4` 无 underline，`247:1614`）——均见 `figma-component-spec.md` §4.7。

`〔用户已补稿 2026-07-19〕` **用户已于 2026-07-19 在 Figma 补了 `Text_link` hover 设计稿**（另一 worker 正在抽参数，wave3 追加中）。因此：
- `Text_link` hover 参数**以 `figma-component-spec.md` Text_link 状态表（wave3 追加后）为准**，本文不写任何 hover 参数。
- 本文档前版曾写的「hover 加下划线保持原色、pressed opacity 0.7」**发明值作废**，不落码。
- pressed 态 `〔已裁决 2026-07-20(U-9)〕`：pressed = `#1A1818`（default `#2A2828` 加深；underline / 字号 / 字重不变），双端通用；落码消费 `--login-link-pressed` token（PR0a 注册）。wave3 实测落地后如与裁决值不同，改 token 值即可，组件零改动。（原「wave3 落地前 pressed 暂按 default 态处理」句已被本裁决取代。）

> 此条不再是「延展」，改为「待 wave3 实测落地」。`figma-component-spec.md` Text_link 状态表追加后，以实测为准。

### 2.3 通则（lead 判断）

下列通则约束 §2.1 / §2.2 全部态的实现，`〔lead 决策〕`：

1. **态只叠遮罩 / 改 opacity / transform**，不改布局、字色、字号、字重、边框宽度、圆角、组件尺寸。态切换不产生布局位移。
2. **移动端一律不实现 hover**——只保留 `press` / `active` / `focus` / `disabled` / `busy` 触摸语义（与 `figma-component-spec.md` §0.1 平台规则一致）。
3. **全部态实现须 compositor-only**：hover / pressed 叠层用 `opacity` / `transform` / 伪元素 `background` 过渡，禁止挂 SVG path / mask 动画；遵守仓库 `AGENTS.md` 规则 7「常驻动画必须 compositor-only」（瞬态 hover/pressed 也按此实现，不破例）。
4. **叠层归属**：hover / pressed 叠层挂在组件**外层 wrapper** 或伪元素上，不侵入图标 / 文本子节点；绿钮、图标钮的图标色在态切换中保持不变。

---

## 3. 动画与阴影（D-a）

`〔lead 决策〕` 动画与窗口阴影沿用现有代码参数与系统默认，**不自定义新动效参数、不自定义窗口阴影**：

| 项 | 决策 | 依据 / 关系 |
|---|---|---|
| 桌面 spinner | 沿用现有代码：Tailwind `animate-spin`（1s linear infinite），挂 HTML wrapper 元素、compositor-only | 遵守 `AGENTS.md` 规则 7；图标动效挂外层 wrapper（`<span className="animate-spin inline-flex"><Loader/></span>`），SVG 静止 |
| 移动 loading | 沿用 `ActivityIndicator` 原生默认 | 不引入自定义 spinner 资源 / 时长 / easing |
| 桌面窗口阴影 | 沿用 OS / Electron `BrowserWindow` 系统默认，不自定义 | 覆盖 `figma-component-spec.md` §1.4 末行 + §8 #2 的缺口标注 |

**与 figma 缺口标注的关系**：`figma-component-spec.md` §1.4 末行原标注「桌面窗口阴影 MCP 未暴露 explicit shadow x/y/blur/spread，不从截图目测，需设计补 effect 参数」；§8 #2 同列此为缺口并建议「实现先不加或请设计提供 effect 参数」。D-a `〔lead 决策〕` 把该缺口**关闭为「不自定义、沿用系统默认」**——不再等设计补 effect 参数，实现端不为窗口阴影写任何自定义 CSS / Electron shadow 参数。

**loading 动效缺口的关系**：`figma-component-spec.md` §8 #6 标注「所有文本行高仅返回 `normal`、字间距不暴露；loading 图标为静态 asset，无动画时长 / easing 标注」。D-a 决策为「沿用现有代码参数」——即用 Tailwind `animate-spin` 默认值（1s linear infinite）与 `ActivityIndicator` 原生默认作为实现值，不为 loading 重新标注时长 / easing。此决策关闭 §8 #6 的 loading 动效子项。

### 3.1 开机 Splash → 登录 衔接动画（用户拍板 2026-07-19 · demo 已实现验收）

`〔用户拍板〕` D-a「不自定义新动效参数」只约束 spinner / 窗口阴影；**开机 Splash 到登录页的衔接动画是用户逐帧调校拍板的专门动效**，参数以下表为准（demo `splashHandoff()` 为参考实现，双端全设备生效）：

**竖排设备（桌面 / 手机 / iPad 竖屏）**：

| 步骤 | 时点 | 参数 |
|---|---|---|
| 1. loading 淡出 | t=0 | spinner opacity→0，200ms ease |
| 2. 缓冲 | t=0 起 | 立绘 + 字标停留 0.3s |
| 3. 位移 | t=300ms | 立绘 + 字标从 Splash 居中位移动到登录位，650ms `cubic-bezier(.33,0,.18,1)` |
| 4. 面板入场 | t=300+650ms（就位即刻） | 登录面板 opacity 0→1 + 自下而上 20px 上滑，420ms `cubic-bezier(.35,.1,.25,1)` |
| 5. Slogan 入场 | 面板开始后 +100ms | Slogan opacity 0→1，500ms `cubic-bezier(.55,.06,.38,.96)`；**Slogan 必须最后出现** |

**横屏设备（iPad 横屏，设计帧 `358:833` 1180×820）**：`〔设计稿实测〕` 立绘 / 字标 Splash 期即在登录位**静止不动，无位移阶段**；loading 图标 48×48 @(853,479)（`368:908`）。loading 完成后直接执行步骤 4 / 5（面板、Slogan 速率与竖排一致）。

**Splash 期 loading 图标位置**（`〔设计稿实测〕`）：桌面 64×64 @(878,1521)（`366:883`，帧 `366:845`）；横屏见上；手机 / iPad 竖屏按对应设计帧同名 `loading_icon` 节点取位。

**播放时机**（`〔用户拍板〕`）：冷启动每次播放；设备 / 尺寸切换**不重播**。

---

## 4. 布局延展（D-d）

`〔lead 决策〕` 横屏 / iPad / 平板 / 分屏的版式延展。本节只给**版式决策**，缩放公式本体一律指向 `adaptation-spec.md`，不复制。

### 4.1 横屏

`〔lead 决策·重写 2026-07-19〕` **iPad 横屏有专门设计帧**「Log in_iPad_1133×744」，为**左右构图**（立绘居左，右列 = `CINDY.` 字标 + 输入面板 + 第三方圆钮行）。原「横屏维持竖排居中限宽、不做左右分栏」表述**作废**。

- 精确几何与断点插值规则**由 lead 细化中**，落点 `adaptation-spec.md` 横屏节（待追加）。
- 宽 < 700pt 的分屏 / Stage Manager 窄窗**回退手机竖排规则不变**（见 §4.4 指向 `adaptation-spec.md` §3.3）。
- `〔文档诚实标注〕` 此横屏帧尚未在 `figma-component-spec.md` §0.2 读取记录登记实测参数；wave3 / lead 细化落地前，实现端不擅自推导左右构图的几何坐标。

### 4.2 iPad / 平板

`〔lead 决策〕`：

- **iPad 竖屏已有设计帧**（iPad mini 8.3）。`〔文档诚实标注〕` 此帧**尚未在 `figma-component-spec.md` §0.2 读取记录内登记实测参数**（§0.2 移动端读取记录只覆盖国区/国际区 750×1624 与 750×1334，未含 iPad 帧）。本轮按 lead 提供事实记录其存在；后续若需 iPad 竖屏帧像素级参数，须单独补 Figma MCP 读取并回写 `figma-component-spec.md`。
- **iPad 竖屏全屏**（宽 ≥ 700pt）= 手机版式居中限宽 + 立绘按缩放规则。即用手机舞台居中、红底铺满全屏〔已作废(wave4)：「红底铺满全屏」改为白底体系背景铺满,见 §8.2;版式规则（手机舞台居中、白面板不拉宽）沿用〕，不把白面板拉宽到平板全宽。
- **iPad 横屏**走 §4.1 专门左右构图帧（`Log in_iPad_1133×744`），不套手机竖排。
- **分屏 / Stage Manager 窄窗**（宽 < 700pt）= 回退手机竖排弹性规则（见 §4.4 指向的 `adaptation-spec.md` §3.3 两档外分辨率策略）。

### 4.3 设备档位参考

`〔lead 决策·非 figma 实测〕` 以下设备档位尺寸由 lead 提供，作为 §4.1 / §4.2 验收时的机型档位参考（**不是 Figma 设计参数**，实现时不把这些数字当设计坐标）：

| 档位 | 尺寸（pt） | 备注 |
|---|---|---|
| iPad mini（8.3） | 744 × 1133（竖）/ 1133 × 744（横） | 竖屏已有设计帧；横屏有专门左右构图帧 `Log in_iPad_1133×744`（参数 lead 细化中） |
| iPad 标准 | 820 × 1180 | |
| iPad Pro 11 | 834 × 1210 | |
| iPad Pro 13 | 1032 × 1376 | |
| Split View 最窄 | 320（宽） | 回退手机稿弹性规则 |

横屏尺寸 = 竖屏宽高互换（如 mini 横屏 1133×744）。

### 4.4 缩放公式指向（不复制本体）

布局缩放 / 插值的公式本体一律查 `adaptation-spec.md`，本文只指向章节：

- `〔指向〕` 桌面 stage 缩放：`adaptation-spec.md` §1.1 第 5 条 `fitScale` 公式 + §1.1 第 6 条 `minScale = 0.36` 推导 + §1.1 第 7 条红底外溢裁切规则。iPad 全屏「立绘按缩放规则」即走此公式。〔已作废：§1.1 条 5/6 的 fitScale/`minScale=0.36` 已被 demo v3.1 拍板缩放公式取代（`implementation-plan.md` 权威链收口项）;条 7 红底外溢裁切规则随 wave4 作废（§8.2,白底体系背景代码渐变铺满、无裁切）〕
- `〔指向〕` 移动两档线性插值：`adaptation-spec.md` §3.2 第 2 条 `t = (designHeight - 1334) / (1624 - 1334)` 与 §3.2 第 3 条视觉区插值规则。分屏窄窗回退走 §3.3「1334 以下」弹性分支。
- `〔指向〕` 回调页缩放：`adaptation-spec.md` §4 第 5 条 `scale = min(1, (viewportWidth - safe - 32)/680, (viewportHeight - topOffset - safe - 24)/680)`。
- `〔指向〕` 红底铺底、五要素绝对定位、状态切换不重排：`adaptation-spec.md` §1.1 第 7/8 条、§2 第 1-5 条。〔wave4 改判：「红底铺底」已作废,背景=白底体系铺满（§8）;五要素绝对定位、状态切换不重排规则沿用〕

### 4.5 键盘态（用户拍板 2026-07-19 · demo 已实现验收）

`〔用户拍板〕` 移动端键盘弹起规则（覆盖原「待拍板」状态，demo 键盘模拟已按此实现并验收）：

1. **整体组合上顶**：输入框聚焦时，立绘 + Slogan + 字标 + 登录面板**作为整体**向屏幕上方平移，露出完整输入框；顶部溢出的立绘 / Slogan 允许被屏幕上缘裁切（即回答了原 `adaptation-spec.md` §3.5 第 4 条——允许）。
2. **面板紧贴键盘**：登录面板底缘与虚拟键盘顶缘间距固定 **10px**，全设备（iPhone / Android / iPad / Android pad）一致。
3. **键盘形态按平台**：iPhone 用 iOS 默认键盘、iPad 尺寸用 iPadOS 标准键盘、Android 设备（含 pad）用 Gboard；数字输入（验证码 / 手机号）唤起数字键盘。
4. 键盘收起后组合回到原位，过程不产生跳变（规范 7）。

此拍板关闭 `adaptation-spec.md` §3.5 的 4 条「建议·待拍板」与 `landing-plan.md` §6 #22 键盘态子项（两文档待回写时同步标注指向本节）。

---

## 5. WeChat 登录入口（D-c）

`〔lead 决策〕`：

1. **国区 WeChat 审核未通过，上线前入口不显示**。审核通过前不渲染 WeChat 圆钮。
2. **获批后沿用 Figma「LOG IN_手机登录_默认」帧的第三方圆钮行排版**——Apple / WeChat 绿钮 / SSO 三钮同排、同尺寸（80×80）、同间距（gap=70），**不需要新设计帧**。即 WeChat 加入时复用国区移动默认帧已有的第三方圆钮行容器坐标，不另开布局。
3. **入口显隐由服务端 provider 配置驱动**（现有 `/api/auth/providers` 机制）——客户端按服务端下发的 `ProviderConfig.social` 是否含 `wechat` 决定渲染，不做客户端硬编码开关。

**与 figma 实测的关系**：

- `〔设计稿实测〕` `figma-component-spec.md` §4.5 第三方圆钮表：WeChat 圆钮 `247:1721`、icon `247:1724`（48×48），备注「组件库存在；当前登录页面未使用」；§8 #5 同列此为「若实现时直接暴露所有组件库变体，会多出微信入口」的缺口。D-c 决策关闭该缺口的「展示策略」子项：WeChat 圆钮不是「组件库多出来的废变体」，而是「服务端配置驱动的条件入口」。
- `〔设计稿实测〕` §4.5 组合位置表：国区圆钮行 `347:1284` / `347:2646` / `347:2684`（容器 230×80，Apple x=0、SSO x=150，gap=70）；国际区 `347:1493` / `347:2879` / `347:2906`（容器 380×80，Apple x=0、Google x=150、SSO x=300，gap=70）。WeChat 加入国区时沿用同尺寸同间距。
- `〔延展·lead 判断〕` WeChat 绿钮的 hover / pressed 态照抄主按钮参数（见 §2.2 第三方圆钮行）——绿钮同样只叠遮罩、不改图标色。

**与 landing-plan §6 #28 的关系**：D-c 关闭了 `landing-plan.md` §6 #28「移动 provider 排列 / WeChat 展示策略 / 无稿 RN 状态」三子项中的 **#28-② WeChat 展示策略**子项；#28-①（provider 排列动态 vs 固定）、#28-③（无稿 RN 状态处置）仍待拍板，不在本轮关闭。

---

## 6. 文档地位声明

1. **本文件是延展决策权威**：交互态延展规则（§2）、动画与阴影（§3，含 §3.1 开机衔接动画）、横屏/平板布局延展（§4，含 §4.5 键盘态）、WeChat 入口（§5）、demo 阶段拍板（§7）这些**设计稿未定义、由 lead 归纳 / 用户拍板**的决策，以本文件为权威记录。交互与视觉的最终验收基准是 demo `docs/cindy-login-hifi.html`（见文首声明;**视觉五维已被 §8 wave4 覆盖,见文首例外条款**）。
2. **设计稿实测参数权威仍是 `figma-component-spec.md`**：所有 `〔设计稿实测〕` 参数的最终来源是 `figma-component-spec.md`（及其 §0.2 读取记录背书）。本文件引用时只摘必要参数 + nodeId，不重抄全表；实现端取值一律回查 `figma-component-spec.md`。
3. **冲突时以设计稿实测为准**：若本文件延展规则与 `figma-component-spec.md` 实测参数冲突，以 `figma-component-spec.md` 实测为准；本文件延展规则仅在 `figma-component-spec.md` §8 已标注为「缺口 / 未定义」的点位上生效。若设计后续为本文件延展覆盖的缺口补了实测节点（如 `Text_link` hover / pressed、第三方圆钮 hover / pressed、iPad 帧），以新补实测为准，本文件对应延展条目同步作废。
4. **与 `adaptation-spec.md` 的关系**：`adaptation-spec.md` 是适配模型 + 缺口汇总权威（含桌面 stage / 移动两档 / 回调页缩放公式、§7 26 项缺口清单）。本文件是「`adaptation-spec.md` §7 / `figma-component-spec.md` §8 列出的缺口，哪些已被本轮 lead 决策拍板、拍成什么」的延展决策层。D-a（§3）把 `figma-component-spec.md` §8 #2 窗口阴影 + #6 loading 动效从「缺口」关闭为「沿用系统默认 / 现有代码」；D-d（§4）中 iPad 平板/分屏子项已拍板，但**横屏子项改为「已有稿·细化中」**（用户补 `Log in_iPad_1133×744` 左右构图帧，参数 lead 细化、落点 `adaptation-spec.md` 横屏节），未关闭。
5. **与 `landing-plan.md` 的关系**：`landing-plan.md` §6 待拍板清单中已被本文件覆盖的编号（#3 hover、#4 pressed、#5 阴影、#6 loading 动画、#10 / #28-② WeChat、#21 平板+分屏）标记为「已拍板」并指向本文件对应章节；**#21 横屏子项改为「已有稿·细化中」**（用户补 `Log in_iPad_1133×744` 左右构图帧，参数 lead 细化、落点 `adaptation-spec.md` 横屏节），不作为已拍板关闭；未覆盖的子项（#18/#19/#20 两档间插值与 1334 以下 / 1624 以上、#22 键盘态、#28-①/#28-③ 等）保持待拍板，不在本轮关闭。
6. **诚实标注义务**：本文件凡引用了「lead 提供但未在 `figma-component-spec.md` 登记实测」的事实（如 iPad mini 8.3 竖屏帧、§4.3 设备档位尺寸），均显式标注「非 figma 实测」，后续若取得实测参数须回写 `figma-component-spec.md` 并同步本文件。

---

## 7. Demo 阶段拍板决策（2026-07-19 ~ 2026-07-20 · 全部已在 demo 实现并验收）

demo `docs/cindy-login-hifi.html` 打磨期间用户逐条拍板的决策，按主题归档。**这些决策与 §1~§5 同级权威**；落地实现时逐条对照，不得回退。

### 7.1 覆盖范围（状态补齐口径）

`〔用户拍板〕` 新皮肤只覆盖满足「**登录链路 ∩ 现网源码存在**」的界面与状态（现网盘点权威：`login-ui-inventory-f8760bed.md`，基线 `main@f8760bed`）：

- **不出**：provider / ghost / generic OAuth 授权页壳（非登录链）、登录成功后过渡帧（LocalDbGate 底色帧、主界面加载）、现网不存在的界面（LocalDbGate 品牌屏、归因展示）。
- **出且已验收**：桌面 8 态 + preparing 伪态全量、19 个桌面错误码 error_text、桌面全屏 error 态、浏览器登录回调（成功 / 失败 / 中性 × 深浅色）、LegacyMigrationDialog 三相、桌面 Splash 失败三弹窗、移动全链（启动闸门 / config-missing / 无 loginState 兜底 / 15+fallback 错误码 / 原生社交 / SSO 浏览器跳转）。
- ~~现网 Splash 的 tips 轮播 / 下载进度在新稿无位置：按稿不出，留待讨论~~ → `〔用户拍板 2026-07-20（Lizi）〕` **保留 Splash 更新链全部可见状态**：现网 `useSplash` 14 相中用户可见的 6 个 tips/进度态（checking_update 检查更新中 / updating 更新下载 / update_done 等待自动重启 / checking 环境检测 / downloading 组件下载(x/2) / failed 初始化失败可点重试）按新设计呈现——tips 文案（现网 `splash.tips.*` 四语言 verbatim）置于 loading 图标下方居中、白 80%；下载态加进度条（延展参数：现网 192×4 → 设计尺度 300×6 r3，白 25% 轨 + 白填充）+ 速度/体积统计行（`38% · 3.2 MB/s · 24.8 MB / 65.3 MB` 形态）；failed 态白字加粗下划线可点重试、loading 图标隐藏〔呈现样式已被 §8.1 wave4 统一面板化取代（白面板/进度条 501×16/failed 态主按钮「重试」）;本条的状态覆盖拍板（6 可见态保留）沿用〕。**桌面专属**（xdt-updater 与组件下载不存在于手机端，移动 Splash 保持纯品牌屏）。demo 已实现（Splash 阶段选择器 + 状态补齐 6 格）。遗留项清零。

### 7.2 文案

`〔用户拍板〕` **全部文案 = 现网 i18n verbatim，不新写不改写**：

> `〔用户拍板 2026-07-20（修订）〕` **语言口径升级为 5 语：zh-CN / zh-TW / ja / ko / en，双端一致**（「简/繁/日/韩/英 5 语言适配」）。覆盖本节下方旧口径（桌面 4 语、移动 zh/en + ja/ko 回退英文）。
> `〔U-1 终裁 2026-07-20,PR0b-desktop 落码回写〕` zh-TW **按现网 locale 同标准全量接入**,取代本块早前「登录域全量翻译、非登录域 fallback zh-CN」的旧表述：zh-TW 进 `SUPPORTED_LOCALES`,`locales/zh-TW/common.json` **全量 key 翻译**（与 ja/ko 同标准；登录域 login.*/splash.*/legacyMigration.* 人工精校 = PR0b merge gate,非登录域同标准翻译 + 抽检记录）;全部 SUPPORTED_LOCALES 消费者补 zh-TW 真实分支（不折叠简中,清单见 `locale-consumer-inventory.md`）;fallback 链仅作防漏兜底（renderer `{'zh-TW':['zh-CN','en']}` / main `zh-TW→zh-CN→en→key`）,不是覆盖策略;`resolveSystemLocale` zh-Hant/zh-HK/zh-MO→zh-TW、其余 zh→zh-CN;不引入 OpenCC。移动 `loginMessages.ts` catalog 扩 5 语（归 PR0b-mobile）。机器门 = `scripts/check-login-i18n-parity.mjs`（SC-4）。下段 4 语表述保留为历史记录。

- 桌面 4 语言（zh-CN / en / ja / ko）取 `common.json` `login.*` / `splash.*` / `legacyMigration.*`；移动现网仅 zh / en（`loginMessages.ts`），**ja / ko 一律回退英文**，不显示缺失占位。
- 桌面 / 移动措辞差异必须保留（如 binding 完成按钮桌面「完成登录」/ 移动「登录」、loading 桌面「请稍候...」「正在验证...」/ 移动「处理中…」、移动 method-choice 单行「以企业身份登录 · <connectionName>」）——差异全表见 `login-ui-inventory-f8760bed.md` §7。
- 设计稿文字与现网 i18n 冲突时**以现网为准**（例：设计稿「通过邮箱发送验证码」→ 用现网「向邮箱发送验证码」）。

### 7.3 组件级拍板（设计稿实测 + 用户微调）

| 条目 | 决策 | 来源 |
|---|---|---|
| loading 按钮 | 文字保持按钮居中；spinner 24×24 绝对定位 (487, 27)，即右缘内侧 29px、垂直居中 | `〔设计稿实测〕` `log_in_button/load` `247:1544` |
| 方式行（method-choice / account-selection / sso-org-list 复用） | 540×100 r60；左 icon 24 box @(27,37)——企业行 enterprise 图标、个人行 person 矢量 18×20 居中；右 share 图标；**标题 / 副标题左对齐（x=67），文字块在行内垂直居中**（单行 / 双行通吃，行距 5px） | `〔设计稿实测〕` `329:956` / `347:1636` + `〔用户拍板 2026-07-20〕` 垂直居中 |
| method-choice 纯个人变体 | 弃用现网单按钮形态，改用双行方式行：「以个人身份登录 / 向邮箱发送验证码」+ person 图标；副标题显示**邮箱**（非手机号） | `〔用户拍板 2026-07-20〕` |
| 验证码重发 | 新增 42s 倒计时（「42 秒后可重新发送」→ 倒数结束变「重新发送验证码」链接）；现网无冷却，此为新设计增强 | `〔用户拍板〕`（拍板项 #32）+ `Text_link` `247:1612/1614` |
| 桌面窗口描边 | 双层描边：外 2px `#7A0B19` + 内 inset 2px `#F26D7E`，r16〔已作废(wave4)：双描边换色为外 2px `#A3A8AD` r18 + 内 inset 2px `#FFFFFF` r16,见 §8.1（`368:1375`/`368:1377`）〕；mac 三色点左上 / Windows ─□✕ 右上 | `〔设计稿实测〕` `358:689/690/691`（旧帧,历史记录） |
| Splash 失败三弹窗（manifest / download / spawn） | 按登录面板规则呈现：680×440 面板、标题副标题居中、pill 主按钮；文案用现网 `splash.*` 四语言 | `〔用户拍板 2026-07-19〕` |
| 第三方入口 | 圆钮行形态（Apple / Google / WeChat / SSO 同排 80×80 圆钮，SSO 为行内最后一颗），替代现网文字按钮 +「或」分隔线 | `〔设计稿实测〕` `247:1710` / `329:243` |

### 7.4 浏览器回调页 / 表情包

`〔用户拍板〕`：

1. 回调卡片浮于**设计页面底色**上：浅色 `#EEEEEE` / 深色 `#2A2828`，圆角卡片（r36）居中，不再用现网灰底页壳配色。
2. **Cindy 表情包（chibi 立绘）只出现在浏览器相关页面**；唯一例外是 LegacyMigrationDialog（迁移未完成弹窗，用回调卡形式 + 表情包）。App 内登录界面一律不放表情包。
3. 回调三变体：成功 / 失败 / 中性（「需要继续操作」），文案见 demo `CALLBACK` 目录（登录回调沿现网 `login.browserCallback.*` 措辞骨架）。

### 7.5 区域与平台

- 区域系统（cn / global）完整呈现：Global 时标题旁 pill 徽标（桌面「Global」/ 移动「国际」）、归因决定默认输入类型（cn=手机号 / global=邮箱）、社交矩阵 cn={Apple(+WeChat 获批后)} / global={Apple, Google}、SSO 入口恒显——与现网 server 驱动模型一致（`login-ui-inventory-f8760bed.md` §1.5）。
- 移动键盘规则见 §4.5；开机衔接动画见 §3.1（横屏无位移变体按 `358:833`）。

### 7.6 demo 工具层说明（不属于产品规格)

demo 的设备切换器、错误模拟下拉、sim 日志、键盘模拟器、状态补齐 tab 本身是**验收工具**，不是产品需求；落地实现只取其呈现的界面 / 状态 / 文案 / 动画结果。分享给他人用自包含版 `cindy-login-hifi-standalone.html`（资源已内联，单文件可开）。

---

## 8. 白底体系拍板（wave4 · 2026-07-20 · 覆盖性变更）

`〔用户拍板 2026-07-20〕` **登录流程全部界面（客户端/手机/pad,苹果+安卓全设备）从品牌红全屏底改为白底体系**;设计稿已更新 6 个新帧（`368:1375` 登录默认 + `379:581/525/607/633/655` Splash 五态,均 1819×2098）。本节为覆盖性权威:**与 §1.1「品牌红全屏底」、§7.1 Splash 红底呈现相冲突的旧表述自本节起作废**;未被本节触及的部分（布局坐标、组件几何、交互态、动画时序、文案、区域系统）继续沿用原拍板。

### 8.1 变更四项 + Splash 统一面板（参数均为 wave4 Figma 实读,带 nodeId）

1. **背景体系**（帧 fill + 两层渐变,代码复现、非图片资产）:
   - 底色 `#F1F0F1`（帧 fill）——**用户拍板 2026-07-22:登录页底色固定 `#EDEDED`（light/dark 同值,与编辑器主题解耦,token-decision-table §5.2「登录不随主题」）**,取代 2026-07-20「落码改判为消费不透明 `var(--surface)` token」——该改判系主题耦合源:cindy-dark 下 `--surface`=#2A2828,登录页背景变深且与 SLOGAN #2A2828 同色隐形、面板取 dark 值变深灰(2026-07-22 沙盒手测 MT-1/2/5)。`#EDEDED` 即原改判所引 PR #104 白底机制在 cindy-light 下的实际渲染值;该实现的「加载期完全遮蔽主界面」「最短停留 3s 地板」「热更重启守地板」仍为不得回退行为。**v2 品牌块(其立绘/字标/手写体)不作基准,立绘/字标/slogan/登录全部 UI 仍以本 §8 wave4 帧与 demo 分层基准为准,用户裁定 2026-07-20**;
   - 红径向渐变层（`379:518`）: `#F70121` α1→α0@0.747,中心在帧右上角外侧（≈x128%, y7%）,图层 opacity 6%;
   - 红线性渐变层（`379:520`）: `#F70121` α0→α1,向左下角变红（(86.5%,85.8%)→(0%,100.7%)）,图层 opacity 5%;
   - 「红色渐变样式需要继承」= 上述两层为必现元素,双端全设备一致。
   - **窗口双描边换色**: 外 `#A3A8AD` 2px（帧描边,r18）+ 内 `#FFFFFF` 2px INSIDE（`368:1377`,r16）——取代旧 `#7A0B19`/`#F26D7E`（旧值已作废）;窗口阴影仍沿系统默认（D-a 不变）。
2. **字标**: 换黑红版（黑字 CINDY + 红三角 i 点 + 红下划线块）,位图 `368:1381` 423×145 @WORD_MARK 容器内 (128,17)（容器 680×180 @570,1029,内层绝对 ≈698,1046）,**透明底**——wave3.5 的字标红底告警对新资产不再适用。
3. **SLOGAN**: 矢量 `368:1394` 453.2×129.1,fill `#2A2828` + 0.5px stroke 同色（白→近黑）;几何沿旧。
4. **UI 面板描边**: 登录流程全部面板加 `#D4D4D4` 1px INSIDE 描边（`368:1383`,面板 680×440 r36 fill #FBFBFB 不变）。**面板内组件几何零变化**（input 540×80@70,158、主按钮@70,300、圆钮行 80×80 gap70、立绘 934×934@443,275 均与旧版一致;主按钮/圆钮配色 #2A2828/#434343 不变）。
5. **Splash 统一面板化**（取代 §7.1 的红底 tips/300×6 进度条呈现）: 五态共用登录同款白面板,元素:spinner 64×64 @面板内(308,188),内弧 `#6F6F6F`;进度条（仅更新下载态）轨 501×16 r12 `#D9D9D9` @(90,346) + 填充 `#252222`;明细行 `38%·3.2MB/s·24.8MB/65.3MB` 20px Regular `#6F6F6F`;失败态 = 面板标题「环境初始化失败」+ 主按钮样式「重试」（540×80 @70,300,取代白字下划线交互）。标题 32 Bold `#252222`、副文案 20 Regular `#6F6F6F`（与登录面板同版式）。
   - 帧↔状态: `379:581` 检查更新中... / `379:525` CINDY 更新中...(进度) / `379:607` 更新完成,等待自动重启... / `379:633` 运行环境检测中... / `379:655` 环境初始化失败(重试)。
   - `〔延展·lead 判断〕` **downloading（组件下载 x/2）无专属新帧**: 复用 `379:525` 更新下载态的面板形态（spinner+进度条+明细）,文案用现网 `splash.tips` 对应条目;设计后续补帧则以补帧为准。

### 8.2 延展与边界

- `〔延展·lead 判断〕` **移动/iPad 无白底版专属新帧**: 手机/平板帧（132:2741 等）设计稿未随本轮更新,但用户拍板全端白底——移动/iPad 按「桌面 wave4 背景/字标/slogan/描边参数 + 各自旧帧布局几何」合成落地;设计补帧后以补帧为准。
- **回调页不在本轮变更范围**: 用户列举变更为登录/Splash 界面四项;回调页深浅双色卡设计稿（343:355 族）未更新,维持 §7.4 拍板。若需同步白底体系另行拍板。
- **Splash→登录衔接动画**: §3.1 时序参数不变;「红底铺满/外溢裁切」（已作废）语义替换为「白底体系背景铺满」(背景为代码渐变,天然全屏,无裁切问题;Slogan 窄窗左移防裁切规则保留)。
- **demo 基准分层**（重要）: `docs/cindy-login-hifi.html` 冻结于红底体系,**在背景/字标/slogan/面板描边/Splash 呈现五个维度已过期**——该五维度验收基准 = wave4 新帧（截图对照 368:1375/379:5xx）;其余维度（布局坐标、状态覆盖、交互、动画时序、文案、语言）仍以 demo 为准。demo 重制并重新验收后恢复单一基准。

## 9. identifier 形态分区互斥拍板(2026-07-21 · 覆盖性变更)

用户拍板(2026-07-21,原话要点「手机和邮箱登录不会同时存在 是分区的」「查清楚 cindy 的两种启动方式,这个多加的 tab 问题 所有端你直接修复」):

1. **手机号与邮箱登录按构建区域分区互斥**——cn 启动(com.xd.cindycn)=手机号登录,global 启动(com.xd.cindy)=邮箱登录;identifier 形态由构建期区域(desktop `VITE_CINDY_AUTH_REGION` / mobile `EXPO_PUBLIC_CINDY_AUTH_REGION`,dev 回落 cn)**确定性推导**,不再依赖服务端 providers 组合渲染。
2. **手机/邮箱双 tab 切换 UI 全端移除**(desktop `LoginIdTabs` + mobile `LoginIdTabs`,几何参数 @(70,112) 540×34 r18 随之退役)。服务端即使误下发 email+phone 双方式,也只呈现区域首选的单形态;providers 仅作缺失兜底(区域首选方式未下发时落到另一侧的单形态)。
3. **demo 中的 tab 呈现自本拍板起作废**(demo 早于本拍板冻结;fidelity 验收对 identifier 行按本拍板口径判定,不以 demo tab 帧为基准;demo 重制时同步移除)。
4. 落码:`apps/desktop/src/shared/loginIdentifierMethod.ts` 与 `apps/mobile/src/auth/loginIdentifierMethod.ts`(同语义纯函数,双端各带单测)。

## 10. 第三方登录圆钮状态精简拍板(2026-07-21 · 覆盖性变更)

用户拍板(2026-07-21,原话「所有第三方登录的圆形入口的组件状态样式参考大按钮的状态样式,hover\pressed,不需要 disable 和 loading 状态」):

1. **第三方圆钮(Apple / Google / WeChat / SSO)只保留 normal + hover(仅桌面)+ pressed(双端)三态**;hover/pressed 规格照抄主按钮 `log_in_button`(白 8% / 黑 50% rgba 叠层,§2.2 hover/pressed 两行沿用,参数不变;该叠层为 figma §2.1 实测 rgba 字面参数,与主按钮同款,非主题色——token-decision-table §3,不新增 token)。
2. **圆钮 disabled 与 loading 态移除**——覆盖 §2.2 表 2026-07-19 拍板的 loading/disabled 两行(本表行 80/81,已标注作废);落码侧圆钮从不曾实现 loading(无 prop),disabled 渲染路径(round button)本轮删除。
3. **与 figma-component-spec §4.5 一致**:§4.5 圆钮状态表本就只列 normal/hover/pressed(hover/pressed 标注「未提供圆钮 hover/pressed node,同变体或后续补稿」),无 disabled/loading 行;本拍板把 §2.2 延展规则收敛回 figma spec 口径,不与任何 figma 实测冲突,无需改 `figma-component-spec.md`。
4. **demo 基准**:demo 圆钮不呈现 disabled/loading 态,本拍板与 demo 一致;fidelity 验收对圆钮按本拍板口径(三态)判定,不以 demo 任何 disabled/loading 圆钮帧为基准(demo 无此帧)。
5. 落码:`apps/desktop/src/renderer/components/login/LoginControls.tsx`(`LoginSocialButton` 移除 `disabled` prop / disabled className 分支 / border 三元,hover/pressed 叠层保留照抄主按钮)、`apps/mobile/src/components/LoginSkinControls.tsx`(同款移除 `disabled` prop / `StateOverlay` `disabled` 分支 / border 三元 / `accessibilityState` disabled)、调用方 `apps/desktop/src/renderer/components/login/LoginPage.tsx` 与 `apps/mobile/app/(auth)/login.tsx` 移除 `disabled=` 绑定。主按钮 `log_in_button` 五态(normal/hover/pressed/loading/disabled)及其它组件(input / method-row / back 的 disabled)不受影响;`--login-disabled-button-overlay` / `--login-control-border-disabled` token 仍被主按钮等组件消费,无孤儿 token。
