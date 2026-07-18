# Cindy 客户端仓

> **Agent 注意**：本文件（`AGENTS.md`）是 agent 指令正本，直接编辑本文件即可。`CLAUDE.md` 是一个只含 `@AGENTS.md` import 指令的真文件——Claude Code 只读 `CLAUDE.md`、不自动读 `AGENTS.md`，靠这行 import 把本文件引入，两端共用同一份规则（用真文件而非 symlink 是为兼容 Windows 检出）。规则只写在本文件里，不要写进 `CLAUDE.md`。
> 提 PR 的 Title / Description 规范见 `.github/PULL_REQUEST_TEMPLATE.md`。

## 本仓边界与迁移差异（先读）

本仓由原 `XDMaker` 单仓迁出，**只负责 desktop、mobile 及其共享 packages**；服务端位于独立的 `cindy-server` 仓库，除非用户明确要求，不要跨仓修改服务端。与原单仓相比的差异与新增约束：

- **本仓没有 `apps/server` / `apps/heartbeat-server`**。下文规则 17 的 server（Prisma）段与规则 19（docker compose 白名单）仅在 `cindy-server` 仓工作时适用，保留在此作为同一套工程口径的参照。
- **本地 server 由相邻的 `cindy-server` checkout 提供**：`pnpm dev:server` 会定位 `../cindy-server`（或 `XDT_SERVER_REPO` 指定的路径）并执行其 `dev:server`；server 侧 `.env` 配置以该仓文档为准。原单仓的 `pnpm dev:all` 在本仓不存在。
- **工作流**：尊重宿主和开发者选择的 Git 隔离方式。cwd 已是会话级 / 任务级 worktree 时直接复用，禁止再嵌套创建；cwd 不是任务 worktree 时按用户级 Git workflow 决定是否另建；未配置该 workflow 时先向用户确认，不要直接修改 checkout。不要把新任务混进已有脏 checkout，也不要用破坏性 Git 命令覆盖用户改动。功能完成后跑与风险匹配的验证、提交前对整体 diff review 一次；验证和 review 通过后创建本地 commit，把结果与 commit 信息交给用户确认，**只有用户明确确认后才能 push**（「提 PR」节的测试与对抗性 review 门禁仍然适用，push 本身必须经用户确认）。
- **SQLite migration 迁移基线**：从旧仓迁入的 SQL 由 `drizzle/migration-baseline.json` 固定 SHA256；数据库变化只能追加新 migration，并运行 `pnpm --filter desktop db:validate` 与 migration replay。本地数据库查询必须使用异步 API；不要对异步 DB client 使用同步 `.all()`。
- **main 进程禁止运行时动态 `import()`**；依赖使用顶层静态 import。
- **协议 submodule**：`cindy-protocol` 是协议权威来源。desktop 使用 `@cindy/slack-hook-protocol`，客户端 device-link 包复用 `@cindy/device-link-protocol` 的 relay 层定义；客户端重连、IPC allowlist 与隧道 payload 留在 `packages/device-link`。**升级 submodule 指针前必须确认 `cindy-server` 同步升级**，避免两端 wire protocol 漂移。
- **dev 数据目录为 `Cindy` userData**（2026-07-17 身份翻转起由 `productName: Cindy` 派生；从空开始，不再沿用老 `xdt-maker` 目录的历史数据）；用户未明确要求隔离时，不加 `--isolated`、不设置 `XDT_USER_DATA_DIR`（参数语义见下文启动参数表）。

## 外部关联

- **Slack 频道**：`#xd-maker`（channel_id `C0B3D62NPTQ`, workspace `xindong.slack.com`）。项目相关的 Slack 讨论、通知、搜索默认走该频道；用户说「发到 Slack / 搜一下 Slack / Slack 上的讨论」而未指定频道时，默认定位到 `#xd-maker`，可直接以 `C0B3D62NPTQ` 作为 `channel_id` 调用 Slack 工具，无需再查。
- **Slack 发消息规范(避免刷屏)**:往 `#xd-maker`(以及任何项目频道)发消息时,**频道正文只发一句话总结**(1-2 行,给个能扫到的标题),详情、链接、日志、截图说明、长列表全部走 thread 回复。具体做法:先调 `slack_send_message` 发一句话总结拿到返回的 `ts`,再调 `slack_send_message` 传 `thread_ts=<上一步的 ts>` 把详情作为 thread 回复贴上去(需要发到频道正文也让所有人看到时才加 `reply_broadcast=true`,默认不要开)。除非用户明确说「就一条正文发出来 / 不要开 thread」,否则一律按这个模式发。

## Quick Start

### 前置检查（首次克隆或遇到 pnpm 报错时执行）

运行任何 `pnpm` 命令前，先确认全局工具已就绪：

```bash
node --version   # 需要 v22 LTS+（当前开发环境 v25）
pnpm --version   # 需要 v10.x（当前开发环境 v10.33，暂不支持 v11）
```

**`node` 未安装时**：
- macOS：`brew install node` 或前往 https://nodejs.org 下载 LTS 安装包
- Windows：`winget install OpenJS.NodeJS.LTS` 或前往 https://nodejs.org 下载 LTS 安装包
- 安装后重启终端再继续

**`pnpm` 未安装时**：

```bash
npm install -g pnpm@10
```

安装后重启终端再继续。

**遇到 Corepack 相关错误**（如提示"Do you want to install pnpm?"交互卡住）：

```bash
corepack disable
```

---

```bash
# 1. Install dependencies
# postinstall 会 best-effort 按当前平台下载 agent 二进制（claude / codex / ripgrep，
# 已不在 git/LFS，版本 pin 在 tools/<kind>/latest.json）；失败只 warn 不阻断。
pnpm install

# 2. Pull LFS files (sqlite-vec 原生扩展等仍走 LFS)
git lfs pull

# 3. Start desktop (remote API, no local server needed)
# 创建/修复 apps/desktop/.env；predev guard 会再确认 agent 二进制就位（缺了在此硬下载）。
pnpm restart:desktop:remote
```

Login via Feishu OAuth in the Electron window.

### Agent 二进制（claude / codex / ripgrep）命令模型

这些 CLI 不进 git/LFS，由 `tools/<kind>/latest.json` 的 pin 版本驱动按需下载（`scripts/ensure-agent-binaries.mjs`，靠 `.version` 标记随 pin 升级刷新）。语义对齐"升级依赖"：

| 命令 | 作用 |
|------|------|
| `pnpm update:<kind>` | 把 `<kind>` bump 到最新版（**改 `latest.json` pin** + 下载） |
| `pnpm update:<kind> <X>` | 把 `<kind>` pin 到 `<X>`（**改 `latest.json` pin** + 下载） |
| `pnpm install:<kind>` | 按 pin 版本下载到本地（不改 pin）；`<kind>` ∈ `claude` / `codex` / `ripgrep`，或 `install:agent-binaries` 一次全装 |

- `pnpm install` 的 postinstall 会自动跑 `install`（best-effort、当前平台、幂等）；不需要桌面端的 CI 可设 `XDT_SKIP_AGENT_BIN_INSTALL=1` 跳过。
- 想本地临时跑某版本：直接 `pnpm update:<kind> <X>`（它就是 bump pin），别手改二进制目录。
- 被 GitHub API 限流时设 `GITHUB_TOKEN`（codex / ripgrep 走 GitHub Releases）。

