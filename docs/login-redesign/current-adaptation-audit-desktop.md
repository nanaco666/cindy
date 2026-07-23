# Cindy 桌面端登录 UI 现状适配规范盘查

> 范围：`apps/desktop` 登录、授权、登录后授权入口与 OAuth 回调终态页。本文只基于代码盘查推导布局/缩放行为，未改源码。
>
> 基准说明：当前工作树分支仍是旧版飞书登录页；仓库内 `.xdt-worktrees/main-login-audit` 包含近期 login v2 状态机、系统浏览器授权回调和 `oauthResultPage.ts`。由于本次任务明确要求覆盖 login v2 与共享 OAuth 终态页，本文同时记录「当前根工作树」与「login-v2 worktree」两套现状。

## 盘查清单

共盘查 24 个界面/状态/窗口配置：

1. 主窗口/副窗口 BrowserWindow chrome 与全局缩放。
2. 当前根工作树登录页 `LoginPage`。
3. 当前根工作树迁移进度页。
4. 当前根工作树迁移失败/跳过确认弹窗。
5. login v2 登录卡片外壳。
6. login v2 准备/未拿到状态。
7. login v2 身份输入态。
8. login v2 企业 SSO 组织输入态。
9. login v2 方法选择态。
10. login v2 验证码态。
11. login v2 账号选择态。
12. login v2 绑定态。
13. login v2 系统浏览器授权等待态。
14. login v2 错误/完成态。
15. Auth/DB 路由门控空白态。
16. login v2 旧库迁移弹窗。
17. 当前根工作树飞书 OAuth BrowserWindow。
18. login v2 系统浏览器 OAuth 回调/终态页。
19. 当前根工作树 Ghost OAuth 旧终态页。
20. Providers 设置区授权行。
21. 自定义供应商 OAuth 配置弹窗。
22. XD 网关 Key 授权弹窗。
23. Slack Hook / Computer Use 等设置里的授权入口。
24. 内置 Ghost 设置页授权入口。

## 全局适配约束

### 1. 主窗口/副窗口 BrowserWindow chrome 与缩放

**证据**

- 主窗口默认尺寸来自 `windowStateKeeper({ defaultWidth: 1280, defaultHeight: 800 })`，见 [apps/desktop/src/main/bootstrap-electron.ts:1573](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/main/bootstrap-electron.ts:1573>)。
- 主窗口 `minWidth: 800`、`minHeight: 600`，macOS `titleBarStyle: 'hidden'`，非 macOS `frame: false`，见 [apps/desktop/src/main/bootstrap-electron.ts:1548](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/main/bootstrap-electron.ts:1548>)、[apps/desktop/src/main/bootstrap-electron.ts:1578](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/main/bootstrap-electron.ts:1578>)。
- 副窗口复刻主窗口 min 800x600 与 chrome 策略，见 [apps/desktop/src/main/secondary-windows.ts:81](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/main/secondary-windows.ts:81>)、[apps/desktop/src/main/secondary-windows.ts:99](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/main/secondary-windows.ts:99>)。
- renderer 根节点 `html, body, #root` 固定 100% 且 `overflow: hidden`，见 [apps/desktop/src/renderer/styles/globals.css:119](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/styles/globals.css:119>)。
- 页面缩放通过 `webContents.setZoomLevel` 作用于 app 内容，见 [apps/desktop/src/main/bootstrap-electron.ts:1418](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/main/bootstrap-electron.ts:1418>)。

**适配结论**

- 桌面端登录 UI 的有效最小视口按 800x600 推导；CSS 自身没有为更小窗口完整兜底。
- 根滚动被禁用，登录页/迁移页如果内容高度超过 600 高窗口可用区域，会裁切而不是自然滚动。
- app 内页面缩放会整体放大/缩小固定 px 元素；系统浏览器 OAuth 回调页不受 Electron `setZoomLevel` 影响，只受外部浏览器缩放/DPI 影响。
- DPI/系统缩放主要交给 Chromium/Electron 的 CSS px 体系，没有针对登录图像的 `srcset`、`image-set` 或按 DPR 切资源逻辑。

## 当前根工作树：登录与迁移

### 2. 当前根工作树登录页 `LoginPage`

**证据**

