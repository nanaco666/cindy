# Desktop DB 子线程化 — db 调用点清单(MR2 审计基础)

> 配套文档:`desktop-db-subprocess.md`(主方案)。
> 本清单是对"改造面到底有多大"的量化盘点,通过 4 个并行子代理逐文件 Read main 进程源码得出。
> 生成时间:2026-06-03。**只读分析,未改任何代码。**
>
> **2026-06 决策:走 worker_threads,db worker 是 main 进程内的独立线程**。本文中"worker 侧" / "db-worker" / "下沉 worker"在 worker_threads 路径下统一指 **db worker thread**。"无法序列化跨进程"的措辞在 thread 间同样成立(thread message 也走 structured-clone,不能传含闭包/句柄的复杂对象)。详见主方案「决策结果」章节。
>
> 分类口径:
> - **符号形态**:getRawDb / getDrizzle / db.transaction / raw.transaction / prepare.all 等
> - **调用方类型**:IPC handler / 后台定时(setInterval) / IM回调(飞书长连接) / worker处理循环(embedding) / 启动期 / 内部工具函数 / MCP tool / 其它
> - **事务闭包?**:N;或 Y + 闭包内是否带【循环/分支/中间计算/嵌套调用/await】(决定能不能拆成线性 step 数组,还是必须在 worker 侧做成具名 RPC)
> - **热循环/批量?**:Y = 在 for/map 里逐行调 db
> - **迁移难度**:易(单条 query 直接换 RPC)/ 中(需批量化或小重构)/ 难(事务闭包带控制流或 native/句柄生命周期锚点)

---

## 概览

| 区 | 覆盖范围 | 调用点数(约) | 难 | 事务闭包 | 非 IPC 调用方 |
|---|---|---|---|---|---|
| A | `localDb/` 自身 + `localDb/ipc/` | ~54 | 9 | 2 | 启动期 / 内部工具 |
| B | `maker-host/` + `maker-orchestration/` | ~34 | 4 | 4 | import 流程 / MCP tool |
| C | `scheduler-host/` + `im/feishu/` + `maker-ipc/` | ~48 | 13 | 0 | scheduler fire + 飞书 IM ~22 处 |
| D | `embedding-host/` + 广播器 + worktree + 杂项 | ~22 | 4 | 4 | embedding tick + 广播器 |
| **合计** | **30+ 文件** | **~158** | **30** | **10** | **大量(见下)** |

**关键结论:改造面是"大半个 main 进程",不是"localDb 一个文件夹"。** 方案文档"非 IPC 调用方本来就少"的判断不成立。

---

## 必须在 worker 侧做成具名 RPC 的事务闭包(10 处,核心工作量)

这批是整个方案最大的风险与工作量。better-sqlite3 的 `db.transaction(closure)` 是同步 JS 闭包,**无法序列化跨进程**,`TxStep[]` 线性数组覆盖不了。每一处都要在 db-worker 侧实现一个具名 RPC,把闭包内的业务逻辑(循环/分支/去重/动态 stmt)一并下沉。

| # | 位置 | 闭包内部干什么 | 建议 RPC 名 |
|---|---|---|---|
| 1 | `localDb/migrationCoordinator.ts:229` `writePageToDb` | 双层 for(sessions × messages)逐行 insert | `migration:writePage(rows)` |
| 2 | `localDb/migrate.ts:129` 每条 migration | 动态 DDL `db.exec(sql)` + 外部 TS `script.run(db)` | 整个 `runMigrations` 留 worker 侧 |
| 3 | `maker-host/codex-local-sessions.ts:257` import messages | for 循环 upsert + 外部 `Set.has` 去重 | `batchUpsertCodexMessages(rows)` |
| 4 | `maker-host/claude-local-sessions.ts:185` import messages | for 循环逐行 upsert + key 拼接 | `batchUpsertClaudeMessages(rows)` |
| 5 | `maker-orchestration/rewind.ts:258` commit rewind | 两条 UPDATE 原子(messages.rewind_at + sessions token reset) | `commitRewind(sessionId, targetCreatedAt, now)` |
| 6 | `maker-orchestration/fork.ts:170` fork session | INSERT 新 session + 批量 INSERT messages(可能数百行) | `forkSession(sessionRow, messages[])` |
| 7 | `embedding-host/EmbeddingWorker.ts:316` markDoneNoVector | for 批量 UPDATE | `embedding:markDoneNoVector(ids)` |
| 8 | `embedding-host/EmbeddingWorker.ts:357` commitEmbeddings | **双表原子写** + 按 vec_table 名动态 build/缓存 stmt | `embedding:commit(jobs, embeddings)` |
| 9 | `embedding-host/EmbeddingWorker.ts:393` recordFailureBatch | for + 分支(attempts 阈值决定 reschedule/fail)+ 退避计算 | `embedding:recordFailures(jobs)` |
| 10 | `embedding-host/EmbeddingService.ts:134` enqueueJobs | for 批量 INSERT OR IGNORE + `inserted++` 计数(返回值) | `embedding:enqueue(items) → {inserted}` |

> 注:`codex-local-sessions.ts:873` `copyThreadStateToTarget` 系列也有事务闭包,但操作的是 **Codex 外部 SQLite**(`new Database(codexDbPath)`),不是 xdt-maker localDb,**不进 db 子进程范围**,迁移时必须严格区分。

---

## 非 IPC 调用方(async 传染高风险区)

方案文档第 6 条说"IPC handler 已 async,改造不构成 contagion"。但下面这批不是 IPC handler,有同步路径 / 深埋回调链 / 自持事务:

