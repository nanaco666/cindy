# Discord Bot 技术方案(P1 · DM)

> 配套文件:`feature-discord-bot.md`(验收)· `feature-discord-bot-plan.md`(实施计划)。
> 本文回答"怎么实现";范围、验收、分期见验收文件。

## 1. 分层与依赖

```
┌ renderer  Settings/DiscordBotSection ──ipc──┐
├ desktop main                                 ▼
│   im/index.ts ──wireDiscordOrchestrator──▶ im/shared/*(编排层,零改动)
│   im/discord/{adapter,uiText,index}.ts       │ ImChannelAdapter
│   im/host.ts(IMHost 装配 + createDiscordIM) │
├ packages/lizi-im(electron-free)             ▼
│   src/discord/{index,gateway,codec,markdown,chunk,components,streamingText}.ts
│   依赖: discord.js v14(新增;Gateway WS + REST 全托管)
└ Discord(Gateway WSS 出站直连 + REST;无公网回调,无 server relay)
```

与飞书/Slack 的定位差异:**直连 + token 本机 safeStorage**(飞书模式),
非 Slack 的 server relay 模式。

## 2. 已核定常量(2026-07 核对)

| 常量 | 值 | 依据 |
|---|---|---|
| Gateway intents(P1) | `Guilds \| DirectMessages` | DM 内容豁免 MESSAGE_CONTENT 特权 intent(官方 FAQ:bot 在 DM、被 @、自己的消息里恒可读 content)→ **P1 用户无需在 Portal 开任何特权 intent** |
| discord.js Partials | `Partials.Channel` 必开 | discord.js 不缓存 DM channel,不开收不到 DM(已知 gotcha) |
| 消息长度上限 | 2000 字符(发送与编辑同限) | `MAX_MESSAGE_LEN = 2000`,分段阈值 1900 |
| 出站附件上限 | **8 MiB**(保守值) | 2025-01 起默认上限 10 MiB,bot 实测口径有 8 MiB 记录;取 8 MiB,超限 `TOO_LARGE`。实现时以实际 413 响应兜底 |
| 入站附件上限 | 50 MiB | 对齐飞书/Slack 既有策略(超限进 unsupported,不下载) |
| 流式编辑节流 | 1300 ms | 对齐 `slack/streamingText.ts` 的 `UPDATE_THROTTLE_MS`;低于编辑限流(≈5 次/5s/频道) |
| Button 组件 | ≤5 按钮/行,≤5 行;`custom_id` ≤100 字符 | 官方组件文档 |
| Interaction ACK | 3 秒内;用 type 6 `DEFERRED_UPDATE_MESSAGE` | 按钮按压先 defer,真正的卡片更新走编排层的 `updateInteractiveCard` |

## 3. 模块设计(packages/lizi-im/src/discord/)

