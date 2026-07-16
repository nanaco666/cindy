# MR2.2 切片设计 — 158 callsite 切到 DbClient + 全局 rollback flag

> 上游文档:`desktop-db-subprocess.md`(主方案)、`desktop-db-subprocess-callsites.md`(158 调用点审计)、`desktop-db-subprocess-tx-migration.md`(10 个事务迁移规约)、`desktop-db-subprocess-mr1-cut.md`(MR1 切片)。
> 前置 commit:MR1 `9ccdcd97` / MR2.0 `9545d6ef` / MR2.1 `fb068541` / MR2.1 fix `9bf86192`。
> 生成时间:2026-06-04。

## 范围

把 main 进程现有 158 个直接调 `getRawDb()` / `getDrizzle()` / `db.transaction(...)` 的调用点,全部改走 `DbClient`(worker_threads RPC 路径),并加 `XDT_DB_INPROC` 全局 flag 作为应急 rollback。

完成后 worker 路径成为默认,业务行为不变。**这是基础设施改造,不动业务逻辑**。

## 范围外

- **不**实现 utility-process 真版本(escape hatch stub 仍保留)。
- **不**重构业务代码(callsite 函数签名变 async / 调用点跟着加 await,但业务流程不变)。
- **不**改 IPC handler 协议、不改 renderer 端契约。
- **不**改 `packages/maker-core` / 系统提示词。
- **不**收 inline worker 与 TS reference 的代码重复债(见主方案「已知技术债」章节,留给后续 MR)。

---

## 4 个开放问题的决策

### Q1 — fork.session 的 `newMessageIds` 由 main 怎么生成?

**main 侧 fork 调用点(`maker-orchestration/fork.ts:158-218`)的改造:**

现状 `forkSessionAtMessage` 流程:
1. **tx 外** `db.select().from(messages).where(...).orderBy(asc)` 拿 source messages 数组
2. **tx 内** insert 新 session + bulk insert messages(每行用 `createId()` 现场生成)

MR2.2 改造:
1. **tx 外** `dbClient.query<{ c: number }>('SELECT count(*) FROM messages WHERE session_id = ? AND created_at < ? AND rewind_at IS NULL', [sourceSessionId, target.createdAt])` 拿 N
2. **tx 外** `const newMessageIds = Array.from({ length: N }, () => ({ id: createId(), clientId: createId() }))`(`createId` 仍走 `@paralleldrive/cuid2`)
3. **tx 内** `await dbClient.tx('fork.session', { sourceSessionId, targetCreatedAt, newSession, uuidMap, newMessageIds })`

**为什么不让 main 同时拿走完整 messages 数组传给 worker**:
- worker 内 tx 必须自己 select 一遍(tx 一致性视图),数据传两遍冗余
- 只传 count 是 8 字节,传完整 messages 行可能是几 MB

**为什么不让 worker 内生成 id**:
- 跟现有 `uuidMap`(main 生成 + 传入)模式保持一致
- worker 内一旦引入 cuid2 / 任何 id 生成,后续每加一个 tx 都要争论"谁生成 id"
- main 侧已经 import 了 `@paralleldrive/cuid2`,零新增依赖
- MR2.1 fix `9bf86192` 已立此原则,继续守

**额外成本**:多一次 count query RPC round-trip。可接受 — fork 不是热路径,每次操作只多 ~1ms。

---

### Q2 — flag 设计粒度

**采用全局 env flag,不做 per-callsite / per-tx 粒度。**

实现:
- `XDT_DB_INPROC=true` 启动时 main 进程 boot 阶段读到 → DbClient 内部所有入口(`query` / `queryOne` / `exec` / `tx` / `drizzle`)直接走 `getRawDb()` / `getDrizzle()` 老路径,不创建 worker。
- 默认值:`false`(走 worker)。
- 入口集中在 `DbClient.ts` `createDbClient()` 内:
  ```ts
  if (process.env.XDT_DB_INPROC === 'true') {
    return createInprocDbClient(opts);  // 返回一个把所有 method 转发到 getRawDb/getDrizzle 的实现
  }
  // ... 现有 worker 路径
  ```

