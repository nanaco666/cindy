---
id: packages--file-browser-core
type: module
covers:
  - packages/file-browser-core/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-06T06:45:14.357Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# packages--file-browser-core

## 是什么

`@lizi/file-browser-core`（`packages/file-browser-core/`）是 workdir 文件浏览的共享核心实现：单层目录扫描 / 文件读写 / ignore 匹配 / 全项目文件名清单 / ripgrep 内容搜索。同一份代码同时跑在两种宿主里：desktop main 的 file-browser IPC LocalBackend（`apps/desktop/src/main/file-browser/`），以及远端 `packages/remote-file-service` daemon（SSH remote 会话执行端，esbuild 打包后跑在 `~/.xdt-server/v1/node/` 的 bundled Node 上）。因此本包被硬性要求：零 Electron 依赖、零原生模块依赖（prebuilt `.node` 进不了 daemon bundle），所有宿主差异（logger、rgPath、窗口生命周期）由调用方注入。`eslint.config.mjs` 用 `no-restricted-imports` 强制禁止 import `electron*` 和 `@parcel/watcher*`。

## 关键抽象 / 核心代码地标

- `src/scanner.ts` — 单层（非递归）目录扫描 + 文件 CRUD。实测 Unity workdir 全量递归扫描要 4 秒 / 698k 条目，单层 `readdir` 只要 0.1–12ms，所以文件树采用 lazy per-folder 展开而非一次性递归。
  - `assertInsideWorkdir` / `assertRealPathInsideWorkdir` / `assertRealParentInsideWorkdir`：三层路径越界防护，前者做字符串层 traversal 检查，后两者对 resolved realpath 做 symlink 越界检查（防 workdir 内符号链接指到 workdir 外）。所有对外 API 的路径安全都收敛在这三个函数。
  - `listDir(workdir, relPath, matcher, opts)`：单层列目录，过滤走传入的 `Matcher`，过滤掉 `.xdt-tmp` 原子写中间产物；`docMode` 选项通过 `hasDocDescendant` 递归探测子目录是否含 doc 类文件（并行 walk + 共享 `Found` 单元格短路）。
  - `readFile` / `writeFile`：`MAX_FILE_BYTES = 2MiB` 截断上限；二进制检测靠"前 4KB 是否含 NULL 字节"；`writeFile` 走 `${target}.xdt-tmp` → fsync → rename 的原子写模式，且要求目标文件已存在（无 save-as 语义）。
  - `readFileChunk`：任意大小文件的分片读，不截断不做二进制检测（服务"完整拉回本地缓存"传输管线）；内部用循环读满防止 `fs.read` 短读导致尾部补零静默损坏数据。
  - `createFile` / `createFolder` / `renameEntry` / `deleteEntry` / `statEntry`：其余文件树 CRUD，`renameEntry` 特殊处理大小写仅改写（case-insensitive 文件系统上 `access` 会误报"已存在"）。
  - `XDT_TMP_SUFFIX = '.xdt-tmp'`：原子写临时后缀，`listDir` 与桌面端 `watcher.ts` 都必须过滤它，否则渲染层会闪现 ghost row。
- `src/ignore.ts` — `loadIgnoreMatcher(workdir, opts)` 返回 `Matcher.ignores(relPath, isDir)`。规则来源：workdir 内 `.gitignore`（优先）或 `.p4ignore`（Perforce 项目 fallback）叠加 `BUILTIN_IGNORE`（VCS / 包管理器 / IDE 缓存 / OS 垃圾 / Unity 构建产物等常青黑名单，来自真实 Unity 698k 条目 benchmark）。`hideMetaFiles` 选项额外过滤 `*.meta`（Unity 元数据，默认隐藏，砍掉约 47% 典型条目）。按 `(workdir, hideMetaFiles)` 缓存 + `inflight` Map 去重并发构建请求；缓存新鲜度靠源文件 mtime 校验，并额外处理"更高优先级 ignore 文件后出现"的升级场景。`buildMatcher` 内的 stat-read-stat 三次重试是为了避开并发写导致的 (旧内容+新mtime) 错配。
- `src/listAllFiles.ts` — 全项目文件名清单（用于 fuzzy filter 的内存索引，非文件树本身）。两个实现：
  - `listAllFiles`：spawn ripgrep `--files`（honor `.gitignore` / `.ignore` / `.rgignore`，不含 `BUILTIN_IGNORE`），一次性收集、不流式吐，命中 `LIST_ALL_FILES_CAP = 30000` 立即 kill rg 并标记 `truncated`。
  - `listAllFilesWalk`：无 rg 时的纯 JS fallback，复用 `loadIgnoreMatcher`（`hideMetaFiles: false`），语义是"与文件树所见一致"而非"与 rg 一致"（两者过滤集合有意不同，见文件内注释）。跳过符号链接，不可读目录静默跳过。
