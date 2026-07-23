# 登录链路权威转移图（flow-map）

> 从真实代码提取的「登录链路状态机 + 转移条件」权威图。作为 demo 重接线和后续 PR 的唯一依据。
> 任何与本文档冲突的 demo / 设计稿表述，以本图为准；本图与代码冲突时以代码为准。

## 基线与阅读说明

- **基线**：`origin/main` HEAD = `6835a14f`（`fix(maker-core): 强制收割 codex app-server 前先广播终态...`）。
  - 任务给的是 `643c3dc`，origin 已前进，以新 SHA `6835a14f` 为准。
  - 全部结论用 `git show origin/main:<path>` 读取，**未读工作区改动**（当前分支 `skin/cindy-theme-family` 相对 origin/main 有大量偏离，工作区已无 `packages/auth-client` 目录，必须以 origin/main 为准）。
- **只读边界**：本文件是本次任务的唯一产物；未改任何源码，未删 docs 下任何文件。
- **锚点约定**：所有结论带 `file:line`，行号对齐 origin/main。`types.ts` 指 `packages/auth-client/src/types.ts`；`client.ts` 指 `packages/auth-client/src/client.ts`；`authManager.ts` 指 `apps/desktop/src/main/authManager.ts`；`LoginPage.tsx` 指 `apps/desktop/src/renderer/components/login/LoginPage.tsx`；`authIpc.ts` 指 `apps/desktop/src/shared/authIpc.ts`。
- **服务端决定 vs 客户端契约**：登录态分支由 auth-server 的 `LoginOutcome.status` 决定。客户端契约（`loginOutcomeSchema`，`types.ts:97-102`）把它约束为 discriminated union，status ∈ `{ "ok", "select_account", "binding_required" }`。客户端知道「这三种都可能」，但不知道某次输入会命中哪一种——命中哪一种完全由服务端按「该 identifier/credential 解析到几条 membership、是否需要补绑身份」决定。下文凡标「服务端决定·客户端契约未约束」处，即指此意。

---

## T1 共享状态机核心（packages/auth-client）

平台无关的纯状态机。`AuthFlowState`（`types.ts:115-132`）是 8 步判别联合：

| step | 载荷 | 定义 |
|---|---|---|
| `identifier` | `providers: ProviderConfig` | `types.ts:116` |
| `method-choice` | `email, methods: LoginMethod[]` | `types.ts:117` |
| `verification-code` | `kind: VerificationKind, identifier` | `types.ts:118` |
| `browser-redirect` | `label: string` | `types.ts:119` |
| `account-selection` | `accounts: AuthMembership[]` | `types.ts:120` |
| `binding` | `bindType, codeRequested, contact?` | `types.ts:121-126` |
| `completed` | `membership: AuthMembership` | `types.ts:127` |
| `error` | `code, recoverTo` | `types.ts:128-132` |

### 状态机纯函数 reduceAuthFlow（types.ts:152-195）

输入 `AuthFlowAction`（`types.ts:134-149`），输出下一 `AuthFlowState`。**唯一的状态转移仲裁者**，平台两侧（desktop main / mobile）都调它。

| action type | 触发来源 | 转到 step | 锚点 |
|---|---|---|---|
| `providers-loaded` | `getProviders()` 成功 | `identifier` | `types.ts:157-158` |
| `discovery-loaded` | `discover(email)` 或 `discoverSsoOrg(org)` 成功 | `method-choice` | `types.ts:159-164` |
| `code-requested` | `requestCode(kind, id)` 成功 | `verification-code` | `types.ts:165-170` |
| `browser-started` | `start-browser` 派发（social/sso） | `browser-redirect` | `types.ts:171-172` |
| `binding-code-requested` | `requestBindingCode(...)` 成功 | `binding`(codeRequested=true) | `types.ts:173-179` |
| `failed` | 任一 API 抛 `AuthApiError` 且不可原地重试 | `error` | `types.ts:180-181` |
| `outcome` | verify/exchange/selectAccount/verifyBinding 返回 `LoginOutcome` | **三分支见下** | `types.ts:182-193` |

### outcome 三分支（types.ts:182-193）—— account-selection / binding / completed 的唯一入口

`outcome` action 携带 `LoginOutcome`（`types.ts:97-102`，discriminated union on `status`）：

