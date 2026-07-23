# Cindy 桌面端登录链路重盘报告

> 本报告只新增本文件，未删除或修改 `docs/` 下既有文件。源码事实全部以本次拉取后的最新 main 为准；旧审计结论只作为待核对对象。

## 1. 基线核定

- 已执行 `git fetch origin main`，成功从 `origin/main` 拉取最新 main 到 `FETCH_HEAD`。
- 本次选用基线：`643c3dcabd018f3944a7ee501e3993eff4d5476a`（`main` / `origin/main` / `FETCH_HEAD`，2026-07-19 14:40:51 +0800，`feat(desktop): open profile edit dialog on avatar click`）。
- 本次还扫描了未合入 `origin/main` 的本地/远端分支中登录相关路径差异，未发现 `apps/desktop` 登录链路、`packages/auth-client` 或区域脚本有更新于 main 且未合入的分支。

| 对象 | SHA | 时间 | 备注 |
|---|---|---|---|
| 当前工作树 `skin/cindy-theme-family` | `1da571331118a075c8bb712e7a633d330102194a` | 2026-07-16 18:28:16 +0800 | 非 main；当前工作树有主题与登录文档相关脏改，本报告未触碰既有文件 |
| 本地 `main` | `643c3dcabd018f3944a7ee501e3993eff4d5476a` | 2026-07-19 14:40:51 +0800 | 与 `origin/main` 一致 |
| `origin/main` | `643c3dcabd018f3944a7ee501e3993eff4d5476a` | 2026-07-19 14:40:51 +0800 | **本报告源码基线** |
| `.xdt-worktrees/main-login-audit` | `6d5033d476d10a924720e8505be79120bd71d010` | 2026-07-19 01:19:08 +0800 | 旧审计基线，落后于最新 main |

说明：`docs/login-redesign/*` 是当前工作树里的本地文档工件，不在 `origin/main` 的 `docs/login-redesign` 路径中；本报告按任务要求核对这些本地文档，但代码事实只取 `origin/main@643c3dc...`。

## 2. 当前桌面登录链路

### 2.1 状态机与 UI 映射

登录页已经是 auth-server login v2。`/login` 路由经 `GuestRoute` 渲染 `LoginPage`，受保护路由经 `ProtectedRoute -> LocalDbGate` 进入主功能区。证据：`apps/desktop/src/renderer/router.tsx:41-58 @643c3dca`。

| 状态 / 子状态 | 当前 UI 与行为 |
|---|---|
| `AuthFlowState` 总集 | `identifier`、`method-choice`、`verification-code`、`browser-redirect`、`account-selection`、`binding`、`completed`、`error`；纯 reducer 在 `packages/auth-client/src/types.ts:115-132`、`:151-195 @643c3dca`。 |
| 准备 / 未拿到 state | `loginState` 为空时显示 Header 文案“正在连接登录服务 / 将为你加载当前区域可用的登录方式”，没有 spinner；首次加载由 `useLogin()` 调 `loadLoginState()`。见 `apps/desktop/src/renderer/components/login/LoginPage.tsx:520-523`、`apps/desktop/src/renderer/hooks/useLogin.ts:21-33 @643c3dca`。 |
| 身份输入 `identifier` | Header、可选手机号/邮箱 tabs、输入框、继续按钮、动态 social 按钮、企业 SSO 文本入口。见 `LoginPage.tsx:100-103`、`:142-240 @643c3dca`。 |
| 企业 SSO 组织输入 | `identifier` 内本地子视图 `ssoOrgMode`，输入企业 ID / org slug 后 dispatch `discover-sso-org`。见 `LoginPage.tsx:51-53`、`:93-140 @643c3dca`。 |
| 登录方式选择 `method-choice` | 邮箱 discovery 或企业 ID discovery 后进入；SSO connection 按按钮列出，可选个人邮箱验证码；`ssoRequired` 时隐藏个人验证码并显示提示。见 `LoginPage.tsx:242-343 @643c3dca`。 |
| 验证码 `verification-code` | 6 位数字输入、登录按钮、重新发送按钮；当前没有倒计时态。见 `LoginPage.tsx:345-402 @643c3dca`。 |
| 账号选择 `account-selection` | 个人/组织身份行，名称与组织/邮箱 truncate；选择后回 main 走 loginTicket。见 `LoginPage.tsx:404-438`、`apps/desktop/src/main/authManager.ts:1215-1223 @643c3dca`。 |
| 绑定 `binding` | 支持手机号/邮箱绑定；先填 contact 发码，再填验证码完成登录。见 `LoginPage.tsx:440-518`、`authManager.ts:1226-1252 @643c3dca`。 |
| 浏览器等待 `browser-redirect` | Header、24px spinner、取消按钮；renderer 在 `start-browser` 发出后立即投影等待态，不等 main loopback 返回。见 `LoginPage.tsx:534-552`、`apps/desktop/src/renderer/contexts/AuthContext.tsx:157-165 @643c3dca`。 |
| 错误 `error` | 独立 error step 渲染“暂时无法登录 / 登录失败，请稍后重试”和重试按钮；请求错误也可保留上一可用页面并在卡片底部显示错误文案。见 `LoginPage.tsx:524-532`、`:600-606`、`authManager.ts:1253-1271 @643c3dca`。 |
| 完成 `completed` | `completed` 在 renderer 直接 `return null`，随后 auth state push 让 `GuestRoute` 跳走；没有成功页。见 `LoginPage.tsx:554`、`authManager.ts:1054-1088 @643c3dca`。 |

