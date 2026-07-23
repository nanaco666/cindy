# 授权回调终态页三分类归并方案

## 盘点范围

本文只做方案盘点，不改源码。当前工作根 `skin/cindy-theme-family` 下没有 `apps/desktop/src/main/oauthResultPage.ts`；本次按随仓 worktree `.xdt-worktrees/main-login-audit` 的 `6d5033d4` 代码盘点，因为它与 `docs/cindy-login-prototype.html` 的「授权回调页 gallery」同源，且实际包含共享页壳 `oauthResultPage.ts` 与调用点。若后续实现落在当前分支，需要先把该共享页壳变更同步进目标分支再改造。

实际存在的回调页变体按「页面种类」计为 10 个：

- 成功类：`login-success`、`ghost-success`、`xai-success`、`generic-success`
- 失败类：`login-error`、`ghost-error`、`claude-error`、`xai-error`、`generic-error`
- 中性/需继续操作类：`warning`（当前 preview/单测预留，无生产调用方）

Figma 读取状态：已按指定 nodeId 逐节点读取 `xNK3qh7zVfrO3zrKj5tEf8` 中的 680 x 680 三类卡片、1831 x 1831 浏览器页壳、750 x 1623 移动端 Chrome 回调页；未再读取 `0:1`。国区/国际区三类卡片结构同构，抽查国际区 `347:3149` 的 design context 与国区成功卡一致。翻译术语参考了 Microsoft OAuth 文档的日文/韩文页：日文 OAuth 授权语境使用「認可」，韩文文档使用「인증 코드 권한 부여」等 OAuth 表述；用户可见文案仍优先沿用现有代码里的四语表达。

参考：

- `docs/cindy-login-prototype.html`
- `.xdt-worktrees/main-login-audit/apps/desktop/src/main/oauthResultPage.ts`
- `.xdt-worktrees/main-login-audit/apps/desktop/src/main/authLoopbackCallback.ts`
- `.xdt-worktrees/main-login-audit/apps/desktop/src/main/authManager.ts`
- `.xdt-worktrees/main-login-audit/apps/desktop/src/main/cindy-brain/ghostOauthFlow.ts`
- `.xdt-worktrees/main-login-audit/apps/desktop/src/main/maker-host/claude-oauth-login.ts`
- `.xdt-worktrees/main-login-audit/apps/desktop/src/main/maker-host/grok-oauth-login.ts`
- `.xdt-worktrees/main-login-audit/apps/desktop/src/main/maker-host/generic-oauth.ts`
- https://learn.microsoft.com/ja-jp/entra/identity-platform/v2-oauth2-auth-code-flow
- https://learn.microsoft.com/ko-kr/entra/identity-platform/v2-oauth2-auth-code-flow

## 现有共享页壳

`renderOAuthResultPage(input)` 目前只有 3 个视觉 variant：`success`、`error`、`warning`。差异只体现在 `data-cindy-oauth-result` 和 badge 内的 Lucide path；卡片布局、字体、颜色、CTA 样式一致。

当前页壳参数：

| 项 | Light | Dark / 响应式 |
|---|---|---|
| 页面 | `#f8f8f6`，`body` 居中，`min-height: 100vh`，`padding: 16px` | `#1f1f1e`，生产跟随 `prefers-color-scheme`，preview 可用 `data-theme` 强制 |
| 卡片 | `width: min(100%, 400px)`，`padding: 40px 44px`，`border: 1px solid #d7d7d4`，`border-radius: 12px`，背景 `#fff` | 背景 `#2c2c2a`，边框 `#3c3c3a`；小屏 `padding: 32px 24px` |
| Badge | 48 x 48，圆形，`#e5e5e5`，内含 22 x 22 单色 SVG | `#3c3c3a` |
| 标题 | 20px / 1.3 / weight 500，`#262626`，下边距 10px | `#d4d4d4`；小屏 18px |
| 正文 | 14px / 1.6 / weight 400，`#737373` | `#a3a3a3` |
| detail | monospace 12px / 1.5，`overflow-wrap: anywhere` | Light `#a3a3a3`，Dark `#737373` |
| CTA | `inline-flex`，`min-height: 44px`，`padding: 10px 24px`，黑色胶囊，15px / 1.4 / weight 500 | Dark 反色；hover `#e5e5e5` 仅桌面浏览器有意义，移动端触摸场景不设 hover |