- 页面根：`flex min-h-screen flex-col bg-[var(--login-bg)]`，见 [apps/desktop/src/renderer/components/login/LoginPage.tsx:18](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/login/LoginPage.tsx:18>)。
- 顶部拖拽区：`h-[46px] w-full shrink-0`，非 macOS 放 `WindowControls`，见 [apps/desktop/src/renderer/components/login/LoginPage.tsx:20](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/login/LoginPage.tsx:20>)。
- 内容区：`flex flex-1 flex-col items-center justify-center`，见 [apps/desktop/src/renderer/components/login/LoginPage.tsx:32](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/login/LoginPage.tsx:32>)。
- 卡片：`w-[400px] p-[48px] rounded-[12px]`，见 [apps/desktop/src/renderer/components/login/LoginPage.tsx:33](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/login/LoginPage.tsx:33>)。
- Logo：`h-[216px] w-[216px] object-contain`，见 [apps/desktop/src/renderer/components/login/LoginPage.tsx:40](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/login/LoginPage.tsx:40>)。
- 飞书按钮：`h-[48px] w-full rounded-full`，见 [apps/desktop/src/renderer/components/login/LoginPage.tsx:57](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/login/LoginPage.tsx:57>)。

**布局实现**

- 外层竖向 flex；登录内容在去掉 46px toolbar 后的剩余空间内水平/垂直居中。
- 卡片和 Logo 都是固定 px，不随视口缩放；内部靠固定 spacer、divider 和按钮纵向堆叠。
- 没有 absolute 定位、百分比布局、aspect-ratio 或响应式断点。

**尺寸约束**

- 依赖主窗口 min 800x600；登录卡片固定 400px 宽，Logo 216px。
- CSS 层没有 `max-width`，如果被嵌入到小于 400px 的容器会横向溢出；正常 BrowserWindow 下不会触发。

**拉伸行为**

- 左右拉宽：400px 卡片继续在视口中心，背景铺满，元素不缩放，左右留白增加。
- 上下拉高：卡片继续在内容区垂直居中，toolbar 固定 46px，额外高度平均分配到卡片上下。
- 缩小到 800x600：生产态通常能完整显示；dev 登录按钮、错误文案和长 i18n 文案会增加高度。根 overflow hidden，极端文案/系统缩放下会裁切。

**主题/i18n/DPI/资源**

- 颜色全部来自 login token：`--login-bg`、`--login-card-bg`、`--login-card-border`、`--login-btn-*`，token 注册见 [apps/desktop/src/renderer/themes/colors.ts:429](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/themes/colors.ts:429>)。
- 文案走 i18n；按钮固定高度，长文案不会主动换行，可能挤压图标/文字间距。
- Logo 为 `splash-logo.png`，固定 216x216，`object-contain` 防变形，但不跟随窗口等比缩放。

### 3. 当前根工作树迁移进度页

**证据**

- 根和 toolbar 与登录页一致，见 [apps/desktop/src/renderer/components/login/MigrationProgressView.tsx:169](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/login/MigrationProgressView.tsx:169>)。
- 卡片：`w-[560px] p-[48px]`，见 [apps/desktop/src/renderer/components/login/MigrationProgressView.tsx:188](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/login/MigrationProgressView.tsx:188>)。
- Logo：216x216，见 [apps/desktop/src/renderer/components/login/MigrationProgressView.tsx:194](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/login/MigrationProgressView.tsx:194>)。
- 进度条：`w-[480px] h-[8px]`，见 [apps/desktop/src/renderer/components/login/MigrationProgressView.tsx:226](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/login/MigrationProgressView.tsx:226>)。

**布局实现**

- 与登录页同样是 flex 居中 + 固定宽卡片。
- 进度条用百分比 `width: ${percent}%` 填充，轨道宽度固定 480px。

**尺寸约束**

- 卡片 560px 宽，正常 800px minWidth 下左右可见。
- 高度由 logo、标题、副标题、progress、detail、retry notice 决定；没有滚动容器。

**拉伸行为**

- 左右拉宽：卡片固定 560px，水平居中，进度条固定 480px。
- 上下拉高：卡片垂直居中。
- 缩小到极限：横向仍可放下；纵向遇到长标题/副标题/重试文案会增长，根 overflow hidden 下可能裁切。

**主题/i18n/DPI/资源**

- 复用 login token，迁移进度条有独立 `migration-*` token，见 [apps/desktop/src/renderer/themes/colors.ts:467](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/themes/colors.ts:467>)。
- 文案走 i18n，标题/副标题 `w-full text-center`，长文案会换行并增加卡片高度。
- 图像同 `splash-logo.png` 216x216 `object-contain`。

### 4. 迁移失败/跳过确认弹窗

