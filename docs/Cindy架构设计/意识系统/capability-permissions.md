# 能力权限与 Cindy 能力后端(C3c 实施方案 + network 槽前瞻)

> 状态:草案 v0.1(2026-07-12,与 Lizi 讨论中)。
> 范围:装入确认框的逐项权限清单、按能力配额、cindy-request 的 callId 归因、
> 用户图片授权、cindy.video 能力扩展、官方命名空间保留,以及 network 槽的
> 前瞻设计。cindy 槽已落地部分(image 详单 / 档位 / 目录选型 / 每意识钉选)
> 只作现状引用,不重复设计。

## 0. 背景与目标

cindy 槽(意识请 Cindy 本体代办)已经跑通图像两动作:

- **能力详单**:`ghost.json` 的 `"cindy": {"image": ["generate","edit"]}`,装入时钉死,
  有槽无详单 = 零能力(老包兼容);
- **选型链**:调用显式点名 > 每意识钉选(ghost-cindy-prefs.json)> tier 档位 > 出厂默认
  (providers.json 目录,`getActiveCatalog` 每单现读,OSS 热更);
- **归属安全**:改图源图逐张查账验归属(`ghostCanRead`:出生自本意识或挂本意识画廊),
  越权统一拒绝不泄露细节;在途并发默认不限,可按意识配置上限
  (ghost-cindy-prefs.json 的 `inflightLimits`,2026-07-12 起——此前默认每意识 1 单)。

C3c 要补的是**权限的"事前可见、事中可控、事后可查"**三块,外加两笔既定欠账
(cindy.video、官方前缀)。完成后 lizi_art 的图像+视频通道具备退役条件
(**已于 2026-07-12 正式退役**,见 §5 检查单)。

## 1. 装入确认框:逐项权限清单(C3c-1)

### 现状问题

确认框只有一行汇总(「包含:面板 · 可执行代码 · Cindy 代办 · 注册工具」),用户
看不到"Cindy 代办"具体是什么能力、注册了哪些工具、会抢哪条指令。权限告知形同虚设。

### 设计

确认框从"一行汇总"改为**逐项权限卡**,数据全部来自清单静态推导(装入前无需运行代码):

| 权限项 | 展示内容 | 数据来源 |
|---|---|---|
| Cindy 代办 | 按类目逐条:「图像生成」「图像编辑」(未来「视频生成」…) | `manifest.cindy` 详单 |
| 注册工具 | 工具名 + 一句话描述,逐个列出 | `manifest.tools` |
| 聊天指令 | `$<command>`(含撞名检查结果) | `manifest.command` |
| 面板 | 面板标题 + 停靠位置 | `manifest.panel` |
| 可执行代码 | 「离屏沙箱运行,无文件/网络访问」固定说明 | `manifest.entry` 存在 |
| 消息订阅 | (订阅槽落地后)订阅的事件类型 | 未来字段 |

原则(与 `docs/configuration-design-principles.md` 同源):
- **如实、逐项、无技术黑话**——写「图像生成」不写 `image.generate`;
- **更新时做 diff 展示**:同 id 更新只高亮新增/移除的权限项(如 v1.5 → v1.6 新增
  「视频生成」),不变项折叠;
- 权限清单是**装入时钉死**的(详单语义不变),运行期不存在"动态申请升权"。

### 实施

renderer 确认弹窗组件改造 + `validateGhostManifest` 已有的结构化 manifest 直接喂
数据,无 main 侧新逻辑。i18n 四语言同步。

## 2. 按能力配额(C3c-2)

> **状态:搁置(2026-07-12 Lizi 决定)**。现阶段意识全部自产自装、无第三方
> 分发渠道,"防谁"的前提不存在,做了空转;唯一真实风险(自己写出死循环刷单)
> 概率低。**重启条件:意识分发渠道立项时,本节升格为必做前置**——届时装入
> 确认框的"每天最多 N 单"也是用户安全感的一部分。以下设计保留备用。

