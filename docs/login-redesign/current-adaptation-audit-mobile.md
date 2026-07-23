# Cindy 移动端登录 UI 现状适配盘查

> 范围：`apps/mobile`（Expo / React Native / expo-router）中登录、鉴权回跳、启动门、登出回登录相关 UI 与承载组件。本文只盘查现状，不改源码。

## 结论摘要

- 当前项目内可见登录 UI 主要集中在 `apps/mobile/app/(auth)/login.tsx`，是一套 token 化黑白灰工作台风格：标题、说明、一个「飞书登录」主按钮、开发调试入口与底部调试 sheet。
- 登录状态流由 `apps/mobile/src/auth/AuthContext.tsx` 管理，但账号选择、企业 SSO 授权、绑定确认等 UI 不在 RN 代码内，分别由飞书 App、系统浏览器 / `expo-web-browser` 或服务端回跳承载。
- 登录页没有 `Dimensions` / `useWindowDimensions` / 断点 / 缩放模型，也没有插画、签名、字标等图片资源；适配主要依赖 `flex: 1`、`justifyContent: "space-between"`、固定 token 间距和 `SafeAreaView`。
- Figma 目标登录帧已读到两档：`750 x 1624` 与 `750 x 1334`（@2x 逻辑宽 375pt）；设计意图是登录面板尺寸固定，上方立绘 / 签名 / 字标随高度压缩。
- 当前 app 配置允许横竖屏与 iPad：`orientation: "default"`，iOS 显式支持 portrait / upside-down / landscape，且 `supportsTablet: true`。登录页本身没有横屏 / 平板专用布局。
- 字体缩放由全局 `AppText` 封顶到 `maxFontSizeMultiplier = 1.2`；暗色模式跟随系统；可见文案基本是硬编码中文，未见移动端 i18n 层。

## Figma 读取结果

已按补充 nodeId 直接读取 `fileKey=xNK3qh7zVfrO3zrKj5tEf8`，未再请求巨型根节点 `0:1`。

设计稿只有两档分辨率：`750 x 1624` 与 `750 x 1334`，按 @2x 逻辑宽 375pt 折算，分别对应约 `375 x 812pt` 与 `375 x 667pt`。以下坐标均为 Figma px；实现到 React Native 时可先除以 2 得到 375pt 设计坐标，再按实际宽度缩放。

### 登录帧参数

**国区 750 x 1624：`132:2741` / `Log in_iPhone_750x1624`**

| 元素 | x | y | w | h | 备注 |
|---|---:|---:|---:|---:|---|
| frame | 0 | 0 | 750 | 1624 | 背景红 `#df0c27` |
| Status Bar | 0 | 0 | 750 | 115.672 | 白色系统栏 mock |
| `CINDY_mobile` | 0 | 96 | 750 | 902 | 立绘组 instance；symbol `347:2707` 外框为 `750 x 902` |
| `SLOGAN` | 289 | 659 | 460 | 134 | 内部 vector `98,27,321,92` |
| `WORD_MARK` | 0 | 793 | 750 | 180 | 内部 `CINDY_Standard_White` 为 `175,21,401,137` |
| `Log_in` | 35 | 973 | 680 | 560 | 登录整体组；水平居中 |
| `Log_in_bg` | 0 | 0 | 680 | 440 | 白面板 `#fbfbfb`，圆角 36 |
| 标题 | 222 | 31 | 236 | 38 | `欢迎使用 CINDY`，HarmonyOS Sans SC Bold 32，`#252222` |
| 副标题 | 41 | 75 | 599 | 23 | `选择一种方式安全登录`，HarmonyOS Sans SC Regular 20，`#6f6f6f` |
| 输入框 `input_2` | 70 | 158 | 540 | 80 | `#eee`，border `#d4d4d4`，圆角 40；placeholder 24，`#d4d4d4` |
| 主按钮 `log_in_button` | 70 | 300 | 540 | 80 | `#2a2828`，border `#434343`，圆角 40；文字 `继续` 24，`#d4d4d4` |
| 第三方入口 | 225 | 480 | 230 | 80 | 可见两个圆钮：Apple `0,0,80,80`；SSO `150,0,80,80`；中间 gap 70 |

**国区 750 x 1334：`347:2662` / `Log in_iPhone_750x1334`**

| 元素 | x | y | w | h | 与 1624 档差异 |
|---|---:|---:|---:|---:|---|
| frame | 0 | 0 | 750 | 1334 | 同宽、短高 |
| Status Bar | 0 | 0 | 750 | 115.672 | 不变 |
| `CINDY_mobile` | 75 | 107 | 599 | 720 | 约 0.799 倍缩放并水平居中 |
| `SLOGAN` | 385 | 458.965 | 364 | 106.035 | 约 0.791 倍，靠右 |
| `WORD_MARK` | 45 | 576 | 660 | 158.4 | 约 0.88 倍；内部字标 `154,18.479,352.928,120.544` |
| `Log_in` | 35 | 734 | 680 | 560 | 登录组尺寸不变，上移 239 |
| `Log_in_bg` / 输入框 / 主按钮 / 标题 / 副标题 / 第三方入口 | 同 1624 档 | 同 1624 档 | 同 1624 档 | 同 1624 档 | 面板内部完全不缩放 |

**国际区 750 x 1624：`347:2857` / `Log in_iPhone_750x1624`**

- 上方立绘、签名、字标、登录组位置与国区 `132:2741` 一致。
- 登录标题改为 title group：`x=0 y=31 w=680 h=38`，标题文字 `x=185 y=0 w=236 h=38`，右侧 `Global` pill `x=425 y=4 w=70 h=30`，pill 内文字 `x=11 y=6 w=49 h=19`。
- 第三方入口从国区两个变为三个：`x=150 y=480 w=380 h=80`，圆钮位于 `x=0 / 150 / 300`，每个 `80 x 80`，gap 70。

**国际区 750 x 1334：`347:2884` / `Log in_iPhone_750x1334`**

- 上方压缩规则与国区 `347:2662` 一致。
- 标题 group 与国际区 1624 档一致：`x=0 y=31 w=680 h=38`，`Global` pill `x=425 y=4 w=70 h=30`。
- 第三方入口与国际区 1624 档一致：`x=150 y=480 w=380 h=80`，三枚 `80 x 80` 圆钮。

