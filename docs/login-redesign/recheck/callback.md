# 回调页 / 浏览器链路与跨端区域归因重盘

## 0. 基线

本次第一步已执行 `git fetch origin main`，成功从 `origin/main` 拉取最新 main。各 HEAD 对比：

| 位置 | SHA | commit time | 结论 |
|---|---|---:|---|
| 当前工作根 `skin/cindy-theme-family` | `1da571331118a075c8bb712e7a633d330102194a` | 2026-07-16 18:28:16 +08:00 | 不是最新 main |
| 本地 `main` / `origin/main` | `643c3dcabd018f3944a7ee501e3993eff4d5476a` | 2026-07-19 14:40:51 +08:00 | **本报告基线** |
| `.xdt-worktrees/main-login-audit` | `6d5033d476d10a924720e8505be79120bd71d010` | 2026-07-19 01:19:08 +08:00 | 旧审计基线，已过期 |

后文所有源码事实均按 `origin/main@643c3dcabd018f3944a7ee501e3993eff4d5476a` 重验。只新增本文件；未删除、未修改 `docs/` 下既有文件。

## 1. 摘要结论

- `apps/desktop/src/main/oauthResultPage.ts` 已在最新 main；旧文档“当前工作根没有该文件、按旧 worktree 盘点”的基线前提已失效。
- 当前“业务页面种类”仍可按旧盘点的 10 个理解：`login-success`、`login-error`、`ghost-success`、`ghost-error`、`claude-error`、`xai-success`、`xai-error`、`generic-success`、`generic-error`、`warning`。没有新增、删减、改名。
- 但源码里只有共享视觉 `variant: success | warning | error`；`pageKind/copyKind/visualKind` 三层模型尚未落地，10 个 pageKind 只在 preview 脚本里显式枚举。
- `generic-oauth` 的 `close()` 裸文本 `done` 路径仍在；PR3 仍必须消除。
- 移动端旧审计的“正式路径只有飞书 OAuth、没有 RN auth flow”已经完全不成立。最新 main 的 mobile 已有手机号 / 邮箱验证码 / 企业 SSO / Native Apple / Google / WeChat / 账号选择 / 绑定的 RN 状态机。
- 回调页三类视觉映射仍成立：成功 4 个、失败 5 个、中性 1 个；但中性仍无生产调用方。

## 2. 回调终态页现状

### 2.1 共享页壳

`oauthResultPage.ts` 当前定义：

- 语言：`zh | en | ja | ko`，浏览器 `Accept-Language` 命中 zh/ja/ko/en，否则 en。
- 视觉 variant：`success | warning | error`。
- CTA：`buildOAuthReturnAction(lang, source, brandName)` 生成 `cindy://focus/<source>`。
- 视觉仍是旧版小卡：`width:min(100%,400px)`、48px badge、Lucide path、内联 CSS；还不是 Figma 680 x 680 三类卡。

证据：`apps/desktop/src/main/oauthResultPage.ts:9-24 @643c3dca`、`apps/desktop/src/main/oauthResultPage.ts:55-63 @643c3dca`、`apps/desktop/src/main/oauthResultPage.ts:130-180 @643c3dca`。

### 2.2 变体全集

| pageKind | 生产调用方 | 当前视觉 variant | 当前触发时机 | deep link source |
|---|---|---|---|---|
| `login-success` | 桌面 auth-server social / SSO loopback | `success` | `/auth/callback` 收到 code 且 state 匹配后立即渲染，早于 token exchange | `desktop-login` |
| `login-error` | 同上 | `error` | 只有实际回调请求进入 listener 且 state/provider/code 错误时渲染；listener 失败 / 打不开浏览器 / 超时 / app 内取消没有浏览器 HTML | `desktop-login` |
| `ghost-success` | Ghost OAuth loopback | `success` | code/state 合法后立即渲染，早于 broker/token exchange | `ghost-oauth` |
| `ghost-error` | Ghost OAuth loopback | `error` | provider error、callback 参数非法、callback 处理异常 | `ghost-oauth` |
| `claude-error` | Claude OAuth callback | `error` | 缺 code、state 错、exchange/scope 失败；成功 302 到 Claude 官方成功页 | `claude-oauth` |
| `xai-success` | xAI/Grok OAuth callback | `success` | token exchange、nonce 校验、凭证写入后渲染 | `xai-oauth` |
| `xai-error` | xAI/Grok OAuth callback | `error` | 缺 code、state 错、exchange/nonce/write/取消 pending 失败 | `xai-oauth` |
| `generic-success` | descriptor-driven provider OAuth | `success` | token exchange、safeStorage 写入后渲染 | `generic-oauth` |
| `generic-error` | descriptor-driven provider OAuth | `error` | 缺 code、state 错、exchange/write 失败；取消 pending 可能走裸 `done` | `generic-oauth` |
| `warning` | preview / test only | `warning` | 生产无调用方 | preview 为 `preview-warning`，测试含 `slack-hook-install` 样例 |