### 威胁模型

意识代码不可信(第三方 .cindy),cindy 代办花的是用户的 proxy 额度。现有防线只有
在途并发名额(`cindySlot` inflight;2026-07-12 起默认不限、用户配了上限才闸),
缺**频次/总量**维度——恶意或写坏的意识可以串行狂刷出图单。

### 设计

主机级配额,按 **意识 × 能力类目** 记账,纯代码强制(规则 9):

- **滑动窗频次**:每意识每类目,默认 `image: 30 单/小时`(常量起步,后续可进
  providers.json 随目录热更下发);
- **单日总量**:每意识每类目,默认 `image: 200 单/天`;
- 超限返回结构化错误(「今日出图配额已用完,明天再试或到设置调整」),不静默排队;
- 配额计数落 localDb(重启不清零),表按 `(ghostId, capability, windowStart)` 聚合;
- 设置页意识详情暴露"今日已用量"只读展示;配额调整属高级设置(配置文件层级,
  不进 Settings 外层——遵守配置设计原则的可见性分层)。

**不做**:全局跨意识总配额(proxy 侧已有账号级限流,主机不重复造);按 token/
金额计费(主机看不到单价,只按"单数"配额)。

## 3. cindy-request 挂 callId 归因(C3c-3)

### 现状问题

`GhostPipeCindyRequest` 没有关联字段,主机日志只知道"意识 X 发起了一单
gen_image",对不上"是聊天里哪次 tool-call 触发的"。审计、排查、未来按会话
计费都缺这根线。

### 设计

- 管子协议 `cindy-request` 增加**可选** `callId` 字段:意识把 `tool-call` 收到的
  `callId` 原样带上;
- 主机侧:配额记账、日志、(未来)用量面板全部带 `callId` + `ghostId` 双键;
- **可选而非必填**:意识可能在无 tool-call 语境下自发代办(如面板交互触发),
  强制必填会把这类合法场景逼成造假 callId。无 callId 的单在日志里标 `unattributed`;
- FORGE_GUIDE 同步:「代办请求请带上 callId,让用户能在账单里对上这笔钱」
  (规则 24,手册与校验同改)。

## 4. 用户图片授权(C3c-4)

### 现状问题

改图铁律是"只能改本意识生成的图"(`ghostCanRead`)。用户想让画图意识改**自己
发进聊天的照片**做不到——这是 lizi_art `image_edit` 今天有、意识没有的最后一块
能力差距(lizi_art 收 `xdt-image://` 或本地绝对路径)。

### 设计:显式引渡,不开默认口子

归属模型不动(意识永远只能读自己名下的账),新增两条**用户显式授权**路径:

1. **附件随单授权(主路径)**:AI 调 `ghost_call` 时把**当条 user 消息的图片附件**
   作为参数传入 → 主机(不是意识)把附件图落 `cindy-media` 总仓、给该意识记一条
   `granted` 引用(refKind 新增 `ghost-grant`),然后把指纹交给意识。语义:用户把图
   和请求一起发出 = 对这单的授权意图明确,不需要再弹框。授权是**按张、永久**的
   (进了该意识的账本,后续还能继续改),不是"按次阅后即焚"——与画廊挂墙同一
   生命周期模型,回收由媒体总仓引用计数统一管。
2. **拖拽引渡(已有,反向)**:用户把聊天里的图拖进意识面板 → 已有的引渡通道,
   同样落 `ghost-grant` 引用。

**不做**:意识主动申请读任意 session 附件的 API(等价于给沙箱开相册权限,违背
"摸不到文件"的结构保证);"装入时勾选『允许读我的图片』"这类粗粒度总开关
(用户无法理解其真实范围)。

### 实施

- `shared/ghost.ts`:`ghost_call` 工具参数协议增加可选 `attachments`(消息附件指纹,
  由 renderer/main 侧解析,意识代码无感知);
