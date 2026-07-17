# lizi MCP 工具全量盘点与意识(Ghost)迁移评估

> 状态:盘点快照(2026-07-16 更新;工具计数基于 2026-07-12 main 代码实数)。
> 用途:lizi_art 退役后,逐个评估剩余 MCP server 是否迁移成意识的工作清单。
> 勾选规则:每处理完一个 server(迁移完成 / 明确不迁),把对应条目勾上并补一行结论。
> 2026-07-16 大势:**第三梯队 6 家全部迁完**——lizi_feishu 于 2026-07-16 改判迁移(xd-feishu);可意识化的 MCP 至此清零。2026-07-17 追加:飞书授权也切到意识 OAuth broker(tokenBroker:'feishu'),"后端留任"终结,login-feishu-token 平台契约删除(见 lizi_feishu 条目)。

## 0. 总量口径

- **21 个 MCP provider**:20 个本地(`packages/lizi-mcps/src/providers.ts`)+ 1 个远程托管(slack,`https://mcp.slack.com/mcp`,本地 0 工具)。
- **真实工具 ≈ 553 个**(不含"入口式" server 的 `list_tools` / `call_tool` 两个入口壳):
  - 直注册形态:orca 12 + lsp 6 = 18;
  - 入口式形态 18 个 server 合计 ≈ 535;
  - 其中 feishu 的"全量直通" ≈123 是运行时按 GEN_TOOLS 过滤器算出的浮动值(只读 GET + user token 的协作域);只算手写定值工具的口径是 ≈430。
- 含入口壳(18 × 2 = 36)总计 ≈ 589。
- **lizi_art 现状**:已于 2026-07-12 正式退役。`providers.ts` 无注册;图像/视频后端于 2026-07-13 改名并**整体迁出 lizi-mcps**,现居 `apps/desktop/src/main/cindy-proxy-media/`(`CindyProxyMediaBackendDeps`,cindy 槽的媒体引擎,兼供 mivo 存储装配)。详见 `capability-permissions.md` §5 退役检查单。
- **方向(2026-07-13 Lizi 定案):逐步掏空 lizi-mcps**——可意识化的能力迁成意识(network/cindy 槽),主机专属后端迁回 desktop main,包里最终只留真正跨 agent 复用的 MCP 工具层。cindy-proxy-media 迁出是第一步。

## 1. 迁移判断标准

意识沙箱**无文件访问、无网络访问**,一切能力只能走主机代办通道:

| 通道 | 状态 | 能干什么 |
|---|---|---|
| cindy 槽 | ✅ 已落地 | 图像/视频 generate/edit,主机选型、主机买单,产物进 cindy-media 总仓 |
| network 槽 | ✅ 已落地(2026-07-12,C4) | 主机代理 fetch(域名白名单)+ 凭证保险库(明文不进沙箱);后续叠加 as:'media' 取件 / upload 上传 / exchange 二段式 / OAuth(直连 + tokenBroker)/ as:'file' + save 票据下行(见 capability-permissions.md §7) |
| fs 槽 | ✅ 已落地(2026-07-14) | 主机代写文件三档守门:data 私有储物柜 / workdir 跟随会话权限模式 / save 票据——out_file 泄洪与本地产物落盘由此回归(见 capability-permissions.md §7.5) |
| 过户票据(ghost_call 顶层) | ✅ 已落地(2026-07-13/14) | attachments 附件过户、dir 目录过户(deploy/上传)、save_dir 落盘票据、grant_only 批量预授权——「上传/下载依赖本地文件」的迁移障碍由此解除 |
| 管子 / 面板 / 工具注册 / notify | ✅ 已落地 | 与主机通讯、UI、向主 agent 注册少量工具、系统轻提示 toast |

据此三个硬性否决项(07-12 口径;**2 与 3 已被上表能力逐步拆解**,以各条目落地为证):
1. 依赖主进程状态 / IPC / 本机驱动 / 子进程 → 不可迁;
2. ~~依赖本地文件系统读写(上传附件、out_file 落盘、目录遍历)→ 沙箱摸不到~~ → 已由 fs 槽 + 过户票据解除(out_file 走 fs 槽 workdir 档、上传走 attachments/dir 过户、下载走 save_dir 票据);
3. ~~凭证是用户主机侧 OAuth 登录态(非意识作者自带)~~ → 已由凭证模型扩展解除(login-email 派生 / 老账号一次性搬账进意识保险库 / OAuth 直连与 tokenBroker 两形态)。

