# Cindy 登录链路 UI 界面与交互状态总清单

> **基线**:`main@f8760bed`(2026-07-19 最新),审计于只读 worktree `.xdt-worktrees/main-login-audit`。
> **方法**:三个范围(桌面主链路 / 浏览器侧 / 手机版+过渡链)各由 Opus 4.8 与 GPT-5.5 两个模型独立审计,lead 逐条交叉核对;分歧处由 lead 亲读代码裁决(裁决记录见文末 §9)。所有条目带 `file:line` 锚点,文案均为代码 verbatim。
> **置信度标注**:未标注 = 双模型互证;`[单源已抽查]` = 仅一份报告提出、lead 已亲读代码确认。

---

## §1 桌面端登录页:状态机与逐状态 UI

### 1.0 架构事实

- 状态机权威定义:`packages/auth-client/src/types.ts:115-132`。真实 step 共 8 个:`identifier / method-choice / verification-code / browser-redirect / account-selection / binding / completed / error`。
- **`preparing` 是伪状态**:`loginState === null` 时 LoginPage 渲染的准备视图,不在枚举里(`LoginPage.tsx:520-522`)。
- renderer 只读投影;票据(pendingLoginTicket/pendingBindTicket)全在 main 内存(`authManager.ts:1093-1100`)。
- 路由:`/login`→GuestRoute→LoginPage;`/`→ProtectedRoute→LocalDbGate→MainLayout(`router.tsx:41-58`)。守卫在 `isInitializing` 时渲染 `null`。
- AuthProvider 在 RouterProvider 之外,登录成功靠 `auth:state-change` 广播 → GuestRoute 被动 `<Navigate to="/">`,无显式导航(`AuthContext.tsx:86-101`)。
- SplashScreen 挂在 App 顶层(`App.tsx:239`,仅主窗),淡出条件 = env 通过 + ≥1.5s + auth 初始化完成(`useSplash.ts:87`)。**用户看到登录页时 splash 必已卸载**。

### 1.1 卡片外壳(全状态共用)

| 元素 | 规格 | 锚点 |
|---|---|---|
| 页面根 | `min-h-screen bg-[var(--login-bg)]`,顶部 46px 拖拽区,非 mac 显示 WindowControls | LoginPage.tsx:564-575 |
| 卡片 | `min-h-[560px] w-[440px] rounded-xl px-10 py-8`,border `--login-card-border`,bg `--login-card-bg` | :577-583 |
| Logo | 深浅色 wordmark,宽 216px,alt="Cindy",不可拖拽 | :584-590 |
| Global 徽标 | 仅 `VITE_CINDY_AUTH_REGION==='global'` 时显示 chip **"Global"**;cn 无徽标 | :591-596 |
| 错误横幅 | 卡片底部 `role="alert"`,`--login-error-text`;文案 = `login.errors.<code>`,无 key 落 fallback | :600-607, :70-75 |
| Header | 标题 24px、副标题 14px,居中 | :614-621 |
| 主按钮 | 高 44px 全宽圆角 full,`--login-btn-bg`;disabled = `opacity-60 cursor-not-allowed` | :13-17 |
| 次按钮 | 高 44px 全宽,border + `--surface-elevated` | :20-24 |
| 输入框 | 高 44px 全宽圆角 full,placeholder `--text-placeholder`,focus ring | :27-31 |
| **返回按钮** | **左上角 icon-only ArrowLeft,无可见文字**;"返回/取消"只进 aria-label/title | :635-659 |

### 1.2 逐状态清单

#### S0 preparing(伪状态,loginState=null)
- **进入**:初始;useLogin 自动 `loadLoginState()`(useLogin.ts:21-34)→ main 拉 `/api/auth/providers`。
- **UI**:仅 Header——**"正在连接登录服务"** / **"将为你加载当前区域可用的登录方式"**。无输入无按钮。(LoginPage.tsx:521-523)
- **转移**:成功→identifier;失败→error(code + recoverTo:'identifier',authManager.ts:1046-1050)。

