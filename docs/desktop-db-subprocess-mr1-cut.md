# MR1 切片设计 — DbClient 骨架 + worker thread 启动 + 实现无关层

> 配套:`desktop-db-subprocess.md`(主方案,2026-06 决策走 worker_threads)、`-mr0-spike.md`(SPIKE-0 PASS / SPIKE-3 待验)、`-tx-migration.md`、`-callsites.md`。
> **本 MR1 的目的**:把"db worker thread + DbClient 实现无关层"骨架立起来,跟现有 `getRawDb()` / `getDrizzle()` **并存无冲突**,验证端到端 RPC 跑通。**不触动任何现有 IPC handler、不动 `localDb/` 实现**。
>
> 业务搬迁、158 调用点改造、10 个事务搬迁全部留 MR2。MR1 只关心**接口形状对、escape hatch 可用、SPIKE-3 验通**。

---

## MR1 边界(只做这些,不做更多)

| 做 | 不做 |
|---|---|
| 新建 `localDb/client/` + `localDb/worker/` 两套目录(实现无关 + worker 入口) | 不改 `localDb/index.ts` 现有 `getRawDb` / `getDrizzle` / `ensureReady` 等导出 |
| `DbClient` 接口 + `DbTransport` 抽象 + 工厂 + `WorkerThreadTransport` 完整实现 | 不动任何 IPC handler |
| `UtilityProcessTransport` stub(只占接口形状) | 不动 158 个 db 调用点 |
| db worker thread 入口 + RPC dispatcher,绑到真 better-sqlite3(用 `:memory:` 起步) | 不搬业务 db 逻辑 |
| 端到端 smoke:`query` / `exec` / `tx` 三个 op 跑通 | 不接真 db 文件(`xdt-maker-{userId}.db` 留 MR2) |
| 集成 main lifecycle:`onQuit` 走 `client.dispose()` | 不接 migration / schema drift / sqlite-vec(留 MR2,因为依赖真 db 文件) |
| **SPIKE-3 跑完**(drizzle build/execute 拆分 PoC,vitest) | 不上线 — 此时 `DbClient` 与 `getRawDb` 并存,默认仍走 `getRawDb`,新 client 只在 smoke test 路径里启 |
| 单测:client ↔ worker 双向 message、worker 崩了 client 兜底、escape hatch transport 切换 | 不删 `__spike__/` 目录(留作回归 baseline,MR1 PR 末尾再删) |
| ESLint 规则:`localDb/` 之外禁止 import `worker_threads` / `electron.utilityProcess` | 不改 forge config(worker_threads 不需要) |

---

## 文件清单

```
apps/desktop/src/main/localDb/
├── index.ts                          # 现有,不动
├── client/                           # 新增:实现无关层
│   ├── DbClient.ts                   # 接口 + 工厂 createDbClient()
│   ├── DbTransport.ts                # transport 抽象 + 协议类型
│   ├── WorkerThreadTransport.ts      # 默认实现:node:worker_threads
│   ├── UtilityProcessTransport.ts    # escape hatch stub(throw "not implemented")
│   ├── DbErrorBoundary.ts            # main 进程级 RPC error catch + 单次重启策略
│   └── __tests__/
│       ├── DbClient.test.ts          # 单测:接口形状 / 工厂选 transport / dispose
│       ├── WorkerThreadTransport.test.ts  # 单测:双向 message / 崩溃兜底 / 重启
│       └── escapeHatch.test.ts       # 单测:切 UtilityProcessTransport 接口不变
└── worker/                           # 新增:worker thread 入口
    ├── index.ts                      # entry: 接 parentPort,启动 RPC dispatcher
    ├── dispatcher.ts                 # op → handler 路由(query/exec/tx 起步)
    ├── opHandlers/                   # 每个 op 一个 handler 文件(MR2 继续填)
    │   ├── query.ts
    │   ├── exec.ts
    │   └── tx.ts                     # MR1 只放 placeholder,10 个具名事务 MR2 落
    └── __tests__/
        └── dispatcher.test.ts        # 单测:op 路由 / 错误回传
```

**为什么不分顶级目录(`apps/desktop/src/dbWorker/`)**:worker thread 跟 main 共享同一 V8 process,共享 module resolution,放在 `localDb/` 下子目录最自然,也跟"db 在 main 进程内的独立线程"的实际拓扑对齐。