新设计应保留「系统浏览器里独立 HTML、不能依赖 renderer token」这个前提，但把 badge SVG 改为三类表情立绘：成功=开心，失败=困扰，中性=打哈欠。

## 变体全量枚举

| 变体 | 触发场景 | 当前文案 | 当前样式差异 | deep link 行为 |
|---|---|---|---|---|
| `login-success` | 桌面账号登录/SSO/social loopback `/auth/callback` 收到 `code` 且 `state` 匹配后立即渲染。注意：页面在 `exchangeAuthorizationCode` 之前返回，语义是「浏览器侧回调完成」，不是 token 交换已成功。 | zh `登录成功 / 你可以关闭此页面，回到 Cindy 继续。 / 回到 Cindy`；en `Signed in / You can close this page and return to Cindy. / Return to Cindy`；ja `ログイン完了 / このページを閉じて Cindy に戻れます。 / Cindy に戻る`；ko `로그인 완료 / 이 페이지를 닫고 Cindy(으)로 돌아가세요. / Cindy(으)로 돌아가기` | `variant: success`，当前为勾号 badge。 | `cindy://focus/desktop-login`，main 只 focus 窗口，不发 renderer 导航 payload。 |
| `login-error` | 同一 loopback 收到 `state` 不匹配、provider `error`、缺 `code`、监听失败、超时/取消等。渲染路径中 detail 显示原始错误码。 | 标题/正文同登录失败四语：zh `登录未完成 / 请回到 Cindy 重新登录。`；en `Sign-in not completed / Please return to Cindy and sign in again.`；ja `ログインを完了できませんでした / Cindy に戻ってもう一度ログインしてください。`；ko `로그인이 완료되지 않았습니다 / Cindy(으)로 돌아가 다시 로그인해 주세요.`；detail 示例：`STATE_MISMATCH`、`access_denied`、`INVALID_AUTH_CODE`。 | `variant: error`，当前为叉号 badge；有 detail 行。 | `cindy://focus/desktop-login`。 |
| `ghost-success` | 意识 Ghost OAuth loopback `/callback` 或自定义 `callbackPath` 收到 `code` 且 `state` 匹配后立即渲染。注意：页面在 token exchange/broker exchange 之前返回，存在「回调成功但后续换 token 失败」的部分成功窗口。 | zh `授权成功 / 你可以关闭此页面，回到 Cindy 继续。`；en `Authorization successful / You can close this page and return to Cindy.`；ja `認可が完了しました / このページを閉じて Cindy に戻れます。`；ko `인증 완료 / 이 페이지를 닫고 Cindy(으)로 돌아가세요.`；按钮来自共享 CTA。 | `variant: success`。 | `cindy://focus/ghost-oauth`。 |
| `ghost-error` | Ghost OAuth provider 返回 `error`；或缺 `code`/缺 `state`/state 不匹配；或回调处理异常。 | 三种正文：provider error：`授权服务器返回错误：{detail}` / `The authorization server returned an error: {detail}` / `認可サーバーがエラーを返しました：{detail}` / `인증 서버가 오류를 반환했습니다: {detail}`；invalid callback：`回调参数不完整或校验失败，请回到 Cindy 重试。` 等四语；internal：`回调处理异常，请回到 Cindy 重试。` 等四语。 | `variant: error`；provider error 的错误码进入正文，不走 detail 行。 | `cindy://focus/ghost-oauth`。 |
| `claude-error` | Claude OAuth 本地 callback `/callback` 缺 `code`、state 不匹配、token exchange 失败、缺 `user:inference` scope、用户取消且 pending response 尚在。Claude 成功时不渲染本地成功页，而是 302 到 `https://platform.claude.com/oauth/code/success?app=claude-code`。 | 使用 provider copy，providerName=`Claude`。缺 code：`没有收到 Claude 的授权码，请返回 Cindy 重试。` 等四语，detail 可来自 `error_description`/`error`；state 错：`授权校验失败，请返回 Cindy 重新发起连接。` 等四语；exchange/scope 失败：`连接 Claude 时发生错误，请返回 Cindy 重试。` 等四语，detail 例如 `not_a_subscription`。 | `variant: error`；可能有 detail 行。 | `cindy://focus/claude-oauth`。成功无 Cindy deep link，因为跳官方成功页。 |
| `xai-success` | xAI/Grok OAuth 固定回调 `http://127.0.0.1:56121/callback`，token exchange、nonce 校验、凭证写入完成后才渲染。 | 使用 provider copy，providerName=`xAI`：zh `授权成功 / xAI 已连接到 Cindy。你可以返回应用继续。`；en `Authorization complete / xAI is now connected to Cindy. You can return to the app to continue.`；ja `認可が完了しました / xAI が Cindy に接続されました。アプリに戻って続行できます。`；ko `인증 완료 / xAI 계정이 Cindy에 연결되었습니다. 앱으로 돌아가 계속할 수 있습니다.` | `variant: success`。 | `cindy://focus/xai-oauth`。 |
| `xai-error` | xAI callback 缺 `code`、state 不匹配、token exchange/nonce/写入前后异常、取消时 pending response 仍在。 | 使用 provider copy。缺 code：`没有收到 xAI 的授权码，请返回 Cindy 重试。` 等四语，detail 可来自 provider；state 错：`授权校验失败，请返回 Cindy 重新发起连接。` 等四语；exchange 失败：`连接 xAI 时发生错误，请返回 Cindy 重试。` 等四语，detail 为异常摘要。 | `variant: error`；可能有 detail 行。 | `cindy://focus/xai-oauth`。 |
| `generic-success` | 描述符驱动的自定义/目录供应商 OAuth，loopback `/callback`，token exchange 成功且 safeStorage 写入完成后渲染。providerName 来自用户/目录配置。 | 使用 provider copy，providerName=`{providerName}`：zh `授权成功 / {providerName} 已连接到 Cindy。你可以返回应用继续。`；en `Authorization complete / {providerName} is now connected to Cindy. You can return to the app to continue.`；ja `認可が完了しました / {providerName} が Cindy に接続されました。アプリに戻って続行できます。`；ko `인증 완료 / {providerName} 계정이 Cindy에 연결되었습니다. 앱으로 돌아가 계속할 수 있습니다.` | `variant: success`。 | `cindy://focus/generic-oauth`。 |
| `generic-error` | Generic callback 缺 `code`、state 不匹配、token exchange 失败、凭证写入失败、取消时 pending response 仍在。另有遗留非共享页路径：`close()` 在某些取消时会直接返回裸文本 `done`。 | 使用 provider copy。缺 code、state 错、exchange/write 失败分别对应 missingCode/invalidState/exchangeFailed 四语；detail 可来自 provider 或异常摘要。 | `variant: error`；可能有 detail 行。遗留 `done` 路径无卡片样式。 | `cindy://focus/generic-oauth`；遗留 `done` 无 CTA。 |
| `warning` | 共享页壳类型、单测和 preview 样例存在；生产代码暂无调用方。用于「需继续操作」而非成功/失败。 | preview 样例：zh `需要继续操作 / 请返回 Cindy，完成当前工作区的安装后继续。`；en `Action required / Return to Cindy and finish installing in the current workspace.`；ja `操作が必要です / Cindy に戻り、現在のワークスペースへのインストールを完了してください。`；ko `추가 작업 필요 / Cindy로 돌아가 현재 워크스페이스 설치를 완료하세요.` | `variant: warning`，当前为警告三角 badge。 | preview 为 `cindy://focus/preview-warning`；生产落地时应使用真实 source，例如 `slack-hook-install` 或 `ghost-install`。 |

