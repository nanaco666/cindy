# Desktop 发布:国内(cn)/ 海外(global)/ dev 三渠道

> 2026-07-19 整理,2026-07-20 增补 dev 第三目标。发布脚本区域化(`--region cn|global|dev`)
> 后的指令矩阵与差异化配置单点说明。
> 相关脚本:`apps/desktop/scripts/release-{macos,windows}.mjs`、`promote-canary-{macos,windows}.mjs`、
> 共享配置 `scripts/shared/oss.mjs`(发布目标)与 `scripts/shared/client-endpoint-build-env.mjs`(烘焙端点)。

## 1. 指令矩阵

所有指令在仓库根目录执行(也可 `pnpm --filter desktop <同名指令>`)。

### 三步拆分管线(2026-07 打包/发布拆分,推荐)

打包与发布是两个独立脚本,靠 `build-info.json` 衔接;canary 验证后 promote 到 stable:

| 步骤 | 命令 | 干什么 |
|---|---|---|
| ① 打包 | `pnpm release:package -- --region cn --version 0.1.0` | `package-desktop.mjs`:forge make + 签名(mac 含公证)+ smoke,产出本地产物 + `build-info.json`,**不碰 OSS/CDN** |
| ② 发布灰度 | `pnpm release:canary -- --region cn --version 0.1.0 --execute` | `publish-desktop.mjs`:校验 build-info(完整性 / 签名 / 版本单调性)→ 上传安装包 / 热更包 / agent 二进制 → 写 canary manifest;**缺省 dry-run,`--execute` 才上传** |
| ③ 正式发布 | `pnpm release:promote:win:cn --yes`(按平台/区域) | canary manifest 覆盖为 stable(覆盖前自动备份) |

- ① 的版本必须显式 `x.y.z`(发布链路禁用版本无关包);② 只认与 ① 相同的显式版本。
- ② 默认发布产物目录里该平台的全部 arch(mac 双架构一次发完),`--arch` 可限定;
  发布必须在**目标平台的发版机**上执行(agent 二进制版本探测要运行目标平台的
  claude/codex,跨平台代传会被硬闸拒绝)。
- ② 的安全门禁全部 fail closed:未签名拒发、build-info 与 region/版本不符拒发、
  版本回退拒发(`--force` 放行)、远端同名对象内容不同拒覆盖(防 CDN 边缘缓存字节分裂)、
  manifest 出闸前断言 claudeCode / codex 段完整(防全新渠道发出无法自举的 manifest)。

### 打包 + 发布到 canary 通道(一体式,legacy)

release 脚本一条龙完成:electron-forge make → 签名(mac 含公证)→ 安装包 + 热更 zip →
上传 OSS → 更新 `manifest-<platform>-canary.json`。**默认只动 canary,不碰 stable。**
三步管线验证稳定后本节脚本(`release-{macos,windows}.mjs`)将退役。

| 平台 | 国内 cn | 海外 global |
|---|---|---|
| macOS(arm64+x64) | `pnpm release:mac:cn` | `pnpm release:mac:global` |
| Windows(x64,需在 Windows 机器上跑) | `pnpm release:win:cn` | `pnpm release:win:global` |

- `release:mac` / `release:win`(不带区域后缀)= cn,行为不变。
- 版本号参数:`pnpm release:mac:cn minor`(major / minor / patch / 显式 `x.y.z`,默认 patch)。
  版本基线来自该渠道 CDN 上的 canary manifest(canary 缺失回退 stable)。
- mac 单架构:`pnpm release:mac:arm64`(cn);global 单架构加透传参数
  `pnpm release:mac:global --arch arm64`。
- **渠道首发**(该渠道 CDN 上还没有任何 manifest,典型是 global 首发):bump 关键字无基线可算,
  必须显式传版本号,例如 `pnpm release:mac:global 1.0.0`。脚本会从空 manifest 骨架起步。
- 只打包命令只用 `--region cn|global|dev` 选择目标，不再提供 package-level
  `--channel`；产物按 `release/artifacts/<region>/<version|unversioned>/...` 归档。
  canary / stable 仅由 release / promote 阶段管理。

### 单独发布 Windows agent 二进制

只更新 Claude Code / Codex、不重新打包客户端时，同样按 region 读取
`apps/desktop/scripts/release-regions.json`，并更新该渠道的
`manifest-win32-x64-canary.json`：

| 二进制 | 国内 cn | 海外 global | dev |
|---|---|---|---|
| Claude Code | `pnpm release:claude-code:win:cn` | `pnpm release:claude-code:win:global` | `pnpm release:claude-code:win:dev` |
| Codex | `pnpm release:codex:win:cn` | `pnpm release:codex:win:global` | `pnpm release:codex:win:dev` |

- 兼容入口 `release:claude-code:win` / `release:codex:win` 仍默认 cn。
- 底层脚本也支持 `--region cn|global|dev`，可与 `--platform`、`--version`、
  `--dry-run`、`--force` 组合。
- 二进制先上传到 `<prefix>/claude-code/...` 或 `<prefix>/codex/...`，再更新同一
  region 的 canary manifest；提升 stable 仍使用对应的 `release:promote:win:<region>`。

