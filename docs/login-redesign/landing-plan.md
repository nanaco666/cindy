# Cindy 登录流程 UI 替换落地方案（final v2 · 基线重盘后三方共识版）

> 状态：**final**。v3 修订稿经第二轮三方复审（3× codex gpt-5.5 xhigh）确认：三份 recheck 报告 92 条出入点全部吸收、无过期结论残留、rev3-c 提出的 2 个 P1（DAG 批次④矛盾、escape 回归单测缺失）修复后三路一致确认共识（2026-07-19）。此前 final（三方共识版）建立在过期代码基线（worktree main-login-audit @6d5033d4 + 旧根工作树）之上；经三路重盘（`recheck/desktop.md`、`recheck/mobile.md`、`recheck/callback.md`，代码基线 **`origin/main@643c3dc`**，2026-07-19 14:40）共发现 92 条出入点，本版全部吸收。设计稿侧结论（双盲验收 + 仲裁）不受影响，变的是「现状」与「怎么替换」。
>
> **基线重盘后的三个核心事实**：① 桌面已是 auth-server login v2（旧飞书登录页/迁移进度页/飞书 OAuth 窗口已消失）；② 移动端已有完整 auth-server RN 状态机（手机号/邮箱/验证码/Apple/Google/WeChat/企业 SSO/账号选择/绑定），旧「仅飞书单按钮」结论作废；③ 回调页壳已共享化并覆盖 login/Ghost/Claude/xAI/generic 全部 provider，但视觉仍是 400px 小卡、运行时只有 `variant` 三值，无 pageKind 模型。
>
> 忠实原则不变：设计稿已定义的照抄（`acceptance-report.md` 背书）；未定义的为「候选默认值·未批不落码」；批准记录回写 §6。

## 0. 权威材料索引

| 文档 | 角色 |
|---|---|
| `recheck/desktop.md` / `recheck/mobile.md` / `recheck/callback.md` | **现状代码事实权威（main@643c3dc）**；与旧审计冲突时以 recheck 为准 |
| `acceptance-report.md` | 设计稿参数可信度背书 + 仲裁结论 |
| `figma-component-spec.md` / `DESIGN-login.md` / `token-decision-table.md` / `adaptation-spec.md` / `callback-pages-classification.md` | 设计参数/适配/三分类权威（其中涉及「现状」的段落以 recheck 修正为准） |
| `current-adaptation-audit-desktop.md` / `-mobile.md` | 历史审计（基线过期，仅存档；不再作为代码地图） |

## 1. 范围核销表（基线 main@643c3dc）

处置枚举：`替换@PRn`（有 figma 帧，像素验收）/ `皮肤适配@PRn`（无专属帧，套新体系组件，功能验收）/ `保留`／`外部`／`历史`（已消失，无需处理）／`拍板`（见 §6）。

### 1.1 桌面（对旧 24 项的重盘后修订版）

