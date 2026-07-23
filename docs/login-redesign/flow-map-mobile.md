# Cindy 登录链路权威转移图 · 移动端（flow-map-mobile）

> **基线**：`origin/main` HEAD = `6835a14fe21cc53b4b9f18fe7a2321648e000b42`（`git fetch origin` 后 `git rev-parse origin/main`）。本文件全部结论以该 SHA 为准，行号锚点取自 `git show origin/main:<path>`。
>
> **范围声明**：本文件只覆盖**移动端**（`apps/mobile`）登录链路 + 浏览器回调边界。共享状态机（`reduceAuthFlow` / `AuthFlowState` / `LoginOutcome` 全表）与**桌面**链路由配对 worker 写在 `docs/login-redesign/flow-map.md`，本文不重复抄其全文，仅在必要处引用 `packages/auth-client/src/types.ts` 的权威定义。移动端状态机的**宿主**是 `apps/mobile/src/auth/AuthContext.tsx`，UI 投影在 `apps/mobile/app/(auth)/login.tsx`。

---

## 0. 移动端登录链路全景（先看这张）

移动端登录是一个由 **`AuthContext.dispatchLoginAction`** 驱动、**`reduceAuthFlow`**（`@cindy/auth-client` 纯函数）做 UI 态投影的状态机。所有密钥/ticket 留在 `AuthContext` 的 ref 与 SecureStore，UI 只读 `auth.loginState`（`AuthFlowState | null`）。

- 状态机宿主：`apps/mobile/src/auth/AuthContext.tsx:528`（`dispatchLoginAction`）、`:464`（`completeOAuthCallback`，深链回调入口）、`:514`（`Linking` 深链监听器）。
- 纯 UI 投影：`apps/mobile/app/(auth)/login.tsx:520`（`stateContent = renderIdentifier() ?? renderMethodChoice() ?? renderVerification() ?? renderAccountSelection() ?? renderBinding()`），`browser-redirect` 步在 `:580` 内联渲染。
- 共享状态机定义：`packages/auth-client/src/types.ts:115`（`AuthFlowState` 联合）、`:134`（`AuthFlowAction`）、`:152`（`reduceAuthFlow`）。
- 区域变量：`apps/mobile/src/config/env.ts:30`（`AUTH_REGION`）、`:32`（`APP_SCHEME = global→'cindy' / cn→'cindycn'`）、`:33`（`MOBILE_REDIRECT_URL = ${APP_SCHEME}://auth`，即 `cindy://auth` 或 `cindycn://auth`）。
- 文案 key：`apps/mobile/src/auth/loginMessages.ts`（`loginText(key)`，`zh`/`en` 两语；`LoginMessageKey` 见 `:106`）；错误码本地化 `authErrorText` 见 `:178`。

---

## T1. 移动链路枚举（区域 × 入口）

### T1.1 区域维度（`EXPO_PUBLIC_CINDY_AUTH_REGION`）

区域是**构建期烘焙**常量（`apps/mobile/src/config/env.ts:30`），运行期不可改。EAS profile 在 `apps/mobile/eas.json:13/31/50/58/68/80` 按变体注入 `cn` / `global`。客户端契约**只约束**下列 region-gated 行为，**不约束**服务端下发的具体 provider 集合（那由 `client.getProviders()` 返回，见下）：

| region | APP_SCHEME / 回调深链 | 副标题 key (`login.tsx:554`) | region 徽标 (`login.tsx:541`) | 微信 env (`env.ts:188-191`) |
|---|---|---|---|---|
| `cn`（缺省） | `cindycn://auth` | `subtitleCn`（国内版 · 手机号归因） | 不显示 | `WECHAT_APP_ID` / `WECHAT_UNIVERSAL_LINK` 通常仅 cn 自建变体注入 |
| `global` | `cindy://auth` | `subtitleGlobal`（国际版 · 邮箱归因） | 显示 `regionGlobal` 徽标 | 一般不注入 |

### T1.2 入口维度（provider 配置驱动 + 客户端门控）

`AuthContext.dispatchLoginAction({type:'reset'})` 在登录页首次进入时（`login.tsx:64`）调用 `client.getProviders()`，返回 `ProviderConfig`（`packages/auth-client/src/types.ts:24`）：

```ts
{ region, attribution: 'phone'|'email', email: bool, phone: bool, social: ('apple'|'google'|'wechat')[] }
```

- **attribution** 决定 identifier 步默认 tab：`login.tsx:69` 把 `identifierKind` 设为 `providers.attribution`（cn 期望 `phone`、global 期望 `email`，但**实际值服务端决定**）。
- **email && phone** 同时为 true 才显示 phone/email 切换 tabs（`login.tsx:93` `showTabs`）；否则只渲染单个输入框。
- **social[]** 经 `isNativeSocialProviderSupported`（`apps/mobile/src/auth/nativeSocial.ts:26`）二次门控后才渲染按钮（`login.tsx:90`）：apple 仅 iOS、google 需 `GOOGLE_WEB_CLIENT_ID`（+ iOS 需 `GOOGLE_IOS_CLIENT_ID`/`GOOGLE_IOS_URL_SCHEME`）、wechat 需 `WECHAT_APP_ID`+`WECHAT_UNIVERSAL_LINK`。
- 因此「某 region 实际露出哪些入口」= 服务端 `getProviders()` 返回 ∩ 客户端平台/构建期凭据门控。**region 与 provider 集合的精确对应关系：服务端决定，客户端契约未约束**（客户端只锁 attribution/副标题/徽标/微信 env）。