## 桌面端启动与开发（Agent 规则）

### 唯一允许命令

**Agent 启动 / 重启桌面端只允许两个 restart 命令**：
- **默认 `pnpm restart:desktop:remote`**——连远程 API（`xdt-api`）。用户不指定模式时**永远走这个**。
- **`pnpm restart:desktop:local`**——起**本地桌面客户端**连 `http://localhost:3333`。**仅当用户显式说要"连本地服务器 / 连本地 server"（或等价的"启动本地客户端 / 本地模式"）时才用**；它只起客户端、不起 server，也不要主动切。

除这两个 restart 命令外，禁止任何其它启动形式：`pnpm dev:desktop:remote` / `pnpm dev:desktop` / `pnpm dev:all` / `pnpm --filter desktop dev:remote` / `pnpm --filter desktop dev` / `tail -f /dev/null | pnpm dev:desktop:remote` 都不允许（这些 dev 命令无 TTY 兜底、不杀旧进程、不补 `.env`，agent 环境下必失败——必须走 restart 包装）。

restart 脚本会在非交互式 agent（Claude / Codex）终端里自动打开系统终端承载 dev 进程（Windows 用 `cmd.exe` 窗口、macOS 用 Terminal.app）、停止**所有可识别的 Cindy desktop dev 进程**（跨 checkout/worktree、不分 remote/local）、补齐 `apps/desktop/.env`。绕过它在 agent 环境下必失败。不要直接 `pkill electron` / `taskkill /IM electron.exe`（会误杀其它 Electron 应用）。

> 澄清：restart 脚本内部在新开的系统终端里**最终 spawn 的是 `pnpm dev:desktop:remote`（local 模式则是 `pnpm dev:desktop`）**——这是预期行为，因为那个时刻已在真 TTY 里、旧进程已 kill、`.env` 已补齐。"agent 禁用 `dev:desktop:remote` / `dev:desktop`"指的是 **agent 不要直接调它们**，不是说脚本内部不能用。

### 命令表

| Command | Description |
|---------|-------------|
| `pnpm restart:desktop:remote` | **默认**；Agent 启动 / 重启桌面端连**远程 API**；补 `.env`、停所有 Cindy Electron dev 进程、在真 TTY 下启动；支持 `--region=cn|global`（默认 `cn`） |
| `pnpm restart:desktop:local` | **仅用户明确要求本地时**；连**本地 server**（`http://localhost:3333`）；同样停旧进程、真 TTY 启动;local 端点由 dev 脚本链自动生成的 `config/endpoint.local.json`(gitignored)承载;agent 只起客户端，本地 server 仍由用户自己起 |
| `pnpm dev:desktop:remote` | ⚠️ human-only；**agent 禁止直接调**（无 TTY 兜底、不杀旧进程、不补 `.env`，agent 环境下必失败）——agent 走 `restart:desktop:remote` |
| `pnpm dev:desktop` | ⚠️ human-only；连本地 server 的底层命令，**agent 禁止直接调**——agent 走 `restart:desktop:local` |
| `pnpm dev:server` | ⚠️ human-only；到相邻 `cindy-server` checkout（或 `XDT_SERVER_REPO`）启动本地 server，**agent 禁止** |
| `pnpm build` | 打包 Electron app |

### 可选启动参数 `--region` / `--passive` / `--isolated`（仅用户显式要求时加）

两个 restart 命令都支持；human 直跑的 `pnpm dev:desktop` / `pnpm dev:desktop:remote` / `pnpm dev:desktop:inspect` 也支持同名参数（desktop dev 脚本以 `electron-forge start -- ` 收尾，pnpm 追加的参数会透传进主进程解析）。agent 仍然只走 restart 命令。remote restart 另支持 `--region=cn|global`（也接受 `--region global`）：默认 `cn`；`global` 会同时切换构建身份与仓内 `config/endpoint.global.json`。再加 `--endpoints-cdn`（或 env `XDT_ENDPOINTS_CDN=1`）时不读仓内清单，改按同一个 region 走与 packaged 相同的线上 CDN 端点清单拉取链路（测线上清单；mobile 对应 `EXPO_PUBLIC_ENDPOINTS_CDN=1`），同样仅用户显式要求时加。

背景：dev 和 release（正式安装版）默认共用同一个 userData / SQLite 数据库；双开时定时任务靠 DB 级原子认领互斥，但**旧 release 包没有认领逻辑**，过渡期需要下面的参数配合。

| 参数 | 作用 | 什么时候用 |
|------|------|-----------|
| `--passive` | 定时任务被动模式：本实例不自动触发 schedule（不 tick、不把对方 in-flight run 误标 interrupted），任务管理 UI / MCP / 手动"立即运行"照常；数据仍与 release 共享 | 用户说「被动模式 / 不要抢定时任务 / 让位给正式版 / 定时任务交给 release 跑」，或用户反馈「dev + release 双开导致定时任务重复执行」且希望继续共享数据时 |
| `--isolated` | dev 使用独立 userData 目录（Windows `%APPDATA%\xdt-maker-dev`、macOS `~/Library/Application Support/xdt-maker-dev`）：数据库 / 登录态 / 会话 / 定时任务与 release 彻底隔离；首次需重新走飞书登录；**设备身份同步隔离**——自动派生独立 deviceId（`dev-<机器指纹>`），不会覆盖正式版的登录续期凭证、不触发同机互踢（服务端凭证按 user+device 一对一存）；已手动设 `XDT_USER_DATA_DIR` / `XDT_DEVICE_ID_OVERRIDE` 时尊重用户值不覆盖 | 用户说「独立数据库 / 隔离数据 / 沙箱启动 / 不要动我正式版的数据」时 |
| `--isolated=<名字>` | **命名沙箱**：每个名字一条完全独立的沙箱（目录 `xdt-maker-dev-<名字>`、设备标识 `dev-<名字>-<指纹>`），与默认沙箱、其它命名沙箱、正式版全部互不干扰；名字限 `A-Za-z0-9_-`、≤32 字符（restart 脚本对非法名字直接报错退出） | 用户说「再开一个独立实例 / 第二个沙箱 / 多开几个环境 / 给这个分支单独开一个环境」时。⚠️ 同一 checkout 的 restart 命令启动前会杀掉本 checkout 全部 dev 进程——agent 无法用 restart 同时多开；用户要真正并行多实例时，告知其在自己终端里直跑 `pnpm dev:desktop:remote --isolated=<名字>`（human-only 命令，不杀旧进程）或用多个 checkout |

- 两个参数都不带 = 原行为（共库 + 正常调度），**用户没提就不要主动加**。
- `--isolated` 已彻底分库，天然不存在定时任务重复问题，无需再叠 `--passive`。
- 参数只对 dev 生效（packaged 版本主进程忽略这些覆写），不影响用户机器上的正式版。

### 开发模式：默认 Remote，本地需显式指定

**不指定时永远走 Remote 模式（`pnpm restart:desktop:remote`）**。只有用户**显式指定要连本地服务器**（「连本地 server / 连本地服务器 / 启动本地客户端 / 本地模式」）时，才用 `pnpm restart:desktop:local` 起一个连 `http://localhost:3333` 的桌面客户端。其它说法一律不要自作主张切本地。