---

## DbClient 接口(MR1 落地版)

```ts
// apps/desktop/src/main/localDb/client/DbClient.ts

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../schema';

/**
 * 实现无关 db 客户端接口。
 * 调用方只 import 这个,不知道底层是 worker thread 还是 utility process。
 *
 * 核心约束:`localDb/` 之外任何文件禁止 import worker_threads / utilityProcess
 * (CI lint 规则把关)。escape hatch:切换 transport 时调用方代码 0 改动。
 */
export interface DbClient {
  /** 一次性查询 */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined>;
  exec(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>;

  /**
   * 具名事务 — 10 个边界事务统一走这个口(详见 -tx-migration.md)。
   * MR1 只放协议骨架,实际事务 handler 在 MR2 逐个落地。
   */
  tx<R = unknown>(name: string, args: unknown): Promise<R>;

  /**
   * drizzle proxy — MR1 末尾 SPIKE-3 通过后,这里返回拆分后的 proxy。
   * SPIKE-3 失败的话,这条要 throw "not supported",所有 drizzle 调用要改 raw SQL。
   */
  drizzle: BetterSQLite3Database<typeof schema>;

  /** 切账号:graceful close 当前 db,重新 ensureReady(newUserId) */
  closeForUserSwitch(userId: string): Promise<void>;

  /** 退出 */
  dispose(): Promise<void>;
}

export type DbTransportKind = 'worker-thread' | 'utility-process';

/**
 * 工厂:默认 worker-thread,可选 utility-process(escape hatch)。
 * 通过 env var `XDT_DB_TRANSPORT=utility-process` 切换,无需重 build。
 */
export function createDbClient(opts?: {
  transport?: DbTransportKind;
  userId?: string;
}): Promise<DbClient>;
```

---

## DbTransport 抽象

```ts
// apps/desktop/src/main/localDb/client/DbTransport.ts

/**
 * 底层 transport 抽象。WorkerThreadTransport / UtilityProcessTransport
 * 各实现一份,DbClient 内部通过它收发消息,不知道具体实现。
 */
export interface DbTransport {
  /** 发 RPC,等 response。失败 throw。 */
  send<R = unknown>(op: string, args: unknown, transferList?: Transferable[]): Promise<R>;

  /** 接 worker push 事件(log / migration:progress / corrupt-recovered) */
  on(event: 'log', cb: (payload: LogEvent) => void): void;
  on(event: 'migration:progress', cb: (payload: MigrationProgressEvent) => void): void;
  on(event: 'corrupt-recovered', cb: (payload: CorruptRecoveredEvent) => void): void;

  /** worker 死了的回调(worker thread 崩 → main 也死,所以这条几乎不触发;但 utility process 模式必备) */
  onTerminated(cb: (info: { code: number | null; signal: string | null }) => void): void;

  close(): Promise<void>;
}

// 协议类型
export type RpcRequest = { id: number; op: string; args: unknown };
export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string; stack?: string } };

export type LogEvent = { level: 'info' | 'warn' | 'error'; scope: string; payload: unknown };
export type MigrationProgressEvent = { phase: string; current: number; total: number };
export type CorruptRecoveredEvent = { source: 'iso' | 'clean'; mtime: string };
```

---

## WorkerThreadTransport(MR1 完整实现)

要点:
- `new Worker(workerEntryPath)` 启动 db worker thread(vite 编译产物路径解析参考 spike 代码 inline `WORKER_CODE` 的做法,或单独抽 worker entry chunk)
- 用 `MessageChannel` 双向通信,main 持 `port1`,worker 持 `port2`
- RPC `id` 单调递增,Map 维护 pending promises;worker 回 response 时 resolve/reject
- 大 payload(Float32Array / FTS5 结果)通过 `transferList: [arrayBuffer]` 真零拷贝
- `worker.on('error')` / `worker.on('exit')` → 触发 `onTerminated` 回调
- `close()` await `client.dispose()` RPC 完成后 `worker.terminate()`