### 2.2 登录方式、区域与归因

| 维度 | 当前事实 |
|---|---|
| 手机号 / 邮箱 / 验证码 | 服务端 provider config 下发 `email`、`phone`、`attribution`；两种都开时显示 tabs，只开一种时隐藏 tabs。手机号直接 request code；邮箱先 discovery，再可走 `email_code`。见 `packages/auth-client/src/types.ts:24-31`、`LoginPage.tsx:58-68`、`:82-90`、`authManager.ts:1118-1152 @643c3dca`。 |
| Apple / Google / WeChat | schema 支持 `apple | google | wechat`，desktop 按 `providers.social` 全量渲染为系统浏览器授权按钮；main 再校验 provider 是否在当前 config 中。见 `packages/auth-client/src/types.ts:6-7`、`LoginPage.tsx:195-218`、`authManager.ts:1164-1170 @643c3dca`。 |
| 企业 SSO | 两条入口：邮箱域名 discovery 返回 SSO methods，或企业 ID discovery 返回 org connections；authorize URL 走 `/api/auth/sso/<connectionId>/authorize`。见 `packages/auth-client/src/client.ts:98-125`、`:250-271`、`authManager.ts:1129-1140`、`:1170-1177 @643c3dca`。 |
| 飞书 | 首登主登录已无飞书 OAuth。`authManager` 注释明确 Feishu login/token 链退役；`xd-feishu` 仅是登录后的 Ghost/意识授权入口。见 `authManager.ts:85-90`、`:685`、`:888`、`:1058 @643c3dca`。 |
| 国区 / 国际区 | Desktop main 用 `VITE_CINDY_AUTH_REGION === 'global' ? 'global' : 'cn'`；构建/dev 脚本均默认 `cn`，支持 `cn | global`。见 `authManager.ts:70-76`、`scripts/shared/client-endpoint-build-env.mjs:13-28`、`:74-88`、`scripts/shared/desktop-dev-region.mjs:1-40 @643c3dca`。 |
| region 校验 | `CindyAuthClient.getProviders()` 会校验服务端返回 `providers.region` 等于当前客户端 region，否则抛 `REGION_MISMATCH`。见 `packages/auth-client/src/client.ts:83-95 @643c3dca`。 |
| 归因展示 | Desktop 没有“国内版 · 手机号归因 / 国际版 · 邮箱归因”文案；`attribution` 只决定默认输入 tab。唯一可见区域标识是 global 构建才显示 `Global` pill，国内版不显示。见 `LoginPage.tsx:58-68`、`:591-596 @643c3dca`。 |

### 2.3 迁移链路

- `MigrationProgressView` 已不在最新 main；`apps/desktop/src/renderer/components/login` 只剩 `LoginPage.tsx` 与测试。
- 旧库迁移仍存在，但形态是全局 `LegacyMigrationDialog`：`confirm | running | failed | done`，复用 `ConfirmDialog`，失败只给“继续”，不再有进度页或跳过确认弹窗。见 `apps/desktop/src/renderer/components/auth/LegacyMigrationDialog.tsx:6-21`、`:47-76 @643c3dca`。
- 迁移在首次登录成功、db 打开前触发；老目录存在才弹确认，复制 db / media / browser profile；失败不阻塞登录，下次重试。见 `apps/desktop/src/main/legacyUserDataMigration.ts:1-24`、`:282-395 @643c3dca`。
- 迁移只在 `CURRENT_CINDY_REGION === 'cn'` 执行，global 构建直接跳过，避免跨区域串台。见 `legacyUserDataMigration.ts:493-501 @643c3dca`。

### 2.4 浏览器回调页与授权窗口

