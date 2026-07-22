# 法律与合规资料

本目录是仓库内人工维护的法律合规记录、第三方许可清单和 SBOM 的统一入口。

- [`wechat-open-sdk-compliance.md`](./wechat-open-sdk-compliance.md)：微信 Open SDK 接入与发布前合规检查。
- [`notices/`](./notices/)：由 `pnpm licenses:generate` 生成的第三方开源声明、受限组件审计表与 SPDX SBOM。

以下文件因生态识别、上游归属或随包分发要求保留在原位，不另建重复真源：

- 仓库根 `LICENSE` 与 `NOTICE`：供 GitHub、包管理器、Podspec 和源码分发识别。
- vendored 源码、原生二进制与字体旁的 `LICENSE` / `NOTICE` / `*-OFL.txt`：必须随对应材料保留。
- `apps/desktop/resources/THIRD-PARTY-*.txt`：生成后随桌面安装包分发的资源副本。
- `cindy-protocol/` 内的法律文件：属于独立协议 submodule 仓库，不由本仓目录重排。

新增人工维护的隐私、条款、SDK 合规或发布合规文档应放在本目录；只有消费者或
分发格式要求固定路径时才就地保留，并在这里登记入口。