```ts
// apps/desktop/src/main/localDb/client/WorkerThreadTransport.ts (骨架)

import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { app } from 'electron';
import type { DbTransport, RpcRequest, RpcResponse } from './DbTransport';

export class WorkerThreadTransport implements DbTransport {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private eventListeners = new Map<string, Set<(payload: unknown) => void>>();
  private terminatedListeners = new Set<(info: { code: number | null; signal: string | null }) => void>();

  constructor(workerData: { userId: string }) {
    const workerPath = resolveWorkerEntryPath();
    this.worker = new Worker(workerPath, { workerData });

    this.worker.on('message', (msg: RpcResponse | { event: string; payload: unknown }) => {
      if ('id' in msg) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, stack: msg.error.stack }));
      } else {
        const listeners = this.eventListeners.get(msg.event);
        if (listeners) for (const cb of listeners) cb(msg.payload);
      }
    });

    this.worker.on('error', (err) => {
      // 所有 pending RPC reject;触发 onTerminated
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      for (const cb of this.terminatedListeners) cb({ code: null, signal: null });
    });

    this.worker.on('exit', (code) => {
      for (const cb of this.terminatedListeners) cb({ code, signal: null });
    });
  }

  send<R>(op: string, args: unknown, transferList?: Transferable[]): Promise<R> {
    const id = this.nextId++;
    const req: RpcRequest = { id, op, args };
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage(req, transferList ?? []);
    });
  }

  on(event: string, cb: (payload: unknown) => void): void {
    if (!this.eventListeners.has(event)) this.eventListeners.set(event, new Set());
    this.eventListeners.get(event)!.add(cb);
  }

  onTerminated(cb: (info: { code: number | null; signal: string | null }) => void): void {
    this.terminatedListeners.add(cb);
  }

  async close(): Promise<void> {
    try { await this.send('closeDb', undefined); } catch { /* worker may have exited */ }
    await this.worker.terminate();
  }
}

function resolveWorkerEntryPath(): string {
  // dev: __dirname = <repo>/apps/desktop/.vite/build → worker entry 跟 main 同 chunk
  // packaged: app.asar/.../index.js → 走 .vite/build/db-worker.js(vite chunk split)
  // 实现细节:配置 vite 把 worker entry 拆 chunk,或用 spike 同款 inline WORKER_CODE 字符串
  // MR1 阶段先用 inline 字符串(可工作),vite chunk split 优化留 MR2 或后续
  throw new Error('TODO: implement worker entry resolution (or use inline WORKER_CODE pattern)');
}
```

---

## Worker thread 入口(MR1 骨架)

```ts
// apps/desktop/src/main/localDb/worker/index.ts (骨架)

import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { dispatch } from './dispatcher';
import type { RpcRequest, RpcResponse } from '../client/DbTransport';

if (!parentPort) throw new Error('db worker must be spawned via worker_threads');

// MR1:用 :memory:,MR2 接真 db 文件
const db = new Database(':memory:');
// MR2 加:loadSqliteVec, runMigrations, schemaDriftDetector...

parentPort.on('message', async (req: RpcRequest) => {
  try {
    const result = await dispatch(req.op, req.args, db);
    parentPort!.postMessage({ id: req.id, ok: true, result } satisfies RpcResponse);
  } catch (err) {
    parentPort!.postMessage({
      id: req.id,
      ok: false,
      error: {
        code: (err as { code?: string }).code ?? 'WORKER_RPC_ERROR',
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
    } satisfies RpcResponse);
  }
});
```

---

## Dispatcher(MR1 三个 op + tx 占位)

```ts
// apps/desktop/src/main/localDb/worker/dispatcher.ts (骨架)

import type Database from 'better-sqlite3';

export async function dispatch(op: string, args: unknown, db: Database.Database): Promise<unknown> {
  switch (op) {
    case 'query': {
      const { sql, params } = args as { sql: string; params?: unknown[] };
      return db.prepare(sql).all(...(params ?? []));
    }
    case 'queryOne': {
      const { sql, params } = args as { sql: string; params?: unknown[] };
      return db.prepare(sql).get(...(params ?? []));
    }
    case 'exec': {
      const { sql, params } = args as { sql: string; params?: unknown[] };
      const info = db.prepare(sql).run(...(params ?? []));
      return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
    }
    case 'tx': {
      // MR1 占位:MR2 把 10 个具名事务 handler 接进来
      throw Object.assign(new Error('tx not implemented in MR1'), { code: 'NOT_IMPLEMENTED' });
    }
    case 'closeDb': {
      db.close();
      return;
    }
    default:
      throw Object.assign(new Error(`unknown op: ${op}`), { code: 'UNKNOWN_OP' });
  }
}
```