### 1. 飞书 IM 长连接回调(~13 处,最大头)
WebSocket 消息回调链 `feishuIm.onMessage → messageHandler → runAgentTurn / handleSlashCommand` 深处的 db 调用:
- `im/feishu/sessionRepo.ts`:`findActiveFeishuSession` / `createFeishuSession` / `touchUserSent`(**每条飞书消息必调,最高频**)/ `clearContext` / `updateModelEffort` / `updatePermissionMode`
- `im/feishu/runAgentTurn.ts`:`resolveRouteTarget` / `maybeGenerateFbotTitleOnFirstMessage` / `persistSdkSessionId`(每次 agent 启动必调)
- `im/feishu/controlProjects.ts`:`listProjectsForControl` / `listSessionsForWorkspace`
- `im/feishu/sessionSummary.ts`:`generateTakeoverSummary`;`slashCommands.ts`:`readSessionTitle`

### 2. 后台 scheduler fire 回调
`scheduler-host/runner.ts:fire()`(由 `@lizi/maker-scheduler` cron 引擎 setInterval 触发,**不在 IPC 栈**):间接调 `getSessionRowSnapshot` / `createMessage` / `backfillSessionMeta`(`_shared.ts` 直接 drizzle update)。

### 3. embedding worker tick
`embedding-host/EmbeddingWorker.ts`:**当前就跑在 main 进程内**(5s setInterval + in-flight 守卫),通过注入的 `getDb()` 直接持同步连接。见下方架构决策。

### 4. 后台广播器 / 启动期
`sessionSpendBroadcaster` / `usageBroadcaster`(每 turn done 后);`bootstrap-electron.ts` 启动期探测 + getter 注入;`reconcileAll` fire-and-forget。

---

## 循环内逐行调 db 的性能热点(迁移后会放大成 N 次 RPC 往返)

| 位置 | 形态 | 风险 |
|---|---|---|
| `localDb/chatHistorySearch.ts:369-413` `fetchContextWindow` | `for (命中) { 3 次串行 drizzle select }`,limit 默认 10 → **最差 30 次往返** | 迁移后最易性能退化;需先合并成"带上下文窗口的批量命中" RPC |
| `maker-host/codex-local-sessions.ts:793` / `claude-local-sessions.ts:343` `upsertLocalSession` | 外层 `for (threadId of uniqueIds)` 逐线程 2 次 raw prepare | 需批量化为单次多行 upsert |
| `scheduler-host/project-automation-loader.ts` `reconcile` / `deleteProjectSchedules` | for 循环逐个 scheduler.create/update/delete(间接 db 写) | 规模受 schedule 数控制,通常不大 |
| `localDb/schemaDriftRepair.ts:86+` | 12 表 × 3 次 PRAGMA ≈ 36 次 | 启动期,均在 worker 侧执行,问题不大 |

---

## write-then-read 一致性(迁移后必须 worker 侧串行保证)

这批是"先写、立即回读最新值"模式,迁移后两步之间若不在同一串行队列,高频场景下可能读到别的 turn 的写:
- `sessionSpendBroadcaster.ts` `recordSessionTurnSpend` / `recordSessionContextSnapshot`(各一对 update+回读,每 turn)
- `localDb/dailySpend.ts:incrementDailySpend`(每 turn 同步 `.run()` + `.get()`,**迁移后调用方 agentManager 必须异步化**)
- `localDb/ipc/sessions.ts` create/update、`localDb/ipc/messages.ts` createMessage(insert/update 后回读)

---

## 关键架构决策缺口(方案文档未交代)

1. **EmbeddingWorker 的归属**:它**当前就在 main 进程内**(不是独立子进程),直接持同步 db 连接跑 3 个事务闭包。db 下放后二选一:
   - 路径 A:embedding 逻辑随 db 进 db-worker → db-worker 变成"db + embedding 计算进程",不再是纯代理
   - 路径 B:embedding 留 main,3 个事务全改 worker 侧具名 RPC(`commit` 双表原子不可拆)
   必须在设计阶段定掉,影响拓扑图。

2. **Codex/Claude 外部 DB 混用**:`codex-local-sessions.ts` 同时操作 xdt-maker localDb(`getRawDb()`)和 Codex 外部 SQLite(`new Database`),两套句柄在 copy 流程混用。后者不进子进程,迁移要严格隔离。

3. **MCP tool 触发路径叠加延迟**:`maker-host/session-search.ts` 由 MCP `session_search` tool(LLM 触发)调用,不是 IPC 也不是后台。迁移后 MCP 路径多一次 RPC 往返,需评估对 agent turn 延迟影响。

4. **句柄生命周期锚点**:`localDb/index.ts` 的 `drizzle()` 初始化、`loadSqliteVec`、`runMigrations`、`closeDb`、`backup.ts` 的 `db.backup` / 临时 `new Database` probe,都强绑 db 句柄,必须整体在 worker 侧,是 native 加载 go/no-go 点。

---

## 零 db 接触(确认无需改动)

- `voice-input/`(整目录)、`mcp-integrations/mcp-providers.ts`、`mcp-integrations/codexHttpBridge.ts`、`worktree/WorktreeManager.ts`
- `maker-host/index.ts`(仅组装层)、`maker-host/rehydrateCloseSuppression.ts`(纯内存)、`maker-host/imported-user-content.ts`(走 imageCacheStore 文件系统)、`maker-host/plugins/settings-reader.ts`(纯 fs 读 JSON)
- `im/index.ts`(仅 orchestration 入口)

---

## 附:各区完整调用点表格

详见本次审计 4 个子代理的逐行输出(区 A/B/C/D)。如需把全部 ~158 行明细贴入本文件,可再生成;上面已按"难度 / 事务 / 非IPC / 热循环 / write-read"五个维度收口到决策所需粒度。