- `cindy-media/ledger.ts`:`MediaRefKind` 增 `ghost-grant`;`ghostCanRead` 的 or 分支
  加一条;
- `cindySlot` 源图校验不改(`resolveOwnedMedia` 走 `ghostCanRead`,天然吃到新分支)。

## 5. cindy.video 能力扩展(C3c-5,lizi_art 退役前置)

lizi_art 还有 `video_generate` / `video_edit`(seedance / happyhorse 两 provider),
迁移方式与 image 完全同构,不引入新概念:

- 详单类目扩展:`GHOST_MODEL_IMAGE_ACTIONS` 旁增 `video: ['generate','edit']`;
  `CINDY_CAPABILITY_KEYS` 增 `video.generate` / `video.edit`;
- `providers.json` 增 `videoModels` / `videoDefaults`(与 imageModels 同结构同校验),
  打包兜底常量同源守卫测试同款;
- `cindySlot` 增视频两动作 handler(复用 lizi_art 的 provider 层代码,注入方式同
  generateImage/editImage);视频产物进 `cindy-media` 总仓 + 画廊(面板显示视频卡);
- 档位/钉选/显式点名选型链原样适用;
- 确认框权限项显示「视频生成」「视频编辑」;配额独立类目(`video: 10 单/小时` 起步,
  视频贵)。

### lizi_art 退役检查单(2026-07-12 Lizi 拍板执行,已完成)

- [x] C3c-1…C3c-5 全部落地(真机 QA 由退役后的意识链路验证兜底)
- [x] art 意识(cindy-art)声明 image + video 全量能力(真机验证两类目:退役后回归时执行)
- [x] 官方预装通道落地(builtinGhostProvisioner,cindy-art audience=all 随应用可用)
- [x] 移除 lizi_art MCP 注册与工具层:providers.ts 注册、mcpServer.ts / toolRegistry.ts /
  prompts/ / media/(未使用的老文件存储)已删;video provider 层与 xdproxy 图像客户端
  **留作纯后端**(现 `apps/desktop/src/main/cindy-proxy-media/`,`CindyProxyMediaBackendDeps`;
  2026-07-13 由 lizi-mcps 的 `src/art/` 改名并整体迁入 desktop main——它是 cindy 槽的媒体
  引擎、只有主机一个消费方,不属于 MCP 工具包;这也是"逐步掏空 lizi-mcps"方向的第一步),由 desktop
  cindy 槽与 mivo 存储装配直连消费——"迁入 cindy 槽后端"落地为"摘工具壳、后端留任",
  代码未删除
- [x] 系统提示词无需再改(绘图规则已于 2026-07-12 提前删除,`c5001a45f`)
- 配套:mivo 路由规则(routing.md / list_tools.md)默认通道改为 cindy-art 意识;
  desktop art 插件项、`lizi_art` provider 映射、四语言插件文案同步移除;历史消息的
  lizi_art 工具卡渲染与 `xdt-image://` / `xdt-video://` 老地址只读服务不受影响

## 6. 官方命名空间保留(✅ 已落地 2026-07-13)

- `cindy-` 前缀 id 保留给官方意识:`validateGhostManifest` 不动(校验器保持纯函数),
  **拦在装入通道**——`ghosts:inspect / install / update` 三个用户通道 IPC 对
  `cindy-` 前缀直接拒装(`rejectReservedGhostId`,错误码 `GHOST_ID_RESERVED`,
  四语言文案),官方预装(builtinGhostProvisioner)走内部安装路径不受限;
- **dev 构建豁免**(解开旧顾虑"会把开发期拖入挡死"):`app.isPackaged` 才生效,
  内置意识的开发迭代(打包重装 cindy-art / cindy-web-search)不受影响;
- **为什么必须拦**:凭证别名表(providerSecrets `GHOST_SECRET_STORAGE_ALIASES`)
  按 id 生效——不拦的话,用户卸载内置意识后装入同 id 第三方包即可冒充官方身份、
  蹭走用户历史填过的机器级 key(2026-07-13 review P1 实锤后落地);