### T1.3 每条链路的有序状态序列

状态名取自 `AuthFlowState['step']`（`packages/auth-client/src/types.ts:115`）。`→` 表示客户端 `dispatchLoginAction` 触发 → `reduceAuthFlow` 投影下一态。 `[方括号]` = 该步由服务端 `LoginOutcome` 决定（`types.ts:97`，三态 `ok` / `select_account` / `binding_required`），客户端不可预测。

#### 链路 A · 手机号验证码（cn 主路径，`attribution='phone'`）
```
identifier(phone) →[request-code kind=phone]→ verification-code(phone) →[verify-code kind=phone]→ [outcome]
  ├─ ok                  → completed（登录完成，AuthProvider 挂载业务树）
  ├─ select_account      → account-selection →[select-account]→ [outcome]（同三态递归）
  └─ binding_required    → binding(bindType) →[request-binding-code]→ binding(codeRequested=true) →[verify-binding]→ [outcome]
```
- 手机号**不走 discover**：`login.tsx:148` phone 分支直接 `dispatchLoginAction({type:'request-code', kind:'phone', identifier})`，跳过 method-choice。
- 服务端 `verifyCode` 的三态 outcome 由 `acceptOutcome`（`AuthContext.tsx:245`）分派：`select_account`→存 `pendingLoginTicketRef`+`account-selection`；`binding_required`→存 `pendingBindTicketRef`+`binding`；`ok`→持久化 refreshToken+设 user。

#### 链路 B · 邮箱验证码（global 主路径 / cn 次路径）
```
identifier(email) →[discover email]→ method-choice →[request-code kind=email]→ verification-code(email) →[verify-code kind=email]→ [outcome]（同链路 A 三态分支）
```
- 邮箱**必走 discover**：`login.tsx:147` email 分支 `dispatchLoginAction({type:'discover', email})`，服务端 `client.discover(email)` 返回 `LoginMethod[]`（`types.ts:50`，`email_code` 与/或 `sso`）。即使只返回 `email_code` 一项也进 method-choice（`renderMethodChoice` `login.tsx:258`，无 SSO 时 emailCode 按钮为 primary）。
- 入口差异：cn 若 `providers.email && providers.phone` 同为 true，identifier 步显示 tabs（`login.tsx:93`），用户可切到 email；global 通常只有 email（无 tabs）。

#### 链路 C · Apple（native-social，iOS 专属）
```
identifier →[native-social provider=apple]→ [outcome]（acceptOutcome，同三态分支）
```
- `acquireAppleCredential`（`nativeSocial.ts:50`）：`expo-apple-authentication`，iOS only（`Platform.OS !== 'ios'` → `SOCIAL_PROVIDER_UNAVAILABLE`，`nativeSocial.ts:51-52`）。取 `identityToken`+`rawNonce`+可选 `user.name`，交 `client.exchangeNativeSocial('apple', credential)`（`AuthContext.tsx:613`）。
- 无中间步：凭据本地获取 → 服务端交换 → `acceptOutcome` 直接落地。

#### 链路 D · Google（native-social，iOS + Android）
```
identifier →[native-social provider=google]→ [outcome]（同三态分支）
```
- `acquireGoogleCredential`（`nativeSocial.ts:81`）：`@react-native-google-signin/google-signin`，Android 先 `hasPlayServices`，`result.type!=='success'` → `USER_CANCELLED`（`nativeSocial.ts:102`）。返回 `idToken`，交 `client.exchangeNativeSocial('google', ...)`。
- 需 `GOOGLE_WEB_CLIENT_ID`（+ iOS 需 ios clientId/scheme），否则 `SOCIAL_PROVIDER_NOT_CONFIGURED`（`nativeSocial.ts:84-89`）。

#### 链路 E · 微信（native-social，cn，iOS + Android）
```
identifier →[native-social provider=wechat]→ [outcome]（同三态分支）
```
- `acquireWechatCredential`（`nativeSocial.ts:107`）：`xdt-wechat-login`，需 `WECHAT_APP_ID`+`WECHAT_UNIVERSAL_LINK` + 设备装微信；scope `snsapi_userinfo`，state 用 `createState()`。返回 `code` 交 `client.exchangeNativeSocial('wechat', ...)`。
- 超时：**仅按前台时间计时** 8s（`NATIVE_WECHAT_LOGIN_FOREGROUND_TIMEOUT_MS`，`nativeSocial.ts:14/151`）——打开微信会 background Cindy，墙钟超时会在用户合法授权期间误判，故用 `AppState` 暂停/累计。超时 → `REQUEST_TIMEOUT` 并 `cancelWechatAuthRequest()`。