| outcome.status | 转到 step | 触发条件（服务端决定） | 客户端契约字段 | 锚点 |
|---|---|---|---|---|
| `"ok"` | `completed` | 服务端判定该 identifier/credential 直接对应一个已绑定的 membership，登录成功 | `accessToken, refreshToken, membership` | `types.ts:183-184` |
| `"select_account"` | `account-selection` | 服务端判定该 identifier/credential 解析到 **≥2 个 membership**（同一身份挂多个账号/组织身份），需用户选一个 | `loginTicket, accounts[](min1)` | `types.ts:186-187` |
| `"binding_required"` | `binding`(codeRequested=false) | 服务端判定该身份尚未绑定到任何 membership，需先补绑 phone 或 email | `bindType("phone"\|"email"), bindTicket` | `types.ts:189-193` |

### 哪些 API 会产出 outcome（即 account-selection / binding 可从哪些链路冒出）

`LoginOutcome` 由 `client.ts` 中 5 个方法返回（均 `POST` + `loginOutcomeSchema` 校验）：

| 方法 | 端点 | 锚点 | 桌面是否用 |
|---|---|---|---|
| `verifyCode(kind,id,code)` | `/api/auth/{kind}/verify-code` | `client.ts:139-156` | 是（phone/email code 链路） |
| `exchangeAuthorizationCode(code,verifier)` | `/api/auth/token` (grantType=authorization_code) | `client.ts:158-168` | 是（social/SSO 浏览器回调兑换） |
| `exchangeNativeSocial(provider,credential)` | `/api/auth/social/{provider}` | `client.ts:170-183` | **否**（仅 mobile，`apps/mobile/src/auth/AuthContext.tsx:613`） |
| `selectAccount(loginTicket,accountId)` | `/api/auth/select-account` | `client.ts:185-191` | 是（account-selection 后） |
| `verifyBinding(bindTicket,bindType,contact,code)` | `/api/auth/binding/verify` | `client.ts:209-221` | 是（binding 态） |

> 关键推论：**`account-selection` 与 `binding` 不是某一条链路的固定步骤，而是任意 outcome 调用都可能命中的服务端分支**。它们可从 phone-code、email-code、social（Apple/Google/Wechat）、SSO、select-account、甚至 verify-binding 之后冒出。客户端无法预判，只能按 `status` 分支渲染。

### error 态进入条件

- `failed` action（`types.ts:180-181`），`recoverTo` 决定回退到哪个非 error step。
- 桌面侧：`authManager.ts:244-247` 把 `INVALID_LOGIN_TICKET / INVALID_BIND_TICKET / INVALID_AUTH_CODE`（`flowCannotRetry`）映射为 `error` + `recoverTo:'identifier'`；其余错误保留在 `stateBeforeAction`（原地可重试，不丢已输入 identifier / 已下发 code）。`getLoginState` 失败也进 `error`（`authManager.ts:25-26`）。

---

## T2 桌面链路枚举（apps/desktop）

### 入口由 ProviderConfig 驱动（types.ts:24-31）

`getProviders()`（`client.ts:83-96`）返回 `{ region, attribution, email, phone, social[] }`。桌面 `LoginPage` 按这些布尔/枚举渲染入口（`LoginPage.tsx:100-240` `renderIdentifier`）：

- `providers.email && providers.phone` → 顶部 phone/email 切换 tab（`LoginPage.tsx:103,146-170`）；否则只渲染 `attribution` 指定的那一个。
- `providers.social[]`（enum `apple|google|wechat`，`types.ts:6`）→ 渲染社交登录按钮（`LoginPage.tsx:195-220`）。
- SSO 入口按钮（"使用企业 SSO 登录"）**恒定存在**于 identifier 步（`LoginPage.tsx:222-237`），切到 `ssoOrgMode` 子视图输入企业 ID。

### 区域（cn / global）