- `src/search/RipgrepSearcher.ts` — 包装 rg 子进程的 `EventEmitter` 纯类，`-F` fixed-string、`--json` NDJSON 逐行 parse、`TEXT_FILE_GLOB_ARGS`（从 `textFileExts.ts` 派生）限定只搜文本文件、全局 `maxMatches` 上限触发主动 kill + `end({truncated:true})`。单实例可并发管理多个 `searchId`。取消 = SIGTERM + 200ms 兜底 SIGKILL（`KILL_GRACE_MS`，与 `listAllFiles.ts` 同款 kill 模式）。
- `src/search/types.ts` — `SearchQuery` / `SearchMatch` / `SearchEnd` / `SearchError` / `SearchEvent` union，跨 IPC / daemon RPC 边界的搜索事件契约。
- `src/textFileExts.ts` — `SUPPORTED_TEXT_EXTS` / `COMPOUND_EXTS` / `KNOWN_TEXT_FILENAMES`：文本文件扩展名白名单，同时驱动 `RipgrepSearcher` 的搜索范围和（桌面端消费方）附件类型判断。
- `src/logging.ts` — `setFileBrowserCoreLoggerFactory` / `scopedLogger`：日志完全由宿主注入，未注入前静默 noop（这个包里没有"错过就无法诊断"级别的日志）；`scopedLogger` 返回的代理惰性解析当前 factory，模块顶层 `const log = scopedLogger(...)` 声明顺序与注入时机无关。
- `src/index.ts` — 唯一对外入口，`package.json` 的 `exports` 只暴露 `.`（全量）和 `./textFileExts`（子路径，供 renderer 端单独引用扩展名白名单而不拉全量 Node API 依赖）。

## 模块边界

- 不依赖：Electron、任何原生模块（含 `@parcel/watcher`）、IPC 框架。只用 Node 内置模块（`node:fs` / `node:path` / `node:child_process` / `node:readline` / `node:events` / `node:crypto`）+ 一个纯 JS 依赖 `ignore`。
- 被依赖：`apps/desktop/src/main/file-browser/*`（LocalBackend：`index.ts` / `device-op.ts` / `search/index.ts` / `watcher.ts`）和 `packages/remote-file-service/src/{protocol,server,watch}.ts`（daemon 端）。两边各自实现 watcher（本包不提供 watch 能力，只共享事件形状约定）、各自注入 logger factory 和 `rgPath`。
- 对外接口形态：纯函数 + 一个类（`RipgrepSearcher`），无状态单例、无全局副作用（`ignore.ts` 的 cache/inflight Map 是模块级但仅按 workdir 分区，测试用 `__clearCacheForTesting` 复位）。所有路径 API 用 workdir-relative POSIX 字符串，绝对路径不出这个模块（除 `SearchQuery.workdir` 本身是绝对路径输入）。

## 不要做的事

- 不要在这个包里 `import electron` 或任何原生 addon —— eslint 规则会拦，且会让 daemon bundle 直接炸。
- 不要绕过 `assertInsideWorkdir` / `assertRealPathInsideWorkdir` 自己拼路径做文件操作 —— 会重新打开 workdir 越界（含 symlink 越界）的安全口子。
- 不要给 `listDir` 改成递归全量扫描 —— 单层 lazy 扫描是刻意的性能设计（见 scanner.ts 顶部实测数据），递归会在大型 Unity/monorepo workdir 上重新引入秒级卡顿。
- 不要绕过 `XDT_TMP_SUFFIX` 过滤直接把 `.xdt-tmp` 文件暴露给调用方 —— 会在渲染层产生一闪而过的 ghost row。
- 不要在 `writeFile` 里放开"文件不存在也创建"的语义 —— 这是 read-then-edit 场景的设计约束，不是遗漏。
- 不要给这个包自己接日志实现（`console.log` 或直接 import 具体 logger）—— 必须走 `logging.ts` 的注入机制，否则两个宿主之一会崩（daemon 的 stdout 被 NDJSON RPC 独占，误用 console.log 会污染协议流）。
- 修改 `SUPPORTED_TEXT_EXTS` 时要同时想清楚对 `RipgrepSearcher` 搜索范围和桌面端附件类型判断（`apps/desktop/src/shared/textFileExts.ts`，消费方）两侧的影响，别只看单侧诉求。
- 不要给 `listAllFiles`（rg 版）和 `listAllFilesWalk`（JS fallback）强行对齐过滤语义 —— 两者刻意不同（前者贴近 rg/.gitignore 生态，后者贴近文件树可见集合），改动前确认没理解反。

## 演进备忘

_仅追加。每次重大改动留一行：日期 - 做了什么 - 原因。_
