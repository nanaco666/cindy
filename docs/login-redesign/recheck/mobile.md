# Cindy 移动端登录链路重盘报告

> 本报告只新增本文件，未删除或修改 `docs/` 下既有文件。代码事实以最新 main 为准；旧审计结论不沿用。

## 1. 基线核定

- 已执行 `git fetch origin main`，成功拉取 `origin/main` 到 `FETCH_HEAD`。
- 本次选用基线：`643c3dcabd018f3944a7ee501e3993eff4d5476a`（`main` / `origin/main` / `FETCH_HEAD`，2026-07-19 14:40:51 +0800，`feat(desktop): open profile edit dialog on avatar click`）。

| 对象 | SHA | 时间 | 备注 |
|---|---|---|---|
| 当前工作树 `skin/cindy-theme-family` | `1da571331118a075c8bb712e7a633d330102194a` | 2026-07-16 18:28:16 +0800 | 非 main；当前工作树已有桌面主题与登录文档相关未跟踪/未提交改动，本报告未触碰既有文件 |
| 本地 `main` | `643c3dcabd018f3944a7ee501e3993eff4d5476a` | 2026-07-19 14:40:51 +0800 | 与 `origin/main` 一致 |
| `origin/main` | `643c3dcabd018f3944a7ee501e3993eff4d5476a` | 2026-07-19 14:40:51 +0800 | 最新 main |
| `FETCH_HEAD` | `643c3dcabd018f3944a7ee501e3993eff4d5476a` | 2026-07-19 14:40:51 +0800 | `git fetch origin main` 结果 |
| `.xdt-worktrees/main-login-audit` | `6d5033d476d10a924720e8505be79120bd71d010` | 2026-07-19 01:19:08 +0800 | detached，旧审计基线，落后于本次 main |

发现未合 main 的移动登录相关分支：

- `origin/feat/auth-server-login`：`eefe4b2bd261787ea0b0243cf97f9be9428834a7`，ahead main 5 / behind main 507；包含移动登录 UI 文案调整（例如去掉“归因 / 国内版 / 国际版”内部术语）和微信构建修复，但不是最新 main。
- `origin/fix/mobile-ios-native-build`、`origin/fix/mobile-wechat-modulemap*`：均涉及 `xdt-wechat-login` 或构建修复，落后 main，不作为现状基线。
- `origin/codex/mobile-unified-update-check`：涉及设置页更新检查，不改变登录方式全集。

## 2. 结论摘要

最新 main 上，移动端已经不是“飞书 OAuth 单按钮”。`apps/mobile` 已接入 `@cindy/auth-client` 的 auth-server 登录流，RN 内置登录 UI 覆盖手机号/邮箱输入、验证码、企业 SSO、账号选择、绑定、错误、浏览器等待和 deep link 回跳。

登录方式全集：

| 登录方式 | 现状 |
|---|---|
| 手机号 + 验证码 | 支持。手机号提交直接 `request-code(kind: "phone")`，验证码走 `verify-code`。见 `apps/mobile/app/(auth)/login.tsx:143`、`apps/mobile/src/auth/AuthContext.tsx:585`、`packages/auth-client/src/client.ts:127`、`packages/auth-client/src/client.ts:139`（基线 `643c3dc`）。 |
| 邮箱 + 验证码 | 支持。邮箱先 `discover(email)`，若允许 `email_code` 再发送邮箱验证码。见 `apps/mobile/app/(auth)/login.tsx:146`、`apps/mobile/app/(auth)/login.tsx:258`、`apps/mobile/src/auth/AuthContext.tsx:558`、`packages/auth-client/src/client.ts:98`（基线 `643c3dc`）。 |
| Apple | 支持 iOS 原生凭据，前提是 auth-server provider 返回 `apple`；Android 不显示。见 `packages/auth-client/src/types.ts:6`、`apps/mobile/src/auth/nativeSocial.ts:26`、`apps/mobile/src/auth/nativeSocial.ts:50`（基线 `643c3dc`）。 |
| Google | 支持 iOS / Android 原生凭据，前提是 provider 返回 `google` 且 Google client 配置齐全；本地 region 配置要求 global 才能配置 Google。见 `apps/mobile/src/auth/nativeSocial.ts:31`、`apps/mobile/src/auth/nativeSocial.ts:81`、`apps/mobile/app.config.js:48`、`apps/mobile/app.config.js:54`（基线 `643c3dc`）。 |
| WeChat | 代码支持 iOS / Android 原生微信登录，前提是 provider 返回 `wechat` 且 `WECHAT_APP_ID` / universal link 配置齐全；当前设计稿登录帧未使用 WeChat 圆钮。见 `packages/auth-client/src/types.ts:6`、`apps/mobile/src/auth/nativeSocial.ts:107`、`apps/mobile/package.json:56`、`apps/mobile/package.json:58`（基线 `643c3dc`）。 |
| 企业 SSO | 支持两条入口：邮箱域名 discovery 后选择 SSO，或直接输入企业 ID / org slug discovery；授权走系统浏览器 PKCE + deep link。见 `apps/mobile/app/(auth)/login.tsx:94`、`apps/mobile/app/(auth)/login.tsx:258`、`apps/mobile/src/auth/AuthContext.tsx:570`、`apps/mobile/src/auth/AuthContext.tsx:618`、`packages/auth-client/src/client.ts:107`、`packages/auth-client/src/client.ts:250`（基线 `643c3dc`）。 |
| 飞书 OAuth / 原生飞书 SSO | 当前移动登录链路中已退役。代码仍有“飞书通知”等业务文案，但登录依赖里没有 `xdt-feishu-login`，旧飞书 refresh/profile/pendingOAuth key 会被清理。见 `apps/mobile/package.json:5`、`apps/mobile/package.json:58`、`apps/mobile/src/auth/AuthContext.tsx:372`（基线 `643c3dc`）。 |

