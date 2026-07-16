# 品牌改名清单（Branding Rename Checklist）

> 状态：authoritative（品牌名收敛与改名操作的执行清单）
> 背景：品牌展示名已收敛到 `packages/maker-shared/src/branding.ts` 的 `BRAND_NAME`（配套 `BRAND_WEBSITE_URL`）。此前 PR #767 已统一过 agent-facing 文案的拼写（`XDT` 前缀连写 / 带空格两种错拼 → `XDMaker`，具体禁词见 guard 脚本的 `FORBIDDEN_TERMS`，本文档不写出字面量以免触发 guard 自身）并建立品牌治理 CI；本文档在其之上回答两个问题：**改名时改哪里**、**改名时哪些绝对不能动**。
> 自动化闸门（CI workflow `brand-terminology.yml` → `pnpm check:brand-terminology`，源自 PR #767）：`scripts/brand-terminology-guard.mjs` 同时负责 (a) 全仓禁错拼变体、(b) locale JSON 禁硬编码品牌名（必须用 `{{appName}}`）。运行时插值的端到端断言在 `apps/desktop/src/renderer/__tests__/i18nBrandPlaceholder.test.ts`。

## 一、改一处即全局生效（常量层）

改 `packages/maker-shared/src/branding.ts`：

| 常量 | 当前值 | 覆盖面 |
|---|---|---|
| `BRAND_NAME` | `XDMaker` | desktop renderer/main 全部展示层字符串；四语言 locale 的 `{{appName}}`（renderer 走 i18next `interpolation.defaultVariables`，main 走 `apps/desktop/src/main/i18n.ts` 的迷你 `t()` 注入）；`packages/lizi-mcps` 的 MCP 工具描述、错误文案、OAuth 授权成功页 |
| `BRAND_WEBSITE_URL` | `https://xdmaker.magiclizi.com` | 更新横幅 / splash 的官网跳转（域名本身的注册与重定向是外部协调项，见第三节） |

改完跑：仓库根 `pnpm test:unit` + `pnpm --filter desktop typecheck` + `pnpm check:brand-terminology`。

同步更新 `scripts/brand-terminology-guard.mjs`：把**旧品牌名及其变体加进 `FORBIDDEN_TERMS`**（`replacement` 指向新名），这样旧名残留会在 CI 里持续红灯；guard 里的 locale 例外（`settings.remote.keys.nameHint` / `settings.computerUse.browser.openForLoginHint` 全路径豁免 / 架构文档路径）对应的是标识符，改名时不动。

⚠️ **LLM 影响评估（规则 10/11）**：`BRAND_NAME` 会进入 MCP 工具描述（prompt 前缀的一部分），改值会一次性打破 Anthropic prompt cache 前缀并可能影响模型对产品的称呼——这是改名的固有代价，发布前按规则 10 要求做一轮缓存率/行为抽查，并在 PR 里写明。

## 二、手动清单（收敛不进常量，改名时逐项处理）

### 打包 / OS 集成（apps/desktop）

- [ ] `forge.config.ts`：`packagerConfig.name`/`productName: 'XDMaker'`、Windows `shortcutName: 'XDMaker'`、macOS `CFBundleDocumentTypes`/UTType 的 `UTTypeDescription: 'XDMaker Session Share'` 等**显示名**字段。
- [ ] 应用图标 / splash logo 素材（`apps/desktop/resources/`、`src/renderer/assets/splash-logo.png`）。
- [ ] `apps/desktop/help-knowledge/*.md`（内置帮助知识库源文件）→ 全局替换后跑 `pnpm gen:help-kb` 重新生成 `helpKnowledge.generated.ts`。

### 手机端（apps/mobile）

- [ ] `app.json`：`expo.name`（桌面图标显示名）与麦克风/相册/相机权限描述文案。
- [ ] `apps/mobile/app/**`、`src/**` 内的展示文案（登录页等）——手机端未接常量层，需 grep `XDMaker` 逐处替换。

### 服务端（apps/server，零内部依赖、无法 import maker-shared）

- [ ] `src/services/slackRelay.ts` / `slackOAuth.ts` / `routes/slack.ts`：Slack bot 欢迎语、离线提示、OAuth 结果页文案。
- [ ] `src/services/auth.ts`：Dev 用户显示名。
- [ ] `src/services/github.ts` 及 issue 提交相关文案。

### Markdown prompt / skills（纯文本吃不到 TS 常量）

