# 设计方案(DRAFT / 待评审):远程控制模型选择 1:1 镜像本地「供应商 + 模型」结构

> 状态:**草案,待 owner(device-link / 远程控制)+ model-providers 双方 review 后再实现**。
> 作者:Lizi(model-providers) + Claude。背景见仓库根 `CLAUDE.md` 规则 22、`docs/device-link-server-split.md`。
> 关联:`9fe1b6f97 fix(desktop): 远程会话模型选择器恢复「以被控端为准」`(已修「列表来源」回归,本方案是其后续——把「供应商维度」也补齐)。

---

## 1. 背景与问题

本地模型选择已经是 **provider-first** 结构:同一个 model id(如 `gpt-5.5`)可挂在多家供应商下(Anthropic / OpenAI / XD / 自定义),列表按供应商分段 + icon,用户能选「用哪家来源跑这个模型」,选择经 `sessions.provider_id` 落地、决定路由。

但 **device-link 远程会话**目前刻意退化成扁平列表:

```ts
// ModelSelector.tsx:277
const sourcesEnabled = !!onProviderChange && !deviceId;   // device-link → false
// ChatInput.tsx:2597  handleProviderChange
if (sessionId && getSessionDeviceId(sessionId)) return;   // 远程切来源 = no-op
```

后果(均已在代码中确认):
1. **列表与本地不一致**:远程是扁平无 icon、按 id 去重(`deriveAvailableModels` first-wins),本地是分段多供应商。
2. **同 id 多供应商够不到**:被控端若 OpenAI 和 xdproxy 都提供 `gpt-5.5`,控制端只看到 1 行,且无法指定走哪家 → 其中一家**从控制端永远够不到**。
3. **静默路由**:控制端发出去的只有 model id 字符串(`buildDeviceLinkCreateArgs` 无 providerId),被控端按自己的默认路由跑,控制端**不可见、不可控**(潜在计费/行为差异)。

**目标**:远程控制时,模型选择器 1:1 镜像本地的「供应商 + 模型」结构——列被控端的供应商、能按供应商选来源、选择在被控端落地并回流控制端。

---

## 2. 目标 / 非目标

**目标**
- 远程会话的模型选择器展示**被控端**的供应商结构(分段 + icon + 同 id 多供应商多行),与本地 picker 同构。
- 控制端能为远程会话**选择来源(providerId)**,并真实作用于被控端的路由(create + 运行时切换两条路径)。
- 选择在被控端**持久化**(`sessions.provider_id`),跨重启/resume 不丢;并**回流**控制端镜像。

**非目标**
- 不把控制端本地的供应商/密钥泄漏给被控端,反之亦然(各端供应商独立)。
- 不在控制端为远程会话写本地 `providerModelMemory`(远程一律「以被控端为准」,镜像而非本地记忆)。
- 不改 server 端 Device 表 / 不引入 server migration(`sessions.provider_id` 在 desktop Drizzle 库,已存在)。
- 不动 maker-core 的 prompt 组装 / tool 暴露 / translator / model 映射(规则 10/11 不触碰)。

---

## 3. 核心原则(沿用 device-link 不变量)

`docs/device-link-server-split.md` 的关键不变量:**被控端 = 唯一真相源,relay = 哑中继(不解析业务 payload),控制端 = 纯镜像;relay 帧上限 2MB**。

本方案是把这条原则从「能力(capabilities)」**自然扩展到「供应商(providers)」**:
- 读:供应商结构 source 自被控端(隧道 `maker:provider:list`),控制端按 deviceId 缓存镜像——与现有 `useAgentCapabilities(deviceId)` 的 device-scoping 机制同构。
- 写:控制端发 `setModel(sessionId, model, providerId)`,被控端是真相源——更新路由 + 持久化 `provider_id` + 回流 `sessions:patched`。
- 安全:`ProviderView = Provider + connected:boolean`,`Provider.auth` 只含 `{ method }`,**不含 api key/secret**;过隧道安全(需复核自定义供应商 routing 里的 endpoint 是否算敏感,见开放问题 Q3)。

---

## 4. 现状 plumbing(已确认,作为设计基线)