#### 链路 F · 企业 SSO（从邮箱 discover 命中企业域）
```
identifier(email) →[discover email]→ method-choice（sso methods，可能 ssoRequired=true）→[start-sso connectionId]→ browser-redirect(label) →[系统浏览器 openAuthSessionAsync]→ [深链 cindycn://auth|cindy://auth 回跳]→ completeOAuthCallback → acceptOutcome（同三态分支）
```
- method-choice 中 `ssoMethods` 来自 `discover` 返回的 `method.type==='sso'`（`login.tsx:261`）。若 `ssoRequired=true`，隐藏 emailCode 按钮并提示 `ssoRequired` 文案（`login.tsx:322-324`）；否则 emailCode 作 secondary 与企业登录按钮并列（`login.tsx:309/317`）。
- `start-sso`（`AuthContext.tsx:618`）：生成 PKCE pair + state（`pkce.ts`），把 `PendingOAuth{codeVerifier,deviceId,state,createdAt,label}` 写入 SecureStore `PENDING_OAUTH_KEY`（10 分钟有效期 `PENDING_OAUTH_MAX_AGE_MS`，`AuthContext.tsx:65/950`），`reduceAuthFlow` 投影 `browser-started` → `browser-redirect` 步，再 `WebBrowser.openAuthSessionAsync(authUrl, MOBILE_REDIRECT_URL)`（`AuthContext.tsx:645`）。
- `authUrl` 由 `client.buildAuthorizeUrl({kind:'sso', providerOrConnectionId:connectionId, redirectUri, codeChallenge, state})` 构造（`AuthContext.tsx:638`）。

#### 链路 G · 企业 SSO 入口（按企业 ID，identifier 步内 ssoOrgMode 子视图）
```
identifier →[toggle ssoOrgMode]→ identifier(ssoOrg 子视图) →[discover-sso-org org]→ method-choice（sso methods，ssoOrgDetected 副标题）→[start-sso connectionId]→ browser-redirect →[深链回跳]→ completeOAuthCallback → acceptOutcome
```
- `discover-sso-org`（`AuthContext.tsx:572`）：`client.discoverSsoOrg(org)` 返回 `SsoOrgDiscovery`（`types.ts:41`，`orgName`+`connections[]`），经 `ssoOrgDiscoveryToMethods`（`types.ts:67`）映射成 `LoginMethod[]`（`ssoRequired=false`）进 method-choice。企业存在但未启 SSO（`connections:[]`）→ 服务端 200 + 空数组 → 客户端显式 `ORG_SSO_NOT_FOUND`（`types.ts:45` 注释）。
- method-choice 副标题：无 email 上下文时用 `ssoOrgDetected`（`login.tsx:279`）。

### T1.4 转移条件表（移动端 dispatch → reduceAuthFlow → 下一态）

| 当前 step | 触发（`MobileLoginAction`，`AuthContext.tsx:83`） | reduceAuthFlow 事件（`types.ts:134`） | 下一 step | 转移条件来源 |
|---|---|---|---|---|
| `identifier` | `request-code` kind=phone | `code-requested`（`AuthContext.tsx:588`） | `verification-code` | 客户端直触发（`login.tsx:149`） |
| `identifier` | `discover` email | `discovery-loaded`（`AuthContext.tsx:562`） | `method-choice` | 客户端直触发（`login.tsx:147`） |
| `identifier` | `discover-sso-org` org | `discovery-loaded`（`AuthContext.tsx:577`，`ssoOrgDiscoveryToMethods`） | `method-choice` | 客户端直触发（`login.tsx:98`） |
| `identifier` | `native-social` provider | （无中间态，直 `acceptOutcome`） | `[outcome]` 三态 | 客户端直触发（`login.tsx:230`） |
| `method-choice` | `request-code` kind=email | `code-requested`（`AuthContext.tsx:589`） | `verification-code` | 客户端（`login.tsx:312`） |
| `method-choice` | `start-sso` connectionId+label | `browser-started`（`AuthContext.tsx:633`） | `browser-redirect` | 客户端（`login.tsx:292`） |
| `verification-code` | `verify-code` kind+identifier+code | `outcome`（`AuthContext.tsx:598`→`acceptOutcome`） | `completed`/`account-selection`/`binding` | **服务端 outcome 决定** |
| `browser-redirect` | （深链回调，非 dispatch）`completeOAuthCallback`（`AuthContext.tsx:464`） | `outcome`（`acceptOutcome`） | `completed`/`account-selection`/`binding` | **服务端 outcome 决定** |
| `account-selection` | `select-account` accountId | `outcome`（`AuthContext.tsx:660`→`acceptOutcome`，用 `pendingLoginTicketRef`） | `[outcome]` 三态 | **服务端 outcome 决定** |
| `binding` | `request-binding-code` contact | `binding-code-requested`（`AuthContext.tsx:679`） | `binding(codeRequested=true)` | 客户端（`login.tsx:439`），用 `pendingBindTicketRef` |
| `binding` | `verify-binding` contact+code | `outcome`（`AuthContext.tsx:687`→`acceptOutcome`） | `[outcome]` 三态 | **服务端 outcome 决定** |
| 任意 | `reset` | `providers-loaded`（`AuthContext.tsx:551`） | `identifier` | 客户端（`login.tsx:64/83`）；清 ticket+pendingOAuth |
| 任意（错误） | dispatch 抛错 | `setAuthError(code)`（`AuthContext.tsx:707`） | UI 内联错误（不进 `error` step） | 见 T2 错误段 |