`restart:desktop:local` **只起客户端**——即便用户提到"服务器"，也不要因此去跑 `dev:server` / `dev:all` / 起 Postgres，本地 server 始终由用户自己起。Remote 跑不通时先排查 `.env` 和登录态，不要自动升级到本地。

- **运行期端点来源(2026-07 端点清单重构)**:业务端点不再走 `.env` / 构建期烘焙——remote dev 默认 region `cn`，读仓内 `config/endpoint.json`；`--region=global` 时读 `config/endpoint.global.json`（两份均与各自 CDN 上 `<hotfix base>/endpoint.json` 同格式）。local 模式(`pnpm dev:desktop` 脚本链里的 `apps/desktop/scripts/dev-local-env.mjs`)自动生成并读 `config/endpoint.local.json`(gitignored,api/auth/device-link 指 localhost,每次启动整文件重写);packaged 与 `--endpoints-cdn` 从烘焙的 region 化 hotfix CDN 基址阻断式拉取。`apps/desktop/.env` 仍是 gitignored、per checkout/worktree 的,但只剩构建身份字段(`VITE_FEISHU_APP_ID` / `VITE_CINDY_AUTH_REGION`),restart 命令缺失时创建、只补空值;remote 模式由 `scripts/dev-remote-env.mjs` 注入身份字段、不看 `.env`。
- 本地 server 位于相邻的 `cindy-server` 仓（`pnpm dev:server` 会定位并启动它），其 `.env` 与启动要求以该仓文档为准。

### 启动 → 测试 → 结束

**Step 1 启动**：仓库根执行 `pnpm restart:desktop:remote`（默认）；仅当用户明确要本地时执行 `pnpm restart:desktop:local`。
- 如果你自己就跑在 Cindy desktop dev 进程内（典型：你是桌面端内嵌的 Claude / Codex agent），脚本会自检并以 exit 1 拒绝执行，打印一条英文提示让你转告用户回他自己的终端手动重启。看到这种 refusal 信息时**不要重试 / 不要换命令**，原样转告用户即可。
- 改动了 main / preload / MCP / package 代码后必须重新执行；仅改 renderer 代码时热更新生效，无需重启。

**Step 2 测试**：等待用户操作，或在用户要求时协助验证。同一会话内不要反复重启；只有需要加载新代码、进程卡死或用户明确要求时才回到 Step 1。具备 Computer Use 能力时，可在用户要求时通过截图 / 点击界面协助黑盒测试。遇到 bug 或异常时，优先读日志定位（日志目录与排查方式见设计规范「日志」条）。

**Step 3 结束**：macOS 直接关闭 Terminal 窗口即停止 dev 进程；Windows 的 `cmd` 窗口会在 dev 进程结束或下次重启时自动关闭。如果运行环境提供后台任务能力且脚本没有打开系统终端，再用对应的 TaskStop 终止任务。不要发 Ctrl+C / Cmd+C 给非交互终端——无效。

## Dogfooding：在本仓库的 worktree 会话里工作（Agent 规则）

如果你是 Cindy 内嵌的 agent，且 cwd 位于 `<baseRepo>/.cindy-worktrees/<name>`（或品牌迁移前的 `.xdt-worktrees/<name>`）下（会话级 git worktree），遵守以下契约（完整工作流与原理见 `docs/dogfooding-workflow.md`）：

1. **先等 checkout 完成，再确认依赖**：worktree 创建返回时后台的完整 checkout 可能仍在进行（staged copy 只含 `CLAUDE.md` / `.claude` 等少量文件，**不含 `package.json`**）。跑任何 `pnpm` 命令前先确认 `package.json` 存在且 `git status --short` 干净，未就绪就稍等再查。worktree 与 baseRepo 共享 `.git` 但**不共享 node_modules**，创建流程不会自动安装：checkout 完成后若 `node_modules` 缺失，先 `pnpm install`（首次可能数分钟，注意命令超时，必要时分步执行）。
2. **你的编辑对运行中的 app 无效**：Vite HMR 只 watch 启动 dev 实例的那个 checkout，worktree 下的任何改动既不会热更也不会随重启生效。「改了没反应」不是 bug。验证一律在本 worktree 内跑 `pnpm --filter desktop typecheck` / 定向 `vitest run`；需要运行时验证时，commit + push 后告知用户，由用户启 verify 实例或重启（你无法重启宿主，见上文 refusal 规则）。
3. **宿主 app 日志不在你的 cwd 下**：dev 日志位于启动 checkout（通常是 baseRepo）的 `apps/desktop/logs/`，读日志时拼 baseRepo 的绝对路径。
4. **结束前必须 commit（+ push）**：用户**删除或归档会话**时，脏 worktree 的改动会先存为内容快照（`refs/xdt/snapshots/<sessionId>`）再删除目录（确认弹窗有警告；归档会话重开后可一键「恢复工作区」）。`/clear`、鉴权重连、app 退出等瞬态 close 不触发回收（2026-07 P0 重构）；在 worktree 里手动干活时可放 `.worktree-keep` 哨兵文件豁免一切自动回收。仍然不要把未提交的成果留在 worktree 里收工。
5. **stale prebundle 白屏陷阱**：给 maker-core / maker-cc-manager 等带依赖内部包新增 export 后，运行中实例可能因 stale Vite prebundle 报 `does not provide an export named X` 白屏——这需要受影响实例完整重启（re-optimize），提醒用户即可，不要误诊为自己的代码问题。

## 手机版出包 / 发版（Agent 规则）

手机版的**「开发 → 自测 → 发版」整体工作流与轨道模型（模拟器 / per-dev 手机 Beta / 正式服、Android 覆盖、正式服只从 `main` 手动发）以 `apps/mobile/docs/dev-and-release-workflow.md` 为准**——先读那份建立心智模型。模拟器调试见 `apps/mobile/docs/simulator-debugging.md`。

手机版（`apps/mobile`，Expo / React Native）的**出包与发版以 `apps/mobile/RELEASING.md` 的脚本入口为准**——别自己猜流程、别只靠搜关键词找，先读那份文档。要点：

- **走 EAS 云构建，不在本地编译**：编译、签名（Apple 凭据托管在 EAS）、提交 TestFlight 都在 EAS 云端完成，不用本地开 Xcode。
- **命令通过 release 脚本调用 pinned `eas-cli`**；开发机通常已登录 EAS，先 `npx eas-cli whoami` 确认登录态。
- **先用脚本判热更 vs 冷更**：`pnpm mobile:release:check -- --target production|staging|beta --dev <name>`。纯 JS / TS 且 runtime 匹配才可 OTA；动了原生层或 fingerprint 变化必须冷更。
- **不要手拼写操作命令**：Beta 走 `pnpm mobile:release:beta -- --dev <name> --message "..."`；正式服走 `pnpm mobile:release:prod -- --message "..."`。脚本默认 dry-run，只有 `--execute` 才会调用 EAS 写操作。
- **冷更版本号由脚本保证单调**：自建线冷更脚本读线上基线后,检测到 iOS `buildNumber` / Android `versionCode` 未大于基线时**自动自增写回版本文件**(`app.json` / `android-version.json`,`--execute` 才写盘;`--ipa` / `--apk` 复用现成包时跳过自动 bump、落回单调断言报错;发布完成后把 bump 改动 commit 回 main);Android 不上 Google Play,自签 APK 直传自有 OSS 分发(不经 NPKG;iOS 企业重签仍借 NPKG,重签后 ipa 也转传 OSS);飞书 Android 包名 + SHA 登记仍是外部 pending 动作，不能假装已完成。

