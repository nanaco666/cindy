# Linux Desktop Release Plan

> 状态：规划草案（2026-06-17）。
>
> 目标：把当前 Windows/macOS 优先的 desktop 发布链路扩展到 Linux。本文拆成两个可独立排期的计划：
> - **首版**：能交付给内部 Linux 用户真实使用的 `linux-x64` 客户端。
> - **完整版**：补齐接近 Windows/macOS 的平台体验、自动更新和语音输入能力。
>
> 范围：`apps/desktop`、根发布脚本、内置 agent / ripgrep / sqlite-vec 运行资产、CI 发布脚本。默认不改 server API、不改 maker-core agent 行为、不改系统提示词。

---

## 1. 当前状态

代码里已经有少量 Linux 运行时分支，但发布链路和运行资产没有打通。

| 领域 | 当前状态 | 关键代码 |
|---|---|---|
| pnpm 安装架构 | 只声明 `win32` / `darwin`，未纳入 Linux optional deps | `package.json` 的 `pnpm.supportedArchitectures` |
| 桌面发布命令 | 只有 `release:win` / `release:mac`，无 Linux | `package.json`、`apps/desktop/package.json` |
| Electron Forge maker | 只有 macOS ZIP 和 Windows NSIS | `apps/desktop/forge.config.ts` |
| sqlite-vec | 资源目录只有 macOS / Windows；加载器把非 Windows 都当 `.dylib` | `apps/desktop/native/sqlite-vec/**`、`apps/desktop/src/main/localDb/sqliteVecLoader.ts` |
| agent/ripgrep 运行资产 | `claude-code-bin` / `codex-bin` / `ripgrep-bin` 只有 macOS / Windows | `apps/*-bin/**`、`tools/*/update.mjs` |
| 自动更新 | main 里有 Linux AppImage 替换雏形，但没有 Linux 产物和 manifest 链路 | `apps/desktop/src/main/updateService.ts` |
| Deep link / 协议 | 运行时会调用 `setAsDefaultProtocolClient`，但 argv 注释仍写 Linux 暂不支持 | `apps/desktop/src/main/deepLink.ts` |
| 语音输入 | Linux 粘贴路径会调用外部 `xdotool key ctrl+v`，属于 X11 依赖；Wayland/未安装 `xdotool` 时不可视为完整支持 | `apps/desktop/src/main/voice-input/global.ts` |
| CI / smoke | smoke 脚本能解析 Linux packaged 路径；CI 只有 Win/Mac build/publish | `apps/desktop/scripts/smoke-packaged.mjs`、`apps/desktop/scripts/ci/**` |

---

## 2. 首版计划

### 2.1 首版目标

首版目标是 **Linux x64 可安装、可启动、可登录、可运行 Claude/Codex agent、可完成常规桌面对话与文件工作流**。

建议首版平台基线：
- Ubuntu 22.04/24.04 x64。
- 规划偏好 AppImage，以减少首版对 `fakeroot` / `dpkg` / 包仓库的依赖；当前首版实现已选择 Electron Forge `MakerDeb` / `.deb`，因此 Linux builder 必须显式具备 deb 打包依赖。若后续切回 AppImage 或同时支持多格式，需要重新评估 CI、下载页和自动更新策略。
- Remote API 模式优先，不把本地 server 作为首版发布目标。

首版明确非目标：
- 不承诺 Linux 自动更新完整可用；可以禁用更新入口或提示手动下载。
- 不承诺 Linux 全局语音输入“录完插入任意应用”完整可用；可以隐藏或降级该入口。
- 不承诺 Linux arm64。
- 不承诺所有桌面环境（GNOME/KDE/Wayland/X11）体验一致。

### 2.2 首版工作量

首版按 **10-18 人日** 估算。若 CI runner / Linux 签发与 OSS 发布环境已具备、且只交付单一安装格式，可压到 10-14 人日；如果必须同时做 deb + AppImage、补多发行版验收，或补齐 CI 系统依赖，会接近 18 人日。