| 能力 | 现状 | file:line |
|---|---|---|
| 列供应商 IPC | `maker:provider:list` → `{ providers: ProviderView[] }`,已注册 | channels.ts:197 / providerHandlers.ts:44 / preload.ts:2187 |
| 切来源(运行时)| `maker:set-model` 已带可选第 3 参 `providerId`,handler 收到即 `setSessionProvider` | register.ts:3876 |
| set-model 已在隧道 allowlist | 是(CORE_INVOKE_CHANNELS) | allowlist.ts:75 |
| per-session 供应商存储 | `setSessionProvider/getSessionProvider/hydrateSessionProvider`(内存)| session-provider-store.ts:20 |
| DB 字段 | `sessions.provider_id`(NULL=默认路由)已存在 | localDb/schema.ts:59 |
| create 时落地 | `bootstrapSession` 从 DB 回填 `provider_id`(create 时恒 NULL)| register.ts:2055 |
| device 能力缓存机制 | `useAgentCapabilities(deviceId)` 按 `(deviceId,agentKind)` 隔离 + 代际驱逐 | useAgentCapabilities.ts |
| 回流 | `local-db:sessions:patched` 在 PUSH_FORWARD_ALLOWLIST | allowlist.ts:195 |

**两个缺口**:
- **G1(create)**:`MakerSessionCreateOpts` 无 `providerId`(sessionRequest.ts:5);新建远程会话只能 NULL → 默认路由。
- **G2(持久化)**:`persistRemoteSetting`(dispatch.ts:123)的 `SET_CHANNEL_FIELD` 不含 `providerId`;远程 `set-model` 带的 providerId 只进了被控端**内存** store,**没写 DB** → 被控端重启/resume 后 `hydrateSessionProvider` 读 NULL,选择丢失。

---

## 5. 设计

### 5.1 读路径:控制端镜像被控端供应商
- **允许通道**:`packages/device-link/src/allowlist.ts` 的 `CORE_INVOKE_CHANNELS` 增加 `maker:provider:list`(只读)。
- **字段裁剪(D3)**:被控端返回前把 `ProviderView` 投影成"仅显示用"的最小集——保留 `id/name/agents/connected` + `models[agent]`(id/name/efforts/defaultEffort/effortDisplayNames/supportsFastMode/contextWindow/defaultEnabled),**剥掉 `routing`(含自定义供应商 endpoint)等执行字段**。控制端只渲染、不执行,执行细节(路由/密钥)不出被控端。需先核实 renderer 侧 `nativeDefaultSourceId/getModel/providerOffersModel/connectedProvidersForAgent` 是否读 `routing`——若不读则可安全剥离(预计不读,待确认)。
- **device-scoped useProviders**:新增 `useProviders(deviceId?)` 变体(或并行 hook),deviceId 非空时隧道 `maker:provider:list` 到被控端、按 `deviceId` 缓存 + 代际驱逐——**直接复用 `useAgentCapabilities` 的缓存/inflight/`deviceGen` 驱逐范式**(避免下线/重连后串旧供应商)。deviceId 省略 → 现有本地路径,逐字节不变。
  - 注意 2MB 帧上限:`ProviderView[]`(含各 agent 的 model 元数据)体量为 KB 级,远低于上限;若未来自定义供应商极多需留意。

### 5.2 ModelSelector:解除 device-link 限制,喂被控端 providers
- `sourcesEnabled` 由 `!!onProviderChange && !deviceId` 改为 `!!onProviderChange`(去掉 `&& !deviceId`),**但 `providers` 来源切成 device-scoped**(deviceId 非空用被控端 providers)。
- `connected` / `activeSourceId` / `sections` / 空态 CTA 全部改吃 device-scoped providers。
- **D4**:远程上下文(deviceId 非空)隐藏底部「+ 连接来源」footer(控制端无法替被控端连来源)。
- 之前的 `selectVisibleModels`(本次回归修复引入)在 device-link 分段模式下被 `sections` 路径取代;flat 回退仍保留(被控端 0 供应商 / 能力未到位时)。
- `currentAgentKind`:device-link 一定带 `vendorKey` → 直接用,不走本地 providers 反推。

### 5.3 写路径(运行时切换,已建远程会话)
- `ChatInput.handleProviderChange` 去掉 `if (sessionId && getSessionDeviceId(sessionId)) return;`,改为 device-link 分支:`await makerApiFor(sessionId).setModel(sessionId, model, providerId)` + `setEffort`(沿用现有远程 setModel/setEffort 的 **await + 失败 toast + 不写本地偏好** 范式,见 ChatInput:2457-2473)。
- **不写本地 `providerModelMemory`**(远程镜像,不落本地记忆;见非目标)。