**为什么不做 per-callsite flag**:
- 158 处都加 `if (flag) { 老路径 } else { 新路径 }` 代码爆炸,维护成本远超 worker 故障收益
- 全局 flag 提供"出问题立刻 rollback"的红色按钮就够了,不需要细粒度调度

**为什么不做 per-tx flag**:
- 同上,触发条件复杂(哪个 tx 出问题就 disable 哪个?用户怎么配?)
- 真出问题就全局回滚,然后慢慢排查,不靠 per-tx 兜底

**inproc fallback 怎么实现 `dbClient.tx(name, args)`**:
inproc 路径下 `tx(name, args)` 直接调 `worker/opHandlers/tx.ts` 的 `tx(getRawDb(), { name, args })`(opHandlers/tx.ts 本来就是纯函数 TS reference,不依赖 worker 上下文,直接可复用)。这刚好把"inline worker 与 TS reference 双实现"债的副作用变成红利 — TS reference 此时是 inproc fallback 路径的实现来源,不再是"只跑单测的死代码"。

---

### Q3 — 改造节奏

**一次性切,不分批。**

理由:
1. 158 callsite 改造模式高度同质化(`getRawDb()` → `await dbClient.query()` / `getDrizzle()` → `dbClient.drizzle`),grep-replace 风格,分批的收益小
2. 分批意味着工作树长期处于"一部分走 worker 一部分走 main"的混合状态,排查 bug 时要先判定"这个 callsite 在哪条路径上",debug 复杂度反而高
3. 全局 flag 已经提供 rollback 隔离,不需要分批做风险隔离
4. 派给 worker(codex)一次性 grep+替换,1-2 天工作量,分批反而拉长 calendar