**证据**

- 失败弹窗 overlay fixed inset，content fixed center，`w-[440px] p-[32px]`，见 [apps/desktop/src/renderer/components/login/MigrationProgressView.tsx:270](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/login/MigrationProgressView.tsx:270>)。
- 跳过确认弹窗同样 `w-[440px] p-[32px]`，见 [apps/desktop/src/renderer/components/login/MigrationProgressView.tsx:331](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/login/MigrationProgressView.tsx:331>)。

**布局实现**

- Radix AlertDialog fixed 居中，靠 `left-1/2 top-1/2 -translate-x/y-1/2`。
- 按钮行 `flex justify-end gap-3`，不换行。

**尺寸约束与拉伸行为**

- 弹窗固定 440px 宽，随窗口拉伸始终居中，不随视口缩放。
- 在 800x600 下横向安全；极端文案会撑高弹窗，根没有全局滚动。
- 长按钮文案可能让按钮行横向拥挤或溢出。

**主题/i18n/DPI**

- 使用 login/confirm/update token；按钮文案走 i18n。
- 弹窗是 CSS fixed，DPI/页面 zoom 下按 Chromium 缩放。

## login v2 worktree：状态机登录 UI

### 5. login v2 登录卡片外壳

**证据**

- 根：`flex min-h-screen flex-col bg-[var(--login-bg)]`，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:565](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:565>)。
- toolbar：46px，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:566](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:566>)。
- 内容 wrapper：`flex flex-1 items-center justify-center px-6 py-8`，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:577](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:577>)。
- 主卡片：`min-h-[560px] w-[440px] max-w-full px-10 py-8`，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:578](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:578>)。
- Logo：`mb-6 w-[216px] object-contain`，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:584](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:584>)。
- 内容区：`flex w-full flex-1 flex-col items-center justify-center`，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:597](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:597>)。

**布局实现**

- 仍是单卡片居中模型；不同状态都被塞进固定卡片内容区。
- 卡片宽度 440px，`max-w-full` 可在更窄容器下收缩，但主 BrowserWindow min 800 通常不会触发。
- 返回按钮 absolute 定位在卡片左上角，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:635](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:635>)。

**尺寸约束**

- 最小高度组合：toolbar 46 + wrapper 上下 padding 64 + card min-height 560 = 670px，高于主窗口 minHeight 600。
- 因根 overflow hidden，600 高窗口下 login v2 卡片存在纵向裁切风险。

**拉伸行为**

- 左右拉宽：440px 卡片固定居中，五类内容不缩放。
- 上下拉高：卡片整体垂直居中，状态内容在卡片内部 `flex-1 justify-center` 居中。
- 缩小到极限：纵向最容易出问题；不是等比缩小，而是固定卡片被视口裁切。

**主题/i18n/DPI/资源**

- 使用 `--login-*`、`--surface-*`、`--text-*` token；可随 app 主题变。
- Brand logo 来自 `useBrandLogo()`，固定宽 216px，高度按资源比例，`object-contain`。
- 没有 Cindy 立绘、签名或字标组合资源。

### 6. login v2 准备/未拿到状态

**证据**

- `!loginState` 时只渲染 Header，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:520](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:520>)。
- Header 为 `mb-6 text-center`，标题 24px，副标题 `break-words` 14px，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:614](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:614>)。

**适配行为**

- 该状态没有 loading 图或占位 skeleton，只在卡片中心显示文案。
- 左右/上下拉伸继承外壳；长副标题会换行并增加内容高度。

### 7. login v2 身份输入态

**证据**

- email/phone tab：`mb-4 flex w-full rounded-full p-1`，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:146](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:146>)。
- 输入框：`h-11 w-full rounded-full`，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:27](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:27>)、[.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:172](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:172>)。
- social buttons grid：`grid w-full gap-2`，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:195](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:195>)。
- SSO 入口为 `mt-5 w-full text-center` 文本按钮，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:222](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:222>)。

**拉伸/文案行为**

- 控件宽度填满卡片内部宽度；卡片不随视口放大。
- social button 数量越多，高度越高；没有内部滚动。
- tab/按钮固定高度，长 i18n 文案会压缩或溢出，不会自动变成多行布局。

### 8. login v2 企业 SSO 组织输入态

**证据**

- BackButton + Header + `form w-full space-y-3`，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:104](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:104>)。
- hint：`mt-4 text-center text-[13px] leading-5`，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:136](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:136>)。

**拉伸/文案行为**

