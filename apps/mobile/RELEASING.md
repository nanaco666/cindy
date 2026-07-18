# 手机版发版指南(apps/mobile)

> 发版流程走脚本,不要手拼 `eas build` / `eas update`。`mobile:release:check` / `mobile:release:beta` / `mobile:release:prod` 使用 pinned `eas-cli@20.4.0`,会自检 EAS 登录态;其中会写 EAS 的 beta/prod 脚本默认 dry-run,只有显式 `--execute` 才会触发 EAS 写操作。
> `mobile:release:ios:npkg` 是 NPKG 上传/解析运维脚本,会按子命令直接访问 NPKG,运行前先确认目标包和分发范围。

## 心智模型

- `runtimeVersion` 使用 `@expo/fingerprint`。本地 fingerprint 与已安装包 runtime 一致时才可 OTA;不一致必须冷更重出包。
- `channel` 写进构建产物。正式服走 `production`;内部 adhoc 走 `staging`;手机 Beta 走 `beta-<dev>`。
- `branch` 是 OTA 发布目标。脚本默认让 branch 与 channel 同名。
- iOS `buildNumber` 在冷更时必须单调递增,脚本会检查;自建线冷更脚本(`mobile:release:ios:local` / `mobile:release:android:local`)检测到版本号 ≤ 线上基线时会自动自增写回版本文件(`--execute` 才写盘,发布后把 bump commit 回 main)。Android 正式发版仍 pending;等 `android.versionCode` 被有意识加入后,脚本才检查它单调。

完整开发/自测/发版模型见 [`docs/dev-and-release-workflow.md`](./docs/dev-and-release-workflow.md)。

## 命令矩阵

```bash
# 只读检查:输出当前 fingerprint、线上基线、可热更/必须冷更结论
pnpm mobile:release:check -- --target production
pnpm mobile:release:check -- --target staging
pnpm mobile:release:check -- --target beta --dev dash

# 手机 Beta:per-dev profile/channel/branch,必须显式 --dev,默认 dry-run
pnpm mobile:release:beta -- --dev dash --message "验证远控输入"
pnpm mobile:release:beta -- --dev dash --message "验证远控输入" --execute

# 正式服:必须 main + clean + HEAD==origin/main,默认覆盖 production + staging,默认 dry-run
pnpm mobile:release:prod -- --message "发布远控修复"
pnpm mobile:release:prod -- --message "发布远控修复" --execute

# iOS NPKG 运维脚本:上传 EAS iOS 产物等企业重签 / 补取链接 / 下载重签 ipa
# (自建线冷更发版走 mobile:release:ios:local,它内部调 upload + download 后把 ipa 直传自有 OSS)
pnpm mobile:release:ios:npkg -- from-eas
pnpm mobile:release:ios:npkg -- upload /path/to/xdmaker.ipa --tag release
pnpm mobile:release:ios:npkg -- resolve <parent_package_id>
pnpm mobile:release:ios:npkg -- download <package_id> /path/to/save.ipa

# 新增开发者 beta profile + 同名 EAS channel/branch 关联,默认 dry-run
pnpm mobile:beta:add-dev -- alice
pnpm mobile:beta:add-dev -- alice --execute
```

## 自建线地区分包(region,cn / global)

自建线四个脚本 `mobile:release:{ios,android}:{local,ota,check}` **必须显式带 `--region cn|global`**(无默认值,缺失即报错):

```bash
pnpm mobile:release:ios:local     -- --region global --execute
pnpm mobile:release:android:local -- --region cn     --execute
pnpm mobile:release:ios:ota       -- --region global --execute
pnpm mobile:release:android:check -- --region cn
```

- 所有**随地区变的非机密分包参数**(iOS bundleId / Android package / NPKG 期望包名 / TapDB 公开 clientId·clientToken / OSS 落点 bucket·CDN·prefix·ossRegion / 非机密签名描述符)集中在打包机本地的 `apps/mobile/scripts/self-host-regions.json`(纯值、已 gitignore;复制 `self-host-regions.json.example` 填值)。cn=`com.xd.cindycn`、global=`com.xd.cindy`。
- **真机密仍走 env,按 region 后缀**:Android keystore 两个口令 `XDT_ANDROID_KEYSTORE_PASSWORD_{CN,GLOBAL}` / `XDT_ANDROID_KEY_PASSWORD_{CN,GLOBAL}`(cn 兼容无后缀旧名);OSS AK/SK 同账号继续用 `FP_DEV_OSS_ACCESS_KEY_ID/SECRET`,不同账号用 `XDT_OSS_ACCESS_KEY_ID_{CN,GLOBAL}` / `XDT_OSS_ACCESS_KEY_SECRET_{CN,GLOBAL}`。
- OTA 更新域名**不进** region JSON:运行期由对应地区 `endpoint.json` 的 `mobileUpdateBaseUrl` 下发,不烘焙进包。
- cn / global 是两个独立 OSS bucket,`release.json` 等落点互不覆盖。global 上架/重签需另在 NPKG 登记 `com.xd.cindy`(外部 pending)。

## 脚本契约