## 设计实现规范

> 下面这些规则按主题分组。原 22 条中已移除旧规则 4「复用 / 抽象」与旧规则 6「以源码实现为准」（属通用工程常识），**其余条目沿用原编号以保持既有引用（DESIGN.md / 代码注释等）稳定，故 4、6 空缺**。conventions：粗体小标题用于引用（口头可说"规则 N"），引用以小标题语义为准。

### 架构与代码质量

1. **render / main 解耦**：业务逻辑、网络通讯、数据存储等一律放在 main 实现，render 只负责渲染，不在 render 里写业务逻辑；render 与 main 通过 IPC 通讯，main 负责与 package 通讯。

2. **package 解耦**：package 是未来可单独提供能力的模块，其设计实现必须与 render / main 解耦；有关联的部分通过初始化或运行时配置 / 回调传入，不直接依赖 render / main。

3. **UI / 设计稿遵守 `DESIGN.md`**：
   - 项目视觉是黑白反色设计，但不会出现纯黑或纯白的内容。
   - 任何涉及前端 UI 新增或修改（新组件、新页面、布局 / 样式变化）的改动，实现前必须先阅读仓库根 `DESIGN.md` 并确认变更符合其中的视觉规范。
   - 对于非 trivial 的 UI 变化（整页新增、复杂交互组件、布局重构），应主动建议用户先用 pencil MCP 绘制 `.pen` 设计稿，再以"1:1 还原设计稿"的方式实现，避免凭空生成视觉风格不统一的界面。

5. **注释**：所有类 / 对象都需要有明确的注释；核心类的实现内部要有注释描述逻辑。

25. **媒体文件的生成 / 存储 / 读取一律走 cindy-media 媒体总仓,禁止另起炉灶(编码与 review 必查)**。任何新增或修改的功能涉及媒体字节(图片 / 视频 / 音频 / 3D 模型)落盘时,必须走 `apps/desktop/src/main/cindy-media/` 的统一逻辑:写入 = blobStore 指纹落盘 + ledger 记账(blob 行 + 引用行,含出生信息);读取 / 渲染 = `cindy-media://blobs/<指纹>.<ext>` 协议;生命周期 = 引用计数(业务删除自己名下的 ref,不直接删文件)。设计依据 `docs/Cindy架构设计/媒体总仓/media-store.md`。**禁止**:新建专用媒体目录、新写 cache store、新注册媒体协议、绕过账本直接往磁盘写媒体文件。`imageCacheStore` / `videoCacheStore` / `modelCacheStore` / `audioFileProtocol` 与 `userData/cc-agent/` 是**冻结的老世界**——老协议(`xdt-image` / `xdt-video` / `xdt-model`)只读服务历史地址,存量写入点按迁移计划逐步切换到总仓,期间不许有任何**新增**代码路径往 `cc-agent/` 写入。边界:非媒体的任意类型文件(docx / zip 等)不进字节仓,走 `xdt-file` 直读通道;`xdt-audio` 保留"播放用户本地散文件"的直读职责。review 时命中"新增媒体落盘"的 PR 按此检查,绕过总仓 = P1。

### 前端实现

7. **视觉连续性，杜绝跳变 / 空白帧**：
   - 所有界面 / 子界面 / 边栏切换时，切换过程不要产生让人难受的视觉跳变。
   - Render 层数据获取与显示遵守时序：先异步获取数据（绝对不能卡主线程渲染），获取期间界面不发生变化，拿到数据后再刷新显示，避免空白帧或界面跳变。
   - 应用内数据大部分来自本地，因此无需做任何 loading 态的界面显示（需要不同设计要先和用户确认）。
   - **常驻动画必须 compositor-only（编码与 review 必查）**：常驻 / 循环的单元素简单动效（spinner、呼吸、shimmer 等）只允许写成 HTML 元素上的 `transform` / `opacity`，其它写法（`mask` / `background-position` 等，以及任何挂在 SVG 上的动画，`transform` / `opacity` 也不行）都会每帧惊动主线程，造成持续 CPU / 能耗泄漏。图标动效一律挂外层 wrapper：`// ❌ <Loader2 className="animate-spin" />`、`// ✅ <span className="animate-spin inline-flex"><Loader2 /></span>`。多元素组合的复杂动效（错峰、内部形变等）不死限实现宿主（含 SVG），按表现力灵活选，但遵守性能原则：常驻 infinite 动画越少越好、能不错峰就不错峰、能限挂载时长就限。动画只在有状态含义时挂载（如仅 running），响应 `prefers-reduced-motion`；性能有疑虑时 DevTools Performance 实测，以数据为准。弹窗按钮 loading 等秒级瞬态存量不强制改，新代码一律照此。

8. **agent 功能在 `packages/maker-core` 实现**：实现 claude / codex 的 agent 功能时，具体逻辑要放在 maker 的 package 中；尽量在 BaseAgent 抽象方法、实现共用逻辑，子类继承实现各自特殊的部分；main 通过 maker 来调用和访问 agent 能力与信息。

### LLM / agent 行为可控性

9. **优先用代码保证确定性，而非依赖 prompt**：实现 LLM / agent 相关功能时，**优先用代码实现来确保逻辑的确定性**，而不是优先依赖提示词（prompt）完成。能用代码做的判断、分支、校验、状态机、数据结构转换、流程编排、权限控制、错误处理、重试与兜底，都要写在代码里，让行为可预测、可测试、可调试；提示词只承担"模型自由发挥"那部分真正需要语言理解 / 生成的工作。不要把本该由代码保证的确定性逻辑（例如格式校验、字段抽取、流程跳转、是否调用某个工具）甩给 prompt"自己判断"，否则会引入不可复现的 LLM 行为漂移。当你打算用 prompt 解决一个问题前，先问自己：这件事用代码能不能做？能就用代码。