---

## DbErrorBoundary(main 进程级保护)

worker thread crash 会带挂 main(决策章节里说的代价)。MR1 加这层保证 db RPC 异常**绝不污染 main unhandledRejection 路径**:

```ts
// apps/desktop/src/main/localDb/client/DbErrorBoundary.ts (骨架)

export class DbErrorBoundary {
  private terminatedCount = 0;
  private readonly maxAutoRestart = 1;

  /** 所有 DbClient RPC 调用包一层,统一 catch,不让传到 main unhandledRejection */
  async wrap<T>(opName: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      log.error(JSON.stringify({ event: 'dbClient.rpcError', op: opName, error: ... }));
      throw err;  // 调用方仍能 catch,但 unhandledRejection 不会触发(因为我们 catch 了一次)
    }
  }

  /** worker 退出时调,决定要不要自动重启 */
  onWorkerTerminated(info: { code: number | null }): { shouldRestart: boolean } {
    this.terminatedCount++;
    return { shouldRestart: this.terminatedCount <= this.maxAutoRestart };
  }
}
```

---

## SPIKE-3 已 PASS(2026-06-04)— 对 MR1 实施的影响

详见 `-mr0-spike.md` SPIKE-3 节。结论:6 条试金石 query 全过,drizzle proxy 路径可行。两个发现影响 MR1 实施:

### 影响 1:vitest 必须 ELECTRON_RUN_AS_NODE=1 跑

`apps/desktop/node_modules/better-sqlite3` 经 `electron-rebuild` 编为 Electron NODE_MODULE_VERSION 145,plain Node(v24.x ABI 137)load 会 ABI mismatch。**MR1 所有用 better-sqlite3 的单测**(本切片下 `WorkerThreadTransport.test.ts` / `dispatcher.test.ts` / `drizzle-split.spike.test.ts` 都用)必须按下面跑:

```bash
# PowerShell
$env:ELECTRON_RUN_AS_NODE='1'; pnpm --filter desktop exec electron ../../node_modules/vitest/vitest.mjs run <pattern>

# bash / cmd
ELECTRON_RUN_AS_NODE=1 pnpm --filter desktop exec electron ../../node_modules/vitest/vitest.mjs run <pattern>
```

**MR1 工作项**:在 `apps/desktop/package.json` 加一个 `test:db` script 封装这条命令,作者写测试时只用这个 script,避免每次手敲 env。仓库根 README / CLAUDE.md 的 dev 段也加一行说明(MR1 同 PR 内做)。

### 影响 2:drizzle proxy 复用 drizzle 内部 row mapping(路径已验证)

raw `prepare(sql).all(params)` 返回 snake_case + 表达式 key,**不会自动得到 drizzle 的 camel alias / 嵌套对象形态**。MR2 改造所有 `db.select().from(...)` 调用前,**MR1 的 drizzle proxy 必须把 row mapping 收口好**,否则改造工作要给每个调用点手写 mapper(改造面巨增,不可接受)。

**lead 已 read drizzle 源码确认路径可走**(`node_modules/drizzle-orm/better-sqlite3/session.js` + `utils.js`),drizzle 内部把 mapping 拆成两个干净的 building block:

1. **`orderSelectedFields(config.fields)`** — 把 builder 的嵌套 fields obj 拍平成 `{path: string[], field}[]` 数组,知道每列对应哪个字段、要不要包成嵌套
2. **`mapResultRow(fieldsList, rowArray, joinsNotNullableMap)`** — 把 raw row(SQLite `stmt.raw()` 返回的 array,不是 obj!)+ fields metadata + joins 信息 → drizzle 期望的嵌套对象

两者都从 `drizzle-orm/utils.js` 公开 export(虽不在 docs 但 ts 类型可见)。drizzle 自己 in-proc `.all()` 用的就是这俩:

```ts
// node_modules/drizzle-orm/better-sqlite3/session.js:68-80 的核心逻辑
all() {
  const rows = stmt.raw().all(...params);                     // array-of-arrays
  return rows.map((row) => mapResultRow(fields, row, joinsNotNullableMap));
}
```

**drizzle proxy 实施 sketch**(MR1 直接照这个写):

