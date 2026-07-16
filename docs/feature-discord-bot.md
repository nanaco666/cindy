# Feature: Discord Bot(connect Discord server)

> 状态:设计稿 / 验收文件(未实现)。
> 模板:`docs/feature-slack-bot.md`(Slack 渠道)+ `packages/lizi-im` 渠道抽象。
> 外部参考实现(本机可查源码):
> - `~/openclaw/extensions/discord/`(TS,@buape/carbon,ChannelPlugin 契约)
> - `~/hermes-agent/gateway/platforms/discord.py`(Python,discord.py,BasePlatformAdapter)

## 1. 目标与范围

让用户在 maker Settings 里连接自己的 Discord bot,与飞书/Slack 同级:
Discord 用户 DM bot ↔ 一个持久 maker session(`sessions.source = 'discord'`),
支持流式回复、卡片交互(权限/ask/plan/model)、文件收发、/ctr 接管。

**分期:**

| Phase | 范围 | 说明 |
|---|---|---|
| **P1(本文件验收对象)** | **DM 私聊** | 个人助理模式,对齐 lizi-im 现有 p2p-only 语义 |
| P2 | Guild 频道 + @mention + auto-thread | thread = session(复用 Slack 的 threadScoped 模型,scopeKey = thread id) |
| P2.5 | `lizi_discord_bot` MCP(send_file_to_user 主动推送) | 对齐 `lizi_slack_bot` |

P1 明确不做:guild 消息响应(收到直接忽略)、slash command 注册、语音、webhook 分身。

## 2. 架构决策(已定)

1. **直连,不走 server relay。** Discord Gateway 是 bot 出站 WSS 长连接,无需公网回调
   → 学飞书模式:desktop 主进程直连,bot token 用 safeStorage 本机加密(`host.secrets`)。
   不同于 Slack(token 在 server、SSE relay)。
2. **库选型:`discord.js` v14+**,作为 `packages/lizi-im` 的依赖。
   理由:心跳/RESUME/限流/分片全部内置,维护成本最低;desktop 打包体积可接受。
   备选:`@buape/carbon`(openclaw 用,更轻)或裸 `ws` + REST(hermes 证明核心面只有
   connect/send/edit/react 四类调用)。若打包体积超预算再降级。
3. **会话模型(P1):** DM 无 thread → 非 threadScoped,同一
   `(botContextId, discordUserId)` 恒同一 session(对齐飞书)。
   `botContextId` = bot 的 application id。
4. **权限模型(P1):** Settings 里必填「我的 Discord 用户 ID」,只响应该用户的 DM,
   其他人 DM 静默忽略。配对码流程(openclaw/hermes 的 pairing)留到 P2。
5. **messageId 编码:** Discord 编辑/回应消息需要 `channel_id + message_id` 两段
   → `messageId = "{channelId}|{messageId}"`,对齐 Slack 的 `"{channelId}|{ts}"` 编码
   (`blocks.ts` codec 同款思路,放 `discord/codec.ts`)。

### 实现前必须核对的官方文档(不许凭记忆写,逐条验证后回填本节)

- [ ] Gateway intents 位值:P1 只需 `Guilds | DirectMessages`;
      **MessageContent intent 只影响 guild 消息,DM 内容不需要它**(P2 才必须开)。
- [ ] bot 上传文件大小上限(默认 25MiB?)→ `sendFile` 的 TOO_LARGE 阈值。
- [ ] 消息编辑限流(约 5次/5s/频道)→ 流式 throttle 间隔取值。
- [ ] 消息/编辑 2000 字符上限;embed 是否走不同上限。
- [ ] Button 组件:每行 ≤5 按钮、≤5 行;INTERACTION_CREATE 需 3 秒内 ACK
      (type 6 DEFERRED_UPDATE_MESSAGE),不需要额外 intent。

## 3. 数据流(P1)

```
Settings(DiscordBotSection) ──存 token+userId(safeStorage)──▶ DiscordIM.init()
  └─ probe: GET /users/@me(验 token、取 bot 名)+ GET /gateway/bot(WS url)
DiscordIM(lizi-im, Gateway WS 直连)
  └─ MESSAGE_CREATE(DM, sender==允许的 userId)
       → 附件下载到 discordMediaDir → 归一化 IMMessageEvent
       → im/shared 编排层(orchestrator/messageHandler/turnRunner, 零改动)
       → bindingStore / sessionIdFor → session(source='discord')
       → agent 回复 → adapter.im.sendMarkdownText / startStreamingText
       → DiscordIM: markdown 映射 + 2000 分段 + 流式 edit 节流 → Discord
```

## 4. 改动清单

### ① `packages/lizi-im`(传输层,新增 `src/discord/`)