10. **改动 `packages/maker-core` 必须守住 agent 的核心数据指标（缓存率 / 性能 / 返回速度 / 返回内容准确性），不许在没有评估和实测的前提下回退任何一项**。maker-core 是所有 agent 会话的编排与事件流核心，它上面的每一行改动都可能在用户无感知的情况下拖垮线上指标——而这类回退**不会被 typecheck / lint / 单测发现**，只能靠改动者在 review 前主动评估 + 实测。下面按四个指标说清"哪些改动会踩"和"必须怎么做"：
    - **缓存率（Anthropic prompt cache）**：命中依赖**请求前缀逐字节稳定**。Claude system prompt 由多段拼接（SDK preset → `MAKER_SYSTEM_PROMPT_APPEND` → makerMemoryRules → host `runtimeConfig.systemPrompt` → per-workdir MEMORY.md index snapshot → per-call userPrompt，见 `src/agents/claude-code/index.ts`）。**禁止**：往稳定前缀里塞每轮都变的内容（时间戳、随机文案、易变计数器）、调整各段拼接顺序、在会话中途增删 / 重排 tool 定义或 MCP server 注册、破坏 MEMORY.md「会话启动时快照、rewind 不刷新」的语义（`TurnStartPhrases` 这类随机内容只能进 per-call userPrompt 段，绝不能混进缓存前缀）。任何动到 prompt 组装 / tool 暴露 / MCP 注册的改动，改完用 `UsageTracker`（`src/agents/shared/usage-tracker.ts`）的 per-turn / session cache hit rate 或 `/context` 命令对比改动前后，确认缓存率没掉。
    - **性能 / 返回速度**：event loop（`AsyncQueue`）和 translator（`src/agents/*/translator.ts`）是**每事件 / 每 token 都过一遍的热路径**。禁止在热路径里塞同步阻塞调用（同步 IO、大对象深拷贝、灾难性正则回溯、每事件 new 一堆临时对象），禁止在 `handle.send` 路径上加额外网络往返或串行 await，保持「先 push 进队列、消费端 async 流式吐」的非阻塞模型（参考 SSE idle watchdog 的 arm 时机：必须在 `inputQueue.push` 之后，别把客户端耗时算进上游静默配额）。耗时操作走缓存 + 超时 + fallback（参考 `ImageResizer` 的 LRU + 5s 超时 + 失败回退原图），不要让单次慢操作卡住整个 turn。
    - **返回内容准确性**：translator 必须把 vendor SDK 事件**无丢失、无错序**地映射进已有 `AgentEvent` union，不许吞掉 / 错误合并 / 错配 `text` / `thinking` / `tool_use` / `tool_result` 等事件（错序会让 renderer 渲染出错乱内容）；model 路由只走 `toSdkModelString` 的**显式版本号**，禁止 `'opus'` / `'sonnet'` 裸别名（cc-code 二进制升级后别名指针会漂到下一代模型，用户选了 4.6 实际命中 4.7）；任何会改变送进模型的 prompt 内容 / tool 可用性 / 权限分支的改动都可能让模型行为漂移，必须是**有意为之**并在 PR 里说清为什么。
    - **review 前硬性要求**：凡改动落在 prompt 组装、tool / MCP 暴露、translator、event loop、model 映射、usage / token 计量这几条路径上的，PR Description 必须显式写明：(a) 可能影响哪个 / 哪几个指标、(b) 用什么方法实测了（cache hit rate 改动前后对比数据、热路径耗时、典型 turn 的事件流抽查等）、(c) 实测结论。**不许用「看着没问题 / 应该不影响」代替实测**——这四个指标都是 LLM 侧不可复现的运行时指标，静态检查发现不了回退，只有数据能证明。

11. **任何人都不得擅自修改 Cindy 的系统提示词（system prompt），需要改动必须先和 Lizi 讨论确认后才能动手**。这里的"系统提示词"指随每个 agent 会话下发给模型、决定其全局行为的那部分文本——包括但不限于 `packages/maker-core` 里参与拼接 Claude / Codex system prompt 的各段（SDK preset 之外的 `MAKER_SYSTEM_PROMPT_APPEND`、`makerMemoryRules`、host 注入的 `runtimeConfig.systemPrompt` 等，见 `src/agents/claude-code/index.ts` 及对应 codex 实现）、以及任何固化在代码 / 模板 / 常量里、会进入模型 system 段的提示词内容。**原因**：系统提示词是产品行为与质量的"宪法层"，一处改动会无差别地影响所有用户的所有会话，既可能让模型行为整体漂移（规则 9 / 10 已说明 LLM 侧改动不可复现、静态检查发现不了），也会破坏 Anthropic prompt cache 的前缀稳定性拖垮缓存率（规则 10）。这类改动绝不能由 agent 或任何贡献者凭"我觉得这样更好"自行决定。**怎么做**：(a) 收到任何"改一下系统提示词 / 调整 agent 人设 / 加一条全局指令 / 删改某段 system 文本"的诉求时，**先停下**，不要直接动代码；(b) 把"要改哪段、改成什么、为什么改、预期影响（行为 + 缓存率）"整理清楚，**主动找 Lizi 讨论并取得明确确认**；(c) 确认通过后再实现，并在 MR Description 里显式写明"系统提示词改动已和 Lizi 确认"+ 按规则 10 的实测要求附上缓存率 / 行为影响评估。未经确认的系统提示词改动一律不许提 PR。

### 工程规范

12. **日志**：
    - 所有日志输出都要走系统统一的日志模块，不能自己 `console.log`。
    - dev 模式下排查 bug 时，如果问题可以通过日志定位，优先在可疑代码路径加 DEBUG 级日志（走统一 logger，不要 console.log），让用户复现一次后去日志目录定位。日志目录是项目内的 `apps/desktop/logs/`：先用 Glob/ls 列出当前文件（文件名和 rotate 后缀都可能变），再 Read 相关文件；如果 cwd 不在仓库根（worktree、子目录等），先确认仓库根再拼绝对路径。问题确认后记得清掉那些临时排查日志，不要留在仓库里。

13. **main 进程 IPC handler 错误必须用 `throwIpcError(code, message)`**：禁止裸 `throw new Error('xxx')`、禁止 `return { ok: false, error: '...' }`。`code` 必须来自 `apps/desktop/src/shared/ipc-errors.ts` 的 `IpcErrorCode` 字面量联合，违规会被 typecheck 拦下；确实需要新 code 时先扩枚举（通用 / 业务 code 分组），不要在调用点用 `as IpcErrorCode` 强转绕过。renderer 端消费 IPC 错误统一走 `apps/desktop/src/renderer/utils/ipcError.ts` 的 `extractIpcError` / `mapIpcErrorToI18nKey`，不要手写 `err.message.match(/\[XXX\]/)` 解码——背景是 Electron 跨进程序列化会丢 `Error.code` 自定义字段，`throwIpcError` 通过 `[CODE] message` 的 message 编码 + renderer 端正则解码绕开这个限制，整个链路就是这套协议，绕开会拿不到 code。Phase 2+ 仍在收尾迁移历史 handler，编辑老代码时顺手把碰到的裸 throw 改成 `throwIpcError`，但不要为了清理而清理（不要主动批量 grep 改）。⚠️ 例外：查询型 handler（list / scan / search 等）如果失败时 renderer 仍需要 fallback data 才能正常渲染，可以保留 `{ success: true, ...data } | { success: false, error, ...defaultData }` 模式（典型例子：`LIST_AGENT_SKILLS` 失败时返回 `skills: []`，renderer 直接解构空数组继续渲染，比 try/catch 包裹更干净）。判断标准：失败时 renderer 是否需要结构化 metadata（如 `reason: 'oversize'` + `size` + `limitMb`）或 fallback data 才能正确显示——需要就保留 `{success}` 风格，**不**强行迁 throw。新写 handler 默认走 `throwIpcError`，只有命中这条例外才用 `{success}` 风格。