- `AUTH_REGION` 构建期烘焙：`VITE_CINDY_AUTH_REGION === 'global' ? 'global' : 'cn'`（`authManager.ts:70-72`）。
- 〔2026-07-19 补正〕**dev 场景下区域由启动参数驱动**：`pnpm restart:desktop:remote --region=cn|global`。解析链 = CLI `--region` 显式值 → 兼容 `CINDY_AUTH_REGION` env → 默认 `cn`（`scripts/shared/desktop-dev-region.mjs` `resolveDesktopDevRegion`）；remote dev 同时按区域选取对应 endpoint 清单。「构建期烘焙」描述的是打包产物；dev 的烘焙值来源就是这个启动参数注入。
- 〔实测参照 · 2026-07-19 用户截图〕当前线上形态：global = 邮箱输入 + Apple + Google + 企业 SSO 文字链 + `Global` 徽标；cn = 手机号输入 + Apple + 企业 SSO 文字链、无徽标。此为服务端当时下发的 ProviderConfig 实况快照，仅作参照，不构成客户端契约。
- 服务端 `providers.region` 必须等于构建 `AUTH_REGION`，否则抛 `REGION_MISMATCH`（`client.ts:88-94`）。
- global 构建：登录卡顶部显示 `login.globalRegion` 徽标（`LoginPage.tsx:592-596`）；cn 构建不显示。
- **每 region 具体有哪些 providers 字段值（cn 是否含 phone/wechat、global 是否含 apple/google 等）由服务端 `getProviders()` 返回决定，客户端代码不硬编码——「服务端决定·客户端契约未约束」。** 下文链路模板按「该入口被 ProviderConfig 允许」为前提枚举，cn/global 的实际可用入口以服务端配置为准。

### 链路模板（7 条，每条有序状态序列）

状态简写：I=identifier / M=method-choice / V=verification-code / B=browser-redirect / A=account-selection / Bind=binding / C=completed / E=error。`outcome→{ok|sel|bind}` 表示服务端 outcome 三分支。

#### 链路 1：邮箱验证码（前提 `providers.email`）

1. **I**（email tab）→ 用户输 email，submit → `dispatch discover`（`LoginPage.tsx:86-87`）
2. **M** → 若 `email_code` 方法被允许且无 `ssoRequired` 拦截（`LoginPage.tsx:245-247`），点 `emailCode`/`personalLogin` → `dispatch request-code(email)`（`LoginPage.tsx:323-328`）
3. **V** → 输 6 位码 → `dispatch verify-code(email)`（`LoginPage.tsx:350-355`）
4. `acceptLoginOutcome(verifyCode(...))`（`authManager.ts:1131-137`）→ **outcome 三分支**：ok→**C** / sel→**A** / bind→**Bind**

#### 链路 2：手机号验证码（前提 `providers.phone`）

1. **I**（phone tab）→ 用户输 phone，submit → `dispatch request-code(phone)`（`LoginPage.tsx:88-89`）。**注意：phone 直接进 V，不经 M**（`submitIdentifier` 对 phone 分支不调 discover）。
2. **V** → 输 6 位码 → `dispatch verify-code(phone)`（`LoginPage.tsx:350-355`）
3. `acceptLoginOutcome(verifyCode(...))` → **outcome 三分支**：ok→**C** / sel→**A** / bind→**Bind**

> ⚠️ 这是用户质疑点：**phone-code 登录后 account-selection 是否可能出现？是。** 当且仅当服务端对 `verifyCode(phone,...)` 返回 `status:"select_account"`（该手机号解析到 ≥2 个 membership）。它不是 phone 链路的固定步骤，是服务端分支。

#### 链路 3：Apple（前提 `'apple' ∈ providers.social`）

1. **I** → 点 Apple 按钮 → `dispatch start-browser(social, apple, label=login.social.apple)`（`LoginPage.tsx:205-211`）
2. **B**（`browser-redirect`，label=Apple）→ renderer 乐观立即切 B（`AuthContext.tsx:161-163`），同时 main 打开系统浏览器到 `buildAuthorizeUrl(kind:social)`（`client.ts:250-272`，`authManager.ts:1186-1203`）
3. 系统浏览器内完成 IdP 登录 → 回调到 loopback `http://127.0.0.1:<port>/auth/callback`（`authManager.ts:397`，`authLoopbackCallback.ts:122`）→ **回调页**渲染（见 ④）→ `exchangeAuthorizationCode(code, verifier)`（`authManager.ts:1200`）
4. `acceptLoginOutcome(exchange)` → **outcome 三分支**：ok→**C** / sel→**A** / bind→**Bind**

#### 链路 4：Google（前提 `'google' ∈ providers.social`）

同链路 3，`providerOrConnectionId='google'`，`label=login.social.google`。

