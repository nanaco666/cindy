# Dogfooding 工作流：用 Cindy 开发 Cindy

> 状态：参考（工作流指南）。记录 2026-07 时点的代码事实与实践建议，文中文件引用均经代码核对；与代码冲突时以代码为准，并请在同一改动里修正本文档。worktree 生命周期的已知 bug 与改进计划见 `docs/worktree-lifecycle.md`（MR1–MR4）。

## 背景与结论

Cindy 本身就是 coding agent 宿主，用它开发它自己（dogfooding）是最紧的产品反馈环。**结论：编码生产环今天端到端可用**——在 worktree 会话里 edit → typecheck → vitest → `git commit` → push 任务分支 → `gh pr create` 全链路通畅。代码和文档改动正常都通过 PR 进入 `main`；local merge-back 只作为开发者明确选择的本地验证例外，直推远端 `main` 只在具备 bypass 权限的仓库维护者明确授权并通过额外门禁时使用。真正的限制只有一条物理约束（HMR 是 checkout 级的，见下）和两个 P0 缺口（worktree 运行时验证未工具化、新 worktree 无 node_modules，见文末差距清单）。

## 心智模型：HMR 是 checkout 级的，不是 repo 级的

运行中 dev 实例的 Vite renderer server 根目录是**启动它的那个 checkout** 的 `apps/desktop/src/renderer`（`apps/desktop/vite.renderer.config.ts:222`，`root: path.resolve(__dirname, 'src/renderer')`）。因此：

| agent 在哪里编辑 | 对运行中的 baseRepo dev 实例的影响 |
|---|---|
| `baseRepo/apps/desktop/src/renderer/**` | **HMR 即时热更** |
| `baseRepo/packages/<零依赖包>/src/**` | 热更（这些包被排除出 optimizeDeps，`vite.renderer.config.ts:179-219`） |
| `baseRepo` 的 main / preload / `packages/maker-core` | **人工 restart 前无任何效果**（maker-core 以 TS 源码形式打进 main 构建；forge 的 vite 插件不会自动重启 Electron） |
| **`baseRepo/.cindy-worktrees/<wt>/**` 下的任何文件** | **完全无效果**——绝对路径不同，不在 dev server 的 module graph 里 |

所以 **worktree 会话是"产出分支"的地方，不是"观察 app 变化"的地方**。正常验证 worktree 改动有三条路：
(a) worktree 内跑 typecheck / vitest；(b) 从该 worktree 启一个 verify 实例（见下）；(c) PR 发布后刷新由最新 `main` + 待验证 PR 组成的 personal client / 验证 checkout。确需复用现有 baseRepo 实例做快速 HMR 时，可以显式选择 local merge-back，但它只是本地验证，不是发布路径，也不能据此直推远端 `main`。

## 实例拓扑（推荐稳态）

支撑事实：正常 dev 与打包版在共享 userData 时共用 single-instance lock；任意数量的显式 `--passive` dev 都会跳过锁，以便和 primary 共享数据多开并让出自动 schedule。`--isolated[=<名字>]` 会切独立 userData，因此仍能各自持锁并并行；`XDT_USER_DATA_DIR` 仅 dev 生效，也可用于显式隔离 userData / SQLite。passive 多开不提供 `second-instance` 转发，主 `cindy://` deep link（以及永久兼容的历史 `xdt-maker://`）落到哪个实例由当前 OS 协议注册归属决定；Vite 端口不固定（5173 起按启动顺序递增）。

1. **实例 A——日常主力**。由**人**在自己的终端从 baseRepo 启动（`pnpm restart:desktop:remote`，默认模式）。**承载所有会话**：baseRepo 里的只读 / 运维会话 + 全部 N 个任务 worktree 会话（WorktreeManager 在 `baseRepo/.cindy-worktrees/` 下创建，都归这个实例管；历史 `.xdt-worktrees/` 继续兼容）。代码和文档修改都在任务 worktree 完成。与打包版 app 二选一常驻；必须共享数据同跑时加 `--passive`，需要完全隔离时用 `--isolated` / `XDT_USER_DATA_DIR`。
2. **实例 B..N——per-worktree verify 实例（短命）**。需要真机验证某个 worktree 的 main / renderer 改动时，由**人**从该 worktree 启动：

   ```bash
   # macOS（bash / zsh）
   cd /path/to/baseRepo/.cindy-worktrees/<wt>
   XDT_USER_DATA_DIR="$HOME/.xdt-dev-userdata/<wt>" pnpm restart:desktop:remote
   ```

   ```powershell
   # Windows（PowerShell）——POSIX 行内 env 赋值在 PowerShell / cmd 下不生效，
   # 会静默丢失 XDT_USER_DATA_DIR、退回默认 userData，正好撞上本节要防的 SQLite 冲突
   cd C:\path\to\baseRepo\.cindy-worktrees\<wt>
   $env:XDT_USER_DATA_DIR = "$env:USERPROFILE\.xdt-dev-userdata\<wt>"; pnpm restart:desktop:remote
   ```

   只用来点检运行时表现，userData 视为一次性，用完即杀。不要在里面开长期会话，也不要嵌套 worktree（worktree 内的 New Maker worktree 开关会被禁用）。