### 提升到 release(canary → stable)

promote 脚本只搬 manifest:把 `manifest-<platform>-canary.json` 的内容覆盖到
`manifest-<platform>.json`(stable)。安装包 / 热更 zip / agent 二进制在 release 阶段已上传,
canary 与 stable 共享同一批底层文件。覆盖前自动把当前 stable 备份到 `back-up/<version>/`。

| 平台 | 国内 cn | 海外 global |
|---|---|---|
| macOS | `pnpm release:promote:mac:cn --yes` | `pnpm release:promote:mac:global --yes` |
| Windows | `pnpm release:promote:win:cn --yes` | `pnpm release:promote:win:global --yes` |

- 不带 `--yes` = dry-run,只打印将要提升的版本,不动线上。
- mac 单架构:`--arch arm64` / `--arch x64` 可叠加。

## 2. 国内 / 海外打包的差异化配置

区域只由一个开关决定:release 脚本的 `--region`(内部落到 `CINDY_AUTH_REGION` 环境变量,
构建期烘焙进包)。两条渠道各自差异:

| 维度 | 国内 cn | 海外 global | 单点位置 |
|---|---|---|---|
| 应用身份(exe / .app / 安装目录 / 同机双装) | `Cindy` | `CindyGlobal` | `src/shared/brandIdentity.ts`(lib.mjs 镜像 `PACKAGED_APP_NAME_BY_REGION`) |
| appId / AUMID | `com.xd.cindycn` | `com.xd.cindy` | `forge.config.ts` ← `brandAppId(region)` |
| 运行期端点清单(构建期烘焙自举基址) | `config/endpoint.json` | `config/endpoint.global.json` | `scripts/shared/client-endpoint-build-env.mjs` |
| 热更 CDN(客户端视角) | `https://hotfix.cindy.com.cn/cindy` | `https://hotfix.cindy.app/cindy` | 各 endpoint*.json 的 `cdnBaseUrl` |
| 发布 CDN 基址 + OSS 目标(bucket / prefix / region) | `release-regions.json` 的 `cn.oss.*` | `release-regions.json` 的 `global.oss.*` | `apps/desktop/scripts/ci/release-regions.mjs`(env `XDT_*` / `XDT_GLOBAL_*` 可覆盖) |
| 阿里云 AK/SK | `FP_DEV_OSS_ACCESS_KEY_ID/SECRET` | 同左;跨账号时改配 `XDT_GLOBAL_OSS_ACCESS_KEY_ID/SECRET` | `scripts/shared/oss.mjs` `resolveOssCredentials` |
| mac 签名证书(Developer ID) | X.D. Network Inc.(`NTC4BJ542G`) | XD Entertainment Pte Ltd(`SX9RG894L5`) | `release-regions.json` 的 `<region>.macSigning`(证书私钥在钥匙串,按 signIdentity 名字取;身份**无代码默认值**,JSON 与 env 都缺时签名前报错) |
| 发布产物文件名基名(安装包/热更 zip,下载可见) | `cindy-*` | `cindy-global-*` | `ci/lib.mjs` `RELEASE_ARTIFACT_BASENAME_BY_REGION`(老 `xdt-maker-*` 只属于已冻结渠道) |
| agent 二进制下载 fallback(ensureBinary) | cn 清单基址 | global 清单基址 | 读 `CINDY_AUTH_REGION`(release 脚本已自动注入) |

**两条渠道相同、与区域无关的配置**(同一份 `.env`):

- macOS 公证账号:`APPLE_APP_PASSWORD`(必填,env,zhouyi@xd.com 名下的 App 专用密码)
  + `macSigning.appleId = zhouyi@xd.com`(该账号对两个 team 均有公证权限,已实测;
  换公证账号时两处必须成对更新——App 专用密码与 Apple ID 一一绑定)。签名**证书**按区域走 `macSigning`(见上表)。
- Windows 签名:`NPKG_TOKEN` **必填硬闸**(npkg 内网签名服务)——缺 token 构建前终止,签名后对安装器与热更包主 exe 做 Authenticode 验签,非 Valid 一律中止;未签名 exe 禁止出渠道(调试用 `package-desktop.mjs --allow-unsigned`)。
- 渠道冻结硬闸:任一区域都禁止把 OSS prefix 指到已冻结的老 `/xdt-maker` 渠道
  (`assertNotPublishingCindyToLegacyChannel`)。

### 发版机配置清单

发布目标(非机密)与凭证(机密)分两处,对齐 mobile 自建线的 self-host-regions 模式:

**1)`apps/desktop/scripts/release-regions.json`** —— 双渠道发布目标,纯值,已 gitignore;
复制同目录 `release-regions.json.example` 填值。只发单渠道的机器可以只填对应渠道,
另一渠道留空(用到时才 fail closed 报缺)。