- 继承卡片居中；内容高度比身份输入态略低。
- SSO hint 会换行并撑高；无滚动。
- BackButton absolute，不参与文档流；长标题时可能靠近返回按钮，但不会推开它。

### 9. login v2 方法选择态

**证据**

- SSO 方法按钮使用 `h-auto min-h-12 justify-start rounded-xl px-4 py-3 text-left`，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:264](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:264>)。
- 企业/个人名称用 `block truncate`，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:283](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:283>)、[.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:310](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:310>)。

**拉伸/文案行为**

- 多个 SSO 方法纵向堆叠；长企业名/连接名被截断，不换行。
- 按钮可高于 48px，但不是等比缩放。
- SSO required 提示居中换行，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:336](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:336>)。

### 10. login v2 验证码态

**证据**

- code input：`text-center tracking-[0.35em]`，6 位限制，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:345](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:345>)。
- resend button：`w-full text-center text-[13px]`，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:385](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:385>)。

**拉伸/文案行为**

- 控件固定高度，输入文本 letter spacing 固定；页面缩放会改变视觉间距。
- `codeSentTo` 副标题使用 Header 的 `break-words`，长邮箱/手机号可换行，不会截断。

### 11. login v2 账号选择态

**证据**

- 账号按钮 `h-auto min-h-12`，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:404](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:404>)。
- 账号名与组织/邮箱使用 `block truncate`，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:427](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:427>)。

**拉伸/文案行为**

- 账号数量直接影响总高度；无 max-height/scroll。
- 长账号名/组织名截断，不换行。
- 缩小高度时多账号最容易被卡片裁掉。

### 12. login v2 绑定态

**证据**

- 绑定 contact 表单与 code 表单见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:440](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:440>)。
- contact 显示使用 `truncate text-center`，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:486](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:486>)。

**拉伸/文案行为**

- 布局同验证码态；contact 会截断。
- 绑定前后两个子态会改变表单高度，但卡片位置和外壳不变。

### 13. login v2 系统浏览器授权等待态

**证据**

- `browser-redirect` 渲染 Header、24px Spinner、取消按钮，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:534](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:534>)。
- 状态机入口由 social/SSO 按钮 dispatch `start-browser`，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:205](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:205>)、[.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:274](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:274>)。

**布局实现与拉伸行为**

- 等待态仍在同一登录卡片中心，不是独立全屏授权中间页。
- Spinner 不改变布局宽度；取消按钮填满卡片内部宽度。
- `loginState.label` 作为 Header subtitle，`break-words`，长服务商名会换行。

### 14. login v2 错误/完成态

**证据**

- `error` step 渲染 Header + retry 按钮，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:524](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:524>)。
- `completed` 直接 `return null`，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:554](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:554>)。
- 全局错误文案显示在卡片底部 `mt-5 text-center`，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:600](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:600>)。

**拉伸/文案行为**

- 错误态卡片高度固定最小 560px，内容居中。
- `completed` 会让卡片内容区为空，但外层卡片/Logo 仍存在到路由跳转完成；不是终态成功页。
- 错误文案会增加卡片底部高度，长错误文案可换行。

### 15. Auth/DB 路由门控空白态

**证据**

- GuestRoute 初始化时 `return null`，见 [apps/desktop/src/renderer/components/auth/GuestRoute.tsx:5](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/auth/GuestRoute.tsx:5>)。
- ProtectedRoute 初始化时 `return null`，见 [apps/desktop/src/renderer/components/auth/ProtectedRoute.tsx:5](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/auth/ProtectedRoute.tsx:5>)。
- 当前根 MigrationGate checking/fatal 返回 null，见 [apps/desktop/src/renderer/components/auth/MigrationGate.tsx:175](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/auth/MigrationGate.tsx:175>)。
- login-v2 worktree LocalDbGate checking/fatal 返回 null，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/auth/LocalDbGate.tsx:108](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/auth/LocalDbGate.tsx:108>)。

**适配结论**

- 这些不是可见 UI，而是登录/入主界面的空白帧风险。
- 拉伸行为等同背景/上一层容器；没有居中元素、没有反馈，也无主题除背景外的表现。
- 新设计如果要求登录流程所有中间态都有完整五要素，需要把这些 null gate 纳入过渡策略。

### 16. login v2 旧库迁移弹窗

**证据**