## 三分类映射

| 变体 | 归并类别 | 理由 | 边界说明 |
|---|---|---|---|
| `login-success` | 成功 | 浏览器验证已完成，用户可以回 Cindy。 | 当前在 token exchange 前渲染，严格说是「浏览器侧成功」。若产品要求「最终登录成功」必须延后渲染；否则维持成功类，并让 app 内处理后续 exchange 失败。 |
| `login-error` | 失败 | 用户没有完成登录闭环，需重新登录。 | detail 保留错误码，但分类不因错误码细分。 |
| `ghost-success` | 成功 | OAuth callback code/state 已通过，用户已完成浏览器授权动作。 | 现代码在 token exchange 前渲染，若未来需要表达「授权已收到但安装还没完」，应改判中性。 |
| `ghost-error` | 失败 | provider 拒绝、回调非法或处理异常，当前授权没有完成。 | provider `error` 也归失败，不单独做 warning。 |
| `claude-error` | 失败 | 本地只存在 Claude 失败页；成功走官方成功页。 | 若后续增加 Cindy 自有 Claude 成功页，则新增 `claude-success` 并归成功类。 |
| `xai-success` | 成功 | token 交换和本地凭证写入已完成。 | 没有部分成功窗口。 |
| `xai-error` | 失败 | 授权码缺失、校验失败、交换失败或写入前异常。 | 取消导致的 pending response 失败页也归失败。 |
| `generic-success` | 成功 | token 交换和本地凭证写入已完成。 | providerName 动态替换，不影响分类。 |
| `generic-error` | 失败 | 授权码缺失、校验失败、交换失败或安全存储写入失败。 | `close()` 裸文本 `done` 是遗留非品牌页，应在改造时消除或纳入中性/失败页，不计独立设计类。 |
| `warning` | 中性/需继续操作 | 用户不是失败，也不能把当前流程视为结束；需要回 app 完成下一步。 | Ghost 安装后需继续操作、Slack hook workspace 安装、凭证已收但仍需选择 workspace 等 future cases 都应判中性。 |

