# 审查面板 Git 化架构

> 状态: 已落地 v1。本文是 `apps/desktop` 右侧栏「审查」tab 的架构契约与实现索引, 只保留当前仍有效的产品决策、安全不变量和模块地图。

## 背景

审查面板从旧的「agent Edit/Write/MultiEdit 消息查看器」升级为「绑定当前会话 worktree 的 git 工作区审查器」。事实源切到 `git status` / `git diff`, agent 本轮改动只作为 Last turn 过滤条件。

对标结论: 交互以 OpenAI Codex 桌面 App 为主, GitHub Desktop 为辅。Codex 提供 source dropdown、真实 staged/unstaged、hunk 操作、commit/push、worktree 默认执行环境和自研 diff renderer 的方向; GitHub Desktop 提供 partial patch 拼装与 `git apply` 边界处理经验。

## 决策

| # | 决策 | 结论 |
|---|---|---|
| D1 | 审查数据源 | git status/diff 是唯一事实源; agent 消息只提供 Last turn 文件过滤 |
| D2 | commit 模型 | 真实暂存区模型: 用户显式 stage/unstage, commit 只提交真实 staged 内容 |
| D3 | v1 写操作 | stage / unstage / discard(仅工作区还原) / commit / push; 不做 pull / reset / amend / squash |
| D4 | pull | 不提供 pull/fetch/rebase/merge; 落后上游只展示本地 tracking ref 信息, 同步交给终端 |
| D5 | worktree | 审查面板只消费会话 worktree, 不管理 worktree 生命周期; worktree 能力独立于 Orca 协同 |
| D6 | branch/PR | v1 不建/不切/不改 branch; create branch 永久不进审查面板; PR 二期基于既有分支再做 |
| D7 | stage 粒度 | 文件级 + hunk 级 + section 批量; 行级不做; rename/copy v1 只允许整文件操作 |
| D8 | diff 渲染 | 自研 renderer: unified/split、未改动行分隔、hunk 操作、虚拟化、worker 异步高亮 + LRU。当前实现复用既有 highlight.js worker; 不引入 react-diff-view / Monaco / diff2html |
| D9 | Last turn 写操作 | M5 起 Last turn 是可写过滤视图: 每个 diff 按自身 source 给 stage/unstage 按钮; 批量「全部暂存」和「还原全部」只作用于过滤集里的 unstaged 文件 |
| D10 | 还原语义 | 对齐 Codex: 「还原/Revert」是丢弃工作区改动的破坏性操作, 不是取消暂存; 需要确认弹窗, 未跟踪文件会被删除 |

## 模块地图

### main: `apps/desktop/src/main/git-review/`

| 模块 | 职责 |
|---|---|
| `types.ts` | ReviewScope、FileStatus、FileDiff、Hunk、DiffLine、写操作结果等 IPC 数据模型 |
| `gitRunner.ts` | git-review 专用 git 执行器; 支持 stdin、timeout、AbortSignal、非交互 env、dubious ownership 重试 |
| `scopeResolver.ts` | sessionId -> session row + WorktreeStore -> `resolveSessionGitDirLive` -> ReviewScope |
| `statusReader.ts` | `git status --porcelain=2 -z --branch` 解析 staged/unstaged/untracked、ahead/behind、unmerged、进行中操作 |
| `diffReader.ts` | 读取 staged/unstaged/untracked diff, 做 binary/large/too-large/submodule 分流 |
| `diffParser.ts` | raw unified diff -> FileDiff/Hunk/DiffLine; 维护 hunk header、三套行号、no-newline、rename/mode、selectableLines |
| `patchFormatter.ts` | DiffSelection -> 可 apply 的 patch; 自算 hunk header, 未选 Delete 转 context, 未选 Add 丢弃 |
| `stageOps.ts` | 文件级和 hunk 级 stage/unstage/discard; section 批量; stale diff / 禁 partial / rename 边界处理 |
| `commitOps.ts` | `git commit -F -`; 校验 message、staged 非空、无 unmerged/进行中操作 |
| `pushOps.ts` | 首推 set-upstream、普通 push、非快进二段确认、`--force-with-lease` |
| `ipc.ts` | `git-review:*` handler; handler body 可注入测试; 错误统一 `throwIpcError` |
| `index.ts` | 服务组装与导出 |

### renderer

| 模块 | 职责 |
|---|---|
| `plugins/review/ReviewTabBody.tsx` | source dropdown、紧凑顶部栏、文件列表、diff 区、stage/unstage/discard、commit、push |
| `plugins/review/useReviewGitState.ts` | 读取 git-review IPC; 刷新策略为显式刷新、窗口聚焦、turn 结束、debounce |
| `plugins/review/useLastTurnFilter.ts` | 从 agent 消息提取本轮 touched paths, 归一为 repo-relative POSIX 后过滤 git diff |
| `plugins/review/DiffViewer/` | 自研 diff renderer、split/unified 行模型、高亮 worker 接入、虚拟化阈值与测试 |
| `RightSidebarShell.tsx` | auto-create 使用 git dirty summary, 不再依赖 agent 消息 diff |

## 写门禁与安全不变量