国区 / 国际区判定：

- 构建 region 来自 `EXPO_PUBLIC_CINDY_AUTH_REGION`，默认 `cn`，`global` 才切到国际区；同时决定 scheme：`cn -> cindycn://auth`，`global -> cindy://auth`。见 `apps/mobile/src/config/env.ts:30`、`apps/mobile/src/config/env.ts:32`、`apps/mobile/app.config.js:104`、`apps/mobile/app.config.js:151`（基线 `643c3dc`）。
- EAS profile 已显式区分 `production/testflight` 的 `cn` 与 `production-global/testflight-global` 的 `global`。见 `apps/mobile/eas.json:7`、`apps/mobile/eas.json:25`、`apps/mobile/eas.json:78`（基线 `643c3dc`）。
- auth-server `/api/auth/providers` 返回 `region / attribution / email / phone / social`；客户端若收到 region mismatch 会抛 `REGION_MISMATCH`。见 `packages/auth-client/src/types.ts:24`、`packages/auth-client/src/client.ts:83`（基线 `643c3dc`）。
- 登录页默认输入类型来自 `providers.attribution`；区域归因展示文案来自本地 `loginMessages`：中文 `国内版 · 手机号归因` / `国际版 · 邮箱归因`，英文 `China · phone attribution` / `Global · email attribution`。见 `apps/mobile/app/(auth)/login.tsx:67`、`apps/mobile/app/(auth)/login.tsx:552`、`apps/mobile/src/auth/loginMessages.ts:9`、`apps/mobile/src/auth/loginMessages.ts:57`（基线 `643c3dc`）。

## 3. 代码结构与状态机

| 层 | 文件与职责 |
|---|---|
| 路由守卫 | `apps/mobile/app/_layout.tsx:25`：`NavigationGate` 按 `auth.initialized`、`auth.isAuthenticated` 与 `(auth)` route group 做 `/login` 和 `/` 重定向。 |
| 启动门 | `apps/mobile/app/_layout.tsx:65`、`apps/mobile/app/_layout.tsx:88`：端点清单 gate 先于 OTA gate；失败时显示重试屏，pending / OTA 时显示 splash。 |
| 登录 UI | `apps/mobile/app/(auth)/login.tsx:37`：登录页只负责 presentation，本地状态包含 `identifierKind`、企业 ID 模式、验证码、绑定联系信息等。 |
| AuthContext | `apps/mobile/src/auth/AuthContext.tsx:83`：`MobileLoginAction` 覆盖 reset、discover、discover-sso-org、request/verify code、start-sso、native-social、select-account、binding。 |
| auth-client 状态机 | `packages/auth-client/src/types.ts:115`：`AuthFlowState` 覆盖 `identifier`、`method-choice`、`verification-code`、`browser-redirect`、`account-selection`、`binding`、`completed`、`error`；`reduceAuthFlow` 在 `packages/auth-client/src/types.ts:151`。 |
| 网络协议 | `packages/auth-client/src/client.ts:83`：providers/discovery/request-code/verify-code/social/sso/select-account/binding/refresh/me/logout 全在 `CindyAuthClient`。 |
| Deep link | `apps/mobile/src/auth/AuthContext.tsx:512`：`Linking.addEventListener` 和 `getInitialURL` 捕获 `cindycn://auth` / `cindy://auth`；`apps/mobile/app/+native-intent.ts:16` 只防 router 404。 |

RN 内现有 UI 状态：