部分成功判定原则：

- 浏览器授权完成但本地/服务端 token exchange 还没确认：若页面必须立即返回，可沿用成功类，但文案不要承诺「账号已连接」；更稳妥是中性「请返回 Cindy 完成登录」。
- 凭证已写入，但还需要用户回当前 workspace 完成安装/绑定：中性。
- 凭证写入失败、state 不匹配、provider 拒绝、缺授权码：失败。
- 用户主动取消：失败，除非产品明确要做「已取消」中性页；当前代码按失败处理。

## 统一文案表

说明：

- `{brand}` 当前为 `Cindy`。若设计视觉要求按钮显示 `CINDY`，建议在渲染层提供 display brand，而不是在每条文案里硬编码。
- `{providerName}` 为动态供应商名；generic 示例可用 `Acme AI`。
- detail 行为保留为诊断信息，不进入标题/副文案翻译表。

| 变体 | zh-CN | en | ja | ko |
|---|---|---|---|---|
| `login-success` | 标题：登录成功<br>副文案：你可以关闭此页面，回到 {brand} 继续。<br>按钮：回到 {brand} | Title: Signed in<br>Body: You can close this page and return to {brand}.<br>Button: Return to {brand} | タイトル：ログイン完了<br>本文：このページを閉じて {brand} に戻れます。<br>ボタン：{brand} に戻る | 제목: 로그인 완료<br>본문: 이 페이지를 닫고 {brand}(으)로 돌아가세요.<br>버튼: {brand}(으)로 돌아가기 |
| `login-error` | 标题：登录未完成<br>副文案：请回到 {brand} 重新登录。<br>按钮：回到 {brand} | Title: Sign-in not completed<br>Body: Please return to {brand} and sign in again.<br>Button: Return to {brand} | タイトル：ログインを完了できませんでした<br>本文：{brand} に戻ってもう一度ログインしてください。<br>ボタン：{brand} に戻る | 제목: 로그인이 완료되지 않았습니다<br>본문: {brand}(으)로 돌아가 다시 로그인해 주세요.<br>버튼: {brand}(으)로 돌아가기 |
| `ghost-success` | 标题：授权成功<br>副文案：你可以关闭此页面，回到 {brand} 继续。<br>按钮：返回 {brand} | Title: Authorization successful<br>Body: You can close this page and return to {brand}.<br>Button: Return to {brand} | タイトル：認可が完了しました<br>本文：このページを閉じて {brand} に戻れます。<br>ボタン：{brand} に戻る | 제목: 인증 완료<br>본문: 이 페이지를 닫고 {brand}(으)로 돌아가세요.<br>버튼: {brand}(으)로 돌아가기 |
| `ghost-error` | 标题：授权失败<br>副文案 A：授权服务器返回错误：{detail}<br>副文案 B：回调参数不完整或校验失败，请回到 {brand} 重试。<br>副文案 C：回调处理异常，请回到 {brand} 重试。<br>按钮：返回 {brand} | Title: Authorization failed<br>Body A: The authorization server returned an error: {detail}<br>Body B: The callback is incomplete or failed validation. Please return to {brand} and try again.<br>Body C: Something went wrong while handling the callback. Please return to {brand} and try again.<br>Button: Return to {brand} | タイトル：認可に失敗しました<br>本文 A：認可サーバーがエラーを返しました：{detail}<br>本文 B：コールバックのパラメータが不完全か検証に失敗しました。{brand} に戻ってやり直してください。<br>本文 C：コールバック処理中にエラーが発生しました。{brand} に戻ってやり直してください。<br>ボタン：{brand} に戻る | 제목: 인증 실패<br>본문 A: 인증 서버가 오류를 반환했습니다: {detail}<br>본문 B: 콜백 매개변수가 불완전하거나 검증에 실패했습니다. {brand}(으)로 돌아가 다시 시도하세요.<br>본문 C: 콜백 처리 중 오류가 발생했습니다. {brand}(으)로 돌아가 다시 시도하세요.<br>버튼: {brand}(으)로 돌아가기 |
| `claude-error` | 标题：授权未完成<br>副文案 A：没有收到 Claude 的授权码，请返回 {brand} 重试。<br>副文案 B：授权校验失败，请返回 {brand} 重新发起连接。<br>副文案 C：连接 Claude 时发生错误，请返回 {brand} 重试。<br>按钮：返回 {brand} | Title: Authorization not completed<br>Body A: No authorization code was received from Claude. Return to {brand} and try again.<br>Body B: Authorization validation failed. Return to {brand} and start the connection again.<br>Body C: Something went wrong while connecting Claude. Return to {brand} and try again.<br>Button: Return to {brand} | タイトル：認可を完了できませんでした<br>本文 A：Claude から認可コードを受信できませんでした。{brand} に戻って再試行してください。<br>本文 B：認可の検証に失敗しました。{brand} に戻って接続をやり直してください。<br>本文 C：Claude への接続中にエラーが発生しました。{brand} に戻って再試行してください。<br>ボタン：{brand} に戻る | 제목: 인증이 완료되지 않았습니다<br>본문 A: Claude 인증 코드를 받지 못했습니다. {brand}(으)로 돌아가 다시 시도하세요.<br>본문 B: 인증 검증에 실패했습니다. {brand}(으)로 돌아가 연결을 다시 시작하세요.<br>본문 C: Claude 연결 중 오류가 발생했습니다. {brand}(으)로 돌아가 다시 시도하세요.<br>버튼: {brand}(으)로 돌아가기 |
| `xai-success` | 标题：授权成功<br>副文案：xAI 已连接到 {brand}。你可以返回应用继续。<br>按钮：返回 {brand} | Title: Authorization complete<br>Body: xAI is now connected to {brand}. You can return to the app to continue.<br>Button: Return to {brand} | タイトル：認可が完了しました<br>本文：xAI が {brand} に接続されました。アプリに戻って続行できます。<br>ボタン：{brand} に戻る | 제목: 인증 완료<br>본문: xAI 계정이 {brand}에 연결되었습니다. 앱으로 돌아가 계속할 수 있습니다.<br>버튼: {brand}(으)로 돌아가기 |
| `xai-error` | 标题：授权未完成<br>副文案 A：没有收到 xAI 的授权码，请返回 {brand} 重试。<br>副文案 B：授权校验失败，请返回 {brand} 重新发起连接。<br>副文案 C：连接 xAI 时发生错误，请返回 {brand} 重试。<br>按钮：返回 {brand} | Title: Authorization not completed<br>Body A: No authorization code was received from xAI. Return to {brand} and try again.<br>Body B: Authorization validation failed. Return to {brand} and start the connection again.<br>Body C: Something went wrong while connecting xAI. Return to {brand} and try again.<br>Button: Return to {brand} | タイトル：認可を完了できませんでした<br>本文 A：xAI から認可コードを受信できませんでした。{brand} に戻って再試行してください。<br>本文 B：認可の検証に失敗しました。{brand} に戻って接続をやり直してください。<br>本文 C：xAI への接続中にエラーが発生しました。{brand} に戻って再試行してください。<br>ボタン：{brand} に戻る | 제목: 인증이 완료되지 않았습니다<br>본문 A: xAI 인증 코드를 받지 못했습니다. {brand}(으)로 돌아가 다시 시도하세요.<br>본문 B: 인증 검증에 실패했습니다. {brand}(으)로 돌아가 연결을 다시 시작하세요.<br>본문 C: xAI 연결 중 오류가 발생했습니다. {brand}(으)로 돌아가 다시 시도하세요.<br>버튼: {brand}(으)로 돌아가기 |
| `generic-success` | 标题：授权成功<br>副文案：{providerName} 已连接到 {brand}。你可以返回应用继续。<br>按钮：返回 {brand} | Title: Authorization complete<br>Body: {providerName} is now connected to {brand}. You can return to the app to continue.<br>Button: Return to {brand} | タイトル：認可が完了しました<br>本文：{providerName} が {brand} に接続されました。アプリに戻って続行できます。<br>ボタン：{brand} に戻る | 제목: 인증 완료<br>본문: {providerName} 계정이 {brand}에 연결되었습니다. 앱으로 돌아가 계속할 수 있습니다.<br>버튼: {brand}(으)로 돌아가기 |
| `generic-error` | 标题：授权未完成<br>副文案 A：没有收到 {providerName} 的授权码，请返回 {brand} 重试。<br>副文案 B：授权校验失败，请返回 {brand} 重新发起连接。<br>副文案 C：连接 {providerName} 时发生错误，请返回 {brand} 重试。<br>按钮：返回 {brand} | Title: Authorization not completed<br>Body A: No authorization code was received from {providerName}. Return to {brand} and try again.<br>Body B: Authorization validation failed. Return to {brand} and start the connection again.<br>Body C: Something went wrong while connecting {providerName}. Return to {brand} and try again.<br>Button: Return to {brand} | タイトル：認可を完了できませんでした<br>本文 A：{providerName} から認可コードを受信できませんでした。{brand} に戻って再試行してください。<br>本文 B：認可の検証に失敗しました。{brand} に戻って接続をやり直してください。<br>本文 C：{providerName} への接続中にエラーが発生しました。{brand} に戻って再試行してください。<br>ボタン：{brand} に戻る | 제목: 인증이 완료되지 않았습니다<br>본문 A: {providerName} 인증 코드를 받지 못했습니다. {brand}(으)로 돌아가 다시 시도하세요.<br>본문 B: 인증 검증에 실패했습니다. {brand}(으)로 돌아가 연결을 다시 시작하세요.<br>본문 C: {providerName} 연결 중 오류가 발생했습니다. {brand}(으)로 돌아가 다시 시도하세요.<br>버튼: {brand}(으)로 돌아가기 |
| `warning` | 标题：需要继续操作<br>副文案：请返回 {brand}，完成当前工作区的安装后继续。<br>按钮：返回 {brand} | Title: Action required<br>Body: Return to {brand} and finish installing in the current workspace.<br>Button: Return to {brand} | タイトル：操作が必要です<br>本文：{brand} に戻り、現在のワークスペースへのインストールを完了してください。<br>ボタン：{brand} に戻る | 제목: 추가 작업 필요<br>본문: {brand}로 돌아가 현재 워크스페이스 설치를 완료하세요.<br>버튼: {brand}(으)로 돌아가기 |

