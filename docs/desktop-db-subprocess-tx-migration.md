# Desktop DB 子线程化 — 10 个事务闭包的搬迁方案

> 配套:`desktop-db-subprocess.md`(主方案)、`desktop-db-subprocess-callsites.md`(调用点清单)。
> 本文逐个给出 `db.transaction(closure)` 的搬迁设计。读了每处精确源码后得出。生成时间:2026-06-03。
>
> **2026-06 决策:走 worker_threads(`node:worker_threads`),db worker 是 main 进程内的独立线程,不是子进程**。本文中"worker 侧" / "db worker" / "下沉 worker"在 worker_threads 路径下统一指 **db worker thread**。讨论"跨进程"的场景仅在比较 `UtilityProcessTransport` escape hatch 时出现。Float32 / 大 payload 的"transferable / transferList 零拷贝"在 thread 间是真正的同进程内存零拷贝(比子进程间更高效)。详见主方案「决策结果」章节。

## 核心洞察(先看这个)

读完 10 处源码后,有两个结论直接影响方案形态:

### 洞察 1:embedding 归属 —— 深挖后推荐"留 main"(纠正初版)

> **初版本文曾推荐"路径 A:embedding 整体进 db-worker",理由是省掉 Float32 跨进程序列化。读完 provider 模式 + wiring 后该结论被推翻,见下。**

`EmbeddingWorker` 的 3 个事务 + `EmbeddingService.enqueueJobs` 共 4 个,在 embedding-host 模块内。但 embedding 的真实耦合不止 db:

```
tick(5s) → provider.getTextsForJobs()  读 db(messages)+ 纯函数 extractEmbedText
         → client.embed()               网络到 xdproxy + Bearer ANTHROPIC_API_KEY
         → commitEmbeddings()           写 db(vec 表 + jobs,Float32)
```

- **路径 A(不推荐):embedding 整体进 db-worker**。4 个事务确实不用改,但要把 **网络栈 + auth token(`readClaudeApiKey`)+ provider 注册模式** 一起拖进 worker。provider 是 consumer 在 **main bootstrap 注册的闭包**(`setupChatHistoryEmbedder`),跨进程后这套解耦契约要重新设计(未来 memory/document consumer 也要能注册)—— 这是真架构改动。且 worker 崩溃域从"纯 db"扩大到"db + 网络 + auth"。
- **路径 B(推荐):embedding 留 main,db 操作走 RPC**。4 个事务改具名 RPC + `getTextsForJobs` 的 SELECT 改 query RPC。**worker 保持纯 db RPC 服务边界**(方案设计原则 5),net/auth/provider 全留 main 不动。

**Float32 跨进程不是问题**:batch 32 × 1024dim × 4B = 128KB/批、5s 一 tick,MessagePort **transferable ArrayBuffer 零拷贝**传,微秒级。"JSON 膨胀+精度"只在 JSON-RPC 下成立,方案用 MessagePort 不受影响。

**结论:embedding 留 main(路径 B)。** 10 个事务全部要处理(6 个边界 + 4 个 embedding RPC),但 worker 边界干净、embedding 的复杂耦合不污染 db 进程。Float32 不是选型理由。

### 洞察 2:6 个边界事务的搬迁模式高度统一,没有"恶心 case"

读完源码确认:这 6 个闭包的输入**全是内存里已备好的 POJO 数组 / 标量**,闭包内**没有 await、没有"事务执行到一半要回 main 等数据"的跨进程依赖**。所以搬迁模式统一为:

> **具名 RPC + 数据数组/标量入参 + worker 侧固定执行闭包逻辑 + 返回计数/标量**

不存在"事务里跨 IPC"这种会 hold 着 SQLite 锁阻塞其它请求的情况。这是好消息 —— 工作量大但风险可控,是机械搬迁不是架构博弈。

---

## 6 个边界事务(必须做 main↔worker RPC)

### TX-1 `migrationCoordinator.ts:227` writePageToDb

- **现状**:`raw.transaction(()=>{ for sessions { insertSession; for messages { insertMessage } } + 3×writeMeta })`。闭包内含日期转换 `new Date(x).getTime()`、`getSynced()`(内嵌一次 readMeta)。
- **输入**:`resp: RawPage`(sessions[] 含嵌套 messages[],纯 POJO,来自云端分页拉取)。
- **输出**:void(外部 `recordRecentDelta(resp.sessions.length)` 留 main)。
- **原子性边界**:整页(sessions + messages + meta)一个事务。
- **RPC**:`migration.writePage(resp: RawPage): Promise<void>`
- **下沉到 worker**:日期转换、`writeMeta`/`readMeta`/`getSynced`(它们本就读写 migration_meta 表,整组搬进 worker)。
- **难点**:无真难点;RawPage 直接 structured-clone。注意 `cloud_migration_*` 这组 meta 读写全部归 worker,main 侧的进度展示从 worker push 的 `migration:progress` event 拿。
- **难度**:中。

