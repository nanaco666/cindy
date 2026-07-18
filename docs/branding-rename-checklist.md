# 品牌改名清单（Branding Rename Checklist）

> 状态：authoritative（品牌名收敛与改名操作的执行清单）
> 背景：品牌展示名已收敛到 `packages/maker-shared/src/branding.ts` 的 `BRAND_NAME`（配套 `BRAND_WEBSITE_URL`）。此前 PR #767 已统一过 agent-facing 文案的拼写（`XDT` 前缀连写 / 带空格两种错拼 → `XDMaker`，具体禁词见 guard 脚本的 `FORBIDDEN_TERMS`，本文档不写出字面量以免触发 guard 自身）并建立品牌治理 CI；本文档在其之上回答两个问题：**改名时改哪里**、**改名时哪些绝对不能动**。
> 自动化闸门（CI workflow `brand-terminology.yml` → `pnpm check:brand-terminology`，源自 PR #767）：`scripts/brand-terminology-guard.mjs` 同时负责 (a) 全仓禁错拼变体、(b) locale JSON 禁硬编码品牌名（必须用 `{{appName}}`）。运行时插值的端到端断言在 `apps/desktop/src/renderer/__tests__/i18nBrandPlaceholder.test.ts`。

## 一、改一处即全局生效（常量层）

改 `packages/maker-shared/src/branding.ts`：

| 常量 | 当前值 | 覆盖面 |
|---|---|---|
| `BRAND_NAME` | `Cindy`（2026-07-16 已翻转） | desktop renderer/main 全部展示层字符串；四语言 locale 的 `{{appName}}`（renderer 走 i18next `interpolation.defaultVariables`，main 走 `apps/desktop/src/main/i18n.ts` 的迷你 `t()` 注入）；`packages/lizi-mcps` 的 MCP 工具描述、错误文案、OAuth 授权成功页 |

官网链接不再是品牌常量：原 `BRAND_WEBSITE_URL` 已删除，改为 `config/production-endpoints.json` 的 `websiteUrl`（消费点 `apps/desktop/src/shared/endpoints.ts` 的 `WEBSITE_URL`，由 `check-endpoint-literals` 门禁校验一致）。国内/海外（`cindy.com.cn` / `cindy.app`）不在代码里分支——未来由各分发渠道（bucket）自带的 `production-endpoints.json` 给出不同值。

改完跑：仓库根 `pnpm test:unit` + `pnpm --filter desktop typecheck` + `pnpm check:brand-terminology`。

`scripts/brand-terminology-guard.mjs` 的 `FORBIDDEN_TERMS`：把**旧品牌名及其变体加进禁词表**（`replacement` 指向新名）这一步**推迟到第二节手动清单清扫完成之后**——常量翻转时全仓仍有大量合法的旧名残留（forge 显示名、docs、测试夹具），提前加禁词会让 CI 直接红灯。guard 里的 locale 例外（`settings.remote.keys.nameHint` 全路径豁免 / 架构文档路径）对应的是标识符，改名时不动。（`openForLoginHint` 的豁免已随 2026-07-17 浏览器 profile 翻转移除——profile 显示名已是 Cindy，文案同步后不再含旧品牌。）

⚠️ **LLM 影响评估（规则 10/11）**：`BRAND_NAME` 会进入 MCP 工具描述（prompt 前缀的一部分），改值会一次性打破 Anthropic prompt cache 前缀并可能影响模型对产品的称呼——这是改名的固有代价，发布前按规则 10 要求做一轮缓存率/行为抽查，并在 PR 里写明。

## 二、手动清单（收敛不进常量，改名时逐项处理）

### 打包 / OS 集成（apps/desktop）