### 5.4 写路径(create,新建远程会话)
**默认选择(D1)**:新建远程草稿的默认 model/provider 以被控端为准——默认来源 = 被控端 `nativeDefaultSourceId`;默认 model = 控制端记忆若被控端 offer 则保留、否则 reconcile 到被控端默认。不套控制端本地 prefs 的 default。

两个方案,**推荐 A**:
- **方案 A(create 带 providerId,race-free)**:`MakerSessionCreateOpts` + `buildDeviceLinkCreateArgs` 增加可选 `providerId`;被控端 create 时把它写进 `sessions.provider_id`(在 `bootstrapSession` 的 hydrate 之前/同时),使**首个请求**即按所选来源路由。需确认 create 的 DB 行插入点能接 providerId(可能轻触 maker-core `CreateSessionOptions` 或在 desktop 侧 create 后补写 DB——见开放问题 Q1)。
- **方案 B(create 后补 setModel)**:create 不变,建完立刻隧道 `setModel(sessionId, model, providerId)`。简单、不碰 create opts,但有「首个 turn 可能先用默认路由」的竞态窗口。

### 5.5 缺口修复
- **G2**:扩展被控端 `persistRemoteSetting`——`maker:set-model` 特例,除 `model` 外把 `args[2]`(providerId)也持久化进 `sessions.provider_id`(与本地 `sessionService.update({providerId})` 等价)。这样远程切来源跨重启不丢。
- 确保 `sessions:patched` 回流 **包含 providerId**,控制端 mirror(`remoteProjectsStore` / `selectedProviderId`)据此更新高亮(需确认 patch 生成是否带 provider_id 字段——开放问题 Q2)。

### 5.6 provider 记忆
- 远程:**不读不写** `providerModelMemory`(本地 localStorage、`${agentKind}:${providerId}`,无 deviceId 隔离,远程写会与本地串)。远程的 (provider,model) 选择由**被控端 DB** 持久化,控制端镜像即可。

---

## 6. 协议改动清单(给 review 聚焦)

| # | 改动 | 文件 | 类型 |
|---|---|---|---|
| 1 | allowlist 增 `maker:provider:list`(只读) | packages/device-link/src/allowlist.ts | 协议 |
| 2 | device-scoped `useProviders(deviceId)` | apps/desktop/src/renderer/hooks/useProviders.ts(+ 新建 hook)| renderer |
| 3 | ModelSelector 解除 `&& !deviceId` + 喂 device providers | ModelSelector.tsx | renderer |
| 4 | handleProviderChange device-link 分支走隧道 setModel(providerId) | ChatInput.tsx | renderer |
| 5 | persistRemoteSetting 持久化 set-model 的 providerId(G2) | apps/desktop/src/main/device-link/dispatch.ts | 被控端 |
| 6 | create 带 providerId(方案 A)| sessionRequest.ts / deviceLinkCreateArgs.ts / bootstrapSession | 协议 + 被控端 |
| 7 | sessions:patched 回流含 providerId + 控制端 mirror 应用(G2 回流半边)| register.ts / remoteProjectsStore | 被控端 + renderer |

---

## 7. 时序

**运行时切来源(已建远程会话)**
```
控制端 ModelSelector 选(provider=openai, gpt-5.5)
  → handleProviderChange(remote 分支)
  → deviceLink.invoke(deviceId, 'maker:set-model', [sid, 'gpt-5.5', 'openai'])
被控端 dispatch.runInvoke → allowlist 通过 → dispatchLocalInvoke('maker:set-model', [...])
  → setSessionProvider(sid,'openai') + sess.setModel('gpt-5.5')
  → persistRemoteSetting: 写 sessions.{model,provider_id}   ← G2 修复
  → 广播 local-db:sessions:patched {model, providerId}        ← 回流
控制端 收到 patched → remoteProjectsStore 更新 → ModelSelector 高亮 openai 行
```

**新建远程会话(方案 A)**
```
控制端草稿选(provider, model, effort, fast)
  → buildDeviceLinkCreateArgs({..., providerId})              ← 新增字段
  → deviceLink.invoke(deviceId, 'maker:create-session', [args])
被控端 bootstrapSession: createSession 时写 sessions.provider_id
  → hydrateSessionProvider 读到非 NULL → 首个请求即按所选来源路由
```

---

