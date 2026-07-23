# 开发环境与依赖准备

> **读取时机**：首次克隆、创建新 worktree、缺少依赖或安装命令失败时

## 环境要求

- Node.js 与 pnpm 版本以根 `package.json` 的 `engines` 和 `packageManager` 为准。
- Git 与 Git LFS。

先核对实际版本：

```bash
node --version
pnpm --version
git lfs version
```

## 安装

公开贡献者只初始化普通开发必需且可访问的 submodule，不要为了取得私有 submodule
而索取、复制或写入凭证：

```bash
git clone https://github.com/makecindy/cindy.git
cd cindy
git submodule update --init --recursive cindy-protocol apps/desktop/resources/builtin-ghosts/official
git lfs pull
pnpm install
```

新 worktree 不共享 `node_modules`。确认 checkout 已完成且根 `package.json` 存在后，
在该 worktree 内重新运行 `pnpm install`。

## 不变量

- submodule 版本由父仓 gitlink 锁定；普通同步不得使用 `git submodule update --remote`。
- `apps/desktop/resources/builtin-ghosts/xd` 是可选的私有开发资源，缺失时不要把访问令牌
  写入仓库、Git 配置或脚本。
- 依赖和命令的事实源是当前 checkout 的 `package.json` 与脚本。文档和脚本冲突时，
  先核对代码并修正文档，不要继续执行已失效命令。
- 不要把其他 checkout 的 `node_modules`、用户数据、授权文件或数据库复制进当前工作区。

贡献方式与 PR 流程见仓库根 [`CONTRIBUTING.md`](../../CONTRIBUTING.md)。