| 模块 | 工作量 | 代码改动范围 | 交付内容 | 验收 |
|---|---:|---|---|---|
| 安装依赖与平台声明 | 0.5-1d | `package.json`、`pnpm-lock.yaml`、`apps/desktop/forge.config.ts` 的 `parcelWatcherPlatformPkg()` | `pnpm.supportedArchitectures.os` 增加 `linux`，并按首版目标明确 libc（优先 glibc）；修正 `@parcel/watcher` Linux 子包命名为 `@parcel/watcher-linux-x64-glibc`（必要时后续支持 `-musl`）。`sharp` 的 `@img/sharp-linux-x64` / `@img/sharp-libvips-linux-x64` 命名已匹配现有包 | Linux runner 上 `pnpm install` 成功；`bundleNativeDeps()` 能 resolve Linux watcher/sharp 子包；desktop typecheck 不因 optional deps 缺失失败 |
| Linux Forge 打包 | 2-3d | `apps/desktop/package.json`、`apps/desktop/forge.config.ts`、可能新增 `@electron-forge/maker-*` 依赖 | 新增 `release:linux` / `build:linux`；首版当前采用 `MakerDeb` / `.deb`，如改 AppImage 需同步调整 release/CI；补 Linux icon、desktopName、mime/category metadata；按 target platform 处理 `extraResource`，避免把 Windows-only `resources/cindy-updater.exe` / `resources/xdt-helper.exe` 无条件打进 Linux 包；`buildCindyUpdater()` 也应按 target platform 跳过非 Windows 目标 | `npx electron-forge make --platform linux --arch x64` 产出可执行安装包；Linux 包内不包含不可用的 Windows helper/updater，或有明确 stub/guard |
| Linux release 脚本 | 2-3d | 新增 `apps/desktop/scripts/release-linux.mjs`；根 `package.json` release script；复用或抽取 `apps/desktop/scripts/ci/lib.mjs` / Win/Mac release 公共逻辑 | 对齐 Win/Mac release 护栏：版本注入、`db:validate`、remote bundle、forge make、drizzle 校验、smoke、release manifest。避免一次性重构三套 release 脚本，优先局部复用 | `pnpm release:linux` 能在 Linux x64 上跑完 dry run / canary 产物生成 |
| sqlite-vec Linux 支持 | 1-2d | `apps/desktop/native/sqlite-vec/linux-x64/vec0.so`、`apps/desktop/forge.config.ts` 的 `copySqliteVecBinary`、`apps/desktop/src/main/localDb/sqliteVecLoader.ts` 的 `libFilename()`、`scripts/ensure-dev-runtime-assets.mjs`、`scripts/dev-embed-search.mjs`、相关测试 | 增加 Linux `.so` 命名规则和 LFS 资产；打包时复制到 `app.asar.unpacked`；dev 资产检查识别 Linux。注意 `ensure-dev-runtime-assets.mjs` 当前对非 macOS/Windows 直接返回空数组，改 Linux 时要同时纳入 Claude/Codex/sqlite-vec 三类 dev 资产 | Linux packaged smoke 里 sqlite-vec load 不报缺文件；语义搜索不可用时也要有明确日志 |
| agent / ripgrep 运行资产 | 2-3d | `tools/claude/update.mjs`、`tools/codex/update.mjs`、`tools/ripgrep/update.mjs`、`scripts/ensure-dev-runtime-assets.mjs`、`apps/desktop/scripts/release-claude-code.mjs`、`apps/desktop/scripts/release-codex.mjs`、`apps/desktop/scripts/release-windows.mjs` / `release-macos.mjs` 中可抽公共逻辑、`apps/desktop/src/main/agent-binaries/**`、`apps/desktop/src/main/maker-host/runtime-configs.ts` | 增加 `linux-x64` 下载、promote、校验、打包查找；补 `apps/claude-code-bin/linux-x64`、`apps/codex-bin/linux-x64`、`apps/ripgrep-bin/linux-x64`；确认官方 Linux 资产命名与运行依赖后再锁定排期下界 | Linux 客户端能启动 Claude/Codex agent；项目内 grep/search 走 bundled ripgrep 成功 |
| 首版更新降级 | 0.5-1d | `apps/desktop/src/main/updateService.ts`、`apps/desktop/src/renderer/lib/checkForUpdateWithToast.ts`、`apps/desktop/src/renderer/components/sidebar/UpdateBanner.tsx`、Linux release manifest 生成、四语言 `common.json` | Linux 首版不走半成品自动更新；检查更新返回明确 unsupported/manual-download 状态，或完全隐藏入口。Linux manifest 在更新器加固前不得发布 `app.hotfix`，只能提供 installer/manual-download 信息 | 发布 `manifest-linux-x64(-canary).json` 不会激活 `executeUpdateLinux()`；直到更新器加固并经 Lizi/owner 确认前，Linux manifest 不含 `app.hotfix` |
| 首版语音输入降级 | 0.5-1d | `apps/desktop/src/main/voice-input/global.ts`、`apps/desktop/src/shared/voiceInputData.ts`、renderer voice input settings / overlay 入口、四语言 `common.json` | Linux 隐藏全局语音输入入口，或只保留“录音转文字到应用内输入框”的可控路径；如果保留全局粘贴，必须显式 gate `xdotool` + X11 环境，不能让 Wayland/缺命令用户进入静默失败路径 | Linux 设置页不会展示不可用的全局粘贴能力；Wayland/缺 `xdotool` 时 readiness 明确不可用；已有 Windows/macOS 行为不变 |
| Deep link / OAuth 基础验证 | 0.5-1d | `apps/desktop/src/main/deepLink.ts`、`apps/desktop/src/main/bootstrap-electron.ts`、Forge Linux desktop metadata | 确认 Feishu OAuth browser flow、`xdt-maker://` 协议注册和冷启动 pending 机制在 Linux 包里可用；首版如不支持外部 deep link，要显式禁用复制入口或文档说明 | 登录成功；复制的 session/project deep link 在同一 Linux 桌面环境至少有一条 E2E 通过 |
| CI 与 smoke | 1-1.5d | 新增 `apps/desktop/scripts/ci/build-linux.mjs`、`publish-linux.mjs`；调整 CI 配置；`apps/desktop/scripts/smoke-packaged.mjs` | Linux runner 构建、打包、smoke；release manifest 写入 `platform: linux` / `arch: x64`。当前 `.deb` 首版 runner 需要 `fakeroot`、`dpkg`、`desktop-file-utils`，并保留 `@electron/rebuild` / `better-sqlite3` 所需的 `python3`、`make`、`gcc/g++` | CI 能产出 Linux 包并上传 canary 或 release artifact |
| 首版 QA | 1.5-2d | 不限代码；必要时补测试 | Ubuntu LTS 上完整验收：安装、启动、登录、agent 对话、权限确认、文件附件、ripgrep 搜索、DB migration、退出重启 | 形成首版验收记录；已知降级项在 UI/文档可见 |