#### S1 identifier(主入口)
- **进入**:providers-loaded。进入时 `identifierKind = providers.attribution`,重置 sso/code/binding 本地态(:58-68)。
- **UI**:
  - Header **"欢迎使用 Cindy"** / **"选择一种方式安全登录"**
  - Tab(仅 `email && phone` 同真):顺序恒 `[phone, email]`,**"手机号"**/**"邮箱"**,图标 Phone/Mail
  - 输入框:email→`type=email` placeholder **"请输入邮箱"**;phone→`type=tel` **"请输入手机号"**
  - 主按钮 **"继续"**(loading→spinner+**"请稍候..."**);disabled=`isLoading || !identifier.trim()`
  - 社交区(仅 `social.length>0`):divider **"或"**;每 provider 一个次按钮 **"使用 {{provider}} 登录"**(Apple/Google/微信);mark:apple=``、google=`G`、wechat=`微`(:664-670)
  - 企业 SSO 入口(**恒显,无区域条件**):**"使用企业 SSO 登录"**(:222-237)
- **交互**:email 提交→`discover`→method-choice;phone 提交→`request-code(phone)`→verification-code;社交→`start-browser(social)`→browser-redirect;SSO 入口→本地 `ssoOrgMode=true`(不进 main)。
- **社交可见性矩阵**:完全由 server `providers.social` 决定,client 不硬编码;实测区域预设 cn≈{phone,apple(wechat 视配置)},global≈{email,apple,google}——以 server 返回为准。

#### S1b identifier/ssoOrgMode(企业 ID 子视图,本地态)
- **UI**:返回 icon(aria **"返回"**);Header **"企业 SSO 登录"** / **"输入企业 ID,跳转到你所在企业的单点登录"**;输入 maxLength=64 placeholder **"请输入企业 ID"**;**"继续"**;底部 **"不知道企业 ID?请联系企业管理员"**(:104-140)。
- **交互**:提交→`discover-sso-org`(main 转小写请求 `/api/auth/sso/discovery`,空 connections→`ORG_SSO_NOT_FOUND`)→method-choice(email='');返回→回 identifier 主视图。

#### S2 method-choice
- **进入**:email discover 或 SSO org discover 成功。
- **派生**:`emailAllowed` = 有 email_code 方法 **且** 无任何 ssoRequired;orgName = 首个 sso 方法的 orgName(:244-249)。
- **UI**:
  - 返回 icon→`reset`(回 identifier)
  - Header **"选择登录方式"**;副标题三分支:有 org+email→**"{{email}} 属于企业「{{org}}」"**;SSO 入口路径(无 email)→**"选择企业「{{org}}」的单点登录方式"**;无 org→直接显示 email
  - 每个 SSO 方法:主按钮,Building2 图标 + **"以企业身份登录"** + 副行 **"通过 {{name}} 单点登录"** + ExternalLink 图标
  - 邮箱验证码项(仅 emailAllowed):有 SSO 并存→次按钮 UserRound **"以个人身份登录"**/**"向邮箱发送验证码"**;无 SSO→主按钮 Mail **"使用邮箱验证码登录"**
  - ssoRequired 存在时底部提示 **"该企业要求通过 SSO 登录"**
- **交互**:SSO→`start-browser(sso, connectionId)`→browser-redirect;邮箱→`request-code(email)`→verification-code。

#### S3 verification-code
- **UI**:返回 icon→reset;Header **"输入验证码"** / **"验证码已发送至 {{identifier}}"**;输入 `inputMode=numeric pattern=[0-9]{6} maxLength=6` 居中大字距 placeholder **"6 位验证码"**,自动剔除非数字;主按钮 **"登录"**(loading→**"正在验证..."**),disabled=`isLoading || len!==6`;文本链接 **"重新发送验证码"**。
- **⚠ 无重发倒计时/冷却**——重发按钮仅受 isLoading 禁用(双模型确认,无 countdown state)。
- **交互**:提交→`verify-code`→outcome 三分支;重发→`request-code` 原地。

#### S4 browser-redirect
- **进入**:start-browser。**乐观投影**:renderer 在 IPC 返回前立即 `setLoginState({step:'browser-redirect',label})`(AuthContext.tsx:161-163)。
- **UI**:Header **"请在浏览器中完成验证"** + 副标题 = label(Apple/Google/微信/connectionName);Spinner size24(role=status,aria=**"请稍候..."**);次按钮 **"取消"**。
- **取消按钮无 disabled 属性,loading 中恒可点**(有测试断言,LoginPage.browserRedirect.test.tsx:65-69);`cancel-browser` 是唯一穿透 renderer busy 锁的 action(useLogin.ts:38)。
- **超时**:`BROWSER_AUTH_TIMEOUT_MS = 5min`→`USER_CANCELLED`(静默)。
- **转移**:回调 outcome→completed/account-selection/binding;取消→settle 后回退上一可用态或重载 providers→identifier。

#### S5 account-selection
- **进入**:outcome `select_account`(main 存 pendingLoginTicket);可从 verify-code / 浏览器回调 / verify-binding 任一 outcome 触发。
- **UI**:返回 icon→reset;Header **"选择身份"** / **"选择本次要使用的个人或企业身份"**;每账号一个次按钮:org→Building2 / personal→UserRound;主行 displayName;副行 `orgName || email ||` **"个人身份"**。
- **交互**:点选→`select-account`;缺票→`INVALID_LOGIN_TICKET`(→error)。