```
src/discord/
  index.ts          DiscordIM extends BaseIM implements ChannelIM
  gateway.ts        WS 生命周期封装(discord.js Client / 心跳 / RESUME / 重连 / 去重)
  markdown.ts       maker markdown → Discord markdown 映射(对位 slack/mrkdwn.ts)
  components.ts     InteractiveCardSpec ↔ Discord buttons/embeds + messageId codec
                    (对位 slack/blocks.ts)
  chunk.ts          2000 字符分段(保代码块围栏,对位 openclaw discord/chunk.ts)
  streamingText.ts  send + 节流 edit 的流式 handle(对位 slack/streamingText.ts;
                    finalize 超 2000 时余量以后续消息补发)
```

- `src/index.ts` 导出 `createDiscordIM` + `DiscordIM` 类型。
- `src/types.ts`:`IMHost.paths` 加 `discordMediaDir?: string`(可选,对齐 slackMediaDir)。
- `package.json`:加 `discord.js` 依赖。

**DiscordIM 骨架:**

```ts
// packages/lizi-im/src/discord/index.ts
export interface DiscordIMOptions {
  resolveImageUrl?: (url: string) => string; // xdt-image:// → absPath(同 SlackIMOptions)
}

export class DiscordIM extends BaseIM implements ChannelIM {
  // name = 'discord';secrets keys: 'discord-bot-token' / 'discord-owner-user-id'
  constructor(host: IMHost, opts: DiscordIMOptions = {}) { super('discord', host); }

  // ── lifecycle(BaseIM)──────────────────────────────────────────────
  async init(): Promise<void> {}     // 读 secrets → 无 token 则 idle;有则 connect
  async dispose(): Promise<void> {}  // gateway destroy
  registerIpc(): void {}             // im:discord:set-config / get-status / disconnect
                                     // (供 Settings 页;命名对齐 feishu/slack ipc)

  // ── inbound ───────────────────────────────────────────────────────
  onMessage(h: (e: IMMessageEvent) => void): () => void {}
  //   MESSAGE_CREATE 过滤链(顺序照 hermes on_message):
  //   ①自身/bot 消息 ②非 DM(P1 丢弃) ③sender != ownerUserId ④RESUME 重放去重
  //   附件:下载到 host.paths.discordMediaDir,>50MiB 进 unsupported(对齐飞书);
  //   audio/video/sticker 进 unsupported。
  //   归一化:senderId=user id / chatId=DM channel id / contextId=application id /
  //   messageId=codec 编码 / threadTs,scopeKey 恒 undefined(P1)。
  onCardAction(h: (e: IMCardActionEvent) => void): () => void {}
  //   INTERACTION_CREATE(button) → 3s 内 deferred ACK → 解 custom_id 出
  //   buttonId+payload(codec 对齐 slack decodeActionId)
  onStatusChange(h: (s: IMStatus) => void): () => void {}
  //   idle→connecting→connected{appId=botUser.tag};invalid token→error;
  //   另一进程抢占同 token(gateway 4005?)→ 归入 error(P1 不做 conflict 细分)

  // ── outbound(全部先 resolve DM channel:POST /users/@me/channels 缓存)──
  async sendText(userId, text, opts?) {}          // 分段发,返回首段 messageId
  async sendMarkdownText(userId, md, opts?) {}    // markdown.ts 映射后分段发
  async sendInteractiveCard(userId, spec, opts?) {} // embed(title+body) + buttons
  async updateInteractiveCard(messageId, spec) {}   // PATCH 消息(codec 解出两段 id)
  async patchMarkdownCard(messageId, md) {}         // PATCH 成纯文本,components: []
  async startStreamingText(userId, initial?, opts?) {} // streamingText.ts
  async sendFile(userId, absPath, displayName?, opts?) {} // multipart 上传;
                                                    // 超限 → { ok:false, reason:'TOO_LARGE' }
  async reactToMessage(messageId, emoji) {}   // PUT reaction;token = emoji 本身
  async removeMessageReaction(messageId, token) {}
  // threadKeyForMessage 不实现(P1 无 thread)

  getStatus(): IMStatus {}
}

export function createDiscordIM(host: IMHost, opts?: DiscordIMOptions): DiscordIM {}
```

### ② `apps/desktop/src/main/im`(编排接线;`im/shared/*` 零改动)

- `shared/types.ts:24`:`ImChannelName` = `'feishu' | 'slack' | 'discord'`。
- 新增 `discord/`:
  - `uiText.ts`:完整 `ImUiTextPack`(逐字段,缺编译报错;`thread` 段省略)+
    `PROCESSING_EMOJI = '👀'`(Discord reaction 用原生 emoji 字符,非 slack 式名字)。
  - `adapter.ts`:`buildDiscordAdapter(discordIm, config)`(骨架见下)。
  - `index.ts`:`wireDiscordOrchestrator(...)`(对位 `slack/index.ts`)。
- `host.ts`:`paths` 加 `discordMediaDir`;`export const discordIm = createDiscordIM(host, { resolveImageUrl })`;`createIM([feishuIm, slackIm, discordIm])`。
- `index.ts`:`DISCORD_CONFIG`(agentKind/defaultModel/defaultPermissionMode 对齐 slack)
  + 接线;binding cleanup hook 按 `index.ts:157` 注释加 discord 分支。

**adapter 骨架:**

