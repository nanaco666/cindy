# Cindy 品牌迁移:全仓 `xdt-maker` / `XDMaker` 出现点三分类清单

> 状态:草案 v2(已吸收 2026-07-09 事实核查评审:48 条核对,修正 4 处事实错误、5 处遗漏、3 处分类争议)。配套文档:[`migration-state-machine.md`](./migration-state-machine.md)(迁移状态机与双端契约,v3 B′ 方案)。
>
> **与 [`docs/branding-rename-checklist.md`](../branding-rename-checklist.md) 的关系**:那份是显示层改名的 authoritative 清单(`BRAND_NAME` 单点 + 手动清单 + 外部协调项),其 §四 明确"标识符层绝对不动;若产品决策要求连标识符一起换,必须为每一项单独设计迁移方案"。**本次 Cindy 计划正是那个产品决策**——本清单即标识符层的逐项迁移设计,显示层不重复罗列、直接执行那份 checklist(把 `BRAND_NAME` 改为 `Cindy` 起步)。
>
> 数据来源:全仓 grep(约 1700 处、400+ 文件)+ 三路代码实勘(主进程身份锚点 / userData 与 agent 侧 / 构建发布链),关键锚点已逐个 grep 复核。

## 0. 分类定义

| 分类 | 含义 |
|---|---|
| **A 改** | Cindy 渠道版本中改为新品牌值,需配套的迁移/兼容动作在"处置"列写明 |
| **B 不改** | 永久保留旧值——内部标识、兼容锚点,改了只有风险没有收益 |
| **C 老渠道保留** | 双轨项:老渠道过渡版必须维持旧值(更新链/迁移依赖),Cindy 渠道用新值。本质是"A 改 + 为老渠道保留一条旧值构建路径" |

改名基线(**2026-07-09 已拍板**,见状态机文档 §10/§11):显示名 `Cindy`、executableName `cindy`、appId/bundleId `com.magiclizi.cindy`、主 scheme `cindy://`、userData 目录 `Cindy`、CDN 前缀 `/cindy`、版本号从 `1.0.0` 起步。所有 A/C 类标识符值统一从新增的**构建期身份配置单点**(`brand-identity`,状态机文档 §11)派生,未来再改名只动配置 + 出迁移 manifest。

## 1. OS 注册身份层(改名工程的核心)

| 锚点 | 位置 | 分类 | 处置 |
|---|---|---|---|
| `productName: "xdt-maker"`(决定 userData 目录名 / mac `.app` 名) | `apps/desktop/package.json:3` | **C** | Cindy 渠道改;过渡版保持(userData 路径是迁移 source)。注意 `forge.config.ts` 里另有 MakerDeb `productName: 'XDMaker'` 与 NSIS `shortcutName: 'XDMaker'` 两个**显示名**字段,与此解耦,走 checklist 显示层 |
| `executableName: 'xdt-maker'` | `forge.config.ts` packagerConfig | **C** | Cindy 渠道改 `cindy`;老渠道 updater 契约 `--exe-name xdt-maker.exe` 依赖旧值 |
| NSIS `appId` + `WINDOWS_APP_USER_MODEL_ID`(均为 `com.magiclizi.xdt-maker`) | `forge.config.ts:896`、`bootstrap-electron.ts:4044` | **C** | **AUMID 三位一体**(NSIS appId = 运行时 setAppUserModelId = 快捷方式 AUMID),Cindy 渠道三处同一 PR 改 `com.magiclizi.cindy`,任何一处漂移 = toast 静默丢失 |
| `DEEP_LINK_PROTOCOL = 'xdt-maker'` | `main/deepLink.ts:45` | **A + B** | Cindy 主 scheme 改 `cindy://`;**`xdt-maker://` 永久双注册 + 双解析**(存量链接不能死)。⚠️ renderer 侧有 **7 处独立硬编码副本**,均非从常量派生:`renderer/lib/deepLink.ts:9`、`remarkSessionLinks.ts:26,30`、`userMessageLinkify.ts:40,111`(字符串长度切片!)、`MarkdownRenderer.tsx:208`(**URL 消毒白名单**,漏改则 `cindy://` 被 react-markdown 消毒成空 href)、`:1547,1559`(session-card/chip 判断)——双 scheme 改造必须收敛到 shared 单点。⚠️ 桌面之外还有两个解析方,见 §5 协调项 |
| 文件夹右键菜单注册表键 `Directory\shell\xdt-maker` | `main/folderContextMenu.ts:60-61`、`resources/installer.nsh` | **A** | Cindy 自愈写新键 `...\shell\cindy`(显示文案已走 `BRAND_NAME`,自动跟随);旧键由老 NSIS 卸载器清理(customUnInstall 已有) |
| `.cindy` 文件关联 ProgId `XDMaker.CindyGhost` | `main/brain/fileAssociation.ts:31` | **A** | 改 `Cindy.CindyGhost`;Cindy 首启自愈重写 `.cindy` → 新 ProgId 并删旧 ProgId 键 |
| mac UTI `com.magiclizi.xdt-maker.cindy` / `.cshare`、`CFBundleDocumentTypes`、`protocols` | `forge.config.ts` extendInfo | **A** | 随新 bundleId 声明 `com.magiclizi.cindy.*`;protocols 数组同时声明 `cindy` 与 `xdt-maker`(双注册的 mac 半边) |
| dev 沙箱目录 `xdt-maker-dev[-<name>]` | `main/index.ts:57-74` | **A(低优)** | 纯 dev 侧,随 productName 自然变化 |