### 立绘与回调页参考

- `CINDY_mobile` symbol：`347:2707`，外框 `750 x 902`。design context 展开显示内部 Cindy 图层约为 `x=15 y=78 w=703 h=703`，通过 mask 使用图片资源裁切。
- White 成功回调页：`347:3066`，frame `750 x 1623`；背景浏览器截图 `0,0,750,1623`；内容底色块 `0,160,750,1315`，`#eee`；成功卡片 `35,251,680,680`，`#fbfbfb`，border `#d4d4d4`，圆角 36；emoji `200,60,280,280`；标题 `42,352,598,38`；说明 `41,396,599,23`；按钮 `70,529,540,80`。
- Dark 成功回调页：`347:3052`，frame `750 x 1623`；内容底色块 `0,171,750,1315`；成功卡片 `35,251,680,680`；emoji、标题、说明、按钮位置与 White 一致；按钮组件为 `white_button`。

### 从两档高度可推导的设计意图

- 登录白面板和第三方入口在两个高度档中尺寸不变：`Log_in` 始终 `680 x 560`，面板始终 `680 x 440`，输入框 / 按钮始终 `540 x 80`，第三方圆钮始终 `80 x 80`。
- 高度不足时，优先缩放和上移上方立绘 / 签名 / 字标，而不是压缩登录面板。`CINDY_mobile` 从 `750 x 902` 缩到 `599 x 720`，但 `Log_in` 不缩放。
- 底部留白不是简单固定值：1624 档 `Log_in` bottom 为 `91px`，1334 档 bottom 为 `40px`。短屏优先把登录组贴近底部安全区上方，长屏保留更大呼吸感。
- 国区与国际区几何共用同一套高度规则；差异只在标题 `Global` 标识和第三方入口数量 / 起始 x。

### 五要素绝对坐标与间距

下表把五个需要锁定位置关系的设计要素抽成实现可直接消费的绝对坐标。国区 / 国际区的上方三要素与白面板坐标相同；第三方圆钮因地区不同而有不同起始 x 与数量。

| 要素 | 750x1624 绝对坐标 | 750x1334 绝对坐标 | 高度压缩差值 |
|---|---|---|---|
| 立绘 `CINDY_mobile` | `x=0 y=96 w=750 h=902` | `x=75 y=107 w=599 h=720` | 宽约 `0.799x`，高约 `0.798x`；top 下移 `+11`，bottom 从 `998` 上移到 `827` |
| 手写签名 `SLOGAN` frame | `x=289 y=659 w=460 h=134` | `x=385 y=458.965 w=364 h=106.035` | 宽高约 `0.791x`；x 右移 `+96`，y 上移 `-200.035` |
| CINDY 字标 `WORD_MARK` frame | `x=0 y=793 w=750 h=180` | `x=45 y=576 w=660 h=158.4` | 宽高约 `0.88x`；x 右移 `+45`，y 上移 `-217` |
| CINDY 字标实际图片 | `x=175 y=814 w=401 h=137` | `x=199 y=594.479 w=352.928 h=120.544` | 宽高约 `0.88x`；y 上移 `-219.521` |
| 白色输入面板 `Log_in_bg` | `x=35 y=973 w=680 h=440` | `x=35 y=734 w=680 h=440` | 尺寸不变；y 上移 `-239` |
| 登录整体组 `Log_in` | `x=35 y=973 w=680 h=560` | `x=35 y=734 w=680 h=560` | 尺寸不变；y 上移 `-239` |
| 国区第三方入口 group | `x=260 y=1453 w=230 h=80` | `x=260 y=1214 w=230 h=80` | 尺寸不变；y 上移 `-239` |
| 国区圆钮 | Apple `260,1453,80,80`；SSO `410,1453,80,80` | Apple `260,1214,80,80`；SSO `410,1214,80,80` | 圆钮尺寸 / 水平 gap 不变 |
| 国际区第三方入口 group | `x=185 y=1453 w=380 h=80` | `x=185 y=1214 w=380 h=80` | 尺寸不变；y 上移 `-239` |
| 国际区圆钮 | `185,1453,80,80` / `335,1453,80,80` / `485,1453,80,80` | `185,1214,80,80` / `335,1214,80,80` / `485,1214,80,80` | 三枚圆钮尺寸 / 水平 gap 不变 |

关键间距：

- 1624 档：`SLOGAN` frame bottom `793` 与 `WORD_MARK` top `793` 相接；`WORD_MARK` bottom `973` 与 `Log_in` top `973` 相接；白面板 bottom `1413` 到第三方入口 top `1453` 为 `40`；第三方入口 bottom `1533` 到屏幕 bottom 为 `91`。
- 1334 档：`SLOGAN` bottom `565` 到 `WORD_MARK` top `576` 为 `11`；`WORD_MARK` bottom `734.4` 与 `Log_in` top `734` 基本相接（四舍五入约 `-0.4` overlap）；白面板 bottom `1174` 到第三方入口 top `1214` 仍为 `40`；第三方入口 bottom `1294` 到屏幕 bottom 为 `40`。
- 面板内部在两档高度完全一致：标题 top `31`，副标题 top `75`，输入框 `x=70 y=158 w=540 h=80`，主按钮 `x=70 y=300 w=540 h=80`；输入框与按钮垂直 gap 为 `62`，按钮 bottom 到白面板 bottom 为 `60`。
- 国际区 `Global` 标识只影响面板标题行：title group `x=0 y=31 w=680 h=38`，标题文字相对 group `x=185 y=0 w=236 h=38`，`Global` pill 相对 group `x=425 y=4 w=70 h=30`。第三方入口从国区 `x=225 w=230` 改为 `x=150 w=380`（相对 `Log_in`），以容纳三枚圆钮。

## 登录相关 UI 清单

本次登记 13 个登录相关 UI surface；其中项目内直接可替换的 screen / route 主要是 `login`、启动门 `index` / `_layout`、设置页登出区，另有系统 / 飞书外部授权界面。

