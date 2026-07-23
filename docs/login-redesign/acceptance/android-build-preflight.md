# Android 构建 preflight 证据(PR4-preflight / implementation-plan Step 5-pre)

> 执行时间:2026-07-20;执行环境:macOS(darwin arm64),worktree `feat/login-skin-pr4-preflight`(base = `origin/feat/login-skin-integration`,含 PR0a/PR0b 三支)。
> 结论:**两条路径(初装构建、Metro 热开发)均已打通**,cn/global 双 region + `cindy-phone`/`cindy-tablet` 双 AVD 全部启动到登录页;存在 1 个必须 workaround 的构建阻塞(Gradle 模板漂移,见发现②)与 2 个 GAP(文末),PR4a 可开工。

## 0. 环境基线(实测)

| 项 | 值 |
|---|---|
| ANDROID_HOME | `~/Library/Android/sdk`(cmdline-tools / emulator / platform-tools / platforms / system-images 齐) |
| JDK | **系统 PATH 无 java**;使用 Android Studio 内嵌 JBR:`JAVA_HOME=/Applications/Android Studio.app/Contents/jbr/Contents/Home`(OpenJDK 21.0.10) |
| AVD | `cindy-phone`(1080×2400)、`cindy-tablet`(2560×1600),均 Android 15;`emulator -list-avds` 确认 |
| Node / pnpm | Node v24.13.0 · pnpm 10.x(仓规基线) |
| 构建期自动补装 | gradle 8.14.3 发行包、NDK 27.0.12077973 + 27.1.12297006、Build-Tools 35.0.0、CMake 3.22.1(gradle 首跑自动下载,licenses 自动接受) |

## 1. 关键发现

### 发现①:JDK 不在 shell PATH
`/usr/libexec/java_home` 无结果;裸跑 gradle 必失败。**全部构建命令须带** `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"` 并把 `$JAVA_HOME/bin` 前置 PATH(会话级 env,零仓内改动)。

### 发现②(核心阻塞 + workaround):expo prebuild 模板 Gradle 9 与项目 RN 0.85.3 不兼容
- 裸跑 `pnpm --filter mobile android`(expo run:android)时 prebuild 拉取的 `expo-template-bare-minimum`(实测 56.0.12 / 56.0.30 / sdk-56 tag 均同)生成 **Gradle 9.3.1** wrapper;
- 项目 pin `react-native@0.85.3`(SDK 56 推荐 0.86,expo CLI 有版本提示),0.85 的 React Native Gradle Plugin 引用了 Gradle 9 已移除的 `JvmVendorSpec.IBM_SEMERU` → `BUILD FAILED: Class org.gradle.jvm.toolchain.JvmVendorSpec does not have member field 'IBM_SEMERU'`;
- **workaround(本次采用,仓内零改动)**:prebuild 后把生成目录(gitignored)`apps/mobile/android/gradle/wrapper/gradle-wrapper.properties` 的 distributionUrl 降为 `gradle-8.14.3-bin.zip`(RN 0.85 官方配套线)再构建 → 稳定通过;
- **正式修复需 owner 拍板(PR4a 前非必需,workaround 足够开发期使用)**:(a) 升 RN 0.86 对齐 SDK 56 推荐(影响面大,独立事项);或 (b) 仓内固化 android dev 构建包装脚本(pin 模板 + wrapper 版本,需扩写入 allowlist)。本 preflight 按「只读诊断为默认」不动仓内配置,仅在此记录。

### 发现③:普通 dev 构建不需要 `self-host-regions.json`
`app.config.js` 仅在 `EXPO_PUBLIC_XDT_OTA_SELFHOST=1` 或 `CINDY_USE_LOCAL_REGION_CONFIG=1` 时读取该 gitignored 文件;普通 `expo run:android` 走内置 `REGION_CONFIG`(cn: `com.xd.cindycn`/scheme `cindycn`;global: `com.xd.cindy`/scheme `cindy`)。但 `pnpm mobile:sim:*` 系列脚本无条件要求该文件(见 GAP-2)。

### 发现④:本地 native modules 的 gradle 产物未被 gitignore
构建后 `apps/mobile/modules/xdt-tapdb/android/build/` 与 `apps/mobile/modules/xdt-wechat-login/android/build/` 以 untracked 状态出现(`.gitignore` 只忽略 `apps/mobile/android/` 根生成目录)。本 PR 不提交这些产物、也不动 `.gitignore`(超出 Step 5-pre 允许写入范围);建议随 PR4a 或独立 chore 给 `apps/mobile/modules/*/android/build/` 补 ignore 规则,避免 Android 开发期误提交。

## 2. 成功命令序列(可复现)

### 2.1 cn region 初装(WHAT①)

```bash
# 0) 环境(每个构建 shell 都要)
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

# 1) 无头启动 phone AVD(不打扰桌面)
"$ANDROID_HOME/emulator/emulator" -avd cindy-phone -no-window -no-audio -no-boot-anim -no-snapshot-save &
"$ANDROID_HOME/platform-tools/adb" wait-for-device   # 等 device 态;完整就绪轮询 getprop sys.boot_completed=1(实测 ~5s,快照热)

# 2) pinned 模板 prebuild + wrapper 降级(发现② workaround)
cd apps/mobile
pnpm exec expo prebuild --platform android --template expo-template-bare-minimum@56.0.12 --no-install
sed -i '' 's|gradle-9.3.1-bin.zip|gradle-8.14.3-bin.zip|' android/gradle/wrapper/gradle-wrapper.properties

# 3) 构建安装启动(仓库根)
pnpm --filter mobile android
```