## 新设计三类卡片规格

Figma 参数来源：fileKey `xNK3qh7zVfrO3zrKj5tEf8`，国区卡片 `343:355`、`347:2503`、`347:1353`、`347:2509`、`347:1461`、`347:2515`；国际区卡片 `347:3149`、`347:3155`、`347:3161`、`347:3167`、`347:3173`、`347:3179`。所有卡片外框均为 680 x 680。

客户端和移动端共用同一套三类卡片设计。移动端浏览器是触摸场景，不设 hover 状态；按钮 hover 色、hover 阴影、hover 边框等参数只对桌面浏览器生效。

### 卡片共用参数

| 项 | White | Dark | 备注 |
|---|---|---|---|
| 外框 | 680 x 680；背景 `#fbfbfb`；1px `#d4d4d4` 实线边框；圆角 36；`overflow: clip` | 680 x 680；背景 `#312f2f`；1px `#434343` 实线边框；圆角 36；`overflow: clip` | 国区与国际区一致 |
| 布局/内边距 | Figma 为绝对定位布局，无 auto-layout padding；文本安全边距约 41-42px；按钮左右边距 70px；关键纵向位置：立绘 y=60、标题 y=352、副文案 y=396、按钮 y=529 | 同 White | 实现时可用固定卡片尺寸 + responsive scale，或保持 680px 卡片在移动浏览器中居中放置 |
| 立绘容器 | x=200，y=60，280 x 280 | 同 White | metadata 因边框显示为 x=201/y=61；实现按 design context 的 x=200/y=60 |
| 标题 | x=42，y=352，w=598，h=38；HarmonyOS Sans SC Bold；32px；line-height normal；居中；`#252222` | 同位置/字体/行高；颜色 `#d4d4d4` | Figma 以 `top=370` 的居中定位表达 |
| 副文案 | x=41，y=396，w=599，h=23；HarmonyOS Sans SC Regular；20px；line-height normal；居中；`#6f6f6f` | 同位置/字体/行高/颜色 | Figma 以 `top=calc(50% + 67.5px)` 的居中定位表达 |
| CTA 按钮 | x=70，y=529，540 x 80；背景 `#2a2828`；1px `#434343` 边框；圆角 40 | x=70，y=529，540 x 80；背景 `#eeeeee`；1px `#ffffff` 边框；圆角 40 | metadata 因边框显示为 x=71/y=530 |
| CTA 文字 | HarmonyOS Sans SC Bold；24px；line-height normal；居中；w=516；颜色 `#d4d4d4` | 同字体/尺寸/行高；颜色 `#2a2828` | 成功/失败按钮文案为「回到 CINDY」；中性为「返回 CINDY」 |
| hover | Figma 未给出独立 hover node | Figma 未给出独立 hover node | 如后续补 hover 色/阴影/边框，仅桌面浏览器生效；移动端/触摸浏览器不设 hover |