```ts
// apps/desktop/src/main/localDb/client/drizzleProxy.ts (核心 ~30 行)
import { orderSelectedFields, mapResultRow } from 'drizzle-orm/utils.js';
import type { DbTransport } from './DbTransport';

/**
 * 给一个 drizzle SQLiteSelectBase 实例(builder 链末端),返回一个 awaitable
 * 的 Promise<mapped rows>。execute 阶段走 RPC,mapping 用 drizzle 内部函数复用。
 *
 * 关键不变量:调用方拿到的对象跟 in-proc drizzle 完全等价,MR2 改造调用方
 * 只需把 `const rows = drizzle.select()...` 改成 `const rows = await dbClient.drizzle.select()...`,
 * 不动 rows 后续用法。
 */
async function executeSelect<T>(builder: any, transport: DbTransport): Promise<T[]> {
  const { sql, params } = builder.toSQL();
  const fieldsList = orderSelectedFields(builder.config.fields);
  const joinsNotNullableMap = builder.joinsNotNullableMap;
  // worker 侧执行 stmt.raw().all(...params) 返回 array-of-arrays
  const rawRows = await transport.send<unknown[][]>('rawAll', { sql, params });
  return rawRows.map((row) => mapResultRow(fieldsList, row, joinsNotNullableMap) as T);
}

// .get() 路径:同上但用 'rawGet' op,worker 侧 stmt.raw().get(...params)
async function executeGet<T>(builder: any, transport: DbTransport): Promise<T | undefined> {
  const { sql, params } = builder.toSQL();
  const fieldsList = orderSelectedFields(builder.config.fields);
  const joinsNotNullableMap = builder.joinsNotNullableMap;
  const row = await transport.send<unknown[] | undefined>('rawGet', { sql, params });
  return row ? (mapResultRow(fieldsList, row, joinsNotNullableMap) as T) : undefined;
}

// .run() 路径(insert/update/delete/upsert):无 mapping,直接透传
async function executeRun(builder: any, transport: DbTransport) {
  const { sql, params } = builder.toSQL();
  return transport.send<{ changes: number; lastInsertRowid: number | bigint }>('run', { sql, params });
}
```

**worker 侧 dispatcher 加 3 个 op**(`apps/desktop/src/main/localDb/worker/opHandlers/`):
- `rawAll` → `db.prepare(sql).raw().all(...params)` (返回 array-of-arrays)
- `rawGet` → `db.prepare(sql).raw().get(...params)`(返回 array 或 undefined)
- `run` → `const info = db.prepare(sql).run(...params); return { changes: info.changes, lastInsertRowid: info.lastInsertRowid }`

**Proxy 入口**:`DbClient.drizzle` 不能简单返回 in-proc `drizzle()` 实例,因为它的 `.all()/.get()/.run()` 是同步的。两种实现思路:
- **(a)推荐**:`DbClient.drizzle` 返回原 `drizzle(stubDb, {schema})` builder(stubDb 是个永远不会真执行的占位),但 **proxy 通过 Proxy/Reflect 拦截 builder 末端的 `.all()/.get()/.run()`**,改成 async 调上面的 `executeXxx`。调用方写法跟 in-proc 一致 + 加 `await`
- (b)放弃复用 drizzle().builder,自己暴露 `dbClient.select().from()...` API。改造面更大,不推荐

实施 worker 在 MR1 跑通 (a) 后,改写 `drizzle-split.spike.test.ts`:测试逻辑改成"用 DbClient.drizzle 跑同一组 query,断言结果跟 in-proc drizzle 完全等价(**不再手动 map**)"作回归基线。SPIKE-3 test 现在的手动 mapping 逻辑是给"裸 .toSQL() 拆分"用的,DbClient.drizzle 实现完后那层手动 map 应该消失。

### 试金石测试文件已存在

`apps/desktop/src/main/localDb/__tests__/drizzle-split.spike.test.ts` 已落地(SPIKE-3 验证产物)。MR1 可保留作 drizzle proxy 实现的回归 baseline — drizzle proxy 实现完后,把这个 test 改成"通过 DbClient.drizzle 跑同一组 query,期望结果跟 in-proc drizzle 完全等价(不再手动 map)",成为 MR2 的回归基线。MR1 PR 里**保留**该文件,**不**跟 `__spike__/` 一起删。

---

## 单测覆盖(MR1 必须有)