| # | 界面 / 状态 | 代码位置 |
|---|---|---|
| 1 | 原生启动 / Splash 到 JS 的衔接 | `apps/mobile/app.json:7`, `apps/mobile/app.json:9`; 未见显式 `SplashScreen` 代码 |
| 2 | 自建 OTA 启动检查 loading | `apps/mobile/app/_layout.tsx:79`, `apps/mobile/app/_layout.tsx:84`, `apps/mobile/src/components/CenteredScreen.tsx:6` |
| 3 | 冷启动恢复登录态 loading | `apps/mobile/app/index.tsx:6`, `apps/mobile/app/index.tsx:8`, `apps/mobile/app/index.tsx:11` |
| 4 | 登录态导航守卫 | `apps/mobile/app/_layout.tsx:22`, `apps/mobile/app/_layout.tsx:28`, `apps/mobile/app/_layout.tsx:31`, `apps/mobile/app/_layout.tsx:35` |
| 5 | 登录入口主屏 | `apps/mobile/app/(auth)/login.tsx:67` |
| 6 | 配置缺失反馈 | `apps/mobile/app/(auth)/login.tsx:27`, `apps/mobile/app/(auth)/login.tsx:81`, `apps/mobile/src/config/env.ts:70` |
| 7 | 等待飞书 / 浏览器授权状态 | `apps/mobile/app/(auth)/login.tsx:92`, `apps/mobile/src/auth/AuthContext.tsx:399`, `apps/mobile/src/auth/AuthContext.tsx:427` |
| 8 | 登录失败反馈 | `apps/mobile/app/(auth)/login.tsx:78`, `apps/mobile/src/auth/oauthCallback.ts:6`, `apps/mobile/src/auth/AuthContext.tsx:447` |
| 9 | 企业 SSO / 飞书 App 原生入口 | `apps/mobile/src/auth/AuthContext.tsx:411`, `apps/mobile/src/auth/feishuNativeLogin.ts:20`, `apps/mobile/modules/xdt-feishu-login/ios/XdtFeishuLoginModule.swift:18`, `apps/mobile/modules/xdt-feishu-login/android/src/main/java/com/xdtmaker/feishulogin/XdtFeishuLoginModule.kt:25` |
| 10 | 系统浏览器 OAuth / 账号选择 / 授权 | `apps/mobile/src/auth/AuthContext.tsx:352`, `apps/mobile/src/auth/AuthContext.tsx:427`; UI 在系统浏览器 / 飞书网页，不在 RN 内 |
| 11 | 开发调试 sheet / mock 登录 | `apps/mobile/app/(auth)/login.tsx:105`, `apps/mobile/app/(auth)/login.tsx:119`, `apps/mobile/app/(auth)/login.tsx:156` |
| 12 | callback URL 手动输入 / deep link 回跳 | `apps/mobile/app/(auth)/login.tsx:170`, `apps/mobile/app/+native-intent.ts:16`, `apps/mobile/src/auth/AuthContext.tsx:441` |
| 13 | 登出后回登录页 | `apps/mobile/app/settings.tsx:372`, `apps/mobile/app/settings.tsx:612`, `apps/mobile/app/settings.tsx:620` |

## 按“8 状态流 + 企业 SSO”口径映射

| 任务口径 | 现状落点 | 备注 |
|---|---|---|
| 入口 | `apps/mobile/app/(auth)/login.tsx:67` 至 `apps/mobile/app/(auth)/login.tsx:103` | 项目内唯一正式入口，一个「飞书登录」按钮 |
| 输入 | 正式路径输入在飞书 App / 系统浏览器；项目内仅 dev sheet 的 callback URL 输入，见 `apps/mobile/app/(auth)/login.tsx:170` | 新设计若有手机号 / 邮箱 / code 输入，需要新增正式输入面板和键盘避让 |
| 等待浏览器授权 | `auth.isBusy` 驱动按钮 busy，见 `apps/mobile/app/(auth)/login.tsx:92`、`apps/mobile/src/components/MobilePrimitives.tsx:579` | 没有独立“等待授权”页面或 overlay |
| 账号选择 | 飞书 App / 浏览器 OAuth 外部 UI，触发点 `apps/mobile/src/auth/AuthContext.tsx:427` | RN 内不可替换 |
| 绑定 | 未见移动端 RN 绑定 UI；登录成功后保存 token/user 并进入首页，见 `apps/mobile/src/auth/AuthContext.tsx:663` 至 `apps/mobile/src/auth/AuthContext.tsx:671` | 若新稿要求“账号绑定 / 设备绑定”确认页，需要新增状态 |
| 完成反馈 | `isAuthenticated` 后 `NavigationGate` 立即 `router.replace("/")`，见 `apps/mobile/app/_layout.tsx:35` | 无完成页 / 成功动画 |
| 失败反馈 | 登录页内联错误块，见 `apps/mobile/app/(auth)/login.tsx:78`；deep link 错误写入 `authError`，见 `apps/mobile/src/auth/AuthContext.tsx:452` | 无失败页 |
| deep link 回跳处理 UI | `+native-intent` 把 `/auth` 改回 `/`，见 `apps/mobile/app/+native-intent.ts:16`；交换 code 在 `AuthContext` listener 内完成，见 `apps/mobile/src/auth/AuthContext.tsx:441` | 无单独回跳页，成功跳首页，失败回登录页错误块 |
| 企业 SSO 入口 | 同一「飞书登录」按钮下的 native path，见 `apps/mobile/src/auth/AuthContext.tsx:411` 至 `apps/mobile/src/auth/AuthContext.tsx:425` | native SSO UI 由飞书 SDK / App 承载 |

## 全局适配事实

**导航与路由**

- 根布局是 `SafeAreaProvider -> ThemeProvider -> AuthProvider -> DeviceLinkProvider -> NavigationGate`，见 `apps/mobile/app/_layout.tsx:90` 至 `apps/mobile/app/_layout.tsx:100`。
- `NavigationGate` 根据 `segments[0] === "(auth)"` 与 `auth.isAuthenticated` 做 `router.replace("/login")` / `router.replace("/")`，见 `apps/mobile/app/_layout.tsx:28` 至 `apps/mobile/app/_layout.tsx:38`。
- `Stack` 全局 `headerShown: false`，登录页没有导航栏，见 `apps/mobile/app/_layout.tsx:43` 至 `apps/mobile/app/_layout.tsx:52`。
- OAuth deep link 的 `/auth` 不映射到一个可见页面，`+native-intent` 只把它重写回 `/`，见 `apps/mobile/app/+native-intent.ts:16` 至 `apps/mobile/app/+native-intent.ts:23`。