- FORGE_GUIDE §8 拒装速查已同步(规则 24)。

## 7. network 槽(C4,已落地 2026-07-12)

cindy 槽解决"用 Cindy 自己的能力";network 槽解决"意识自带服务"——作者有自己的
后端/第三方 API(天气、股价、自家 SaaS),带着凭证来。README 两条铁律的第二条
在此落地:**意识自有凭证锁在主机保险库,沙箱无读取接口**。

### 清单声明(装入时钉死,确认框逐项展示;真身 `shared/ghost.ts` 校验)

```jsonc
"network": {
  "hosts": ["api.example.com", "*.weather.com"],  // 1–8 条;小写至少两段;通配只允许最左一段;不收 IP/端口/路径
  "secrets": [{                                    // 0–4 条:需要用户填的凭证槽
    "key": "api_token", "label": "Example API Token", "hint": "在 example.com/settings 生成",
    "inject": {                                    // 必填:注入绑定在 secret 上(落地时由独立 auth 模板改为此形态,
      "header": "Authorization",                   // 结构上钉死"key 只流向它声明的域名",意识更新扩白名单也扩不走
      "format": "Bearer {value}",                  // 存量凭证的流向;format 恰含一个 {value} 占位)
      "hosts": ["api.example.com"]                 // 可选:hosts 声明条目的子集(逐字);缺省=全部
    },
    "exchange": {                                   // 可选:key 换令牌二段式(2026-07-13 落地,详见下方运行时形态)
      "url": "https://api.example.com/token",       // 交换端点(https;域名必须命中 hosts——原始 key 也只流向用户同意过的域名)
      "bodyFormat": "{\"sub\":\"{value}\"}",         // POST 体模板,恰含一个 {value};按 contentType 确定性转义
      "contentType": "application/json",            // 缺省 json;另支持 x-www-form-urlencoded
      "tokenPath": "session",                       // 令牌在响应 JSON 的点分路径(不支持数组下标)
      "ttlSeconds": 86400                           // 缓存秒数 60–2592000,缺省 3600
    }
  }]
}
```

### 运行时形态(实现:`cindy-brain/networkSlot.ts`)

- **管子代理 fetch**:沙箱内无直接网络(断网闸不放开、CSP 不放宽);电子脑
  `cindy.fetch({url, method?, headers?, body?, timeoutMs?, callId?})` 即
  `cindy.send({type:'fetch-request',…})` 的语法糖,主机按白名单校验域名
  (仅 https 443、重定向≤3 跳且逐跳重验白名单,出圈阻断)后用 Node fetch
  (undici,`redirect:'manual'` 可读 Location 逐跳守门)代发;
- **凭证保险库**:user 凭证的收单**一律由意识 settingsHtml 自绘**(2026-07-13
  Lizi 两次定案,当天收敛:先开 `input:'ghost'` 意识收单通道,随后宿主凭证
  渲染整体退役——基座不再为意识特设任何凭证 UI;声明 user 凭证必须同时声明
  settingsHtml,校验强制,`input` 字段随之退役:遗留 `"ghost"` 值接受并忽略,
  `"host"` 拒绝)。值经协议 `/secrets/<key>` **只写通道**一次性入库——录入
  瞬间明文路过意识页面(用户主动敲进它的输入框),入库后意识只能查回
  `{key, saved, tail?}` 状态、永远读不回值。
  tail 是**尾 4 位指纹**(2026-07-13 Lizi 拍板的有意识降级,帮用户回忆填的是
  哪个 key):入库瞬间由主机截取、`ghost_hint_` 前缀分键保管,协议读路径只回
  预截值;老键(宿主输入行时代/别名互通存的)首查时由 main 保险库层懒回填
  补截(main 本就持明文注入权,沙箱可见面不变);值不足 12 字符不产指纹。
  login-email 派生凭证无收单、不可配置(PUT/DELETE 405),GET 回
  `{key, saved, identity}`——identity = 当前登录邮箱,供意识设置页只读展示
  "用的是哪个身份"(2026-07-13 Lizi 定案:确认框已披露"将使用你的登录邮箱",
  且注入时它自己的服务端本就可见,回给设置页不算新增泄露面;只回邮箱,
  不是通用用户信息接口)。
  非凭证自定义参数走 `/kv` 端点(卸下清除沉睡保留),见 runtime-sandbox.md §2。
  无论哪种输入面,保管都是 safeStorage 加密落 `ghost_secret_<ghostId>_<key>`,
  只在代理 fetch 时按 inject 声明拼进请求头;明文不进沙箱、不进日志、不进管子
  消息;跨域重定向时重算注入;意识自带的同名头先剥除再注入(伪造值出不了网);
  换账号随 clearAll 前缀清扫、卸载意识连孤儿键一并清;