| # | Surface（现状名） | 处置 | 说明 |
|---|---|---|---|
| 1 | 主窗口/副窗口 chrome（1280×800 默认，min 800×600，mac hidden titlebar / 非 mac frameless） | 替换@PR2 | min 尺寸调整依 #13/#14/#16 |
| 2 | ~~旧飞书登录页~~ | **历史** | 已消失；PR5 退役项取消 |
| 3 | ~~迁移进度页 / 失败跳过弹窗~~ → `LegacyMigrationDialog`（confirm/running/failed，ConfirmDialog 承载，**仅 cn 构建触发**） | 拍板 #29 | 无设计稿；候选默认=保留现状交互、仅换 token；验收矩阵须区分 cn/global |
| 4 | login v2 卡片外壳（440px 居中卡） | 替换@PR1 | → 1819×2098 stage |
| 5 | v2 准备/未拿到态（现状无 loading 图标） | 替换@PR2 | 帧 347:1406/1948；需补 64×64 panel loading |
| 6 | v2 身份输入态（手机/邮箱 tabs 由 ProviderConfig 动态、社交按钮动态渲染） | 替换@PR1 | 与设计稿固定集合的对齐见 #33 |
| 7 | v2 企业 SSO 组织输入态（identifier 内 ssoOrgMode 子视图） | 拍板 #29 | 无设计稿帧 |
| 8 | v2 方式选择态（可多 SSO connection；无邮箱上下文变体存在） | 替换@PR2 + 拍板 #29 | 帧 347:1620 只画了单企业+个人两行；多 connection/无邮箱 subtitle 为无稿变体 |
| 9 | v2 验证码态（现状**无倒计时**，只有重发按钮） | 替换@PR2 + 拍板 #32 | 设计稿有倒计时/重发两态，代码缺倒计时状态机 |
| 10 | v2 账号选择态 | 拍板 #29 | 无设计稿帧 |
| 11 | v2 绑定态（contact+code 两子态） | 拍板 #29 | 无设计稿帧 |
| 12 | v2 浏览器授权等待态（24px spinner，renderer 先行投影） | 替换@PR2 | 帧 347:1363/1906（64×64 loading @308,158） |
| 13 | v2 错误态 / 完成态（completed 渲染 null 直接跳走） | 错误替换@PR2；完成态拍板 #29 | 设计稿无完成态帧 |
| 14 | 路由门控（GuestRoute/ProtectedRoute/LocalDbGate null gate；MigrationGate 已消失） | 拍板 #29 | 候选默认=红底空场景过渡防空白帧 |
| 15 | ~~飞书 OAuth BrowserWindow~~ | **历史** | 首登 social/SSO 已全走系统浏览器 loopback（5 分钟超时） |
| 16 | 共享 OAuth result 页壳（400px 小卡；已覆盖 login/Ghost/Claude/xAI/generic 全部调用点） | 替换@PR3 | 替换对象=这一个共享壳；Ghost 旧壳已消失，无独立替换项 |
| 17 | Providers 设置区授权行 / 自定义供应商弹窗 / **XD Gateway 自动凭据行**（手填 Key 弹窗已消失）/ Slack Hook·Computer Use 入口 / 内置 Ghost 设置页（现清单：xd-feishu、GitHub、GitLab、Google、Atlassian、Mivo、Pages；cindy-slack 已退役） | 保留（后续 issue） | 设计稿边界=登录流程+回调页；清单以 recheck/desktop.md N1~N4 为准 |
| 18 | 桌面「归因」信息展示（现状**不存在**——只有 global 构建的 Global pill；移动端有「国内版·手机号归因」文案） | 拍板 #33 | 若设计要求桌面也展示归因，属新增文案+设计 |

### 1.2 移动（重写版——基于完整 auth-server RN 状态机）

| # | Surface（现状名） | 处置 | 说明 |
|---|---|---|---|
| 1 | Splash / OTA gate / 冷启动恢复（已用 Cindy splash 位图资产）/ StartupBlockedScreen（端点清单失败重试屏） | 拍板 #29 | 候选默认=复用/校准现有 Cindy splash 到红底体系，非从零 |
| 2 | 登录入口态 identifier（手机/邮箱 segmented tabs、输入、继续、社交按钮、企业 SSO 文本入口；ScrollView+KeyboardAvoidingView 卡片布局） | 替换@PR4 | 帧 132:2741/347:2662/2857/2884；改为 750 坐标红底 stage |
| 3 | 企业 ID 输入（ssoOrgMode） | 拍板 #29 | 无设计稿帧 |
| 4 | 方式选择 method-choice（多 connection label 拼接） | 皮肤适配@PR4 + 拍板 #29 | 桌面帧可参照，移动无专属帧；多 connection 变体无稿 |
| 5 | 验证码态（CodeInput + 登录 + 重发；**无倒计时**） | 替换@PR4 + 拍板 #32 | 同桌面 #9 |
| 6 | 浏览器授权等待 browser-redirect（无 loading 图标） | 替换@PR4 | 需补面板 loading |
| 7 | 账号选择（RN 内界面，**非外部**） | 拍板 #29 | 旧审计「外部承载」结论作废 |
| 8 | 绑定（手机/邮箱绑定+验证码，RN 内） | 拍板 #29 | 旧审计漏项 |
| 9 | 错误展示（卡片内联 error block，用通用 errorText token） | 替换@PR4 | 切到登录专属 `#D91F37` error_text 视觉 |
| 10 | 配置缺失反馈（auth base URL 校验）+ 启动端点阻断屏（两个不同 surface） | 皮肤适配@PR4 | 旧「缺 FEISHU_APP_ID」触发条件作废 |
| 11 | deep link 回跳（region 化 scheme：cn=`cindycn://auth`、global=`cindy://auth`，native Linking 链路） | 逻辑保留；resolving 界面皮肤适配@PR4 | 旧 `lizcn://auth`/手动 callback 输入结论作废 |
| 12 | 登出回登录 | 随 #2 | 逻辑不动 |
| 13 | ~~开发调试 sheet / mock 登录~~ | **历史** | 最新 main 无此 surface |
| 14 | 系统浏览器内授权页（SSO/social 的 `openAuthSessionAsync`） | 外部 | 浏览器终态页承载方见 #30 |