#### S6 binding(两阶段)
- **进入**:outcome `binding_required`(bindType=phone|email,main 存 pendingBindTicket)。
- **UI 阶段一(codeRequested=false)**:左上 icon 的 aria 是 **"取消"**(非"返回");Header phone=**"绑定手机号"**/**"登录完成前,需要验证一个手机号"**,email=**"绑定邮箱"**/**"登录完成前,需要验证一个真实邮箱"**;输入复用 email/phone placeholder;按钮 **"发送验证码"**(loading→"请稍候...")。
- **UI 阶段二(codeRequested=true)**:显示 contact 文本行;6 位验证码输入(同 S3);按钮 **"完成登录"**(loading→**"正在验证..."**);**无"重新发送"按钮**(与 S3 不同)。
- **交互**:`request-binding-code`→阶段二;`verify-binding`→outcome(ok→completed,亦可 select_account);缺票→`INVALID_BIND_TICKET`(→error)。

#### S7 completed
- **UI**:renderContent 返回 **null**——卡片外壳(logo)还在、内容区空,无 spinner 无文案,极短瞬态(LoginPage.tsx:554)。随即广播→路由跳走。

#### S8 error
- **进入**(仅两类):(a) 初始拉 providers 失败;(b) flowCannotRetry 三码 `INVALID_LOGIN_TICKET / INVALID_BIND_TICKET / INVALID_AUTH_CODE`(authManager.ts:1257-1270)。
- **UI**:Header **"暂时无法登录"** / 副标题固定 **"登录失败,请稍后重试"**;主按钮 **"重试"**(loading→"请稍候...");errorCode 另在底部横幅显示对应文案。
- **交互**:重试→`reset`→identifier。`recoverTo` 字段 renderer 未消费(恒 reset)。
- **其余失败**(网络/验证码错等):不进 error,停原界面 + 底部横幅(main 保留 stateBeforeAction)。

### 1.3 桌面错误码 → 文案总表(zh-CN verbatim)

**有专属 key(19 个)**:

| code | 文案 | 备注 |
|---|---|---|
| fallback | 登录失败,请稍后重试 | 兜底 + error step 副标题 |
| AUTH_SERVICE_UNAVAILABLE | 登录服务暂不可用 | |
| AUTH_REQUEST_FAILED | 登录请求失败,请重试 | |
| NETWORK_ERROR | 网络连接失败,请检查网络 | |
| REQUEST_TIMEOUT | 请求超时,请重试 | |
| INVALID_PARAMS | 输入格式不正确 | |
| INVALID_CODE | 验证码错误或已过期 | |
| CODE_ATTEMPTS_EXCEEDED | 验证码错误次数过多,请重新获取 | |
| RATE_LIMITED | 操作过于频繁,请稍后再试 | |
| SSO_LOGIN_REQUIRED | 该邮箱所属企业要求通过 SSO 登录 | |
| ORG_SSO_NOT_FOUND | 未找到该企业,或该企业未启用 SSO 登录 | |
| SOCIAL_TOKEN_INVALID | 第三方授权已失效,请重试 | |
| SOCIAL_PROVIDER_DISABLED | 该登录方式当前不可用 | |
| USER_CANCELLED | 已取消登录 | **静默**:useLogin 置 null,横幅不显示 |
| STATE_MISMATCH | 安全校验失败,请重试 | |
| INVALID_AUTH_CODE | 授权已过期,请重新登录 | flowCannotRetry→error |
| INVALID_LOGIN_TICKET | 登录会话已过期,请重新登录 | flowCannotRetry→error |
| INVALID_BIND_TICKET | 绑定会话已过期,请重新登录 | flowCannotRetry→error |
| REGION_MISMATCH | 登录服务区域与当前客户端不匹配 | |

**无专属 key、落兜底文案的(10 个)**:`PHONE_LOGIN_DISABLED / CONNECTION_NOT_FOUND / INVALID_AUTH_ACTION / NO_BROWSER_AUTH_IN_PROGRESS / LOGIN_BUSY / CALLBACK_LISTENER_FAILED / BROWSER_OPEN_FAILED / AUTH_FLOW_SUPERSEDED / INVALID_RESPONSE / 回调透传的任意 provider error`——全部显示"登录失败,请稍后重试"。

### 1.4 loading / 锁

- renderer:`loadingRef` 单飞锁,cancel-browser 例外(useLogin.ts:38);main:`loginActionPromise` 单飞,并发返回 `LOGIN_BUSY`(authManager.ts:1290-1298)。
- loading 文案两种:继续/发送类→**"请稍候..."**;登录/完成登录→**"正在验证..."**(BusyLabel = spinner+文案)。
- 无整页 loading 遮罩(符合规范 7)。