- [x]（2026-07-17）打包**显示名**字段全套：NSIS `shortcutName: 'Cindy'`、deb `productName: 'Cindy'`、UTType `Cindy Session Share`、深链 label、mac 权限描述文案、新增 `win32metadata`（CompanyName=XD / ProductName=FileDescription=Cindy，任务管理器显示层）；`installer.nsh` 运行提示与右键菜单**显示文案**改 Cindy，三代快捷方式名（xdt-maker / XDMaker / Cindy）安装与卸载全清理。⚠️ 标识符字段（`executableName`/`appId`/mac `.app` 名）不动，等渠道迁移。
- [x]（2026-07-17）**存量用户快捷方式启动自愈**：`main/windowsShortcutSelfHeal.ts`——差量更新不重跑安装器，win32 packaged 启动时把指向本 exe 的旧名 .lnk 换名为 Cindy.lnk（AUMID 保持 `BRAND_IDENTITY.appId` 三位一体），任务栏固定项只原地刷 icon/AUMID 不改名（改名会掉钉）。macOS 不做运行时自愈（改自身 bundle 破坏签名），图标随下一次整包更新自然生效。
- [x]（2026-07-17）**macOS 打包显示名**（win32metadata 的 mac 同构）：forge `postPackage` 钩子用 PlistBuddy 把包内 `Info.plist` 的 `CFBundleName` / `CFBundleDisplayName` 改 Cindy——Dock 名 / 菜单栏粗体标题 / Cmd+Tab / 系统通知即显示 Cindy。为什么不走 packagerConfig:`extendInfo` 在 packager 里先合并、后被 appName 覆写改不动这两个键;`packagerConfig.name` 会连 `.app` 目录名一起改踩标识符红线。签名/公证在 release-macos.mjs、发生在 postPackage 之后,plist 改动被一起封印。⚠️ `.app` 目录名（Finder 里 /Applications 列表显示）仍是 xdt-maker，等渠道迁移;应用菜单里 About/Hide/Quit 文案已在 bootstrap-electron 菜单模板切 `BRAND_NAME`（dev 菜单栏粗体 "Electron" 是官方 dev 二进制 CFBundleName，无解，仅 dev 可见）。
- [x] 应用图标素材：desktop 已于 2026-07-16 换 CINDY 全套（`99349c77a`，ico/icns/png 重生成）；界面 wordmark logo 已换 CINDY 深浅双版（经 `hooks/useBrandLogo.ts` 按主题选用）。
- [x]（2026-07-17）`apps/desktop/help-knowledge/*.md`（内置帮助知识库源文件）→ 全局替换后跑 `pnpm gen:help-kb` 重新生成 `helpKnowledge.generated.ts`。另:`cindy-brain/forge.ts` 的 FORGE_GUIDE（意识编写手册）品牌串同批改完。
- 注:`feishu-bot.md` 提及「FeiShu OAuth sign-in 登录」的内容已过时（登录已迁 Cindy auth），品牌串已改但内容重写不属于改名范畴，待帮助文档内容更新时处理。

### 未接常量层的 package（无法 import maker-shared，需逐处改）

- [x]（2026-07-17）`packages/voice-input-core/src/DictationRefiner.ts`：LLM system prompt 硬编码「你是 XDMaker 的语音听写文本后处理器」（配套 `DictationRefiner.test.ts` 同步，promptVersion 按文件契约 bump 到 zh.v17）。voice-input-core 不依赖 maker-shared，改字面量即可。

### 内置意识资源与 OAuth 回执页（2026-07-17 review 补漏）

- [x] `resources/builtin-ghosts/**`（cindy-slack / xd-atlassian / filo-google / xd-mivo 的 ghost.json 描述、settings.js 错误文案）与 `resources/example-ghosts/session-sentinel/ghost.json` 的 author——自包含意识包吃不到常量，逐处替换；main.js/settings.html 里的代码注释保留。
- [x] `main/cindy-brain/ghostOauthBroker.ts`、`maker-host/generic-oauth.ts`、`maker-host/grok-oauth-login.ts`——main 进程硬编码品牌串，改为 import `BRAND_NAME`（第 1 步漏网）。

### 手机端（apps/mobile）

- [x]（2026-07-17）`app.json`：`expo.name`（桌面图标显示名）与麦克风/相册/相机权限描述文案。⚠️ `expo.name` 变更改变 resolved config → **下次手机版发布必须冷更**（fingerprint 漂移，OTA 判定会拦）。
- [x]（2026-07-17）`apps/mobile/app/**`、`src/**` 内的展示文案——已 grep 逐处替换（含 device-link 设备名兜底 `Cindy <platform>`）；耦合测试（mobileSettings / nativeAppConfig / nativeE2eEnvironment）同步。e2e 工具链内部文档（`nativeE2eEnvironment` 断言的 README/脚本文案）未动，属开发工具文案非用户可见。

### 服务端（apps/server，零内部依赖、无法 import maker-shared）

- [ ] `src/services/slackRelay.ts` / `slackOAuth.ts` / `routes/slack.ts`：Slack bot 欢迎语、离线提示、OAuth 结果页文案。
- [ ] `src/services/auth.ts`：Dev 用户显示名。
- [ ] `src/services/github.ts` 及 issue 提交相关文案。

### Markdown prompt / skills（纯文本吃不到 TS 常量）

- [x]（2026-07-17）`packages/lizi-mcps/src/prompts/**/*.md`：飞书 bot 工具说明里的「私聊 xdt-maker bot」——经 owner 澄清飞书 bot 是**用户自己配置的**（名字用户自起），文案写死具体名字本就是错误假设，已改为中性说法「私聊你配置的那个机器人」，不依赖任何外部改名。
- [x]（2026-07-17）`.claude/skills/**`、`.agents/skills/**`：grep 无品牌残留（`agent-use/scripts/sync-agent-instructions.mjs` 仅历史对比注释，保留）。
- [x]（2026-07-17）`AGENTS.md` / `README.md` / `DESIGN.md` / `docs/**`：README/DESIGN 现行引用已改；AGENTS.md「由原 XDMaker 单仓迁出」为历史记录保留；`docs/**` 历史/迁移文档不动。
- [x]（2026-07-17）`packages/lizi-mcps/src/browser/prompts/rules/browser-workflow.md` 里的 profile 名**跟随 `MANAGED_PROFILE`**——profile 已翻转为 `'Cindy'`（老登录态经 mToc 迁移 `browser/XDMaker → browser/Cindy` 接续 + dev 实例就地改名自愈），文案已同步。