**移动 i18n 现状修正**：登录域已有 zh/en 纯数据 catalog（loginMessages.ts，含 14 类错误码映射），非从零——PR0b-mobile 任务改为「zh/en 扩四语 + 清理外围硬编码中文（端点失败屏等）+ 与 desktop key/fallback 对齐」。

## 2. 关键架构决策（不变量 / 候选默认值 / 现状事实 三层）

### D1 桌面布局模型
〔Figma 不变量〕1819×2098 stage 五要素坐标（同前版，acceptance-report §2）。〔现状事实〕替换对象=main 上的 v2 440px 居中卡（非旧双基线混合）；桌面 i18n 四语与 main 侧 t() 已就绪；现有登录 UI 走 `--login-*` app theme token 且**跟随主题**。〔候选默认·未批不落码〕stage+scale 模型、锚点、minScale 0.36、minHeight、scale 封顶、DPI 策略、Windows chrome 平台例外（同前版 #13~#16）。**token 命名警示**：colors.ts 已存在跟随主题的 `--login-*` token（426-462 行），新品牌皮肤 token 须用新前缀（如 `--login-brand-*`）或迁移旧 token，PR0a 定稿，禁止撞名混义。

### D2 token 与常量落点
同前版（22 色 / 25 尺寸 / mobile / callback 四落点，登录皮肤与回调卡作用域分离，依 #23）。新增：需处置现有 `--login-*` token 的去留（见 D1 警示）。

### D3 回调页壳改造
〔Figma 不变量〕三类卡全参数、表情立绘、按钮文案。〔现状事实（recheck/callback.md）〕共享壳已在 main 且覆盖全部 provider；运行时仅 `variant: success|warning|error`——**pageKind→copyKind→visualKind 三层模型是 PR3 要新增的重构，不是现状**；escape 已有，**detail 截断与 generic 裸 `done` 未解决**（仍是 PR3 硬门禁）；`login-error` 浏览器页只在回调请求真实到达时渲染，listener 失败/超时/取消只走 app 内错误（验收矩阵按此拆分）；preview 文案≠生产文案（copy builder 统一后 preview 必须调同一 builder）；生产 source 全集=desktop-login/ghost-oauth/claude-oauth/xai-oauth/generic-oauth。〔候选默认·未批不落码〕#24 anchor、#25 资源交付、#26 detail 展示、#31 CTA 品牌显示（设计稿「回到 CINDY」大写 vs 现产品名「Cindy」——需 brand display token 拍板）。**#11 收窄**：仅 `login-success`/`ghost-success` 有提前渲染语义问题（xAI/generic 在写凭证后成功、Claude 成功走官方页）；低风险方案=改文案「验证已完成」，延后渲染牵涉 authManager/ghost broker 时序。**#12 拆三条**：桌面登录回调跟 app locale / 桌面 provider·Ghost 回调跟 Accept-Language / 移动登录 zh/en——是否统一为 app locale 分别拍板。**PR3 范围限定为桌面 loopback 回调页**；设计稿的「移动 Chrome 回调页」在移动客户端无承载（RN 直接 deep link 回 app），承载方案见 **#30**（auth-server/中转页，可能跨 cindy-server 仓）。