> 注 1：`AuthFlowState` 还定义了 `error` step（`types.ts:128`，带 `recoverTo`），但移动端 `AuthContext` **不使用** `reduceAuthFlow({type:'failed'})`——错误只走 `setAuthError(code)` 在 UI 顶部内联展示（`login.tsx:519/560`），loginState 不切到 `error` step。当前 step 保持不变，用户可重试。
> 注 2：`browser-redirect` → `completeOAuthCallback` 这条转移**不经 `dispatchLoginAction`**，而是经 `Linking` 深链监听器（`AuthContext.tsx:514`）或 `openAuthSessionAsync` 的 inline 返回（`AuthContext.tsx:649-651`）。
> 注 3：标「**服务端 outcome 决定**」的转移——何时返回 `select_account`（多身份）/ `binding_required`（缺手机号/邮箱）/ `ok`——客户端代码看不出，**服务端决定·客户端契约未约束**。

### T1.5 深链回跳如何续接状态机（T1 重点）

回调深链 = `${APP_SCHEME}://auth`（cn `cindycn://auth`、global `cindy://auth`，`env.ts:33`），query 带 `code` + `state`。

1. **PKCE verifier 持久化**：`start-sso` 在打开浏览器前把 `{codeVerifier, deviceId, state, createdAt, label}` 写入 SecureStore（`AuthContext.tsx:622`），即使浏览器触发 App 冷重启也能续接（`AuthContext.tsx:512` 注释）。
2. **iOS inline 完成**：`WebBrowser.openAuthSessionAsync`（`expo-web-browser`）走 ASWebAuthenticationSession，在会话内捕获 `cindy://auth?...` 并 inline 返回 `result.type==='success'` + `result.url` → 直接 `completeOAuthCallback(result.url)`（`AuthContext.tsx:649-651`），router 不导航到 `/auth`。
3. **Android 冷启动 intent**：服务器 302 到自定义 scheme 常以新 intent 冷启 App，expo-router 会撞上无路由的 `/auth` → `+native-intent.ts:22` 把 `/auth` 路径重定向到 `/`（index），`app/index.tsx:11` 再按登录态渲染（未登录→`/login`，已登录→首页）。**实际 PKCE 交换不依赖路由**：由 `AuthContext.tsx:514` 的 `Linking.addEventListener('url')` + `Linking.getInitialURL()` 独立捕获原始 URL → `handleDeepLink` → `completeOAuthCallback`（`+native-intent.ts:7` 注释明确）。
4. **`completeOAuthCallback`**（`AuthContext.tsx:464`）：`matchesOAuthCallbackUrl(url, MOBILE_REDIRECT_URL)` 校验 scheme/host/path → `readPendingOAuth`（验 state + 10min age，超期→`INVALID_AUTH_CODE` 并删 pending，`AuthContext.tsx:950`）→ `parseOAuthCallbackUrl`（`oauthCallback.ts:29`，有 `error` param 抛该 code、缺 code→`INVALID_AUTH_CODE`、缺 state→`STATE_MISMATCH`）→ `callback.state !== pending.state` → `STATE_MISMATCH` → `client.exchangeAuthorizationCode(code, codeVerifier)` → `acceptOutcome`。

---

## T2. 每状态 UI 快照（移动端）

通用外壳（所有 step 共用，`login.tsx:527`）：`SafeAreaView` + `KeyboardAvoidingView` + `ScrollView`，顶部 brandBlock（`product` + 可选 regionBadge + `title` + `subtitle`，`login.tsx:537-557`），中部 `card` 内：可选 error 行（`:560`）→ 可选 configPanel（`:565`）→ `stateContent`（`:578`）→ 可选 browser-redirect 区（`:580`）→ 可选 retry 按钮（`:598`，仅 `!loginState && !configIssues` 时）。`disabled = isBusy || !initialized || configIssues.length>0`（`login.tsx:54`）。