**横竖屏 / 平板**

- `apps/mobile/app.json:7` 为 `orientation: "default"`。
- iOS `UISupportedInterfaceOrientations` 同时列出竖屏、倒竖屏和两个横屏方向，见 `apps/mobile/app.json:22` 至 `apps/mobile/app.json:33`。
- `supportsTablet: true`，见 `apps/mobile/app.json:39`。
- 登录页没有 `useWindowDimensions` / `Dimensions.get` / 平板断点；同仓其它页面有专门的尺寸模型，但登录页未使用。

**字体缩放**

- 全局文字组件 `Text` / `TextInput` 注入 `maxFontSizeMultiplier={1.2}`，见 `apps/mobile/src/components/AppText.tsx:16` 至 `apps/mobile/src/components/AppText.tsx:24`。
- 登录页所有 RN 文本来自 `@/components/AppText`，见 `apps/mobile/app/(auth)/login.tsx:8`。
- 这意味着系统字号会响应但最高 1.2 倍；登录页标题、说明、错误块无逐屏重排策略，长文案靠自然换行。

**暗色模式**

- `app.json` 使用 `userInterfaceStyle: "automatic"`，见 `apps/mobile/app.json:9`。
- `ThemeProvider` 通过 `useColorScheme()` 选择 light / dark palette，见 `apps/mobile/src/theme/ThemeProvider.tsx:15` 至 `apps/mobile/src/theme/ThemeProvider.tsx:19`。
- 登录页所有颜色走 `useThemedStyles(makeStyles)` / `useTheme()`，见 `apps/mobile/app/(auth)/login.tsx:20` 至 `apps/mobile/app/(auth)/login.tsx:21`。

**i18n**

- 移动端登录相关可见文案是硬编码中文，例如 `远程控制台`、`飞书登录`、`开发调试`、`用 callback URL 完成登录`，见 `apps/mobile/app/(auth)/login.tsx:71` 至 `apps/mobile/app/(auth)/login.tsx:97`、`apps/mobile/app/(auth)/login.tsx:137` 至 `apps/mobile/app/(auth)/login.tsx:187`。
- 未见登录页接入 `useTranslation` / locale 文案资源。国际区设计需要单独补文案长度与换行规则。

**Hover / 触摸交互态**

- 代码盘查命令：`rg -n --glob '!node_modules/**' "hover|hovered|onHover|onMouse|mouseEnter|mouseLeave|:hover" apps/mobile`。
- 登录相关 RN 代码未见 `hovered`、`onHoverIn`、`:hover` 或 mouse event 样式；当前按钮 / 行组件主要处理 `pressed`、`disabled`、`busy`、`selected / active` 等触摸语义，见 `apps/mobile/src/components/MobilePrimitives.tsx:556` 至 `apps/mobile/src/components/MobilePrimitives.tsx:575`。
- 搜到的 hover 仅出现在移动端文档或非登录代码注释中，例如 `apps/mobile/docs/mobile-current-execution-plan.md:164`、`apps/mobile/src/session/MobileModelPickerList.tsx:7`、`apps/mobile/src/session/ModelOptionsSheetView.tsx:5`，语义是“桌面 hover 转为手机长按 / sheet / 常驻触摸入口”，不是 RN hover 样式。
- 结论：客户端和移动端可共用设计与组件语义，但移动端不需要迁移组件库 hover 状态；登录新实现只需要定义 press / active / focus / disabled / busy 等触摸态。

## 逐界面适配审计

### 1. 原生启动 / Splash 到 JS 衔接

- 文件路径：`apps/mobile/app.json:7`, `apps/mobile/app.json:9`；未见 `SplashScreen.preventAutoHideAsync` / `hideAsync`。
- 布局实现：原生启动画面由 Expo 默认配置接管；仓库有 `assets/splash-icon.png`，但 `app.json` 未显式声明 `splash` 配置。
- Safe area：原生启动阶段不走 RN safe-area；进入 JS 后由 `_layout` 挂 `SafeAreaProvider`。
- 尺寸 / 宽高比：无项目内适配规则。
- 键盘 / 横竖屏：启动阶段无键盘；方向跟随 app 全局 `orientation: "default"`。
- 字体缩放 / 暗色 / i18n：不适用或由系统 / Expo 默认启动画面处理。
- 图片资源：当前登录替换所需立绘、签名、字标均未在启动配置中出现。

### 2. 自建 OTA 启动检查 loading

- 文件路径：`apps/mobile/app/_layout.tsx:79` 至 `apps/mobile/app/_layout.tsx:88`，`apps/mobile/src/components/CenteredScreen.tsx:6` 至 `apps/mobile/src/components/CenteredScreen.tsx:15`。
- 布局实现：`GestureHandlerRootView flex:1` 下渲染 `CenteredScreen`；内部 `View flex:1`、`alignItems:"center"`、`justifyContent:"center"`、`gap`、`padding`，见 `CenteredScreen.tsx:18` 至 `CenteredScreen.tsx:36`。
- Safe area：只有 `SafeAreaProvider`，没有 `SafeAreaView`；居中内容可能进入状态栏 / home indicator 的视觉区域，但中心布局通常影响不大。
- 尺寸 / 宽高比：无 `useWindowDimensions`，所有屏幕居中；平板和横屏会在全屏中心显示小 loading。
- 键盘 / 横竖屏：无键盘；全局支持横竖屏。
- 字体缩放 / 暗色 / i18n：使用 `AppText`，fontScale 封顶 1.2；颜色跟随主题；文案硬编码中文 `正在检查更新`。
- 图片资源：无图片，只有 `ActivityIndicator`。

### 3. 冷启动恢复登录态 loading