### D4 移动布局模型
〔Figma 不变量〕两档帧全参数、功能区刚性/视觉区弹性、无 hover。〔现状事实（recheck/mobile.md）〕**完整 auth-server RN 状态机已存在**（AuthFlowState 8 态 + select_account/binding outcome），PR4 = 对现有状态机做 UI 皮肤化/复刻，**不存在新建 flow 的分叉**；登录方式=服务端 ProviderConfig 下发 + 客户端原生能力过滤（Apple 仅 iOS、Google 需 client 配置、WeChat 需 appId+universal link）；region 为构建期身份（EXPO_PUBLIC_CINDY_AUTH_REGION，EAS profile 区分 cn/global），mismatch 抛错。〔候选默认·未批不落码〕#18~#22 同前版；键盘态基线=现有 KeyboardAvoidingView 重做而非新增。**#28 重写**（原「皮肤 vs 新建 flow」作废）：移动登录 UI 与 provider 策略确认——①国区/国际区 provider 排列按服务端动态返回还是按设计稿固定集合；②WeChat provider 出现时展示/隐藏/补设计；③account-selection、binding、sso-org 等无稿 RN 状态走 #29 补稿还是批准候选默认。

### D5 资源管线
同前版（manifest 统一、规则 25 边界、PR0b 三域子集）。补充：移动 splash 已有 Cindy 位图资产，manifest 应含「校准 vs 替换」判定；`xdt-feishu-login` 原生模块已移除、`xdt-wechat-login` 存在——资源与配置盘点以 recheck 为准。

## 3. 实施分期（DAG 骨架不变，内容按新基线修订）

```
PR0a（无拍板依赖）────────────┐
批次① ─→ PR0b-desktop ──────┼─→ PR1 ─→ PR2 ─┐
批次② ─→ PR0b-callback ─────┼─→ PR3 ────────┼─→ PR5
批次③ ──→ PR0b-mobile ──────┴─→ PR4 ────────┘
```

批次④（无稿 surface #29）不是 PR4 的开工门槛：其拍板结果分别馈入对应 PR0b 子集的资源/文案项与 PR2/PR4 的「皮肤适配」条目（未拍板项先不做，不阻塞其余开工）。#28/#33 同理：只作为 **PR4 provider 相关验收口径与截图矩阵的前置**，不阻塞 PR4 开工。

- **PR0a**：同前版 + 处置现有 `--login-*` token 命名冲突方案。
- **PR1 桌面 stage 框架**（前置：批次① + PR0b-desktop）：stage 组件 + identifier/输入中/登录中/报错。**必须先建 provider fixtures**（phone-only / email-only / both / social 各组合 / attribution 两值）——登录方式是服务端动态下发，不能只按国区/国际区两个静态假设开发与验收。
- **PR2 桌面剩余状态**（前置：PR1）：验证码（倒计时依 #32）、方式选择（多 connection 变体依 #29）、浏览器三态（补 64×64 loading）、560↔440 锚定、chrome；**无稿状态（sso-org/账号选择/绑定/完成/门控/LegacyMigrationDialog）依 #29 拍板结果做皮肤化**。
- **PR3 回调页**（前置：PR0a + 批次② + PR0b-callback；范围=**桌面 loopback 回调页**）：显式任务列「新增 pageKind/copyKind/visualKind adapter（兼容旧 variant）」「统一 copy builder（preview 调同一 builder）」「消除 generic 裸 done」「detail 截断」「三类卡视觉替换」「**保留并扩展 providerName/detail/href/htmlLang 的 escape 回归单测——pageKind/copy builder/视觉替换不得回退现有 escape**」；回归覆盖 login/Ghost/Claude/xAI/generic 全部调用点。
- **PR4 移动端**（前置：PR0b-mobile + 批次③）：对现有 RN 状态机皮肤化——750 坐标 stage、五要素资源接入、input/按钮/圆钮组件重建（现 44/48px 控件不能过像素验收）、Global pill 移入面板标题组、错误视觉切换、i18n 扩四语；测试清单增加 account-selection、binding、native social provider 过滤、SSO org discovery、REGION_MISMATCH、旧飞书 key 清理回归。
- **PR5 收尾**：删除项修订——旧飞书页/旧 Ghost 壳/迁移进度页/旧飞书 OAuth BrowserWindow **已消失，改为「确认无死引用」验证项**；其余同前版。