| step | 渲染函数 / 锚点 | 字段 / 按钮 | 文案 key（`loginMessages.ts`） | 交互动作 |
|---|---|---|---|---|
| `identifier`（主） | `renderIdentifier` `login.tsx:86` | phone/email tabs（仅 `showTabs`，`:93`）、identifier 输入框（`:188`）、continue 按钮（`:209`）、social 按钮（`:223`，`isNativeSocialProviderSupported` 过滤）、ssoEntry 按钮（`:242`） | `phone`/`email`/`phonePlaceholder`/`emailPlaceholder`/`continue`/`or`/`apple`/`google`/`wechat`/`ssoEntry` | continue：email→`discover`、phone→`request-code`(phone)（`:143`）；social→`native-social`（`:229`）；ssoEntry→切 `ssoOrgMode=true`（`:248`） |
| `identifier`（ssoOrg 子视图） | `renderIdentifier` ssoOrgMode 分支 `login.tsx:94` | BackButton、ssoOrg 输入框（`:113`）、continue 按钮（`:128`）、helper 文本 | `ssoOrgTitle`/`ssoOrgSubtitle`/`ssoOrgPlaceholder`/`ssoOrgHint`/`continue`/`back` | continue→`discover-sso-org`（`:98`）；back→清错 + `ssoOrgMode=false`（`:104`） |
| `method-choice` | `renderMethodChoice` `login.tsx:258` | BackButton、StepHeader、每个 sso method 按钮（`:283`）、emailCode 按钮（`:304`，仅 `emailAllowed`）、ssoRequired helper（`:322`） | `chooseMethod`/`orgDetected`/`ssoOrgDetected`/`enterpriseLogin`/`personalLogin`/`emailCode`/`ssoRequired` | sso 按钮→`start-sso`(connectionId,label)（`:292`）；emailCode→`request-code`(email)（`:312`）；back→`reset`（`:269`） |
| `verification-code` | `renderVerification` `login.tsx:329` | BackButton、StepHeader、CodeInput（`:348`，6 位数字，`autoComplete='one-time-code'`，`:673`）、signIn 按钮（`:354`）、resend 按钮（`:365`，`density='compact'`） | `enterCode`/`codeSentTo`/`codePlaceholder`/`signIn`/`resendCode`/`back` | signIn→`verify-code`(kind,identifier,code)（`:334`，需 `code.length===6`）；resend→`request-code`(kind,identifier)（`:370`）；back→`reset` |
| `account-selection` | `renderAccountSelection` `login.tsx:384` | BackButton、StepHeader、每个 account 行（`:395`，org 用 `Building2` 图标、个人用 `UserRound`，`:412-415`） | `chooseAccount`/`chooseAccountSubtitle`/`personalAccount`/`back` | account 行→`select-account`(accountId)（`:401`）；back→`reset` |
| `binding`（`codeRequested=false`） | `renderBinding` `login.tsx:433`，`!state.codeRequested` 分支 `:462` | BackButton、StepHeader、bindingContact 输入框（`:464`）、sendCode 按钮（`:481`） | `bindPhoneTitle`/`bindEmailTitle`/`bindPhoneSubtitle`/`bindEmailSubtitle`/`emailPlaceholder`/`phonePlaceholder`/`sendCode`/`back` | sendCode→`request-binding-code`(contact)（`:439`）；back→`reset` |
| `binding`（`codeRequested=true`） | `renderBinding` `:493` | BackButton、StepHeader、contact helper 文本（`:495`）、CodeInput（`:496`）、signIn 按钮（`:502`） | （同上 title/subtitle）+ `codePlaceholder`/`signIn`/`back` | signIn→`verify-binding`(contact,code)（`:446`，需 `code.length===6`）；back→`reset` |
| `browser-redirect` | 内联 `login.tsx:580` | StepHeader、cancel 按钮（`:586`） | `browserTitle`/`browserSubtitle`/`cancel` | cancel→`reset`（`:590`）。**此 step 是 App 内占位屏**，浏览器在系统层开（见 T3） |
| `completed` | （无 UI）`acceptOutcome` `AuthContext.tsx:283` | — | — | `user` 置位 → `isAuthenticated=true` → `NavigationGate`（`_layout.tsx:38`）`router.replace('/')` |

### T2.1 错误内联展示

- 错误**不进 `error` step**：`AuthContext` 捕获异常 → `setAuthError(code)`（`AuthContext.tsx:707`），loginState 保持当前 step。UI 在 card 顶部渲染 `error` 行（`login.tsx:519/560`，`testID='login.error'`），文案经 `authErrorText(code)`（`loginMessages.ts:178`）映射。
- 错误码集合（`loginMessages.ts:122-176`）：`INVALID_CODE`/`INVALID_PARAMS`/`INVALID_AUTH_CODE`/`INVALID_LOGIN_TICKET`/`INVALID_BIND_TICKET`/`STATE_MISMATCH`/`REGION_MISMATCH`/`NETWORK_ERROR`/`REQUEST_TIMEOUT`/`USER_CANCELLED`/`SOCIAL_PROVIDER_NOT_CONFIGURED`/`SOCIAL_PROVIDER_UNAVAILABLE`/`AUTH_REQUEST_FAILED`/`ORG_SSO_NOT_FOUND`。未命中 code → `errorFallback`（`loginMessages.ts:181`）。
- 原始 SDK 取消码归一：`authErrorCode`（`AuthContext.tsx:881`）把 `ERR_REQUEST_CANCELED`/`ERR_WECHAT_CANCELLED`/`SIGN_IN_CANCELLED` 映射为 `USER_CANCELLED`（`:887-894`）。
- ticket 过期专项处理：`INVALID_LOGIN_TICKET` / `INVALID_BIND_TICKET` 时清 ticket + `updateLoginState(null)`（`AuthContext.tsx:699-706`），即退回「无 loginState」态（UI 落到 `:598` retry 按钮）。
- `INVALID_AUTH_CODE`（深链回调失败，如 pendingOAuth 过期）：`completeOAuthCallback` 删 pendingOAuth + `updateLoginState(null)`（`AuthContext.tsx:486-489`），UI 落 retry 按钮。
- 清错：用户按 BackButton / 切 tab / 开 ssoOrgMode / `reset` 均调 `auth.clearAuthError()`（`login.tsx:82/105/169/247`）。