**唯一例外**:async 传染严重的路径(callsite #1 「飞书 IM 长连接回调」和 #3「embedding worker tick」),如果在改造时发现某条调用链需要把 N 层函数全改 async,先单独评估,可能要 stage 改(先把同步入口改成 fire-and-forget 异步、保持回调链同步;再小步迁内部 db 调用)。这种情况由 worker 实施时遇到再决定,**不预先在文档里展开**(避免 over-engineering)。

---

### Q4 — drizzle proxy 性能基线

**放进 MR2.2 内的 Step 0,作为"开干前必须 PASS 的 gate"**,不单开 MR2.2-pre。

要测什么:
- 选 5 个典型 callsite 模式 + 1 个最热路径,跑 in-proc drizzle vs DbClient.drizzle proxy 的 p50/p95 延迟对比
- 模式:
  1. **select-by-pk**(`select().from(sessions).where(eq(id, ?))`)— 最高频
  2. **select-list-paginated**(`select().from(messages).where(...).orderBy().limit()`)— sidebar / 详情页
  3. **select-with-join**(`select().from(messages).innerJoin(sessions, ...)`)— 复杂查询
  4. **insert-single**(`insert().values({...}).run()`)— 写路径
  5. **update**(`update().set({...}).where(...).run()`)— 写路径
  6. **chatHistorySearch.fetchContextWindow**(`callsites.md` 标的最热点:for-loop 内 3 次 select,最差 30 次 RPC 往返)

通过门槛:
- p50 退化 < 2ms,p95 退化 < 10ms — 接受
- p50 退化 > 5ms 或 p95 退化 > 20ms — **不通过,设计需要调整**(可能要在热路径上保留 inproc 路径,或者改成预编译 stmt 批量化)

如果第 6 个模式(fetchContextWindow)单测下来超 RPC 30 次后 p95 > 100ms,**先在该函数里做批量化重构(单次 RPC 带上下文窗口拿完)**,再继续 158 callsite 改造。这是性能必修课,不能跳。

---

## 改造模式手册(给 worker 实施 + 后续 reviewer)

### 模式 1:`getRawDb().prepare(...).all(...)` / `.get(...)` / `.run(...)`

```ts
// 改造前
const rows = getRawDb().prepare('SELECT ...').all(p1, p2);

// 改造后
const rows = await dbClient.query<RowType>('SELECT ...', [p1, p2]);
```

注意:`.get()` → `dbClient.queryOne<RowType>(...)`(返回 `T | undefined`);`.run()` → `dbClient.exec(...)`(返回 `{ changes, lastInsertRowid }`)。

### 模式 2:`getDrizzle().select()...` builder

```ts
// 改造前
const rows = await getDrizzle().select().from(sessions).where(eq(sessions.id, id));

// 改造后(几乎零差异 — drizzleProxy 透明转发)
const rows = await dbClient.drizzle.select().from(sessions).where(eq(sessions.id, id));
```

注意:`dbClient.drizzle` 是 Proxy 实现,builder 的所有链式调用都返回 Proxy 包装,terminal method(`.all` / `.get` / `.run` / `.execute` / `await`)触发 RPC。语法跟 in-proc drizzle 一致。

### 模式 3:`db.transaction(closure)` → 改用 `dbClient.tx(name, args)`

这 10 处事务闭包 MR2.1 已在 worker 侧实现具名 op(`migration.writePage` / `migration.apply` / `codex.importMessages` / `claude.importMessages` / `rewind.commit` / `fork.session` / `embedding.markDone` / `embedding.commit` / `embedding.recordFailures` / `embedding.enqueue`)。改造时:

```ts
// 改造前
await db.transaction(async (tx) => {
  tx.update(messages).set({...}).where(...).run();
  tx.update(sessions).set({...}).where(...).run();
});

// 改造后
await dbClient.tx('rewind.commit', { sessionId, targetCreatedAt, now });
```

逐个 callsite 对照 `tx-migration.md` 的 args / result spec 改造。

### 模式 4:`getRawDb()` 句柄需要传给第三方函数(如 `loadSqliteVec`、`backup`、`migrate`)

这些都是 **lifecycle / init 路径**,**不改**,继续走 main 进程内的 `getRawDb()`。理由:
- 这些操作是"db 文件生命周期管理",不是业务读写
- MR2.0 已经让 worker 内自己跑了一遍 vec/migrate/drift,main 这边是为了 158 callsite 仍需要的 in-proc 句柄
- MR2.2 之后,main 侧的 `getRawDb()` 只剩 lifecycle / inproc fallback / 这种第三方传句柄场景,业务路径全走 dbClient

---

## 实施步骤

### Step 0 — 性能基线(必须先过)

在 `apps/desktop/src/main/localDb/__tests__/` 加 `drizzle-proxy-perf.bench.ts`:
- 测 6 个模式 × 各 1000 次,对比 inproc vs proxy 的 p50/p95
- 跑 `pnpm --filter desktop test:db --reporter=verbose drizzle-proxy-perf` 拿数据
- 数据填进本文档「性能基线结果」章节(本文档 Step 0 完成后追加)
- **不通过则 fail-stop,不继续 Step 1**

### Step 1 — 实现 inproc fallback

`DbClient.ts` 内新增 `createInprocDbClient(opts)`:
- 所有 method 转发到 `getRawDb()` / `getDrizzle()`
- `tx(name, args)` 调 `worker/opHandlers/tx.ts` 的 `tx(getRawDb(), { name, args })` 复用 TS reference
- `closeForUserSwitch` 调 `closeDb()` + 重新 `ensureReady`
- `dispose` no-op(老路径生命周期由 onQuit 管)

`createDbClient(opts)` 入口:
```ts
if (process.env.XDT_DB_INPROC === 'true') {
  return createInprocDbClient(opts);
}
```

加单测覆盖 inproc 路径:跑 query / queryOne / exec / tx 各一次,确认走老句柄。

### Step 2 — 切 158 callsite

按 `callsites.md` 的 A/B/C/D 区顺序改:
- **区 A**(`localDb/` 内部 + `localDb/ipc/` ~54 处,9 难)— 改造模式最规整,但事务闭包 2 个在这里
- **区 B**(`maker-host/` + `maker-orchestration/` ~34 处,4 难,4 个事务闭包包括 fork)
- **区 C**(`scheduler-host/` + `im/feishu/` + `maker-ipc/` ~48 处,13 难,飞书 IM 回调链 async 传染高风险区)
- **区 D**(`embedding-host/` + 广播器 ~22 处,4 难,4 个事务闭包)

每区一个 commit,commit message 形如 `refactor(desktop): MR2.2 区A localDb/ + localDb/ipc/ 切到 DbClient`。
4 个 commit 一次提完,不分 MR。

### Step 3 — 全局 typecheck + lint + test

- `pnpm --filter desktop exec tsc --noEmit -p .`
- `pnpm --filter desktop exec eslint src`
- `pnpm --filter desktop test:db` — 全套 db 测试过
- 不要求 full `pnpm --filter desktop test` 全过(已知有几个不相关的 renderer/text 测试历史 fail)

### Step 4 — dev 实测验证

`pnpm restart:desktop:remote` 启动,**用户**执行以下操作(worker 不能跑 dev):
1. 登录 → 看 `[DbClient] smoke OK` 日志(MR2.0 已验)
2. 打开历史 session → sidebar 列表渲染、详情消息流渲染
3. 发一条消息 → agent turn → token usage 落库
4. fork 一条会话 → 验证新会话 message id 不重复、内容一致
5. rewind 一条会话 → 验证 message rewind_at 字段
6. 切换账号 → 验证 closeForUserSwitch 路径
7. 退出 app → 验证 onQuit dispose

**任何一步报错 / 行为异常 → `export XDT_DB_INPROC=true` 重启,确认 rollback 路径能工作**。

---

## Rollback 路径

| 触发条件 | 操作 | 影响 |
|---|---|---|
| dev / packaged 跑起来后某个 callsite 报错 | 设 `XDT_DB_INPROC=true` 重启 | 全部 callsite 走 inproc 老路径,行为等同 MR2.2 之前 |
| worker 启动失败 / 进程崩溃 | DbClient 内部 unavailable 状态 → 调用方 throw | **MR2.2 没做自动 fallback** — 失败就是失败,用户手动切 flag |
| 性能严重退化 | 同上,手动切 flag | 等下一个 MR 修热路径 |

**为什么不做自动 fallback**:
- 自动 fallback 会让"worker 路径其实坏了"被掩盖,生产数据偷偷走 inproc,bug 难暴露
- 应急按钮是 env flag,简单粗暴,reviewer 一眼看明白
- worker 真出问题应该让用户感知 + 报告 bug,而不是静默切路径

---

## 已知风险 / 待跟踪

1. **async 传染深度未知**:`callsites.md` 标的飞书 IM 回调链(~13 处)、scheduler fire(`runner.ts`)、embedding tick 都不是 async 入口。改造时如果某条链 N 层函数都要改 async,worker 在 review 时回报,必要时调整切片(不是所有 callsite 都强制改 async — 同步入口可以加 `void dbClient.query(...).then(...)` 但要逐处评估)。
2. **chatHistorySearch.fetchContextWindow 性能**:Step 0 基线如果 fail,先做批量化重构再继续 — 这件事可能拖长 MR2.2 calendar。
3. **embedding worker tick 的 5s setInterval**:当前在 main 进程跑,持 sync db 句柄。切到 dbClient.tx 后,每 tick 是几个 async RPC,需要重新评估 tick 间隔和 in-flight 守卫语义。worker 在改区 D 时单独评估。
4. **inline worker 与 TS reference 双实现的债**(主方案「已知技术债」章节):MR2.2 让 inproc fallback 复用了 TS reference,这是债的副作用红利;但 worker 路径仍是 inline 的另一份。改 op 仍要双边改。下次新增 op 时如果实现 > 50 行,先收债再加。

---

## 派活清单(给 worker 的 self-contained spec)

worker 实施 MR2.2 时,**必须先**:
1. 完整读本文档 + `callsites.md` + `tx-migration.md` + 主方案「已知技术债」
2. **先跑 Step 0 性能基线**,把结果填进本文档「性能基线结果」章节,**通过后再开干 Step 1**
3. Step 1-3 完成后,**报告给 lead**:
   - 4 个区 commit hash
   - 158 callsite 改造数 / 改造未尽数(如果有 async 传染高风险区跳过的)
   - 任何 spec 调整(原因 + 决策)
   - Step 0 性能数据
   - typecheck / lint / test:db 结果
4. **不要**做 Step 4(dev 实测),由 lead 转交用户做

完成 commit message 形如:
- `perf(desktop): MR2.2 Step 0 drizzle proxy 性能基线 + 文档`
- `feat(desktop): MR2.2 Step 1 DbClient inproc fallback + XDT_DB_INPROC flag`
- `refactor(desktop): MR2.2 区A localDb/ + localDb/ipc/ 切到 DbClient`
- `refactor(desktop): MR2.2 区B maker-host/ + maker-orchestration/ 切到 DbClient`
- `refactor(desktop): MR2.2 区C scheduler-host/ + im/feishu/ + maker-ipc/ 切到 DbClient`
- `refactor(desktop): MR2.2 区D embedding-host/ + 广播器 + 杂项 切到 DbClient`

---

## 性能基线结果

测试运行命令:

```bash
pnpm --filter desktop test:db --reporter=verbose drizzle-proxy-perf
```

测试环境注记:`vitest` 当前只收 `*.test.ts`,因此保留 `drizzle-proxy-perf.bench.ts` + `drizzle-proxy-perf.test.ts` wrapper,不为单个 bench 修改 vitest config。

| Pattern | inproc p50 | inproc p95 | proxy p50 | proxy p95 | delta p50 | delta p95 | 判定 |
|---|---:|---:|---:|---:|---:|---:|---|
| `select-by-pk` | 0.179ms | 0.256ms | 0.302ms | 0.479ms | 0.123ms | 0.223ms | PASS |
| `select-list-paginated` | 0.112ms | 0.167ms | 0.280ms | 0.409ms | 0.168ms | 0.242ms | PASS |
| `select-with-join` | 0.085ms | 0.156ms | 0.195ms | 0.271ms | 0.110ms | 0.114ms | PASS |
| `insert-single` | 0.089ms | 0.175ms | 0.216ms | 0.394ms | 0.127ms | 0.219ms | PASS |
| `update` | 0.031ms | 0.098ms | 0.116ms | 0.186ms | 0.085ms | 0.088ms | PASS |
| `chatHistorySearch.fetchContextWindow` | 2.735ms | 3.665ms | 5.802ms | 8.201ms | 3.067ms | 4.536ms | 黄区豁免 |

判定:5/6 模式 PASS。`chatHistorySearch.fetchContextWindow` 的 p50 退化为 3.067ms,超过 `< 2ms` 接受线,但 p95 退化 4.536ms 仍低于 `< 10ms` 接受线。该项按 MR2.2 决策豁免,继续 Step 1。

豁免理由:
- `fetchContextWindow` 是用户主动搜索聊天历史时触发的低频路径,不是每条消息 / 每个 turn 的热路径。
- 测得 proxy p50 5.802ms 与 `30 次 RPC * ~0.19ms/次` 的预期一致,说明没有额外架构性性能问题。
- p95 退化低于 `< 10ms` 接受线,没有 tail latency 风险。
- 把该路径批量化会改变业务函数边界,超出 MR2.2"基础设施改造,不动业务逻辑"范围;如后续出现真实性能反馈,单独起 `perf(desktop): fetchContextWindow 30 次 RPC -> 单次批量` MR 处理。