## 8. 不变量与对齐(self-check)
- ✅ 被控端唯一真相源:供应商结构、provider_id 持久化、路由决策都在被控端;控制端只镜像。
- ✅ relay 哑中继:新增 `maker:provider:list` 仍是 allowlist 直透,relay 不解析。
- ✅ 控制端纯镜像:不写本地 provider 记忆;高亮态由回流的 patched 驱动。
- ✅ 2MB 帧:ProviderView[] 为 KB 级。
- ✅ secret 不过隧道:ProviderView 不含 key(待复核自定义 routing endpoint,Q3)。
- ✅ 无 server migration:provider_id 在 desktop Drizzle 库,已存在。

---

## 9. 回归与测试点
- **本机/协同/定时不变**:deviceId 省略时所有路径逐字节同现状(useProviders 本地分支、ModelSelector flat/分段、handleProviderChange 本地落地)。
- **新单测**:
  - device-scoped useProviders 的缓存隔离 + 代际驱逐(仿 `agentCapabilitiesDeviceCache.test.ts`)。
  - `buildDeviceLinkCreateArgs` 透传 providerId(扩 `deviceLinkCreateArgs.test.ts`)。
  - persistRemoteSetting 对 set-model 的 providerId 持久化(被控端单测)。
  - 远程 handleProviderChange 走隧道(扩 `deviceLinkControllerScenarios.test.ts`)。
- **黑盒**(必须真机双端):被控端连一个控制端没有的自定义供应商 → 控制端远程 picker 出现该供应商行;选 openai 的 gpt-5.5 vs xd 的 gpt-5.5 → 被控端路由确实不同 + 重启后保持。

---

## 10. 分阶段(建议)
- **P1**:读路径 + 已建远程会话的运行时切来源 + G2 持久化 + 回流(改动 1–5、7)。即可解决「同 id 多供应商够不到」「静默路由」两个主要痛点(对已存在的远程会话)。
- **P2**:新建远程会话带 providerId(改动 6,方案 A)。补齐 create 路径。
- 不做 display-only 半成品(展示多供应商行却不能选 = 更糟)。

---

## 11. 决策(Lizi 已拍板 2026-06-23)
- **D1(列表 + 默认都以被控端为准)**:新建远程会话时,模型列表来自被控端 providers,**默认选中的 model/provider 也以被控端为准**——默认来源 = 被控端 `nativeDefaultSourceId`;默认 model = 控制端记忆若被控端 offer 则保留、否则 reconcile 到被控端默认(复用 `resolveSourceSwitch` 的 reconcile 口径)。**不**套控制端本地 prefs 的 default。
- **D2(回流必须带 providerId)**:改了来源就要同步回控制端。落地 = 补 `persistRemoteSetting` 持久化 set-model 的 providerId(G2)+ 确保 `sessions:patched` 回流带 provider_id + 控制端 mirror 消费它更新高亮。实现细节,无需额外拍板。
- **D3(过隧道只传"显示用"最小字段,执行细节不出被控端)**:控制端只需渲染列表所需信息——provider `id/name/agents/connected` + `models[agent]` 的 `id/name/efforts/defaultEffort/effortDisplayNames/supportsFastMode/contextWindow/defaultEnabled`。**剥掉 `routing`(含自定义供应商 endpoint)等执行用字段**,绝不过隧道。路由/密钥全留在被控端(它才是执行方)。→ 比"传完整 ProviderView"更安全,且符合「被控端=真相源」。需在隧道返回前做一道字段裁剪(allowlist 投影)。
- **D4(远程隐藏"连接来源" footer)**:远程上下文下 ModelSelector 底部「+ 连接来源」CTA 隐藏(控制端无法替被控端连来源)。
- **D5(create 落地点,实现细节)**:create 时 `provider_id` 的写入**倾向 desktop 侧 create 后补写 DB,不碰 maker-core**(只是数据字段,但能不碰核心就不碰)。无需拍板,实现时定。

---

## 12. 工作量与风险
- 工作量:中(P1 约 5 个改动点 + 测试;P2 再 1 个)。最大单块是 device-scoped `useProviders`(要正确复刻代际驱逐,防串设备)。
- 风险:协议层改动(allowlist + create opts),属远程控制 owner 领域 → **本方案需其 review 通过再实现**。其余为 renderer + 被控端持久化,风险可控。
- no-break:全部改动以 `deviceId` 为开关;本机/协同/定时路径不进新分支。