- **硬边界**:文本响应 ≤1MB 截断;body ≤256KB;每意识在途 4 单常量硬顶(防
  死循环,非配额);响应头只回白名单字段;
- **媒体模式(media-store 通道,2026-07-13 落地)**:`cindy.fetch({as:'media'})`
  时,2xx 的总仓受支持媒体(图/视频/音频/glb)**字节不进沙箱**——主机流式读
  (≤256MB,超限整单拒不截断)后经 `ingestMedia` 落 cindy-media 总仓、挂
  ghost-gallery 引用(出生=该意识,与 cindy 槽产物同待遇),只回取件单
  `{url, hash, ext, bytes}`;`label` 作画廊 caption。非 2xx / 文本响应自动回落
  文本形态(轮询"生成中"/错误 JSON 意识看得到);媒体模式超时档 1s–300s
  缺省 120s。这是 mivo 意识化的存储地基;
- **上传通道(upload,2026-07-13 落地,媒体模式的镜像)**:意识把"自己名下"
  的总仓媒体传给白名单服务(mivo 改图/图生视频的源图)——请求里只报指纹
  (1–4 条),主机查账验归属(`ghostCanRead`:出生自它 / 挂它画廊 / 用户显式
  过户)、读 blob、按 RFC 2046 手工代组 multipart/form-data(boundary 随机、
  Content-Type 主机独占、filename = 指纹前 16 位 + 总仓后缀,无用户可控文本),
  字节不进沙箱。仅 POST,与 body / as:'media' 互斥;单文件 ≤64MB、单次总量
  ≤128MB 超限整单拒;与媒体取件共用全局串行闸(multipart 体整体驻内存,峰值
  封顶);越权与不存在统一话术不给探测空间;响应按文本形态返回。凭证注入 /
  重定向守门 / 401 重换与普通请求同一条链;
- **凭证交换(exchange,2026-07-13 落地)**:mivo 类"key 先换临时令牌"的二段式
  由 `secrets[].exchange` **清单声明**覆盖(与 Lizi 定案:通用声明而非主机硬编码,
  新意识接入二段式服务零 app 更新)。主机照单代办:POST 交换端点(key 按
  contentType 转义进 body 模板;交换请求自带 15s 超时、响应 ≤256KB、重定向一律
  阻断、不占意识在途名额)→ tokenPath 取令牌 → 内存缓存(键含原始 key,用户改
  key 立即失配重换;不落盘,重启重换)+ 单飞去重 → `inject.format` 的 {value}
  注入令牌;上游 401 且本单用过交换凭证时作废缓存重换**整链重试一次**,再 401
  原样回意识。key 与令牌全程不进沙箱、不进日志;交换失败折叠成结构化错误
  (带状态码与 ≤200 字摘录,不含凭证字节);