## 2. 全量清单(按迁移优先级分组)

### ✅ 第一优先:推荐迁移

- [x] **lizi_mivo** — 13 个真实工具 → **意识本体已落地(2026-07-13,待真机 QA 后摘壳;同日更名 cindy-mivo → xd-mivo,历史卡片/KV 随播种迁移,密钥走官方别名零迁移)**
  - 工具:image 5(submit_gen_image / poll_result / segment_image / super_resolution_image / mivo_button_action)、video 1(submit_gen_video)、audio 2(submit_gen_music / submit_gen_sound_effect)、model3d 4(submit_gen_3d_model / poll_3d_result / convert_3d_model_format / animate_3d_model)、file 1(download_file)。来源 `mivo/mcp/server.ts`。
  - **路线定案(2026-07-12 与 Lizi 讨论)**:走 **network 槽路线(独立意识,作者/用户自带 key)**,不走 cindy 槽路线。理由:mivo key 是**用户本机 safeStorage 里自己填的 per-user key**(`mcp-integrations/mivo.ts` 经 providerSecretStore 读,无服务器副本),本质是"用户自带凭证调第三方服务",与 cindy 槽"Cindy 本体买单、主机选型"的模型不符;与 cindy 无关是正确形态。
  - **现状盘点(ghost 系统今天支持什么)**:
    - ✅ 已支持:独立意识形态、tools 工具注册(manifest.tools + ghost_call)、$ 指令、面板、聊天卡片(海报模式 v1,纯静态)、装入确认框逐项权限、内置预装通道(builtinGhostProvisioner)、submit+poll 拆分的长任务模型(mivo 现有工具面即此形态,可直接搬)。
    - ❌ 缺口(按重要度):
      1. **network 槽(C4)未实现**——沙箱今天无任何网络通道(管子协议只有 tool-call/交卷、card-update、cindy-request 四动作、订阅)。mivo 意识需要 `cindy.fetch` 代理 + 域名白名单 `["aigc.xindong.com"]`。这是硬前置。
      2. **凭证保险库 + 填写 UI 未实现**——"在 mivo 意识的设置页填 key"的正确形态:manifest 声明 secrets 槽 → **主机**在该意识设置页渲染标准凭证输入框(主机 UI,不是意识自己的 settingsHtml——意识自渲染表单会让 key 明文进沙箱,违背保险库设计)→ 主机加密落库 → 代理 fetch 时注入。注:manifest 的 `settingsHtml` 字段今天只有校验 + 设置页占位("渲染通道未开通",GhostDetailSection.tsx),尚无实际渲染通道,恰好不用背着它设计。
      3. ~~**鉴权不是静态 header 注入**~~ ✅ **已落地(2026-07-13,exchange 通用声明)**——MivoClient 的两段式(POST `/api/v1/state/token`,key 放请求体 `{sub}` → 响应 `session` 当 Bearer)已由 `network.secrets[].exchange` 清单声明覆盖:意识声明交换端点/请求体模板/tokenPath/ttl,**主机照单代办**换取+缓存+注入+401 作废重换重试;key 与令牌都不进沙箱,新意识接入二段式服务零 app 更新(与 Lizi 定案:通用声明,不做主机硬编码)。实现见 `networkSlot.ts` 交换引擎,契约见 `shared/ghost.ts` `GhostSecretExchangeDecl`,手册 §2/§4.7 已同步。mivo 意识的声明即:`exchange: { url: "https://aigc.xindong.com/api/v1/state/token", bodyFormat: "{\"id\":\"\",\"sub\":\"{value}\",\"name\":\"\"}", tokenPath: "session", ttlSeconds: 86400 }`。
      4. ~~**媒体入账通道缺失**~~ ✅ **已落地(2026-07-13,`as:'media'` 媒体模式)**——`cindy.fetch({as:'media'})` 字节不进沙箱直落总仓挂 ghost-gallery 引用(见 `capability-permissions.md` §7)。剩余尾巴:audio / model3d 的聊天/面板渲染卡需补。
      4b. ~~**媒体上传(multipart)通道缺失**~~ ✅ **已落地(2026-07-13,upload 反向通道)**——`cindy.fetch({method:'POST', upload:{hashes, field?}})`:意识只报总仓指纹(附件过户已让它拿到指纹),主机验归属(`ghostCanRead`)、读 blob、手工代组 multipart 出网,字节不进沙箱;单文件 ≤64MB / 单次 ≤4 文件 ≤128MB,与取件共用全局串行闸(见 `capability-permissions.md` §7)。mivo 的 `POST /api/v1/file/`(field 'file')可直接用。另注:结果轮询**不是**缺口——mivo 有普通 `GET /api/v1/message/{id}`(`getMessageResult`),意识轮询即可,不需要 SSE 流式。
      5. **MJ 按钮(mivo_button_action)交互缺口**——现在聊天图卡上的 U1/V1 按钮走 main IPC 直连 MivoClient(`getMivoClient`,agent loop 之外)。意识聊天卡片当前是纯静态海报模式(脚本/事件被 sanitizer 剥除,`v?: 1` 预留了交互版),迁移后此功能要么等卡片交互模式落地,要么降级(按钮动作改为让用户说话触发工具)。
      6. **download_file 落 workdir 能力消失**——沙箱摸不到文件,"存到本地路径"(3D 模型给引擎项目用的场景)需改为:产物进总仓 + 用户从聊天/画廊导出,或由主 agent 侧配套通道另行下载。
  - **建议实施顺序**:C4 network 槽(代理 fetch + 域名白名单)→ secrets 保险库 + 主机渲染的凭证填写 UI(含 token 交换定案)→ media-store 入账管子(含 audio/model3d 渲染)→ mivo 意识本体(工具面搬迁,MJ 按钮暂降级)→ 摘 lizi_mivo MCP 壳(复刻 lizi_art"壳下线、后端留任"模式,MivoClient 留给主机侧残留消费方评估)。
  - **结论(2026-07-13):意识本体已落地**——`resources/builtin-ghosts/cindy-mivo/`(ghost.json + main.js ~1300 行,audience=all 预装),12 工具上架(图 Nano/GPT/MJ/Niji、视频 Seedance/Kling、音乐 Suno、音效 ElevenLabs、3D TRIPO/Seed3D、抠图/超分、按钮动作、下载);凭证经官方别名表映射老 `mivo_api_key` 存储键(老用户零迁移);MJ 按钮 v1 = 数据形式 + button_action 工具(Lizi 定案保留完整功能;卡片交互 v2 落地后由意识自绘按钮);download_file 改「下载进媒体库」语义。~~**convert_3d_model_format v1 暂缓**~~ ✅ **已补上(2026-07-13,双路落地,v1.5.0)**——原暂缓理由(总仓只收 GLB,as:'media' 下载非 GLB 必被拒)被同日落地的「as:'file' + save_dir 落盘票据」通道解掉:GLB 产物照旧入媒体库,FBX/OBJ_ZIP 凭主 agent 在 ghost_call 顶层过户的 save_dir 票据直写用户目录(字节与绝对路径都不进沙箱、不进总仓);gen3d 的 fbx/obj 请求改为生成 GLB 中间产物 + guidance 引导转换,download_file 的 CONVERSION_REQUIRED 守卫同步做实;USD 仍引导网页端导出,ARK Seed3D 产物不支持转换;**跟踪事项:总仓扩 3D/压缩包类型 + as:'media' 对 octet-stream 的 magic-byte 嗅探兜底**(OSS 常吐 octet-stream,GLB 取件依赖正名 content-type,真机 QA 重点)。**摘壳已执行(2026-07-14,Lizi 拍板 QA 后置)**:lizi-mcps 的 mivo 整目录 + providers/LiziMcpId 注册、desktop mcp-integrations/mivo.ts + maker-ipc/mivo.ts(MJ 按钮 IPC 直连与 3D 懒下载三通道)、builtin-plugins mivo 开关、renderer ChatImageActions 按钮条 + makerChatStore mivo 状态机、帮助文档 api-keys 篇全部移除;老 MCP 历史消息降级为纯媒体展示(按钮条不再渲染、mivo 3D 预览退回普通图片,已缓存模型仍可经 xdt-model 老协议查看);payloadSummary 的 mivo 提取保留服务 IM/手机端历史渲染,手机端老按钮下线另行跟进。真机 QA 项(GLB octet-stream 嗅探、convert 新链路)转由意识 xd-mivo 承担。