- 首登 social / SSO 不再创建 Feishu OAuth `BrowserWindow`；desktop 用系统浏览器 + 127.0.0.1 loopback，5 分钟超时。见 `apps/desktop/src/main/authManager.ts:319-406 @643c3dca`。
- loopback HTML 走 `renderAuthLoopbackPage()`，其本质转调共享 `renderOAuthResultPage()`。见 `apps/desktop/src/main/authLoopbackCallback.ts:73-102 @643c3dca`。
- 共享页壳当前仍是 400px 小卡、48px Lucide badge、内联 light/dark CSS，不是 Figma 680x680 三类卡。见 `apps/desktop/src/main/oauthResultPage.ts:138-180 @643c3dca`。
- Ghost OAuth 已用共享页壳；Claude / xAI / generic provider OAuth 也在生产调用 `renderOAuthResultPage()`。见 `apps/desktop/src/main/cindy-brain/ghostOauthFlow.ts:264-294`、`apps/desktop/src/main/maker-host/claude-oauth-login.ts:205-258`、`apps/desktop/src/main/maker-host/grok-oauth-login.ts:269-324`、`apps/desktop/src/main/maker-host/generic-oauth.ts:318-386 @643c3dca`。

### 2.5 BrowserWindow、i18n 与主题 token

- 主窗口仍是 `windowStateKeeper` 默认 1280x800，`minWidth: 800`、`minHeight: 600`、title 为 `BRAND_NAME`、macOS hidden titlebar + traffic light、非 macOS frameless，创建后 `applyPageZoomLevel(mainWindow, 0)`。见 `apps/desktop/src/main/bootstrap-electron.ts:1648-1714`、`:1720 @643c3dca`。
- 副窗口复刻 1280x800 fallback、min 800x600 和 chrome 策略。见 `apps/desktop/src/main/secondary-windows.ts:82-121 @643c3dca`。
- Renderer i18n 同步加载 `en / zh-CN / ja / ko`，fallback 为 `en`；main 侧复用同一批 locale JSON 并提供 `t()`。见 `apps/desktop/src/renderer/i18n/index.ts:16-52`、`apps/desktop/src/main/i18n.ts:24-34`、`:100-103 @643c3dca`。
- login 与 legacy migration 文案已有四语 key；中文登录 key 见 `apps/desktop/src/renderer/i18n/locales/zh-CN/common.json:2348-2439 @643c3dca`。
- 现有登录 UI 走 `--login-*`、`--surface-*`、`--text-*`、`--focus-ring-soft` 等 app theme token；不是固定红底白卡品牌皮肤。见 `apps/desktop/src/renderer/themes/colors.ts:11-183`、`:426-462`、`:1565-1573 @643c3dca`。

## 3. 旧审计 24 项复核

统计口径：24 项内标 `仍准确 / 已变化 / 已消失`；旧审计遗漏但本次必须登记的另列 `新增 surface`。24 项内统计为：仍准确 15、已变化 6、已消失 3。新增 surface 4。

