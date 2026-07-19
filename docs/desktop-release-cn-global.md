# Desktop 发布:国内(cn)/ 海外(global)双渠道

> 2026-07-19 整理。发布脚本区域化(`--region cn|global`)后的指令矩阵与差异化配置单点说明。
> 相关脚本:`apps/desktop/scripts/release-{macos,windows}.mjs`、`promote-canary-{macos,windows}.mjs`、
> 共享配置 `scripts/shared/oss.mjs`(发布目标)与 `scripts/shared/client-endpoint-build-env.mjs`(烘焙端点)。

## 1. 指令矩阵

所有指令在仓库根目录执行(也可 `pnpm --filter desktop <同名指令>`)。

### 打包 + 发布到 canary 通道

release 脚本一条龙完成:electron-forge make → 签名(mac 含公证)→ 安装包 + 热更 zip →
上传 OSS → 更新 `manifest-<platform>-canary.json`。**默认只动 canary,不碰 stable。**

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
| 发布产物文件名基名(安装包/热更 zip,下载可见) | `cindy-*` | `cindy-global-*` | `ci/lib.mjs` `RELEASE_ARTIFACT_BASENAME_BY_REGION`(老 `xdt-maker-*` 只属于已冻结渠道) |
| agent 二进制下载 fallback(ensureBinary) | cn 清单基址 | global 清单基址 | 读 `CINDY_AUTH_REGION`(release 脚本已自动注入) |

**两条渠道相同、与区域无关的配置**(同一份 `.env`):

- macOS 签名/公证:`APPLE_APP_PASSWORD`(必填)、`APPLE_ID` / `APPLE_TEAM_ID` /
  `APPLE_SIGN_IDENTITY`(有默认值)—— 同一个 Apple Developer 账号签两个 bundle id。
- Windows 签名:`NPKG_TOKEN`(不设则跳过签名;npkg 服务在内网)。
- 渠道冻结硬闸:任一区域都禁止把 OSS prefix 指到已冻结的老 `/xdt-maker` 渠道
  (`assertNotPublishingCindyToLegacyChannel`)。

### 发版机配置清单

发布目标(非机密)与凭证(机密)分两处,对齐 mobile 自建线的 self-host-regions 模式:

**1)`apps/desktop/scripts/release-regions.json`** —— 双渠道发布目标,纯值,已 gitignore;
复制同目录 `release-regions.json.example` 填值。只发单渠道的机器可以只填对应渠道,
另一渠道留空(用到时才 fail closed 报缺)。

```json
{
    "cn":     { "oss": { "cdnBaseUrl": "…", "bucket": "…", "prefix": "…", "ossRegion": "…" } },
    "global": { "oss": { "cdnBaseUrl": "…", "bucket": "…", "prefix": "…", "ossRegion": "…" } }
}
```

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