### TX-2 `migrate.ts:129` 每条 migration 的事务

- **现状**:`db.transaction(()=>{ db.exec(sql); if(tsScript){ require(path); script.run(db) } writeSchemaVersion; writeMigrationHistory })`。**闭包里能 require 外部 TS 脚本并把裸 `db` 句柄交给它任意操作。**
- **原子性边界**:单条 migration(DDL + TS 脚本副作用 + version + history)一个事务。
- **RPC**:不是单个 RPC —— **整个 `runMigrations` + `backup`/`restore`/`schemaDrift` 子系统搬进 worker**,启动期由 worker 在 `ensureReady` 内部跑,完成后 push ready。
- **难点(真难,但是"搬运"难不是"设计"难)**:
  1. TS migration 脚本产物路径在 **worker 进程**的 `require` 解析 —— packaged 后 `app.asar.unpacked` 路径要重新校准(worker 的 `__dirname` 与 main 不同)。**这是 MR0 spike 必须验的点。**
  2. `db.backup`(async)、`restoreDbFromBackup`(关连接→覆盖文件→重开)、CORRUPT probe(`new Database(readonly)` + `PRAGMA quick_check`)全部强绑句柄,必须在 worker 侧。
- **难度**:难。

### TX-3 `codex-local-sessions.ts:257` importExternalCodexMessages

- **现状**:`db.transaction((rows)=>{ for row { if(!existingImportedClientIds.has(cid) && isLikelyLocalDuplicate(existing,row)) continue; upsert.run(...); changed+=... } return changed })`。依赖两个从 db 读出的 Set(`existing` 指纹、`existingImportedClientIds`)。
- **原子性边界**:一个 session 的整批 import 消息。
- **RPC(收口式,推荐)**:`importCodexMessages(sessionId, prefix, rows: ImportedCodexMessage[]): Promise<{changed:number}>` —— 把"读两个 Set + 去重 + 事务 upsert"整段下沉 worker,main 只传原始 rows。
- **下沉到 worker**:`readExistingMessageFingerprints`、`readExistingImportedClientIds`、`isLikelyLocalDuplicate`、`stringifyContent`(确认是纯函数即可直接搬)。
- **难点**:去重逻辑要跟 main 解耦;`rows` 由 `readCodexRolloutMessages`(读 Codex rollout 文件)在 main 侧产出后传入 —— 文件读保留 main,只把 db 部分下沉。
- **难度**:难。

### TX-4 `claude-local-sessions.ts:185` importExternalClaudeCodeMessages

- **现状**:与 TX-3 对称,`db.transaction((rows)=>{ for row { upsert.run(...); changed+=... } })`,但**没有外部 Set 去重**(纯 upsert)。
- **RPC**:`importClaudeMessages(sessionId, prefix, rows: ImportedClaudeMessage[]): Promise<{changed:number}>`
- **下沉到 worker**:`stringifyContent`。
- **难点**:比 TX-3 简单(无去重 Set)。
- **难度**:难(归类难是因为带循环事务,实际工作量中)。

### TX-5 `rewind.ts:258` commitRewind

- **现状**:`await db.transaction((tx)=>{ tx.update(messages).set({rewindAt:now}).where(sid & createdAt>=target & rewindAt IS NULL); tx.update(sessions).set({userSendAt,updatedAt,contextTokens:0,contextWindow:0}).where(sid) })`。
- **输入**:全标量 —— `sessionId`、`ctx.targetCreatedAt`、`now`。**最干净的一个。**
- **原子性边界**:两条 UPDATE。
- **RPC**:`commitRewind(sessionId, targetCreatedAt, now): Promise<void>`,事务后的 `db.select(sessions)` 回读单独走一次普通 query RPC。
- **难点**:无。SDK 副作用(`makerSession.commitRewindFiles`)本就在事务外,留 main。
- **难度**:中(因为输入全标量,实际偏易)。

### TX-6 `fork.ts:170` forkSession

- **现状**:`await db.transaction((tx)=>{ tx.insert(sessions).values(新session); if(sourceMessages.length) tx.insert(messages).values(sourceMessages.map(remap)) })`。`sourceMessages` 由前面一次 `db.select` 拉出,`remapAgentMetaUuid` 在内存重映射 UUID。
- **原子性边界**:INSERT 1 session + 批量 INSERT N messages(可能数百行)。
- **RPC(收口式,强烈推荐)**:`forkSession(sourceSessionId, targetCreatedAt, newSessionRow, uuidMap): Promise<void>` —— **把 sourceMessages 的 select + remap + insert 整段下沉 worker**。
  - 反例(不要这么做):main 先 `select` 数百条回来 → remap → 再把数百条传回 worker insert。等于把同一批 message 跨进程**来回搬两趟**,序列化成本翻倍。