| # | 旧审计 surface | 复核结果 | 本次结论 |
|---:|---|---|---|
| 1 | 主窗口/副窗口 BrowserWindow chrome 与缩放 | 仍准确 | 默认 1280x800、min 800x600、mac hidden titlebar / 非 mac frameless 仍成立；line refs 更新到 `bootstrap-electron.ts:1648-1714`、`secondary-windows.ts:82-121 @643c3dca`。 |
| 2 | 当前根工作树旧飞书登录页 `LoginPage` | 已消失 | 最新 main 的 `LoginPage` 是 auth-server v2；Feishu login 已整体下线。见 `LoginPage.tsx:43-44`、`authManager.ts:85-90 @643c3dca`。 |
| 3 | 当前根工作树迁移进度页 | 已消失 | `MigrationProgressView` 不在 latest main；迁移 running 改由 `LegacyMigrationDialog` 的 ConfirmDialog loading 表达。见 `LegacyMigrationDialog.tsx:14-18`、`:47-76 @643c3dca`。 |
| 4 | 当前根工作树迁移失败/跳过确认弹窗 | 已变化 | 旧进度页内 failed/skip 双弹窗消失；当前只有 legacy migration failed + “继续”，没有 skip 确认。见 `LegacyMigrationDialog.tsx:44-76 @643c3dca`。 |
| 5 | login v2 登录卡片外壳 | 仍准确 | 单卡片居中、440px、min-h 560、logo 216px 仍是 main 现状。见 `LoginPage.tsx:564-610 @643c3dca`。 |
| 6 | login v2 准备/未拿到状态 | 仍准确 | 仍只渲染 Header 文案，没有 loading 图标。见 `LoginPage.tsx:520-523 @643c3dca`。 |
| 7 | login v2 身份输入态 | 仍准确 | tabs / input / social / SSO 文本入口仍存在。见 `LoginPage.tsx:142-240 @643c3dca`。 |
| 8 | login v2 企业 SSO 组织输入态 | 仍准确 | 仍是 identifier 内 `ssoOrgMode` 子视图。见 `LoginPage.tsx:104-140 @643c3dca`。 |
| 9 | login v2 方法选择态 | 仍准确 | SSO rows + 可选个人邮箱验证码仍存在。见 `LoginPage.tsx:242-343 @643c3dca`。 |
| 10 | login v2 验证码态 | 仍准确 | 6 位输入 + 登录 + 重新发送仍存在；无倒计时。见 `LoginPage.tsx:345-402 @643c3dca`。 |
| 11 | login v2 账号选择态 | 仍准确 | 账号行和 truncate 行为仍存在。见 `LoginPage.tsx:404-438 @643c3dca`。 |
| 12 | login v2 绑定态 | 仍准确 | contact / code 两子态仍存在。见 `LoginPage.tsx:440-518 @643c3dca`。 |
| 13 | login v2 系统浏览器授权等待态 | 仍准确 | Header + spinner + cancel；renderer 立即投影等待态。见 `LoginPage.tsx:534-552`、`AuthContext.tsx:157-165 @643c3dca`。 |
| 14 | login v2 错误/完成态 | 仍准确 | error step + retry；completed `return null`。见 `LoginPage.tsx:524-554 @643c3dca`。 |
| 15 | Auth/DB 路由门控空白态 | 已变化 | `MigrationGate` 已消失；只剩 `GuestRoute`、`ProtectedRoute`、`LocalDbGate` 的 null gate。见 `GuestRoute.tsx:5-10`、`ProtectedRoute.tsx:5-10`、`LocalDbGate.tsx:35-118 @643c3dca`。 |
| 16 | login v2 旧库迁移弹窗 | 仍准确 | 仍复用 ConfirmDialog，但现在已在 main；同时补充 cn-only 条件。见 `LegacyMigrationDialog.tsx:47-76`、`legacyUserDataMigration.ts:493-501 @643c3dca`。 |
| 17 | 当前根工作树飞书 OAuth BrowserWindow | 已消失 | `authManager` 不再创建 OAuth BrowserWindow；Feishu login 退役，首登 social/SSO 全走 system browser loopback。见 `authManager.ts:85-90`、`:319-406 @643c3dca`。 |
| 18 | login v2 系统浏览器 OAuth 回调/终态页 | 已变化 | 旧事实基本成立，但共享页壳已进 latest main 且扩展到 Ghost / Claude / xAI / generic provider 调用。见 `oauthResultPage.ts:138-180`、`ghostOauthFlow.ts:264-294`、`claude-oauth-login.ts:205-258`、`grok-oauth-login.ts:269-324`、`generic-oauth.ts:318-386 @643c3dca`。 |
| 19 | 当前根工作树 Ghost OAuth 旧终态页 | 已变化 | Ghost 旧 `oauthPageShell` 已消失，改用共享 `renderOAuthResultPage()`。见 `ghostOauthFlow.ts:264-294 @643c3dca`。 |
| 20 | Providers 设置区授权行 | 仍准确 | Anthropic / OpenAI / xAI / generic OAuth rows 仍是 Settings 内 row。见 `ProvidersSection.tsx:491-816 @643c3dca`。 |
| 21 | 自定义供应商 OAuth 配置弹窗 | 仍准确 | 600px、max-h 88vh、body scroll、OAuth authMode 字段仍存在。见 `CustomProviderDialog.tsx:667-771 @643c3dca`。 |
| 22 | XD 网关 Key 授权弹窗 | 已变化 | `XdGatewayKeyDialog.tsx` 已不在 settings 组件树；XD Gateway 改为 Providers row，服务端自动下发/重试/轮换/断开，没有手填弹窗。见 `ProvidersSection.tsx:818-992 @643c3dca`。 |
| 23 | Slack Hook / Computer Use 等设置里的授权入口 | 仍准确 | Hook row 和 Computer Use open-for-login 仍存在，属于 Settings 内嵌 surface。见 `HookConnectionsSection.tsx:303-365`、`ComputerUseSection.tsx:1002-1012`、`:1209-1229 @643c3dca`。 |
| 24 | 内置 Ghost 设置页授权入口 | 已变化 | 旧 `cindy-slack` 退役，`cindy-feishu` 改名/迁移为 `xd-feishu`；当前还有 GitHub/GitLab/Google/Atlassian/Mivo/Pages 等自绘 settings。见 `cindy-brain/index.ts:235-245`、`builtin-ghosts/xd-feishu/settings.html:5-14 @643c3dca`。 |

新增 surface / 新增事实：

