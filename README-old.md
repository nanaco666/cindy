# Cindy 客户端

Cindy 的客户端 monorepo，包含：

- `apps/desktop`：Electron 桌面客户端
- `apps/mobile`：Expo / React Native 手机客户端
- `apps/android-platform-tools-bin`：桌面端随包使用的 Android Platform-Tools
- `packages/*`：客户端共享能力
- `cindy-protocol/`：与服务端共用的协议 submodule

服务端已经拆到独立仓库 `xindong/cindy-server`，不在本仓构建。

## 首次安装

需要 Node.js 22、pnpm 10、Git LFS，以及访问私有仓库 `xindong/cindy-protocol` 的权限。

```bash
git clone --recurse-submodules git@github.com:xindong/cindy-moved.git
cd cindy-moved
git lfs pull
pnpm install
```

已有 checkout 补 submodule：

```bash
git submodule update --init --recursive
```

协议版本固定在父仓记录的 commit。升级协议时必须同步确认 `cindy-server` 的 submodule 指针。

## 桌面端开发

默认连接远程 API：

```bash
pnpm restart:desktop:remote
```

区域化 desktop dev：

```bash
# 国内版（默认，读取 config/endpoint.json）
pnpm restart:desktop:remote --region=cn

# 海外版（读取 config/endpoint.global.json）
pnpm restart:desktop:remote --region=global

# 验证对应区域的线上 CDN 端点清单
pnpm restart:desktop:remote --region=global --endpoints-cdn
```

连接开发者自己启动的本地服务端：

```bash
pnpm restart:desktop:local
```

少数手机端本地 E2E 会用 `pnpm dev:server` 临时拉起服务端。本仓的这个命令只负责
转发到外部服务端仓：默认查找同级目录 `../cindy-server`，也可以显式指定：

```bash
XDT_SERVER_REPO=/path/to/cindy-server pnpm dev:server
```

dev 数据目录为 `Cindy` userData（2026-07-17 身份翻转起由 `productName: Cindy` 派生，
从空开始；主库为 `cindy-<userId>.db`，不再沿用老 `xdt-maker` 目录的历史数据）。
不要给普通开发启动加 `--isolated`，也不要设置 `XDT_USER_DATA_DIR`；这两个入口
只用于明确需要数据隔离的调试场景。

## 手机端开发

常用入口：

```bash
pnpm mobile:sim:start
pnpm --filter mobile typecheck
pnpm --filter mobile test
pnpm --filter mobile test:scope
```

当前开发说明见 `docs/dev-rules/mobile-development.md`。

## 验证

```bash
pnpm check:endpoints
pnpm --filter desktop typecheck
pnpm --filter desktop db:validate
pnpm --filter desktop test:migration-replay
pnpm --filter mobile typecheck
pnpm --filter mobile test
pnpm --filter mobile test:scope
pnpm test:unit
```

`apps/desktop/drizzle/migration-baseline.json` 固定了从旧仓迁入的历史 SQL。历史
migration 只允许原样保留；数据库变化必须新增 migration。

## CI 与发布

普通 CI 只检查客户端、共享 packages 和协议消费。由于协议仓是私有 submodule，
GitHub 仓库需要配置 Actions secret `CINDY_PROTOCOL_DEPLOY_KEY`，内容为能够只读
`xindong/cindy-protocol` 的 SSH deploy key。

旧仓的发版 CI、签名凭据和自托管 runner 没有迁入。本仓发布线后续单独建设。

## 许可证 / License

除非另有说明，本仓库的源代码依据 [Apache License 2.0](LICENSE) 授权。

模型权重、数据集、提示词、商标，以及其他单独标识的材料，可能适用各自的许可条款，
不因根目录的 Apache-2.0 而被自动覆盖。第三方开源组件保留各自的版权与许可，其归属
声明与 SPDX SBOM 统一收口在 [`docs/legal/`](docs/legal/)；各分发产物的精确清单
见 [`docs/legal/notices/`](docs/legal/notices/)（说明见
[`docs/legal/notices/README.md`](docs/legal/notices/README.md)）。

本项目的版权与归属信息见 [`NOTICE`](NOTICE)。

---

Except as otherwise noted, the source code in this repository is licensed under
the [Apache License, Version 2.0](LICENSE).

Model weights, datasets, prompts, trademarks, and other separately identified
materials may be subject to their own license terms and are not automatically
covered by the repository-level Apache-2.0 grant. Third-party open-source
components retain their own copyright and license. Their attribution notices and
SPDX SBOMs are managed under [`docs/legal/`](docs/legal/), with artifact-specific
outputs in [`docs/legal/notices/`](docs/legal/notices/). See [`NOTICE`](NOTICE)
for this project's copyright and attribution information.