- 文件路径：`apps/mobile/app/index.tsx:6` 至 `apps/mobile/app/index.tsx:12`。
- 布局实现：`!auth.initialized` 时复用 `CenteredScreen title="XDMaker" subtitle="正在恢复登录状态"`；初始化完成后未登录直接 `<Redirect href="/login" />`。
- Safe area：同 `CenteredScreen`，无 `SafeAreaView`。
- 尺寸 / 宽高比：无缩放 / 断点；居中 loading 在平板 / 横屏不扩展内容。
- 键盘 / 横竖屏：无键盘；全局横竖屏。
- 字体缩放 / 暗色 / i18n：同 `CenteredScreen`；中文硬编码。
- 图片资源：无图片。

### 4. 登录态导航守卫

- 文件路径：`apps/mobile/app/_layout.tsx:22` 至 `apps/mobile/app/_layout.tsx:38`。
- 布局实现：不直接渲染可见 UI，只在 effect 中按登录态切路由。
- Safe area：不直接处理；由目标页面决定。
- 尺寸 / 宽高比：不适用。
- 键盘 / 横竖屏：不适用。
- 字体缩放 / 暗色 / i18n：不适用。
- 图片资源：无。
- 风险：新设计若需要“完成态动画 / 绑定成功页”，当前逻辑会在 `user !== null` 后立即 `replace("/")`，没有完成页停留点。

### 5. 登录入口主屏

- 文件路径：`apps/mobile/app/(auth)/login.tsx:67` 至 `apps/mobile/app/(auth)/login.tsx:103`；样式见 `apps/mobile/app/(auth)/login.tsx:201` 至 `apps/mobile/app/(auth)/login.tsx:263`。
- 布局实现：根是 `SafeAreaView flex:1`；内部 `shell flex:1`，`justifyContent:"space-between"`，`paddingHorizontal: spacing.xl`，`paddingVertical: spacing.xxl`。品牌块是普通 `View` + `gap`，按钮是 `MainWindowActionButton`。
- 绝对定位 / 百分比 / Dimensions：主屏没有绝对定位、没有百分比定位、没有 `Dimensions` / `useWindowDimensions`。
- Safe area：使用 `react-native-safe-area-context` 的 `SafeAreaView`，默认四边避让 notch / 灵动岛 / home bar。
- 小屏 / 大屏 / 平板：没有断点。小屏或横屏下，长副标题、错误块、配置面板和按钮都在同一个非滚动 `shell` 中，可能挤压；大屏 / 平板只扩大空白，不限制最大宽。
- 键盘避让：主屏没有输入框，无 `KeyboardAvoidingView`。
- 横竖屏：跟随全局，登录页自身不锁竖屏。
- 字体缩放：`Text` 由 `AppText` 封顶 1.2；标题 `typeScale.hero=40`，副标题 `typeScale.body=16`。
- 暗色模式：背景、文字、按钮颜色全部走 theme token；不是新设计的红色品牌面。
- i18n：中文硬编码，副标题长句自然换行，无英文 / 国际区长度策略。
- 图片资源：无 `Image` / `ImageBackground`，没有当前登录插画。

### 6. 配置缺失反馈

- 文件路径：`apps/mobile/app/(auth)/login.tsx:27` 至 `apps/mobile/app/(auth)/login.tsx:32`，`apps/mobile/app/(auth)/login.tsx:81` 至 `apps/mobile/app/(auth)/login.tsx:90`，`apps/mobile/src/config/env.ts:70` 至 `apps/mobile/src/config/env.ts:82`。
- 布局实现：当 `EXPO_PUBLIC_FEISHU_APP_ID` 缺失时，在登录页主内容内插入 `configPanel`，`borderWidth: hairlineWidth`、`gap`、`padding`。
- Safe area：继承登录页 `SafeAreaView`。
- 小屏 / 大屏 / 平板：无滚动容器；如果配置项增多或文字变长，会与主按钮共同挤压垂直空间。
- 键盘 / 横竖屏：无键盘；横屏无特殊处理。
- 字体缩放 / 暗色 / i18n：使用 token 字号和颜色；中文硬编码。
- 图片资源：无。

### 7. 等待飞书 / 浏览器授权状态

- 文件路径：`apps/mobile/app/(auth)/login.tsx:92` 至 `apps/mobile/app/(auth)/login.tsx:103`，`apps/mobile/src/components/MobilePrimitives.tsx:539` 至 `apps/mobile/src/components/MobilePrimitives.tsx:595`，`apps/mobile/src/auth/AuthContext.tsx:399` 至 `apps/mobile/src/auth/AuthContext.tsx:439`。
- 布局实现：仍是登录页主屏；`auth.isBusy` 让 `MainWindowActionButton` disabled，并用 `ActivityIndicator` 替换按钮文本。
- Safe area：继承登录页。
- 小屏 / 大屏 / 平板：无变化；busy 只改变按钮内部内容。
- 键盘 / 横竖屏：无键盘；横屏无特殊处理。
- 字体缩放 / 暗色 / i18n：按钮 label / accessibility 中文硬编码；ActivityIndicator 颜色跟随 theme。
- 图片资源：无。
- 状态边界：点击后如果走系统浏览器 / 飞书 App，主要授权 UI 离开 RN；RN 内没有“等待浏览器授权”的全屏中间页，只有回到 app 后可能仍显示 busy 或错误。

### 8. 登录失败反馈

- 文件路径：`apps/mobile/app/(auth)/login.tsx:39` 至 `apps/mobile/app/(auth)/login.tsx:47`，`apps/mobile/app/(auth)/login.tsx:78` 至 `apps/mobile/app/(auth)/login.tsx:80`，`apps/mobile/src/auth/oauthCallback.ts:6` 至 `apps/mobile/src/auth/oauthCallback.ts:23`，`apps/mobile/src/auth/AuthContext.tsx:447` 至 `apps/mobile/src/auth/AuthContext.tsx:454`。
- 布局实现：错误以登录页中间的 `Text` 块显示，带边框、圆角、padding；不是 toast / modal。
- Safe area：继承登录页。
- 小屏 / 大屏 / 平板：错误文本无限自然换行；无滚动，长错误可能挤压按钮。
- 键盘 / 横竖屏：主错误无键盘；横屏无特殊处理。
- 字体缩放 / 暗色 / i18n：错误文字颜色是黑白系 `errorText`，边框跟随 `errorBorder`；文案中文硬编码，部分错误来自原生 / 网络异常 `err.message`。
- 图片资源：无。
- 状态边界：没有独立“失败页”；失败后仍停留登录页。