| # | 新增项 | 说明 |
|---:|---|---|
| N1 | XD Gateway 自动凭据行 | 旧审计登记的是手填 Key 弹窗；当前真实 surface 是 `ProvidersSection` 内自动下发、失败重试、轮换、断开与 masked key chip。见 `ProvidersSection.tsx:828-992 @643c3dca`。 |
| N2 | 共享 OAuth result 覆盖 Provider OAuth | 旧审计主要登记 login / Ghost；当前 Claude 失败页、xAI 成功/失败页、generic provider 成功/失败页都复用同一页壳。见 `oauthResultPage.ts:138-180`、`claude-oauth-login.ts:205-258`、`grok-oauth-login.ts:269-324`、`generic-oauth.ts:318-386 @643c3dca`。 |
| N3 | GitHub / GitLab Ghost PAT 设置页 | 当前内置 Ghost 包含 `cindy-github` / `cindy-gitlab` settings，自绘 PAT/账号行，不在旧 #24 的 Slack/Atlassian/Google/Feishu 列表中。见 `builtin-ghosts/cindy-github/settings.html:5-10 @643c3dca`。 |
| N4 | Feishu Ghost broker OAuth 设置页 | 首登飞书下线，但 `xd-feishu` 作为登录后意识授权入口存在，走 broker OAuth，不能误删或归入首登。见 `builtin-ghosts/xd-feishu/settings.html:5-14`、`:77-80 @643c3dca`。 |

## 4. 出入点 diff

格式：`现状事实（file:line + SHA）| 文档说法 | 影响`。本节共 34 条出入点。

### 4.1 vs `current-adaptation-audit-desktop.md`

| # | 出入点 |
|---:|---|
| A1 | 现状事实：最新 main 已只有 auth-server v2 LoginPage，旧 Feishu 首登页不在当前根工作树；`LoginPage.tsx:43-44`、`authManager.ts:85-90 @643c3dca`。 \| 文档说法：旧审计把“当前根工作树登录页 LoginPage”列为旧飞书页，见 `current-adaptation-audit-desktop.md:55-90`。 \| 影响：旧审计的“根工作树旧 UI + worktree v2 UI”双基线前提失效；PR5 不应再规划退役桌面旧飞书 LoginPage。 |
| A2 | 现状事实：`MigrationProgressView` 已消失；迁移 running/failed 由 `LegacyMigrationDialog` 承载；`LegacyMigrationDialog.tsx:6-21`、`:47-76 @643c3dca`。 \| 文档说法：旧审计 #3/#4 仍描述进度页、进度条、失败/跳过确认弹窗，见 `current-adaptation-audit-desktop.md:91-143`。 \| 影响：`landing-plan` #3/#4 应从“迁移进度页/跳过弹窗”改为“LegacyMigrationDialog confirm/running/failed”。 |
| A3 | 现状事实：旧库迁移只在 cn 构建执行，global 构建跳过；`legacyUserDataMigration.ts:493-501 @643c3dca`。 \| 文档说法：旧审计 #16 只说旧库迁移弹窗，未登记区域条件，见 `current-adaptation-audit-desktop.md:313-324`。 \| 影响：迁移验收矩阵需区分 cn/global；global 不应期待迁移弹窗。 |
| A4 | 现状事实：`MigrationGate` 已不存在，路由只有 `GuestRoute` / `ProtectedRoute` / `LocalDbGate` null gate；`router.tsx:41-58`、`LocalDbGate.tsx:9-18`、`:108-118 @643c3dca`。 \| 文档说法：旧审计 #15 同时引用当前根 `MigrationGate` 与 worktree `LocalDbGate`，见 `current-adaptation-audit-desktop.md:298-311`。 \| 影响：#15 应改为 LocalDbGate 专项，不再跟旧 chat-data migration gate 绑定。 |
| A5 | 现状事实：首登 social/SSO 不创建 Feishu OAuth BrowserWindow；`authManager` 只有系统浏览器 loopback 授权；`authManager.ts:319-406`、`:1164-1212 @643c3dca`。 \| 文档说法：旧审计 #17 记录飞书 OAuth BrowserWindow 600x740，见 `current-adaptation-audit-desktop.md:328-339`。 \| 影响：#17 可从桌面核销表删除或标历史；PR5 不需要处理这条旧窗口。 |
| A6 | 现状事实：Ghost OAuth 成功/失败页已改用 `renderOAuthResultPage()`；`ghostOauthFlow.ts:264-294 @643c3dca`。 \| 文档说法：旧审计 #19 记录 Ghost 仍有旧 `oauthPageShell`，见 `current-adaptation-audit-desktop.md:368-378`。 \| 影响：PR3 不再是“先统一 Ghost 旧 shell”，而是“把已共享的小卡页壳替换为 Figma 三类卡”。 |
| A7 | 现状事实：共享 OAuth result 已覆盖 login、Ghost、Claude、xAI、generic provider；`oauthResultPage.ts:138-180`、`claude-oauth-login.ts:205-258`、`grok-oauth-login.ts:269-324`、`generic-oauth.ts:318-386 @643c3dca`。 \| 文档说法：旧审计 #18/#19 只把共享页壳放在 login-v2 worktree 与 Ghost 替换方向。 \| 影响：PR3 影响面比旧审计大，必须覆盖 provider OAuth 回归测试。 |
| A8 | 现状事实：XD Gateway Key 不再有手填弹窗，改为 row 内自动下发/失败重试/轮换/断开；`ProvidersSection.tsx:818-992 @643c3dca`。 \| 文档说法：旧审计 #22 记录 `XdGatewayKeyDialog.tsx` 480px 弹窗，见 `current-adaptation-audit-desktop.md:440-453`。 \| 影响：#22 处置应改成“Settings 内 XD Gateway row 保留/后续 issue”，不是弹窗适配。 |
| A9 | 现状事实：`cindy-slack` Ghost 已退役，`cindy-feishu` 映射到 `xd-feishu`，当前 builtin ghosts 列表已有 GitHub/GitLab/Google/Atlassian/Feishu/Mivo/Pages；`cindy-brain/index.ts:235-245`、`builtin-ghosts/xd-feishu/settings.html:5-14 @643c3dca`。 \| 文档说法：旧审计 #24 仍点名 `cindy-slack` / `cindy-feishu`，见 `current-adaptation-audit-desktop.md:480-505`。 \| 影响：设置页授权入口清单需要重列，避免误把退役 Slack Ghost 纳入 UI 替换。 |
| A10 | 现状事实：登录方式可用集来自服务端 `ProviderConfig`，包括 `email/phone/social/attribution`；`packages/auth-client/src/types.ts:24-31 @643c3dca`。 \| 文档说法：旧审计多处按视觉状态描述，没有明确“服务端动态开关”是 desktop 现状。 \| 影响：设计验收 fixture 不能只按 cn/global 静态推断，必须构造 provider config。 |
| A11 | 现状事实：Desktop 没有“归因”文案，只显示 global build 的 `Global` pill；`LoginPage.tsx:591-596 @643c3dca`。 \| 文档说法：旧审计未区分 desktop 的归因展示缺失；后续计划文档讨论跨端区域归因。 \| 影响：如果新设计要桌面展示“国内/国际 + 归因”，需要新增文案/设计，不是复用现有 key。 |
| A12 | 现状事实：latest main 的 `/login` 路由直接使用 v2 `LoginPage`，不存在“根工作树旧登录页 + worktree v2 登录页”双实现基线；`router.tsx:41-48`、`LoginPage.tsx:43-44 @643c3dca`。 \| 文档说法：旧审计第 5 行明确混用根工作树和 `.xdt-worktrees/main-login-audit`。 \| 影响：后续落地计划不能再把旧审计当代码地图，必须以本报告基线或更新后的审计为准。 |