证据：preview 枚举见 `apps/desktop/scripts/preview-oauth-pages.ts:15-26 @643c3dca`；生产调用见 `apps/desktop/src/main/authManager.ts:351-361 @643c3dca`、`apps/desktop/src/main/cindy-brain/ghostOauthFlow.ts:269-294 @643c3dca`、`apps/desktop/src/main/maker-host/claude-oauth-login.ts:205-258 @643c3dca`、`apps/desktop/src/main/maker-host/grok-oauth-login.ts:269-330 @643c3dca`、`apps/desktop/src/main/maker-host/generic-oauth.ts:318-386 @643c3dca`。

### 2.3 `close()` 裸 `done`

`generic-oauth` 仍有遗留路径：如果 `pendingRes` 存在时直接 `close()`，会 `writeHead(200)` 后 `end('done')`，没有品牌卡、没有 CTA。`cancelGenericOAuthLogin()` 会先 abort 再 close，因此这条路径仍可能被用户取消 / 新登录顶替触发。

证据：`apps/desktop/src/main/maker-host/generic-oauth.ts:395-400 @643c3dca`、`apps/desktop/src/main/maker-host/generic-oauth.ts:423-428 @643c3dca`。

## 3. OAuth 调用点现状

| 调用点 | 当前职责 | 与旧盘点是否一致 |
|---|---|---|
| `authLoopbackCallback.ts` | 纯函数 parse `/auth/callback`，封装 `renderAuthLoopbackPage()`；实际 server 在 `authManager.ts` | 基本一致，但旧盘点把超时 / 取消也归入浏览器 `login-error` 页，最新代码不是这样 |
| `authManager.ts` | 桌面 auth-server social / SSO 系统浏览器授权；先渲染 loopback HTML，再 exchange code | 主链路一致；新增/现有企业 ID SSO 入口、server provider config 检查要纳入 |
| `ghostOauthFlow.ts` | Ghost/意识 OAuth；合法 callback 先成功页，后续 broker/token exchange | 一致；仍有提前成功语义 |
| `claude-oauth-login.ts` | Claude 订阅 OAuth；成功 302 官方成功页，本地只渲染失败页 | 一致 |
| `grok-oauth-login.ts` | xAI/Grok OAuth；写凭证后成功页 | 一致 |
| `generic-oauth.ts` | 自定义/目录 provider OAuth；写凭证后成功页；`close()` 遗留 `done` | 一致，遗留问题仍在 |

关键证据：`apps/desktop/src/main/authLoopbackCallback.ts:109-132 @643c3dca`、`apps/desktop/src/main/authManager.ts:324-405 @643c3dca`、`apps/desktop/src/main/authManager.ts:1164-1212 @643c3dca`、`apps/desktop/src/main/cindy-brain/ghostOauthFlow.ts:577-613 @643c3dca`、`apps/desktop/src/main/maker-host/claude-oauth-login.ts:185-242 @643c3dca`、`apps/desktop/src/main/maker-host/grok-oauth-login.ts:250-315 @643c3dca`、`apps/desktop/src/main/maker-host/generic-oauth.ts:298-371 @643c3dca`。

## 4. 跨端区域 / 归因 / 登录方式

### 4.1 区域判定

区域是构建期身份，不是运行时切换：