- 所有改 index / HEAD / ref 的操作必须进入 `git-snapshot/gitRepoWriteQueue`, 与 auto-snapshot、Codex rewind 共用同一写队列。
- 写操作 main 侧硬校验 scope 可用、writeDisabledReasons 为空; renderer 置灰只是体验层, 不作为安全边界。
- agent turn 进行中时禁用 stage/unstage/discard/commit/push; turn 结束刷新后再启用。
- 检测 `MERGE_HEAD`、`REBASE_HEAD`、`rebase-merge`、`rebase-apply`、`CHERRY_PICK_HEAD`、`SQUASH_MSG` 等进行中状态时, 全部写操作冻结, 只读观测保留。
- linked worktree 的 git state 路径必须经 `git rev-parse --git-path`; 禁止拼 `<worktree>/.git/...`。
- hunk stage/unstage 用当前 diff 生成 patch, apply 前重读/校验新鲜度; 禁 `--3way`; stale 即失败并要求刷新。
- stage hunk: unstaged diff -> `git apply --cached --unidiff-zero --whitespace=nowarn -`。
- unstage hunk: staged diff -> `git apply --cached -R --unidiff-zero --whitespace=nowarn -`。
- discard hunk: unstaged diff -> `git apply -R --unidiff-zero --whitespace=nowarn -`; file/section 级 discard 只作用于工作区, untracked 路径会删除, staged 内容保留。
- discard 是破坏性写操作, renderer 必须先弹确认; main 侧仍进写队列并重读 status/diff。
- 禁 partial 名单: binary、submodule、unrenderable、large-text、rename/copy。
- commit 使用 `git commit -F -`, 不做 empty commit, 不做 include-unstaged。
- 用户显式 commit/push 尊重仓库 hooks 与 GPG 配置; 内部 patch apply 与只读命令保持确定性。
- push 无 upstream 时 set-upstream; ahead=0 且 behind>0 纯落后禁推; 非快进需要二段确认并用 `--force-with-lease=<ref>:<oid>`。
- IPC 错误必须走 `throwIpcError`; renderer 用 `extractIpcError` 按错误码本地化, 不做 message 子串匹配。

## 仍有效风险

| 风险 | 对策 |
|---|---|
| partial patch 边界坑(rename/no-newline/CRLF/stale) | 移植 Desktop 风格 patchFormatter 用例; v1 禁 rename/copy partial; discard hunk 复用同一 stale 防线 |
| stale patch 误 apply | apply 前校验新鲜度; 禁 `--3way`; 失败刷新并提示重试 |
| linked worktree git state 定位错误 | 所有状态文件路径经 `git rev-parse --git-path` |
| 多会话或外部写入竞态 | 所有 review 写操作进 `gitRepoWriteQueue`; agent running 由 main 写入口硬拒绝(`SESSION_RUNNING`, 入队前与队列执行时各校验一次); renderer 置灰仅是体验层 |
| auto git-snapshot 与用户 commit 混淆 | v1 worktree 会话维持 auto-snapshot 禁用/跳过; 未来若开启必须复用写队列并跳过用户已推进 HEAD 的 turn |
| 大 diff 卡顿 | 先 plain 渲染; 高亮走 worker + LRU + 阈值降级; 文件列表和 diff 行按阈值虚拟化 |
| Windows 路径/换行差异 | 路径使用 git 输出的 repo-relative POSIX; gitRunner 处理 stdin/timeout/非交互 env; 关键用例覆盖 CRLF 与 literal pathspec |

## 二期候选

优先级从高到低:

1. PR 创建: 基于既有分支执行 push + create PR。
2. word diff: 成本低、阅读收益高, 但大 diff 需自动降级。
3. 图片预览 diff: 先做 two-up 预览, 避免图片改动只显示 binary。
4. 行级 staging: selection 模型已按原始 DiffLine.index 设计, 后续可放开交互。
5. Branch source 视图: 只读比较当前分支与 base。(已完成)
6. commit 历史: 已对齐 Codex——source 下拉「提交」子菜单列出 base..HEAD 分支领先提交(基准复用 Branch source 默认链), 不做完整历史浏览/分页/搜索。
7. md 富预览: 可复用聊天区 Markdown renderer, 重点在切换和失败回退。

明确不做: pull、create branch、blame gutter、pdf 预览。

## 里程碑状态

- M1: git-review 读链路、status/diff/diffParser、git 数据源 ReviewTabBody 已完成。
- M1.5: source dropdown、Commit source 最近 20 条提交只读 diff 已完成。
- M1.6: rename 表达、长行滚动、hunk 间未改动行、中文裸文案、相对时间等 UI 修复已完成。
- M2: patchFormatter、stageOps、commitOps、stage/unstage/commit UI 已完成。
- M2.1: commit 后刷新、STALE_DIFF 错误码、rename partial 说明已完成。
- M3: pushOps、推送门禁、ahead/behind 联动、force-with-lease 确认已完成。
- M3.1: push lease/no-remote/generic 错误文案与门禁 tooltip 已完成。
- M4: diff worker 高亮、unified/split、虚拟化已完成。
- M5: Last turn 写操作、紧凑顶部栏、Codex 式还原(discard)、本文档入库已完成。