- **主机托管 OAuth(source:'oauth',2026-07-13 落地,google/conf/jira 意识化前置)**:
  对接"标准 OAuth 授权、令牌会过期"的服务(Google / Atlassian 等)。与 Lizi 定案
  **通用声明式**:平台不预设 provider 名单——意识在凭证上声明 `oauth` 详单
  (authorizeUrl / tokenUrl / scopes / pkce 缺省 S256 / extraAuthorizeParams 服务商
  特有参数 / identity 账号标签端点),三个 URL 域名都必须命中 hosts 白名单
  (确认框展示的域名集合 = 全部出网面;clientSecret 只流向 tokenUrl)。
  **声明化的是参数不是代码**:授权流程(拉浏览器、127.0.0.1 loopback 回调、
  state/PKCE 校验、code 换 token、refresh 含轮换回写、invalid_grant 标过期)
  永远由主机可信代码执行(`ghostOauthFlow.ts` 引擎 + `ghostOauthAccounts.ts`
  账号/令牌管理器),意识无从插手。client 凭证(clientId/clientSecret)不进
  ghost.json,由用户在意识 settingsHtml 里自填(用户用自己在服务商注册的 OAuth
  应用,配额风控归用户)——经 `/oauth` 通道(与 /secrets 同纪律的只写+动作面:
  GET 状态零令牌字节、PUT client 只写、POST connect 主机跑授权、DELETE 断开、
  POST default)。多账号:每槽 ≤8 个,fetch 可带 `authAccount` 选账号,缺省默认
  账号。注入:networkSlot 出网现取新鲜 access token(内存缓存 + 单飞刷新,
  refresh token 按账号落保险库,派生键 `<key>-rt-<accountId>` 等共享
  ghost_secret_ 前缀、卸载前缀清扫连带),上游 401 作废重刷**整链重试一次**
  (与 exchange 同路)。互斥:oauth 与 exchange 不共存;login-email 不涉。
  确认框:「将引导你在 <授权域名> 完成 OAuth 授权(名称)」+ 主机说明 +
  scopes 原文逐行(`networkSecretOauth` / `networkSecretOauthDetail`);
- **飞书登录态令牌(source:'login-feishu-token')已整档退役(2026-07-16
  落地,2026-07-17 随飞书登录整体下线删除)**:该派生凭证原以主机
  FeishuTokenManager 的登录态 user access token 现取注入(刷新链走 xdt-api
  refresh-feishu)。飞书登录退役后,xd-feishu 改走上面的 **oauth +
  tokenBroker:'feishu'** 通道(PKCE,code 换 token / 刷新经 oauth-broker-server
  的 feishu provider,上游拒绝码 `FEISHU_OAUTH_FAILED`;broker 模式自此兼容
  PKCE,verifier 经 broker exchange 透传服务端);schema、networkSlot 注入
  通道、确认框分档文案 `networkSecretFeishuToken(Detail)`、FORGE_GUIDE 章节
  均已删除,存量已装清单由内置播种器按指纹覆盖自愈。2026-07-16 同日上传
  通道两个通用增强(仍现行):`upload.fields`(随行普通表单字段 ≤8 条,
  在文件段之前;值里字面量
  `{bytes}` 由主机替换成全部上传文件总字节数——飞书 drive upload_all 的
  size 字段用)与 `uploadDir.fileField`(单文件精确字段名,与 fileFieldPrefix
  互斥、票据必须恰含 1 个文件、filename 只取文件名——飞书 im 文件上传这类
  "字段名钉死 file"的服务用);