| 状态 | 现状事实 |
|---|---|
| Splash / OTA / 端点恢复 | `CenteredScreen variant="splash"` 使用 Cindy splash 图片资产；端点失败是 `StartupBlockedScreen`，文案“无法获取服务器配置 / 重试”。见 `apps/mobile/src/components/CenteredScreen.tsx:7`、`apps/mobile/app/_layout.tsx:106`、`apps/mobile/src/components/StartupBlockedScreen.tsx:8`（基线 `643c3dc`）。 |
| 冷启动恢复登录态 | `index` 在 `!auth.initialized` 时显示 splash，未登录重定向 `/login`。见 `apps/mobile/app/index.tsx:6`（基线 `643c3dc`）。 |
| 入口 / 输入 | `identifier` 状态渲染手机号/邮箱 segmented tabs、输入框、继续按钮、社交按钮和企业 SSO 入口；若只开放一种 `email/phone`，tabs 隐藏。见 `apps/mobile/app/(auth)/login.tsx:86`、`apps/mobile/app/(auth)/login.tsx:158`、`apps/mobile/app/(auth)/login.tsx:188`、`apps/mobile/app/(auth)/login.tsx:220`、`apps/mobile/app/(auth)/login.tsx:241`（基线 `643c3dc`）。 |
| 企业 ID 输入 | `ssoOrgMode` 在 identifier 步骤内输入企业 ID，并发 `discover-sso-org`。见 `apps/mobile/app/(auth)/login.tsx:94`、`apps/mobile/src/auth/AuthContext.tsx:570`（基线 `643c3dc`）。 |
| 方法选择 | `method-choice` 渲染 SSO 方法按钮和可选个人邮箱验证码按钮；SSO required 时只给提示。见 `apps/mobile/app/(auth)/login.tsx:258`（基线 `643c3dc`）。 |
| 验证码 | `verification-code` 渲染 6 位 `CodeInput`、登录按钮、重新发送按钮。见 `apps/mobile/app/(auth)/login.tsx:329`、`apps/mobile/app/(auth)/login.tsx:658`（基线 `643c3dc`）。 |
| 浏览器授权等待 | `browser-redirect` 渲染“请在浏览器中完成登录”和取消按钮；当前无面板级 spinner。见 `apps/mobile/app/(auth)/login.tsx:580`（基线 `643c3dc`）。 |
| 账号选择 | `account-selection` 在 RN 内渲染个人/组织身份行，不是外部浏览器承载。见 `apps/mobile/app/(auth)/login.tsx:384`、`apps/mobile/src/auth/AuthContext.tsx:249`（基线 `643c3dc`）。 |
| 绑定 | `binding` 在 RN 内渲染手机号/邮箱绑定输入、发码、验证码确认。见 `apps/mobile/app/(auth)/login.tsx:433`、`apps/mobile/src/auth/AuthContext.tsx:257`、`apps/mobile/src/auth/AuthContext.tsx:667`（基线 `643c3dc`）。 |
| 完成 | `LoginOutcome.status === "ok"` 后设置 user/token，`completed` 状态很快被 `NavigationGate` 重定向到首页；没有完成页。见 `apps/mobile/src/auth/AuthContext.tsx:266`、`apps/mobile/app/_layout.tsx:38`（基线 `643c3dc`）。 |
| 错误 | `authError` 通过 `authErrorText` 映射后在登录卡片顶部内联显示；不是独立错误页。见 `apps/mobile/app/(auth)/login.tsx:519`、`apps/mobile/src/auth/loginMessages.ts:122`（基线 `643c3dc`）。 |
| 配置缺失 / 配置错误 | 登录页只检查显式 `EXPO_PUBLIC_CINDY_AUTH_BASE_URL` 是否为 http(s) URL；生产端点清单拉取失败另走启动阻断屏。见 `apps/mobile/src/config/env.ts:110`、`apps/mobile/app/(auth)/login.tsx:565`、`apps/mobile/app/_layout.tsx:106`（基线 `643c3dc`）。 |
| 登出回登录 | 设置页 `logout` 后 `router.replace('/login')`。见 `apps/mobile/app/settings.tsx:400`（基线 `643c3dc`）。 |

## 4. 文案、i18n、布局与主题现状

登录域已有轻量 zh/en catalog，不再是全硬编码中文；但不是桌面同款四语 i18n，也不是全 app i18n。