### 9. 企业 SSO / 飞书 App 原生入口

- 文件路径：JS 入口 `apps/mobile/src/auth/AuthContext.tsx:411` 至 `apps/mobile/src/auth/AuthContext.tsx:425`；检测封装 `apps/mobile/src/auth/feishuNativeLogin.ts:20` 至 `apps/mobile/src/auth/feishuNativeLogin.ts:31`；iOS `apps/mobile/modules/xdt-feishu-login/ios/XdtFeishuLoginModule.swift:18` 至 `apps/mobile/modules/xdt-feishu-login/ios/XdtFeishuLoginModule.swift:42`；Android `apps/mobile/modules/xdt-feishu-login/android/src/main/java/com/xdtmaker/feishulogin/XdtFeishuLoginModule.kt:25` 至 `apps/mobile/modules/xdt-feishu-login/android/src/main/java/com/xdtmaker/feishulogin/XdtFeishuLoginModule.kt:65`。
- 布局实现：项目内没有 SSO 页面；同一个「飞书登录」按钮触发原生 SDK。账号选择、企业确认、授权 UI 由飞书 App / SDK 承载。
- Safe area：外部 UI 不受 RN safe-area 规则控制。
- 小屏 / 大屏 / 平板：由飞书 App / SDK 决定；本项目无断点。
- 键盘 / 横竖屏：外部 UI 决定；JS 侧只设置 8 秒前台超时，见 `apps/mobile/src/auth/AuthContext.tsx:47` 与 `apps/mobile/src/auth/AuthContext.tsx:81` 至 `apps/mobile/src/auth/AuthContext.tsx:139`。
- 字体缩放 / 暗色 / i18n：外部 UI 决定；iOS / Android native SDK 里显式设置中文：iOS `LarkSSO.setupLang("zh")`，Android `.setLanguage("zh")`。
- 图片资源：外部 UI 决定。
- 状态边界：若 native 未启用、未安装飞书、唤起失败或超时，会 fallback 到浏览器 OAuth；一旦已拿到 native code，换 token 失败直接暴露错误，不再 fallback。

### 10. 系统浏览器 OAuth / 账号选择 / 授权

- 文件路径：构造授权 URL `apps/mobile/src/auth/AuthContext.tsx:352` 至 `apps/mobile/src/auth/AuthContext.tsx:383`；打开系统会话 `apps/mobile/src/auth/AuthContext.tsx:427` 至 `apps/mobile/src/auth/AuthContext.tsx:435`；scope `apps/mobile/src/config/env.ts:114` 至 `apps/mobile/src/config/env.ts:120`。
- 布局实现：项目内没有浏览器授权页；通过 `WebBrowser.openAuthSessionAsync(authUrl, "lizcn://auth")` 打开系统浏览器授权。
- Safe area：系统浏览器 / ASWebAuthenticationSession 决定。
- 小屏 / 大屏 / 平板：外部浏览器决定。
- 键盘 / 横竖屏：账号输入、密码、企业选择均在外部浏览器；RN 不处理键盘避让。
- 字体缩放 / 暗色 / i18n：外部网页决定；本项目只申请 `contact:user.email:readonly`。
- 图片资源：外部网页决定。
- 状态边界：没有项目内“账号选择 / 授权确认 / 绑定”界面，无法用 RN 设计稿 100% 替换这些外部 UI。

### 11. 开发调试 sheet / mock 登录

- 文件路径：入口 `apps/mobile/app/(auth)/login.tsx:105` 至 `apps/mobile/app/(auth)/login.tsx:116`；Modal `apps/mobile/app/(auth)/login.tsx:119` 至 `apps/mobile/app/(auth)/login.tsx:195`；样式 `apps/mobile/app/(auth)/login.tsx:264` 至 `apps/mobile/app/(auth)/login.tsx:319`。
- 布局实现：`Modal transparent presentationStyle="overFullScreen"`；根 `debugModalRoot flex:1 justifyContent:"flex-end"`；半透明 backdrop 是 `StyleSheet.absoluteFill`；sheet 是底部 `SafeAreaView`，固定 padding/gap，无拖拽模型。
- Safe area：sheet 自身使用 `SafeAreaView`，可避让底部 home bar；backdrop 全屏覆盖。
- 小屏 / 大屏 / 平板：无 `ScrollView`，无最大宽；内容较多且含输入框，小屏横屏时存在被键盘或高度挤压风险。
- 键盘避让：含 multiline `TextInput`，但没有 `KeyboardAvoidingView`；键盘弹出时底部 sheet 可能被遮挡。
- 横竖屏：全局支持，sheet 无横屏专用布局。
- 字体缩放 / 暗色 / i18n：使用 `AppText` 和 theme；中文硬编码。
- 图片资源：无。
- 状态边界：仅 `__DEV__ || DEV_LOGIN_ENABLED` 展示，见 `apps/mobile/app/(auth)/login.tsx:28`。

### 12. callback URL 手动输入 / deep link 回跳

- 文件路径：输入区 `apps/mobile/app/(auth)/login.tsx:167` 至 `apps/mobile/app/(auth)/login.tsx:191`；回跳拦截 `apps/mobile/app/+native-intent.ts:16` 至 `apps/mobile/app/+native-intent.ts:23`；deep link 完成 `apps/mobile/src/auth/AuthContext.tsx:441` 至 `apps/mobile/src/auth/AuthContext.tsx:459`；pending 校验 `apps/mobile/src/auth/AuthContext.tsx:602` 至 `apps/mobile/src/auth/AuthContext.tsx:620`。
- 布局实现：手动输入在开发调试 sheet 内，是 multiline `TextInput` + 操作按钮；真实 deep link 回跳没有可见页面，router 只避免 `/auth` 404。
- Safe area：手动输入继承 sheet `SafeAreaView`；真实 deep link 回跳落到 `/` 后由 `index` / `login` 或首页处理。
- 小屏 / 大屏 / 平板：手动输入框 `minHeight:72`，无滚动；长 URL 靠 multiline。
- 键盘避让：没有 `KeyboardAvoidingView`，这是当前登录流程唯一项目内输入框的主要适配缺口。
- 横竖屏：全局支持，输入区无横屏布局。
- 字体缩放 / 暗色 / i18n：placeholder 和按钮中文 / URL 模板硬编码；fontScale 封顶 1.2。
- 图片资源：无。

