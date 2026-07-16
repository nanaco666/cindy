# MR0 spike — Desktop DB 子线程化 go/no-go 验证

> 配套:`desktop-db-subprocess.md`(主方案)、`-callsites.md`(调用点清单)、`-tx-migration.md`(事务搬迁)。
>
> **本 spike 的目的**:在动土前用最小代价验证会决定方案形态的不确定点。
>
> **2026-06 决策**:走 worker_threads(详见主方案「决策结果」节)。SPIKE-0 PASS、SPIKE-1/2 因此 N/A,只剩 SPIKE-3 仍需在 MR1 阶段验。

---

## 总览(当前状态)

| Spike | 不确定性 | 状态 |
|---|---|---|
| **SPIKE-0** | worker_threads 里 better-sqlite3 + sqlite-vec native 加载可用性 | ✅ **PASS**(2026-06-04 dev 6/6,详见下方) |
| ~~SPIKE-1~~ | ~~utilityProcess 里 native 加载~~ | **N/A**(走 worker_threads 路径,共享 main 的 module resolution) |
| ~~SPIKE-2~~ | ~~TS migration 脚本 `require(tsScriptPath)` 在 worker 进程 packaged 后能解析~~ | **N/A**(worker thread 的 `__dirname` 跟 main 一致,共享 module resolution) |
| **SPIKE-3** | drizzle query builder 能独立于 driver 输出 SQL + params(execute 走 RPC) | ✅ **PASS**(2026-06-04 6 条试金石全过 + 2 个工程发现,详见下方) |

---

## SPIKE-0:已 PASS(2026-06-04 dev 验证)

### 结果

dev 模式 6/6 PASS:

| Check | 结果 | 关键细节 |
|---|---|---|
| `require_better_sqlite3` | ✅ | 在 worker_thread 内 require 成功 |
| `open_memory_db` | ✅ | `new Database(':memory:')` 正常 |
| `basic_crud` | ✅ | prepare / run / get / all 全 OK |
| `transaction` | ✅ | `db.transaction(closure)` 在 thread 内可用 |
| `load_sqlite_vec` | ✅ | `loadExtension('vec0.dll')` 成功 |
| `vec_version_query` | ✅ | **`vec_version() = v0.1.9`** |

环境:`Electron 41.2.0` / `Node 24.14.0` / `v8 14.6.202.31-electron.0` / `NODE_MODULE_VERSION 145`。
报告 JSON 保留在:`<userData>/spike-worker-threads-2026-06-04T07-03-10-074Z.json`。

### Packaged 双平台验证 — 降级为 release smoke

原计划"packaged Win/Mac 必须各跑一次"已降级,理由:

- 我们 worker 形态用 `new Worker(WORKER_CODE, { eval: true })` 内嵌字符串,**根本不 require local file 路径**,绕开了 [electron#43513](https://github.com/electron/electron/issues/43513) 的核心风险点
- worker 内只 `require('better-sqlite3')`(bare specifier),走 Node module resolution 沿 `__dirname` 向上找 `node_modules`,**dev 和 packaged 走同一套算法**
- dev 环境是真实 Electron 41.2.0 + electron-rebuild 重编过的 native ABI,跟 packaged 99% 一致
- packaged 验证降级到 **MR 合并前 release smoke 流程**(跟所有 release 一样,本来就要跑 smoke test)

### spike 脚本怎么再跑(如需复测)

详见 `apps/desktop/src/main/__spike__/README.md`。要点:
- **Dev 模式用环境变量** `XDT_SPIKE=worker-threads`(`restart-desktop-remote.mjs` 会吞 argv)
- **Packaged 模式用 argv** `--spike-worker-threads`(直接给 binary)
- 跑完 `app.exit(0/1)`,报告写 `<userData>/spike-worker-threads-<ISO>.json`

---

## SPIKE-3:已 PASS(2026-06-04 验证 + 2 个工程发现)

### 结果

环境:`drizzle-orm@0.36.4` / `better-sqlite3@12.9.0` / vitest in-memory db,通过 `ELECTRON_RUN_AS_NODE=1` 跑(见下方"工程发现 1")。

| Query | `.toSQL()` 形态 | R1 vs R2 等价 | 备注 |
|---|---|---|---|
| sessions:list | `SELECT ..., count(messages.id) FROM sessions LEFT JOIN messages ... GROUP BY sessions.id ORDER BY sessions.updated_at DESC LIMIT ?` | ✅ | raw 返回 snake_case + `count(...)` 表达式 key;手动 map 后与 drizzle 嵌套 `{session, messageCount}` 等价 |
| archiveWorkers | select + update 串联 | ✅ | `session_id` → `sessionId` 映射后等价 |
| dailySpend upsert | `INSERT ... ON CONFLICT (...) DO UPDATE SET ...` | ✅ | `.run()` 返回 `{changes, lastInsertRowid}` 与 raw 一致 |
| listWorkdirs GROUP BY HAVING | `GROUP BY working_dir HAVING ... ORDER BY MAX(created_at) DESC` | ✅ | raw 聚合列是表达式 key,映射后与 drizzle alias 等价 |
| fetchSessionsMeta inArray | `WHERE sessions.id IN (?, ?, ?, ?, ?)` | ✅ | 5 元素展开 5 placeholder,params 平铺正确 |
| relational query | N/A | N/A | grep `db.query.` / `drizzle.query.` 全仓库 0 命中,**项目当前不用 relational query** |

测试文件:`apps/desktop/src/main/localDb/__tests__/drizzle-split.spike.test.ts`(MR1 合并时跟 `__spike__/` 一起评估去留 — 可保留作 drizzle proxy 回归 baseline)。

### 工程发现 1:better-sqlite3 ABI 与 plain Node 不兼容,vitest 必须走 Electron-as-Node

`apps/desktop/node_modules/better-sqlite3` 经 `electron-rebuild` 编为 Electron 41.2.0 的 NODE_MODULE_VERSION 145。直接 `pnpm vitest` 用宿主 Node(v24.13.0, ABI 137)跑会报 native ABI mismatch。

**正确跑法**(以后 desktop 包加任何用 better-sqlite3 的 vitest 都按这个):
```bash
$env:ELECTRON_RUN_AS_NODE='1'    # PowerShell
ELECTRON_RUN_AS_NODE=1            # bash / cmd
pnpm --filter desktop exec electron ../../node_modules/vitest/vitest.mjs run <test-pattern>
```

Electron-as-Node 环境是 Node v24.14.0 / modules=145,与 packaged native 一致。**MR1 切片文档需把这条记进单测运行指南**。

### 工程发现 2:raw SQL 执行不会复刻 drizzle 的 row mapping,drizzle proxy 必须自己做

raw `prepare(sql).all(params)` 返回的是**SQLite 原生 row 形态**:
- 列名 snake_case(不是 drizzle 的 camelCase alias)
- 聚合列用 SQL 表达式做 key(如 `count(messages.id)`、`MAX(...)`,而非 drizzle select 里给的 `messageCount` / `lastSessionAt` 别名)
- 嵌套 select(`{session: sessions, messageCount: count(...)}`)的"session 子对象"不会自动构建

**根因**:drizzle 的 row mapping 发生在 `BetterSQLite3Database` driver 层,它内部知道 select shape 跟 SQL 列的对应。我们把 build/execute 拆开后,execute 拿到的只是 raw row,**mapping 元数据没传过来**。

**这条不阻塞 SPIKE-3 PASS**(本来就只验"数据等价",不验"对象形态等价"),但**强制 MR2 设计要把 mapping 收口**:

- **选项 A(推荐)**:drizzle proxy 内部除 `.toSQL()` 外还存一份"select shape → row mapper"的元数据(drizzle 内部有 `selectedFields` 之类的 metadata,可以读出来),execute 完用它把 raw row 映射回 drizzle shape。这是 drizzle 自己 in-proc 的做法,我们复用其映射逻辑。
- **选项 B**:每条 query 调用方手动 map(就是 SPIKE-3 test 文件里的写法)。这条改造面巨大(几百个 query 全要重写),**明确不推荐**。
- **选项 C**:select shape 上加 `AS` alias 把 mapping 信息塞进 SQL 自己。需要改 drizzle 的 SQL 生成路径,**风险高**。

MR2 必须做 A。MR1 切片文档"DbClient.drizzle 实现"部分要写清"drizzle proxy 至少要恢复列名 alias + 嵌套 select 重建"。

### Spike 工作量实绩

实际 0.5 天(预估 0.5-1 天),Worker(codex/gpt-5.5)完成。

---

## 已被排除的"看似不确定但不是问题"

记录下来避免回头又被当 spike 候选:

1. **`commitEmbeddings` Float32Array 跨 thread 性能** → `transferList` 真零拷贝 ArrayBuffer,128KB/批 × 5s/tick,微秒级。不需 spike。(详见 `-tx-migration.md` 洞察 1)
2. **embedding 子系统归属** → 已决路径 B(留 main),无需验证迁移可行性
3. **WAL crash recovery 兜底** → 业界一等公民(SQLite 官方 + codex desktop 同款),不需自己 spike
4. **better-sqlite3 同步 API 在 worker thread 是否会阻塞 main thread** → 不会,worker thread 各有自己的 isolate + event loop。这正是方案要的效果。不需 spike
5. **utilityProcess + native 加载** → SPIKE-1 已 N/A,不走该路径(escape hatch 触发时才验)
6. **TS migration require 在子进程** → SPIKE-2 已 N/A,worker thread 共享 main module resolution
7. **packaged double-platform worker_threads 行为** → 降级为 release smoke(详见上方 SPIKE-0 PASS 节)

---

## 一句话总结

**SPIKE-0 PASS + SPIKE-1/2 N/A + SPIKE-3 PASS → 所有 spike 不确定性消除,走 worker_threads 路径无技术性硬阻塞。MR1 可立即推进。** MR2 设计必须吸收 SPIKE-3 的 row mapping 发现(drizzle proxy 复用 drizzle 内部 selectedFields 元数据做映射,详见 SPIKE-3 节选项 A)。