| Test | 目的 |
|---|---|
| `DbClient.test.ts` | 接口形状 / 工厂选 transport / dispose 幂等 |
| `WorkerThreadTransport.test.ts` | 双向 message / pending Map 在 worker 崩时全 reject / transferList 零拷贝实测(测 Float32Array transfer 后 main 侧 buffer 是 detached) |
| `escapeHatch.test.ts` | 通过 `XDT_DB_TRANSPORT=utility-process` 创建 client,接口形状跟默认完全一致(stub transport 即可,验证接口分离干净) |
| `dispatcher.test.ts` | op 路由 / 错误回传含 code / 未知 op throw `UNKNOWN_OP` |
| `drizzle-split.spike.test.ts` | SPIKE-3 验收 |

---

## CI / Lint 规则(MR1 加入)

```js
// eslint 规则:apps/desktop/src/main/ 下,除 localDb/ 外禁止 import worker_threads / utilityProcess
{
  files: ['apps/desktop/src/main/!(localDb)/**/*.{ts,tsx}'],
  rules: {
    'no-restricted-imports': ['error', {
      paths: [
        { name: 'node:worker_threads', message: 'Use DbClient instead. Direct worker_threads breaks escape hatch.' },
        { name: 'worker_threads', message: 'Use DbClient instead.' },
      ],
      patterns: [
        // electron.utilityProcess 走 named import,需要单独规则
      ],
    }],
  },
}
```

理由:**escape hatch 的前提是调用方不知道 transport 实现细节**。lint 把关,防回归。

---

## 验收清单

MR1 PR 合并前必须满足:

- [ ] `DbClient` / `DbTransport` 接口完整,vitest 覆盖
- [ ] `WorkerThreadTransport` 完整实现,smoke 跑通 query/exec
- [ ] `UtilityProcessTransport` stub 接口形状跟 worker thread 实现一致(escape hatch 切换可编译)
- [ ] `DbErrorBoundary` wrap 所有 RPC 调用,worker crash 不传到 unhandledRejection
- [ ] 现有 `getRawDb()` / `getDrizzle()` 仍工作(`localDb/index.ts` 0 改动)
- [ ] ESLint 规则就位,`apps/desktop/src/main/` 之外的代码 import worker_threads 报错
- [x] **SPIKE-3 已 PASS**(2026-06-04,详见 `-mr0-spike.md` SPIKE-3 节)
- [ ] **drizzle proxy 实现复用 drizzle 内部 row mapping**(详见上方"影响 2");proxy 实现完后改写 `drizzle-split.spike.test.ts` 走 DbClient.drizzle 作回归基线
- [ ] **vitest 跑法**:加 `apps/desktop/package.json` 的 `test:db` script 封装 ELECTRON_RUN_AS_NODE=1;README/CLAUDE.md dev 段加说明
- [ ] 删 `apps/desktop/src/main/__spike__/` 目录 + `bootstrap-electron.ts` 里的 spike 触发分支(但 `drizzle-split.spike.test.ts` 保留作回归基线)
- [ ] MR Description 符合 CLAUDE.md MR 规范(feature 模板,改动范围、自测确认、cindy-updater 声明等)
- [ ] **typecheck + lint + 现有 test 全过**;`pnpm restart:desktop:remote` dev 启动正常

---

## MR1 工程量预估

| 项 | 估时 |
|---|---|
| DbClient + Transport 接口 + 实现 + 单测 | 1-1.5 天 |
| worker entry + dispatcher + 单测 | 0.5-1 天 |
| DbErrorBoundary + main 集成 | 0.5 天 |
| SPIKE-3 vitest + 6 条试金石 | 0.5-1 天 |
| ESLint 规则 + 调通 | 0.5 天 |
| dev 端到端 smoke + 删 spike 目录 + MR 写描述 | 0.5 天 |
| **小计** | **3.5-5 天** |

---

## 下一步(MR1 PR 准备阶段)

- 跟 owner 同步 MR1 范围 + workplan 拿绿灯
- 创建分支 `feat/db-worker-thread-skeleton`
- 按文件清单 + 验收 checklist 实现
- SPIKE-3 出结论后,MR1 PR 描述里附 SPIKE-3 报告
- 合并后 MR2 启动:158 调用点 + 10 事务搬迁(详见 `-callsites.md` / `-tx-migration.md`)