- 文案源：`apps/mobile/src/auth/loginMessages.ts:5` 至 `apps/mobile/src/auth/loginMessages.ts:103`（基线 `643c3dc`）。
- 语言选择：系统 locale 首选，`zh* -> zh`，其余 `en`；auth-server locale 为 `zh-CN` 或 `en`。见 `apps/mobile/src/auth/loginMessages.ts:108`、`apps/mobile/src/auth/loginMessages.ts:114`（基线 `643c3dc`）。
- 登录文案全集包括：产品名、登录标题、国区/国际区归因副标题、手机号/邮箱、输入 placeholder、继续/或/Apple/Google/WeChat、选择登录方式、企业/个人身份、邮箱验证码、SSO required、企业 SSO 入口与企业 ID 输入说明、验证码输入/发送至/placeholder/登录/重发、账号选择、个人身份、绑定手机号/邮箱、发送验证码、返回/取消、浏览器授权等待、处理中、配置未完成、Global badge、兜底错误。
- 错误文案覆盖 `INVALID_CODE`、`INVALID_PARAMS`、`INVALID_AUTH_CODE`、`INVALID_LOGIN_TICKET`、`INVALID_BIND_TICKET`、`STATE_MISMATCH`、`REGION_MISMATCH`、`NETWORK_ERROR`、`REQUEST_TIMEOUT`、`USER_CANCELLED`、`SOCIAL_PROVIDER_NOT_CONFIGURED`、`SOCIAL_PROVIDER_UNAVAILABLE`、`AUTH_REQUEST_FAILED`、`ORG_SSO_NOT_FOUND`。见 `apps/mobile/src/auth/loginMessages.ts:122`（基线 `643c3dc`）。
- 仍硬编码中文的登录相关外围：端点失败屏由 `_layout` 传入“无法获取服务器配置 / 请检查网络连接后重试 / 重试”，配置 URL 错误 message 为中文。见 `apps/mobile/app/_layout.tsx:108`、`apps/mobile/src/config/env.ts:119`（基线 `643c3dc`）。

布局与主题：

- 当前登录页是 `SafeAreaView + KeyboardAvoidingView + ScrollView + card`，不是 Figma 红底绝对坐标舞台。见 `apps/mobile/app/(auth)/login.tsx:527`、`apps/mobile/app/(auth)/login.tsx:529`、`apps/mobile/app/(auth)/login.tsx:533`、`apps/mobile/app/(auth)/login.tsx:559`（基线 `643c3dc`）。
- 当前登录页主体颜色走 `ThemeProvider` light/dark token；App 级 `userInterfaceStyle: "automatic"`。见 `apps/mobile/src/theme/ThemeProvider.tsx:15`、`apps/mobile/app.json:9`、`apps/mobile/app/(auth)/login.tsx:700`（基线 `643c3dc`）。
- 当前登录页没有 Cindy 立绘/签名/字标资源；只有文本品牌块。Splash 已有 Cindy bitmap 资产。见 `apps/mobile/app/(auth)/login.tsx:537`、`apps/mobile/src/components/CenteredScreen.tsx:7`（基线 `643c3dc`）。
- 全局文字封顶 `maxFontSizeMultiplier = 1.2`。见 `apps/mobile/src/components/AppText.tsx:17`（基线 `643c3dc`）。

## 5. 出入点 diff

格式：`现状事实（file:line + 基线 SHA）| 文档说法（哪份哪节）| 影响（改哪条计划/拍板项）`。

### 5.1 vs `current-adaptation-audit-mobile.md`