### 2.3 首版建议 MR 切分

1. **MR1: Linux platform scaffolding**
   - 改 `package.json` / `apps/desktop/package.json` / `forge.config.ts`。
   - 增加 Linux maker 和 `release:linux` 空壳流程。
   - 按 target platform 处理 `extraResource`，避免 Linux 包携带 Windows-only `cindy-updater.exe` / `xdt-helper.exe`。
   - 验收：Linux 能 forge package/make 到最小可执行包，包内资源不含错误平台的 helper/updater。

2. **MR2: Linux runtime assets**
   - 补 sqlite-vec、Claude、Codex、ripgrep 的 `linux-x64` 资产链路。
   - 验收：packaged smoke + agent 二进制探测 + ripgrep 路径探测。

3. **MR3: Linux release script and CI**
   - 新增 `release-linux.mjs`、CI build/publish 脚本、manifest 输出。
   - 在更新器加固前，Linux manifest 不得写入或上传 `app.hotfix`；只允许 installer/manual-download 信息。
   - 验收：runner 产出 canary artifact；`manifest-linux-x64-canary.json` 不会触发客户端自动下载/应用 hotfix。

4. **MR4: Linux UX guardrails**
   - 自动更新和语音输入降级；deep link / OAuth 最小修正。
   - 验收：用户不会进入半成品功能路径，Ubuntu LTS 手工验收通过。

---

## 3. 完整版计划

### 3.1 完整版目标

完整版目标是 Linux 客户端在主功能上接近 Windows/macOS：
- 可安装、可自动更新或有等价的稳定升级路径。
- Claude/Codex、ripgrep、sqlite-vec、DB migration、SkillHub、Scheduler、IM 接管、通知等主流程在 Linux 上可长期使用。
- 语音输入在 Linux 至少支持主流桌面环境的全局录音与文本插入，或给出可靠的能力矩阵与 UI 分流。
- CI/CD 能持续发布 Linux canary/stable。

完整版从首版继续追加 **20-35 人日**。如果首版没有做 AppImage 而选择 deb，且完整版要求自动更新，会额外增加迁移成本；若同时扩多发行版、多架构和自动化 QA，会靠近区间高位。