- **下行落盘(as:'file' + save 票据,2026-07-13 落地,uploadDir 的镜像)**:
  任意类型文件(邮件附件 / 云盘文档)下载进用户本地——主 agent 经 ghost_call
  顶层 `save_dir` 过户 workdir 内的**已存在目录**(realpath 钳制同 dir 过户),
  主机发限时票据注入 `args.save_deposit = { token, dir_name }`;意识
  `cindy.fetch({as:'file', saveTo:{token, filename?}})` 时主机把 2xx 响应字节
  直接写进该目录(≤256MB/文件,超限整单拒;非 2xx 回落文本)——**字节与
  绝对路径都不进沙箱、不进媒体总仓**(非媒体不进字节仓,规则 25 边界内的
  直写用户文件),意识只拿到消毒去重后的文件名(只留 basename、剥控制字符
  与前导点、永不覆盖已有文件)。票据可多次使用(一次调用链下多个附件):
  10 分钟 TTL 内最多 16 个文件 / 共 512MB,写满自动作废;与媒体取件共用全局
  串行闸。真身 `dirDeposit.ts` 的 SaveDepositVault。同批:`dir` 过户扩展为
  也接受**单个文件**路径(单文件上传场景);cindy.fetch 放行 PUT / PATCH
  (body 同 POST 档),Google Calendar / Sheets / Jira / Confluence 的更新类
  API 因此可用;
- **配额**:随 §2 一并搁置(分发渠道立项时重启);
- **确认框**:「访问网络域名 api.example.com」逐条 +「需要你提供凭证(Example
  API Token)」逐条;code 条目的"无网络访问"说明对 network 意识换分档版
  (`codeDetailNetwork`)。

### 与 cindy 槽的分野(定案重述)

- cindy 槽 = 标准库:登录即有,Cindy 本体买单,主机选型;
- network 槽 = 系统调用:作者自带服务与凭证,用户知情后放行,主机只做通道与守门。

### 首个消费方

内置意识 **cindy-web-search**(`resources/builtin-ghosts/official/cindy-web-search`,
audience=all 随应用预装):brave + tavily 双域名、双凭证、不同注入头,用户在
意识详情页配两个 key 即可搜索公网;`shared/__tests__/ghost.test.ts` 锁其身份卡
永远过校验。

## 7.5 2026-07-14 批次:新卡槽与过户增强

第三梯队意识化冲刺(GitHub / GitLab / Google / Atlassian,见
mcp-to-ghost-migration.md §2)期间落地的平台能力,补记于此。

### fs 卡槽(主机代写文件,三档守门)

第八槽(`GHOST_SLOTS` 加 `'fs'`,commit `be6c3a19d`)。沙箱仍无文件系统——槽是
「申请主机代写」的资格,声明 `"slots":[…,"fs"]` 后经管子
`cindy.fs({op, root, path, …})`(≡ `cindy.send({type:'fs-request',…})`)请主机
落盘。真身 `cindy-brain/fsSlot.ts`,契约常量 `shared/ghost.ts` 的 `GHOST_FS_*`
(单次读写 ≤16MB、path ≤256 字符 ≤16 段、拒 Windows 保留名/尾点段,symlink 不
穿透);装入确认框披露「可写入文件」条目。三档 root:

| root | op | 目标 | 门禁 |
|---|---|---|---|
| `data` | write/read/list/delete | `userData/ghost-fs/<ghostId>` 私有储物柜 | 免确认;配额 2000 文件 / 256MB,用量核算失败关闭;卸载随包回收 |
| `workdir` | 仅 write | 会话工作目录(凭 callId 反查归属,不信自报) | 跟随会话权限模式(免批直写 / 逐条弹 `fs_write` 确认卡,同目录本会话记忆;plan 模式拒;SSH 远程工作区拒——规则 26) |
| `save` | 仅 write | 主 agent `save_dir` 过户的票据目录 | 复用 SaveDepositVault 票据预算,只取 basename |

**out_file 泄洪回归**:老 MCP 的「大结果写 workdir 只交路径」语义借 workdir 档
回归——xd-atlassian 首发(commit `e1ad35ffe`,`deliver()` 四态:内联 / 落盘交
`saved_to` / 点名失败内联附注 / 落盘不可用回落截断),cindy-github /
cindy-gitlab 随后同款(2026-07-15,call_tool 层 `out_file` 参数 + 超 50KB 自动
泄洪,写盘内容与内联同口径即 slim/raw 后的 JSON)。FORGE_GUIDE §4.10 同步。