| # | 出入点 |
|---:|---|
| A1 | 现状事实：登录页已是 auth-server 多状态 RN UI，入口含手机号/邮箱输入、社交按钮、企业 SSO；`apps/mobile/app/(auth)/login.tsx:86`、`apps/mobile/app/(auth)/login.tsx:158`、`apps/mobile/app/(auth)/login.tsx:220`、`apps/mobile/app/(auth)/login.tsx:241`（基线 `643c3dc`） \| 文档说法：旧审计 §结论摘要称“一个「飞书登录」主按钮”，§映射称“项目内唯一正式入口，一个「飞书登录」按钮”（`current-adaptation-audit-mobile.md:7`、`:124`） \| 影响：撤销“移动正式路径只有飞书单按钮”前提，`landing-plan` #28 需撤销/改写。 |
| A2 | 现状事实：移动端登录协议由 `CindyAuthClient` 驱动，`clientType: "mobile"`，region/locale/deviceId 传给 auth-server；`apps/mobile/src/auth/AuthContext.tsx:832`（基线 `643c3dc`） \| 文档说法：旧审计称状态流账号选择/企业 SSO/绑定由飞书 App、系统浏览器或服务端回跳承载（`:8`） \| 影响：计划必须以现有 auth-server 状态机为 UI 替换基础，不是新建状态机。 |
| A3 | 现状事实：RN 内已有手机号/邮箱输入和验证码输入；`apps/mobile/app/(auth)/login.tsx:188`、`:329`、`:658`（基线 `643c3dc`） \| 文档说法：旧审计称正式路径输入在外部，项目内只有 dev sheet callback URL 输入（`:125`） \| 影响：PR4 不能按“无正式输入”估算；需要直接复刻 input_2 / input_验证码到现有输入态。 |
| A4 | 现状事实：RN 内已有账号选择界面；`apps/mobile/app/(auth)/login.tsx:384`、`apps/mobile/src/auth/AuthContext.tsx:249`（基线 `643c3dc`） \| 文档说法：旧审计称账号选择在飞书 App / 浏览器 OAuth 外部 UI，RN 内不可替换（`:127`、`:283`） \| 影响：`landing-plan` §1.2 #10 “外部”应拆分，账号选择 RN surface 需要补设计或纳入 #29。 |
| A5 | 现状事实：RN 内已有绑定手机号/邮箱流程；`apps/mobile/app/(auth)/login.tsx:433`、`apps/mobile/src/auth/AuthContext.tsx:667`（基线 `643c3dc`） \| 文档说法：旧审计称“未见移动端 RN 绑定 UI”（`:128`） \| 影响：`landing-plan` §1.2 漏列绑定 surface，应新增或并入 #29 无稿 surface。 |
| A6 | 现状事实：企业 SSO 有 RN 企业 ID 输入入口和 method-choice 入口；`apps/mobile/app/(auth)/login.tsx:94`、`:258`、`packages/auth-client/src/client.ts:107`（基线 `643c3dc`） \| 文档说法：旧审计 §9 称“项目内没有 SSO 页面；同一个「飞书登录」按钮触发原生 SDK”（`:263`、`:266`） \| 影响：`landing-plan` §1.2 #9 “企业 SSO / 飞书原生入口 外部”需改为“入口/选择 RN，浏览器授权外部”。 |
| A7 | 现状事实：native social 支持 Apple / Google / WeChat，且会按平台和配置过滤；`packages/auth-client/src/types.ts:6`、`apps/mobile/src/auth/nativeSocial.ts:26`（基线 `643c3dc`） \| 文档说法：旧审计未登记 Apple/Google/WeChat 正式登录能力，并把第三方入口归入飞书/外部授权（`:114`、`:132`） \| 影响：PR4 设计核销要覆盖 Apple/Google/WeChat 的显示规则，尤其 WeChat 与设计稿不一致。 |
| A8 | 现状事实：移动依赖中没有 `xdt-feishu-login`，只有 `xdt-wechat-login` 等本地模块；`apps/mobile/package.json:56`、`:58`（基线 `643c3dc`） \| 文档说法：旧审计引用 `xdt-feishu-login` iOS/Android native module 和 `LarkSSO.setupLang("zh")`（`:265`、`:270`） \| 影响：旧 Feishu native SSO 相关计划、配置缺失和测试路径应删除或标为历史。 |
| A9 | 现状事实：回跳 scheme 为 region 化 `cindycn://auth` / `cindy://auth`；`apps/mobile/src/config/env.ts:30`、`:32`、`apps/mobile/app/+native-intent.ts:3`（基线 `643c3dc`） \| 文档说法：旧审计写 `lizcn://auth`，且将回跳与飞书 OAuth 绑定（`:277`、`:299`） \| 影响：PR4 deep link 测试矩阵和文档需按 region scheme 更新。 |
| A10 | 现状事实：配置错误不再是缺 `EXPO_PUBLIC_FEISHU_APP_ID`，登录页只校验显式 auth base URL，生产还受 endpoint gate 阻断；`apps/mobile/src/config/env.ts:110`、`apps/mobile/app/_layout.tsx:106`（基线 `643c3dc`） \| 文档说法：旧审计称“当 `EXPO_PUBLIC_FEISHU_APP_ID` 缺失时插入 configPanel”（`:233`、`:234`） \| 影响：`landing-plan` §1.2 #6 的配置缺失反馈应改为 auth base URL / endpoint manifest 错误。 |
| A11 | 现状事实：登录域已有 zh/en catalog 和错误码映射；`apps/mobile/src/auth/loginMessages.ts:5`、`:108`、`:122`（基线 `643c3dc`） \| 文档说法：旧审计称“未见移动端 i18n 层”“可见文案基本硬编码中文”（`:12`、`:162`） \| 影响：mobile i18n 方案应从“从零建立”改为“登录域 zh/en 扩展到四语/统一 fallback”。 |
| A12 | 现状事实：登录页已使用 `KeyboardAvoidingView` 和 `ScrollView`；`apps/mobile/app/(auth)/login.tsx:529`、`:533`（基线 `643c3dc`） \| 文档说法：旧审计称主屏无输入框、无 `KeyboardAvoidingView`，无滚动容器（`:223`、`:224`） \| 影响：键盘态仍需按新设计重做，但不是完全缺失。 |
| A13 | 现状事实：Splash 已使用 Cindy bitmap 资产，pending/OTA/恢复态复用 `variant="splash"`；`apps/mobile/src/components/CenteredScreen.tsx:7`、`:36`、`apps/mobile/app/_layout.tsx:75`、`apps/mobile/app/index.tsx:8`（基线 `643c3dc`） \| 文档说法：旧审计称启动/loading 无图片、`XDMaker` 文案、未见显式 splash 资源（`:178`、`:184`、`:198`） \| 影响：`landing-plan` §1.2 #1/#2/#3 候选默认应改为“复用/校准现有 Cindy splash”，不是从零。 |