### 13. 登出后回登录页

- 文件路径：登出逻辑 `apps/mobile/app/settings.tsx:372` 至 `apps/mobile/app/settings.tsx:381`；账号头部 `apps/mobile/app/settings.tsx:420` 至 `apps/mobile/app/settings.tsx:442`；登出区 `apps/mobile/app/settings.tsx:612` 至 `apps/mobile/app/settings.tsx:630`；样式 `apps/mobile/app/settings.tsx:843` 至 `apps/mobile/app/settings.tsx:952`。
- 布局实现：设置页根 `SafeAreaView` + `ScreenHeader` + `ScrollView`；登出按钮用 `MainWindowActionGroup` / `MainWindowActionButton` danger action。登出成功后 `router.replace("/login")`。
- Safe area：设置页使用 `SafeAreaView`；内容在 `ScrollView` 中，底部 `paddingBottom: spacing.xxl`。
- 小屏 / 大屏 / 平板：设置页可滚动，比登录主屏更稳；但无平板最大宽，平板上内容全宽。
- 键盘避让：登出区无键盘；设置页另有设备名 / Key 输入，不属于登录入口，但同文件没有全页 `KeyboardAvoidingView`。
- 横竖屏：全局支持；设置页无横屏专用规则。
- 字体缩放 / 暗色 / i18n：使用 `AppText`、theme token；中文硬编码。
- 图片资源：账号头像可用 `Image source={{ uri: auth.user.avatar }}` 固定 `56 x 56`，无显式 `resizeMode`，见 `apps/mobile/app/settings.tsx:423` 至 `apps/mobile/app/settings.tsx:428` 和 `apps/mobile/app/settings.tsx:859` 至 `apps/mobile/app/settings.tsx:871`。登录页本身无图片。

## 与新设计稿的主要冲突

1. **几何模型冲突**：新设计已给出 750x1624 / 750x1334 两套绝对坐标，要求全屏红底、Cindy 立绘、手写签名、CINDY 字标、白色输入面板、第三方圆钮五要素位置关系锁死；当前登录页是普通 flex 流，没有按设计基准坐标缩放 / 插值的布局模型。
2. **视觉体系冲突**：当前移动端权威规范是黑白灰 token + 自动 light/dark，见 `apps/mobile/docs/mobile-design-guide.md:11` 至 `apps/mobile/docs/mobile-design-guide.md:18`；新设计的红底、白面板和品牌插画会绕过现有 token 语义，需要定义登录页专属品牌 token 或明确豁免。
3. **输入与键盘冲突**：新设计包含白色输入面板；当前正式登录主屏没有输入框，唯一输入在开发调试 sheet，且没有 `KeyboardAvoidingView`。新登录页必须补键盘弹出时立绘、签名、面板如何让位。
4. **横屏 / 平板冲突**：当前 app 全局支持横屏和 iPad，但登录页无横屏 / 平板规则。新设计如果只给两个竖屏分辨率，直接替换会在横屏、iPad、折叠屏上失控。
5. **外部授权不可替换冲突**：账号选择、企业 SSO 授权、浏览器 OAuth 页面不在 RN 内。新设计只能替换发起前、等待中、失败 / 回跳后的项目内 UI，不能 100% 控制飞书 App / 系统浏览器内部画面。
6. **完成态冲突**：当前登录成功后立即 `replace("/")`，没有绑定成功 / 完成反馈页。若新设计包含完成态或失败态专页，需要调整导航状态机。
7. **Hover 状态迁移冲突**：桌面 / 组件库可能定义 hover，但移动端不需要 hover；现状登录相关 RN 代码也没有 hover 样式。新设计交互态应只落到 press / active / focus / disabled / busy，避免把桌面 hover 态迁到触摸端。

## 补齐移动端设计规则的素材清单与初步建议