- 结果:`BUILD SUCCESSFUL in 23m 20s`(**冷构建**,含 gradle 发行包/NDK×2/Build-Tools/CMake 下载与全量 CMake 原生编译;二次构建见 2.3 的 43s)→ APK 安装 → app 自动启动;
- 包名:`com.xd.cindycn`;scheme:`cindycn`;前台证据:`mCurrentFocus=…com.xd.cindycn/com.xd.cindycn.MainActivity`;
- Metro 连接证据:`Android Bundled 18475ms apps/mobile/index.js (4036 modules)`;
- 登录页截图:`evidence/android-preflight/cn-phone-login.png`(CINDY / Sign in to Cindy / 手机号 identifier / Continue / 企业 SSO;模拟器系统语言 en → 英文文案,符合 loginMessages locale 兜底)。

### 2.2 热开发 Metro 复用(WHAT②)

```bash
# 初装后日常热开发:只起 Metro,无需重编原生
pnpm --filter mobile start          # expo start,监听 8081
adb shell am force-stop com.xd.cindycn && adb shell am start -n com.xd.cindycn/.MainActivity
```

- 证据:app 重启后重连新 Metro,`Android Bundled 1301ms (3931 modules)`(缓存热,对比冷 18.5s);截图 `evidence/android-preflight/cn-phone-metro-reload.png`;
- ⚠️ 计划点名的 `pnpm mobile:sim:start` 在本机被 `self-host-regions.json` 硬闸挡住(GAP-2),本节用裸 `expo start` 实证了「初装后 Metro 即可热开发」的事实;sim:start 的增量(`__DEV__` build label 指纹注入、8081 归属保护)待 GAP-2 解除后可用;
- Android 模拟器需 `adb reverse tcp:8081 tcp:8081` 才能访问宿主 Metro(expo run:android 会为当时在线设备自动设置;后续新起的设备要手动补)。

### 2.3 global region(WHAT③)

```bash
export EXPO_PUBLIC_CINDY_AUTH_REGION=global   # 叠加 2.1 的 0) 环境
cd apps/mobile && rm -rf android
pnpm exec expo prebuild --platform android --template expo-template-bare-minimum@56.0.12 --no-install
sed -i '' 's|gradle-9.3.1-bin.zip|gradle-8.14.3-bin.zip|' android/gradle/wrapper/gradle-wrapper.properties
pnpm --filter mobile android          # 仓库根,同 env
```

- 结果:`BUILD SUCCESSFUL in 43s`(gradle/NDK 缓存热)→ `com.xd.cindy` 安装启动;
- 包名:`com.xd.cindy`;scheme:`cindy`;前台证据:`mCurrentFocus=…com.xd.cindy/com.xd.cindy.MainActivity`;`pm list packages` 双包并存(`com.xd.cindycn` + `com.xd.cindy`);
- Metro 证据:`Android Bundled 1343ms (4036 modules)`;
- 登录页截图:`evidence/android-preflight/global-phone-login.png`——identifier 为 **Email address**(cn 为手机号),region providers attribution 差异正确呈现;
- 注意:cn/global 共用 `apps/mobile/android/` 生成目录,切 region 必须 `rm -rf android` 重新 prebuild(applicationId 写死在生成的 build.gradle 里)。

### 2.4 cindy-tablet boot 冒烟(WHAT④)

```bash
"$ANDROID_HOME/emulator/emulator" -avd cindy-tablet -no-window -no-audio -no-boot-anim -no-snapshot-save -port 5556 &
# sys.boot_completed=1 实测 ~30s(Android 15)
adb -s emulator-5556 install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5556 reverse tcp:8081 tcp:8081
adb -s emulator-5556 shell am start -n com.xd.cindy/.MainActivity
```

- boot 冒烟 PASS(30s 内 boot 完成);加测:global APK 安装启动到登录页,横屏 2560×1600 布局正常渲染;截图 `evidence/android-preflight/global-tablet-boot-smoke.png`。

## 3. 证据清单

| 文件 | 内容 |
|---|---|
| `evidence/android-preflight/cn-phone-login.png` | cn `com.xd.cindycn` phone 登录页(手机号 identifier) |
| `evidence/android-preflight/cn-phone-metro-reload.png` | 热开发 Metro 重连后登录页 |
| `evidence/android-preflight/global-phone-login.png` | global `com.xd.cindy` phone 登录页(Email identifier) |
| `evidence/android-preflight/global-tablet-boot-smoke.png` | tablet 横屏 global 登录页 |

构建全量日志在执行机 `/tmp/pr4pre-cn-build.log`、`/tmp/pr4pre-global-build.log`(临时文件,关键行已摘录入本文档;不入仓)。

## 4. GAP(交 lead 裁决,均不阻塞 PR4a 开工)

- **GAP-1(发现②正式修复)**:Gradle 模板漂移的根治需二选一——升 RN 0.86 或仓内固化 prebuild 包装(pin 模板 + wrapper);当前 workaround(生成目录内降 wrapper)已可复现支撑 PR4a/4b 开发,但每次 `rm -rf android` 重建都要重做 sed 一步。
- **GAP-2(`mobile:sim:start` 硬闸)**:`pnpm mobile:sim:*` 无条件要求 gitignored `apps/mobile/scripts/self-host-regions.json`(cn/global 的 TapDB clientId/clientToken 与 global Google OAuth client id 严格非空校验),本机全部 worktree 均无副本,值为真实产品凭证不可捏造。需用户从已配置机器复制或按 `self-host-regions.json.example` 填真值;解除后 PR4a 期可获得 build label 指纹注入与 8081 归属保护。
