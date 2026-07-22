<p align="center">
  <img src="apps/mobile/assets/splash/cindy-splash-illustration.webp" alt="Cindy" width="200" />
</p>

<p align="center">
  <strong>想到，就能做到。</strong><br />
  你的全能 AI 助理 —— 她能操作你的电脑，代替你完成真实工作，而不只是给答案。
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License" /></a>
  <a href="https://github.com/makecindy/cindy/actions/workflows/ci.yml"><img src="https://github.com/makecindy/cindy/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-22%2B-brightgreen.svg" alt="Node" /></a>
  <a href="https://pnpm.io"><img src="https://img.shields.io/badge/pnpm-10-orange.svg" alt="pnpm" /></a>
</p>

<p align="center">
  🌐 <a href="https://cindy.com.cn">国内版</a> | <a href="https://cindy.app">海外版</a>
</p>

Cindy 运行在你自己的电脑上，使用你本地的文件和已登录的应用，底层由
Claude Code 与 Codex 作为 agent 引擎驱动。
她能操作浏览器、电脑和手机，以「多 agent 团队」协同工作，并支持从 IM 和定时任务派活。

本仓库是 Cindy 的开源**客户端** —— 桌面端、手机端及其共享 packages，以 pnpm
monorepo 组织。

## 本仓包含什么

| 路径 | 说明 |
| --- | --- |
| `apps/desktop` | Electron 桌面客户端 |
| `apps/mobile` | Expo / React Native 手机客户端 |
| `packages/*` | 客户端共享能力（鉴权、device-link、agent 编排、模型供应商等） |
| `apps/*-bin` | 随桌面端打包的 agent / 工具二进制（claude-code、codex、ripgrep、android-platform-tools） |
| `cindy-protocol/` | 与服务端共用的协议（git submodule） |

**服务端不在本仓库：** 服务端（`cindy-server`）位于独立仓库，不属于本 monorepo。软件本身免费。

| 使用方式 | 账号要求 | 可用范围 |
| --- | --- | --- |
| 远程托管 | Cindy 云端账号 | 使用 Cindy 的完整托管服务。下载方式与定价见官网。 |
| 本地模式 | 无需登录 Cindy 账号 | 在登录页选择「本地模式」即可使用本机 agent 功能。依赖服务端的能力在该模式下不可用。 |

## 前置要求

- **Node.js** 22.x
- **pnpm** 10.x（暂不支持 v11）
- **Git LFS**

## 首次安装

```bash
git clone --recurse-submodules https://github.com/makecindy/cindy.git
cd cindy
git lfs pull
pnpm install
```

`--recurse-submodules` 会初始化当前父仓声明的全部 submodule（协议仓与内置插件种子仓），
并递归处理嵌套 submodule。它们会检出父仓锁定的 commit，不会自动追踪各子仓最新版本。

已经 clone 但没拉 submodule：

```bash
git submodule update --init --recursive
```

拉取主仓更新后，建议同步父仓记录的 submodule 版本：

```bash
git pull --ff-only
git submodule update --init --recursive
git lfs pull
```

只有需要主动追踪 submodule 上游最新版本时才使用下面的命令；它会修改父仓中的 gitlink，
需要 review 后提交。协议 submodule 更新时还必须同步服务端的指针。

```bash
git submodule update --remote --merge --recursive
```

协议版本固定在父仓记录的 commit。升级协议时必须同步升级服务端的 submodule 指针，
避免两端 wire protocol 漂移。

## 开发

### 桌面端

```bash
# 中国版 Cindy 账号
pnpm restart:desktop:remote --region=cn

# 海外版 Cindy 账号
pnpm restart:desktop:remote --region=global
```

Remote 开发会使用你自己的 Cindy 云端账号和现有登录态，因此可以继续已有的会话与工作。
这是一种“左脚踩右脚”的 dogfooding 模式：一边开发 Cindy 客户端，一边用正在使用的 Cindy
验证它自己。请务必根据账号所在区域显式选择参数：中国版使用 `cn`，海外版使用 `global`，
不要依赖内部默认值。需要隔离日常数据时，可再加 `--isolated=<name>`。

`restart:desktop:remote` 还支持被动多开等模式。完整启动参数与桌面端 dev / 运行时契约见
[`AGENTS.md`](AGENTS.md)。

登录页的「本地模式」不是连接本地服务端，而是无需登录 Cindy 账号即可使用本机
agent 的模式。依赖服务端的能力在该模式下不可用。

### 手机端

```bash
pnpm mobile:sim:start
pnpm --filter mobile typecheck
pnpm --filter mobile test
```

完整开发与发布流程见
[`apps/mobile/docs/dev-and-release-workflow.md`](apps/mobile/docs/dev-and-release-workflow.md)
和 [`apps/mobile/RELEASING.md`](apps/mobile/RELEASING.md)。

## 测试与校验

```bash
pnpm test:unit                              # 完整单测门禁（每次提 PR 前必跑）

pnpm --filter desktop typecheck
pnpm --filter desktop db:validate
pnpm --filter desktop test:migration-replay
pnpm --filter mobile  typecheck
pnpm --filter mobile  test
```

数据库 schema 变更是 **append-only**：历史 migration 由
`apps/desktop/drizzle/migration-baseline.json` 冻结，任何变化只能新增 migration，
不能改动已有的。

## 架构

- [`DESIGN.md`](DESIGN.md) —— 视觉设计系统、颜色 token 与 UI 规范
- [`CONTRIBUTING.md`](CONTRIBUTING.md) —— 面向社区贡献者的环境、验证与提交流程
- [`AGENTS.md`](AGENTS.md) —— 工程规范、启动 / 运行时契约、模块边界
- [`docs/dev-rules/`](docs/dev-rules/) —— 架构深度文档（如 Orca 多 agent 协同）

## 贡献

改动通过 pull request 合入 `main`。完整流程见
[`CONTRIBUTING.md`](CONTRIBUTING.md)。提 PR 前至少需要：

1. 跑 `pnpm test:unit` 并确认全部通过，或在 PR 中说明未执行原因。
2. 按 [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) 填写 PR 描述。

[`AGENTS.md`](AGENTS.md) 中的工程规范是代码风格、双平台（macOS/Windows）兼容，
i18n、主题、review 严重度的权威依据。

## 安全

任何凭证 / 授权文件都不得提交进工作区。发现安全问题请按照
[`SECURITY.md`](SECURITY.md) 的说明私下报告，不要开公开 issue。

## 许可证 / License

除非另有说明，本仓库的源代码依据 [Apache License 2.0](LICENSE) 授权。

模型权重、数据集、提示词、商标，以及其他单独标识的材料，可能适用各自的许可条款，
不因根目录的 Apache-2.0 而被自动覆盖。第三方开源组件保留各自的版权与许可，其归属
声明与 SPDX SBOM 统一收口在 [`docs/legal/`](docs/legal/)；各分发产物的精确清单
见 [`docs/legal/notices/`](docs/legal/notices/)。本项目的版权与归属信息见
[`NOTICE`](NOTICE)。
