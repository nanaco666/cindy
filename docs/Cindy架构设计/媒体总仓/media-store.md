# Cindy 媒体总仓(cindy-media)重构设计 —— 指纹制定稿

> 状态:设计定稿(2026-07-09 与 Lizi 多轮讨论定案;本版为指纹制终稿,取代早先的四层目录树草案)。
> 关联:意识供图(runtime-sandbox.md §5.5 主循环)是本总仓的第一个新客户,读写契约见 §5。

## 0. 为什么重构

实地盘点(2026-07,Lizi Windows 机实测)现状:

- 所有落盘媒体集中在 `userData/cc-agent/` 下,共 9 个在用仓 + 3 个死目录(`lizi-image-media` / `mivo-media` / `mivo`,约 40MB,现行代码零引用),合计约 880MB;
- **三套半重复实现**:`imageCacheStore` / `videoCacheStore` / `modelCacheStore` 互为 mirror(各自维护仓库表、安全解析、mime 表),`audioFileProtocol` 是第四种写法;每加一种媒体来源要动 store / 仓库表 / 协议 / csp 四处;
- **命名语义漂移**:`lizi-art-media` 混装 art 与 mivo 产物;`lizi-` 前缀属待迁移老世界(lizi-mcps);
- **除聊天草稿清扫外全部只进不出**:无上限、无过期、无清扫,磁盘无限增长;目录改名后旧目录永久滞留(死目录即证据);
- 同一内容多处粘贴 = 多份拷贝,无去重;
- 意识供图需要"文件归属"一等公民,老结构给不了。

## 1. 三条硬约束

1. **老地址永久有效。** 聊天数据库与分享包里写死了海量 `xdt-image://...` 地址,不改写历史消息;老协议(`xdt-image` / `xdt-video` / `xdt-model`)永久保留、转只读,专职服务老地址。
2. **老文件原地冻结,一个不搬。** 正式版与 dev 共用 `userData`(Dogfooding 双开常态),搬家 = 老版本碎图。`cc-agent/` 整体 grandfather,不迁移、不重命名、(除既有草稿清扫外)不清理;其治理待老版本淘汰后另议。
3. **新写入 100% 进新世界。** 换心脏上线后,所有新媒体(聊天附件、生成作品、集成缓存、分享导入散件、意识产物)一律写入 `cindy-media/`,不再向 `cc-agent/` 添一个字节。

已接受的代价:老版本不认识 `cindy-media://` 新地址——降级或双开旧版时**新消息**的媒体不显示;老消息永远完好;普通用户单版本升级零感知。

## 2. 核心设计:字节与含义彻底分家

早先草案(sessions/generated/ghosts/cache 四层目录)本质是"让文件夹替账本干活",导致"删会话陪不陪葬""作品属于谁"等目录制固有难题。定稿放弃目录表意:

- **字节仓(blob store)**:硬盘上唯一的文件区,文件名 = 内容指纹(SHA-256),不含任何归属信息;
- **账本(ledger)**:数据库是唯一真相,文件的出生(会话/意识/工具/提示词)、性质(附件/作品/缓存)、引用(消息/画廊/其它会话)全部是账本行;
- **生命周期 = 引用计数**:删会话 = 删其引用行;blob 引用归零 → 回收器收走。"陪葬问题"消解为每个文件各自的引用现实;
- **人类可读性由 App 内提供**(存储管理页:按会话/意识/时间浏览、导出),不靠文件管理器翻目录。

### 2.1 磁盘结构(全部)

```
userData/cindy-media/
└── blobs/
    ├── 00/ … ab/ … ff/          ← 256 个抽屉,按指纹前两位机械分桶(纯防单目录过大,无语义;同 git objects)
    │       └── <sha256 完整指纹>.<ext>    ← 后缀由主机按真实 mime 定,决定渲染方式
```

账本不在此目录——住 desktop localDb(Drizzle/SQLite,与会话/消息同库,可做一致性删除)。

### 2.2 账本表(示意,字段以实现为准)

- `media_blobs`:指纹(主键)、ext/mime、字节数、首次入库时间、性质标记(cache 可再生 / 非 cache);
- `media_refs`:指纹 → 引用方(kind: message / ghost-gallery / session-attachment / import / …,+ 引用方 id)、出生信息(生成会话 id、来源意识/工具、时间)。

schema 变更走规则 17(`pnpm db:generate`,禁手写 migration);migration 回放测试必跑。