### 3.2 完整版工作模块

| 模块 | 工作量 | 代码改动范围 | 交付内容 | 验收 |
|---|---:|---|---|---|
| 自动更新完整化 | 4-7d | `apps/desktop/src/main/updateService.ts`、`apps/desktop/cindy-updater/**`、`apps/desktop/forge.config.ts`、`apps/desktop/scripts/release-linux.mjs`、CI publish、manifest 生成与 promote 脚本、renderer update banner / toast | 明确 Linux 更新策略：AppImage 原地替换、下载新版安装包提示用户安装，或接入包管理仓库。若触碰 `cindy-updater`，必须先和 Lizi / owner 确认 | 从 Linux N 版升级到 N+1 版 E2E 通过；失败可恢复；日志能定位 |
| Linux 语音输入完整化 | 5-10d | `apps/desktop/src/main/voice-input/global.ts`、`SystemAudioMuteGuard.ts`、`apps/desktop/native/voice-input/**` 或新增 Linux helper、renderer voice input overlay/settings、`packages/voice-input-core` 仅在确需抽象时修改、四语言 i18n | 支持 Linux 全局快捷键、录音、文本插入、焦点恢复、剪贴板恢复。Wayland/X11 可走不同实现；不可支持的 DE 必须在 readiness 中明确降级 | Ubuntu GNOME Wayland、Ubuntu X11 至少通过；KDE/Fedora 记录兼容性 |
| Linux desktop integration | 3-5d | `apps/desktop/forge.config.ts`、`apps/desktop/src/main/deepLink.ts`、`apps/desktop/src/main/folderContextMenu.ts` 或新增 Linux 集成模块、renderer deep link 消费测试 | `.desktop` 文件、protocol handler、MIME/open-folder、图标、桌面分类、通知/托盘/badge 行为收敛 | 冷启动 deep link、已运行 deep link、文件夹打开、新建 session、通知点击行为通过 |
| 多发行版与架构扩展 | 3-6d | `package.json` supportedArchitectures、Forge maker 配置、`tools/*/update.mjs`、`apps/*-bin/linux-arm64`、`sqlite-vec/linux-arm64`、CI matrix | 从 `linux-x64` 扩到 `linux-arm64` 或 deb/rpm/AppImage 多格式；补各平台资产 | 每个新增平台都有 packaged smoke；缺官方 agent binary 时有明确不支持策略 |
| Release promotion and rollback | 2-3d | `apps/desktop/scripts/promote-canary-*.mjs` 抽象或新增 `promote-canary-linux.mjs`、release manifest、OSS key 结构、notice 生成流程 | Linux canary -> stable promote；失败回滚；release notice / manifest 与 Win/Mac 一致 | 发布演练完成，能从 canary 提升 stable |
| Linux QA automation | 3-5d | CI workflow、`apps/desktop/scripts/smoke-packaged.mjs`、可能新增 Playwright / CDP smoke、localDb migration replay 环境 | 在 Linux CI 上跑 packaged smoke、migration replay、agent binary readiness、sqlite-vec、基础 renderer E2E | 每次 Linux release 前自动阻断主要缺包/缺资产/DB 失败 |
| 文档与支持矩阵 | 1-2d | `apps/desktop/help-knowledge/**`、下载落地页 `apps/landing-page/**`、README / release docs、四语言 i18n | 下载页展示 Linux 包；帮助文档说明支持发行版、更新方式、语音输入限制 | 用户能从官网/内网拿到 Linux 包并知道限制 |

### 3.3 完整版建议 MR 切分

1. **MR5: Linux updater design and implementation**
   - 先出设计决策，再动 `updateService` / `cindy-updater` / release manifest。
   - `cindy-updater` 是高风险模块，改动前必须拿 owner 确认。

2. **MR6: Linux voice input**
   - 先支持一个明确矩阵：GNOME Wayland + X11。
   - renderer readiness 必须能按平台给出准确可用/不可用原因。

3. **MR7: Linux desktop integration**
   - protocol、open-folder、desktop file、通知行为收敛。

4. **MR8: Linux release hardening**
   - canary/stable promote、rollback、下载页、帮助文档、QA matrix。

---

## 4. 代码范围总表