3. **打包版 Cindy.app——可选的稳定兜底**。restart 脚本永远不会杀它（其可执行路径不含源码 rootDir）。

**kill 范围的不对称性（重要，已核对 `scripts/restart-desktop-remote.mjs:96-112`）**：进程匹配按「命令行是否含本 checkout 的 rootDir（后随 `/` 或引号边界）」判定。worktree 路径是 baseRepo 路径的子路径，因此：

- 从 **baseRepo** 跑 restart → 会杀掉 baseRepo 实例 **以及所有从 `.cindy-worktrees/` 下启动的 verify 实例**；
- 从**某个 worktree** 跑 restart → 只杀该 worktree 自己的实例，不动实例 A；
- 其它位置的 sibling checkout 互不影响（宁可漏杀不误杀，脚本内注释已说明）。

**agent 永远无法重启宿主**：restart 脚本检测到自己的 ppid 链在 Cindy dev 进程树内会 exit 1 拒绝（by design）。每次 main / maker-core 迭代预算一次人工触碰。

## 变更类型 → 回路决策表

| 变更类型 | 在哪做 | 验证回路 | 需要人吗 |
|---|---|---|---|
| 小 / 安全的 renderer 改动 | 任务 worktree | worktree 内 vitest / typecheck；需要运行时验证时走 verify / personal client | 视验证方式而定 |
| 有风险的 renderer / 布局重构 | worktree 会话 | worktree 内 vitest / typecheck + 可选 verify 实例 | 启 verify 实例 |
| main / preload / dbWorker | worktree 会话 | 无热更；verify 实例，或 PR 进入验证 checkout 后人工 restart | **是**（restart 永远是人） |
| `packages/maker-core` | worktree 会话 | restart 回路 + **规则 10 人工指标实测**（缓存率 / 性能 / 返回速度 / 准确性，静态检查测不出） | **是** |
| system prompt 各段 | **agent 不得擅动** | 规则 11：先停下找 Lizi 确认 | **是** |
| DB schema | worktree 会话，ORM 生成 migration，append-only | `pnpm --filter desktop test:migration-replay` 必跑（规则 17） | **是** |
| 零依赖 `packages/*` | 任务 worktree | 定向测试 / typecheck；按消费者决定是否需 verify | 视验证方式而定 |
| 给带依赖内部包（maker-core、maker-cc-manager 等）**新增 export** | 任意 | **陷阱**：stale Vite prebundle → `does not provide an export named X` → 白屏（`vite.renderer.config.ts:157-177`）。解法：受影响实例完整重启（触发 re-optimize） | 是（restart） |

baseRepo 正常只承载运行实例和只读 / 运维会话，不作为新代码或文档任务的编辑现场。需要 HMR 的 renderer 改动优先从任务 worktree 启 verify 实例，或在 PR 发布后刷新 personal client；只有人明确选择快速内环时才 local merge-back，不能因为“改动很小”由 agent 自行跳过 worktree / PR。

## 启动 N 个并行 worktree 会话

**UI 步骤（每个会话，在实例 A 内）**：