### ⏳ 第二梯队:等 network 槽(C4)落地后可选

- [x] **lizi_web_search** — 3 个真实工具(search_web / search_brave / search_tavily)
  - 结论(2026-07-13 完成):**已迁移为内置意识 cindy-web-search 并完整退役 MCP**。与 lizi_art 不同,后端也一并删除(意识自己走 network 槽的 brave/tavily 通道,web-search service 无其它消费方):`packages/lizi-mcps/src/web-search/` 整目录、providers.ts 注册、`LiziMcpId` 成员、desktop `mcp-integrations/web-search.ts`、builtin-plugins 的 web_search 插件项与映射、设置页「工具密钥」的 Brave/Tavily 两行全部移除。**老用户兼容**:意识凭证经 `shared/providerSecrets.ts` 官方别名表映射到历史存储键(`brave_search_api_key` / `tavily_api_key` 同一 .enc 文件),已填的 key 零迁移直接生效。

### ⚠️ 第三梯队:07-12 判"不迁",07-13/14 逐家改判迁移(合计 ≈ 431 工具;仅 feishu 留守)

07-12 的三个共同硬障碍((a) 主机 OAuth 登录态凭证;(b) 工具量大;(c) 本地文件读写)后被平台能力逐一拆解:(a) → 老账号一次性搬账 + OAuth 槽(直连 / tokenBroker);(b) → 两段式目录(list_tools/call_tool 元工具 + 意识内 OPS 表,改工具不发应用版本);(c) → fs 槽 + 过户票据。除 lizi_feishu 外全部改判迁移并摘壳:

- [x] **lizi_feishu** — ≈171(48 精品 + ≈123 只读直通);飞书 OpenAPI + 用户 OAuth;上传/下载钳到 session workdir
  - ~~结论(2026-07-12):不迁,留主机~~ → **结论改判(2026-07-16,Lizi 拍板"全部迁移"):已迁移为内置意识 xd-feishu 并摘壳(lizi_art 模式:壳下线、后端留任)**。
  - **再改判(2026-07-17,Lizi 拍板"授权也归意识"):"后端留任"终结**——飞书登录整体下线后,xd-feishu 凭证从 `login-feishu-token` 切到 `source:'oauth'` + `tokenBroker:'feishu'`(PKCE,exchange/refresh 走 cindy-server oauth-broker-server 的 feishu provider,`FEISHU_OAUTH_FAILED` 上游拒绝码);主机 FeishuTokenManager 接线、authManager setJwt 挂钩、`refresh-feishu` 消费、`login-feishu-token` 平台契约(schema/networkSlot/FORGE_GUIDE)全部删除;scheduler 两个飞书方法改走 ghost pipe(对齐 callJira)。存量用户重新点一次「连接账号」(server 定案不做老 RT 回填);`packages/lizi-mcps/src/feishu/` 只剩死代码待整删(mcp/generated vendored 定义是 gen 脚本的源,整删时保留或搬家)。以下 07-16 要点中"凭证/后端留任"两条已被本段取代:
    - **凭证 = 新平台契约 `source:'login-feishu-token'`**(login-email 同族第三档派生凭证):主机注入时现取 FeishuTokenManager 的 user access token(自刷新 + 单飞去重都在管理器内),401 时 forceRefresh 整链重试一次;token 明文不进沙箱、不进错误消息;用户零配置零搬账(用飞书登录即用),意识设置页只有「测试连接」。"登录体系同源"的产品顾虑经论证不受影响——登录、IM 长连接(lizi-im)、feishu_bot 出站通道都在 desktop main,迁的只是 OpenAPI 协作套件。
    - **工具面全量搬迁**:44 个已注册精品工具(4 个老版已禁用项不迁)逐端点对齐移植进意识 OPS 表;≈123 只读直通面由 `scripts/gen-feishu-ghost-ops.mts` 从 vendored 定义静态烘焙(过滤策略与 genTools.ts 逐条一致:GET + 协作域 + user token + 排 task.v1),实烘 123 条,args 固定 path/params/data 三段;list_tools 保留 recommended/more 两组 + q 过滤 + 分页的老外形。
    - **本地文件语义全走过户票据**:上传本地文件 = ghost_call 顶层 dir 单文件过户(新增 `uploadDir.fileField` 单文件精确字段名,飞书 multipart 字段钉死 'file');上传聊天图 = attachments 指纹(新增 `upload.fields` 随行表单字段 + `{bytes}` 占位,supply drive upload_all 的 size);下载落盘 = save_dir 票据(as:'file');文档/消息图片 = as:'media' 进媒体总仓交回取件地址(**刻意差异**:不再回 base64 图片块);out_file 泄洪 = fs 槽 workdir 档(超 50KB 自动)。
    - **后端留任(与 web-search/mivo 整删不同)**:`packages/lizi-mcps/src/feishu/` 整目录保留——scheduler 脚本 capability broker(`scheduler-host/script-capability-broker.ts`)仍经 registry 直调工具实现,FeishuTokenManager 刷新链仍由 authManager 驱动(且是意识凭证注入的 token 来源);只摘 providers.ts 注册、desktop mcp-providers 接线、builtin-plugins 'feishu' 插件项(feishu_bot 不受影响)。
    - **装配级冒烟入仓**:`builtinFeishuGhost.test.ts`(node vm 驱动真 main.js:167 操作注册完整性 + 空参全扫 + 票据话术 + gop 模板 + 泄洪),与 builtinMivoVideo 同范式。
    - **已知缺口(顺延既有跟踪项)**:意识版 docx 块解析为精简版(图片清单/内嵌块/todo 保留;评论抓取、mention 清单、删除线、折叠章节、drive.meta 补 title 省略);wiki_read 对 bitable/sheet 节点改为指路对应工具(老版内联读);SSH 远程工作区下 dir/save_dir 票据读写本机文件系统的既有缺口(§3 跟踪项 2)同样适用于本意识的上传/下载。