### T2.2 resending 倒计时行为（T2 重点）

**移动端未实现 resend 倒计时 / 冷却**。`renderVerification`（`login.tsx:365-379`）的 resend 是一个 `density='compact'` 的普通按钮，仅受全局 `disabled`（`isBusy || !initialized || configIssues`）门控，**无 `countdown`/`cooldown`/`secondsLeft` 状态、无定时器**（全仓 `apps/mobile` grep `countdown|cooldown|resendAt|secondsLeft` 零命中）。点击即重发 `dispatchLoginAction({type:'request-code', kind, identifier})`（`login.tsx:370`）——与首次发码同一 action；服务端若对重发有频率限制，只会以错误码（如 `REQUEST_TIMEOUT`/`INVALID_CODE`）经 `authErrorText` 内联回显，客户端不做前端节流。**结论：移动端 resend 无冷却 UI，与桌面（如有）不同——此为设计缺口候选，需在设计稿对齐阶段确认是否要补冷却/倒计时。**

---

## T3. 浏览器回调页边界（`oauthResultPage.ts` + 移动端对应）

### T3.1 该回调 HTML 页**只属于桌面**，移动端无对应独立页

`apps/desktop/src/main/oauthResultPage.ts` 的 `renderOAuthResultPage`（`:139`）是一个**纯字符串 HTML 构造器**，渲染在**系统浏览器**里（注释 `:1-5`：「used by Desktop-owned browser flows ... run in the system browser」）。它由桌面侧三处调用：

| 调用方 | 路径 | variant | CTA source |
|---|---|---|---|
| `renderAuthLoopbackPage`（RFC 8252 loopback `/auth/callback`） | `apps/desktop/src/main/authLoopbackCallback.ts:100` | `success` / `error`（无 warning，`:75`） | 由调用方传 |
| Ghost / 模型 provider OAuth | `apps/desktop/src/main/cindy-brain/ghostOauthFlow.ts:271/290` | `success` / `error` | `ghost-oauth`（`:274/293`） |
| Claude OAuth | `apps/desktop/src/main/maker-host/claude-oauth-login.ts:207/225/254` | `success` / `error` | `claude-oauth`（`:199/258`） |
| descriptor 驱动 provider OAuth | `apps/desktop/src/main/maker-host/generic-oauth.ts:320/338/362/382` | `success` / `error` | `generic-oauth`（`:312/365/386`） |

**移动端对应**：移动端登录 SSO（链路 F/G）**不渲染任何独立 HTML 回调页**。它用 `expo-web-browser` 的 `WebBrowser.openAuthSessionAsync(authUrl, MOBILE_REDIRECT_URL)`（`AuthContext.tsx:645`）——这是 **系统认证会话浏览器**（iOS = `ASWebAuthenticationSession`、Android = Chrome Custom Tab），在会话内捕获 `cindy/cindycn://auth?code=&state=` 回跳并 inline 返回 `result.url`（`:649`），再 `completeOAuthCallback`（`:650`）。App 内只有一个 **`browser-redirect` 占位 step**（`login.tsx:580`，文案 `browserTitle`/`browserSubtitle` + cancel 按钮）——这是**进程内 UI 态**，不是浏览器页。因此 `oauthResultPage.ts` 的 HTML / "你可以关闭此页面" 文案在移动端登录链路**永不出现**。

> 移动端不存在 model-provider OAuth（claude/grok/generic provider OAuth 是桌面 `maker-host` 专属），故移动端**没有任何**对 `oauthResultPage` 的引用（`apps/mobile` 全量 grep `oauthResultPage`/`renderOAuthResult`/`DEEP_LINK_URL_PREFIX`/`cindy://focus` 零命中，仅 docs 里 Orca "focus" 无关上下文）。

### T3.2 成功 / 失败 / 中性 三类的真实触发场景

| variant | 类型定义（`oauthResultPage.ts:10`） | 真实触发场景 | 文案 |
|---|---|---|---|
| `success` | renderer 支持 + 生产调用方（`ghostOauthFlow.ts:271`/`generic-oauth.ts:362`） | provider 返回合法 `code`+`state`、`exchangeAuthorizationCode` 成功 | `successTitle`（"授权成功"）+ `successBody`（`ghostOauthFlow.ts:220` "你可以关闭此页面，回到 {brand} 继续。" / `oauthResultPage.ts:85` "{provider} 已连接到 {brand}。你可以返回应用继续。"） + CTA "返回 {brand}" |
| `error` | renderer 支持 + 生产调用方（多处） | 三子类（`claude-oauth-login.ts:207/225/254` / `generic-oauth.ts:320/338/382`）：① **missingCode**（回调缺 `code`）→ `missingCodeBody`；② **invalidState**（`state` mismatch）→ `invalidStateBody`；③ **exchangeFailed**（token 端点交换失败）→ `exchangeFailedBody` | `errorTitle`（"授权失败"/"授权未完成"）+ 对应 body + CTA "返回 {brand}" |
| `warning`（中性） | renderer 类型 + 图标支持（`oauthResultPage.ts:134` RESULT_ICON.warning）+ 测试（`oauthResultPage.test.ts:91`） | **当前生产无调用方**——`apps/desktop/src/main` 全量 grep `variant: 'warning'` 只命中测试与无关 logger/notify tone，**无 OAuth 流实际产出 warning 页**。该 variant 为预留/向前兼容。 | 无生产文案（`getProviderOAuthResultCopy` 与 `OAUTH_PAGE_STRINGS` 均不含 warning 文案，`oauthResultPage.ts:76`/`ghostOauthFlow.ts:29`） |