规则 26 三问（更新）：①SSH 远程——不涉及（不变）。②IPC/deep link——桌面 `cindy://focus/<source>` 沿用不新增；**移动 auth deep link 是独立的 native Linking 链路（`cindycn://auth`/`cindy://auth`），PR4 验收单列，不与桌面 focus 混淆**。③手机版由 PR4 覆盖（范围=皮肤化现有状态机）。

## 4. 验收标准（增补项）

在前版 nodeId/pageKind 驱动矩阵基础上增补：
1. **Provider fixture 矩阵**：phone-only / email-only / both / social {apple,google,wechat} 组合 / SSO 单与多 connection / ssoRequired——桌面移动同套 fixture；WeChat 出现时的行为按 #28-② 拍板结果断言。
2. **回调触发场景拆分**：浏览器页矩阵只覆盖「回调请求真实到达」的场景；listener 失败/超时/取消走 app 内错误态验收。
3. **迁移矩阵区分 cn/global**（global 无 LegacyMigrationDialog）。
4. **移动 deep link**：region 化 scheme 冷/热启动 + REGION_MISMATCH 错误路径。
5. 其余（像素卡、性能预算、规则合规）同前版。

## 5. 风险与对策（更新）

| 风险 | 对策 |
|---|---|
| 服务端 ProviderConfig 动态性 vs 设计稿固定按钮集合 | #33 拍板对齐策略；fixture 驱动开发与验收 |
| 移动 Chrome 回调页无客户端承载 | #30 拍板（server/中转页，可能跨 cindy-server）；未定前 PR3 范围明确排除 |
| 现有 `--login-*` token 撞名 | PR0a 定命名/迁移方案 |
| 倒计时（#32）、完成态等「设计有/代码无」的状态机差 | 逐项拍板：补状态机 or 从像素验收剔除 |
| 字体/性能/文案源合一/旧状态回归 | 同前版 |

## 6. 待拍板清单（33 项）

前版 #1~#27、#29 维持（其中 #29 清单按 §1 修订版重列：**桌面**=sso-org、账号选择、绑定、完成态、门控空场景、LegacyMigrationDialog 三态、method-choice 多 connection/无邮箱变体、迁移 cn-only 说明；**移动**=splash/OTA/阻断屏、sso-org、method-choice、账号选择、绑定、resolving、配置缺失；处置=补稿/批准候选默认/保留现状）。修订与新增：

- **#11（改写·收窄）**：仅 login-success/ghost-success；方案 A=文案改「验证已完成，请返回 Cindy 继续」（与 figma 成功卡文案不同，需设计知悉）/ 方案 B=延后渲染（动 auth 时序）。
- **#12（改写·拆三）**：桌面登录回调语言 / 桌面 provider·Ghost 回调语言 / 移动登录语言，分别拍板是否统一 app locale。
- **#28（重写）**：移动 provider 排列动态 vs 固定、WeChat 展示策略、无稿 RN 状态处置（不再是「是否新建 flow」）。
- **#30（新增）**：移动浏览器终态页承载方——auth-server/中转页方案（跨仓）or 本期范围外。
- **#31（新增）**：CTA 品牌显示 token——「回到 CINDY」大写 vs 产品名 Cindy。
- **#32（新增）**：验证码重发倒计时——双端补状态机 or 从设计验收剔除该状态。
- **#33（新增）**：登录方式集合与归因展示对齐——服务端动态开关如何映射设计稿固定集合；桌面是否新增「归因」展示（现状无）。