### 4.2 vs 设计稿文档（`DESIGN-login.md` §3/§4 与 `figma-component-spec.md`）

| # | 出入点 |
|---:|---|
| D1 | 现状事实：当前是 440px centered card，logo 在卡片内，背景为 theme surface；`LoginPage.tsx:564-610`、`colors.ts:426-462 @643c3dca`。 \| 文档说法：桌面设计为 1819x2098 红底 stage，含 Cindy 立绘、SLOGAN、WORD_MARK、登录组五要素，见 `DESIGN-login.md:26-42`、`figma-component-spec.md:322-339`。 \| 影响：桌面 PR1 仍是完整布局重写，不是 token 微调。 |
| D2 | 现状事实：当前没有 Cindy 立绘、签名、白色 CINDY 字标资源；仅 `useBrandLogo()` 216px wordmark。`LoginPage.tsx:584-590 @643c3dca`。 \| 文档说法：设计稿要求 `CINDY_Client`、`SLOGAN`、`WORD_MARK` 的精确坐标/尺寸，见 `DESIGN-login.md:32-35`、`figma-component-spec.md:311-318`。 \| 影响：PR0b-desktop 资源 manifest 仍是硬前置。 |
| D3 | 现状事实：当前登录面板为 `min-h-[560px] w-[440px] rounded-xl px-10 py-8`；`LoginPage.tsx:577-582 @643c3dca`。 \| 文档说法：Figma 登录面板为 `680 x 440`、圆角 36、登录组常规 `680 x 560`，见 `DESIGN-login.md:35-36`、`figma-component-spec.md:331-332`。 \| 影响：尺寸 token/布局常量需要全部替换。 |
| D4 | 现状事实：输入框和主按钮均为 44px 高、15px 字号、rounded-full；`LoginPage.tsx:13-31 @643c3dca`。 \| 文档说法：`input_2` / `log_in_button` 都是 540x80、radius 40、HarmonyOS 24px，见 `figma-component-spec.md:139-200`。 \| 影响：控件组件需要重建，不能复用当前 pill 直接过像素验收。 |
| D5 | 现状事实：当前社交入口是全宽 secondary button 列表，provider 数量由服务端动态返回；`LoginPage.tsx:195-218 @643c3dca`。 \| 文档说法：第三方入口为 80x80 圆钮，国区 Apple+SSO，国际区 Apple+Google+SSO，见 `figma-component-spec.md:231-249`。 \| 影响：需要决定动态 provider 与固定设计按钮集合如何对齐；WeChat schema 真实存在但页面稿未用。 |
| D6 | 现状事实：Desktop global 只在卡片 logo 下显示一个小 `Global` pill；`LoginPage.tsx:591-596 @643c3dca`。 \| 文档说法：Global pill 在标题组内 `x=425 y=4 w=70 h=30`，见 `DESIGN-login.md:86-94`。 \| 影响：国际区标题结构需重做，现有 pill 位置不可复用。 |
| D7 | 现状事实：准备态没有 loading 图标；`LoginPage.tsx:520-523 @643c3dca`。 \| 文档说法：准备态有 64x64 loading，见 `DESIGN-login.md:145-152`、`figma-component-spec.md:351-353`。 \| 影响：PR2 准备态需补 panel loading；动画需遵守 compositor-only。 |
| D8 | 现状事实：浏览器等待态 spinner 是 24px，位置由 flex 内容流决定；`LoginPage.tsx:534-543 @643c3dca`。 \| 文档说法：浏览器等待 loading 为 64x64，固定 `x=308 y=158`，取消按钮 540x80，见 `DESIGN-login.md:136-144`。 \| 影响：browser-redirect 需要按面板坐标复刻。 |
| D9 | 现状事实：验证码页没有倒计时，不区分“42 秒后可重新发送”和 underline `重新发送` 状态；`LoginPage.tsx:385-398 @643c3dca`。 \| 文档说法：验证码页含 Text_link 倒计时/重发两态，见 `DESIGN-login.md:116-134`、`figma-component-spec.md:263-273`。 \| 影响：若坚持 1:1，需要补倒计时状态机或把该设计状态标为非当前业务。 |
| D10 | 现状事实：method-choice 可渲染多个 SSO connection，并且无邮箱上下文的企业 ID 路径也进入 method-choice；`LoginPage.tsx:244-292`、`:253-262 @643c3dca`。 \| 文档说法：Figma 只有一组企业/个人两行，示例邮箱属于企业，见 `DESIGN-login.md:188-197`、`figma-component-spec.md:287-303`。 \| 影响：多个 SSO connection、无邮箱 subtitle 属于设计稿未画状态，应纳入 #29。 |
| D11 | 现状事实：account-selection、binding、企业 ID 输入、completed 没有 Figma 桌面帧；这些状态在代码中真实存在。见 `LoginPage.tsx:104-140`、`:404-518`、`:554 @643c3dca`。 \| 文档说法：DESIGN §3/§4 只覆盖手机号/邮箱、验证码、方式选择、浏览器等待、准备、错误。 \| 影响：修订 #29 桌面无稿清单应继续保留这些状态；不要遗漏。 |
| D12 | 现状事实：当前 callback page 是 400px 小卡、48px badge、Inter/system font；`oauthResultPage.ts:155-168 @643c3dca`。 \| 文档说法：Browser 回调卡为 680x680、r36、280x280 表情图、540x80 CTA，见 `DESIGN-login.md:256-286`、`figma-component-spec.md:390-425`。 \| 影响：PR3 仍是完整替换；当前共享化不等于视觉已落地。 |

