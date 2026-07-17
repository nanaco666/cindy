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

完整开发与发布说明见 `apps/mobile/docs/dev-and-release-workflow.md` 和
`apps/mobile/RELEASING.md`。

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