- Desktop：`VITE_CINDY_AUTH_REGION === 'global' ? 'global' : 'cn'`；默认 cn。
- Mobile：`EXPO_PUBLIC_CINDY_AUTH_REGION === 'global' ? 'global' : 'cn'`；默认 cn。
- Desktop/mobile 都会把 region 传给 `CindyAuthClient`；`getProviders()` 会校验服务端返回的 `providers.region` 必须等于当前客户端 region，不匹配直接 `REGION_MISMATCH`。
- 端点由 region 化 manifest 提供：`config/endpoint.json` 为 cn，`config/endpoint.global.json` 为 global。

证据：`apps/desktop/src/main/authManager.ts:70-76 @643c3dca`、`apps/mobile/src/config/env.ts:30-33 @643c3dca`、`packages/auth-client/src/client.ts:83-95 @643c3dca`、`config/endpoint.json:3 @643c3dca`、`config/endpoint.global.json:3 @643c3dca`。

### 4.2 归因展示文案来源

- Desktop 没有“国内版 · 手机号归因 / 国际版 · 邮箱归因”文案。它只在 global 构建显示一个 `Global` badge；国内版不标注。输入默认 tab 来自服务端 `providers.attribution`。
- Mobile 有“国内版 · 手机号归因 / 国际版 · 邮箱归因”文案，来自 `apps/mobile/src/auth/loginMessages.ts` 本地 zh/en catalog；登录页按 `AUTH_REGION` 选择 `subtitleCn` / `subtitleGlobal`，global 还显示“国际” badge。

证据：`apps/desktop/src/renderer/components/login/LoginPage.tsx:58-68 @643c3dca`、`apps/desktop/src/renderer/components/login/LoginPage.tsx:591-596 @643c3dca`、`apps/mobile/src/auth/loginMessages.ts:6-10 @643c3dca`、`apps/mobile/app/(auth)/login.tsx:537-556 @643c3dca`。

### 4.3 登录方式可用集

登录方式不是纯本地按 region 硬编码，而是“服务端配置 + 客户端能力过滤”：

- 服务端 `/api/auth/providers` 下发 `region`、`attribution`、`email`、`phone`、`social: apple|google|wechat[]`。
- Desktop：按 `email/phone` 决定是否显示 segmented tabs；按 `social` 渲染社交按钮；企业 SSO 入口始终可进入企业 ID discovery；真正 SSO connection 由 discovery 返回。
- Desktop main 会再次校验 social provider 是否在 `providerConfig.social` 内，SSO connection 是否在 `discoveredMethods` 内。
- Mobile：同样使用 provider config；但 `social` 还会经 `isNativeSocialProviderSupported()` 过滤。Apple 仅 iOS；Google 需要 Google client config；WeChat 需要 appId + universal link。
- Mobile 本地/自建 region config 明确禁止 cn 配 Google，global 缺 Google 配置会 fail-fast；EAS 路径仍由环境注入。

证据：`packages/auth-client/src/types.ts:24-31 @643c3dca`、`apps/desktop/src/renderer/components/login/LoginPage.tsx:100-103 @643c3dca`、`apps/desktop/src/renderer/components/login/LoginPage.tsx:195-237 @643c3dca`、`apps/desktop/src/main/authManager.ts:1164-1177 @643c3dca`、`apps/mobile/app/(auth)/login.tsx:86-93 @643c3dca`、`apps/mobile/src/auth/nativeSocial.ts:26-39 @643c3dca`、`apps/mobile/app.config.js:48-56 @643c3dca`。

## 5. 浏览器等待 / 准备 / 错误态

### 5.1 Desktop

- 准备态：`loginState` 为空时显示“正在连接登录服务 / 将为你加载当前区域可用的登录方式”。
- 登录服务错误态：`loginState.step === 'error'` 时显示“暂时无法登录 / 登录失败，请稍后重试”与“重试”按钮。
- 浏览器等待态：`browser-redirect` 显示“请在浏览器中完成验证”、当前 provider label、spinner、取消按钮。
- Renderer 会在 `start-browser` action 发出后立即投影 `browser-redirect`，不等 main loopback server 完成，以便用户能看到取消入口。
- 浏览器终态页：desktop loopback server 返回独立 HTML；点击 CTA 只是 `cindy://focus/<source>` 聚焦，不带 renderer 导航 payload。