### 5.2 vs 设计稿文档（`DESIGN-login.md` §5 / `figma-component-spec.md`）

| # | 出入点 |
|---:|---|
| D1 | 现状事实：登录页背景是 theme `colors.surface`，卡片是 `colors.surfaceElevated`，非品牌红整屏；`apps/mobile/app/(auth)/login.tsx:700`、`:747`（基线 `643c3dc`） \| 文档说法：移动画板背景固定 `#df0c27`，见 `DESIGN-login.md` §1.2/§5（`:43`、`:216`） \| 影响：PR4 仍需落移动品牌红 stage/token，#23/#29 中移动暗色策略要重新描述。 |
| D2 | 现状事实：登录页品牌块只有文本 `Cindy / 登录 Cindy / 副标题`，无立绘、SLOGAN、WORD_MARK；`apps/mobile/app/(auth)/login.tsx:537`（基线 `643c3dc`） \| 文档说法：移动端必须有 `CINDY_mobile`、`SLOGAN`、`WORD_MARK` 且两档坐标明确，见 `DESIGN-login.md:51`、`:53`、`:54`、`:218` \| 影响：PR0b-mobile 仍需资源 manifest 与登录页资源接入。 |
| D3 | 现状事实：当前布局是 flex/ScrollView 居中卡片，没有 750 坐标引擎；`apps/mobile/app/(auth)/login.tsx:533`、`:707`（基线 `643c3dc`） \| 文档说法：移动登录组 `x=35 y=973/734 w=680 h=560`，功能区刚性，见 `DESIGN-login.md:55`、`:231` \| 影响：D4 #18~#22 仍是有效布局拍板项，但对象是现有完整 auth UI。 |
| D4 | 现状事实：输入框是 `minHeight: 48`、theme token、pill；`apps/mobile/app/(auth)/login.tsx:787`（基线 `643c3dc`） \| 文档说法：`input_2` 为 `540 x 80`、`#EEEEEE`、stroke `#D4D4D4/#2A2828/#D91F37`、HarmonyOS 24，见 `figma-component-spec.md:139`、`:145` \| 影响：PR4 输入组件需像素替换，且要补 focus/error/filled 状态。 |
| D5 | 现状事实：主按钮来自 `MainWindowActionButton`，默认 `minHeight:44`、文本 `typeScale.body`，loading 时只替换 ActivityIndicator；`apps/mobile/src/components/MobilePrimitives.tsx:575`、`:615`、`:974`（基线 `643c3dc`） \| 文档说法：主按钮 `540 x 80`、radius 40、Bold 24、loading 文案+右侧 spinner，见 `figma-component-spec.md:190`、`:196`、`:199` \| 影响：PR4 不能复用现有 main window action button 直接过像素验收。 |
| D6 | 现状事实：社交登录以全宽文字按钮渲染，label 来自 `loginText(provider)`；`apps/mobile/app/(auth)/login.tsx:220`、`:620`（基线 `643c3dc`） \| 文档说法：第三方入口为 80x80 圆钮，国区 Apple+SSO、国际区 Apple+Google+SSO，见 `figma-component-spec.md:231`、`:248` \| 影响：PR4 需新增圆形 icon button；现有 WeChat 支持需单独决定是否显示。 |
| D7 | 现状事实：global 标识显示在 brand row 右侧 badge；`apps/mobile/app/(auth)/login.tsx:537`、`:541`（基线 `643c3dc`） \| 文档说法：Global pill 在登录面板标题 group 内，`x=425 y=4 w=70 h=30`，见 `DESIGN-login.md:54`、`figma-component-spec.md:86` \| 影响：国际区标题布局需重做，不能沿用当前 badge。 |
| D8 | 现状事实：方法选择用普通按钮列表，SSO 多连接时 label 拼接 `企业身份登录 · connectionName`，无 100px 行、副标题、左右图标；`apps/mobile/app/(auth)/login.tsx:283`（基线 `643c3dc`） \| 文档说法：SSO/个人方式选择行为 `540 x 100`，带企业图标、副文案和右箭头，见 `DESIGN-login.md:188`、`figma-component-spec.md:287` \| 影响：method-choice 需要专属组件；并且现有“多个 SSO connection”需定义布局。 |
| D9 | 现状事实：验证码页只有“重新发送验证码”按钮，没有倒计时态；`apps/mobile/app/(auth)/login.tsx:365`（基线 `643c3dc`） \| 文档说法：验证码页有 `42 秒后可重新发送` / `重新发送` 的 `Text_link` 状态，见 `DESIGN-login.md:124`、`figma-component-spec.md:263` \| 影响：若要 1:1，需要补 resend countdown 状态机或从设计验收范围剔除。 |
| D10 | 现状事实：浏览器授权等待态没有 64x64 loading 图标，只显示标题/副标题和取消按钮；`apps/mobile/app/(auth)/login.tsx:580`（基线 `643c3dc`） \| 文档说法：浏览器等待屏 `loading x=308 y=158 w=64 h=64`，见 `DESIGN-login.md:136` \| 影响：browser-redirect UI 需补 panel loading。 |
| D11 | 现状事实：错误显示是卡片内带边框的 `Text` block，颜色使用 `colors.errorText`（黑白系）；`apps/mobile/app/(auth)/login.tsx:809`、`apps/mobile/src/theme/tokens.ts:102`（基线 `643c3dc`） \| 文档说法：错误文案 `error_text` 为 `#D91F37`、居中 680x50，见 `figma-component-spec.md:275` \| 影响：错误态需从通用 app error token 切到登录专属视觉。 |
| D12 | 现状事实：RN 内已有账号选择、绑定、企业 ID 输入三类设计稿未覆盖状态；`apps/mobile/app/(auth)/login.tsx:384`、`:433`、`:94`（基线 `643c3dc`） \| 文档说法：`DESIGN-login.md` 移动 §5 仅覆盖四个入口帧，没有 account-selection/binding/sso-org；`landing-plan` 也把无稿 surface 放 #29 \| 影响：#29 需新增移动 account-selection、binding、sso-org 三项，不能只沿旧 audit 的 13 项。 |
| D13 | 现状事实：登录域仅 zh/en，外围还有中文硬编码；`apps/mobile/src/auth/loginMessages.ts:5`、`apps/mobile/app/_layout.tsx:108`（基线 `643c3dc`） \| 文档说法：落地计划要求 mobile 四语 catalog，见 `landing-plan.md:121` \| 影响：mobile i18n 仍需扩展，但工作量从“从零建立”改为“扩 zh/en catalog + 外围文案”。 |
| D14 | 现状事实：当前 app 全局 `orientation: "default"`、iPad 支持，登录页无 auth route 方向锁；`apps/mobile/app.json:7`、`:36`（基线 `643c3dc`） \| 文档说法：D4 候选默认包含 auth route 锁竖屏 + 平板手机舞台，见 `landing-plan.md:90` \| 影响：#21 保留，但需要基于现有输入/键盘/账号选择状态一起拍板。 |