1. New Maker composer → 项目 chip 选中本仓库。
2. 点齿轮（SlidersHorizontal）→ Advanced：选 **Branch**（源分支，默认当前分支），勾选 **worktree**（`renderer/components/new-chat/WorktreeChipsRow.tsx`）。名字自动生成（如 `pensive-lederberg`）且不可编辑——自己记一张「名字 → 任务」映射表。
3. 选权限模式（`PermissionSelector`）：默认 `acceptEdits`（自动接受文件编辑、Bash 仍提示）；无人值守跑长任务可用 `auto` / `bypassPermissions`。「Always allow for session」（权限提示上 Ctrl+Enter）**只持久化到本会话**，目前没有跨会话白名单。
4. 引擎优先选 **Claude Code**：Codex 默认 `workspace-write` sandbox 会拦 worktree cwd 之外的写入（pnpm monorepo 的根 hoisted 路径容易撞上，`packages/maker-core/src/agents/codex/index.ts:248-276`）；Claude Code 的 Bash 无 sandbox。
5. 发送。app 先建会话，再异步创建 worktree（`git worktree add --no-checkout -b xdt/<name>` + `CLAUDE.md` / `.claude` 等 staged copy + 后台完整 checkout），并把会话 `workingDir` 改写为 worktree 路径。

**首条消息模板**（补偿当前已知缺口，建议每个 worktree 会话都带上）：

> 你的 cwd 是 `.cindy-worktrees/` 下的 git worktree。注意：
> 1. 先确认 checkout 已完成（`package.json` 存在、`git status --short` 干净——创建返回后完整 checkout 仍在后台跑，staged copy 不含 `package.json`），然后 node_modules 缺失就先跑 `pnpm install`（首次可能数分钟，注意命令超时，必要时分步跑）；
> 2. 宿主 app 的日志在 `<baseRepo>/apps/desktop/logs/`，不在你的 cwd 下；
> 3. 你的任何编辑都不会出现在运行中的 app 里（HMR 只 watch 启动 checkout），不要以为"改了没生效"是 bug；验证用本 worktree 内 `pnpm --filter desktop typecheck` / 定向 `vitest run`；
> 4. 你不能重启桌面端；需要运行时验证时，正常先 commit，再按当前开发者 / 宿主 workflow push 任务分支并创建 / 更新 PR；local merge-back 或直推 `main` 必须由有权决定的开发者明确选择。

**并发事实**：每会话一个 worktree + 一条 `xdt/<name>` 分支；同一 baseRepo 上创建是串行的；`MAX_WORKTREES=5` 上限**只作用于 scheduler 的 ephemeral 池**，交互式 worktree 不设上限（GC 靠自己，见下）。**不要用 Orca workers 做并行隔离**——当前所有 worker 共享 Lead 的单一 workingDir（`orcaWorkerCreationService.ts:399`），并行写必然互踩；per-worker worktree 是 `docs/orca-team-architecture.md` Part 2 的未来项。N 个独立普通会话各持 worktree 才是当前正确姿势。

## 监控与 review N 个并行会话

- **注意力信号**：侧边栏 attention 红点 + dock 徽标在 dev 下可靠；未打包 dev 构建的原生系统通知不可靠（打包才有 AUMID / 图标注册），可在 Settings → Notifications 开飞书 DM 兜底。
- **会话内 review**：右侧栏「改动」tab 展示 per-file diff——但它是**消息推导**的（聚合 Edit / Write tool call，`diff-panel/useSessionDiffs.ts`），不是 git 真相；手工编辑、跨会话叠加不会被合并呈现。
- **权威分支 delta** 用终端（右侧栏 Terminal tab 是真 PTY，或自己的 shell；所有 worktree 共享 baseRepo 的 `.git`，在仓库任意位置都能跑）：

  ```bash
  git worktree list
  git log --oneline <source-branch>..xdt/<name>
  git diff <source-branch>...xdt/<name>
  ```

  `<source-branch>` 是创建会话时 Branch 选择器里选的源分支（默认为当时的当前分支），worktree 可以从任意 commit-ish 创建——硬套 `main` 会把源分支相对 main 的无关分叉也混进 review 视野。

- **PR 徽标**：agent 用 `gh pr create`（或 Cindy GitHub 意识）建 PR 后，消息里的 PR URL 会被动提取为侧边栏实时状态徽标（open / draft / merged / closed；依赖本机 `gh auth login`）。
- **中途干预**：Stop 中断、mid-turn steer、队列面板挂 pending 消息、fork-at-message 改道。

## 验证与发布

**按变更类型先验证**（对照上面的决策表），正常走 PR：

**默认发布路线——PR（产品徽标全程可用）**：agent 在 worktree 会话内完成验证与本地 commit，再按当前开发者 / 宿主 workflow 的授权约定执行

```bash
git add <相关文件> && git commit -m "..."
git push -u origin xdt/<name>
gh pr create --base <source-branch> ...
```