- [ ] `packages/lizi-mcps/src/prompts/**/*.md`：飞书 bot 工具说明里的「私聊 xdt-maker bot」等（bot 显示名要与飞书平台实际改名同步，见第三节）。
- [ ] `.claude/skills/**`、`.agents/skills/**`：其中 `review-pr` 两份由 `agent-use/docs/` 经 `pnpm sync:agent-instructions` 生成——改源头再重跑生成。
- [ ] `AGENTS.md` / `README.md` / `DESIGN.md` / `docs/**`：按需替换（历史记录类文档可不动）。
- [ ] 例外：`packages/lizi-mcps/src/browser/prompts/rules/browser-workflow.md` 里的「名为 "XDMaker" 的 profile」**跟随 `MANAGED_PROFILE` 而非品牌名**（见第四节），只有 profile 迁移方案落地后才一起改。

### 静态页面 / 公告

- [ ] `apps/landing-page/index.html`：标题、文案、下载按钮。
- [ ] `apps/notice/*.json` 公告模板（新公告用新名即可，历史公告不动）。

## 三、外部协调项（不在本仓库内，需人工对接）

- [ ] 飞书开放平台：OAuth 应用名、bot 显示名（与上面 lizi-mcps prompts 的「xdt-maker bot」文案同步）。
- [ ] Slack App 名称（apps/server 共享 bot）。
- [ ] 官网域名 `xdmaker.magiclizi.com`：新域名注册 + 老域名重定向，然后改 `BRAND_WEBSITE_URL`。
- [ ] GitHub 仓库 `xindong/XDMaker`（issue 提交目标仓）、下载 CDN 路径。

## 四、绝对不要动（标识符层，改了 = 数据迁移事故）

这些值与品牌展示名**故意解耦**，改名时保持原值；若产品决策要求连标识符一起换，必须为每一项单独设计迁移方案，不属于「改名」范畴：

| 标识符 | 位置 | 动了会怎样 |
|---|---|---|
| 深链协议 `xdt-maker://` | forge.config.ts protocols、renderer 深链解析、OAuth 唤回 | 所有历史会话链接 / 系统协议注册失效 |
| userData 目录（`package.json` 的 `productName: "xdt-maker"`、`xdt-maker-dev*` 沙箱目录） | Electron `app.getPath('userData')` | 用户本地 DB / 登录态 / 会话全部"消失" |
| `MANAGED_PROFILE = 'XDMaker'` | `apps/desktop/src/main/mcp-integrations/browser.ts` | 自动化浏览器指向全新空 profile，丢登录态 |
| `PROG_ID 'XDMaker.CindyGhost'`、HKCU `Directory\shell\xdt-maker` 注册表键名 | `brain/fileAssociation.ts`、`folderContextMenu.ts` | 文件关联 / 右键菜单重复注册或失效（菜单**显示文案**已走 `BRAND_NAME`，键名不用动） |
| `WINDOWS_APP_USER_MODEL_ID 'com.magiclizi.xdt-maker'`、macOS `appId com.magiclizi.xdt-maker` | bootstrap-electron.ts、forge.config.ts | 通知归属 / 系统身份断裂（如需更换按平台迁移指引单独做） |
| `clientInfo: { name: 'xdt-maker' }` | maker-core codex、lizi-mcps slack-official | 协议握手标识，非展示名 |
| `~/.ssh` 默认密钥名 `xdt-maker`、`.xdmaker/` 项目目录、`xdt/` 分支前缀、`.xdt-worktrees/`、`XDT_*` 环境变量、deviceId 前缀 `dev-` | 多处 | 用户资产 / 协作约定，与品牌无关 |
| 会话分享扩展名 `.cshare`（及旧 `.xdtshare` 兼容） | localDb/ipc/session-share.ts | 历史分享文件打不开 |

## 五、执行顺序建议

1. 改 `BRAND_NAME` / `BRAND_WEBSITE_URL` → 跑测试，覆盖 80% 展示面。
2. 更新 `scripts/brand-terminology-guard.mjs` 的 `FORBIDDEN_TERMS`（旧名进禁词表），让 CI 持续兜底。
3. 过第二节手动清单（打包 → mobile → server → md/skills → 静态页）。
4. 外部协调项并行推进（域名 / 飞书 / Slack / GitHub）。
5. 全仓 `git grep -i "旧品牌名"` 复核，比对第四节确认剩余命中全部是标识符。
6. 按规则 10 做缓存率 / 行为抽查，PR 里附结论。