证据：`apps/desktop/src/renderer/components/login/LoginPage.tsx:520-550 @643c3dca`、`apps/desktop/src/renderer/contexts/AuthContext.tsx:157-164 @643c3dca`、`apps/desktop/src/renderer/i18n/locales/zh-CN/common.json:2397-2408 @643c3dca`、`apps/desktop/src/main/deepLink.ts:182-188 @643c3dca`。

### 5.2 Mobile

- 准备 / 未拿到 state：首次进入 login screen 后自动 dispatch `reset`；若仍没有 `loginState`，卡片底部显示 busy “处理中…”或“继续”按钮。
- 配置错误：`getMobileConfigIssues()` 有问题时显示“登录配置未完成”面板。
- 登录错误：`auth.authError` 通过本地 zh/en `authErrorText()` 显示。
- 浏览器等待：SSO 进入 `browser-redirect` 后显示“请在浏览器中完成登录 / {label} · 完成后会自动返回 Cindy。”以及取消按钮。
- SSO 使用 `WebBrowser.openAuthSessionAsync(authUrl, MOBILE_REDIRECT_URL)`；成功时通过 `cindycn://auth` 或 `cindy://auth` 回 app，由 RN `completeOAuthCallback()` 解析 code/state 并 exchange。
- Mobile 客户端当前没有本地生成“浏览器终态 HTML”。移动端 Chrome 回调页若要 1:1 落地，不在当前 mobile client 代码里完成，必须确认由 auth-server / 回调中间页承载，或另行设计客户端可控的中转页。

证据：`apps/mobile/app/(auth)/login.tsx:56-65 @643c3dca`、`apps/mobile/app/(auth)/login.tsx:519-612 @643c3dca`、`apps/mobile/src/auth/loginMessages.ts:47-52 @643c3dca`、`apps/mobile/src/auth/AuthContext.tsx:464-491 @643c3dca`、`apps/mobile/src/auth/AuthContext.tsx:512-525 @643c3dca`、`apps/mobile/src/auth/AuthContext.tsx:618-655 @643c3dca`、`apps/mobile/src/config/env.ts:30-33 @643c3dca`。

## 6. 出入点 diff

### 6.1 vs `callback-pages-classification.md`

| 现状事实（file:line + SHA） | 文档说法 | 影响 |
|---|---|---|
| `oauthResultPage.ts` 已在 latest main，且本报告基线是 `origin/main@643c3dcabd018f3944a7ee501e3993eff4d5476a`；文件定义见 `apps/desktop/src/main/oauthResultPage.ts:1-24 @643c3dca`。 | 文档第 5 行说当前工作根没有 `oauthResultPage.ts`，按 `.xdt-worktrees/main-login-audit@6d5033d4` 盘点。 | 基线前提失效；后续 PR 应直接以 main 为准，不再把旧 worktree 当权威。 |
| 源码没有生产级 `pageKind`，只有 `OAuthResultPageVariant = success|warning|error`；10 个 pageKind 只在 preview 脚本枚举，见 `apps/desktop/src/main/oauthResultPage.ts:9-24 @643c3dca`、`apps/desktop/scripts/preview-oauth-pages.ts:15-26 @643c3dca`。 | 文档按“页面种类”把 10 个变体作为现状全集。 | 10 个业务变体仍可用作 PR3 目标模型，但不是当前运行时数据结构；PR3 需要新增 pageKind/copyKind 层。 |
| `login-error` 浏览器页只在 loopback request 到达并被解析成 error 时渲染；listener fail / timeout / cancel / openExternal fail 只 resolve app 内错误，没有浏览器 HTML，见 `apps/desktop/src/main/authManager.ts:341-363 @643c3dca`、`apps/desktop/src/main/authManager.ts:380-403 @643c3dca`。 | 文档第 51 行把监听失败、超时 / 取消也归入 `login-error` 页。 | 触发场景要拆：浏览器终态页矩阵不覆盖“没有回调请求”的错误；app 内错误态由 LoginPage 覆盖。 |
| preview 文案已与文档表不同，例如 zh `login-success` preview 是“你可以返回 Cindy 继续使用。”，见 `apps/desktop/scripts/preview-oauth-pages.ts:53-59 @643c3dca`。生产 login callback 仍用 i18n “你可以关闭此页面，回到 {{appName}} 继续。”，见 `apps/desktop/src/renderer/i18n/locales/zh-CN/common.json:2402-2408 @643c3dca`。 | 文档把 preview / 生产 copy 混在同一“当前文案”表里。 | PR3 预览矩阵不能直接代表生产文案；需以 copyKind builder 为准，再由 preview 调同一 builder。 |
| 生产 source 全集是 `desktop-login`、`ghost-oauth`、`claude-oauth`、`xai-oauth`、`generic-oauth`；preview 会生成 `preview-${kind}`；测试里有 `slack-hook-install` 样例，见 `apps/desktop/src/main/authManager.ts:358 @643c3dca`、`apps/desktop/src/main/cindy-brain/ghostOauthFlow.ts:274 @643c3dca`、`apps/desktop/src/main/maker-host/claude-oauth-login.ts:199 @643c3dca`、`apps/desktop/src/main/maker-host/grok-oauth-login.ts:263 @643c3dca`、`apps/desktop/src/main/maker-host/generic-oauth.ts:312 @643c3dca`、`apps/desktop/src/main/__tests__/oauthResultPage.test.ts:89-96 @643c3dca`。 | 文档第 157 行列生产/future source，且第 59 行只点名 preview warning。 | deep link 验收应分“生产 source”与“preview/test source”；不要把 `slack-hook-install` 当生产现状。 |
| Mobile client 没有本地 OAuth result HTML；SSO 成功靠 `WebBrowser.openAuthSessionAsync` 回 `cindycn://auth` / `cindy://auth` 后在 RN exchange，见 `apps/mobile/src/auth/AuthContext.tsx:618-655 @643c3dca`。 | 文档第 106-138 行把“客户端和移动端共用同一套三类卡片设计 / 移动端 Chrome 回调页”作为落地对象。 | 若移动端 Chrome 终态页也要落地，不能只改 desktop main loopback；需确认 auth-server 或中转页承载。 |

