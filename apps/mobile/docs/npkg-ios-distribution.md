# XDMaker 手机版 iOS 内部分发(NPKG)

> 团队运维手册,**无任何密钥**(token 只在本地 `~/.config/xdt-maker/npkg/credentials.env`,不进仓库)。
> 平台:NPKG(心动内部应用分发 + iOS 签名) · 负责人 明瑞锐(`mingruirui` / @PKG Slack) · 更新 2026-06-26。
> 脚本是 bash;Windows 开发者需在 WSL / git-bash 下运行。

## 一句话

我们自己用 **EAS 构建 `.ipa`** -> 上传 **NPKG** -> NPKG **自动用企业证书重签**(无设备上限) -> 拿到 `/install/<id>` 安装链接发出去。NPKG **只重签、不编译源码**。

## 为什么能“无设备上限”

- 企业 In-House 证书 = **`UE5H8B62F9.*`**(`*` = wildcard App ID),账号 **Shanghai Xindong Enterprise Development Co., Ltd.**。
- 这是 Apple 企业开发者(ADEP)账号,装机**不用登记 UDID、无设备上限**。
- ⚠️ 不是 NPKG「证书」页里看到的 Pte Ltd / Co Ltd / X.D. Network Inc 那 3 张(那些是 App Store distribution)。

## 触发机制:**上传即自动**,无需手动点「打包」

`com.xd.lizcn` 的企业 provisioning profile 配好后(一次性,已完成),**每次上传 NPKG 会自动产出 `type=enterprise` 子包**(秒级),父包 `enterprise` 字段 = 子包 id。

- 实测:配好后的上传 3 秒内就出企业子包;配好前上传则不出。
- 没有「触发打包」这一步、没有对应 API、不再依赖明瑞锐(profile 已就位)。

## 前置(一次性,已完成)

1. NPKG 个人 token -> 存 `~/.config/xdt-maker/npkg/credentials.env`(`NPKG_TOKEN` / `NPKG_BASE_URL`,chmod 600,**不进库**)。可在 NPKG 个人中心(`/account/center`)重新生成。
   如需覆盖路径,设置 `NPKG_CONFIG_DIR=/some/dir`,脚本会读取其下的 `credentials.env`。
2. `com.xd.lizcn` 已接入企业账号 + 配好企业 wildcard profile(“白名单”)。

## 发版怎么做

```bash
# 1) 构建 .ipa(任选其一)
#    - 已有 EAS 构建产物:直接用最近一次 finished 的
pnpm mobile:release:ios:npkg -- from-eas

#    - 或手上已有 .ipa 文件:
pnpm mobile:release:ios:npkg -- upload /path/to/xdmaker.ipa --tag release
#      经 pnpm 调用时 cwd 是仓库根,upload 传绝对路径更稳。

# 2) 脚本会:上传 -> 轮询企业子包 -> 打印安装链接 + itms 链接 + 校验签名 Team
#    把打印出的 https://npkg.xindong.com/install/<id> 发给同事即可。
```

补取已上传父包的安装链接(自测/补发):

```bash
pnpm mobile:release:ios:npkg -- resolve <parent_package_id>
```

## 每次发版的“正确触发”怎么保证

脚本是**带自检的**,不是盲发:

- 上传后**必须轮询到企业子包才算成功**,出不来就**超时报错退出**。
- 打印前**校验签名 Team == `UE5H8B62F9.*`**,不符就告警。

会让它失效的情况 + 对策:

| 风险 | 后果 | 对策 |
|---|---|---|
| 企业证书/profile 到期(**2027-01-26**) | 签名失效/装不上 | 到期前找账号 owner 续签 |
| 白名单/企业账号被改或撤销 | 不再自动出企业子包 | 脚本超时报错会立刻暴露 |
| 上传包 md5 重复 | NPKG 拒收 | 每次发版 bump `apps/mobile/app.json` 的 `ios.buildNumber`(本来就这么做) |
| App 新增特殊 entitlement(推送/App Groups/关联域) | 重签后该能力可能失效 | 加这类能力时确认企业 profile 也带 |

## NPKG API(脚本用到的)

- 上传:`POST /api/v1/packages/`(form-data:`file` + `memo` + `tags`) -> 返回 `{id,...}`(父包)。
- 详情:`GET /api/v1/packages/<id>/`(含 `enterprise` 字段 = 企业子包 id、`check_data` 里有签名 Team)。
- 下载原始包字节:`GET /api/v1/packages/<id>/download/`。
- 删除:`DELETE /api/v1/packages/<id>/`(204)。
- OTA(免 token,iOS 用):安装页 `GET /install/<id>`、清单 `GET /plist/<id>`、ipa `/uploads/...repack.ipa`。
- 注:`/api/v1/.../plist|download/` 带 token;OTA 那套 `/install`、`/plist` 免 token。

## 排错

- **超时没出企业子包**:多半是该 bundle 的企业 profile 没配好/被撤;找明瑞锐确认白名单。
- **上传被拒**:多半 md5 重复 -> 用新 buildNumber 重新构建。
- **装上提示“无法验证 App / 不受信任”**:正常企业签首次安装需在 iPhone「设置 -> 通用 -> VPN 与设备管理」信任该企业开发者。

## 相关文档

- [`dev-and-release-workflow.md`](./dev-and-release-workflow.md) - 手机版三轨开发与发版模型。
- [`../RELEASING.md`](../RELEASING.md) - 发版脚本命令矩阵和人工 checklist。