14. **新增 / 修改 main 侧业务逻辑默认带测试**：main 进程是跨平台、跨进程边界的高风险层，新增或修改业务逻辑时默认同步补单测或回归测试；确实无法自动化时，在 PR 自测里写明原因和手工验证路径。IPC handler 的业务体（参数校验、`throwIpcError` 错误路径、maker-host / localDb / auth 等依赖交互）应抽成可注入依赖的纯 handler 或小函数，Electron 的 `ipcMain.handle` 只做 adapter，这样测试可以用内存 harness 直接 invoke handler body，不需要启动 Electron。新增 handler 至少覆盖主路径和关键错误路径；修改已有 handler 时补上能复现本次风险的回归用例。

15. **任何功能的设计与实现都必须同时考虑 macOS / Windows 双平台兼容性，并在两端都做到最优性能**：
    - **路径与目录**：一律走 `path.join` / `path.resolve` / `path.sep`，禁止硬编码 `/` 或 `\\`；用户目录走 `app.getPath('userData' | 'home' | 'temp')`，不要拼 `~` 或 `%APPDATA%`。
    - **子进程 / 原生二进制**（agent CLI、cindy-updater、ripgrep、better-sqlite3 等）按平台 + 架构分发与加载（`process.platform` + `process.arch`）；spawn 时注意 Windows 的 `.cmd` / `.exe` 后缀和 `shell: true` 行为差异；不要假设 POSIX 信号（`SIGTERM` / `SIGINT`）在 Windows 子进程上同样生效，需要兜底显式 kill；env 变量名大小写在 Windows 上不敏感、在 Mac 上敏感。
    - **文件系统差异**：Windows 大小写不敏感、保留路径长度上限、文件锁与删除语义不同；涉及 rename / unlink / 监听文件变化 / SQLite 文件迁移的逻辑，必须在两端都验证。
    - **性能基线以两端中较弱的一端为准**，不能"Mac 上流畅就过"。I/O 密集（SQLite / FTS / 大文件）与渲染密集（长列表虚拟化、动画、滚动）的关键路径，要明确给出在 Windows 上的可接受指标（帧率、首屏、响应延迟），并优先选择跨平台原生最优方案（better-sqlite3、Electron 原生 API、CSS GPU 合成）而非纯 JS polyfill。
    - **快捷键 / 菜单 / 系统集成**（托盘、通知、窗口控制按钮、全屏行为、`cmd` vs `ctrl`）必须按平台规范分别实现，不要把 Mac 的交互直接照搬到 Windows。
    - **回复中显式说明**：写完代码若改动可能影响平台行为，需要在回复里说明"已分别考虑 macOS / Windows 上的 X / Y"，未实测的平台要标注待验证。

16. **新增 / 修改 UI 涉及颜色时必须走主题 token 系统**：项目用 VSCode 风格的 `ColorRegistry + Theme override` 架构(参见 `apps/desktop/src/renderer/themes/`),除默认 light/dark 基础主题外可注册任意数量的扩展主题(具体列表以 `themes/registry.ts` 为准,不在本文档枚举)。**绝对禁止**写 `bg-[#xxx] dark:bg-[#xxx]` / `text-[#xxx] dark:text-[#xxx]` 这种硬编码 hex pair——这种写法只认 `.dark` class 一个开关,任何非默认主题都无法 override 它,违反可扩展性。
    - **token 选择优先级**:先用 semantic slot (`--surface` / `--surface-elevated` / `--surface-chip` / `--border-default` / `--text-primary` / `--text-secondary` / `--text-tertiary` / `--accent-cta-bg` / `--accent-soft` 等);slot 不覆盖时用 component-scoped alias (`--cmd-palette-bg` / `--msg-tool-card-bg` / `--settings-input-text` 等)。所有 token 在 `apps/desktop/src/renderer/themes/colors.ts` 注册,写代码前 grep 一下是否已有合适的,不要重复造。
    - **HSL vs hex 格式**:少数 token 用 HSL 三元组形式 (`--background`、`--sidebar`、`--titlebar`、`--ring`、`--border` 等 shadcn-style 基础色和部分 chrome 色),消费时必须 `hsl(var(--xxx))` 包裹;其它 token 是 hex / rgba,直接 `var(--xxx)` 引用。如何区分:看 colors.ts 注册时 default 是 `'60 12.5% 97%'` 这种三元组的就是 HSL。错误的格式 wrap (例如把 hex 塞进 `hsl()`) 会产生非法 CSS 整条 declaration 被忽略,看着像"主题失效"。
    - **语义豁免色**:以下颜色跨主题保持一致,**不**应该被主题 override,但仍走 token:focus ring (`--focus-ring` / `--focus-ring-soft`,蓝)、error (`--error-bg/-border/-fg/-fg-strong`)、destructive (`--destructive` HSL)、thinking-orange (`--status-bar-accent`)、warning alpha (`--warning-bg-soft`)、diff red/green (`--diff-add/del-*`)、overlay (`--overlay-modal` / `--overlay-lightbox`)、shadow (`--shadow-menu` / `--cmd-palette-shadow` / `--confirm-shadow`)、Toast 三色 (Toast.tsx 内部 hardcode,DESIGN.md §2 明确豁免)。
    - **新增 token 的判断**:现有 token 数量已经收敛过(semantic slot + component alias + singleton 三层),绝大部分新 UI 都能复用。真正要新增时:(a) 先确认现有 token 都不合适、(b) 决定加 slot 还是加 singleton (semantic 跨多处复用就加 slot,单一用途加 singleton)、(c) 加到 colors.ts 同时**评估每套现有非默认主题是否需要 override**(参考各主题文件的 override 数量当基线)。新增前主动跟用户确认。
    - **加新主题流程**:新建 `themes/builtin/<id>.ts` 导出 `Theme` 对象 → 注册到 `themes/registry.ts` 的 `builtinThemes` → 设置页 dropdown 自动选到。主题对象只 override 跟基础主题(默认 light/dark)不同的 token,对照 `themes/builtin/` 下已有的非默认主题作模板。
    - **完整设计规范**:详见仓库根 `DESIGN.md` 第 2 节 (Color Palette & Roles) 和第 10 节 (Theme System & Token Reference)。