### 6.2 vs `landing-plan.md` D3 / PR3 / #11 / #12 / 规则 26

| 现状事实（file:line + SHA） | 文档说法 | 影响 |
|---|---|---|
| 当前只有 `variant`，没有 `pageKind -> copyKind -> visualKind`；生产调用点直接传 title/body/detail/action，见 `apps/desktop/src/main/oauthResultPage.ts:13-24 @643c3dca`、`apps/desktop/src/main/authManager.ts:351-361 @643c3dca`。 | D3 第 85 行把三层数据模型列为“已定业务约束”。 | 这不是现状，而是 PR3 要新增的核心重构；任务拆分里应显式列“引入 pageKind/copyKind/visualKind adapter”。 |
| HTML escape 已有，但 detail 没有长度截断；`detail` 直接 escape 后渲染，见 `apps/desktop/src/main/oauthResultPage.ts:121-145 @643c3dca`。 | D3 第 85 行说所有动态字段 escape + detail 长度截断是硬门禁。 | PR3 测试清单要保留“超长 detail 截断”；当前只能证明 escape，不能证明截断。 |
| `login-success` 和 `ghost-success` 仍早于 token exchange；xAI/generic 则在写凭证后成功；Claude 成功 302 官方页，见 `apps/desktop/src/main/authManager.ts:349-363 @643c3dca`、`apps/desktop/src/main/cindy-brain/ghostOauthFlow.ts:611-613 @643c3dca`、`apps/desktop/src/main/maker-host/grok-oauth-login.ts:437-442 @643c3dca`、`apps/desktop/src/main/maker-host/generic-oauth.ts:509-518 @643c3dca`、`apps/desktop/src/main/maker-host/claude-oauth-login.ts:238-242 @643c3dca`。 | #11 把“成功页语义”作为整体回调页决策。 | #11 应收窄为 `login-success` / `ghost-success` 两类；xAI/generic 不需要提前成功语义决策，Claude 成功不在 Cindy 页壳。 |
| 语言来源仍是 split：desktop login callback 跟 main/app locale；Ghost/provider/Claude/xAI/generic 跟浏览器 `Accept-Language`；mobile login 只有 zh/en 本地 catalog，见 `apps/desktop/src/main/authManager.ts:346-355 @643c3dca`、`apps/desktop/src/main/cindy-brain/ghostOauthFlow.ts:577-583 @643c3dca`、`apps/desktop/src/main/maker-host/generic-oauth.ts:305-310 @643c3dca`、`apps/mobile/src/auth/loginMessages.ts:1-120 @643c3dca`。 | #12 仅说“页面语言来源”待拍板；PR3 测试写 10 pageKind x 4 locale。 | #12 要分 desktop callback 四语与 mobile 登录 zh/en；若移动端也要四语，需要 PR4 或独立 mobile i18n 补齐 ja/ko。 |
| Mobile auth callback path 是 `cindycn://auth` 或 `cindy://auth`，不是 `cindy://focus/<source>`，见 `apps/mobile/src/config/env.ts:30-33 @643c3dca`、`apps/mobile/src/auth/AuthContext.tsx:512-525 @643c3dca`。 | 规则 26 第 2 问说 deep link 沿用 `cindy://focus/<source>`、无需 allowlist；第 3 问说移动回调页由 PR3 覆盖。 | 该结论只覆盖 desktop loopback CTA；mobile auth deeplink 是另一条 native Linking 链路，PR3/PR4 验收要单列。 |
| Mobile 已有完整 RN auth flow：email discover / phone code / SSO org discovery / native social / account selection / binding，见 `apps/mobile/src/auth/AuthContext.tsx:83-98 @643c3dca`、`apps/mobile/src/auth/AuthContext.tsx:545-655 @643c3dca`、`apps/mobile/src/auth/AuthContext.tsx:657-695 @643c3dca`。 | D4 #28 第 91 行说“移动端正式路径只有飞书 OAuth 单按钮，不存在手机号/邮箱/验证码/Apple/Google/SSO 的 RN 业务状态机”。 | #28 是重大过期错误；PR4 不需要在“皮肤 vs 新建 auth flow”二选一中阻塞，应改为“皮肤化现有 RN flow + 确认可暴露方式集合”。 |
| Mobile login 已有 zh/en 纯数据 catalog 与 `getLoginLanguage()`，见 `apps/mobile/src/auth/loginMessages.ts:1-120 @643c3dca`。 | 第 121 行说 apps/mobile 无 i18n 层、登录文案硬编码中文。 | 仍没有桌面同等四语 i18n，但不是从零建设；PR4 应改为“把 zh/en catalog 扩成设计要求语言 / 参数化”，不是“建立登录域 catalog”。 |
| 飞书登录已整体下线；desktop 清理注释写明 Feishu token 链退役，mobile 冷启动清旧 Feishu token，见 `apps/desktop/src/main/authManager.ts:85-90 @643c3dca`、`apps/mobile/src/auth/AuthContext.tsx:372-378 @643c3dca`。 | 范围表 mobile #7/#9 仍写“等待飞书/浏览器授权”“企业 SSO / 飞书原生入口”。 | 术语要改成“auth-server SSO / native social / 系统浏览器授权”；不要再把飞书作为登录主路径。 |
| 登录方式可用集来自 server `ProviderConfig` + client capability，而不是单纯按 region 写死，见 `packages/auth-client/src/types.ts:24-31 @643c3dca`、`apps/mobile/src/auth/nativeSocial.ts:26-39 @643c3dca`。 | PR4 / 设计讨论隐含 Apple/Google/SSO/手机号/邮箱按区域静态配置。 | 设计落地要支持服务端开关动态隐藏；截图验收应构造 provider fixture，而不是只靠 cn/global 两个 build。 |

