# Cindy 新仓库工作清单

> 状态:待新仓库创建后执行(2026-07-14 整理)。本文是新仓库侧工作的唯一清单——`repo-split-and-handover.md` §4 指向本文,不再另维护副本。前置阅读:[`migration-state-machine.md`](./migration-state-machine.md)(v3.1,B′ + Cindy 1.0 即新 auth server)、[`upgrade-launch-checklist.md`](./upgrade-launch-checklist.md)(发布流程与时序约束)。
>
> **创建方式前提**:以 fork/复制本仓库(XDMaker)方式创建,且**必须从 ≥ 收尾版钉版点的 main 切出/同步**(schema 视野不变量,upgrade-launch-checklist §1)。fork 后本仓库的六项双端契约冻结(repo-split §1)。

## A. 身份与构建配置

1. **`packages/maker-shared/src/brandIdentity.ts` 改主值并填 legacy**:
   - `displayName: 'Cindy'`、`executableName: 'cindy'`、`appId/bundleIdPrefix: 'com.magiclizi.cindy'`
   - `primaryScheme: 'cindy'`、`legacySchemes: ['xdt-maker']`(**双 scheme 永久注册**,老深链不断)
   - `userDataDirName: 'Cindy'`、`legacyUserDataDirNames: ['xdt-maker']`、`cdnPrefix: 'cindy'`
   - **`dbFilePrefix` 保持 `'xdt-maker'` 不动**时认领仍按 old uid → new uid 执行；若 1.0 改为 `cindy`,必须同时设 `legacyDbFilePrefixes: ['xdt-maker']`,让认领扫描旧前缀
2. **forge 配置**:executableName / appId / 双 scheme 注册 / mac UTI / NSIS DisplayName 前缀;**安装目录必须与老 app 不同**(win `%LOCALAPPDATA%\Programs\cindy`、mac `/Applications/Cindy.app`)——这是 B′"零文件冲突、老 app 进程内安装"的前提,装错目录整个方案不成立
3. 图标等品牌资源替换

## B. 被 XDMaker 唤起 + 首启迁移链路(fork 继承实现,需激活验证)

4. **`--migrated-from` / `--legacy-user-data` 参数链路实测**:`maybeRunCindyFirstRun` 已在 bootstrap ready 最前接好(fork 继承),但必须在**打包形态**下验证两种唤起路径 argv 完整到达 `parseMigratedLaunchArgs`:
   - win:NSIS 装出的 exe 被老 app 直接带参 spawn
   - mac:`open <app> --args --migrated-from=... --legacy-user-data=...` 间接传参
5. **首启健康检查全链路验证**:等老进程退出 → 自拷(无 sentinel 时 stale `journal=done` 也重拷)→ openDb 逐库 WAL checkpoint + quick_check 诊断(open/pragma/close 异常均隔离为告警)→ handoff 导入(mac)→ verifySafeStorage → sentinel/receipt/confirmed;首启未捕获异常必须退出、不能创建主窗口，receipt 后清理前崩溃则下次 Cindy 启动补删两侧 handoff；失败路径(failed → 自杀退回老 app → 重入 journal 重拷)同样要演练
6. **首启迁移 splash 进度 UI(新 UI 工作)**:拷贝分钟级时不能白屏,接 `runLegacyDataCopy` 的 `onProgress`;遵守 DESIGN.md 视觉规范
7. **延迟卸载执行验证**:`runDelayedUninstallCheck`(win QuietUninstallString / mac 限 `.app` 删除),7 天 + 3 次健康启动 + 老 marker==confirmed + 无老进程 + 首启捕获的旧可执行文件身份未变化；观察期内重装/覆盖原路径必须跳过

## C. 新 auth server + 老库认领(fork 继承实现,需激活验证)

8. **登录模块切新 auth server**:OAuth 流程、API base、`/me` 必须下发 email(认领锚,一致性由新 auth server 保证)
9. **首登认领流程**(状态机文档 v3.1 §5"confirmed 之后的首登与老库认领"):fork 已继承 `registerLocalDbIpc.beforeEnsureReady` → `claimLegacyLocalDbBeforeEnsureReady` 接线；新登录后读 `migration/identity-anchor.json`(随自拷带入)→ `findAnchorByIdentity` 排除新 UID,优先 email 唯一命中、零命中时回退 feishuOpenId → 唯一命中则用 SQLite online backup + quick_check + 同卷原子落位复制重绑老库，再进入 `ensureReady`；无命中 / 多命中安静走新用户分支、老库保留。复制/校验失败只告警并放行新库创建，避免锁死登录；**不回滚迁移**(数据已 confirmed)
10. **设置页手动认领入口**(兜底):列出本机存量 `xdt-maker-*.db`,用户自行指认导入
11. **server 侧 per-user 数据归零的反应盘点**:新 auth server 空库,登录续期凭证、chat-data-localization per-(userId, deviceId) 快照等全部 absent——逐处确认客户端按"从没见过你"处理是安全的
12. **升级公告**(migration-state-machine.md §9 五项用户可见项):必须重新登录一次、mac Dock 固定图标失效、mac TCC 权限重授权、win 控制面板双条目约一周、首启拷贝进度

## D. 发布链

13. **`/cindy/` CDN 前缀 + Cindy 自有 per-platform manifest**(后续热更渠道),版本从 `1.0.0` 起
14. **产出完整安装包**:win NSIS Setup.exe、mac .app zip × (arm64 / x64);**上传到老渠道(`/xdt-maker/`)前缀下**——老 app migration 块的 `file` 是相对老渠道 baseUrl 的路径,与 `/cindy/` 热更渠道是两回事
15. 向本仓库 migration 块注入脚本提供各包 sha256 / size

## 与本仓库(XDMaker 侧)的对接点

| 本仓库剩余工作 | 依赖 |
|---|---|
| migration 块注入/撤回脚本(per-platform、canary/stable、`--remove`) | D-14/15 的包与哈希 |
| 收尾版 failed 遥测轻上报(拍板项) | 无,越早越好 |
| copyExcludes / COPY_MUST_KEEP_PREFIXES 终审 | 钉版前对照真实 userData |
| 收尾版发布 + 钉版 | 无(可先行) |

发布时序与硬约束(钉版点 ⊑ Cindy 切出点、canary 先行、老 server 存活到迁移收敛)见 `upgrade-launch-checklist.md` §4 / §-1。