- LegacyMigrationDialog 复用 ConfirmDialog，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/auth/LegacyMigrationDialog.tsx:47](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/auth/LegacyMigrationDialog.tsx:47>)。
- ConfirmDialog fixed center、`w-full` + `maxWidth ?? 400`，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/ui/confirm-dialog.tsx:89](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/ui/confirm-dialog.tsx:89>)。

**拉伸/主题/i18n**

- 弹窗随视口固定居中，最大宽 400px，不参与登录卡片布局。
- 文字走 i18n，描述可换行；按钮行 `justify-end`，按钮最小宽 96px，长文案可能挤。
- 使用 confirm token，不是 login 页面专属 token。

## OAuth 回调/终态页与授权窗口

### 17. 当前根工作树飞书 OAuth BrowserWindow

**证据**

- 旧 Feishu OAuth 使用独立 BrowserWindow，`width: 600`、`height: 740`、非 modal、可关闭/最小化，见 [apps/desktop/src/main/authManager.ts:332](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/main/authManager.ts:332>)。
- 未显式设置 `minWidth`、`minHeight`、`resizable`、`titleBarStyle` 或 `frame`。

**适配结论**

- 授权页视觉由飞书网页控制，不属于 renderer 登录 UI。
- 窗口默认 600x740，用户若调整大小，Electron 默认 resizable 行为生效；仓库没有对其内部布局兜底。
- 新设计的红底/Cindy 构图无法作用于第三方 OAuth 页面本身，只能作用于发起前和等待/回跳后的 app 页面。

### 18. login v2 系统浏览器 OAuth 回调/终态页

**证据**

- login v2 使用系统浏览器 + loopback，超时 5 分钟，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/main/authManager.ts:319](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/main/authManager.ts:319>)。
- 回调监听 `127.0.0.1:<port>/auth/callback` 后 `shell.openExternal(authUrl)`，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/main/authManager.ts:391](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/main/authManager.ts:391>)。
- 共享结果页 `renderOAuthResultPage`：body `min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px`，card `width:min(100%,400px); padding:40px 44px`，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/main/oauthResultPage.ts:138](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/main/oauthResultPage.ts:138>)。
- 480px 断点压缩 card padding 和 h1 字号，见 [.xdt-worktrees/main-login-audit/apps/desktop/src/main/oauthResultPage.ts:168](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/main/oauthResultPage.ts:168>)。

**布局实现**

- 独立 HTML 字符串，运行在系统浏览器；不是 React 组件。
- 单卡片居中，宽度最多 400px，小屏按 `min(100%,400px)` 收缩。
- 图标 badge 固定 48px，CTA 最小高 44px。

**拉伸行为**

- 左右拉宽：卡片固定最大 400px 居中，背景铺满。
- 上下拉高：卡片在视口中心。
- 缩小：宽度可缩到视口宽度减 padding；文本可换行；浏览器默认可滚动，较 app 根更能容忍小高。

**主题/i18n/DPI**

- 只内联默认 light/dark 色值，并通过 `prefers-color-scheme` 切换；不能读取 app 自定义主题 token。
- 文案支持 zh/en/ja/ko；detail 用 monospace 且 `overflow-wrap:anywhere`。
- 系统浏览器缩放和 DPR 由浏览器处理。

### 19. 当前根工作树 Ghost OAuth 旧终态页

**证据**

- `ghostOauthFlow.ts` 内部旧 `oauthPageShell` 使用 body `display:flex; align-items:center; justify-content:center; height:100vh; margin:0`，card `padding:32px 40px; max-width:360px`，见 [apps/desktop/src/main/cindy-brain/ghostOauthFlow.ts:272](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/main/cindy-brain/ghostOauthFlow.ts:272>)。

**适配结论**

- 旧 shell 与 `oauthResultPage.ts` 同为系统浏览器里的卡片居中模型，但尺寸和色值各自维护。
- 没有移动断点；`height:100vh` 下超高内容容错弱于 `min-height:100vh`。
- login-v2 worktree 已有共享 `oauthResultPage.ts`，整体替换时应统一回调壳，避免 Ghost/登录/Provider 各自残留不同终态页。

## 设置区授权入口

### 20. Providers 设置区授权行

**证据**

