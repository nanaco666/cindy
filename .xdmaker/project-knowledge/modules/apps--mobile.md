---
id: apps--mobile
type: module
covers:
  - apps/mobile/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-06T07:24:52.186Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# apps--mobile

## 是什么

XDMaker 手机版(`apps/mobile`,Expo SDK ~56 / React Native 0.85.3 / React 19.2.3,expo-router 文件路由)。它是**纯控制端(control-only client)**:用与桌面端相同的飞书账号登录,发现可控桌面设备,镜像桌面上的活跃会话,发消息、处理待办交互(权限确认 / plan review / ask-user),不在手机本地跑任何 AI agent、不落地本地会话数据库——所有业务状态都活在被控桌面(`apps/desktop` 的 `maker-core`)上,手机只是通过 device-link 协议做远程读写与事件镜像。产品优先级是 **iOS-first**,Android 是护栏轨道(测试覆盖已存在但正式发版 pending)。

## 关键抽象 / 核心代码地标

- **路由骨架**:`app/_layout.tsx` 顶层套 `SafeAreaProvider → ThemeProvider → AuthProvider → DeviceLinkProvider → NavigationGate`;`NavigationGate` 按登录态在 `(auth)/login` 与主路由间跳转。路由树:`app/index.tsx`(设备列表)、`app/devices/[deviceId].tsx`、`app/sessions/[sessionId].tsx` + `new.tsx`、`app/automations/[deviceId].tsx`、`app/files/[sessionId].tsx` + `preview/`、`app/settings.tsx`。`app/+native-intent.ts` 把飞书 OAuth 回跳的 `/auth` intent 重写回 `/`,避免 expo-router 404。
- **鉴权**:`src/auth/AuthContext.tsx` + PKCE(`pkce.ts`)+ `expo-web-browser`/`Linking` 走飞书 OAuth;`secureStorage.ts`(`expo-secure-store`)存 token;`feishuNativeLogin.ts` / `feishuAppLink.ts` 走本地原生模块 `xdt-feishu-login` 做飞书 App 内跳转登录。
- **API 客户端**:`src/api/client.ts` 的 `apiFetchRaw<T>()`,20s 超时 + bearer header + 类型化 `ApiError`;base URL 来自 `src/config/env.ts` 的 `EXPO_PUBLIC_XDT_API_BASE_URL`(默认 `https://xdt-api.magiclizi.com`,对应 `apps/server`)。
- **device-link 集成(核心架构)**:协议契约在 workspace 包 `packages/device-link`(即 [[packages--device-link]],`@lizi/device-link`),手机是该协议的参考控制端实现;`src/device-link/DeviceLinkContext.tsx` 包一层 `DeviceLinkClient`,配 `topicRegistry.ts`(订阅注册)、`rehydrate.ts`(重连后补齐)、`presenceDevices.ts`/`presenceRecovery.ts`(在线状态)、`accessRevoked.ts`(权限被收回处理);`mobileMakerTransport.ts` / `useMobileMakerTransport.ts` 把 device-link 的 `invoke`/`push` 适配成 maker 会话 API;`rnWebSocket.ts` 是 RN 环境下的 WebSocket 适配。WS 地址走 `deviceLinkWsUrl()` → `<DEVICE_LINK_API_BASE_URL>/api/device-link/ws`;本地开发时 `src/config/env.ts` 会从 `:3333` 的 API base 自动派生 `:3335` 的 relay 地址(对应 `apps/device-link-server`)。
- **会话/UI 层**:`src/session/`(约 120 个文件,是整个 app 最大目录)——消息渲染与 markdown/mermaid/math WebView、composer(附件、命令面板、语音输入)、文件浏览与预览、交互/权限/plan-review 面板、队列面板、日程/自动化模型、rewind 预览、远程媒体磁盘缓存。语音输入(`mobileVoiceController.ts`、`mobileRealtimeAudio.ts` 等)走 LiteLLM 网关(Volcengine SAUC → Qwen realtime → OpenAI 兼容 realtime 兜底链),底层用原生模块 `xdt-mobile-realtime-audio`。
- **状态管理**:无 Redux/MobX;用 React Context(`AuthContext`/`DeviceLinkContext`/`ThemeProvider`)+ 一批手写单例 store(`remoteSessionStore.ts`、`revokedDevicesStore.ts`、`remoteScheduleEvents.ts`、`composerDraftStore.ts`、`mobileVoiceHistoryStore.ts`、`mobileHomeListCache.ts`),持久化走 `@react-native-async-storage/async-storage` / `expo-secure-store`,另有内存缓存(`deviceModelMetaCache.ts`、`agentCapabilitiesCache.ts`、`remoteMediaDiskCache.ts`)。
- **三个本地原生 Expo 模块**(`apps/mobile/modules/`):`xdt-feishu-login`(飞书/Lark 原生 SSO,带 Expo config plugin)、`xdt-mobile-realtime-audio`(语音输入实时采集)、`xdt-tapdb`(TapDB/TapTap 分析 SDK,`src/analytics/mobileTapdb.ts` 接入)。app 根目录没有落盘的 `ios/`/`android/` 工程,走标准 managed/prebuild 模式,靠 `app.json` plugins + `app.config.js` 配置。
- **动态配置**:`app.config.js` 按 `EXPO_PUBLIC_APP_VARIANT=beta` 和 `EXPO_PUBLIC_XDT_OTA_SELFHOST=1` 两个开关分支处理 beta 显示名、自建分发的独立 bundle id(iOS/Android 同为 `com.xd.lizcn`,常量分开维护)与 `updates.url`;非 beta / 非自建时必须原样返回 `app.json` 的 config(逐字节),否则会改变 `@expo/fingerprint`。
- **OTA / 版本管理**:`src/update/startupOtaUpdate.ts` + `useStartupOtaGate.ts`(自建线运行时 OTA 拉取)、`bundleUpdate.ts` + `useBundleUpdatePrompt.ts`(更新提示)、`fetchLatestRelease.ts`。`android-version.json` 是自建 Android 线的 `versionCode` 台账(commit 管理,发布前手动 bump)。
- **发版脚本**:`pnpm mobile:release:check|beta|prod`、`mobile:release:ios:{npkg,check,local,ota}`、`mobile:release:android:{npkg,check,local,ota}`、`mobile:beta:add-dev`、`mobile:sim:{start,whoami,rebuild}`——这些命令定义在**仓库根** `package.json`(而非 `apps/mobile/package.json`),因为后者的 `scripts` 字段本身是 `@expo/fingerprint` 的输入源,加脚本会意外拉高 runtime version。所有会调用 EAS 写操作的脚本默认 dry-run,需显式 `--execute`。