#### 链路 5：Wechat（前提 `'wechat' ∈ providers.social`）

同链路 3，`providerOrConnectionId='wechat'`，`label=login.social.wechat`。`wechat` 仅出现在 `socialProviderSchema`（`types.ts:6`）；是否在 cn/global 启用由服务端配置决定。

#### 链路 6：企业 SSO（经邮箱域名发现，前提 `discover(email)` 返回 sso methods）

1. **I**（email）→ submit → `dispatch discover`（同链路 1 第 1 步）
2. **M** → 渲染 sso 连接按钮（`LoginPage.tsx:265-292`）；点企业登录 → `dispatch start-browser(sso, connectionId, label=connectionName)`（`LoginPage.tsx:274-281`）
3. **B** → 系统浏览器到 `buildAuthorizeUrl(kind:sso)`（`client.ts:260`）→ loopback 回调 → **回调页** → `exchangeAuthorizationCode`（`authManager.ts:1200`）
4. `acceptLoginOutcome(exchange)` → **outcome 三分支**：ok→**C** / sel→**A** / bind→**Bind**

#### 链路 7：企业 SSO（经企业 ID 入口，恒定可用）

1. **I** → 点 `ssoEntry`（`LoginPage.tsx:223-237`）→ `ssoOrgMode` 子视图 → 输企业 ID → `dispatch discover-sso-org`（`LoginPage.tsx:97`）
2. **M**（email=''，methods=sso 连接，`authManager.ts:1107-115`）→ 点连接 → `dispatch start-browser(sso, connectionId, label=connectionName)`（`LoginPage.tsx:274-281`）
3. **B** → 系统浏览器 → loopback 回调 → **回调页** → `exchangeAuthorizationCode`
4. `acceptLoginOutcome(exchange)` → **outcome 三分支**：ok→**C** / sel→**A** / bind→**Bind**

### 全局转移条件表（桌面侧 runLoginAction，authManager.ts:1104-1273）

| from | 触发（用户动作 / 服务端响应字段） | to | 锚点 |
|---|---|---|---|
| (init / null) | `getLoginState` / `reset` → `loadLoginProviders` → `getProviders()` 成功 | `identifier` | `authManager.ts:1031-1042`，`types.ts:157-158` |
| `identifier` | 用户 submit email → `discover(email)` 成功 | `method-choice` | `authManager.ts:1094-103`，`types.ts:159-164` |
| `identifier` | 用户 submit phone → `requestCode(phone,id)` 成功 | `verification-code` | `authManager.ts:1118-128`，`types.ts:165-170` |
| `identifier` | 用户 submit 企业 ID → `discoverSsoOrg(org)` 成功（空 connections 抛 `ORG_SSO_NOT_FOUND`） | `method-choice`(email='') | `authManager.ts:1107-116`，`client.ts:108-125` |
| `identifier` | 点社交按钮 → `start-browser(social)` | `browser-redirect` | `authManager.ts:1140-159`，`AuthContext.tsx:161-163` |
| `method-choice` | 点 emailCode → `requestCode(email,id)` 成功 | `verification-code` | `authManager.ts:1118-128` |
| `method-choice` | 点 sso 连接 → `start-browser(sso)` | `browser-redirect` | `authManager.ts:1140-159` |
| `verification-code` | `verifyCode(kind,id,code)` → outcome.status=`ok` | `completed` | `authManager.ts:1131-137`，`acceptLoginOutcome` `:1091-1096`，`completeLogin` `:1054-1065` |
| `verification-code` | `verifyCode` → outcome.status=`select_account` | `account-selection` | `authManager.ts:1091-1096`，`types.ts:186-187` |
| `verification-code` | `verifyCode` → outcome.status=`binding_required` | `binding`(codeRequested=false) | `authManager.ts:1091-1096`，`types.ts:189-193` |
| `browser-redirect` | `exchangeAuthorizationCode` → outcome 三分支 | `completed` / `account-selection` / `binding` | `authManager.ts:1186-1203`，`:1091-1096` |
| `account-selection` | `selectAccount(loginTicket,accountId)` → outcome 三分支 | `completed` / `account-selection` / `binding` | `authManager.ts:1191-200`，`client.ts:185-191` |
| `binding`(codeRequested=false) | `requestBindingCode(bindTicket,bindType,contact)` 成功 | `binding`(codeRequested=true) | `authManager.ts:1202-213`，`types.ts:173-179` |
| `binding`(codeRequested=true) | `verifyBinding(...)` → outcome 三分支 | `completed` / `account-selection` / `binding` | `authManager.ts:1215-228`，`client.ts:209-221` |
| 任意 | API 抛错且 `flowCannotRetry` | `error`(recoverTo:identifier) | `authManager.ts:233-247` |
| 任意 | API 抛错且可原地重试 | 保留 `stateBeforeAction` | `authManager.ts:244-246` |
| `completed` | `completeLogin` 写 token / 设 currentUser / `notifyRenderer` | （状态停留 completed；renderer 侧 `setLoginState(null)` + 路由接管） | `authManager.ts:1054-1065`，`AuthContext.tsx:86-101` |

