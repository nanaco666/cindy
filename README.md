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
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-22.x-brightgreen.svg" alt="Node.js 22.x" /></a>
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

## 开始开发

开发者安装、公开 submodule 初始化、Git LFS、依赖更新和权限说明统一见
[`CONTRIBUTING.md`](CONTRIBUTING.md)。公开贡献者不要使用会尝试拉取私有 `xd`
插件仓的全量递归初始化命令。

最短入口：

```bash
git clone https://github.com/makecindy/cindy.git
cd cindy
git submodule update --init --recursive cindy-protocol apps/desktop/resources/builtin-ghosts/official
git lfs pull
pnpm install
```

## 开发入口

```bash
# 中国版 Cindy 账号
pnpm restart:desktop:remote --region=cn

# 海外版 Cindy 账号
pnpm restart:desktop:remote --region=global
```

Remote 开发会使用你自己的 Cindy 云端账号和现有登录态，因此可以继续已有的会话与工作。
中国账号必须使用 `cn`，海外账号必须使用 `global`，不要依赖内部默认值。完整的桌面端、
手机端、数据隔离和验证流程见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

登录页的「本地模式」不是连接本地服务端，而是无需登录 Cindy 账号即可使用本机
agent 的模式。依赖服务端的能力在该模式下不可用。

## 架构

- [`DESIGN.md`](DESIGN.md) —— 视觉设计系统、颜色 token 与 UI 规范
- [`CONTRIBUTING.md`](CONTRIBUTING.md) —— 面向社区贡献者的环境、验证与提交流程
- [`AGENTS.md`](AGENTS.md) —— 工程规范、启动 / 运行时契约、模块边界
- [`docs/dev-rules/`](docs/dev-rules/) —— 架构深度文档（如 Orca 多 agent 协同）

## 贡献

改动通过 pull request 合入 `main`。请先阅读
[`CONTRIBUTING.md`](CONTRIBUTING.md)，再按
[`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) 提交。

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