```ts
// apps/desktop/src/main/im/discord/adapter.ts
export function buildDiscordAdapter(im: DiscordIM, config: ImOrchestratorConfig): ImChannelAdapter {
  return {
    channel: 'discord',
    im, config, ui,
    // P1 无 threadScoped(DM 无 thread;P2 guild 时改 true)
    sessions: {
      source: 'discord',
      // 确定性 id;Discord id 是纯数字 snowflake,无需转义
      sessionIdFor: (appId, userId) => `discord_${appId}_${userId}`,
      defaultTitle: (userId) => `Discord · ${userId.slice(-6)}`,
      generatedTitlePrefix: 'Discord · ',
      ensureWorkingDir: (appId) => /* userData/im-working-dir/discord-{appId} */,
      extraInsertColumns: (appId, userId) => ({ imBotContextId: appId, imUserId: userId }),
      // ↑ 复用 slack 引入的 IM 通用列,DB 不加新列
    },
    processingEmoji: '👀',
    buildVendorOptions: (userId) => ({ discordChatId: userId, source: 'discord' }),
    // P1 无 lizi_discord_bot MCP,source 字段先占位(P2.5 门控用)
  };
}
```

### ③ `apps/desktop/src/main/localDb/schema.ts`

- `SESSION_SOURCES`(`:15`)加 `'discord'`;若列上有 CHECK 约束则补 migration,
  纯 TS 常量则无 DB migration。`im_bindings.channel` 已渠道无关,不动。

### ④ Settings UI(`apps/desktop/src/renderer/components/settings`)

- 新增 `DiscordBotSection.tsx` + `hooks/useDiscordBot.ts`,挂进 `ImBotSection.tsx`
  (FeishuBotSection 之后)。
- 表单:Bot Token(密文)+「我的 Discord 用户 ID」+ Connect/Disconnect + 状态行
  (connected 时显示 bot 用户名)。
- 引导文案(照 hermes wizard):
  1. Developer Portal 建 Application → Bot → Reset Token;
  2. P1 无需开任何 privileged intent(DM 不受 MessageContent intent 限制);
  3. OAuth2 URL Generator:scope `bot`,权限 Send Messages / Read Message History /
     Attach Files → 生成邀请链接把 bot 加进任一 server(Discord 限制:
     和 bot 建 DM 需要共同 server);
  4. 开发者模式 → 右键自己头像 → 复制用户 ID。
- i18n:zh-CN / en / ja / ko `common.json` 补齐。

## 5. 验收标准(P1;逐条过,全绿才算完成)

**连接管理**
1. 填有效 token + 用户 ID → Connect → 状态变 connected,显示 bot 用户名。
2. 填无效 token → 明确报错(不是静默失败/无限 connecting)。
3. Disconnect → 状态 idle;重新 Connect 正常。
4. 重启 app → 自动重连,无需重填。

**消息往返**
5. 在 Discord DM bot 发 "hello" → bot 加 👀 reaction → desktop 出现
   `source='discord'` 新 session → bot 回复到位,👀 撤掉。
6. 同一用户再发消息 → 续接同一 session(不新建)。
7. agent 长回答 → Discord 侧消息渐进更新(流式 edit),结束为完整文本。
8. 回复 >2000 字符 → 正确分段,代码块不被拦腰截断。
9. DM 发图片 → agent 能读到(附件落 discordMediaDir);发 >50MiB 文件 →
   收到「无法处理」提示,不调 agent。
10. agent 产出文件(sendFile)→ Discord 收到附件。

**卡片交互**
11. 触发权限确认 → Discord 出现带按钮卡片 → 点 Allow → 会话继续,卡片收口文案更新。
12. /model 卡片 → 选择后生效。

**权限与健壮性**
13. 非配置用户 DM bot → 静默忽略(desktop 无任何 session 产生)。
14. guild 频道里 @bot → P1 静默忽略,不崩溃。
15. 断网 ≥1 分钟后恢复 → 自动重连;断网期间 Discord 侧发的消息不产生重复回复
    (RESUME 重放去重)。
16. `/ctr` 接管流程在 discord session 上可用(对齐 feishu 非 thread 模型)。

**回归**
17. `apps/desktop` `im/shared/__tests__` 全绿,**feishu characterization tests
    不许动断言**(feature-slack-bot.md 双渠道回归清单同要求,扩为三渠道)。
18. `packages/lizi-im` 新增 discord 单测:markdown 映射、2000 分段边界、
    messageId codec 往返。

## 6. 实现顺序(小步快走)

1. 文档核对(第 2 节 checklist)→ 回填阈值常量。
2. `lizi-im/src/discord/` 纯包实现 + 单测(不接 host,先 vitest 过)。
3. host 接线(②③)→ 手动跑通验收 1–6。
4. 流式 + 卡片(验收 7、8、11、12)。
5. 文件收发 + 健壮性(验收 9、10、13–16)。
6. Settings UI + i18n(验收 1–4 的 UI 面)。
7. 回归(验收 17、18)→ 更新本文档状态 → PR。