```json
{
    "cn": {
        "oss":        { "cdnBaseUrl": "…", "bucket": "…", "prefix": "…", "ossRegion": "…" },
        "macSigning": { "appleId": "zhouyi@xd.com", "teamId": "NTC4BJ542G", "signIdentity": "Developer ID Application: X.D. Network Inc. (NTC4BJ542G)" }
    },
    "global": {
        "oss":        { "cdnBaseUrl": "…", "bucket": "…", "prefix": "…", "ossRegion": "…" },
        "macSigning": { "appleId": "zhouyi@xd.com", "teamId": "SX9RG894L5", "signIdentity": "Developer ID Application: XD Entertainment Pte Ltd (SX9RG894L5)" }
    }
}
```

`macSigning` 三字段(appleId / teamId / signIdentity)是签名与公证身份的唯一配置点;
可选第四字段 `appPasswordEnv` 指定该区域公证密码改从哪个 env 变量读(留空 = 读
`APPLE_APP_PASSWORD`)——两区域改用不同公证账号时,各自指向如 `APPLE_APP_PASSWORD_CN` /
`APPLE_APP_PASSWORD_GLOBAL`,密码值本身仍只在 env、不进 JSON;声明了指针但目标变量为空会直接报错
(`resolveAppleIdentity` **无代码默认值**,JSON 与同名 env 都缺时直接报错);对应的
Developer ID 证书(含私钥)必须已导入发版机钥匙串。`package-desktop.mjs` 带版本签名
打包同样读这里(只取 macSigning,不要求 oss)。

优先级:env(`XDT_*` / `XDT_GLOBAL_*`,CI secret 场景)> JSON > 报错。JSON 只补 env
缺失的键;env 四件套齐全时不要求 JSON 文件存在。加载单点:
`apps/desktop/scripts/ci/release-regions.mjs`(回归测试 `scripts/__tests__/release-regions.test.mjs`)。

**2)`apps/desktop/.env`(gitignored)/ shell env** —— 真机密,永远不进 JSON:

```ini
FP_DEV_OSS_ACCESS_KEY_ID=...
FP_DEV_OSS_ACCESS_KEY_SECRET=...
APPLE_APP_PASSWORD=...        # mac 发布(公证)
NPKG_TOKEN=...                # win 签名(可选)
# XDT_GLOBAL_OSS_ACCESS_KEY_ID=...      # 仅当海外 bucket 在另一个阿里云账号
# XDT_GLOBAL_OSS_ACCESS_KEY_SECRET=...
```

## 3. 典型发版流程

```bash
# 1) 国内 canary(mac 双架构 + win)
pnpm release:mac:cn            # 在 mac 发版机
pnpm release:win:cn            # 在 win 发版机

# 2) 海外 canary
pnpm release:mac:global
pnpm release:win:global

# 3) canary 自测通过后,提升 stable(先 dry-run 看一眼)
pnpm release:promote:mac:cn
pnpm release:promote:mac:cn --yes
pnpm release:promote:win:cn --yes
pnpm release:promote:mac:global --yes
pnpm release:promote:win:global --yes
```

注意:cn 与 global 的版本号各自独立演进(各看各的 CDN manifest 基线),不要求同步;
需要对齐时给两边都传同一个显式 `x.y.z`。

## 4. dev 第三目标(2026-07-20,配置接口已留好、服务端待部署)

dev 是与 cn/global 平级的独立目标:独立系统身份 **CindyDev / com.xd.cindydev /
独立 userData**(可与 cn、global 同机三装),连接独立的 dev 服务器。行为语义归
cn 系(登录线、意识 app-context 等运行时分支与 cn 同待遇,意识契约不变)。

当前状态与启用步骤:

1. **端点清单** `config/endpoint.dev.json` 已建,占位域名约定为 `dev-<子域>.cindy.com.cn`
   (如 `dev-auth.cindy.com.cn`);dev 服务器部署时要么按这套域名起,要么改清单。
2. **打包**:`pnpm package:mac:arm64 --region dev [--version x.y.z]` 已可用(产出
   CindyDev,签名默认复用 cn 的 X.D. Network 证书,见 release-regions.json `dev.macSigning`)。
3. **发布**:`release:{mac,win}:dev` / `release:promote:{mac,win}:dev` 指令已就位,
   但 `release-regions.json` 的 `dev.oss` 四件套留空 —— dev 渠道 bucket/CDN 建好后
   填入即可(env 面为 `XDT_DEVCH_*` 前缀;凭证可单独配 `XDT_DEVCH_OSS_ACCESS_KEY_*`,
   不配回落 `FP_DEV_OSS_ACCESS_KEY_*`)。在此之前发 dev 渠道会 fail closed 报缺配置。
4. **dev 模式运行**(不打包):`pnpm restart:desktop:remote --region=dev` 即读
   `endpoint.dev.json`(dev 服务器可达后可用)。
5. **mobile 自建线已同步 dev**:`self-host-regions.json` 加 dev 块(全留空,装载不炸、
   真发 dev 时按缺失字段报错;身份建议 `com.xd.cindydev`,与桌面同套命名);
   `--region dev`、`EXPO_PUBLIC_CINDY_AUTH_REGION=dev`(scheme `cindydev`、端点读
   `endpoint.dev.json`)全链就位。EAS/TestFlight 线不引入 dev(自建线专属)。