| 功能组 | 首版涉及 | 完整版追加 |
|---|---|---|
| 根脚本 / pnpm | `package.json`、`pnpm-lock.yaml` | 多架构 matrix、release promote script |
| Desktop package scripts | `apps/desktop/package.json` | 多格式 Linux 发布脚本 |
| Forge config | `apps/desktop/forge.config.ts`，含 `MakerDeb` / Linux maker、`extraResource` 平台 gating、target-aware `buildCindyUpdater()`、sqlite-vec `.so` copy | AppImage/deb/rpm metadata、protocol/open-folder metadata、updater resources |
| Release scripts | `apps/desktop/scripts/release-linux.mjs`、`apps/desktop/scripts/ci/build-linux.mjs`、`publish-linux.mjs` | `promote-canary-linux.mjs`、公共 release helper 抽象 |
| Native DB assets | `apps/desktop/native/sqlite-vec/linux-x64/vec0.so`、`sqliteVecLoader.ts`、`ensure-dev-runtime-assets.mjs` | `linux-arm64`、更多 migration replay fixture |
| Agent binaries | `tools/claude/update.mjs`、`tools/codex/update.mjs`、`apps/claude-code-bin/linux-x64`、`apps/codex-bin/linux-x64`、`apps/desktop/src/main/agent-binaries/**` | 多架构、发布脚本抽象、缺失平台 fallback |
| Search binary | `tools/ripgrep/update.mjs`、`apps/ripgrep-bin/linux-x64`、`runtime-configs.ts` | 多架构与校验矩阵 |
| Update | 首版只做禁用/手动更新 guard：`updateService.ts`、renderer update UI、i18n、Linux manifest 不写 `app.hotfix`；同时在 Forge 资源层排除 Windows-only updater/helper | AppImage/package-manager 更新、`cindy-updater`、manifest/promote、rollback |
| Voice input | 首版只做 Linux 降级 guard：`voice-input/global.ts`、settings/overlay UI、i18n | Linux helper、Wayland/X11 insertion、mute guard、readiness matrix |
| Deep link / OS integration | `deepLink.ts`、Forge Linux metadata | `.desktop` / MIME / open-folder / notification click E2E |
| Tests / QA | `smoke-packaged.mjs`、CI Linux runner、migration replay | Playwright/CDP smoke、多发行版 matrix、update E2E |
| Docs / download | 首版 release note / known limits | landing page Linux 下载、help-knowledge、支持矩阵 |

---

## 5. 风险与决策点

1. **AppImage vs deb/rpm**：AppImage 覆盖面广，自动更新要自己负责；deb/rpm 更符合包管理器，但发行版覆盖和下载页复杂度更高。规划阶段建议优先 AppImage；当前首版实现选择 `.deb`，因此需要把 deb builder 依赖和后续自动更新迁移成本视为已接受的首版约束。
2. **Wayland 文本插入**：Linux 语音输入的最大不确定性在全局粘贴/焦点恢复，不同桌面环境差异大。首版应降级，完整版再单独攻。
3. **agent 官方 Linux 资产可得性**：Claude Code / Codex / ripgrep 的 Linux x64 资产需要确认官方发布命名和执行依赖。缺任一项都不能称为功能完整。
4. **sqlite-vec Linux 分发**：`.so` 需要与 Electron/系统 glibc 环境兼容。必须在 Linux packaged smoke 中真实 load，而不是只检查文件存在。
5. **自动更新安全性**：当前 Linux 更新代码仍保留直接替换 `APPIMAGE` 路径的旧雏形，缺少 release 产物链路、失败恢复和权限处理；在当前 `.deb` 首版方案下，这条路径应视为 dormant stub，而不是可发布能力。客户端按 `manifest-linux-x64(.json/-canary.json)` 分平台拉 manifest；一旦 Linux manifest 含 `app.hotfix` 就会激活未加固路径。首版发布 manifest 前必须显式禁止 Linux `app.hotfix`，完整版前必须做 E2E。
6. **CI runner 环境**：Electron Linux 打包常见依赖需要在 runner 明确安装。当前 `.deb` 首版至少需要 `fakeroot`、`dpkg`、`desktop-file-utils`；如后续增加 AppImage/RPM，还要补 FUSE、`rpm` 等对应依赖。`forge.config.ts` 的 `rebuildNativeDepsInPackage()` 会用 `@electron/rebuild` 强制重编 `better-sqlite3`，Linux runner 还必须有 node-gyp/C++ 构建工具链（python3、make、gcc/g++ 等）。
7. **Windows-only extraResource**：当前 `forge.config.ts` 无条件声明 `resources/xdt-helper.exe` / `resources/cindy-updater.exe`，且 `buildCindyUpdater()` 只在 Windows host 上构建。首版即使禁用 Linux 自动更新，也必须在打包层按 target platform 排除或替换这些资源，否则 Linux 包会携带错误平台二进制。