- 通用 secondary pill button：`h-8 shrink-0 rounded-full px-[14px]`，见 [apps/desktop/src/renderer/components/settings/ProvidersSection.tsx:121](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/settings/ProvidersSection.tsx:121>)。
- ProviderCell 行结构：avatar 36px + 文本 `min-w-0 flex-1` + trailing + chevron，见 [apps/desktop/src/renderer/components/settings/ProvidersSection.tsx:357](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/settings/ProvidersSection.tsx:357>)。
- Anthropic OAuth row，见 [apps/desktop/src/renderer/components/settings/ProvidersSection.tsx:459](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/settings/ProvidersSection.tsx:459>)。
- OpenAI/Codex OAuth row，见 [apps/desktop/src/renderer/components/settings/ProvidersSection.tsx:547](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/settings/ProvidersSection.tsx:547>)。
- xAI OAuth row，见 [apps/desktop/src/renderer/components/settings/ProvidersSection.tsx:613](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/settings/ProvidersSection.tsx:613>)。
- Generic OAuth row，见 [apps/desktop/src/renderer/components/settings/ProvidersSection.tsx:699](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/settings/ProvidersSection.tsx:699>)。
- 自定义 OAuth row，见 [apps/desktop/src/renderer/components/settings/ProvidersSection.tsx:931](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/settings/ProvidersSection.tsx:931>)。
- ProvidersSection 容器为 `flex flex-col gap-[14px]`，卡片 `flex flex-col rounded-xl border`，见 [apps/desktop/src/renderer/components/settings/ProvidersSection.tsx:1141](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/settings/ProvidersSection.tsx:1141>)。

**布局实现**

- 不是独立登录页；嵌入 Settings 内容流。
- 行内使用 flex，标题/副标题 truncate，右侧按钮/chip shrink-0。
- 模型展开面板垂直增长，搜索框 flex-1，模型名 truncate，见 [apps/desktop/src/renderer/components/settings/ProvidersSection.tsx:223](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/settings/ProvidersSection.tsx:223>)。

**拉伸行为**

- 左右拉宽：设置卡片随父容器变宽，行内文本可占更多空间，按钮保持固定尺寸。
- 左右变窄：标题/副标题优先截断；trailing 不换行，极窄时按钮组会挤压文本或溢出。
- 上下拉高：由 Settings 页面滚动容器承接；本组件自身没有固定高度。
- 授权中：按钮文案从「授权」变「取消」，按钮宽度按文案自然变化，可能导致 trailing 宽度变化。

**主题/i18n/DPI**

- 全部使用 settings token 和 surface/text token，可随主题变化。
- 长服务商名、自定义名和模型名大多 truncate；按钮文案不 truncate。

### 21. 自定义供应商 OAuth 配置弹窗

**证据**

- 弹窗 overlay：`fixed inset-0 flex items-center justify-center`，card `max-h-[88vh] w-[600px]`，见 [apps/desktop/src/renderer/components/settings/CustomProviderDialog.tsx:512](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/settings/CustomProviderDialog.tsx:512>)。
- Body：`overflow-y-auto`，见 [apps/desktop/src/renderer/components/settings/CustomProviderDialog.tsx:541](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/settings/CustomProviderDialog.tsx:541>)。
- OAuth authMode 字段和四个 URL/client/scopes 输入，见 [apps/desktop/src/renderer/components/settings/CustomProviderDialog.tsx:572](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/settings/CustomProviderDialog.tsx:572>)。
- 高级配置折叠，见 [apps/desktop/src/renderer/components/settings/CustomProviderDialog.tsx:730](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/settings/CustomProviderDialog.tsx:730>)。

**布局实现**

- fixed 居中弹窗，宽 600px；body 内部滚动，header/footer 固定在弹窗上下文内。
- 表单按 flex column 堆叠，runtime tab 为 pill segmented control。

**拉伸行为**

- 左右拉宽：弹窗仍 600px 居中。
- 左右缩窄：没有 `max-w-[calc(100vw-...)]`，理论上小于 600px 会横向溢出；主窗口 800px 下安全。
- 上下拉高：弹窗高度由内容决定，最多 88vh。
- 上下缩短：body 滚动，header/footer 保持可见，是现有登录相关 UI 中较完整的纵向适配模式。

**主题/i18n/DPI**

- 复用 settings/login/confirm token。
- 文案、placeholder 走 i18n；长 placeholder 在 input 内裁切。
- OAuth 模式隐藏 API key/test connection，减少高度；高级配置展开会显著增加高度但有 body scroll。

### 22. XD 网关 Key 授权弹窗

**证据**