> **中性（warning）目前是死代码路径**：renderer 会渲染（有图标），但没有任何 OAuth 调用方传入 `variant:'warning'`。若设计稿要求"中性"态（如"已授权但需二次确认"），当前实现缺调用方——**设计缺口候选**。

### T3.3 CTA（`cindy://focus/<source>`）与深链的关系

- CTA 由 `buildOAuthReturnAction(lang, source, brandName)`（`oauthResultPage.ts:55`）构造：`href = ${DEEP_LINK_URL_PREFIX}focus/${encodeURIComponent(source)}`（`:61`）。`DEEP_LINK_URL_PREFIX` = `cindy://`（`apps/desktop/src/shared/deepLinkSchemes.ts:26`，源 `BRAND_IDENTITY.primaryScheme`，2026-07 品牌翻转后主 scheme = `cindy`）。
- `source` 取值：`ghost-oauth`（`ghostOauthFlow.ts:274`）、`claude-oauth`（`claude-oauth-login.ts:199`）、`generic-oauth`（`generic-oauth.ts:312`）。点击 CTA → 系统浏览器打开 `cindy://focus/ghost-oauth` → OS 路由回桌面 App 的深链处理器（**桌面**侧 focus 路由，不在移动端）。
- **与移动端深链的区别**：移动端登录回跳深链是 `cindy://auth`（global）/`cindycn://auth`（cn），path = `auth`，由 `+native-intent.ts:22` 重定向到 `/`，由 `AuthContext` 的 `Linking` 监听器消费（`AuthContext.tsx:514`）。桌面回调页 CTA 是 `cindy://focus/<source>`，path = `focus/...`，是**桌面**侧模型 provider 连接回焦点的深链，与移动端登录 `auth` 深链是**不同的 path/消费方**，不可混用。

### T3.4 "你可以关闭此页面"文案归属（T3 重点）

该文案**只属于浏览器回调 HTML 页**，出现在：
- `ghostOauthFlow.ts:220`（zh `successBody: '你可以关闭此页面，回到 {brand} 继续。'`）、`:230`（en `'You can close this page and return to {brand}.'`）、`:242`（ja）、`:253`（ko）。
- `authLoopbackCallback` 测试夹具 `apps/desktop/src/main/__tests__/authLoopbackCallback.test.ts:42/56`（body `'你可以关闭此页面，回到 Cindy 继续。'`）。

移动端 in-app 状态**绝不出此文案**：移动端唯一的"浏览器"相关 in-app 态是 `browser-redirect` step（`login.tsx:580`），其文案是 `browserTitle`（"请在浏览器中完成登录"）/`browserSubtitle`（"完成后会自动返回 Cindy"）+ cancel 按钮——语义是"等浏览器自动返回"，**不是**"你可以关闭此页面"。两类文案语义互斥：回调页是"动作已完成、可手动关页"，移动 in-app 占位是"动作进行中、等系统自动回跳"。**若在移动 in-app 态出现"你可以关闭此页面"=接线错误**（这正是本图要防的链路接线错误）。

---

## T4. Splash / OTA / StartupBlocked / 配置缺失 与登录链路的先后关系

移动端冷启动到登录页的**严格顺序**（`apps/mobile/app/_layout.tsx:88` `RootLayout`）：

1. **端点清单闸门**（`useStartupEndpointGate`，`apps/mobile/src/config/useStartupEndpointGate.ts:25`，调用 `runStartupEndpointResolve`）：冷启动第一步，拉 OSS `endpoint.json` 回写 env live binding（`env.ts:249` `applyResolvedClientEndpoints`）。
   - `status==='pending'` → `<CenteredScreen variant="splash">`（`_layout.tsx:116`，品牌占位 splash）。
   - `status==='error'`（拉取失败 / JSON 非法 / schema 非法）→ `<StartupBlockedScreen>`（`_layout.tsx:108`，"无法获取服务器配置" + retry，组件 `apps/mobile/src/components/StartupBlockedScreen.tsx`）。**无包内回退、无超时兜底**（`useStartupEndpointGate.ts:2-4`），用户点重试才再跑。
   - `__DEV__` 默认放行（`useStartupEndpointGate.ts:26`），端点初值来自仓内 `config/endpoint.json`（`env.ts:42-58`）。
   - 必须先于 OTA（`useStartupEndpointGate.ts:8` 注释）。
