# 手机版开发与发版工作流(apps/mobile)

> 这是手机版「日常开发 → 自测 → 对外发版」的权威工作流。脚本负责确定性流程,文档只说明模型、契约和人工决策边界。

> `release:check` / `release:beta` / `release:prod` 会自检 EAS 登录态;首次使用需 `npx eas-cli login`。升级 `eas-cli` 前必须重新验证 production fingerprint 红线。

## 三条轨道

| 轨道 | 用途 | 跟随哪个版本 | 隔离边界 | 入口 |
|---|---|---|---|---|
| 模拟器 | 日常 active 开发 | 当前 worktree,实时 Fast Refresh | 本机 Metro,不走 OTA/channel | `pnpm mobile:sim:start` |
| 手机 Beta | 真机自测 | 当前研发分支,手动切 | per-dev channel `beta-<dev>` | `pnpm mobile:release:beta -- --dev <dev>` |
| 正式服 | 对外同事/用户 | `main` 实际状态 | `production` channel,权限和版本受控 | `pnpm mobile:release:prod` |

自测走模拟器 + 手机 Beta;对外走正式服。正式服只从 `main` 手动发,不从 feature 分支直接发。

## 模拟器

模拟器调试已经代码化:

```bash
pnpm mobile:sim:start                       # 国服(默认)
pnpm mobile:sim:start -- --region=global   # 海外
pnpm mobile:sim:whoami                     # 检查国服安装包 + Metro/worktree
pnpm mobile:sim:whoami -- --region=global  # 检查海外安装包 + Metro/worktree
pnpm mobile:sim:rebuild                     # 国服(默认)
pnpm mobile:sim:rebuild -- --region=global # 海外
```

脚本固定 Metro 8081、注入当前 git branch/commit 给新建会话页顶部的 `__DEV__` build label,避免多 worktree 连错 bundle。`mobile:sim:start` / `mobile:sim:rebuild` 会按所选 region 把构建身份与对应 `config/endpoint*.json` 的 `cdnBaseUrl` 同步到 `apps/mobile/.env`,无需手动注入参数或复制 `.env.example`；`mobile:sim:whoami` 用同一份 region 配置解析实际 bundle id，不维护独立硬编码。具体排障见 [`simulator-debugging.md`](./simulator-debugging.md)。
切到 global 时原生 bundle identity / scheme 也会变,先用同 region 的 `mobile:sim:rebuild` 重装开发包,再用 `mobile:sim:start -- --region=global` 启动 Metro。

### PR 与聚合验证顺序

仓库改动正常先在任务 worktree 完成。默认交付顺序为：定向验证与本地 commit → 按开发者 / 宿主 workflow 完成发布授权 → push 任务分支并创建 / 更新 PR → 刷新 verify / personal client checkout → 在该验证 checkout 启 Metro。刷新后、启动 Metro 前，聚合验证记录必须同时列出作为基线的 `main` commit、待验证 PR commit 与聚合后的 `HEAD`，证明验证 checkout 确实由最新 `main` + 待验证 PR 组成。不要仅为了让运行中的 base checkout 立即 HMR 就自行修改或 push `main`；有权决定的开发者明确选择 local merge-back 或直推 `main` 时，按根 `AGENTS.md` 的例外门禁执行。

聚合验证时，除上述三个 commit SHA 外，运行实例还必须具备同一组三件套证据：

1. `pnpm mobile:sim:whoami` 显示 8081 属于当前验证 checkout。
2. App 的 `__DEV__` build label 显示该 checkout 的 branch 与 Metro host:port。
3. Metro 在本次修改后打印新的 `iOS Bundled ...`。

personal client 的具体目录和刷新 helper 属于开发者本机规则，不在仓库文档写死；团队共享契约只有“验证 checkout 必须由最新 `main` + 待验证 PR 组成”。

## Xcode 本地开发(region)

需要在 Xcode 里选择真机 / 模拟器、调签名或看原生日志时,从仓库根运行同一条命令;不传 region 时默认国服:

```bash
pnpm mobile:xcode                   # 国服(默认):com.xd.cindycn / cindycn
pnpm mobile:xcode --region=global   # 海外:com.xd.cindy / cindy
```