- `mobile:release:check` 只读:计算当前 fingerprint,读取 EAS 最新 finished build runtime,输出 `OTA_OK` / `COLD_BUILD_REQUIRED` / `BASELINE_UNKNOWN`。
- `mobile:release:beta` 固定 `beta-<dev>` profile/channel/branch,从 resolved build profile 注入 OTA 需要的 `EXPO_PUBLIC_*` / `EXPO_PUBLIC_APP_VARIANT=beta` / `EXPO_PUBLIC_BETA_DEV`。
- `mobile:release:prod` 拦截非 `main`、脏 worktree、`HEAD != origin/main`;默认同时处理 `production` 和 `staging`;冷更前校验 iOS `buildNumber` 单调,并在 Android `versionCode` 存在时校验它单调;无法读取线上 build/runtime 基线时默认硬失败。
- EAS/TestFlight 的 TapTap/TapDB 客户端公开配置不写进 `eas.json`;在 EAS project environment 的 `production` / `preview` 配好 `EXPO_PUBLIC_TAPTAP_CLIENT_ID` 与 `EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN`。需要覆盖默认渠道或区域时,可同处配置 `EXPO_PUBLIC_TAPDB_CHANNEL` / `EXPO_PUBLIC_TAPDB_REGION`。自建线不依赖这些 env,只读所选 region 的 `self-host-regions.json.tapdb`;发版脚本会主动清掉打包机残留的同名 TapDB env。
- Google 原生登录(global 线)的客户端标识同样不写进 `eas.json`;在 EAS project environment 的 `production` / `preview` 配好 `EXPO_PUBLIC_CINDY_GOOGLE_WEB_CLIENT_ID`、`EXPO_PUBLIC_CINDY_GOOGLE_IOS_CLIENT_ID`、`EXPO_PUBLIC_CINDY_GOOGLE_IOS_URL_SCHEME`(三个值来自 GCP 项目 `cindy-ddd51` 的 Google Cloud Console Web / iOS OAuth client;URL scheme 即 iOS client id 反写 `com.googleusercontent.apps.<id>`,EAS prebuild 时由 `@react-native-google-signin` config plugin 注入 Info.plist;Android 无需独立变量,但 GCP 项目里必须建 Android OAuth client 并登记发布签名 SHA)。⚠️ 这三个变量缺失**不会**让发版失败——客户端 `isNativeSocialProviderSupported` 会静默隐藏 Google 登录按钮(Android 只看 WEB_CLIENT_ID,iOS 三个都要),发 global 线前先确认 EAS environment 已配齐;服务端侧还需 auth-server 把 iOS client id 配进 `GOOGLE_IOS_CLIENT_ID`(原生 idToken 的合法 aud,见 `cindy-server` 仓 `docs/auth-server/`)。
- `mobile:release:ios:npkg` 走 [`docs/npkg-ios-distribution.md`](./docs/npkg-ios-distribution.md):取 EAS iOS `.ipa` 或上传本地 `.ipa`,等待 NPKG 企业重签并输出安装链接;`download` 子命令可把重签子包 `.ipa` 拉回本地。
- **冷更安装包分发走自有 OSS,不再让用户从 NPKG 下载**:`mobile:release:ios:local` 在 NPKG 重签完成后把重签 `.ipa` 下载回来,连同自生成的 `manifest.plist`(itms 安装清单)与 `install.html`(安装页)直传 OSS 的 `mobile-dist/ios/<buildNumber>/`;`release.json` 的 `itmsUrl` / `installUrl` 均指向 OSS/CDN。`mobile:release:android:local` 则完全不经 NPKG,自签 APK 直传 OSS 的 `mobile-dist/android/<versionCode>/`。发布目标只认 `XDT_CDN_BASE_URL` / `XDT_OSS_BUCKET` / `XDT_OSS_PREFIX` / `XDT_OSS_REGION`（自建线由所选 region 配置注入），凭证使用 `FP_DEV_OSS_ACCESS_KEY_ID` / `FP_DEV_OSS_ACCESS_KEY_SECRET`；不再读取 `production-endpoints.json`。
- `--allow-unknown-baseline` 只用于明确的首次发版语义;production Android/all 冷构建在 Android 正式服启用前会被拒绝。
- 会写 EAS 的 beta/prod 脚本默认只打印计划;必须传 `--execute` 才执行。
- 真正的 `eas build` / `eas update` / `eas submit` 不应绕过这些入口。

## 必须人定

- 是否发版、何时发版、发给谁。
- 明知可 OTA 时是否仍要冷更。
- 是否改动 region 对应的 `scheme` / bundle identity / OAuth callback；登录统一走 Cindy auth-server，原生飞书 SSO 与飞书 appId 构建配置已退役。
- App Store / TestFlight 审核材料、隐私权限自查、外部签名分发。
- iOS NPKG 内部分发的目标范围和安装链接发送对象。
- Android 内部分发(不上 Google Play):自建线本机出**自签 APK**(keystore `Cindy.jks` / alias `Cindy`,路径/alias/口令全部走 `XDT_ANDROID_*` 环境变量、无代码默认值,不走 iOS 企业重签),**直传自有 OSS 取 CDN 下载直链**(不经 NPKG;`release-android-npkg.sh` 仅供手动补传);命令 `pnpm mobile:release:android:{check,local,ota,npkg}`,设计见 [`docs/self-hosted-android-build-and-ota.md`](./docs/self-hosted-android-build-and-ota.md)。