| 维度 | 还缺什么 | 基于现状代码的初步建议 |
|---|---|---|
| 设计基准 frame | 两档之间、两档之外如何外推；RN 逻辑 pt 与 Figma px 的换算规则 | 以 750px = 375pt 为基准，先除以 2 得到设计 pt，再按实际宽度 `scale = screenWidth / 375` 缩放；布局模型输入应包含 `heightClass`、`localeVariant`、`colorScheme` |
| 750x1334 以下小屏 / 320 宽设备 | 比 SE/8 更短或更窄时，是否继续缩上方元素、缩整体，还是滚动 | 1334 档显示设计意图是“登录面板不缩，上方立绘/签名/字标缩小并上移”。1334 档已经把立绘压到 `0.799x`、签名压到 `0.791x`、字标压到 `0.88x`，且底部留白只剩 `40px`。更小屏建议继续优先保住 `Log_in 680x560` 和 80px 控件，立绘允许进一步裁切 / 降透明 / 隐藏签名；不要压缩输入框和主按钮 |
| 750x1334 到 750x1624 中间高度 | 两档 y/size 是否线性插值 | 建议按设计单位高度在 1334 到 1624 间线性插值：`Log_in.y` 从 `734 -> 973`（差 `239`），第三方入口跟随同差值；`CINDY_mobile` 从 `75,107,599,720` 插到 `0,96,750,902`；`SLOGAN` 从 `385,458.965,364,106.035` 插到 `289,659,460,134`；`WORD_MARK` 从 `45,576,660,158.4` 插到 `0,793,750,180`。`Log_in` 内部尺寸固定 |
| 750x1624 以上大屏手机 | 是否继续放大、还是只增加上下留白 | 建议宽度仍按屏幕缩放，但高度超过 1624 设计单位时冻结五要素相对尺寸，保留 1624 档 `Log_in` bottom `91px` 作为最小长屏底部呼吸值，把多余高度加到顶部红底/整体舞台外边距；不要让立绘和白面板无限放大 |
| 平板 / iPad | 是否支持全屏铺开、居中手机舞台、双栏，还是强制竖屏窄幅 | 现状 `supportsTablet: true`，不能忽略。建议登录页用最大 375pt 或 430pt 左右的居中手机舞台，红底铺满屏幕，不把 `Log_in` 面板拉宽到平板全屏 |
| 极端宽高比 / 折叠屏 | 宽屏、短屏、超长屏的裁切 / 留白策略 | 先把可用区域投影回 375pt 设计宽度。短屏沿 1334 档继续压缩上方元素；超长屏沿 1624 档冻结主体并增加红底留白；宽屏采用居中舞台 |
| 横屏 | 是否允许登录页横屏；若允许，五要素如何重排 | 当前 app 全局允许横屏。若设计不准备横屏，建议 auth route 级锁竖屏；若继续支持，需单独 landscape frame，不建议把 750x1334 竖屏稿强行缩到横屏 |
| Safe area | notch / 灵动岛 / 状态栏、iOS home indicator、Android 导航条的背景和内容避让 | Figma status bar 高 115.672px 是视觉 mock，不能当真实 safe area。红底应延伸到物理屏边；交互面板和第三方按钮按 `useSafeAreaInsets()` 给底部最小保护，短屏以 1334 档 bottom 40px 为最小视觉参考 |
| 键盘弹出 | 输入聚焦时立绘、签名、字标、面板的移动、缩放、淡出优先级 | 当前登录无键盘避让。新实现应使用 `KeyboardAvoidingView` 或键盘高度 hook；键盘出现时锁定白面板内输入框、主按钮可见，优先裁切 / 淡出立绘与签名，不压缩 80px 输入框 / 按钮 |
| fontScale | 文案是否响应系统字号、最大倍率、按钮和输入高度如何变化 | 沿用 `AppText` 1.2 上限；Logo / 签名 / CINDY 字标若是图片，不参与 fontScale；输入 label / error 需要 1.2 倍下的行数规则 |
| 暗色模式 | Figma 的 White / Dark 帧如何与系统 dark mode 对应；红底是否恒定 | 现状自动跟随系统。建议明确登录页是“品牌常量红底 + 面板 White/Dark variant 跟随系统”，还是完全忽略系统 dark mode |
| i18n / 区域 | 国区 / 国际区文案、第三方登录按钮数量、Feishu / Lark / Google / Apple 等 provider 清单 | 当前无 i18n。建议设计侧提供 CN / INTL 双语文案最大长度和按钮排列；国际区不要依赖中文固定短文案 |
| Hover / 触摸态 | 共用组件库是否给 hover、press、active、focus、disabled、busy 分别出状态 | 移动端不实现 hover，也不迁移桌面 hover-only 样式；RN 登录相关现状无 hover 代码。需要补的是 press/active/focus/disabled/busy 的触摸反馈和可访问状态 |
| 第三方圆钮 | Apple / SSO / 国际区第三个 provider 的真实业务映射、禁用 / loading / pressed 态 | Figma 圆钮固定 80x80、间距 70；国区可见 Apple + SSO 两枚，国际区三枚。RN 触控 hit area 可等于或略大于 40pt 视觉圆；pressed / disabled 态用 opacity 或专属 token，loading 不改变布局尺寸 |
| 失败 / 配置缺失 | 错误显示位置、长错误、多行、网络失败、取消登录、state mismatch、缺 App ID | 当前错误是页面内边框文本。新设计需要定义面板内错误区，长错误滚动或折叠，避免撑破五要素位置关系 |
| deep link 回跳 | 从浏览器 / 飞书回 app 时是否展示“正在完成登录”或“登录成功” | 当前无独立回跳页，只由 `AuthContext` 完成后跳首页。建议新增短暂 completion / resolving state，避免回跳后用户看到旧登录页停顿 |
| 资源导出 | Cindy 立绘 mask 图、手写签名、CINDY 字标、Apple/SSO/provider 图标、成功页 emoji 的格式和倍率 | 当前登录无图片。Figma design context 已暴露临时 asset URL，但 7 天过期，不能作为工程资源。建议设计侧导出稳定 PNG/WebP 2x/3x 或 RN 可承载 SVG，并明确 `CINDY_mobile` mask 裁切锚点 |
| 回调成功页 | 是否要在 RN 内新增完成页，或只作为浏览器回调页参考 | 现状 RN 没有完成页；Figma 参考页卡片为 `680x680`，emoji `280x280`，按钮 `540x80`。若新增 RN 完成态，可复用这套卡片几何；若仅服务端浏览器页使用，则移动端只需 deep link resolving/错误兜底 |
| 测试断点 | 需要验收的设备矩阵 | 至少覆盖设计原生两档 `375x812`、`375x667`，外推档 `320x568`、`390x844`、`393x852`、`430x932`、iPad 竖屏、横屏、Android 三键 / 手势导航、fontScale 1.0 / 1.2、键盘打开 |

## 建议的实现护栏

- 在替换 UI 前先把登录页布局抽成纯函数模型，单测锁住设计基准、SE、小屏现代 iPhone、Pro Max、iPad、横屏和键盘态输出。
- 项目内 UI 可替换范围应限定为登录入口、等待中、错误 / 配置缺失、调试兜底、deep link resolving / completion；飞书 App 与系统浏览器内部页面只能通过前后状态衔接，不能承诺视觉 100% 替换。
- 如果新设计只支持竖屏，先决定是否对 auth route 锁竖屏；当前全局横屏和 iPad 支持会让竖屏稿自然暴露到未定义设备。
- 组件与客户端共用时，移动端仅消费触摸语义态；hover 相关 token / 样式 / 动效标记为不迁移，桌面 hover-only 信息需要转成长按、sheet、明确按钮或直接不显示。
- 新设计的品牌红、白面板、暗色版、错误色、第三方 provider 色需要作为登录页专属 token 或明确设计豁免，不能混入现有全局灰阶 token 造成语义污染。

## 未执行项

- 本次是文档盘查，未运行移动端构建、typecheck 或 UI 截图测试。
- Figma 已按补充 nodeId 读取登录帧与回调页元数据；未下载临时 asset URL，也未做截图像素比对。