### 2.3 指纹与去重

- SHA-256,**主机侧计算**(字节到主机手里才算指纹入库;任何插件/外部"自称指纹"不算数——不信自报);
- 同内容重复写入 = 查账即返回既有指纹,天然去重;
- 碰撞:SHA-256 无已知构造法,生日界远低于硬件位错概率,按"不会发生"处理;
- 文件永不改名、永不搬家:指纹跟内容走,与归属无关,归属变化只动账本。

### 2.4 协议格局

| 协议 | 命运 |
|---|---|
| `cindy-media://` | **新增**,新世界唯一取件窗口;地址即指纹(`cindy-media://blobs/<指纹>.<ext>`),永久稳定;渲染端按后缀分流 img/video/audio/model |
| `cindy-ghost://` | 保留;新增 `cindy-ghost://<意识id>/media/<指纹>` 供图分支:沙箱协议接待员查账本验归属(指纹只当查账钥匙,不拼路径;归属不符即拒;解析出的路径必须落在 blobs 内双保险) |
| `xdt-image` / `xdt-video` / `xdt-model` | 永久保留、只读,服务 `cc-agent/` 老地址 |
| `xdt-audio` / `xdt-file` / `cindy-remote-media` | 本次不动(直读磁盘/远程隧道通道,非仓库) |

安全模型与 runtime-sandbox.md 结构隔离一致:插件永远只摸字符串;主机不信任插件任何输入(指纹=查账钥匙、身份=webContents 房间号、图片=按 mime 只当图片解码);全防线失守也只炸在断网无权限沙箱内(熔断已真机验证)。

## 3. 各类媒体在新世界的写入语义

| 来源 | 入库动作 | 账本记什么 |
|---|---|---|
| 聊天附件(粘贴/拖拽/手机传) | 字节→blob | ref: session-attachment(会话 id);删会话删此 ref |
| AI 生成作品(art/mivo/意识工具) | 主机代办产物→blob | **v1 实现口径(2026-07-12 第 2 步)**:生成时零引用入仓(art 存储是无会话上下文单例),消息落库汇聚点(localDb createMessage / updateMessageContent 挂账钩子)补 ref: session-attachment(会话 id,originKind=tool);消息级 message ref 归后续阶段。画廊 ref 独立存续不变 |
| 集成下载(feishu/slack/jira/confluence/…) | 下载字节→blob | **v1 实现口径(2026-07-12 第 3 步)**:blob 性质=cache(Confluence/Jira MCP 附件);ref: `integration-cache`(refId=`<集成>:<token>`,充当 token→指纹索引回答"下过没有",兼标明缓存身份)。**例外:IM(飞书/Slack/Discord)入站用户附件 isCache=false**——它语义是会话附件而非可再生缓存(Discord CDN 地址限时签名,LRU 逐出即永久丢图),落库时经消息挂账钩子补 session-attachment 引用。消息级 ref 归后续阶段。**飞书 MCP(3b)补充**:meta sidecar 留在 `cc-agent/feishu-media/` 当 token 索引(小 json,非媒体字节);preview 派生键 = `feishu:<token>#preview`(token 字符集不含 `#`,无冲突);仓内文件被逐出 → 包侧清 meta 重下自愈(回收器逐出对 feishu MCP 是正常事件,不是坏账) |
| 分享包导入 | 包内文件→blob(指纹去重) | ref: 导入后的会话 |
| 意识画廊/持久引用 | 不产生新文件 | ref: ghost-gallery(意识 id → 指纹列表);卸载意识删其全部 ref |

意识的非媒体私有状态(画廊清单本身、设置等)是账本/DB 数据,不是 blob,不占字节仓。

## 4. 回收器