## 2. 数据与路径层(硬编码 userData 路径是重灾区)

| 锚点 | 位置 | 分类 | 处置 |
|---|---|---|---|
| 主库文件名 `xdt-maker-<userId>.db` | `localDb/index.ts:81` | **A(带迁移)或 B** | **§10 遗留待确认项**(与状态机文档同源):无论前缀是否改变,新 auth uid 都先经 identity anchor 认领；改前缀时 `brand-identity.legacyDbFilePrefixes[]` 扫旧名、online backup 到当前 `dbFilePrefix`，不改则只换 uid |
| 桌面 codex-home 三平台硬编码路径 `.../xdt-maker/codex-home` | `codex-local-sessions.ts:882-887` | **A(低危)** | 事实核查修正:`getDesktopCodexHome()` 首选 `app.getPath('userData')`(:873-876),硬编码仅是非 Electron 测试兜底——打包版运行时自动跟随新目录,顺手改即可 |
| skillhub 用量索引器三平台硬编码 userData 路径 | `skillhub/usageIndexer.ts:377-379` | **A(必改)** | 与上一行不同:生产调用链 options 为空,`resolveTranscriptDiscoveryContext` 直接落到硬编码 default,漏改则转录索引**静默失效** |
| 孤儿进程收割器路径标记 `XDT_CLAUDE_PATH_MARKERS`(`appdata\roaming\xdt-maker\claude-code\` 等 3 条) | `claude-orphan-reaper.ts:37-41` | **A(双匹配)** | 标记编码了 userData 目录名。Cindy 版**新旧两组标记同时匹配**:迁移窗口期老 app spawn 的 claude 进程命令行里是老路径,只认新路径会漏收割孤儿进程 |
| `MANAGED_PROFILE = 'XDMaker'`(自动化浏览器 profile 名) | `mcp-integrations/browser.ts` | **B** | checklist §四明确:改了 = 浏览器自动化丢登录态。profile 数据随 userData 迁移搬运(状态机文档 §4.1 已列必迁),名字不动 |
| codex rollout `originator: 'xdt-maker'` | `codex-local-sessions.ts:628` | **B** | 已写进存量 session 文件的识别字段;读取侧永远兼容旧值,整体不改 |
| settings 命名空间 `xdtMaker.*`(用户工作区 `.claude/settings.json` 内) | `maker-host/plugins/settings-reader.ts` | **B** | 用户文件里的存量键,改名 = 老用户设置失效;不改 |
| SSH key 默认名/注释 `xdt-maker` / `xdt-maker@<host>` | `remote-ssh/ssh-keys.ts:107,126,127,524` | **A(新生成)+ B(存量)** | 新生成默认 `cindy`;存量密钥文件与远端 authorized_keys 不动,识别逻辑兼容旧名(checklist §四同判) |
| `xdt-image://` / `xdt-audio://` / `xdt-video://` / `xdt-file://` / `xdt-model://` / `xdt-remote-media://` privileged scheme 及 CSP 白名单 | `imageProtocol.ts:23`、`audioFileProtocol.ts:57`、`modelProtocol.ts`、`shared/remoteMediaUrl.ts:56-61`、`security/csp.ts:49-62` | **B** | 进程内 scheme 族(共 6 个),不注册到 OS,改造无收益;且 `xdt-image://` URL 已确认持久化在 DB 消息内容中(§6-3),**永久不改** |
| MCP server 名 `lizi_xdt_helper`、`clientInfo: { name: 'xdt-maker' }` | `packages/lizi-mcps`、maker-core codex | **B** | 改名变更 tool 前缀/握手标识 → 破坏 permission 白名单、触碰规则 10 缓存稳定性;不改 |
| localStorage 键 `xdt-maker:lastReadVersion` 等 | `useUpdateNotice.ts:14,198` | **B** | 公告水位随 `Local Storage/` 迁移继承;改键名 = 重弹全部公告 |
| `.cshare` 扩展名(及旧 `.xdtshare` 兼容) | `localDb/ipc/session-share.ts` | **B** | 历史分享文件必须永远打得开(checklist §四同判) |
| `.xdmaker/` 项目级目录(project-knowledge、automations)、`~/.xdmaker/themes` | `maker-ipc/projectContextInject.ts:25`、`scheduler-host/project-automation-loader.ts:30`、`local-themes/loader.ts:30` | **B** | **已提交进用户/协作者仓库的共享资产**,改名破坏所有存量仓;不改(未来若改需双读) |
| temp 命名 / User-Agent / CUA driver 进程名 / 日志前缀 `[xdt-maker]` | `updateService.ts`、`computer.ts`、`android.ts`、`index.ts` | **B(可选低优改)** | 进程内/临时命名,无兼容约束,Cindy 渠道可顺手改,不作为迁移依赖 |
| `XDT_*` 环境变量族、helper 二进制名 `xdt-*`、`@xdt-maker` 包名、`xdt/` 分支前缀、`.xdt-worktrees/` | 全仓 | **B** | 内部接口与协作约定(checklist §四同判) |

## 3. 更新分发链(双轨核心,详见状态机文档 §8)

| 锚点 | 位置 | 分类 | 处置 |
|---|---|---|---|
| CDN 根 `.../xdt-maker`(外网/内网两条) | `manifestService.ts:77-78` | **C** | 老客户端永远只看旧路径 → 老渠道 manifest 钉在过渡版;Cindy 版常量改 `/cindy` 前缀 |
| OSS 前缀 `OSS_PREFIX='xdt-maker'`、产物名 `xdt-maker-{version}[-arch].{zip,dmg,deb}` / `-Setup.exe`、packaged 目录 `out/xdt-maker-*` | `release-*.mjs`、`scripts/ci/*`、`smoke-packaged.mjs` | **C** | 发布脚本 brand 参数化:老渠道过渡版产老名,Cindy 渠道产新名传 `/cindy`。**严禁覆盖已发布的 `/xdt-maker` 版本化路径**(immutable 守卫 + 2026-07-03 CDN 缓存分裂事故) |
| canary/stable promote 脚本 | `promote-canary-*.mjs` | **C** | 同上参数化;迁移链路先老渠道 canary 验证再 promote |
| updater 契约 `--exe-name` / `--app-dir`、mac 按 `.app` 路径替换 | `updateService.ts:784-786,840,893-894` | **C(零代码)** | 已核实为运行时派生(`path.basename(app.getPath('exe'))`),过渡版与 Cindy 版都无需改——exe 名跟着实际进程走。(`:897-898` 的 `xdt-maker-update-<ts>` 是 temp 命名,归 §2 B 项) |
| xdt-updater(产品名、窗口标题"xdt-maker 更新"、UI 文案) | `xdt-updater/` 全目录 | **C** | 过渡版原样(它要执行迁移);Cindy 渠道首版改"Cindy 更新"(整体改名 cindy-updater 与否见状态机文档 §10-5) |
| `installer.nsh` 全套(kill 进程名、快捷方式、右键菜单键) | `resources/installer.nsh` | **C** | Cindy 出新变体;老渠道文件不动 |
| xdt-updater 免 UAC 安装路径判断 | `installer.rs:104` | **C(零代码)** | 事实核查修正:`needs_elevation()` 是通用可写性探测,与目录名无关(`:102` 的 `xdt-maker` 仅注释);`%LOCALAPPDATA%\Programs\Cindy` 同样可写、天然免 UAC |
| GitLab CI release job(`smash/xdt-maker`、通知文案) | `.gitlab-ci.yml` | **C** | 新增 Cindy release job;repo 改名不在本次范围 |
| landing page(`CDN_DIRECT`、manifest 读取路径、标题) | `apps/landing-page/index.html:6,192-218` | **A(独立开关)** | Cindy 首版 promote stable 后切换,与存量迁移解耦 |
| 公告系统消费 URL(`/notice/...`) | `releaseNotesService.ts` | **C** | Cindy 走 `/cindy/notice/`;老渠道 notice 停更于过渡版公告 |

## 4. 显示文案层 → 直接执行 `branding-rename-checklist.md`

不在此重复。要点摘录:`BRAND_NAME`(`packages/maker-shared/src/branding.ts`)改 `Cindy` 覆盖约 80% 展示面;之后过那份 checklist 的手动清单(forge 显示名字段、图标素材、help-knowledge 重生成、mobile、server 文案、prompts/skills、landing page)+ 外部协调项(飞书/Slack 应用名、`BRAND_WEBSITE_URL` 新域名、GitHub 仓库)。两点补充:

1. **规则 10/11 合规**:`BRAND_NAME` 进入 MCP 工具描述(prompt 前缀),改值一次性打破 prompt cache 并可能影响模型对产品的称呼——checklist 已标注,发版前按规则 10 做缓存率/行为抽查,PR 写明;系统提示词相关段落若涉及,按规则 11 先与 Lizi 确认。
2. **guard 词表**:Cindy 渠道分支把 `XDMaker` 及变体加入 `FORBIDDEN_TERMS`(replacement 指向 `Cindy`);老渠道分支不动。

## 5. 不属本次范围(单独立项)

| 项 | 说明 |
|---|---|
| GitHub 仓库名 `xindong/XDMaker`、`GITHUB_REPO` 默认值 | 仓库改名独立决策(checklist 外部协调项之一) |
| `apps/mobile` 品牌串 | 手机版改名走独立发版轨道(EAS/包名/商店条目),单独立项 |
| **深链外部解析方(功能耦合,必须协调时序)** | ⚠️ 事实核查发现:`apps/slack-hook-server/src/slack/bot.ts:92`(`SESSION_LINK_RE` 只认 `xdt-maker://`)与 `apps/mobile/src/session/sessionLinks.ts:3` + `messageMarkdown.ts:551-552`——桌面端一旦开始**生成** `cindy://` 链接,这两端的会话绑定/链接渲染立即断。时序要求:两端先落地双前缀解析并上线,Cindy 首版才允许切换链接生成侧(或首版暂缓切生成、仍产 `xdt-maker://`) |
| 飞书 OAuth 应用、`xdt-api` 域名、device-link/heartbeat 等服务端资产 | 与客户端解耦,单独排期(部分在 checklist 外部协调项) |
| 注释、测试 fixture、历史文档(`docs/design_docs/*.pen` 等)中的品牌串 | 随各 PR 顺手改,不作为迁移依赖,历史文档不回溯 |

## 6. 核对项结论(已在真机/代码落定,2026-07-09)

1. **Windows 实际安装目录 = `%LOCALAPPDATA%\Programs\xdt-maker`**(开发机实查)。卸载注册表键是 **appId 派生的 GUID**(`HKCU\...\Uninstall\23596995-63c1-...`),DisplayName 为 `xdt-maker <version>`,且带 `QuietUninstallString`(`"...\Uninstall xdt-maker.exe" /currentuser /S`)——迁移程序"静默卸载老程序"直接按 DisplayName/InstallLocation 定位该键调 QuietUninstallString 即可,不自己拼命令。新 appId → 新 GUID,与老条目零冲突。
2. **`--exe-name` 是运行时派生**:`updateService.ts:784-786` 取 `path.basename(app.getPath('exe'))`,`--app-dir` 同理。**过渡版此链路零改动**;Cindy 版自动传新 exe 名,无需碰这段代码。
3. **`xdt-image://` URL 确认持久化在 DB 消息内容中**:`imageCacheOrphanSweep.ts:26` 的孤儿清理 SQL 直接 `content LIKE '%xdt-image://%'`,工具结果 JSON 亦存 `xdt_image_url` 完整 URL。**坐实 §2 的 B 分类**——该 scheme 族(image/audio/video/file)永久不改。
4. **MakerDeb 双名分工**:`name/bin: 'xdt-maker'`(包名/可执行名)+ `productName: 'XDMaker'`(显示名),仅 Linux .deb 使用;Cindy 渠道构建变体两者一并映射(`cindy` / `Cindy`),无迁移逻辑,低优先级。

## 7. 执行顺序建议(与状态机文档 §8 渠道策略配套)

1. **P0(过渡版,老渠道)**:迁移编排(下载 Cindy 包 + marker + mac handoff 导出 + 执行窗口进程内装/拉起,B′ 无独立执行器)。**零改名**——过渡版身份必须原样。
2. **P1(Cindy 首版)**:§1 OS 身份全套 + §2 A 类(含三处硬编码 userData 路径、收割器双标记)+ §4(执行 checklist)+ §3 发布脚本参数化 + 双 scheme 注册/解析收敛 + 首启健康检查与自愈(快捷方式、右键菜单、ProgId)。
3. **P2(切换期)**:老渠道 canary 验证迁移 → promote → landing page 切换 → server 侧文案 → 老渠道 manifest 钉版。
4. **P3(收尾)**:B 类"可选低优改"项、注释/文档清理、guard 词表收紧、`docs/branding-rename-checklist.md` 与本清单合并修订。