> `account-selection` 与 `binding` 的进入条件摘要在表格中已唯一锚定到 `outcome.status`，不重复。

---

## T3 每状态 UI 快照（桌面 LoginPage.tsx）

`renderContent`（`LoginPage.tsx:520-562`）按 `loginState.step` 分发。所有文案走 i18n `login.*`（`apps/desktop/src/renderer/i18n/locales/<locale>/common.json`，4 语种 `zh-CN/en/ja/ko`）。i18n key 名如下：

| step | 渲染内容（字段/按钮/文案 key） | 可交互动作 | 锚点 |
|---|---|---|---|
| (null 加载中) | Header `login.preparing` / `login.preparingSubtitle` | 无（等 `loadLoginState`） | `LoginPage.tsx:521-523` |
| `identifier`（主） | Header `login.title`/`login.subtitle`；条件 phone/email tab（`login.phone`/`login.email`，仅 `email&&phone` 显示）；输入框（`login.emailPlaceholder`/`login.phonePlaceholder`）；主按钮 `login.continue`（loading 显 `login.working`）；`providers.social[]` 按钮（`login.social.<provider>` + `login.socialButton`，分隔线 `login.or`）；SSO 入口 `login.ssoEntry` | submit email→`discover`；submit phone→`request-code(phone)`；点社交→`start-browser(social)`；点 SSO→`ssoOrgMode` | `LoginPage.tsx:142-240` |
| `identifier`(ssoOrg 子视图) | BackButton `login.back`；Header `login.ssoOrgTitle`/`login.ssoOrgSubtitle`；输入框 `login.ssoOrgPlaceholder`；主按钮 `login.continue`；提示 `login.ssoOrgHint` | submit→`discover-sso-org`；返回→退出 ssoOrgMode | `LoginPage.tsx:104-141` |
| `method-choice` | BackButton；Header `login.chooseMethod`（subtitle 视情况 `login.orgDetected`/`login.ssoOrgDetected`/email）；sso 连接按钮（`login.enterpriseLogin`+`login.enterpriseVia`，icon Building2）；可选 emailCode 按钮（`login.personalLogin`/`login.personalDesc` 或 `login.emailCode`）；`ssoRequired` 时提示 `login.ssoRequired` | 点 sso→`start-browser(sso)`；点 emailCode→`request-code(email)` | `LoginPage.tsx:242-343` |
| `verification-code` | BackButton；Header `login.enterCode`/`login.codeSentTo`；6 位数字输入（`login.codePlaceholder`）；主按钮 `login.signIn`（loading `login.verifying`）；`login.resendCode` | submit→`verify-code`；resend→`request-code` | `LoginPage.tsx:345-402` |
| `browser-redirect` | Header `login.browserWaiting` + `label`；Spinner；取消按钮 `login.cancel` | `cancel-browser` | `LoginPage.tsx:534-553` |
| `account-selection` | BackButton；Header `login.chooseAccount`/`login.chooseAccountSubtitle`；`accounts.map` 按钮（org→Building2 / personal→UserRound，副文案 `login.personalAccount` 或 orgName/email） | 点账号→`select-account(accountId)` | `LoginPage.tsx:404-438` |
| `binding`(codeRequested=false) | BackButton `login.cancel`；Header `login.binding.<bindType>Title`/`...Subtitle`；contact 输入（`login.emailPlaceholder`/`login.phonePlaceholder`）；主按钮 `login.sendCode` | submit→`request-binding-code` | `LoginPage.tsx:440-484` |
| `binding`(codeRequested=true) | Header 同上；显示 contact；6 位码输入（`login.codePlaceholder`）；主按钮 `login.completeSignIn`（loading `login.verifying`） | submit→`verify-binding` | `LoginPage.tsx:485-515` |
| `completed` | **`return null`（不渲染任何面板）** | 无 | `LoginPage.tsx:554` |
| `error` | Header `login.unavailable`/`login.errors.fallback`；主按钮 `login.retry` | `reset` | `LoginPage.tsx:524-532` |

