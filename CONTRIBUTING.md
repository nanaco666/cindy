# Contributing / 贡献指南

感谢你为 Cindy 贡献代码、文档和反馈。本仓库是 Cindy 的开源客户端仓，负责
desktop、mobile 及共享 packages；服务端位于独立仓库，不在本仓库的贡献范围内。

## 开始之前

- 使用 Node.js **22.x**、pnpm 10.x 和 Git LFS。
- 先阅读 [README.md](README.md) 的安装说明，以及适用的
  [工程规则](AGENTS.md)。`AGENTS.md` 是详细工程约束，不是本指南的替代品。
- 不要提交凭证、令牌、授权文件、个人数据或生成的本地数据库。
- 当前父仓会锁定 submodule 的 commit。没有对应权限时，不要把私有 submodule
  的凭证写入 Git 配置或仓库文件；`xd` 插件 submodule 是可选的私有开发资源。

## 获取代码与安装

公开贡献者不要依赖一次性递归拉取所有 submodule。先克隆主仓，再初始化当前可访问的
必需 submodule：

```bash
git clone https://github.com/makecindy/cindy.git
cd cindy
git submodule update --init --recursive cindy-protocol apps/desktop/resources/builtin-ghosts/official
git lfs pull
pnpm install
```

如果必需的协议 submodule 不可访问，请先在 issue 中说明，不要提交任何访问令牌。
`apps/desktop/resources/builtin-ghosts/xd` 属于私有可选资源；没有它不应阻断普通的
客户端安装、开发和测试。协议 submodule 的版本由父仓锁定，除非在对应变更中协调，
不要使用 `git submodule update --remote` 擅自移动 gitlink。

拉取主仓更新后，同步父仓锁定的公开 submodule，并保留父仓记录的 commit：

```bash
git pull --ff-only
git submodule update --init --recursive cindy-protocol apps/desktop/resources/builtin-ghosts/official
git lfs pull
```

只有在明确要升级 submodule、并准备同步 review 和提交 gitlink 时，才使用
`git submodule update --remote`。协议版本升级还需要和服务端维护者协调，避免两端
wire protocol 漂移。

## 开发与验证

### 桌面端

远程开发需要 Cindy 账号，并且必须显式选择区域：

```bash
pnpm restart:desktop:remote --region=cn
pnpm restart:desktop:remote --region=global
```

登录页的“本地模式”是无需登录 Cindy 账号的本机 agent 模式，不是连接本地 server；
依赖服务端的能力在该模式下不可用。连接本地 server 需要额外的、独立的服务端 checkout，
不属于普通公开贡献者的默认路径。

### 手机端

```bash
pnpm mobile:sim:start
pnpm --filter mobile typecheck
pnpm --filter mobile test
```

### 验证

根据改动范围选择必要的检查。完整单测门禁为：

```bash
pnpm test:unit

pnpm --filter desktop typecheck
pnpm --filter desktop db:validate
pnpm --filter desktop test:migration-replay
pnpm --filter mobile typecheck
pnpm --filter mobile test
```

涉及端点、移动端 scope、发布流程或其他专项规则时，请运行对应检查，并在 PR 中写明
实际执行的命令和结果。数据库 schema 变更只能新增 migration，不能修改历史 migration。
未执行的验证必须说明原因。

移动端完整开发与发布流程见
[`apps/mobile/docs/dev-and-release-workflow.md`](apps/mobile/docs/dev-and-release-workflow.md)
和 [`apps/mobile/RELEASING.md`](apps/mobile/RELEASING.md)。

## 提交 Pull Request

1. 从最新的 `main` 创建短生命周期分支，保持一个 PR 只解决一个清晰的问题。
2. PR 标题使用 `<type>(<scope>): <简短描述>`，例如
   `docs(readme): clarify local mode`。可用 type 见
   [PR 模板](.github/PULL_REQUEST_TEMPLATE.md)。
3. Review 完整 diff，确认没有凭证、无关生成文件或意外的 submodule 指针变化。
4. 按 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md) 填写变更范围、验证、风险和回滚方式。
5. 等待 CI 和 review；不要直接向 `main` 推送。

小型文档修正也欢迎直接提交 PR。较大的架构、协议、数据库 migration、权限或用户数据
变更，建议先开 issue 讨论范围和兼容性。

## 安全问题

不要在公开 issue、PR 或讨论中披露漏洞、凭证或可利用细节。请按
[SECURITY.md](SECURITY.md) 的流程私下报告。