### 6.3 vs 设计稿三类卡 / 跨端展示

| 现状事实（file:line + SHA） | 文档说法 | 影响 |
|---|---|---|
| 当前 standalone page 是 400px 小卡 + 48px Lucide badge，见 `apps/desktop/src/main/oauthResultPage.ts:155-168 @643c3dca`。 | 设计稿三类卡是 680 x 680、r36、280 x 280 表情立绘、80px CTA。 | 视觉尚未开始落地；PR3 仍是完整替换，不是微调。 |
| 三类映射仍成立：成功 = login/ghost/xai/generic success；失败 = login/ghost/claude/xai/generic error；中性 = warning。生产没有 neutral 调用，见 `apps/desktop/scripts/preview-oauth-pages.ts:15-26 @643c3dca` 与各生产调用点。 | 设计稿只有成功 / 失败 / 中性三类卡。 | 不需要新增第四类视觉；但 copyKind 必须保留 provider/业务差异，否则三类通用文案会误伤 xAI/generic/Claude。 |
| CTA 当前是本地化 `返回 Cindy` / `回到 Cindy` 等，不是统一大写 `CINDY`；provider 通用 CTA 由 `RETURN_LABEL` 生成，见 `apps/desktop/src/main/oauthResultPage.ts:47-63 @643c3dca`，login CTA 来自 i18n `回到 {{appName}}`，见 `apps/desktop/src/renderer/i18n/locales/zh-CN/common.json:2402-2408 @643c3dca`。 | 设计稿成功/失败按钮为“回到 CINDY”，中性为“返回 CINDY”。 | PR3 需要区分 brand display token（`CINDY`）与产品名（`Cindy`），不要直接复用当前 CTA label。 |
| Desktop 不展示“国内版 · 手机号归因 / 国际版 · 邮箱归因”；mobile 展示该信息且仅由本地 `AUTH_REGION` 决定，见 `apps/desktop/src/renderer/components/login/LoginPage.tsx:591-596 @643c3dca`、`apps/mobile/src/auth/loginMessages.ts:6-10 @643c3dca`、`apps/mobile/app/(auth)/login.tsx:537-556 @643c3dca`。 | 设计 / 计划讨论跨端国区、国际区信息展示。 | 跨端文案来源不一致；如果桌面也要展示归因，需要新增设计与文案，不是套 token 即可。 |
| Mobile Chrome callback 设计帧目前没有对应 client-side renderer；mobile only handles deep link and exchanges code in RN，见 `apps/mobile/src/auth/AuthContext.tsx:464-491 @643c3dca`、`apps/mobile/src/auth/AuthContext.tsx:618-655 @643c3dca`。 | 设计稿包含移动端 Chrome White/Dark 回调页。 | 该帧不能在本仓 mobile RN 内 1:1 还原；需把承载方纳入计划，可能跨到 `cindy-server`。 |