- **引用计数为主**:blob 无任何 ref → 进入回收候选(留缓冲期,防写入与记账间隙误判);
- ⚠️ **"零引用"≠"无主"(实现回收器前必读,2026-07-12 第 1/2 步 review 钉死的不变量)**:聊天附件的设计是"粘贴=零引用草稿、发送时才挂 session-attachment ref",生成产物同理(生成=零引用入仓、tool_result 消息落库时挂账),因此**四类暂存区里引用的 blob 可以长期合法地处于零引用状态**:(1) 输入框托盘草稿(composerDraftStore);(2) busy 排队消息;(3) 崩溃恢复持久队列(agent input queue snapshot);(4) "生成完成 → tool_result 落库"的在途窗口(崩溃可使其永久停留)。朴素的"零引用+超过缓冲期即删"会清掉这些用户可见的图。回收器必须感知前三处暂存区(扫描其内容里的 `cindy-media://` 地址视作活引用),或改为在入队/存草稿时就挂临时 ref;第 (4) 类崩溃遗留由对账工具按"只报不删"处置;
- **cache 性质加一条**:总量上限(默认 512MB 量级,配置分层原则定可见性)+ 最久未用先清,即使仍有 ref 也可清(可再生,下次要用重新下载,ref 指向重新入库的同指纹 blob——指纹制下"重下同一文件"自动复位);
- **非 cache 粘性降级(2026-07-12 第 3 步 review 钉死)**:cache blob 一旦被**非 cache 业务**引用即失去"可清"资格——聊天渲染端没有重下通道,清掉聊天历史仍在引用的字节 = 永久缺图。降级有三道口:(a) 重新 ingest 时 `recordBlob` 的"只降不升"合并;(b) 消息落库挂账钩子 `commitChatImageUrls` 对每个入消息的 blob 调 `pinBlob`(置于 hasRef 幂等判定之前,给首次降级失败留自愈口);(c) IM `getCachedImage` 命中复用 MCP 侧 cache blob 时同样 `pinBlob`。集成下载的 blob 因此可能"生为 cache、被聊天引用后转正"——MCP 文档配图仅被 agent 读取(不进聊天渲染)时保持 cache 可清,进了聊天消息即钉死,这是有意的取舍;
- **integration-cache 引用行的生命周期(第 3 步落地)**:该类 ref 是 token→指纹索引,**永不被会话删除清理**(removeSessionRefs 不含它),因此带此 ref 的 blob 永远非零引用——cache 性质 blob 的唯一出口就是上一条的 cache 策略;逐出删 mediaBlobs 行时,索引行靠 `mediaRefs.hash` 的 FK cascade 一并清掉,下次同 token 访问按 miss 重下自动复位。**非 cache 且带 integration-cache ref 的 blob(IM 用户附件)现阶段等价老世界"只进不出"**,过期索引行的清理策略(如按 lastAccess 时效)归阶段③对账工具设计;
- **对账兜底**:查无此账的孤魂文件、有账无文件的坏账,**只报不删**,进对账工具人工处置(账本是命脉,回收必须保守);
- **一律先报数后动手**:每类清理首次只出统计清单,确认后启用真删;
- **死目录清退**(`lizi-image-media` / `mivo-media` / `mivo`):现行代码零引用 + 线上正式版代码零引用 + 文件 mtime > 30 天,三条全满足才列入。

**v1 实现口径(2026-07-12 第 5 步落地)**:入口 = 设置「关于」页的存储空间卡片(`StorageManagementCard`),**全部手动触发、无任何自动删除**(先在真实数据上跑几轮报数,自动化后续再议)。核心模块 `cindy-media/recycler.ts` / `legacyDeadDirs.ts` / `storageIpc.ts`:
- 暂存区感知落地:(1) 草稿托盘 = 双通道——发起清理的窗口随参带 `composerDraftStore.getAllDraftAttachmentUrls()` + **全窗口登记表**(`draftUrlRegistry`:每个窗口的草稿附件集合变化时经 `cindy-media:report-draft-urls` 推给 main,按 webContentsId 登记、窗口销毁清行;多窗口副窗是独立 renderer 进程,发起窗口带不上它们的草稿,review P1 钉死);(2) 内存队列 = `AgentInputCoordinator.collectQueuedPayloadTexts()`(pendingQueue + activeTurn + recovery 序列化);(3) 崩溃快照 = `agent_input_queue_snapshots` 全量 payload 文本正则抽指纹;(4) 在途窗口 = 72h 缓冲期(内部常量)兜底。scan 与 cleanup **各自独立取证**,确认弹窗期间新粘贴的图不吃旧活引用集。**已知限制(备案)**:dev+release 共库双开时,另一实例的 (1)(2) 是它的进程内存、本实例取证不到((3) 共享快照表天然跨实例)——触发需"另一实例草稿存活超 72h + 本实例手动清理确认"两个低概率条件叠加,普通用户不双开,dogfooding 场景自担;另 steer 派发的纳秒级在途窗口同靠缓冲期兜底;
- 删除顺序:条件删账(零引用+缓冲期在同一条 DELETE 里复查)→ 复查无并发重录 → 删字节;失败方向永远是孤魂文件(对账可见),绝不产生坏账;cache 逐出的条件删账额外拦"存在非 integration-cache 引用"(pin 链路的双保险);
- 死目录清退只认三个名字的封闭名单,clean 前重新核验 30 天资格(出现新文件即拒——"零引用"结论过期宁可不删);
- 对账体检(`recycler.reconcile`)只报不删:孤魂(mtime 1h 内的在途写入豁免)/坏账/形状不合文件/.tmp 残留,全量清单进 main 日志,IPC 只回计数与样例;
- 防回潮守门白名单新增 `cindy-media/legacyDeadDirs.ts`(对老世界的唯一允许删除操作)。