### 三类差异参数

| 类别 | 国区 nodeId | 国际区 nodeId | 文案 | 立绘参数 |
|---|---|---|---|---|
| 成功 | White `343:355`；Dark `347:2503` | White `347:3149`；Dark `347:3155` | 标题「登录成功」；副文案「你可以关闭此页面，回到 Cindy 继续」；按钮「回到 CINDY」 | 立绘容器 280 x 280；内部图片裁切 `width: 311.89%`、`height: 313.21%`、`left: -100.32%`、`top: -202.18%` |
| 失败 | White `347:1353`；Dark `347:2509` | White `347:3161`；Dark `347:3167` | 标题「登录未完成」；副文案「请回到 CINDY 重新登录」；按钮「回到 CINDY」 | 立绘容器 280 x 280；内部图片 object-cover/full-size，居中填满 280 x 280 |
| 中性 | White `347:1461`；Dark `347:2515` | White `347:3173`；Dark `347:3179` | 标题「需要继续操作」；副文案「请返回 Cindy，完成当前工作区的安装后继续」；按钮「返回 CINDY」 | 立绘容器 280 x 280；内部可见图片层 273 x 272；裁切 `width: 327.4%`、`height: 329.15%`、`left: -212.69%`、`top: -112.97%` |

### 浏览器页壳与移动端放置