17. **DB schema 变更必须由 ORM migration 工具生成,禁止手写 / 手改 migration 及其元数据**。手改会产出与 schema drift、排序错乱或 journal 对不上的不合法 migration,坏一条就卡死整条迁移链(已出过线上事故)。本项目双 ORM:
    - **desktop(Drizzle/SQLite)**:改 `apps/desktop/src/main/localDb/schema.ts` → 在 `apps/desktop` 跑 `pnpm db:generate` 产出 `.sql` + snapshot + journal 条目,再 `pnpm db:check` 自检。**绝不手改** `drizzle/meta/_journal.json` 与 `*_snapshot.json`、绝不手动新建 / 改名 / 捏序号 `.sql`。只允许在**尚未合入 main 的本 PR 新 migration**里补 `IF EXISTS` 幂等与注释(参考 `0036`);一旦进入 main 即按下方 append-only 规则冻结,后续不得再改内容。
    - **desktop 配套迁移脚本 `drizzle/scripts/NNNN_*.ts` 必须是 CommonJS**:用 `function run(db){...}` + 末尾 `module.exports = { run }`,依赖只用 `import type`。**禁止**顶层 ESM `export` / value `import`——这些脚本不经编译、以 raw 形式随包发出(forge extraResource),生产 Electron 用 `require()` 当 CommonJS 加载,ESM 语法会让用户端炸 `Unexpected token 'export'`,而 dev / vitest 走 import 不复现(只在生产暴露的静默坑,2026-06 由 0040 触发)。参考 `0038_add_session_remote_host_id.ts`;`pnpm db:validate` 已加 step 5 自动拦截顶层 `export` / value `import`。
    - **desktop migration / 配套脚本新增或修改后必须跑回放测试**：在 `apps/desktop` 跑 `pnpm test:migration-replay`（或仓库根 `pnpm --filter desktop test:migration-replay`），确保空库与历史 fixture 能真实升级到 HEAD；新增高风险历史迁移时同步补 fixture，不只依赖静态 `db:validate`。
    - **server(Prisma/PostgreSQL)**(服务端已拆至 `cindy-server` 仓,本条在该仓工作时适用):改 `prisma/schema.prisma` → 跑 `pnpm db:migrate`。**绝不**手写 migration.sql、改 `migration_lock.toml`、捏时间戳前缀(前缀决定执行顺序)。
    - migration 是 **append-only**:别改历史已合入的,要改就再生成一条。

18. **任何 UI 文案的新增 / 修改 / 删除都必须同步走多语言(i18n)体系,禁止在界面里硬编码裸文案,禁止只改一种语言**。i18n 资源在 `apps/desktop/src/renderer/i18n/locales/<locale>/common.json`,支持的语言由 `apps/desktop/src/shared/locale.ts` 的 `SUPPORTED_LOCALES` 定义(当前 4 种:`zh-CN` / `en` / `ja` / `ko`),renderer 通过 `react-i18next` 的 `t('<嵌套.key>')` 消费,单 namespace `common`。**为什么容易遗漏**:`fallbackLng = 'en'`,某语言缺 key 时会**静默回退英文、不报错、没有任何校验脚本拦截**,漏翻在开发期几乎发现不了,只有对应语言用户才会撞见夹生英文——所以只能靠改动者自觉对齐。**怎么做**:
    - **新增文案**:复用已有嵌套分组选好 key(不要新造同义分组),组件里用 `t('key')` 引用,绝不写 `<div>保存</div>` 这种裸文案。
    - **修改文案**:改了某 key 的文案,4 种语言对应翻译同步更新,不要只改中文留其它语言旧值。
    - **删除文案**:删 UI 时把对应 key 从全部 4 个 `common.json` 一起删掉,不留孤儿 key。
    - **四语言必须全部翻准**:`zh-CN` / `en` / `ja` / `ko` 4 个 `common.json` 都必须补齐对应 key 并给出**准确**翻译,绝不允许留空、占位或留"待校对"半成品(留空会触发英文回退,等于没翻);ja / ko 没把握时先查证可靠译法再写,不要硬凑。
    - **校对**:改完手动确认 key 在 4 个文件都存在、无遗漏(没有自动校验脚本,这步只能手核)。

19. **server 新增环境变量必须同步 docker compose 的 `environment:` 白名单**(服务端已拆至 `cindy-server` 仓,本条在该仓工作时适用):`apps/server` 的部署 compose 是**白名单式透传**——容器只能拿到 `docker-compose.prod.yaml` 的 `environment:` 里显式列出的变量,宿主机 `.env` 配了但 compose 没列的变量在容器内永远是空。因此凡在 server 代码里新增 `process.env.XXX` 读取(典型入口 `apps/server/src/config.ts`),必须同步在 `apps/server/docker-compose.prod.yaml` 的 `environment:` 加对应透传条目(有合理默认值的写 `${XXX:-default}`,纯凭证类直接 `${XXX}`)。`apps/server/release/docker-compose.yaml` 由 `release.sh` 从 prod.yaml 拷贝生成,正常走 release 流程会自动同步;若 PR 里直接更新 release 产物,需保持两份一致。`apps/heartbeat-server` 的 compose 同理。**为什么容易踩**:这类遗漏不报错——功能开关类变量(如 `SLACK_ENABLED`)在容器内拿不到值会静默走"未启用"分支,部署后表现为"配了但不生效",typecheck / 单测 / 启动日志都拦不住,只有上线后对应功能不工作才暴露(2026-06 Slack 接入实踩:`config.ts` 加了 6 个 `SLACK_*` 变量但 compose 没透传)。自查方法:改完 `config.ts` 后 diff 一下新增的 `process.env.*` 键名是否都出现在 prod.yaml 的 `environment:` 里。

20. **配置设计遵守 `docs/configuration-design-principles.md`**：Cindy 允许用户高度定制，但默认配置承载创作者品味，是产品体验的一部分。新增 / 修改任何用户可配置项时，必须先判断它属于常规设置、高级设置、隐藏配置还是内部常量；不要因为技术上能配置就放进 Settings 外层，只有大多数用户需要看到和理解的选项才默认可见，其它应收进高级设置、配置文件或允许用户通过自然语言让 agent 修改本地配置。每个配置项都必须区分系统默认值和用户 override，能判断是否被用户显式自定义；未自定义的用户应随版本吃到新的系统默认值，已自定义的用户保留自己的选择。Settings 中恢复默认的语义是清除 override、重新跟随当前版本默认值，而不是写入一份静态默认值快照。实现或 PR 说明里要讲清：默认值、可见性层级、override 如何记录、默认值未来变更时如何迁移、恢复默认清除什么。完整原则见 `docs/configuration-design-principles.md`。

26. **任何产品功能的设计与实现都必须同时考虑「远程连接」与「手机版」，PR 里要么一并适配、要么开 issue 跟踪，不允许静默忽略**。Cindy 的产品形态不止本地桌面单机，同一个功能可能运行在：(a) **SSH 远程工作区**（「远程连接」——workdir、agent 进程、文件都在远程主机上，经 `packages/maker-remote-ssh` / `packages/remote-file-service` / cc-manager 驱动）；(b) **设备互联远程控制**（手机或另一台桌面通过 `packages/device-link` 隧道驱动被控桌面端，IPC channel 白名单准入）；(c) **手机版**（`apps/mobile` 独立客户端，作为纯控制端复用 device-link）。**为什么容易踩**：开发与自测默认在本地桌面进行，这三个形态的缺口不报错、typecheck / 单测全拦不住——远程工作区下直接 `fs` 读 workdir 路径读到的是本机而不是远端；新 IPC channel 不登记 device-link allowlist，手机 / 远程控制端就永远调不通；手机版没有对应入口，用户在手机上就完全看不到这个功能——全部只在对应场景的用户实际使用时才暴露成「功能在远程 / 手机上不工作」。**怎么做**：
    - **设计阶段先回答三个问题**：① 功能涉及 workdir 文件 / agent 进程 / 会话数据时，在 SSH 远程工作区下能否正常工作（路径与执行位置在远端，现有远程通道 remote-file-service / cc-manager / exec 能否覆盖）？② 新增 / 修改的 IPC channel 与推送事件，手机 / 远程控制场景需不需要用？需要就按 `packages/device-link/src/allowlist.ts` 顶注的准入判据登记 invoke / push 白名单并同步 topic 路由；③ 手机版需不需要对应的入口 / UI / 交互？
    - **PR 门禁**：功能类 PR 的 Description 必须写明上述每一项的结论——(1) 本 PR 已一并适配；或 (2) 已开跟踪 issue 并贴链接；或 (3) 说明为什么不涉及（给出理由，不能只写「不涉及」）。默认期望是在同一个 PR 里一并做掉，只有适配量足够独立成 PR、或远程 / 手机侧需要单独设计时才拆 issue 跟踪。
    - review 按此检查：功能类 PR 缺这段说明 = P1。