### 1.5 区域系统(cn/global)影响清单

1. Provider 配置**完全 server 驱动**(`GET /api/auth/providers` 返回 region/attribution/email/phone/social),client 不硬编码登录方式。
2. 客户端唯一硬编码 region 分支 = Global 徽标(cn 不显示)。
3. server region ≠ 构建 region(`VITE_CINDY_AUTH_REGION`,默认 cn)→ `REGION_MISMATCH`。
4. 默认 tab = attribution(cn=phone,global=email);tab 仅双开时显示。
5. SSO 入口恒显,与区域无关。
6. auth 端点:cn=`https://auth.cindy.com.cn`,global=`https://auth.cindy.app`(config/endpoint*.json)。
7. 文案不按 region 分支(同一套 login.*)。
8. 打包身份:cn=`Cindy`/`com.xd.cindycn`,global=`CindyGlobal`/`com.xd.cindy`;**深链 scheme 不随区域分叉**(见 §3.4)。

---

## §2 桌面浏览器侧:6 类场景 + 共享页壳

### 2.1 场景总表(renderOAuthResultPage 全部消费点 + 1 个例外)

| # | 场景 | 端口/路径 | 成功页 | 失败页 | CTA source | 页面语言 |
|---|---|---|---|---|---|---|
| 1 | **登录 social/SSO**(desktop-login) | `127.0.0.1:<动态>/auth/callback` | success 壳,login.browserCallback.* | error 壳,detail=错误码 | `desktop-login` | **app locale**(getResolvedMainLocale,不看浏览器) |
| 2 | **ghost-oauth**(意识授权) | 动态(可配 redirectPort/callbackPath/公网弹跳) | success 壳,ghost 自有文案 | 400/500 三分支(provider-error/invalid-callback/internal) | `ghost-oauth` | 浏览器 Accept-Language |
| 3 | **claude-oauth**(Claude 订阅) | `localhost:<动态>/callback` | **不渲染壳,302 → `https://platform.claude.com/oauth/code/success?app=claude-code`** | 400/400/500 用 provider copy | `claude-oauth`(仅错误页) | 浏览器 Accept-Language |
| 4 | **xai-oauth**(Grok) | **固定 127.0.0.1:56121**/callback(xAI 注册死) | success 壳 provider copy | 同三分支 | `xai-oauth` | 浏览器 Accept-Language |
| 5 | **generic-oauth**(目录描述符/自定义 provider) | `127.0.0.1:<descriptor 或动态>/callback` | success 壳 provider copy | 同三分支;**close() 兜底裸文本 "done"**(abort race 时) | `generic-oauth` | 浏览器 Accept-Language |
| 6 | **OpenAI/ChatGPT**(Codex) | Codex CLI 自管 | **不用 Cindy 页壳**,spawn `codex login` 子进程,回调页归 CLI | 同左 | 无 | CLI 自管 |

全部场景超时 5 分钟;PKCE S256 + state;拉起用 `shell.openExternal`。

### 2.2 共享页壳规格(oauthResultPage.ts)

- 输入:`htmlLang / variant(success|warning|error) / title / body / detail? / action? / theme?(仅 preview)`。**warning variant 生产无调用点**。
- 结构:`<title>${title} · Cindy</title>`;card `min(100%,400px)` padding `40px 44px` 圆角 12px;badge 48px 圆(22px 静态 Lucide,✓/✕/⚠,**永不动画**);h1 20px/500;p 14px;detail monospace 12px;CTA pill min-h 44px。
- Light:page `#f8f8f6` card `#fff` border `#d7d7d4` text `#262626` muted `#737373` detail `#a3a3a3` chip `#e5e5e5` cta `#000`/`#fff` hover `#262626`。
- Dark(`prefers-color-scheme` 或 data-theme):page `#1f1f1e` card `#2c2c2a` border `#3c3c3a` text `#d4d4d4` muted `#a3a3a3` detail `#737373` chip `#3c3c3a` cta `#fff`/`#000` hover `#e5e5e5`。
- CTA focus ring:`3px solid rgba(59,130,246,.5)`。
- 语言:`pickOAuthResultPageLang(Accept-Language)` 首个命中 zh/ja/ko/en,兜底 en。

### 2.3 回调页文案(zh verbatim;4 语言全量见 flow 审计原始报告)

**登录回调(login.browserCallback.*,跟随 app 语言)**:
- 成功:**"登录成功"** / **"你可以关闭此页面,回到 Cindy 继续。"**
- 失败:**"登录未完成"** / **"请回到 Cindy 重新登录。"** + detail=错误码
- CTA:**"回到 Cindy"** → `cindy://focus/desktop-login`