- [x] **github_lizi** — 117;GitHub REST/GraphQL + PAT
  - 结论改判(2026-07-14,推翻 07-12「不迁」):**已迁移为内置意识 cindy-github 并摘壳**(commit `a8cf7dc60` 初名 XD GitHub,`f5289da5c`/`c1cab6af4` 两度更名收敛到 Cindy GitHub)。PAT 凭证卡槽、两段式目录 117 操作、设置页测试连接(notify 槽);老 PAT 由主机启动时一次性搬账进意识保险库(githubAccountsMigration);「owner/repo 从 git remote 推导」的一票否决改为**主 agent 侧推导后显式传参**;Actions 产物/日志从"只返 302 地址"升级为真下载落盘(as:'file' + save_dir 票据)。out_file 泄洪于 2026-07-15 借 fs 槽回归(call_tool 层 out_file 参数 + 超 50KB 自动落盘,v1.1.0)。
- [x] **gitlab_lizi** — 107;GitLab REST + PAT
  - 结论改判(2026-07-14,推翻 07-12「不迁」):**已迁移为内置意识 cindy-gitlab 并摘壳**(commit `c5f771e19`)。network 槽**多连接能力**(connections 声明 gitlab_conn,自建/多实例,地址 + PAT 成对入保险库,≤8 连接)、两段式目录 107 操作;老账号搬账(gitlabAccountsMigration);project_path 同 github 改主 agent 显式传参;仓库归档真下载落盘、项目附件上传走 attachments 过户。out_file 泄洪于 2026-07-15 借 fs 槽回归(同 github,v1.1.0)。
- [x] **lizi_google** — 19(后扩至含 Calendar/Drive/Sheets);Google OAuth(多账号)
  - 结论改判(2026-07-13,推翻 07-12「不迁」):**已迁移为内置意识 filo-google 并摘壳**(MCP 壳与 google 后端一并删除)。OAuth 凭证卡槽(source:'oauth' 直连形态)+ 内置 Filo 应用身份(设置页已移除「自定义 OAuth 客户端」高级区,`8c87c802b`);老账号(filoCurrent)主机启动时一次性搬账;Drive 上传/下载走过户票据与 as:'file' 落盘;PUT/PATCH 放行使 Calendar/Sheets 更新类 API 可用。