错误文案：`login.errors.<errorCode>` 兜底 `login.errors.fallback`（`LoginPage.tsx:70-75`）。

---

## T4 迁移弹窗与路由门控（一句话级）

- **LegacyMigrationDialog**（`apps/desktop/src/renderer/components/auth/LegacyMigrationDialog.tsx:23-77`）：首登成功后、localDb 打开前，main 检测到老版本 userData 时经 `legacy-migration:state` 推送阶段（注释见 `:11-12`）。phase ∈ `confirm|running|done|failed`，`open = phase∈{confirm,running,failed}`（`:44`）。挂载在 App 顶层，与 Toast 同层，**不在 AuthFlowState 状态机内**——是登录→主界面过渡期的旁路全局弹窗，仅首登 + 老数据时出现。
- **GuestRoute**（`apps/desktop/src/renderer/components/auth/GuestRoute.tsx:5-11`）：`isAuthenticated` → `Navigate to "/"`；否则渲染 `<Outlet/>`（即 `/login` 下的 LoginPage）。登录页是 guest-only。
- **ProtectedRoute**（`ProtectedRoute.tsx:5-11`）：`!isAuthenticated` → `Navigate to "/login"`；否则 `<Outlet/>` → `LocalDbGate` → `MainLayout`。
- **router.tsx**（`:41-58`）：`/login` 挂 `GuestRoute` → `LoginPage`；`/` 挂 `ProtectedRoute` → `LocalDbGate`（等 localDb.ensureReady 按 userId 切库）→ `MainLayout` → `/cc-agent`。
- **与登录页的关系**：登录成功 → `isAuthenticated=true` → `GuestRoute` 把 `/login` 重定向到 `/` → `ProtectedRoute` 放行进主界面。`LoginPage` 对 `completed` 态 `return null`（`:554`），`AuthContext` 收到 `state.user` 后 `setLoginState(null)`（`AuthContext.tsx:92`）——**无 completed 面板，直接由路由切到主界面**。

---

## 用户四问直接答案

**① 手机号验证码登录成功后正常走什么？是否可能出现账号选择？什么条件下？**
- 正常走：`identifier`(phone) → `verification-code` → `verify-code(phone)`。若服务端返回 `outcome.status="ok"` → `completed` → 路由切主界面（**无 completed 面板**）。手机号链路不经 `method-choice`（`submitIdentifier` 对 phone 分支直接 `request-code`，`LoginPage.tsx:88-89`）。
- **account-selection 可能出现**：当且仅当服务端对 `verifyCode(phone,...)` 返回 `status:"select_account"`（该手机号解析到 ≥2 个 membership，`types.ts:186-187`、`client.ts:139-156`）。它是服务端分支，不是 phone 链路的固定步骤，也不是"登录成功后"的必经步骤。
- 同理 `binding` 也可能出现：服务端返回 `status:"binding_required"`（该手机身份尚未绑定到 membership）。

**② 绑定态到底服务于哪些链路？**
- `binding` 是**跨链路的服务端分支**，服务于所有会调 `acceptLoginOutcome` 的链路：phone-code（链路 2）、email-code（链路 1）、Apple/Google/Wechat（链路 3-5，经 `exchangeAuthorizationCode`）、SSO 经邮箱/经企业 ID（链路 6-7）、`select-account` 之后、`verify-binding` 自身循环。只要服务端对任一 outcome 调用返回 `binding_required` 就进 binding（`types.ts:189-193`，`authManager.ts:1091-1096`）。它不专属任何单一入口。