- **下沉到 worker**:`remapAgentMetaUuid`、`createId`(message id/clientId 生成)。`sessionToCamel`(返回值转换)留 main。
- **难点**:remap 逻辑下沉;`newSdkSessionId`/`uuidMap` 由 `getMaker().forkSdkSession`(SDK 调用)在 main 侧先产出,作为入参传给 worker。
- **难度**:难。

---

## 4 个 embedding 事务(推荐路径 B:留 main + RPC)

> 下表是**路径 B(embedding 留 main,推荐)**下的 RPC 设计。若反选路径 A(embedding 进 db-worker),这 4 个不改,但代价见洞察 1。

### TX-7 `EmbeddingWorker.ts:316` markDoneNoVector
- 闭包:`for rows { stmt.run(rowid) }` 纯批量 UPDATE。
- 路径 B RPC:`embedding.markDone(rowids: number[]): Promise<void>`。难度:易。

### TX-8 `EmbeddingWorker.ts:357` commitEmbeddings ⚠️最难
- 闭包:**双表原子** —— 按 `job.vec_table` 动态 build/缓存 stmt,`INSERT INTO "{vecTable}"(rowid, embedding=Float32Array)` + `UPDATE embedding_jobs status='done'`。
- 路径 B RPC:`embedding.commit(items: {rowid:number; vecTable:string; embedding:Float32Array}[]): Promise<void>`。
- **难点**:`embedding` 是 Float32Array(1024dim×4B,batch 32 ≈ 128KB/批)。走 MessagePort **transferable ArrayBuffer 零拷贝**传(微秒级,5s 一 tick),不是性能问题。绝不用 JSON 序列化 number[](膨胀+精度)。`vec_table` identifier 校验 `/^[A-Za-z0-9_]+$/` 也下沉 worker。
- 难度:难(双表原子 + 动态 vecTable);但 Float32 跨进程在 transferable 下不痛,不构成选路径 A 的理由。

### TX-9 `EmbeddingWorker.ts:393` recordFailureBatch
- 闭包:`for jobs { nextAttempts>=MAX ? updFail : updReschedule(now+backoff) }`,带分支 + 退避计算。
- 路径 B RPC:`embedding.recordFailures(rowids+attempts, errMsg, now): Promise<{failCount}>`,分支/退避下沉 worker。难度:中。

### TX-10 `EmbeddingService.ts:134` enqueueJobs
- 闭包:`for items { INSERT OR IGNORE; if(changes>0) inserted++ }`。
- 路径 B RPC:`embedding.enqueue(source, items): Promise<{inserted, skipped}>`。难度:中。

---

## 汇总与建议

| TX | 位置 | RPC | 难度 | 备注 |
|---|---|---|---|---|
| 1 | migration writePage | `migration.writePage(resp)` | 中 | meta 读写一并下沉 |
| 2 | migrate 每条 | runMigrations 整体进 worker | 难 | TS 脚本 require 路径是 spike 必验点 |
| 3 | codex import | `importCodexMessages(...)` | 难 | 去重 Set 下沉 |
| 4 | claude import | `importClaudeMessages(...)` | 难 | 无去重,偏中 |
| 5 | rewind commit | `commitRewind(sid, t, now)` | 中 | 全标量,偏易 |
| 6 | fork | `forkSession(...)` 收口 | 难 | 别来回搬 messages |
| 7 | embedding markDone | `embedding.markDone(rowids)` | 易 | |
| 8 | embedding commit | `embedding.commit(items)` | 难 | Float32 走 transferable,不痛 |
| 9 | embedding failures | `embedding.recordFailures(...)` | 中 | 分支/退避下沉 worker |
| 10 | embedding enqueue | `embedding.enqueue(source,items)` | 中 | getTextsForJobs 的 SELECT 也改 query RPC |

**行动建议:**
1. **embedding 留 main(路径 B)**,worker 保持纯 db RPC 服务。10 个事务全部处理,但 net/auth/provider 复杂耦合不污染 db 进程。Float32 走 MessagePort transferable,不是选型理由(见洞察 1)。
2. **MR0 spike 必验**:TX-2 的 TS migration 脚本在 worker 进程 packaged 后的 `require` 解析(`asar.unpacked` 路径)。这是唯一一个"可能根本跑不通"的点,其余都是工作量。
3. **6 个边界事务统一用"具名 RPC + 数组/标量入参 + 计数返回"模式**,TX-3/TX-6 用收口式(把读+计算+写整段下沉),避免 message 来回跨进程。