## 5. 意识系统读写契约(第一客户验收标准)

**写(生成)**:意识工具(如 gen_image)由主机模型槽代办 → 主机算指纹、写 blob、记账(出生=该意识+当前会话,ref=出图消息)→ 指纹字符串经管子回电子脑;agent/聊天流拿 `cindy-media://` 引用渲染图卡。插件全程零文件访问。

**读(面板上墙)**:电子脑把指纹经 BroadcastChannel 广播给面板 → 面板 `<img src="cindy-ghost://<id>/media/<指纹>">` → 接待员查账验归属(该指纹须有本意识的出生记录或 gallery ref)→ 从 blobs 读同一份文件。零拷贝,同一文件两个只读窗口。

**持久(画廊)**:电子脑经管子请求"把指纹挂进我的画廊" → 主机写 ghost-gallery ref → 该 blob 从此不随会话删除而死;卸载意识 → 删其全部 ref → 无人引用的 blob 自然进回收。

## 6. 实施阶段(每步可独立上线、独立回滚)

| 阶段 | 内容 | 用户感知 |
|---|---|---|
| **① 换心脏 + C3d-2 同批** | MediaStore(blob 写入/指纹/resolveSafe)+ 账本表 + `cindy-media://` 协议注册;老三套 store 冻结为只读遗产;**新写入全量切到新世界**;意识供图作为首个客户接线(管子开闸/ghost 总机/模型槽代办)。QA:说"画一张猫"→ 聊天出图卡 → 画廊上墙 | 零感知(老内容照旧,新内容走新路) |
| **② 存储管理页** | 按会话/意识/时间浏览、占用统计、导出;把"可读性"从文件夹还给界面 | 新功能 |
| **③ 开清理** | 引用计数回收 + cache 上限 + 死目录清退 + 对账工具;全部先报数 | 磁盘变小 |
| **④ 迎新客** | lizi-mcps 迁来的工具一律走 MediaStore 记账,不再新增专用目录/协议 | 新功能 |

回滚保证:老世界冻结 + 老地址不改 + 新世界 append-only → 任何阶段回退 = 退代码,数据零损伤。

## 7. 定案记录(2026-07-09)

- 目录表意制(四层树)→ **指纹制**:字节仓无语义,含义全在账本(Lizi:"抛开历史怎样更合理"定向后拍板);
- `blobs/` 下 256 抽屉分桶保留(纯性能保险,零成本);
- SHA-256 + 主机侧计算,碰撞按不会发生处理;
- `imported/` 概念取消(此前已定):导入散件即"归属导入会话的附件 ref";
- "删会话作品陪葬"问题由引用计数自然消解,不再是设计开关;
- 新命名一律 cindy- 语系;`lizi-` 前缀不再新增。

## 8. 待办 / 开放项

- [ ] **媒体读写并入权限模型(归 C3c)**:写=模型槽的推论(无模型槽即无产物途径)、读=归属账本焊死的"自产自看"(默认权限,零授权),两者结构自洽无需新权限;**持久引用(画廊)是真权限**——阻止回收=无限期占用磁盘,需 per-意识配额上限 + 装入确认界面明示("可保存生成媒体,占用上限 X")+ 卸载全额归还;跨意识读取(如"相册管家"读全部作品)现阶段不开口,未来若开必须用户显式授权;
- [ ] cache 上限默认值与设置可见性(docs/configuration-design-principles.md 分层);
- [ ] 对账工具形态(CLI 脚本 vs 设置页入口);
- [ ] `xdt-audio` / `xdt-file` 改姓与否,老世界淘汰时再议;
- [ ] `cc-agent/` 老仓治理,老版本淘汰后另议。