### 静态页面 / 公告

- ~~`apps/landing-page/index.html` / `apps/notice/*.json`~~：不在本仓（仓库拆分后归属 `cindy-server` 侧或独立部署），在对应仓处理。

## 三、外部协调项（不在本仓库内，需人工对接；状态截至 2026-07-16）

- [x] Slack App 名称：已改为 Cindy。
- [x] 官网域名：`cindy.com.cn`（国内）/ `cindy.app`（海外）已持有并接入 `production-endpoints.json`；老域名 `xdmaker.magiclizi.com` 的重定向待处理。
- [ ] GitHub 仓库（issue 提交目标仓）：待 Lizi 最终确认，暂不动。
- [ ] 下载 CDN：Cindy 渠道为独立 bucket（与旧渠道 URL 完全不同，不是同 bucket 换 path），随标识符层迁移一起落地。
- ~~飞书开放平台改名~~：已不再使用飞书登录，此项作废。

## 四、绝对不要动（标识符层，改了 = 数据迁移事故）

这些值与品牌展示名**故意解耦**，改名时保持原值；若产品决策要求连标识符一起换，必须为每一项单独设计迁移方案，不属于「改名」范畴：

| 标识符 | 位置 | 动了会怎样 |
|---|---|---|
| 深链协议 `xdt-maker://` | forge.config.ts protocols、renderer 深链解析、OAuth 唤回 | 所有历史会话链接 / 系统协议注册失效 |
| userData 目录（`package.json` 的 `productName: "xdt-maker"`、`xdt-maker-dev*` 沙箱目录） | Electron `app.getPath('userData')` | 用户本地 DB / 登录态 / 会话全部"消失" |
| `MANAGED_PROFILE = 'Cindy'`（2026-07-17 已随身份翻转定格，老 profile 由 mToc 迁移接续） | `apps/desktop/src/main/mcp-integrations/browser.ts` | 再改名会指向全新空 profile，丢登录态 |
| `PROG_ID 'XDMaker.CindyGhost'`、HKCU `Directory\shell\xdt-maker` 注册表键名 | `brain/fileAssociation.ts`、`folderContextMenu.ts` | 文件关联 / 右键菜单重复注册或失效（菜单**显示文案**已走 `BRAND_NAME`，键名不用动） |
| `WINDOWS_APP_USER_MODEL_ID 'com.magiclizi.xdt-maker'`、macOS `appId com.magiclizi.xdt-maker` | bootstrap-electron.ts、forge.config.ts | 通知归属 / 系统身份断裂（如需更换按平台迁移指引单独做） |
| `clientInfo: { name: 'xdt-maker' }` | maker-core codex、lizi-mcps slack-official | 协议握手标识，非展示名 |
| `~/.ssh` 默认密钥名 `xdt-maker`、`.xdmaker/` 项目目录、`xdt/` 分支前缀、`XDT_*` 环境变量、deviceId 前缀 `dev-` | 多处 | 用户资产 / 协作约定，与品牌无关 |
| 会话分享扩展名 `.cshare`（及旧 `.xdtshare` 兼容） | localDb/ipc/session-share.ts | 历史分享文件打不开 |

## 五、执行顺序建议

1. ✅（2026-07-16）改 `BRAND_NAME` 为 `Cindy` + 官网链接抽到 `production-endpoints.json` 的 `websiteUrl` → 跑测试，覆盖 80% 展示面。
2. 过第二节手动清单（打包显示名 → mobile → md/skills → 静态页；server 文案在 `cindy-server` 仓）。
3. ✅（2026-07-17 决策）**不做全仓 `XDMaker` 禁词**：清扫后的合法残留（冻结标识符 `PROG_ID`/`MANAGED_PROFILE`、代码注释、历史文档、测试夹具、飞书 bot 账号名引用）数量大且长期存在，逐条 file:line:col 豁免不可维护。守护收敛为：guard 的错拼禁词 + locale 硬编码检查（已覆盖 `XDMaker|XD Maker|xdt-maker`）+ review 口径。新增用户可见文案一律走 `BRAND_NAME` / `{{appName}}`。
4. 外部协调项收口（老域名重定向 / GitHub 仓库确认）。
5. 全仓 `git grep -i "旧品牌名"` 复核，比对第四节确认剩余命中全部是标识符。
6. 按规则 10 做缓存率 / 行为抽查，PR 里附结论。