| 文件 | 职责 | 关键接口 |
|---|---|---|
| `index.ts` | `DiscordIM extends BaseIM implements ChannelIM`;组合下面所有模块;secrets 读写;ipc 注册 | `createDiscordIM(host, opts?)` |
| `gateway.ts` | discord.js Client 生命周期:login/destroy、事件转发、状态归一、重放去重 | `createDiscordGateway(cfg): DiscordGateway` |
| `codec.ts` | 两类编码:`messageId = "{channelId}\|{messageId}"`;button `custom_id` 编解码 | `encodeMessageId/decodeMessageId/encodeCustomId/decodeCustomId` |
| `markdown.ts` | maker markdown → Discord markdown(大部分透传;表格降级代码块;剥 HTML;xdt-image 链接摘出交上传) | `markdownToDiscord(md): { text, imageUrls }` |
| `chunk.ts` | 2000 分段,代码块围栏不拦腰断(断点处补 ``` 闭合/重开) | `chunkDiscordText(text, limit=2000): string[]` |
| `components.ts` | `InteractiveCardSpec` ↔ Discord embed + button rows;interaction → `IMCardActionEvent` | `buildCardMessage(spec)` / `parseInteraction(i)` |
| `streamingText.ts` | send 首条 + 1300ms 节流 PATCH;finalize 超 2000 时余量按后续消息补发 | `startStreaming(deps, ...): StreamingTextHandle` |

### 3.1 身份与密钥

- secrets(经 `host.secrets`,safeStorage 加密落盘):
  `discord-bot-token`、`discord-owner-user-id`。
- `botContextId` = bot **application id**(login 后从 `client.application.id` 取,
  同时缓存 bot user tag 供 UI 显示)。
- ipc(`registerIpc`,命名对齐 feishu 现有 `im:*` 前缀,实现时以 feishu
  `registerIpc` 实际频道名为准):
  `im:discord:set-config { token, ownerUserId }` / `im:discord:get-status` /
  `im:discord:disconnect`;状态推送 `host.ipc.broadcast('im:discord:status', IMStatus)`。

### 3.2 状态机(IMStatus 映射)

```
idle(无 token)
  → connecting(login 中 / 断线重连中)
  → connected { appId: botUserTag }(ready)
  → error { reason }(token 无效 4004 / intents 被拒 4014 / 其他致命关闭码)
```
- 非致命断开(网络抖动、RESUME 失败重新 identify)由 discord.js 内部重试,
  期间对外呈现 connecting,**不进 error**。
- `conflict` 状态 P1 不用(Discord 允许同 token 多连接,无飞书式抢占语义)。

### 3.3 入站管线(MESSAGE_CREATE → IMMessageEvent)

过滤链(顺序,借鉴 hermes `on_message`):

1. `author.id === client.user.id` 或 `author.bot` → 丢弃;
2. 非 DM(`channel.type !== DM`)→ 丢弃(P1;guild 消息静默);
3. `author.id !== ownerUserId` → 丢弃(不回任何提示,避免被陌生人探测);
4. 重放去重:LRU(容量 512)记 message id,命中丢弃
   (覆盖 RESUME 重放与 discord.js 罕见重复派发)。

归一化(与 `IMMessageEvent` 契约逐字段):

| 字段 | 取值 |
|---|---|
| `channelName` | `'discord'` |
| `senderId` | `author.id`(snowflake) |
| `chatId` | DM channel id |
| `contextId` | application id |
| `messageId` | `encodeMessageId(channelId, message.id)` |
| `text` | `message.content`(reply 引用不展开,P1 不带 quote 上下文) |
| `attachments` | image/file 下载到 `host.paths.discordMediaDir` 后的 `IMAttachment[]` |
| `unsupported` | >50 MiB(`oversize`)、sticker(`sticker`)、语音消息(`audio`)、下载失败(`download`) |
| `threadTs`/`scopeKey` | 恒 `undefined`(DM 无 thread) |

附件下载走 CDN url(`attachment.url`),文件名冲突加序号;
mime 以 `attachment.contentType` 为准,缺省按扩展名推断。

### 3.4 出站管线

所有出站先解析 DM channel:`client.users.fetch(userId).createDM()`,
结果按 userId 缓存(进程内 Map,断线重连后失效重建)。

- `sendText` / `sendMarkdownText`:markdown 映射(仅后者)→ `chunkDiscordText`
  → 逐段 `channel.send`;返回**首段** messageId(编码后)。
- `sendInteractiveCard`:`buildCardMessage(spec)` → embed(title/body)+ button rows。
  `custom_id = encodeCustomId(buttonId, payload)`;JSON 超 100 字符时降级:
  `custom_id = "ref:" + token`,payload 存进程内 LRU(容量 256)——卡片是短生命周期
  交互,重启后旧卡按钮失效可接受(与飞书卡片过期语义一致,点击回"卡片已过期")。
- `updateInteractiveCard` / `patchMarkdownCard`:`decodeMessageId` → REST PATCH
  (后者 `components: []` 清按钮)。
- `sendFile`:>8 MiB 直接 `{ ok:false, reason:'TOO_LARGE' }`;REST 413 → 同样归
  `TOO_LARGE`;其他失败 `UPLOAD_FAIL`。
- `reactToMessage`:`message.react(emoji)`,emoji 用原生字符(`'👀'`),
  返回 token = emoji 本身;`removeMessageReaction` 按 emoji+self 撤。
- 流式:首条 send(`initial ?? '…'`)→ append/replace 进缓冲 → 1300ms 节流 PATCH
  (超 1900 字符停止编辑,finalize 时把余量 `chunkDiscordText` 后补发新消息)→
  finalize 做 markdown 映射 + xdt-image 上传(`resolveImageUrl` 注入,同 Slack)。

### 3.5 卡片交互(INTERACTION_CREATE)

```
按钮按压 → interaction.deferUpdate()(3s 窗口内 ACK,无 UI 变化)
        → parseInteraction → IMCardActionEvent{ senderId, chatId,
          messageId=encodeMessageId(...), buttonId, payload } → onCardAction
        → 编排层 cardActionHandler 决定后续(updateInteractiveCard 收口)
```
非 owner 用户按压(理论上 DM 内不会发生)→ defer 后忽略。

## 4. host 侧接线(apps/desktop)

- `shared/sessionSource.ts`:`SessionSource` 加 `'discord'`;
  `localDb/schema.ts:15` `SESSION_SOURCES` 加 `'discord'`(drizzle text enum,
  TS 层校验,无 DB CHECK → **无需 migration**)。
- `im/shared/types.ts:24`:`ImChannelName` 加 `'discord'`。
- `im/discord/adapter.ts`(全量见验收文件 §4②):非 threadScoped;
  `sessionIdFor = discord_{appId}_{userId}`;复用 `imBotContextId/imUserId` 通用列;
  `processingEmoji: '👀'`;`buildVendorOptions = { discordChatId, source:'discord' }`。
- `im/discord/uiText.ts`:完整 `ImUiTextPack`(`thread` 段省略),文案基调对齐
  slack `uiText.ts`,"Slack"字样替换为"Discord"。
- `im/host.ts`:`paths.discordMediaDir = userData/cc-agent/discord-media`;
  `export const discordIm = createDiscordIM(host, { resolveImageUrl })`;
  `createIM([feishuIm, slackIm, discordIm])`。
- `im/index.ts`:`DISCORD_CONFIG`(agentKind/defaultModel/defaultPermissionMode
  取值抄 SLACK_CONFIG)+ `wireDiscordOrchestrator`;binding cleanup 按
  `index.ts:157` 注释加 discord 分支。

## 5. Settings UI

`DiscordBotSection.tsx` + `useDiscordBot.ts`(ipc 走 §3.1 频道):

- 表单:Bot Token(password)、我的 Discord 用户 ID(必填,校验 snowflake 纯数字)、
  Connect / Disconnect、状态行(connected 显示 bot tag)。
- 四步引导文案(含外链):建 App/Bot → **无需开特权 intent(P1)** →
  OAuth2 邀请链接(scope `bot`;权限 Send Messages / Read Message History /
  Attach Files;提示"DM 需要与 bot 有共同 server")→ 开发者模式复制用户 ID。
- i18n:zh-CN / en / ja / ko。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| discord.js 打包体积(≈1–2 MB min) | 仅 main process 依赖,不进 renderer bundle;超预算再评估 @buape/carbon / 裸 ws |
| `custom_id` 100 字符不够放 payload | `ref:` token + 进程内 LRU 降级(§3.4);重启后旧卡失效提示 |
| 编辑限流导致流式 429 | 1300ms 节流 + discord.js 内置全局限流队列兜底 |
| 附件上限口径不一(8/10 MiB) | 常量 8 MiB + 413 响应兜底归 TOO_LARGE |
| 用户忘开 Message Content(P2 才需要) | P1 不受影响;P2 接 guild 时 probe 探测并在 UI 明示 |
| DM 前置条件(共同 server) | 引导文案明示;connect 成功但收不到消息时的 FAQ 提示 |