### 4.3 vs `landing-plan.md` §1.1 / D1 / PR1-PR2 / PR5

| # | 出入点 |
|---:|---|
| L1 | 现状事实：桌面旧飞书 LoginPage 已不在 latest main；`LoginPage.tsx:43-44`、`authManager.ts:85-90 @643c3dca`。 \| 文档说法：§1.1 #2 写“旧飞书登录页 LoginPage 替换@PR1 + 退役@PR5”，见 `landing-plan.md:29-31`。 \| 影响：#2 应改为“已消失/历史”，PR5 删除旧飞书桌面首登页面的工作项取消。 |
| L2 | 现状事实：迁移进度页与跳过弹窗消失；现存 `LegacyMigrationDialog`。`LegacyMigrationDialog.tsx:6-21`、`:47-76 @643c3dca`。 \| 文档说法：§1.1 #3/#4 写“迁移进度页 / 迁移失败/跳过弹窗 拍板 #29”，见 `landing-plan.md:31-32`。 \| 影响：#29 桌面项应改名为“LegacyMigrationDialog confirm/running/failed”，移除旧 progress/skip。 |
| L3 | 现状事实：飞书 OAuth BrowserWindow 消失，首登 social/SSO 走系统浏览器 loopback；`authManager.ts:319-406 @643c3dca`。 \| 文档说法：§1.1 #17 写“旧飞书 OAuth BrowserWindow 保留→退役评估@PR5”，见 `landing-plan.md:45`。 \| 影响：#17 改为“已消失”，PR5 只做回归确认，不做退役实现。 |
| L4 | 现状事实：Ghost 旧终态页已共享化；`ghostOauthFlow.ts:264-294 @643c3dca`。 \| 文档说法：§1.1 #19 写“Ghost OAuth 旧终态页 替换@PR3”，见 `landing-plan.md:47`。 \| 影响：#19 应改成“共享 OAuth result 小卡视觉替换@PR3”，不再是 Ghost 独立 shell 替换。 |
| L5 | 现状事实：`XdGatewayKeyDialog` 不存在，XD Gateway 是设置区 row；`ProvidersSection.tsx:818-992 @643c3dca`。 \| 文档说法：§1.1 #22 写“XD 网关 Key 授权弹窗 保留”，见 `landing-plan.md:50`。 \| 影响：#22 名称/处置需改为“XD Gateway Providers row 保留（后续 issue）”。 |
| L6 | 现状事实：内置 Ghost 清单已变，Slack Ghost 退役，Feishu 为 `xd-feishu`，并有 GitHub/GitLab 等；`cindy-brain/index.ts:235-245`、`builtin-ghosts/cindy-github/settings.html:5-10`、`builtin-ghosts/xd-feishu/settings.html:5-14 @643c3dca`。 \| 文档说法：§1.1 #24 沿旧审计的内置 Ghost 设置页授权入口，见 `landing-plan.md:52`。 \| 影响：#24 需重列当前 Ghost surface，Slack Ghost 不应进入验收。 |
| L7 | 现状事实：D1 当前起点已经是 v2 main，非“旧根 + worktree v2”混合；`router.tsx:41-48`、`LoginPage.tsx:43-44 @643c3dca`。 \| 文档说法：D1 仍合理定义目标 1819x2098 stage，但 §0 把旧 audit 作为母本，见 `landing-plan.md:18`、`:74-77`。 \| 影响：D1 保留，但“替换对象”描述应从混合现状改成 latest main 的 v2 card。 |
| L8 | 现状事实：PR1 目标里的“国区/国际区 默认/输入中/登录中/报错”当前不全是独立 state；desktop 登录方式由 ProviderConfig 动态决定，`attribution` 只设默认 tab；`LoginPage.tsx:58-68`、`packages/auth-client/src/types.ts:24-31 @643c3dca`。 \| 文档说法：PR1 写固定国区/国际区输入态，见 `landing-plan.md:115`。 \| 影响：PR1 需先准备 provider fixtures，验证 phone-only、email-only、both、social 多组合。 |
| L9 | 现状事实：PR2 需要覆盖 #8/#11/#12/#14完成态等无稿状态，因为它们是现有 main 真实状态；`LoginPage.tsx:104-140`、`:404-518`、`:554 @643c3dca`。 \| 文档说法：§1.1 #8/#11/#12/#14完成态 已列 #29，但批次④ #29 还包含旧 #3/#4；见 `landing-plan.md:36-44`、`:163`。 \| 影响：#29 应修订为：移除旧 progress/skip，保留 SSO org、account-selection、binding、completed、LocalDbGate、LegacyMigrationDialog。 |
| L10 | 现状事实：OAuth result 的共享化已覆盖更多 provider；`oauthResultPage.ts:138-180` 及 provider 调用点。 \| 文档说法：PR3 写 10 pageKind 三分类页壳，PR5 写旧界面退役；见 `landing-plan.md:117-119`。 \| 影响：PR3 仍有效，但应明确“替换已共享小卡”并补 provider OAuth regression；PR5 不要重复做 Ghost/Feishu 旧壳删除。 |