然后走正常 GitHub review / merge。`--base` 不能省：省略时 `gh` 会取 `gh-merge-base` 配置、否则退回仓库默认分支（main）——从非 main 源分支创建的 worktree 会把 PR 开到 main，混入源分支的无关分叉（同上一节监控命令的 `<source-branch>` 语义）。draft / ready 状态遵循贡献者使用的发布 workflow。`xdt/*` 是产品当前仍在使用的历史兼容分支前缀，不代表允许套用迁移前的 Git 发布规则。

**本地验证例外——local merge-back**：只有开发者明确选择复用现有 baseRepo 实例做快速 HMR 时才使用。它只把任务分支临时聚合到本地验证 checkout，不等于发布，也不自动授权 push `main`；合并前先确认 checkout 干净并记清来源，验证后由该 checkout 的维护者决定如何恢复或丢弃本地集成状态，agent 不得擅自 reset / clean 他人现场。

**远端发布例外——直推 `main`**：只有具备 ruleset bypass 权限的仓库维护者明确授权才使用，并严格执行 `AGENTS.md`「提 PR」节的完整 `pnpm test:unit` 与独立对抗性 review 门禁。GitHub ruleset 的 bypass 只是实现这个例外的能力，不是默认路线。

## 收尾顺序（顺序错了会吃改动）

1. worktree 内先完成验证并 **commit**；再按当前开发者 / 宿主 workflow 的授权约定 push 任务分支并创建 / 更新 PR。
2. 然后才在 app 里**删除或归档**会话——status 变更触发 `sessionRemovalRecycle.recycleWorktreeForRemovedSession` → `removeWorktreeForSession`：worktree 若是脏的，改动会先保存为内容快照（`refs/xdt/snapshots/<sessionId>`，stash-form commit；stash 栈条目保留作冗余备份，`git stash list | grep xdt-auto-stash` 可见）再删除 worktree；确认弹窗会提示"有未提交更改"。归档会话重新打开后可经「恢复工作区」横幅一键重建 + apply 快照；手动恢复：`git stash apply $(git rev-parse refs/xdt/snapshots/<sessionId>)`。（2026-07 P0 重构：回收从 onClose 迁到显式删除/归档，`/clear`、鉴权重连、app 退出、CLI 崩溃等瞬态 close 不再删 worktree；删除前有 live-ref 守卫与 `.worktree-keep` 哨兵守卫。）
3. PR merge 后按 Git workflow 清理 worktree 和本地分支；产品不会自动替你清理，长期不收口会持续积累。
4. **不要**绕过产品手动 `git worktree remove` 仍有会话引用的 worktree：`worktrees.json` ⇄ `sessions.worktree_path` 漂移是已确认 bug 类（MR2 未做），resume 时 cwd 缺失也还没有恢复 UX（MR3 未做）。
5. 每周 GC：

   ```bash
   git worktree list
   git branch --list 'xdt/*'
   git stash list | grep xdt-auto-stash
   ```

## Pitfall 对照表