2. **OTA 热更门**（`useStartupOtaGate`，`_layout.tsx:68`，仅自建变体 `IS_OTA_SELFHOST`，`env.ts:283`）：冷启动 JS check→fetch→reload。未就绪 → `<CenteredScreen variant="splash">`（`_layout.tsx:77`）。EAS 包为 no-op。配套：`useBundleUpdatePrompt({auto:true})`（`:71`，整包 runtimeVersion 变化引导）、`useResumeUpdateCheck`（`:74`，前后台切换静默补检）。
3. **AuthProvider 挂载**（`_layout.tsx:80`，在 `RootAfterEndpoints` 内，即端点 + OTA 闸门都 ready 后）：构造期 effect（`AuthContext.tsx:363`）`ensureDeviceId` → 清 legacy token → 读 `REFRESH_TOKEN_KEY` + 缓存 user → `awaitAuthStartupGate(refresh, 20s)`（`AUTH_STARTUP_GATE_TIMEOUT_MS`，`AuthContext.tsx:66/847`）。弱网冷启动先用缓存 user 恢复"已登录"视图，token 后台补刷（`AuthContext.tsx:383-387`）。超时 20s 不阻断初始化（保留降级会话，自愈 effect 补刷，`AuthContext.tsx:411-456`）。完成 → `setInitialized(true)`。
4. **NavigationGate**（`_layout.tsx:25`）：`auth.initialized` 后判定——`!isAuthenticated && !inAuthGroup` → `router.replace('/login')`（`:34`）；`isAuthenticated && inAuthGroup` → `router.replace('/')`（`:38`）。`app/index.tsx:6` 兜底：`!initialized`→splash、`!isAuthenticated`→`<Redirect href="/login">`、否则 HomeScreen。

**配置缺失屏（`configTitle`）**：与上述启动屏**不同层**——它不是启动闸门，而是**登录页内联面板**。`getMobileConfigIssues()`（`env.ts:110`）只校验 `EXPO_PUBLIC_CINDY_AUTH_BASE_URL`（若显式设置却非 http(s) URL → 推一条 issue）。`login.tsx:565` 在 `configIssues.length>0` 时渲染 `configTitle`（"登录配置未完成"）面板 + 各 issue 的 key/message，并把 `disabled` 置 true（`login.tsx:54`）禁用所有交互。**注意**：`EXPO_PUBLIC_CINDY_AUTH_BASE_URL` 缺失（空串）**不算**配置缺失——会回落到 dev 仓内正本或启动闸门回填值（`env.ts:147`）。只有"显式设了但格式非法"才触发 configTitle。

**`splash-preview.tsx`**（`app/splash-preview.tsx:9`）：dev-only 视觉 mock 路由（`MOBILE_VISUAL_MOCK_ENABLED`，`env.ts:102`），生产启动时序不受影响（`:7` 注释）。

**先后关系一句话**：端点闸门（pending→splash / error→StartupBlocked）→ OTA 闸门（self-host，未就绪→splash）→ AuthProvider 初始化（refresh+缓存 user，20s 超时不阻断）→ NavigationGate 路由 `/login` 或 `/`；`configTitle` 是 `/login` 页内联面板，不参与启动时序。登录链路（T1）只在 NavigationGate 路由到 `/login` 后才开始。

---

## 附：回报摘要

- **移动链路总数**：7 条（A 手机号验证码 / B 邮箱验证码 / C Apple / D Google / E 微信 / F 邮箱命中企业 SSO / G 企业 ID SSO 入口）。区域 × 入口的精确 provider 集合**服务端决定·客户端契约未约束**，客户端只锁 attribution/副标题/region 徽标/微信 env。
- **与桌面差异点**：① 移动端**无独立浏览器回调 HTML 页**——SSO 用 `expo-web-browser.openAuthSessionAsync`（系统认证会话）inline 返回 + `Linking` 深链续接，桌面用 `oauthResultPage.ts` HTML + `cindy://focus/<source>` CTA；② 移动端 resend**无倒计时/冷却**（需对齐设计稿）；③ 移动端**不使用** `AuthFlowState.error` step，错误只 `setAuthError` 内联；④ 移动端区域变量 `EXPO_PUBLIC_CINDY_AUTH_REGION` 决定 `APP_SCHEME`（`cindy`/`cindycn`），桌面 scheme 由 `BRAND_IDENTITY.primaryScheme` 统一 `cindy` + 历史 `xdt-maker`。
- **回调页三类真实触发场景**：success（code+state 合法 + 交换成功）/ error（missingCode 缺 code / invalidState state 不匹配 / exchangeFailed token 交换失败，仅桌面 model-provider OAuth + loopback 登录回调）/ warning（**renderer + test 支持，生产无调用方，死代码路径**）。
- **深链 path 区分**：移动登录回跳 `cindy/cindycn://auth`（path `auth`，`AuthContext` 消费）vs 桌面回调 CTA `cindy://focus/<source>`（path `focus/...`，桌面 focus 路由消费）——不同 path、不同消费方，不可混用。