命令会把所选 region 与对应 endpoint 清单自举基址同步到 `apps/mobile/.env`,再执行 iOS clean prebuild、安装 Pods、打开 app 的 `.xcworkspace`,最后在当前终端持续运行 Metro 8081。固定 clean prebuild 是为了防止从 cn / global 切换时复用旧 `ios/` 里的 bundleId / scheme。它只准备本地 Xcode 开发工程,不 archive、不上传 NPKG / OSS、不写发版记录。Xcode 打开后保持命令所在终端运行,选择目标设备并点击 Run。切 region 时如果 8081 已有旧 Metro,命令会在改文件 / prebuild 前拒绝执行,避免 native 与 JS 使用不同地区。

## 手机 Beta

Beta 现在就是多开发者模型,不是未来目标:

- build profile、channel、branch 同名:`beta-<dev>`。
- 已 seed `beta-dash`;新增开发者用 `pnpm mobile:beta:add-dev -- <dev> --execute` 生成 profile,并创建/关联同名 EAS channel -> branch。
- 同正式服 region 身份与 OAuth callback scheme；登录统一走 Cindy auth-server，原生飞书 SSO 已退役。
- 同 bundleId 的代价:一台手机同一时间只能装一个 Cindy mobile 变体;多个 beta 分支串行切,不能并存。
- Beta 显示名为 `Cindy Beta (<dev>)`;缺少 dev 时退回 `Cindy Beta`。

### Beta 命令

```bash
pnpm mobile:release:check -- --target beta --dev dash
pnpm mobile:release:beta -- --dev dash --message "验证输入队列"
pnpm mobile:release:beta -- --dev dash --message "验证输入队列" --execute
```

`release:beta` 必须显式传 `--dev`,会强制校验 profile/channel/env,并保证 OTA 作业拿到 `EXPO_PUBLIC_APP_VARIANT=beta` / `EXPO_PUBLIC_BETA_DEV` 与必要的 `EXPO_PUBLIC_*`。Beta OTA 不走 `eas update --environment preview`:Expo 的 `--environment` 只读取 EAS Environment,无法表达每个开发者不同的 `EXPO_PUBLIC_BETA_DEV`,所以脚本从 resolved build profile 注入确定的公开 env。脚本默认 dry-run。

## 正式服

正式服只从 `main` 手动发。`release:prod` 会拒绝:

- 当前分支不是 `main`。
- worktree 不干净。
- `HEAD != origin/main`。
- 无法读取线上最新 build/runtime 基线(除非显式 `--allow-unknown-baseline`,只用于首次发版语义)。
- production 冷构建传入 Android/all platform(Android 正式服仍 pending)。

默认同时覆盖:

- `production` branch/channel:store/TestFlight/正式服。
- `staging` branch/channel:内部 adhoc 包。

```bash
pnpm mobile:release:check -- --target production
pnpm mobile:release:prod -- --message "发布远控修复"
pnpm mobile:release:prod -- --message "发布远控修复" --execute
```

## Android 覆盖

iOS 内部分发走 **NPKG 企业包**:`pnpm mobile:release:ios:npkg -- from-eas` 会取最近一次 finished EAS iOS 构建产物、上传 NPKG、等待企业重签并输出安装链接。细节见 [`npkg-ios-distribution.md`](./npkg-ios-distribution.md)。

Android 发版也计划走 **NPKG 企业包**(不上 Google Play),与 iOS 同一条 NPKG 分发渠道;Beta 脚本和配置已覆盖 Android,正式服 Android 仍 pending:

- `eas.json` beta profiles 带 Android 构建配置。
- `app.json` 暂不声明 `android.versionCode`,避免在 Android 发版未就绪前改变 production fingerprint。等启用时再有意识加回,脚本会在它存在时检查单调递增。
- Beta channel 同样适用于 Android 包。

### 自建 Android 线(本机出包 + 自托管 OTA)

除上面的 EAS 线外,现已有一条**与 iOS 自建线对称的 Android 自建分发线**(本机 mac 出**自签 APK**,不走 EAS/企业重签,JS 改动走自托管 OTA)。设计与契约见 [`self-hosted-android-build-and-ota.md`](./self-hosted-android-build-and-ota.md)。命令(默认 dry-run,`--execute` 才真跑):