---

## 6. 建议成功标准

首版成功标准：
- Linux x64 包能安装/启动。
- Feishu 登录成功。
- 新建本地项目会话，Claude/Codex 至少各完成一次 agent turn。
- ripgrep、SQLite migration、sqlite-vec load 或明确降级路径通过。
- Linux manifest 不含会激活未加固更新器的 `app.hotfix`。
- 自动更新和语音输入不可用项不会暴露成可点击但失败的主流程。

完整版成功标准：
- Linux canary/stable 发布与 Win/Mac 一样可重复执行。
- Linux 客户端能从上一版升级到下一版。
- GNOME Wayland + X11 至少覆盖语音输入全局插入。
- deep link / open-folder / notification 主路径通过。
- CI 阻断缺资产、DB migration、packaged smoke、update E2E 的主要回归。

---

## 7. 开发自测清单

下面清单默认用于每个 Linux 相关 MR 合入前的开发自测；如果是纯文档或纯排期调整，可跳过与代码无关项，但要在 MR 描述里注明跳过原因。

### 7.1 首版必跑

1. 依赖与静态检查
   - `pnpm install`
   - `pnpm --filter desktop exec tsc --noEmit`
   - 如改了 locale / manifest JSON，额外用 Node 逐个 parse 相关文件

2. Linux 发布脚本检查
   - `node --check apps/desktop/scripts/ci/build-linux.mjs`
   - `node --check apps/desktop/scripts/ci/publish-linux.mjs`
   - `node --check apps/desktop/scripts/release-linux.mjs`

3. 运行资产检查
   - 确认 `apps/desktop/native/sqlite-vec/linux-x64/vec0.so`
   - 确认 `apps/claude-code-bin/linux-x64/claude`
   - 确认 `apps/codex-bin/linux-x64/codex`
   - 确认 `apps/ripgrep-bin/linux-x64/rg`
   - 在修正 Linux 分支后直接运行 `node scripts/ensure-dev-runtime-assets.mjs`，确认它检查到 Claude/Codex/sqlite-vec 三类 Linux dev 资产，而不是空通过
   - 若改了 `tools/*/update.mjs`，至少验证生成路径、文件名和上游 asset 命名一致

4. 定向测试
   - 语音输入相关改动：`pnpm --filter desktop exec vitest run src/renderer/voice-input/__tests__/dictionaryLearningSettings.test.ts src/main/voice-input/__tests__/globalShortcut.test.ts`
   - DB / migration 相关改动：`pnpm --filter desktop test:migration-replay`
   - update / manifest 相关改动：补对应单测或至少手动验证 `manifest-linux-x64(-canary).json` 不含 `app.hotfix`

5. Linux 打包前置
   - 在 Linux runner / Linux 本机确认 builder 依赖：`fakeroot`、`dpkg`、`desktop-file-utils`
   - 确认 native rebuild 工具链：`python3`、`make`、`gcc/g++`
   - 首版当前是 `.deb`，所以自测不得只停留在脚本 `node --check`

### 7.2 首版发布前必跑

1. Linux 环境执行
   - `npx electron-forge make --platform linux --arch x64`
   - `node apps/desktop/scripts/smoke-packaged.mjs --platform=linux --arch=x64`

2. 发布链路验证
   - `pnpm --filter desktop release:linux -- --version <x.y.z>` 或等价 canary dry run
   - 检查 release manifest 中 `platform: linux`、`arch: x64`
   - 检查 Linux manifest 仅包含 installer/manual-download 信息，不包含 `app.hotfix`
   - 如改了更新逻辑，补客户端侧断言或手工验证：即使遇到误带 `app.hotfix` 的 Linux manifest，首版 guard 也不会进入可发布的自动更新主流程

3. 包内容核对
   - Linux 包内不应包含 `resources/cindy-updater.exe` / `resources/xdt-helper.exe`
   - Linux 包内应包含 ripgrep、sqlite-vec、Claude、Codex 所需运行资产

### 7.3 完整版追加自测