**Provider 共享 copy(claude 错误页/xai/generic,跟随浏览器语言)**:
- 成功:**"授权成功"** / **"{provider} 已连接到 Cindy。你可以返回应用继续。"**
- 失败标题:**"授权未完成"**;三分支 body:missingCode **"没有收到 {provider} 的授权码,请返回 Cindy 重试。"** / invalidState **"授权校验失败,请返回 Cindy 重新发起连接。"** / exchangeFailed **"连接 {provider} 时发生错误,请返回 Cindy 重试。"**
- CTA:**"返回 Cindy"**

**Ghost copy**:
- 成功 **"授权成功"** / **"你可以关闭此页面,回到 Cindy 继续。"**;失败标题 **"授权失败"**;三分支:provider-error **"授权服务器返回错误:{detail}"** / invalid-callback **"回调参数不完整或校验失败,请回到 Cindy 重试。"** / internal **"回调处理异常,请回到 Cindy 重试。"**

> ⚠ 设计注意:**三套标题措辞并存**(登录成功/登录未完成 vs 授权成功/授权未完成 vs 授权成功/授权失败),CTA 也有 **"回到 Cindy"** vs **"返回 Cindy"** 两套;且同一台机器登录页语言=应用语言、provider 授权页语言=浏览器语言,可能不一致。

### 2.4 登录 loopback 参数校验链(authLoopbackCallback.ts:109-132)

按序:url 空→null(404) → 解析失败→null → pathname≠`/auth/callback`→null(404) → state 不符→`STATE_MISMATCH` → 有 error 参数→透传 → 有 code→`{code}` → 否则→`INVALID_AUTH_CODE`。命中的回调恒 HTTP 200 渲染页壳,渲染完立即 finish 并关 server。

---

## §3 Deep link 回跳

1. **桌面 scheme**:生成侧唯一 `cindy://`;解析/OS 注册认 `cindy://` + 历史 `xdt-maker://`。**cn/global 共用,桌面不注册 `cindycn://`**(brandIdentity.ts:118-135,deepLinkSchemes.ts:19-31)。
2. **手机 scheme**:`APP_SCHEME = global ? 'cindy' : 'cindycn'`,回跳 URL `<scheme>://auth`(apps/mobile/src/config/env.ts:30-33)。**`cindycn://` 只属于手机 CN 区**。
3. **focus 深链**:`cindy://focus/<source>` 的 source **解析后被丢弃**,只作日志标记;所有 focus 行为一致 = `focusMainWindow()`(show/restore/focus,mac 额外 `app.focus({steal:true})`),**不发 renderer、无 toast、无落地态**(deepLink.ts:116-119, 290-295)。
4. 登录数据不走深链:loopback code 交换在后台完成,深链只负责唤回前台。
5. 手机端 `+native-intent.ts` 把 `/auth` 回调路径重定向到 `/`,防 expo-router "Unmatched Route" 白屏(Android 冷启场景);真正 code 交换由 AuthContext Linking listener 独立完成。`[单源已抽查]`

---

## §4 手机版登录全链(apps/mobile)

### 4.0 启动闸门(登录屏之前)

| 帧 | 条件 | UI | 锚点 |
|---|---|---|---|
| 端点清单 pending | 冷启动拉 OSS endpoint.json | 品牌 splash(立绘+CINDY 字标+手写体,无文字无 spinner) | _layout.tsx:115, CenteredScreen.tsx:36-99 |
| 端点 error | 拉取失败无缓存 | **"无法获取服务器配置"** / **"请检查网络连接后重试(<reason>)"** / **"重试"**(无跳过) | _layout.tsx:106-114 |
| OTA 未就绪 | 自建变体热更检查中 | 同 splash | _layout.tsx:75-78 |
| auth 初始化中 | initialized=false(闸门超时 20s) | index 渲染 splash;其它路由原地不动 | AuthContext.tsx:363-409, index.tsx:8 |

- NavigationGate:`!initialized`→不动;未登录不在 (auth)→`replace('/login')`;已登录在 (auth)→`replace('/')`(_layout.tsx:31-41)。
- `isAuthenticated = user !== null`(不看 access token)——弱网可先以缓存 profile 恢复已登录视图。
- **旧飞书登录已完全移除**,启动时显式清除旧 refresh token(AuthContext.tsx:372-378)。

### 4.1 登录屏外壳