## 5. 对核销表与计划的修订建议

1. §1.1 桌面 24 项建议改为：准确项保留 #1、#5-#14、#16、#20、#21、#23；#2/#3/#17 标“已消失”；#4/#15/#18/#19/#22/#24 改写为最新 surface。
2. #29 桌面无稿清单建议修订为：保留 `sso-org`、`account-selection`、`binding`、`completed`、`GuestRoute/ProtectedRoute/LocalDbGate`、`LegacyMigrationDialog confirm/running/failed`；移除旧 `MigrationProgressView` 与旧 skip 弹窗。
3. PR1/PR2 仍应做桌面 Figma stage 与状态复刻，但起点是 latest main 的 v2 card；需要 provider fixtures 覆盖 `phone/email/social/attribution` 动态组合。
4. PR3 应描述为“替换已共享的 OAuth result 小卡为三类 Figma 卡”，并把 Ghost、Claude、xAI、generic provider 全部纳入回归；不要再把 Ghost 当独立旧壳。
5. PR5 中“退役旧飞书 LoginPage / 旧飞书 OAuth BrowserWindow / Ghost 旧 shell”的桌面实现项应取消或降为验证项；真实清理重点是确认无死引用与更新文档。

## 6. 验证记录

- 已执行：`git fetch origin main`。
- 已检查：`git show -s`、`git worktree list --porcelain`、`git for-each-ref`、登录相关路径的未合分支 diff、`git show origin/main:<path>`、`git grep`。
- 未运行 build/typecheck/截图测试；本任务是源码与文档事实重盘。