## 模块边界

- **workspace 依赖**(`workspace:*`,均在 `src/` 中被直接 import):`@lizi/device-link`(核心,远控协议客户端)、`@lizi/maker-shared`、`@lizi/model-providers`、`@lizi/voice-input-core`。不依赖 `apps/server` / `apps/device-link-server` / `apps/heartbeat-server` 的源码,只在运行时通过 HTTP/WS 调用它们(`API_BASE_URL` / `DEVICE_LINK_API_BASE_URL`)。
- 三个本地原生模块(`xdt-feishu-login`、`xdt-mobile-realtime-audio`、`xdt-tapdb`)通过 `file:./modules/...` 引入,不是 `@lizi/*` workspace 包。
- 被谁依赖:无(app 是消费端末端,不被其它模块 import)。
- 对外接口形态:纯客户端,不暴露 API;唯一的"对外接口"是它作为 device-link 协议里被允许发起 `invoke` 的一方,受桌面端 `packages/device-link` 的 `REMOTE_INVOKE_ALLOWLIST` / `PUSH_FORWARD_ALLOWLIST` 约束——手机无法远程触发桌面本地 UI/shell 副作用、弹窗、鉴权/API key 操作或裸 DB 写入,这条白名单只能在 `packages/device-link` 侧扩展,手机代码单方面改不动这个边界。

## 不要做的事

- 不要在 `app.config.js` 里给非 beta / 非自建分支注入任何随 commit 变化的内容(如 git hash),会静默改变 `@expo/fingerprint`,拖垮所有人的生产 OTA。
- 不要绕开 `mobile:release:*` 脚本直接跑 `eas build` / `eas update` / `eas submit`——脚本负责注入正确的 EAS environment、过滤除 TapDB 白名单外的环境变量;TapTap client token 绝不能提交进 `eas.json`。
- 不要往 `apps/mobile/package.json` 加开发脚本,应加到仓库根 `package.json`(理由见上)。
- 不要用「原生 build number 没变」当作 JS 代码是最新的证据——只有 Metro reload 证据才算;多 worktree 场景下 app 可能悄悄连到另一分支残留的 8081 端口 Metro,先用 `mobile:sim:whoami` 核实。不要用 `CODE_SIGNING_ALLOWED=NO` 编译(会破坏 `expo-secure-store`/keychain)。不要用 Expo Go 或 TestFlight 证明本地源码改动生效——用 `mobile:sim:start` 起的 Metro + iOS development client。
- 不要改动 `bundleIdentifier` / `scheme` / 飞书 appId(生产与 beta 变体共享;仅自建分发变体有意 fork 出 `com.xd.lizcn`(iOS/Android 自建线同名,常量分开维护))——这是人工决策边界,不能被脚本或改动自动化掉。
- 不要再把桌面 `safeStorage` key 当作手机语音输入的运行时凭证来源——现在手机语音走 Settings 里保存的 LiteLLM key;`voice:credential:*` / `test:voice-cloud:*` 系列脚本是历史遗留诊断工具,明确标注不是运行时契约。
- 正式服发版只能从 `main` 手动发(`mobile:release:prod` 会在非 `main` 分支 / 脏 worktree / `HEAD != origin/main` 时拒绝执行),不要从 feature 分支直接发正式版。

## 演进备忘

_仅追加。每次重大改动留一行:日期 - 做了什么 - 原因。_