| 场景 | nodeId | 画板参数 | 卡片放置 |
|---|---|---|---|
| 桌面浏览器页壳（国区） | `347:3016` | 1831 x 1831；浏览器内容区域 y=146.63，1831 x 1684.37；顶部控件：`#fefefe` 矩形 x=169.19/y=26.32/w=203.03/h=48.88，`#f1f2f3` 矩形 x=259.42/y=95.87/w=404.17/h=33.84 | 成功 White 卡 x=576，y=226，680 x 680 |
| 桌面浏览器页壳（国际区） | `347:3185` | 1831 x 1831；比国区多一个全幅背景图层 `Rectangle` 1831 x 1831；其余浏览器内容区域和顶部控件同国区 | 成功 White 卡 x=576，y=226，680 x 680 |
| 移动端 Chrome White（国区/国际区） | `347:3066` / `347:3212` | 750 x 1623；Chrome 截图背景 750 x 1623；页面内容底色 `#eeeeee`，x=0，y=160，750 x 1315 | 成功 White 卡 x=35，y=251，680 x 680 |
| 移动端 Chrome Dark（国区/国际区） | `347:3052` / `347:3203` | 750 x 1623；Chrome 截图背景 750 x 1623；页面内容底色 `#2a2828`，x=0，y=171，750 x 1315 | 成功 Dark 卡 x=35，y=251，680 x 680 |

