# Worktree Lifecycle 待办清单

## 背景

Cindy 现在用 `baseRepo/.cindy-worktrees/<name>` 给会话和 scheduler 任务创建 Git worktree，并继续识别品牌迁移前的 `.xdt-worktrees` 路径。这个设计的目标是让多个 agent 会话可以在同一个项目上并行工作，同时避免直接污染用户的原始 checkout。

当前实现已经覆盖了创建、池化复用、脏目录保护和侧边栏徽标，但生命周期权威还不够清晰：`worktrees.json`、`sessions.working_dir`、`sessions.worktree_path` 都在描述 worktree 状态，清理逻辑容易把仍被 session 使用的 worktree 当成可回收资源。

## 已确认的问题

- WorktreePool 的数量淘汰只看 store 总数和 dirty 状态，之前没有检查 session 是否仍引用该 worktree。
- WorktreePool 的 `fs.rm` fallback 之前没有复用统一的 `isManagedWorktreePath` 安全门。
- dirty worktree 被 auto-stash 后会变成 clean，从而可能被后续池化清理当成可删除对象。
- `worktrees.json` 和 SQLite session 字段可能漂移，导致 sidebar、resume、清理逻辑看到的状态不一致。
- `workingDir` 同时承担“项目归属”和“agent 实际执行 cwd”两种含义，worktree 场景下容易影响 skill 扫描、项目分组和历史恢复。
- session 恢复时如果 cwd 已不存在，目前缺少产品级修复路径。

## 参考结论

Codex 的核心经验：thread 的 cwd 是一等状态，但 Codex 不主动拥有本地 Git worktree 的创建和删除。它会识别 linked worktree，并把信任、hooks 和项目配置锚回 root checkout。

Claude Code 的核心经验：只删除自己创建且能证明安全的 worktree；删除前检查未提交改动和额外 commit；检查失败就保留；同时把稳定的 project root 和实际执行 cwd 分开。

## 设计原则

- Worktree 是会话或任务隔离资源，不是普通临时目录。
- 自动清理必须失败时保守处理：不能证明安全时保留，不删除。
- 仍被未删除 session 引用的 worktree 不能被 pool、recovery 或 stale cleanup 删除。
- dirty worktree 不能通过 auto-stash 被静默转成“可删除的 clean worktree”。
- 所有删除都必须经过统一安全门，不能在不同模块里各自直接 `fs.rm`。
- 后续要把“项目根目录”和“实际执行目录”分开建模。

## MR 拆分

### 已完成（2026-07）：回收触发信号修正（P0 热修 + 重构）

问题根因：非 ephemeral worktree 的回收挂在 Maker `lifecycleHooks.onClose`（SDK 子进程退出）上，而 close 是进程生命周期事件、不是用户意图——`/clear`、鉴权重连、app 退出、CLI 崩溃都会触发，导致活会话的 worktree 被静默 stash+删除。

已落地：

- `maker:close-session` IPC 支持 `preserveWorkspace` 选项（软重启语义），`/clear` 与鉴权重连传入后经 `withRehydrateCloseSuppressed` 跳过 onClose 重副作用（`maker-ipc/closeSessionRequest.ts`）。
- app 退出期 `rehydrateCloseSuppression.suppressAllForShutdown()` 一刀切抑制——退出期的 fire-and-forget 回收会与 `app.exit` 竞争，可能删到一半。
- onClose 不再调用 `removeWorktreeForSession`，只保留 ephemeral 池化归还；非 ephemeral 回收唯一驱动点是会话 status → `deleted` / `archived` 的显式变更（`localDb/ipc/sessions.ts` → `worktree/sessionRemovalRecycle.ts`）。
- `removeWorktreeForSession` 增加 live-ref 守卫（`worktree/liveSessionRefs.ts`，排除被删会话自身），路径仍被其它未删除会话引用时保留。
- 启动期 `reconcileWorktreesForDeletedSessions()` 对账：owning session 已删除/行缺失的孤儿 worktree 补收；archived 刻意不在启动期补收（避免升级瞬间批量吃掉旧版遗留的脏 worktree）。