- [x] **lizi_confluence** — 17 + **lizi_jira** — 12(合并迁移)
  - 结论改判(2026-07-14,推翻 07-12「不迁」):**Jira + Confluence 合计 29 操作合并迁入内置意识 xd-atlassian 并摘壳**(commit `c130cff34`)。OAuth 卡槽 **tokenBroker 模式**(client secret 留在 XDT server broker、不随包分发;回调钉死 53682 端口 + 占用自愈 `7e32c3729`);老账号搬账(atlassianAccountsMigration);out_file 泄洪首发回归(fs 槽 workdir 档,`e1ad35ffe`,v1.1.0)——本组是 fs 槽与 broker 模式的首个消费方。

### ❌ 不可迁:主机本体能力(12 个 server,≈94 工具)

它们的本质就是主进程状态、IPC、本机驱动或本地文件系统;塞进"无文件无网络"沙箱等于为每个都开专用主机通道、把主机重写一遍。默认全部不迁,逐个确认后勾掉即可。

以下条目于 2026-07-12 逐个确认**不迁**——每个都命中"主进程状态 / 本机驱动 / 本地文件"至少一条硬否决;其中 **lizi_xd_service 已于 2026-07-13 改判重开**(迁企业定向意识,见条目内结论):

- [x] **lizi_computer** — 24;host 外部 computer-use 驱动(deps.callComputerTool)→ 本机驱动,不迁
- [x] **lizi_orca** — 12(直注册);主进程 Orca team 控制器 IPC → 主机本体,不迁
- [x] **lizi_scheduler** — 12;主进程 Scheduler 引擎 → 主机本体,不迁
- [x] **lizi_xdt_helper** — 12;本地 SQLite 聊天库 + 主进程 IPC/状态回调 → 主机本体,不迁
- [x] **lizi_android** — 8;本机 adb 驱动 → 本机驱动,不迁
- [x] **lizi_memory** — 8;workdir 域内 memory 文件 + 本地会话 DB → 本地文件,不迁
- [x] **lizi_lsp** — 6(直注册);本机 typescript-language-server 子进程 → 子进程 + 本地文件,不迁
- [x] **lizi_xd_service** — 5;pages 部署需遍历本地目录 + 登录态派生 token → **已完整迁移为内置意识 xd-pages 并整包退役(2026-07-13,工作区待提交;初名 cindy-xd-pages,同日更名 id=xd-pages / name=XD Pages,孤儿种子回收自动收走旧包)**
  - **结论改判(2026-07-13 Lizi 定案,推翻 07-12「不迁」)**:**迁成内置意识,audience = all**(与 cindy-web-search 同形态随应用预装)。产品理由:xd_service 是 XD 企业服务的接入层,不应由 Cindy / 主机本体负担这段逻辑;现状 MCP 本来就全量注册给所有用户,all 预装才能做到**现有用户无感迁移**。技术前置(按依赖顺序):
    1. **凭证 = 主机登录态派生,只读展示(Lizi 定案,不做用户自填)**:token = `pages_<email>`(`validate.ts` 纯派生,无 OAuth 交换),email 来自主机飞书登录态。需扩「主机登录态派生 secret」注入形态:manifest 声明 secret 来源为登录态邮箱(如 `source: 'hostIdentityEmail'` + 注入模板派生 `pages_{value}`),主机注入、明文不进沙箱;**意识设置页凭证区只读展示该邮箱,不给编辑入口**(用户能看到"实际服务用的就是这个邮箱")。未登录 / 老登录态无 email scope 时 fail-closed,复用现有 RELOGIN_FOR_EMAIL_HINT 引导重登。契约改动需同步 FORGE_GUIDE(规则 24)。
    2. **deploy 目录上传代办通道(唯一大缺口)**:`pages_deploy` 依赖遍历本地构建产物目录(collect.ts,500 files / 500MB 上限)+ multipart 上传,沙箱摸不到文件。需新开「目录过户 + 主机代 collect + 代组 multipart 出网」通道——与 mivo 的媒体 multipart 反向通道同哲学:字节不进沙箱,上传对象由用户 / 主 agent 显式交付(同 attachments 过户),不许意识任意指路径。其余 4 个纯 API 工具(list / info / delete / templates / get_worker_template)不依赖此通道。
    3. **收口**:摘 lizi_xd_service MCP 壳(复刻 web_search 退役模式,后端逻辑随意识走,主机侧无残留消费方则全删)。
  - **分期建议**:一期迁 4 个纯 API 工具 + 登录态凭证注入(含设置页只读展示);二期目录上传通道落地后迁 deploy、摘壳。deploy 未迁完前 MCP 壳不摘,两边共存期间行为一致(同一 email 派生同一 token)。
  - **一期已实现(2026-07-13,工作区待提交)**:(a) 契约:`GhostSecretDecl.source: 'login-email'`(user 归一化省略;禁 url、禁 exchange——登录邮箱不外送交换端点)+ `GHOST_FETCH_METHODS` 放行 DELETE;(b) networkSlot:`getLoginEmail` dep + fail-closed 解析(未登录/缺邮箱/形态非法都拒且**错误消息不含邮箱原文**,守"邮箱不进沙箱"不变量),经 `inject.format: "pages_{value}"` 派生注入;(c) 设置页凭证行只读展示登录邮箱(i18n 4 语言);(d) 内置意识 `cindy-xd-pages`(audience=all,4 工具 pages_list / info / delete / get_worker_template,错误码映射 / 429+网络瞬时重试 / confirm 闸 / ip-guard 模板逐字对齐 MCP 版);(e) FORGE_GUIDE §2/§4.7/校验清单同步;已过 subagent 对抗 review(1 P1 邮箱泄沙箱已修)+ 定向测试。**短收敛已执行(同日,真机实测发现双入口时模型偏向老 MCP 后 Lizi 拍板)**:lizi-mcps 的 pages_list / info / delete / get_worker_template 四工具及 templates.ts 已删除,MCP 只剩 pages_deploy;list_tools / call_tool / deploy 的描述均已指路「站点管理找 Cindy XD Pages 意识」(lizi-mcps 729 测试全绿)。终局:二期 deploy 迁走后整包退役。
  - **二期已完成(同日,Lizi 拍板"彻底抽象成意识"后执行)**:(a) **目录过户通道**——ghost_call 新增顶层 `dir` 参数(cindy-tools 契约 + 手册同步):主机验证(realpath 归一化钳制在会话 workdir 内,symlink/junction 词法绕过被拒;排除 node_modules/.git/.env 及全部 .env.* 变体)、收集文件(500 files / 50MB/file / 256MB total)、发一次性限时票据(ghostId 绑定 + 10min TTL + 单次消费),元数据注入 `args.dir_deposit`(token + rel_paths 清单,绝对路径与字节不进沙箱),真身 `cindy-brain/dirDeposit.ts`;(b) **uploadDir 上传执行**——fetch-request 新增 `uploadDir: { token, fields?, fileFieldPrefix? }`(仅 POST、与 body/upload/as:'media' 互斥),networkSlot 凭票读盘代组 multipart(普通字段在前、file-N filename=相对路径、octet-stream,媒体全局串行闸内,filename 引号/CRLF 消毒);(c) **意识 v1.1.0 加 pages_deploy**——preset 按 rel_paths 判定(package.json 依赖信号缺失→needs_user_confirm 如实降级;非法 preset 显式拒)、user_facing_markdown 输出对齐 MCP 版;(d) **lizi_xd_service 整包退役**——xd-service/ 目录、server/registry、providers/types/index 注册、desktop 适配器、builtin-plugins 插件项与映射、i18n 四语言 plugin 文案全删(存量 settings 残留键静默无害);(e) 已过第二轮 subagent 对抗 review:P1-1 symlink 钳制(realpath)、P1-2 i18n 孤儿 key 均已修,P2 采纳 .env.* 前缀排除 / preset 非法值显式拒 / 注释改准。**已知缺口(规则 26,待跟踪)**:SSH 远程工作区下 dir 过户读的是本机文件系统(LiziMcpSessionContext 无 remote 标记无法探测)——Windows 主机会误报"目录不存在",POSIX 主机同名路径有静默错传风险;老 MCP 版同样局限(非回退),需后续给 SessionContext 补 remote 标记做 fail-closed。**行为变化对存量用户**:目录总量限额 500MB→256MB(内存封顶刻意收紧);deploy 瞬时失败不再自动重试(票据单次消费,重试需主 agent 重新过户)。