实现时建议的设计 token 形态：

- `visualKind: 'success' | 'failure' | 'neutral'`，不要继续让业务调用点决定图形资源。
- `copyKind` 或业务 `pageKind` 独立于视觉类，允许同一视觉类下切不同文案。
- `theme` 仍只用于 preview；生产保持 OS color-scheme。
- hover token 需要按输入能力分支使用：桌面浏览器可应用 `:hover`，移动端/触摸浏览器不输出 hover 视觉差异。
- 静态立绘要能在系统浏览器独立 HTML 中加载。优先方案是由 loopback server 为 callback 页同源提供静态资源，或内联 data URI；不要依赖 `cindy-media://`、renderer bundle 路径或 Electron 私有协议。

## 需要保留的 query 参数/状态位

| 参数/状态 | 保留原因 | 渲染建议 |
|---|---|---|
| `state` | CSRF/串单校验；所有 OAuth/登录流必须保留。 | 不展示；只参与校验。 |
| `code` | 授权码，用于 token exchange。 | 不展示，不进日志。 |
| `error` | provider 拒绝或取消时返回。 | 失败类；可进入 detail，Ghost 当前进入正文。建议统一放 detail，正文保持可本地化。 |
| `error_description` | provider 的人类可读错误说明。 | 失败类 detail，必须 HTML escape，长度建议限制。 |
| `detail` | 本地诊断，如 `STATE_MISMATCH`、`not_a_subscription`、exchange 异常摘要。 | 保留，但新设计可改为小号诊断区或折叠 `<details>`，不要影响三分类。 |
| `source` | CTA deep link 的 focus 来源：`desktop-login`、`ghost-oauth`、`claude-oauth`、`xai-oauth`、`generic-oauth`、future install source。 | 保留到 `cindy://focus/<source>`；只用于日志和聚焦，不作为安全决策。 |
| `lang/htmlLang` | 登录页跟随 app locale；provider/Ghost/Claude/xAI/generic 当前跟随浏览器 `Accept-Language`，fallback en。 | 可以保留现状；若要统一，需先产品决策「浏览器页跟 app 语言」还是「跟浏览器语言」。 |
| `theme` | preview-only 强制 light/dark；生产靠 `prefers-color-scheme`。 | 保留 preview 能力，方便视觉验收。 |
| `variant` | 当前页壳的 3 类状态。 | 可内部兼容：`success -> success`、`error -> failure`、`warning -> neutral`；外部文档统一叫成功/失败/中性。 |

## 页壳改造点

1. 把 `OAuthResultPageVariant` 的 UI 映射收敛成三类资源：`success`、`failure`、`neutral`。代码可先兼容旧值 `error`，渲染层映射到 `failure`。
2. 替换 `RESULT_ICON` 为三张表情立绘，或新增 `RESULT_VISUAL` 配置。立绘不能依赖 renderer runtime；需要可被系统浏览器直接加载。
3. 抽出统一 copy builder。当前登录 copy 在 renderer i18n、Ghost copy 在 `ghostOauthFlow.ts`、provider copy 在 `oauthResultPage.ts`；改造时应集中到一个 main 可用的四语表，调用点只传 `pageKind`、`providerName`、`detail`。
4. 统一失败 detail 策略。建议正文只放可本地化文案，原始 provider error/异常摘要放 detail，且限制长度。
5. 消除 generic `close()` 裸文本 `done` 路径。若用户在 code 已回但后续取消，应明确走失败类或中性类，而不是返回无品牌纯文本。
6. 复核「提前成功页」语义。`login-success` 与 `ghost-success` 当前在 token exchange 前渲染；若新设计标题固定为「登录成功/授权成功」，建议把 response 延后到 exchange 后，或将这两类成功文案改成「验证已完成，请返回 Cindy 继续」以避免误导。
7. 保留 `cindy://focus/<source>`，并确认 app 已注册 `cindy` 主 scheme 与 `xdt-maker` 历史 scheme。当前 focus payload 只拉起窗口，不进 renderer；若设计期望「回到对应设置页/登录页」，需要新增 renderer 导航 payload，而不是复用纯 focus。
8. preview 工具继续保留 10 kind x 4 语言 x light/dark 的矩阵；用上述 Figma 参数更新后，通过同一 renderer 预览核对三类样式。