### notify 槽(系统轻提示)

第七槽(commit `c5e38c747`):意识上行 `{type:'notify', text, tone?}` 请主机弹
toast——纯文本 ≤200 字,提示壳与身份头(图标+名字)由主机画,伪装不了主机通知;
无按钮无回执,同一意识 5 秒限速。真身 `cindy-brain/notifySlot.ts`,FORGE_GUIDE
§4.9。消费方:cindy-github / cindy-gitlab 设置页「测试连接」结果 toast、凭证
入库 / OAuth 授权成功的主机代言 tips(`9cf3a631d`)。

### OAuth broker 模式(tokenBroker)与端口自愈

§7 的 `source:'oauth'` 直连形态之外的第二形态:`oauth.tokenBroker: '<slug>'`
声明后,code 换 token / refresh 不再直连服务商 tokenUrl,而是经 **XDT server
的授权 broker 端点**(`/api/integrations/<slug>/oauth/exchange|refresh`,JWT
鉴权)——client secret 由服务端持有、不随包分发、用户零配置(与 `clientSecret`
声明互斥;slug 白名单接线,server 无对应端点不放行)。调用器
`cindy-brain/ghostOauthBroker.ts`;服务端拆出独立 **apps/oauth-broker-server**
(provider 注册表化,jira 首迁,commit `6fe0b2ae6`)。消费方:xd-atlassian
(`tokenBroker: "jira"` + `redirectPort: 53682` 固定回调端口)。
配套端口自愈(commit `7e32c3729`):自家僵尸监听等真正 close 再 listen;外部
进程占用走 `portReclaim.ts`(netstat/lsof 查 PID 强杀重试,仅第一方官方意识
放行——第三方 manifest 的 redirectPort 不许借刀杀用户本地服务)。

### 过户增强(attachments / dir / save_dir 通用)

- **两层策略**(`897b12c05`):路径在会话 workdir 内直接放行;workdir 外弹
  确认卡由用户决定;
- **授权记忆**(`bc1e34ded`):允许过的不再重复弹卡——同一文件(按内容指纹)
  对同一意识永久生效,同一目录本会话内生效;
- **「允许所在目录」勾选 + 总仓地址再引用放行**(`92723167d`):确认卡可一次
  批整个所在目录;`cindy-media://blobs/<指纹>` 形态的总仓地址再引用免弹卡;
- **grant_only 批量预授权**(`67f88cd33`):`ghost_call` 顶层 `grant_only:true`
  只做 attachments 批量预授权不执行工具,上限放宽到 32 张——连续多次调用同一
  意识各用一个 workdir 外文件时,用户在一张卡上批完,后续零弹卡。

## 8. 实施切片与顺序

| 切片 | 内容 | 状态 / 依赖 |
|---|---|---|
| C3c-1 | 确认框逐项权限清单(含更新 diff) | ✅ 已落地(2026-07-12) |
| C3c-2 | 能力配额(localDb 记账 + 结构化超限错误) | ⏸ 搁置(见 §2;分发渠道立项时重启) |
| C3c-3 | cindy-request callId 归因(协议 + 手册) | ✅ 已落地(2026-07-12) |
| C3c-4 | 用户图片授权(ghost-grant 引用 + ghost_call attachments) | ✅ 已落地(2026-07-12) |
| C3c-5 | cindy.video(详单/目录/槽后端/art 意识更新) | ✅ 已落地(2026-07-12,真机 QA 待跑) |
| C4 | network 槽(代理 fetch + 凭证保险库 + 确认框/设置页/手册) | ✅ 已落地(2026-07-12,真机 QA 待跑);配额部分随 §2 搁置 |

顺序:1 → 3 → 4 → 5 → C4(已全部落地);2 随分发渠道重启。