### 5.3 vs `landing-plan.md`

| # | 出入点 |
|---:|---|
| L1 | 现状事实：移动登录主屏已经不是飞书入口，且没有 `xdt-feishu-login`；`apps/mobile/app/(auth)/login.tsx:86`、`apps/mobile/package.json:56`（基线 `643c3dc`） \| 文档说法：§1.2 #7/#9 多处写“等待飞书/浏览器授权”“企业 SSO / 飞书原生入口”（`landing-plan.md:64`、`:66`） \| 影响：§1.2 surface 名称和说明需全部去飞书化。 |
| L2 | 现状事实：手机号/邮箱/OTP/第三方/SSO RN 状态机已存在；`apps/mobile/src/auth/AuthContext.tsx:83`、`packages/auth-client/src/types.ts:115`（基线 `643c3dc`） \| 文档说法：D4 #28 称“不存在手机号/邮箱/验证码/Apple/Google/SSO 的 RN 业务状态机”（`landing-plan.md:91`） \| 影响：#28 应撤销或改写；不应继续作为 PR4 开工阻塞。 |
| L3 | 现状事实：账号选择和绑定是 RN 内状态；`apps/mobile/app/(auth)/login.tsx:384`、`:433`（基线 `643c3dc`） \| 文档说法：§1.2 #10 把“系统浏览器 OAuth/账号选择”整体标为外部，#12 未列绑定（`landing-plan.md:67`） \| 影响：§1.2 核销表应新增/拆分 account-selection 与 binding。 |
| L4 | 现状事实：企业 SSO 入口包括 RN 企业 ID 输入和 RN 方式选择，外部只发生在浏览器授权阶段；`apps/mobile/app/(auth)/login.tsx:94`、`:258`、`apps/mobile/src/auth/AuthContext.tsx:618`（基线 `643c3dc`） \| 文档说法：§1.2 #9 标“外部（入口按钮属 #5）”（`landing-plan.md:66`） \| 影响：#9 应改为“入口/企业 ID/方式选择替换@PR4；browser authorize 外部”。 |
| L5 | 现状事实：当前没有开发调试 sheet / mock 登录正式页面片段；`apps/mobile/app/(auth)/login.tsx:37` 到 `:618` 全为正式 auth-server UI（基线 `643c3dc`） \| 文档说法：§1.2 #11 写“开发调试 sheet / mock 登录 保留”（`landing-plan.md:68`） \| 影响：#11 应从 PR4 surface 表删除或改为“当前 main 未见该 surface”。 |
| L6 | 现状事实：deep link scheme 已 region 化，且回调不靠手动 callback 输入；`apps/mobile/src/config/env.ts:32`、`apps/mobile/src/auth/AuthContext.tsx:512`（基线 `643c3dc`） \| 文档说法：§1.2 #12 沿旧审计“callback 手动输入 / deep link resolving”（`landing-plan.md:69`） \| 影响：#12 应改为真实 deep link resolving / callback error，不再包含 dev 手动输入。 |
| L7 | 现状事实：登录域已有 zh/en catalog；`apps/mobile/src/auth/loginMessages.ts:5`（基线 `643c3dc`） \| 文档说法：mobile i18n 方案称“现状 apps/mobile 无 i18n 层、登录文案硬编码中文”（`landing-plan.md:121`） \| 影响：PR0b-mobile 的 i18n 任务应修订为“扩展到四语 + 覆盖外围中文硬编码 + 与 desktop key/fallback 对齐”。 |
| L8 | 现状事实：代码额外支持 WeChat provider；`packages/auth-client/src/types.ts:6`、`apps/mobile/src/auth/nativeSocial.ts:107`（基线 `643c3dc`） \| 文档说法：§6 批次④ #10 问“WeChat 圆钮是否保留实现”，设计稿登录页不使用 WeChat（`landing-plan.md:163`；`figma-component-spec.md:239`） \| 影响：#10 仍需保留，但应从“组件库是否保留”升级为“真实 provider 出现时如何处理”。 |
| L9 | 现状事实：#21 锁竖屏/平板舞台仍未由代码实现；`apps/mobile/app.json:7`、`:36`（基线 `643c3dc`） \| 文档说法：D4 #21 是候选默认（`landing-plan.md:90`） \| 影响：#21 保留，但它不再依赖 #28 的“新建 auth flow”分叉；应直接服务 PR4 UI 复刻。 |
| L10 | 现状事实：当前浏览器等待态、配置错误、endpoint 错误已有不同 UI surface；`apps/mobile/app/(auth)/login.tsx:580`、`:565`、`apps/mobile/app/_layout.tsx:106`（基线 `643c3dc`） \| 文档说法：§1.2 #6/#7/#12 仍按旧飞书/手动 callback 表述（`landing-plan.md:63`、`:64`、`:69`） \| 影响：PR4 测试矩阵要拆“登录页 configPanel”和“启动 endpoint blocked screen”。 |
| L11 | 现状事实：现有状态机包含 `select_account` 与 `binding_required` 的服务端 outcome；`packages/auth-client/src/types.ts:86`、`:92`、`apps/mobile/src/auth/AuthContext.tsx:245`（基线 `643c3dc`） \| 文档说法：PR4 测试清单只写插值/safe area/键盘/deep link（`landing-plan.md:126`） \| 影响：PR4 测试清单应增加 account-selection、binding、native social provider filtering、SSO org discovery、region mismatch、旧 Feishu key 清理。 |

## 6. 对 #28 的处置建议

建议：撤销原 #28 文本，改成一个较轻的“移动登录业务差异确认”项，而不是 PR4 阻塞级“是否新建 RN auth flow”。

推荐新文案：

> #28 移动登录 UI 与 provider 策略确认：最新 main 已有 auth-server RN 登录状态机（手机号/邮箱/验证码/Apple/Google/WeChat/企业 SSO/账号选择/绑定）。PR4 不再需要在“皮肤替换 vs 新建 auth flow”间二选一；应直接复刻现有状态机的 UI。仍需产品/设计确认三点：1. 国区/国际区真实 provider 排列是否按服务端动态返回，还是按设计稿固定 Apple/SSO/Google；2. WeChat provider 若出现是否展示、隐藏还是补设计；3. account-selection、binding、企业 ID 输入三类无稿 RN 状态走 #29 补稿还是批准候选默认。

## 7. 本次未做

- 未运行移动端 build/typecheck/截图测试；本任务是代码与文档事实重盘。
- 未读取或修改服务端仓库；provider 配置的运行时实际返回值仅能从移动端 contract 推断。