| 坑 | 根因（已核对） | 规避 |
|---|---|---|
| 删除/归档会话吃掉未提交改动 | snapshot-then-remove（`WorktreeManager.ts` removeWorktreeForSession；2026-07 起仅删除/归档触发，瞬态 close 不再触发；确认弹窗有脏改动警告） | 删除/归档前先 commit；误吞后归档会话可一键「恢复工作区」，或 `git stash apply $(git rev-parse refs/xdt/snapshots/<sessionId>)`；在 worktree 里手动干活时放 `.worktree-keep` 哨兵文件可豁免一切自动回收 |
| worktree 会话里 skill / 配置陈旧 | `.claude` / `.sivi` 在创建时一次性 copy；之后 baseRepo 的 skill 改动对既有会话不可见 | 改完后重建任务 worktree 会话；发布前重新读取当前 AGENTS / Git workflow，不沿用旧快照 |
| 「在 worktree 里改了没反应」 | HMR 根在启动 checkout（`vite.renderer.config.ts:222`） | 见心智模型节；verify 实例或 PR 发布后刷新 personal client |
| 给 maker-core 等加 export 后白屏 | stale optimizeDeps prebundle（`vite.renderer.config.ts:157-177`） | 受影响实例完整重启 |
| 多个实例争用运行职责 | 正常共享 userData 的实例会被 single-instance lock 拦住；`--passive` 明确允许任意多个 dev 共享数据并让出自动 schedule | 要共享数据联调就给额外 dev 加 `--passive` / 用 `--preserve-running`；要数据库 / 登录态完全隔离就用 `--isolated[=<名字>]` 或显式 `XDT_USER_DATA_DIR` |
| 从 baseRepo restart 误杀 verify 实例 | worktree 路径是 baseRepo 路径子路径，kill 匹配按 rootDir 前缀 | 重启实例 A 前先记住 verify 实例会陪葬，需要就重新启 |
| deep link 落错实例 | `cindy://`（历史 `xdt-maker://` 同）后注册者赢（`deepLink.ts`） | 接受现状；知道哪个实例最后注册即可 |
| agent 读错日志 | dev 日志在**启动 checkout** 的 `apps/desktop/logs/`（`logger.ts:311-316`） | 首条消息模板第 2 条 |
| Codex 写 hoisted node_modules 被拦 | `workspace-write` sandbox（`codex/index.ts:248-276`） | worktree 会话先用 Claude Code 引擎 |
| agent Bash 找不到 `pnpm` / `gh` | GUI 启动的 app 继承不到 shell PATH | dev 实例永远从登录 shell 的终端启动 |
| worktree 没了之后 resume 失败 | MR3 未做，无恢复 UX | 有会话引用时不要手动删 worktree |
| `xdt/*` 分支 + stash 积压 | 清理时保留分支（无 `-D`）、无 GC | 每周 GC（见收尾节） |
| 长任务无安全网 commit | auto git snapshot 默认关（`git-snapshot-host.ts`） | 指示 agent 阶段性 commit（或启用 snapshot） |

## 当前差距清单与改进 backlog（2026-07 时点）

**P0（挡住日常使用）**

1. **worktree 改动无运行时验证路径（未工具化）**：verify 实例需要手动 `XDT_USER_DATA_DIR` + 端口不确定，无一键启动。→ 建议做 `scripts/dev-worktree.mjs` 启动器：接 worktree 路径，自动分配 `XDT_USER_DATA_DIR=<worktree>/.xdt-dev-data` 与确定性端口，复用 restart 脚本的进程扫描做启 / 杀。
2. **新 worktree 无 node_modules，创建流程不装**（`WorktreeManager.ts` 无任何 install 逻辑；include-patterns 显式跳过 node_modules）。→ 短期靠 AGENTS.md 契约（已加）；正解是 createWorktree 后台 `pnpm install` + `WorktreeCreatingOverlay` 状态。

**P1（能用但每天疼）**

- Bash 审批白名单只有 session 级持久化（`permissions.ts` 归一化为 `destination: 'session'`）——N 个并行会话重复审批 N 次。
- worktree 里 `.claude` / `.sivi` 是创建时快照，不随 baseRepo 更新。
- 删除/归档会话静默 auto-stash + 删 worktree，无确认、无 UI 提示（对应 MR3 方向；瞬态 close 误删已由 2026-07 P0 重构消除）。
- 「改动」tab 非 git 真相，且无 commit / push / PR 按钮——分支提交与 PR 发布全靠终端。
- stale prebundle 白屏陷阱只能靠文档规避。

**P2（锦上添花）**：worktree 名不可编辑 / 不可复用、`xdt/*` 分支与 stash 无 GC、dev 构建原生通知不可靠、Orca per-worker worktree（未来项）、Codex sandbox 与 pnpm hoisted 路径冲突、`.xdmaker/project-knowledge` 待刷新。

**推荐推进顺序**（每步本身就是 dogfooding 任务，按当前能力递增）：Day 0 人工验证闭环（登录 shell 启实例、`gh auth status`、跑一个 trivial worktree 会话到 PR）→ 纯文档契约（本文档 + AGENTS.md 节）→ 任务 worktree 里的小 UX 修复练手 → `scripts/dev-worktree.mjs`（P0-1）→ createWorktree 后台 install（P0-2）→ 持久化审批白名单 / auto-stash 确认 UX / `.claude` 重同步（P1）→ git 真相 review tab + commit / PR 按钮（最大件）。

## 已知不确定性（待实测）

- 新 worktree 内 `pnpm install` 的真实耗时与 agent Bash 超时的交互未实测。
- worktree 创建后数秒内启 verify 实例可能与后台完整 checkout 竞争——启动前先确认 `git -C <wt> status` 干净。
- dev 构建的原生通知行为按 OS 有差异（代码注释主要针对 Windows AUMID），macOS dev toast 待一次性验证；badge / 飞书可兜底。