- SafeAreaView→KeyboardAvoidingView(iOS padding)→ScrollView 居中;品牌块:**"Cindy"**(大写)+ global 才有 pill **"国际"** + 标题 **"登录 Cindy"** + 副标题 cn=**"国内版 · 手机号归因"** / global=**"国际版 · 邮箱归因"**(login.tsx:527-557)。
- 文案系统:`loginText()` 按系统语言 zh/en 二选一(loginMessages.ts)。
- 错误条(红)在卡片顶部;config 面板:唯一校验 `EXPO_PUBLic_CINDY_AUTH_BASE_URL` 非法→**"登录配置未完成"** + **"登录服务地址必须是 http(s) URL。"**,并全屏禁用。
- 全局 disabled = `isBusy || !initialized || configIssues>0`。
- 无 loginState 兜底:单按钮 **"继续"**(busy→**"处理中…"**)→reset。

### 4.2 状态清单(与桌面同一状态机,渲染差异)

- **identifier**:同桌面结构;placeholder 措辞不同——**"输入手机号(含国家区号)"** / **"输入邮箱地址"**;社交按钮文案 **"通过 Apple/Google/微信 继续"**(桌面是"使用 X 登录");SSO 入口 **"使用企业 SSO 登录"** 恒显。
- **ssoOrgMode 子视图**:同桌面,副标题/提示句尾多句号(**"…单点登录。"** / **"…请联系企业管理员。"**)。
- **method-choice**:同桌面三分支副标题;SSO 按钮多连接时 label = **"以企业身份登录 · <connectionName>"**(桌面是主行+副行两行);无 SSO 时邮箱按钮文案 **"发送邮箱验证码"**(桌面是"使用邮箱验证码登录");ssoRequired 提示 **"该组织要求使用企业 SSO 登录。"**(桌面"该企业要求通过 SSO 登录")。
- **verification-code**:**"输入验证码"** / **"验证码已发送至 <identifier>"**;CodeInput 6 位 `one-time-code`;**"登录"** + **"重新发送验证码"**;**同样无倒计时**。
- **browser-redirect**(仅 SSO 走这里):**"请在浏览器中完成登录"** + **"<label> · 完成后会自动返回 Cindy。"** + **"取消"**;**无 spinner**(桌面有);回调处理中 isBusy 使取消 disabled。
- **account-selection**:**"选择身份"** / **"选择本次要进入的个人或组织身份。"**;行结构同桌面(Building2/UserRound + displayName + orgName/email/**"个人身份"**)。
- **binding**:phone=**"绑定手机号"**/**"国内版需要验证手机号后才能完成登录。"**;email=**"绑定真实邮箱"**/**"国际版需要验证真实邮箱后才能完成登录。"**(措辞带"国内版/国际版",桌面不带);两阶段同桌面,已发码按钮是 **"登录"**(桌面"完成登录")。
- **completed / error 无独立渲染分支**:completed 短瞬 brand+空卡;error 靠顶部错误条(loginState 保留原界面,仅 INVALID_LOGIN_TICKET/INVALID_BIND_TICKET 清空状态)。

### 4.3 手机社交登录(原生 SDK,不走浏览器)

**按钮可见条件 = `isNativeSocialProviderSupported`(nativeSocial.ts:26-39),server 开了但本端 client-id 未注入则不渲染**:

| provider | 平台 | 额外条件 | SDK | 关键边界 |
|---|---|---|---|---|
| apple | 仅 iOS | isAvailableAsync | expo-apple-authentication | 不可用→SOCIAL_PROVIDER_UNAVAILABLE;无 identityToken→AUTH_REQUEST_FAILED |
| google | iOS/Android | GOOGLE_WEB_CLIENT_ID(iOS 另需 IOS_CLIENT_ID+URL_SCHEME) | @react-native-google-signin | Android 先 hasPlayServices(可弹更新框);非 success→USER_CANCELLED;缺配置→SOCIAL_PROVIDER_NOT_CONFIGURED |
| wechat | iOS/Android | WECHAT_APP_ID + UNIVERSAL_LINK | xdt-wechat-login | 未安装→SOCIAL_PROVIDER_UNAVAILABLE;**前台计时 8s 超时**(去微信授权时暂停计时)→REQUEST_TIMEOUT;iOS 模拟器恒不可用 |

- 流程:`native-social` action→原生取短时凭据→`client.exchangeNativeSocial`(token 交换恒在 auth-server)→acceptOutcome。
- 取消类原生 code(`ERR_REQUEST_CANCELED / ERR_WECHAT_CANCELLED / SIGN_IN_CANCELLED`)统一归一 `USER_CANCELLED`。

### 4.4 手机企业 SSO(唯一走浏览器的手机登录)

- start-sso:PKCE+state 存 SecureStore(10 分钟有效,支持浏览器触发的 App 重启后续接)→投影 browser-redirect→`WebBrowser.openAuthSessionAsync(authUrl, <scheme>://auth)`。
- 回跳:success→`completeOAuthCallback`(state 校验→exchange→acceptOutcome,browserCompletionRef 防并发);非 success→清 pending+回滚+USER_CANCELLED。

### 4.5 手机错误码 → 文案表(zh verbatim,loginMessages.ts:122-182)

| code | 文案 |
|---|---|
| INVALID_CODE | 验证码无效或已过期。 |
| INVALID_PARAMS | 输入内容格式不正确。 |
| INVALID_AUTH_CODE | 登录授权已过期,请重新发起。 |
| INVALID_LOGIN_TICKET | 身份选择已过期,请重新登录。 |
| INVALID_BIND_TICKET | 绑定流程已过期,请重新登录。 |
| STATE_MISMATCH | 登录状态校验失败,请重新登录。 |
| REGION_MISMATCH | 客户端区域与登录服务不匹配。 |
| NETWORK_ERROR | 网络连接失败,请检查网络后重试。 |
| REQUEST_TIMEOUT | 登录请求超时,请重试。 |
| USER_CANCELLED | 已取消登录。(**手机端显示**,桌面静默——平台差异) |
| SOCIAL_PROVIDER_NOT_CONFIGURED | 该登录方式尚未完成配置。 |
| SOCIAL_PROVIDER_UNAVAILABLE | 当前设备无法使用该登录方式。 |
| AUTH_REQUEST_FAILED | 登录服务暂时不可用,请稍后重试。 |
| ORG_SSO_NOT_FOUND | 未找到该企业,或该企业未启用 SSO 登录。 |
| fallback | 登录未完成,请重试。 |

### 4.6 dev/debug

- **登录页无 dev/debug 面板**(旧"开发调试"抽屉已随飞书登录移除)。
- 唯一旁路:`MOBILE_VISUAL_MOCK_ENABLED`(`__DEV__` + env flag)整个 AuthProvider 短路为 mock 已登录,登录屏不渲染。

---

## §5 登录成功后过渡链

### 5.1 桌面:completed → 主界面(逐帧)

| 帧 | 触发 | 用户看到 | 锚点 |
|---|---|---|---|
| 1 | dispatch 写 completed | 登录卡壳(logo + 空内容),无 spinner 无文案 | LoginPage.tsx:554 |
| 2 | main 广播 auth:state-change | 瞬时(loginState→null) | AuthContext.tsx:86-101 |
| 3-4 | GuestRoute→`/`,ProtectedRoute 放行 | 路由切换 | GuestRoute/ProtectedRoute |
| 5 | LocalDbGate checking(通常<100ms) | **null → 仅 body `--background` 主题底色纯色帧**(dark 主题即深底,非白闪;splash 此时已卸载,不参与兜底) | LocalDbGate.tsx:108-111, globals.css:126-135 |
| 5' | ensureReady 失败 | 重试 2 次×1s;耗尽→fatal→null(同底色空帧)+ **main 弹 OS dialog**:标题三选一 **"数据库损坏且无可用备份"/"数据库恢复后仍无法打开"/"无法初始化本地数据库"**,detail 尾 **"请重启应用,或在系统资源管理器中打开数据目录手动处理。"**,按钮 **"好的"**;renderer 无重试 UI,停空屏 | LocalDbGate.tsx:32-33,86-96; localDb/index.ts:139-162,565-572 `[单源已抽查]` |
| 6 | ready | appReadyForBot(IM bot 上线)→MainLayout→`Navigate('/cc-agent')`→CCAgentIndexRedirect(会话加载中显示 **"加载中..."**) | LocalDbGate.tsx:79-80, CCAgentIndexRedirect.tsx:30-90 |
| 7 | 首登可能叠 LegacyMigrationDialog(老数据迁移弹窗,phase confirm/running/failed/done) | 弹窗盖主界面 | App.tsx:249 |

> LocalDbGate 源码注释称"App 已有 splash 兜底视觉"与冷启动登录实态有偏差——splash 在登录前已卸载,实际兜底只是 body 底色。

### 5.2 手机:回跳/验证完成 → 首页(逐帧)

1. acceptOutcome ok:持久化 refreshToken→applyUser(isAuthenticated=true)→completed。
2. completed 瞬态:brand + 空卡(极短)。
3. NavigationGate `replace('/')` → HomeScreen(devices/index)。**不回 splash**;Stack contentStyle=colors.surface 保证无白闪。
4. 首页首帧属首页自身加载态(**"正在读取可控制电脑"** spinner / RemoteAccessGuide 引导态 / **"同步失败"**),不属登录链。
5. SSO 回跳分支:App 后台回前台,`+native-intent` 防 /auth 404 白屏。

---

## §6 状态转移总表(双端共用状态机)

| From | Action | To |
|---|---|---|
| (null) | reset→providers-loaded | identifier |
| (null) | 加载失败 | error(桌面)/错误条(手机) |
| identifier | discover(email) | method-choice |
| identifier | request-code(phone) | verification-code |
| identifier | start-browser(social)(桌面)/native-social(手机) | browser-redirect(桌面)/outcome 直达(手机) |
| identifier | SSO 入口(本地) | ssoOrgMode 子视图 |
| ssoOrgMode | discover-sso-org | method-choice |
| method-choice | start-browser(sso)/start-sso | browser-redirect |
| method-choice | request-code(email) | verification-code |
| verification-code | verify-code→outcome | completed / account-selection / binding |
| verification-code | resend | 原地 |
| browser-redirect | 回调 outcome | completed / account-selection / binding |
| browser-redirect | 取消/超时(5min 桌面;手机浏览器会话关闭) | USER_CANCELLED(桌面静默回退;手机回滚+显示"已取消登录。") |
| account-selection | select-account→outcome | completed / binding |
| binding(!code) | request-binding-code | binding(code) |
| binding(code) | verify-binding→outcome | completed / account-selection |
| 任意 | flowCannotRetry(3 票据码) | error(桌面)/清态(手机) |
| 任意 | 可重试失败 | 原界面 + 错误提示 |
| completed | 广播/守卫 | 主界面(§5) |
| 任意 | 返回/取消(reset) | identifier |

---

## §7 桌面 vs 手机差异速查(设计侧)

| 维度 | 桌面 | 手机 |
|---|---|---|
| 社交登录通道 | 系统浏览器 + loopback | 原生 SDK(Apple/Google/微信),不出 App(除 SSO) |
| browser-redirect UI | 有 spinner | 无 spinner |
| 取消按钮 | 恒可点(无 disabled) | 回调处理中 disabled |
| USER_CANCELLED | 静默 | 显示"已取消登录。" |
| completed | null(空卡) | 无渲染分支(同空卡) |
| error step | 专属界面(暂时无法登录+重试) | 无,仅错误条 |
| 回跳 scheme | `cindy://focus/*`(双区共用) | cn=`cindycn://auth`,global=`cindy://auth` |
| 回调 HTML 页 | 有(login.browserCallback.*) | 无(深链/ASWebAuthenticationSession) |
| binding 完成按钮 | "完成登录" | "登录" |
| 社交按钮文案 | "使用 X 登录" | "通过 X 继续" |
| i18n | 4 语言(zh-CN/en/ja/ko) | 2 语言(zh/en,按系统语言) |
| 重发倒计时 | 无 | 无 |

---

## §8 已知设计缺口(代码实态,非推测)

1. 桌面/手机验证码重发均无倒计时/冷却 UI。
2. 桌面 completed→主界面之间两段空白:登录卡空内容瞬态 + LocalDbGate 底色帧;fatal 时 renderer 白屏死等(仅 OS dialog + Cmd+R,2026-07-15 出过线上白屏事故,代码注释可证)。
3. 回调页三套标题措辞 + 两套 CTA 措辞不统一(§2.3)。
4. 10 个错误码落通用兜底文案(LOGIN_BUSY、PHONE_LOGIN_DISABLED 等用户场景可能困惑)。
5. 手机 browser-redirect 无 spinner;手机无 error 专属界面。
6. focus 深链回 app 无任何确认反馈(仅窗口置前)。
7. generic-oauth 取消 race 可见裸文本 "done"。
8. binding 验证码阶段无重发按钮(双端)。

---

## §9 裁决记录(交叉核对分歧处理)

| 争议 | 裁决 | 依据 |
|---|---|---|
| `cindycn://` 是否存在 | 桌面不注册(只有 cindy://+xdt-maker://);手机 CN 区注册 cindycn://auth | brandIdentity.ts:118-135 + mobile env.ts:30-33,lead 亲读确认 |
| splash 是否兜底 completed→main 空帧 | 否——fade 条件含 `!authInitializing`,登录页可见时 splash 已卸载;LocalDbGate 注释是历史设想 | useSplash.ts:87 + SplashScreen.tsx:67 |
| BackButton 是否有可见文字 | 无,icon-only;文字仅 aria/title | LoginPage.tsx:635-659 |
| 手机是否有"飞书登录"/dev 面板 | 均已移除;唯一旁路 visual mock | AuthContext.tsx:128-145, 372-378 |
| 手机是否有 completed/error 屏 | 无独立渲染分支 | login.tsx:519-520 |