- [x] **lizi_ssh** — 3;desktop ConnectionPool 建 SSH 连接 → 主机连接池 + 本机网络栈,不迁
- [x] **lizi_feishu_bot** — 2;主进程 bot 出站通道 + 读本地文件 → 主机本体,不迁
- [x] **lizi_browser** — 1;host 注入的浏览器 runtime(RSB/webview)→ 主机 runtime,不迁
- [x] **lizi_slack_bot** — 1;同 feishu_bot,仅 slack session 注入 → 主机本体,不迁

### ➖ 无可迁项

- [x] **slack** — 远程托管 MCP,本地 0 工具,工具清单在 Slack 官方侧;本身已在进程外,无迁移对象。

## 3. 盘点收口状态(2026-07-16 更新)

- **已收口 21 / 21,可意识化的清零**:已迁并摘壳 **10 家**(lizi_web_search → cindy-web-search、lizi_mivo → xd-mivo、lizi_xd_service → xd-pages、lizi_google → filo-google、lizi_jira + lizi_confluence → xd-atlassian、lizi_github → cindy-github、lizi_gitlab → cindy-gitlab、slack 官方托管 → cindy-slack(07-15)、**lizi_feishu → xd-feishu(07-16,后端留任)**;另 lizi_art 先期退役、图像后端迁 cindy-proxy-media 供 cindy-art);确认留主机 **11 家主机本体** + 新增 lizi_contacts(本地 SQLite 通讯录,主机本体,不迁)。
- **平台能力全景**(逐个迁移过程中沉淀,详见 `capability-permissions.md` §7 / §7.5):network 槽(C4,2026-07-12)→ as:'media' 取件 / exchange 二段式 / upload 上传(07-13)→ OAuth 直连 + as:'file' & save_dir 票据 + dir 目录过户(07-13)→ OAuth tokenBroker 模式 + 53682 端口自愈(`6fe0b2ae6`/`7e32c3729`)、notify 槽(`c5e38c747`)、fs 槽三档守门(`be6c3a19d`)、grant_only 批量预授权(`67f88cd33`)与过户授权记忆(`897b12c05`/`bc1e34ded`/`92723167d`)(07-14)。
- **out_file 泄洪回归**(07-14/15):老 MCP「大结果落 workdir 只交路径」语义借 fs 槽 workdir 档回归——xd-atlassian 首发(`e1ad35ffe`),cindy-github / cindy-gitlab 同款跟进(call_tool 层 out_file 参数 + 超 50KB 自动泄洪,各 v1.1.0)。
- **剩余跟踪项(2026-07-15 盘点)**:
  1. **as:'media' 对 octet-stream 的 magic-byte 嗅探兜底**——OSS 常给 GLB 吐 application/octet-stream,当前 `networkSlot.ts` 取件完全依赖 content-type,命中即拒;xd-mivo 3D 取件真机 QA 的前置(§2 mivo 条目原跟踪事项)。
  2. **SessionContext remote 标记 → dir 过户 / fs 槽 fail-closed**——SSH 远程工作区下 dir 过户读的是本机文件系统,realpath 只能兜住"路径不存在"的一半,POSIX 主机同名本地路径仍有静默错传风险;需给 `LiziMcpSessionContext` 补 remote 标记(§2 xd-service 条目原已知缺口;fs 槽 workdir 档已靠 session 快照的 remoteHostId 显式拒,dir 过户侧仍缺)。
  3. **手机端老 mivo 按钮下线**——`apps/mobile` 的 NormalizedToolMediaActions 仍会渲染老 MCP 历史消息的 mivo 动作按钮,待降级为纯展示(§2 mivo 条目原「另行跟进」)。