**③ in-app completed 的真实 UI 是什么？**
- **没有面板。** `LoginPage` 对 `step==="completed"` 直接 `return null`（`LoginPage.tsx:554`）。`completeLogin` 在 main 侧写 token、设 `currentUser`、`notifyRenderer()`（`authManager.ts:1054-1065`）；renderer `AuthContext.onAuthStateChange` 收到 `state.user` 后 `setLoginState(null)` 并置 `isAuthenticated=true`（`AuthContext.tsx:88-92`）→ `GuestRoute` 把 `/login` 重定向到 `/` → `ProtectedRoute` 放行 → `LocalDbGate` → `MainLayout` 主界面（`router.tsx:41-58`）。**绝不是回调页的「你可以关闭此页面」**——那句文案属于浏览器 loopback 回调页（见 ④），与 in-app completed 是两个完全不同的界面。

**④ 浏览器回调页（"你可以关闭此页面"）只出现在哪些链路的哪一步？**
- 仅出现在 **social（Apple/Google/Wechat，链路 3-5）与 SSO（链路 6-7）** 链路的 `browser-redirect` 步内、IdP 回跳 loopback `http://127.0.0.1:<port>/auth/callback` 时。
- 该页由 `authManager.ts:324` 的 `openSystemBrowserAuthorization` 内 loopback HTTP server 渲染（`renderAuthLoopbackPage`，`authManager.ts:334`；builder `authLoopbackCallback.ts:100`），文案 key `login.browserCallback.successTitle/successBody/errorTitle/errorBody/returnButton`（`authManager.ts:37-43`）。zh-CN 实文：`successTitle="登录成功"`、`successBody="你可以关闭此页面，回到 {{appName}} 继续。"`、`returnButton="回到 {{appName}}"`（`common.json:2403-2407`）。
- **不出现**在 phone-code（链路 2）与 email-code（链路 1）：这两条不经 `start-browser`，没有 loopback 回调页。phone/email code 的"成功"直接进 in-app completed（见 ③）。
- 注意区分两个同在 social/SSO 链路、但界面不同的表面：① desktop 登录窗内的 `browser-redirect` **等待态**（`LoginPage.tsx:534-553`，文案 `login.browserWaiting="请在浏览器中完成验证"` + 取消按钮）；② 系统浏览器内的 loopback **回调页**（"登录成功/你可以关闭此页面"）。前者在 Cindy 登录窗，后者在外部浏览器，二者都仅 social/SSO 链路有。

---

## 链路总数

- **链路模板 7 条**：邮箱验证码（1）、手机号验证码（2）、Apple（3）、Google（4）、Wechat（5）、企业 SSO 经邮箱域名（6）、企业 SSO 经企业 ID（7）。
- **区域构建 2 个**：cn / global（`AUTH_REGION`，`authManager.ts:70-72`）；每 region 实际开放哪些入口由服务端 `getProviders()` 决定（客户端契约未约束具体字段值）。
- `account-selection` / `binding` 不是独立链路，是 7 条链路都可能命中的服务端 outcome 分支。

## account-selection / binding 触发条件摘要

- **account-selection**：服务端对 `verifyCode` / `exchangeAuthorizationCode` / `selectAccount` / `verifyBinding` / `exchangeNativeSocial`(mobile) 返回 `LoginOutcome.status="select_account"`（携带 `loginTicket` + `accounts[]`，min 1），客户端 `reduceAuthFlow` 进 `account-selection`（`types.ts:186-187`）。语义：该 identifier/credential 解析到 ≥2 个 membership。客户端无法预判，契约只约束 status 三选一。
- **binding**：服务端对同样 5 个 outcome 产生方法返回 `status="binding_required"`（携带 `bindType∈{phone,email}` + `bindTicket`），客户端进 `binding`(codeRequested=false)（`types.ts:189-193`）。语义：该身份尚未绑定到任何 membership，需补绑。`requestBindingCode` 成功后再进 `binding`(codeRequested=true)（`types.ts:173-179`）。`verifyBinding` 自身也可能再返回 `binding_required`（服务端决定·客户端契约未约束具体再分支条件）。

## 链路总数 / 触发条件摘要复核

- 链路模板：7。
- region 构建：2（cn/global），入口开放矩阵服务端决定。
- account-selection / binding 唯一触发源：`LoginOutcome.status`（`select_account` / `binding_required`），由 auth-server 决定，客户端契约 `loginOutcomeSchema`（`types.ts:97-102`）约束为三选一 discriminated union。