- overlay fixed center，card `w-[480px] p-6`，见 [apps/desktop/src/renderer/components/settings/XdGatewayKeyDialog.tsx:58](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/settings/XdGatewayKeyDialog.tsx:58>)。
- 输入框 `h-[44px] w-full`，见 [apps/desktop/src/renderer/components/settings/XdGatewayKeyDialog.tsx:94](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/settings/XdGatewayKeyDialog.tsx:94>)。
- 按钮行 `flex justify-end gap-2.5`，见 [apps/desktop/src/renderer/components/settings/XdGatewayKeyDialog.tsx:132](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/settings/XdGatewayKeyDialog.tsx:132>)。

**拉伸/主题/i18n**

- 480px 固定宽居中；无 body scroll，但内容少，800x600 下安全。
- 错误信息出现会撑高弹窗；长错误文案换行。
- 使用 login-card/confirm/settings token，受主题影响。
- 这属于授权/连接入口，不属于首登 UI；整体替换时通常不应套红底登录首屏构图。

### 23. Slack Hook 与 Computer Use 授权入口

**证据**

- Slack Hook 顶部行：`rounded-xl border px-4 py-3`，内部 `flex items-center gap-3`，见 [apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx:297](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx:297>)。
- Slack 授权中复制链接按钮和 Switch 同行，见 [apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx:323](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx:323>)。
- Slack 未安装引导行有安装/复制按钮，见 [apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx:342](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx:342>)。
- Computer Use “打开用于登录的浏览器”入口位于 flex-wrap 行，见 [apps/desktop/src/renderer/components/settings/ComputerUseSection.tsx:1002](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/settings/ComputerUseSection.tsx:1002>)、[apps/desktop/src/renderer/components/settings/ComputerUseSection.tsx:1211](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/settings/ComputerUseSection.tsx:1211>)。

**布局实现**

- 均为 Settings 内嵌行/卡片，不是登录页。
- Slack 行内文案 truncate，按钮固定小 pill；Computer Use 外部浏览器登录行使用 `flex-wrap`，窄宽下按钮可换到下一行。

**拉伸行为**

- Slack：父容器变窄时状态文本截断；多个 pill 按钮不换行，可能挤压。
- Computer Use：`flex-wrap` 更稳，状态文案和按钮可分行。
- 上下空间由 Settings 页面滚动处理。

**主题/i18n**

- 使用 settings/remote/status token；Slack/Computer 文案走 i18n。
- Slack 授权状态文本和错误原因可能较长，主要靠 truncate/换行区分。

### 24. 内置 Ghost 设置页授权入口

**证据**

- Slack Ghost 设置页自绘 HTML，body 13px system font；按钮固定 128px 宽，见 [apps/desktop/resources/builtin-ghosts/cindy-slack/settings.html:14](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/resources/builtin-ghosts/cindy-slack/settings.html:14>)、[apps/desktop/resources/builtin-ghosts/cindy-slack/settings.html:27](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/resources/builtin-ghosts/cindy-slack/settings.html:27>)。
- Atlassian Ghost 设置页同样自绘 HTML，见 [apps/desktop/resources/builtin-ghosts/xd-atlassian/settings.html:11](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/resources/builtin-ghosts/xd-atlassian/settings.html:11>)。
- Google Ghost 设置页同样自绘 HTML，见 [apps/desktop/resources/builtin-ghosts/filo-google/settings.html:9](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/resources/builtin-ghosts/filo-google/settings.html:9>)。
- Feishu Ghost 使用登录态令牌，无 OAuth 输入，只显示身份和测试连接，见 [apps/desktop/resources/builtin-ghosts/cindy-feishu/settings.html:5](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/resources/builtin-ghosts/cindy-feishu/settings.html:5>)。

**布局实现**

- 这些是 `cindy-ghost://` 沙箱页内的静态 HTML/CSS，不由 React 登录/Settings 组件控制。
- 基本是流式文档：label row、account list、input row、status。
- 账户行使用 flex，账号名 `overflow:hidden; text-overflow:ellipsis; white-space:nowrap`。

**拉伸行为**

- 宽度由宿主设置面板决定；按钮固定宽或自然宽，输入行多按钮不换行。
- 宿主高度通常按内容量测，页面本身没有完整窗口级居中/滚动策略。
- 授权中状态文案写入 `#status`，会增加高度；无统一 loading 布局。

**主题/i18n/DPI**

- CSS 使用 `var(--text-primary, fallback)` 这类变量，有主题变量时可继承，fallback 是浅色默认。
- HTML 文案硬编码中文，不走 React i18n；多语言下布局长度不可控。
- 系统缩放按 webview/Chromium CSS px 处理。

## 现状与新设计稿的冲突点清单