1. 若进入自动更新开发
   - 必补 Linux update E2E：N -> N+1 升级、失败恢复、日志检查
   - 如触碰 `apps/desktop/cindy-updater/**`，改动前后都要记录 owner 确认

2. 若进入语音输入完整化
   - Wayland 与 X11 分开验证
   - 覆盖快捷键注册、录音、文本插入、失败提示、readiness 文案

3. 若进入多格式/多架构
   - 每新增一种格式或架构，都要独立跑 packaged smoke 与 asset readiness

---

## 8. 人工测试单

这份测试单面向 QA、开发自验和发布前 smoke。首版至少覆盖 Ubuntu 22.04/24.04 x64；完整版再扩到更多桌面环境与发行版。

### 8.1 首版人工测试单

| 编号 | 场景 | 步骤 | 预期结果 |
|---|---|---|---|
| LNX-MANUAL-001 | 安装 `.deb` | 在 Ubuntu x64 安装首版 `.deb` | 安装成功，桌面应用可见，图标与应用名正确 |
| LNX-MANUAL-002 | 首次启动 | 启动应用 | 应用正常进入启动流程，无缺少二进制/缺少 `.so` 的阻断报错 |
| LNX-MANUAL-003 | Feishu 登录 | 触发登录，走浏览器或内嵌 OAuth 流程 | 登录成功，主界面可进入 |
| LNX-MANUAL-004 | 新建 Claude 会话 | 新建项目会话并发一条消息 | Claude 至少完成一次完整 turn |
| LNX-MANUAL-005 | 新建 Codex 会话 | 新建项目会话并发一条消息 | Codex 至少完成一次完整 turn |
| LNX-MANUAL-006 | 文件工作流 | 在项目里浏览文件、打开文本文件、执行一次搜索 | 文件树可用，ripgrep 搜索返回结果 |
| LNX-MANUAL-007 | sqlite-vec | 触发依赖 embedding / 检索的路径，并检查 sqlite-vec 相关日志或状态 | sqlite-vec 成功加载；若降级也有明确日志或状态信号（例如 load error / fallback），不是静默失败 |
| LNX-MANUAL-008 | 更新入口降级 | 手动点击“检查更新”或观察更新入口 | 不触发 hotfix 下载；若保留入口，显示 manual-download 提示 |
| LNX-MANUAL-009 | 语音输入降级 | 打开设置页 Voice Input | Linux 首版不展示不可用的全局快捷键录制能力；禁用项有明确文案 |
| LNX-MANUAL-010 | Deep link / 协议 | 在同桌面环境下触发 `xdt-maker://` 链接 | 已支持的路径能拉起应用；未支持的路径有明确限制说明 |
| LNX-MANUAL-011 | 重启与二次启动 | 退出应用后再次启动 | DB migration 不报错，应用仍可正常进入 |
| LNX-MANUAL-012 | 已知限制可见性 | 检查下载说明、UI 提示、release note | 首版降级项可见，不存在“可点击但必失败”的主流程入口 |

### 8.2 完整版追加人工测试单

| 编号 | 场景 | 步骤 | 预期结果 |
|---|---|---|---|
| LNX-MANUAL-101 | 自动更新 E2E | 从 N 版升级到 N+1 版 | 更新成功，失败时可恢复 |
| LNX-MANUAL-102 | Wayland 语音输入 | 在 GNOME Wayland 下触发全局语音输入 | 快捷键、录音、文本插入、失败提示符合设计 |
| LNX-MANUAL-103 | X11 语音输入 | 在 X11 环境重复语音输入流程 | 行为与支持矩阵一致 |
| LNX-MANUAL-104 | open-folder / MIME | 从文件管理器或外部协议打开项目/文件夹 | 应用能正确接收并落到对应页面 |
| LNX-MANUAL-105 | 通知点击 | 触发系统通知并点击 | 行为与 macOS/Windows 对齐，至少不丢失会话上下文 |
| LNX-MANUAL-106 | canary/stable promote 回归 | 安装 canary 后升级 stable，或执行回滚演练 | 发布链路与回滚策略可验证 |

### 8.3 测试记录要求

1. 每次首版发布候选至少附一份人工测试记录，包含测试环境、包版本、执行人、结果、阻断问题。
2. 若某项因平台限制或环境缺失跳过，必须写明跳过原因，不能留空。
3. 发现的问题要标注是首版已接受降级，还是发布阻断项。
