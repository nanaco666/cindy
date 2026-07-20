# 跨 profile history reader — 调研报告

> **状态**:调研,未实现。本文档作为后续实现的依据。
>
> **背景**:multi-worker Phase 1 在 `f5931be8` + `aa2f68d9` 引入了 dev-only userData 隔离(stable `xdt-maker.exe` 用 `%APPDATA%/xdt-maker`,dev `electron.exe` 用 `%APPDATA%/xdt-maker-dev`),代价是 stable 这一侧的 lead agent 看不到 dev 里跑的 session / chat history,做不到"dev 跑实验、stable 监督"的工作流。

## 问题

`cindy_helper` MCP 的三个 history 工具(`list_workdirs` / `list_sessions` / `get_chat_history`)只能读**当前进程 profile** 的 DB。host 注入的 reader 在 `apps/desktop/src/main/localDb/chatHistoryReader.ts` 直接调 `getDrizzle()`,绑死了 stable 自己的 singleton。

## 推荐方案

给三个 history 工具加 `profile` 参数(枚举白名单 `current` / `dev`,**不暴露任意 `dbPath` 给 LLM**),host 白名单路由到对应 profile 的 readonly DB。

### 路径与连接

- dev DB 路径:`%APPDATA%/xdt-maker-dev/xdt-maker-<userId>.db`(stable 是 `xdt-maker/xdt-maker-<userId>.db`,见 `apps/desktop/src/main/localDb/index.ts:64-65`)
- 多账号:dev 目录可能有多个 `xdt-maker-*.db`,默认取最新一个,或让 LLM 可选指定 userId
- 打开方式:`new Database(path, { readonly: true, fileMustExist: true })` + `PRAGMA query_only=ON` + `busy_timeout`
- WAL 跨进程只读已有先例:`codex-local-sessions.ts:1202-1205`、`scripts/dev-embed-search.mjs:17-18` 注释明确并发只读安全

## 改动清单(5 处)

1. `packages/lizi-mcps/src/xdt-helper/_history_types.ts` — deps 加 profile 维度(reader 接收 profile 参数,host 实现路由)
2. `list_workdirs.ts` / `list_sessions.ts` / `get_chat_history.ts` — schema 加 `profile?: 'current' | 'dev'`(默认 `current`,向后兼容)
3. `apps/desktop/src/main/localDb/chatHistoryReader.ts` — 解耦,从硬绑 `getDrizzle()` 改成接受 Drizzle handle / DB path 入参
4. `apps/desktop/src/main/mcp-integrations/mcp-providers.ts:83-99` — 注册 host 时为每个 profile 准备 reader
5. dev DB 发现逻辑(新)— 扫 `%APPDATA%/xdt-maker-dev/` 找 `xdt-maker-*.db`,缓存路径,handle 失效后重开

## 边界 / 注意

- **不实现** `search_chat_history` 跨 profile:它耦合 `getRawDb()` + `getEmbeddingService()`,改造代价高,后置
- `SQLITE_BUSY` 要做一次退避重试(dev 在 WAL checkpoint 时可能短暂锁)
- schema 版本不一致(dev 跑了新 migration,stable 还没升)— reader 读到的 schema 可能跟 stable 不同,首版**只读 stable schema 已有的列**,新列降级为 `null`
- **白名单严格**:不接受任意 `dbPath`,只接受枚举 profile;dev 不存在(没装/没启过)时返回明确错误而不是空列表
- 写入永远不暴露,只读

## 已排除的方案

| 方案 | 为什么排除 |
|---|---|
| 现有工具原样使用 | host 注入的 reader 硬绑 `getDrizzle()`,改不动 |
| 临时脚本直接 readonly 读 | 绕过 MCP contract / 权限 / 分页,只适合 smoke |
| copy dev DB 再读 | WAL 模式下裸 copy 不可靠(漏已提交 WAL 写入,源码 `backup.ts:25-30` 已说明) |
| watch `*.db-wal` 触发 | 不是语义事件,只能当二级触发器,核心仍要读 DB |
| dev 双写 JSONL 镜像 | 要改 dev 写路径,引入双写一致性 / 隐私 / 清理问题 |
| cross-process IPC / 端口 | 本次边界排除(不开端口、不引入依赖) |

## 已有的相似先例(可参考)

- `apps/desktop/src/main/maker-host/codex-local-sessions.ts:82-92, 1202-1205` — 外部 Codex SQLite 只读扫描,readonly + busy_timeout
- `apps/desktop/src/main/localDb/ipc/session-import.ts:1-5, 65-70` — 外部 agent 历史 import(只读 scan + 用户确认写入)
- `scripts/dev-embed-search.mjs:135-166, 247` — `--db` 参数指定 DB 路径(产品化时要从 `readonly: false` 改成 `true`)

## 不在范围

- multi-worker Phase 1 的 MR(本 doc 只是 follow-up 设计,实现走独立分支独立 MR)
- 跨 profile 写入(永远不做)
- 任意 dbPath 暴露给 LLM(永远不做)
- search_chat_history 跨 profile(后置)