出入点合计：20 条。

## 7. 对 D3 / PR3 的修订建议

1. PR3 仍可保留“10 pageKind x 4 locale x 2 theme”的 desktop callback 矩阵，但要明确这是要新增的 pageKind/copyKind/visualKind 模型，不是现状已有模型。
2. #11 成功页语义收窄到 `login-success` 与 `ghost-success`。低风险方案是改文案为“验证已完成，请返回 Cindy 继续”；延后渲染会牵涉 authManager 与 ghost broker/token exchange 时序。
3. #12 拆成三件事：desktop login callback 跟 app locale；desktop provider/Ghost callback 跟 browser Accept-Language；mobile 登录目前 zh/en。是否统一为 app locale，需要产品拍板后再改。
4. PR3 如果声明覆盖“移动端 Chrome 回调页”，必须新增 server / 中转页承载方案；否则把 PR3 范围限定为 desktop-owned loopback callback page，mobile 浏览器终态另开项。
5. generic `close()` 裸 `done`、detail truncation、providerName/detail/href/htmlLang escape 单测仍是 PR3 硬门禁；其中 escape 已有，truncation 与 `done` 未解决。
6. PR4 的 #28 应重写：mobile 已有 auth-server RN flow。下一步不是“皮肤替换 vs 新建 flow”，而是“对现有状态机按设计皮肤化，并用 provider fixture 覆盖 cn/global 可用方式差异”。
7. 登录方式开关以 auth-server `ProviderConfig` 为事实源，mobile 再叠 native capability 过滤。视觉稿若要求固定按钮集合，需要和服务端配置策略对齐。

## 8. 验证记录

- 已执行：`git fetch origin main`。
- 已检查：`git status --short --branch`、`git worktree list --porcelain`、`git branch -vv --all`、`git show -s`。
- 已用 `git archive origin/main` 导出 `643c3dca` 快照到 `/tmp` 做只读盘查，避免当前脏工作树影响结论。
- 已用 `rg` / `nl -ba` 逐文件确认上述 file:line。
- 未跑测试：本次只新增重盘文档，没有改源码。