### 高风险模块

21. **cindy-updater 是非常重要的模块,任何修改都要和 owner 确认**：无论你做任何改动,都要先和 Lizi 确认后再动手。

### 文档与规范治理

22. **改 Orca 协同代码前必读 `docs/orca-team-architecture.md`**：它是 Orca 多 agent 协同的权威架构文档（owner: yuhaobo），治理 `apps/desktop` 的 `maker-ipc/orca*` 服务与 `mcp-integrations` codex MCP、`packages/lizi-mcps` 的 `orca`、`packages/orca-workflow`、`packages/maker-core` 的 codex MCP context。改这些模块前先读它，实现要与其中「协同运行时行为契约」「坑点与不变量」声明的不变量保持一致；文档与代码冲突时以代码为准，但要在同一改动里同步修正文档。`docs/` 其余文档的分类与状态见 `docs/README.md`，默认仅供参考。

24. **意识(Ghost)机制改动必须同步《意识编写手册》(FORGE_GUIDE)与装入校验,二者是同一规则的两半**。手册(`apps/desktop/src/main/cindy-brain/forge.ts` 的 `FORGE_GUIDE`)由总机工具 `ghost_forge_guide` 现拿现读,是 agent 替用户编写意识的唯一教材——**手册过期 = AI 按旧规则写出过不了新校验的意识包**(校验拒装是兜底,但用户体验是"AI 反复打包反复被拒")。凡改动**意识作者可见的契约**,同一改动内必须同步更新手册对应章节:(a) `ghost.json` 身份卡字段或校验规则(`shared/ghost.ts` 的 `validateGhostManifest`);(b) 管子协议(`cindy.send` / `cindy.onHostMessage` 的消息形态,`shared/ghost.ts` 管子类型);(c) 模型代办菜单(`cindy-brain/modelSlot.ts` 的 kind / 参数 / 模型白名单);(d) 面板供片协议与注入的主题 token(`cindy-ghost://` 分支、`ghostPanelTheme.ts` 白名单);(e) 打包限制(`cindy-brain/forge.ts` 的 `packGhostDir`)。反向同理:改校验必须同步手册,改手册宣称的新能力必须真有实现。**PR 约束**:命中上述任一路径的 PR,Description 必须写明"手册已同步(改了哪节)"或"无需同步 + 为什么不涉及作者契约";review 时按此检查,漏同步 = P1。`forge.test.ts` 的关键章节存在性测试只是最低闸,不替代逐条人工核对。

### 安全红线

23. **用户凭证 / 授权信息绝不允许落入仓库工作区(凭证不入仓)**:任何代码——包括测试、mock、脚本、构建工具——都不得把凭证类文件(`auth.json`、OAuth / API token、`~/.codex` / `~/.claude` / userData 下的密钥与授权文件等)以复制、硬链接、软链接、落盘等任何形式写到仓库工作区或任何可能被 git 追踪的路径;`.gitignore` 只是兜底,不是防线——凭证一旦进 commit 推到远端,历史无法真正抹除,只能去服务端作废。**高危模式(编码与 review 必查)**:(a) 把 `userData` / `HOME` 等路径 mock 或回落到 `process.cwd()`,尤其平台差异型回落(如 `process.env.TEMP ?? process.cwd()`,TEMP 是 Windows 独有,macOS/Linux 直接落进仓库);(b) 模块级 import 副作用在构造期写盘 / 链凭证——任何传递性 import 都会触发、测试防不住,新代码禁止,存量应 lazy 化;(c) 运行时生成物写进仓库目录而非 `os.tmpdir()` / userData。测试涉及路径一律用 `os.tmpdir()` 下的临时目录并收尾清理;review 命中任一模式按 P0 阻断,「会被 gitignore」不是放行理由。

## 提 PR

提 PR 到 `github.com:xindong/cindy-moved` 时，**Description 规范以 `.github/PULL_REQUEST_TEMPLATE.md` 为准**（本仓模板三节：这次改了什么 / 怎么验证的 / 风险——涉及 SQLite migration、system prompt、协议、原生层或跨平台差异时必须在「风险」里说明）。Reviewer 只看 Title + Description 决定要不要 review、怎么 review，写不清楚直接退回。

**提交 PR 前、以及直接推送 commit 到 `main` 前,都必须在仓库根跑一次 `pnpm test:unit` 并确认全部通过——这是硬性门禁,没跑或没通过就不许提 PR / 不许 push main**。直推 main 没有 PR checks 兜底,这条门禁是唯一防线,同样不豁免。具体约束:
- 有失败必须**先在本地修复到绿灯**再提交,不许带着红灯开 PR 或 push main,也不许用 skip / 注释 / 删用例的方式"制造"绿灯。
- 修复后要**重新完整跑一遍** `pnpm test:unit` 确认整体通过,不能只跑刚修的那个测试文件就当整体通过。
- 若失败是主干既有基线问题(与本次改动无关),不要自行放行——先向用户说明并确认处理方式,再决定是否提交。
- PR 模板「怎么验证的」一节必须**如实**填写测试执行情况:没跑不许写已跑,跑了没过更不许写通过(该节不允许留空)。直推 main 虽无模板兜底,跑测试的义务不变。

**直推 `main` 的代码,commit 之前必须先起一个独立 subagent 对本次 diff 做对抗性 review**——这是与 `pnpm test:unit` 并列的硬性门禁,只对「不走 PR、直接推送到 `main`」的改动生效(走 PR 的改动由 PR review 流程兜底,不重复要求)。具体约束:
- 时序是 **review 在 commit 之前**:改动完成后先把工作区 diff(`git diff` / `git diff --staged`)交给 subagent 审查,review 通过后才允许 `git commit`,不许先 commit 再补 review。
- subagent 必须**独立审查**:给它的任务是对照本文档「设计实现规范」与「Review guidelines」的严重度口径找问题,不是让它复述"看起来没问题"。review 发现 P0 / P1 必须先修复,修复后把新 diff 重新交 review,直到无 P0 / P1 才能 commit + push。
- review 结果要**如实向用户汇报**:发现了什么、修了什么、subagent 最终结论,不许静默吞掉 findings。

## Review guidelines

- 审查对照本文档「设计实现规范」节与 `.github/PULL_REQUEST_TEMPLATE.md`（以现行内容为准，不要凭记忆）。
- 严重度沿用本仓 review 口径，映射到 GitHub：不改不能合（红线 / 崩溃 / 数据丢失 / 跨平台失效 / 安全）= P0；本次必须修但不阻断流程（明显 bug / 规范违反 / 影响面没处理干净）= P1；可选优化 / 风格偏好 = 不报（P2）。