### 已完成（2026-07）：快照 ref + 恢复 UX + 哨兵 + 确认警告（P1）

- 脏 worktree 回收前的内容保护从「只留在 baseRepo 共享 stash 栈」升级为「转存命名空间 ref `refs/xdt/snapshots/<sessionId>`」（`dirty.ts`：stash push -u 后按 message **精确（endsWith）定位**条目 → update-ref；转存失败则中止删除、worktree 原地保留）。stash 条目**保留在栈里作冗余备份**（`xdt-auto-stash:` 前缀可识别）——不自动 drop 是有意取舍：`stash@{n}` 是共享 reflog index，进程外 stash 操作可在 list 与 drop 之间使 index 漂移、误删用户条目。恢复成功后以 `refs/xdt/snapshots-consumed/<sessionId>` 标记去重，同会话快照覆盖保留最新一份。
- 恢复 UX（MR3 的 worktree 部分）：`worktree:restore-status` / `worktree:restore-for-session` IPC + 会话视图 `WorktreeRestoreBanner`——目录缺失但 `xdt/<name>` 分支还在时显示「工作区已被回收 → 恢复工作区」，一键 `git worktree add` 重建 + `git stash apply <snapshot>` + store 重登记。
- `.worktree-keep` 哨兵（对齐 Claude Desktop）：worktree 根放置该文件后，删除回收、池化归还、数量淘汰、启动对账全部跳过。
- 删除/归档确认弹窗预检（`worktree:removal-preview`）：worktree 有未提交更改时确认文案追加警告（单删/归档 + 批量删除）。

### MR1：worktree 删除安全热修

目标：修复当前会导致 active session worktree 被池化淘汰的安全问题。

范围：

- WorktreePool 淘汰前检查是否仍被未删除 session 引用。
- WorktreePool 删除 fallback 复用 `isManagedWorktreePath`。
- dirty worktree 在 WorktreePool 中直接 preserved，不再 auto-stash 后入池。
- 删除失败时不清 store，避免记录和磁盘状态继续漂移。
- 增加回归测试。

不做：

- 不改 SQLite schema。
- 不改 renderer 恢复界面。
- 不做 maker package 层抽象。
- 不改变用户手动创建普通 worktree 的入口和交互。

### MR2：生命周期事实源收敛

目标：让 DB 成为 worktree 生命周期的权威记录，减少 `worktrees.json` 与 session 字段漂移。

待办：

- 设计 `worktrees` 表或等价的 main-side repository。
- 明确 `projectRoot`、`runtimeWorkingDir`、`worktreeId` 的关系。
- 写启动迁移：从 `worktrees.json`、现有 session 字段、`git worktree list` 里补齐状态。
- 保留 `worktrees.json` 作为兼容缓存或迁移输入，避免长期双写。

### MR3：缺失 worktree 的恢复体验

目标：session resume 或发送消息时 cwd 不存在，不再只报“工作目录已不存在”，而是给可恢复动作。

待办：

- 启动和 resume 时识别 `missing-worktree` 状态。
- 提供切回原始仓库、重建 worktree、保留错误、查看 stash 的动作。
- renderer 只展示状态和动作，具体判断留在 main。
- 补 Windows 路径和 macOS 路径的恢复测试。

### MR4：maker package 层 worktree provider

目标：把 Codex、Claude、scheduler 可复用的 worktree 能力沉到 maker package 能力层。

待办：

- 设计 `WorktreeProvider` 接口：detect、create、reuse、remove、recover、list。
- Desktop main 只负责编排、日志、IPC 和权限边界。
- 支持不同 agent 模式的配置继承规则。
- 为未来非 Git 或自定义 hook 的 worktree 创建方式留入口。

## 验收标准

- 任意自动清理路径都能说明“为什么这个 worktree 可以删”。
- 任意无法证明安全的路径都被保留，并有日志说明原因。
- session 使用的 cwd 与 sidebar 项目归属可以独立解释。
- Windows 和 macOS 都不依赖硬编码分隔符、大小写假设或 POSIX-only 行为。