```bash
pnpm mobile:release:android:check -- --region cn # 冷/热更只读预判(默认只读 canary 基线)
pnpm mobile:release:android:local -- --region cn --execute # 冷更:prebuild→gradle 签名 APK→直传 OSS→写 canary-release.json
pnpm mobile:release:android:ota   -- --region cn --execute # JS 热更(自托管 OTA,写 canary-latest.json)
pnpm mobile:release:android:promote -- --region cn --yes # 验证后提升 stable 指针
pnpm mobile:release:android:npkg  -- upload <apk>  # 单独上传 APK 取下载链接(APK 不重签)
```

- **签名**:自有 keystore `Cindy.jks`(alias `Cindy`,PKCS12,2026-07-16 起替换旧 `xdmaker-release`;套件在打包机 `/Users/cn-ios/Documents/cindy/CindyMobileCer/Android/`,不入仓)。签名参数**零代码默认值**,路径/alias/口令全部由 `XDT_ANDROID_KEYSTORE_PATH` / `XDT_ANDROID_KEY_ALIAS` / `XDT_ANDROID_KEYSTORE_PASSWORD` / `XDT_ANDROID_KEY_PASSWORD` 环境变量提供(`--execute` 构建时缺任一项报错;`--apk` 复用现成包时豁免);Android 自签即终版,NPKG **只上传取下载链接、不重签**。换 keystore + 换包名 = 全新安装线,旧 `com.xd.lizcn` 自建包无法覆盖安装。
- **versionCode**:committed 在 `apps/mobile/android-version.json`;冷更脚本读线上基线后自动校验单调,≤ 基线时**自动 +1 写回该文件**(`--execute` 才写盘,发布完成后把改动 commit 回 main),也可手动 bump;经 env 只在自建分支注入,EAS 指纹不受影响。self-host fingerprint 通过 `fingerprint.config.cjs` 排除 `ExpoConfigVersions`,因此 CN / Global 共用版本文件时,单独 bump 不会改变 OTA runtime。

外部动作 pending,不要假装已完成:

- iOS 侧 `com.xd.cindycn` 的 NPKG 企业重签白名单仍是外部待办；原生飞书 SSO 与相应包名/签名登记已退役。
- ~~NPKG 的 Android APK 上传路径~~ 已不需要:冷更 APK 自 2026-07-06 起由 `release-android-local.mjs` 直传自有 OSS 取 CDN 直链,不经 NPKG(`release-android-npkg.sh` 仅供手动补传;只构建不上传用 `--skip-upload`)。

## PR 门禁(CI)

`.github/workflows/mobile.yml` 在 PR 触及 `apps/mobile/**`、mobile 依赖的 workspace 包或 lockfile 时自动跑两个 job:

- **checks**(阻断):`typecheck` + `vitest` + scope-guard。
- **fingerprint-guard**(非阻断):同一 runner 上分别计算 base(main)与 PR 合并结果的原生 runtime fingerprint,变化时在 PR 上发 sticky comment,把"合入后下次发版必须冷更"提前到 review 时可见。哈希用仓库内 `@expo/fingerprint` 计算,与 eas-cli 的值**不可比**,发版判定仍以 `pnpm mobile:release:check` 为准(实现与语义见 `apps/mobile/scripts/ci-fingerprint.mjs` 头注)。

## 代码化边界

可由仓库状态、EAS 状态、app/eas 配置、环境变量、git 状态确定的判断,一律进脚本。会调用外部写操作的脚本默认 dry-run,必须显式 `--execute`。人类只保留意图、时机、风险接受、产品分发范围、合规判断。

## 红线

1. production fingerprint 必须与 `origin/main` 基线一致。beta profile 和 release scripts 不能改变 production OTA runtime。
2. `bundleIdentifier` / Android package 与 callback scheme 必须按 region 保持稳定；登录统一走 Cindy auth-server，禁止重新引入原生飞书 SSO 或飞书 appId 构建配置。
3. `app.config.js` 在非 beta 环境必须原样返回 Expo config。
4. 多人禁止共享单个 `beta` channel。
5. 生产发版禁止绕过 release scripts。

## 相关文档

- [`RELEASING.md`](../RELEASING.md) - 发版脚本命令矩阵和人工 checklist。
- [`simulator-debugging.md`](./simulator-debugging.md) - 模拟器调试与验证契约。
- [`npkg-ios-distribution.md`](./npkg-ios-distribution.md) - iOS NPKG 内部分发手册和脚本说明。