新设计要求：全屏红底 + Cindy 立绘 + 签名 + CINDY 字标 + 白色输入面板 + 第三方登录圆钮；五者作为一个整体在背景上水平居中，位置关系绝对锁死；任意左右/上下拉伸不破坏相对位置；缩小窗口时按最小适配比例完整可见。

### 必须重写的冲突

1. **现状是“单固定卡片居中”，不是“五要素锁定组合”。** 当前根登录页和 login v2 都把 Logo/表单/按钮放入卡片内部流式堆叠，见 [LoginPage.tsx:32](</Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/components/login/LoginPage.tsx:32>)、[login-v2 LoginPage.tsx:577](</Users/praise/AI-Agent/Claude/projects/Project CINDY/.xdt-worktrees/main-login-audit/apps/desktop/src/renderer/components/login/LoginPage.tsx:577>)。没有一个父级“立绘+签名+字标+面板+圆钮”的设计坐标系。

2. **现状不做整体等比缩放，缩小时会裁切。** login v2 外壳最小组合高度约 670px，高于 BrowserWindow minHeight 600，且 root overflow hidden。新设计要求五要素永远完整可见，必须引入组合画布、基准尺寸、`scale = min(...)` 或等效 min-fit 方案。

3. **状态切换会改变内容高度和元素相对位置。** login v2 各状态由不同表单/列表/按钮在卡片中自然流排版，账号选择、多 social、多 SSO 会改变高度。新设计要求位置关系锁死，需要将输入面板内部变化与外部立绘/签名/字标/第三方圆钮位置解耦。

4. **系统浏览器回调页和 Ghost OAuth 页各自维护独立壳。** `oauthResultPage.ts` 是默认 light/dark 卡片居中；root Ghost 仍有旧 shell。它们不能自动套新红底登录构图，若新设计要求回跳终态一致，需要统一替换 OAuth result shell。

5. **Providers/Ghost/Hook 授权入口属于 Settings 流式布局，不适合直接套首登红底。** 这些入口在设置页卡片、弹窗或沙箱 HTML 中，父容器、滚动和主题均不同。整体替换应区分“首登/登录窗口”与“登录后授权入口”，不要把红底首屏构图强行植入设置页。

6. **主题策略冲突。** 现有登录页颜色完全走主题 token；新稿若指定全屏红底和白色输入面板，需要明确是固定品牌皮肤、login-only token，还是仍随主题变化。系统浏览器结果页当前不能读取 app 自定义主题。

7. **图片资源体系缺口。** 当前只加载 splash/brand logo，`object-contain` 固定 216px；没有 Cindy 立绘、签名、CINDY 字标资源的加载、DPI 版本、裁切边界和组合缩放策略。

### 可复用的模式

1. **窗口 chrome 和 46px 拖拽区可复用。** 登录页已有自绘窗口控制与拖拽区域，替换视觉时仍可保留 macOS hidden titlebar / 非 macOS frameless 策略。

2. **主题 token 注册机制可复用。** 可新增 login-redesign 专属 token，例如红底、白面板、圆钮描边/hover，而不是散落硬编码。

3. **login v2 状态机和 main 侧系统浏览器 flow 可复用。** 需要替换的是呈现层，不是授权状态机本身。

4. **CustomProviderDialog 的 `max-h + body overflow-y-auto` 是可复用的纵向适配经验。** 对登录输入面板内部状态多、表单长的情况，可把“面板内部滚动/裁切”与“五要素整体缩放”分层处理。

5. **OAuth result page 的 `width:min(100%,400px)` 和 480px media query 可作为外部浏览器页的小屏适配参考。** 但视觉壳需要统一成新设计或至少统一品牌语言。

## 替换实现前的关键建议

1. 为新登录页建立一个单独的 `LoginComposition` 坐标系：基准宽高固定，五要素用绝对定位或 CSS grid 坐标锁定，再对整个组合做统一 scale。
2. 明确最小适配比例和窗口 minHeight 是否要从 600 上调；如果不改 BrowserWindow minHeight，就必须在 800x600 内完整验证组合缩放。
3. 把输入面板内部状态机渲染限制在面板内部，不让状态高度改变立绘/签名/字标/第三方圆钮的位置。
4. 统一首登等待态、错误态、回跳后提示态的视觉：避免 `return null` 或旧卡片终态破坏整套登录体验。
5. 分开处理 Settings 授权入口：保留设置页流式行/弹窗，只同步按钮/icon/文案语言，不套首登红底构图。