### 已拍板项（2026-07-19 本轮决策 · 指向 design.md）

以下编号在本轮被 lead 决策覆盖，从待拍板状态关闭；结论权威为 `docs/login-redesign/design.md` 对应章节，冲突时以 `figma-component-spec.md` 实测为准。已拍板项的实测参数（带 nodeId）与延展规则在 design.md 中逐字区分，不混写。

- **#3（hover）已拍板**：输入框 / Text_link / 第三方圆钮 / Global pill 无 hover 节点——按 design.md §2 叠层延展规则实现（已设计态引用 + 延展规则照抄）；移动端不实现 hover。
- **#4（pressed）已拍板**：第三方圆钮无 pressed 节点——按 design.md §2 叠层延展规则实现（第三方圆钮 pressed 照抄主按钮 `247:1542` 参数）。
- **#5（阴影）已拍板**：桌面窗口阴影——沿用 OS / BrowserWindow 系统默认，不自定义（design.md §3）。覆盖 `figma-component-spec.md` §8 #2 的「需设计补 effect 参数」缺口，改为不补、沿用系统默认。
- **#6（loading 动画）已拍板**：loading 动画时长 / easing——沿用现有代码参数（桌面 Tailwind `animate-spin` 1s linear infinite + wrapper compositor-only；移动 ActivityIndicator 原生默认）（design.md §3）。覆盖 `figma-component-spec.md` §8 #6 的 loading 动效子项。
- **#10 / #28-②（WeChat 展示策略）已拍板**：WeChat 圆钮展示——国区审核通过前不显示；获批后沿用 Figma「LOG IN_手机登录_默认」帧第三方圆钮行排版（Apple / WeChat 绿钮 / SSO 三钮同排同尺寸同间距），不另开设计帧；入口显隐由服务端 `/api/auth/providers` 下发的 `ProviderConfig.social` 驱动（design.md §5）。
- **#21（横屏 + 平板）部分已拍板**：
  - 横屏子项：**已有稿·细化中**——用户补 iPad 横屏设计帧「Log in_iPad_1133×744」，左右构图（立绘居左，右列 = 字标 + 面板 + 圆钮行）；精确几何与断点插值规则 lead 细化中，落点 `adaptation-spec.md` 横屏节（待追加）。原「竖排居中限宽不分栏」表述作废。见 design.md §4.1。
  - 平板 / 分屏子项：**仍已拍板**——iPad 竖屏全屏（宽 ≥ 700pt）= 手机版式居中限宽 + 立绘按缩放规则；分屏 / Stage Manager 窄窗（宽 < 700pt）回退手机竖排弹性规则。见 design.md §4.2。

仍待拍板（本轮**未**覆盖，不顺手关闭）：

- **#18 / #19 / #20（移动两档间线性插值 / 1334 以下 / 1624 以上）**：D-d 仅覆盖分屏窄窗回退分支，两档间插值模型与两档外完整行为仍待拍板（`adaptation-spec.md` §3.2 / §3.3）。
- **#22（键盘态隐藏 Slogan / 裁切立绘）**：D-d 未覆盖键盘弹起态，仍待拍板（design.md §4.5、`adaptation-spec.md` §3.5）。
- **#28-①（provider 排列动态 vs 固定）/ #28-③（无稿 RN 状态处置）**：D-c 仅关闭 #28-② WeChat 展示策略，#28 另两子项仍待拍板。

阻塞关系：沿用前版三子集模型；#28（新版，轻量）与 #33 阻塞 PR4 的 provider 相关验收口径但不再阻塞开工；#30 只影响是否扩 PR3 范围；#32 阻塞验证码态定稿。
