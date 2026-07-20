---
id: packages--maker-scheduler
type: module
covers:
  - packages/maker-scheduler/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-06T15:29:57.000Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
## 是什么

`packages/maker-scheduler` 是 XDMaker 的定时任务调度引擎。它管理周期性或单次触发的 agent 任务（`claude-code` / `codex`），维护每个 `Schedule` 的状态机（active / paused / expired / running），并在触发时向上层 main 进程发出事件以启动 agent run。

## 关键抽象

- **`Schedule`**：单条调度记录。核心字段：
  - `kind: 'cron'`、`intervalMs`、`nextFireAt`、`lastFiredAt`
  - `agentKind: AgentKind`（`'claude-code' | 'codex'`）
  - `workspaceKind: ScheduleWorkspaceKind`（**必填**，`'project' | 'dialogue'`）：决定 runner 为每次触发分配工作目录的语义；heartbeat 类调度忽略此字段，沿用目标 session 的已有 cwd
  - `useWorktree: boolean`、`targetSessionId?`、`persistentSession`
  - `status: ScheduleStatus`、`manual: boolean`
- **`Scheduler`**（`EventEmitter`）：核心引擎类；`create()` 写入调度记录并计算首次 `nextFireAt`，`start()` 启动内部时钟、修复中断状态的 run，`list()` / `pause()` / `resume()` / `remove()` 等管理接口。`create()` 在 spread `input` 后立即以 `workspaceKind: input.workspaceKind ?? 'project'` 覆写，确保旧调用方不传该字段时行为不变。
- **`CreateScheduleInput`**：`create()` 的入参类型；`workspaceKind` 可选（`?: ScheduleWorkspaceKind`），默认 `'project'`（向后兼容）。
- **`ScheduleWorkspaceKind`**：`'project' | 'dialogue'`，定义并导出于 `types.ts`。
- **`SchedulerEvent`**：Scheduler 向 main 广播的事件联合类型，含 `fire` / `status-change` / `read` / `all-read` / `ready`。其中 `ready` 事件由 main 端在 `scheduler.on(...)` 全部挂完后广播一次（冷启 / 切账号 relogin 均发），唯一用途是让 renderer 的 `schedulesStore` 在切账号场景下后台预热 cache（冷启动场景下 `useSchedules.ensure()` 已在跑 list，`ready` 不会重复触发——store 用 `wasReset` flag 区分两种场景）。

## 模块边界

- **对外暴露**：`Scheduler` 类、`Schedule` / `CreateScheduleInput` 等类型、`ScheduleWorkspaceKind`、`SchedulerEvent` / `SchedulerEventType`
- **不依赖** render 层；不直接调用任何 IPC
- main 进程通过监听 `Scheduler` 事件（fire / status-change / ready 等）来驱动 agent 启动，具体 runner 逻辑在 main 侧实现
- 数据持久化由 `Scheduler` 内部处理（SQLite），不暴露存储细节

## 不要做的事

- 不要在此包里直接 spawn agent 子进程或调用 IPC handler
- 不要在 `create()` 调用点用 `as ScheduleWorkspaceKind` 绕过类型校验；`workspaceKind` 已有默认值，直接传入即可
- 不要假设 `workspaceKind` 对 heartbeat 调度生效——heartbeat 沿用 targetSession 的 cwd，此字段对其无意义
- 不要在 Scheduler 内部 emit `ready`；该事件由 main 端在挂完所有监听器后主动 broadcast，Scheduler 本身不感知

## 演进备忘

- 初始建立知识文件，模块已包含完整 cron 调度引擎与 SQLite 持久化。
- 新增 `ScheduleWorkspaceKind`（`'project' | 'dialogue'`）字段至 `Schedule` 与 `CreateScheduleInput`；`create()` 默认填 `'project'` 保持向后兼容，支持自动化调度区分"项目目录"与"对话目录"两种 workspace 语义。
- 将 `ScheduleWorkspaceKind` 类型正式导出至 `types.ts`，在 `scheduler.ts` `create()` 内以 `?? 'project'` 显式落地默认值，并补充测试覆盖默认行为与 `'dialogue'` 保留两条路径。
- 完成 `workspaceKind` 字段的全量测试补全：在现有 fixture 对象中显式断言 `'project'` 默认值，新增 `'dialogue'` 保留路径独立用例，确保两条分支均有覆盖。
- 将 `workspaceKind` 正式写入 `types.ts`（`Schedule` 必填、`CreateScheduleInput` 可选）并在 `scheduler.ts` `create()` 中落地 `?? 'project'` 默认值；测试同步补全所有 fixture 的 `workspaceKind: 'project'` 断言与 `'dialogue'` 独立用例，类型与实现完全对齐。
- 向 `SchedulerEvent` 联合新增 `{ type: 'ready' }` 事件：由 main 在挂完所有 `scheduler.on()` 监听器后广播一次（冷启 / 切账号 relogin），供 renderer `schedulesStore` 在切账号场景下后台预热 list cache；store 通过 `wasReset` flag 避免与冷启动的 `ensure()` 重复触发。
- 三文件（`types.ts` / `scheduler.ts` / `scheduler.test.ts`）全量落地确认：`ScheduleWorkspaceKind` 类型导出、`Schedule.workspaceKind` 必填字段（含 heartbeat 豁免 JSDoc）、`CreateScheduleInput.workspaceKind` 可选字段、`create()` `?? 'project'` 覆写、四处 fixture 断言 + `'dialogue'` 独立用例、`SchedulerEvent.ready` 事件声明，两项特性全量收尾。
