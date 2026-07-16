# Discord Bot(P1 · DM)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 配套:`feature-discord-bot.md`(验收标准,编号 V1–V18)· `feature-discord-bot-tech.md`(技术方案,常量与模块契约以它为准)。

**Goal:** maker Settings 连接 Discord bot,owner 用户 DM ↔ 持久 session(source='discord'),支持流式/卡片/文件/接管。

**Architecture:** `packages/lizi-im/src/discord/`(discord.js 直连传输层)+ `apps/desktop/src/main/im/discord/`(ImChannelAdapter 接线),编排层 `im/shared/*` 零改动。

**Tech Stack:** TypeScript / discord.js v14 / vitest / Electron main / React(Settings)。

## Global Constraints

- `im/shared/*` 与 `maker-core` **一行不改**;feishu characterization tests 断言不许动。
- 常量:消息 2000(分段阈值 1900)/ 出站附件 8 MiB / 入站附件 50 MiB / 流式节流 1300ms / intents `Guilds|DirectMessages` / `Partials.Channel` 必开。
- messageId 编码 `"{channelId}|{messageId}"`;非 owner DM 与所有 guild 消息静默丢弃。
- commit 不加 Co-Authored-By 署名;每个 Task 单独 commit;合并走 PR。
- 包内代码 electron-free(`packages/lizi-im` 只依赖 `IMHost` 注入)。

---

### Task 1: lizi-im 脚手架 + codec

**Files:**
- Modify: `packages/lizi-im/package.json`(dependencies 加 `"discord.js": "^14.16.0"`)
- Modify: `packages/lizi-im/src/types.ts:45`(`paths` 加 `discordMediaDir?: string`,注释对齐 slackMediaDir)
- Create: `packages/lizi-im/src/discord/codec.ts`
- Test: `packages/lizi-im/src/discord/__tests__/codec.test.ts`

**Interfaces(Produces):**
```ts
export function encodeMessageId(channelId: string, messageId: string): string;       // "{c}|{m}"
export function decodeMessageId(encoded: string): { channelId: string; messageId: string }; // 非法格式 throw
export function encodeCustomId(buttonId: string, payload: Record<string, unknown>): string;
// JSON.stringify({i,p}) ≤100 字符直接用;超长返回 "ref:{token}" 并写入模块级 LRU(容量 256)
export function decodeCustomId(customId: string): { buttonId: string; payload: Record<string, unknown> } | null;
// ref 未命中(重启/逐出)返回 null → 调用方回"卡片已过期"
```

- [ ] Step 1 写失败测试:messageId 往返、含 `|` 的非法输入 throw、customId 短 payload 往返、>100 字符走 ref 且可解回、伪造 `ref:xxx` 返回 null
- [ ] Step 2 `pnpm --filter lizi-im test` → FAIL(模块不存在)
- [ ] Step 3 实现 codec.ts(LRU 用 Map + 插入序逐出,不引依赖)
- [ ] Step 4 测试全绿;`pnpm --filter lizi-im build`(tsc noEmit)过
- [ ] Step 5 Commit `feat(lizi-im): discord codec + discordMediaDir path`

### Task 2: markdown 映射

**Files:**
- Create: `packages/lizi-im/src/discord/markdown.ts`
- Test: `packages/lizi-im/src/discord/__tests__/markdown.test.ts`

**Interfaces(Produces):**
```ts
export function markdownToDiscord(md: string): { text: string; imageUrls: string[] };
// imageUrls = 文内 ![...](xdt-image://...) 摘出的 url 列表(text 中移除该行);
// http(s) 图片链接保留原样(Discord 自动预览)
```

规则(对照 `slack/mrkdwn.ts` 的测试组织方式):粗体/斜体/行内 code/围栏/引用/标题/有序无序列表 **透传**(Discord 原生支持);表格 → 整表包 ``` 围栏;HTML 标签剥离;`[text](url)` 透传(bot 消息支持 masked link)。

- [ ] Step 1 失败测试:每条规则一个 case + 混合文档快照
- [ ] Step 2 FAIL 确认 → Step 3 实现 → Step 4 全绿 → Step 5 Commit `feat(lizi-im): discord markdown mapping`

### Task 3: 2000 分段

**Files:**
- Create: `packages/lizi-im/src/discord/chunk.ts`
- Test: `packages/lizi-im/src/discord/__tests__/chunk.test.ts`

**Interfaces(Produces):**
```ts
export const MAX_MESSAGE_LEN = 2000;
export const SPLIT_THRESHOLD = 1900;
export function chunkDiscordText(text: string, limit?: number): string[];
// 不变量: 每段 ≤ limit;优先段落边界断;围栏内断开时上段补 "```"、下段以 "```{lang}" 重开
```

- [ ] Step 1 失败测试:≤limit 单段原样;长文按段落断;3000 字符代码块断点两侧围栏闭合/重开且语言保留;单行超 limit 硬切
- [ ] Step 2–5 同上;Commit `feat(lizi-im): discord text chunking`

### Task 4: gateway 封装

**Files:**
- Create: `packages/lizi-im/src/discord/gateway.ts`
- Test: `packages/lizi-im/src/discord/__tests__/gateway.test.ts`(纯逻辑部分)

**Interfaces(Produces):**
```ts
export interface DiscordGatewayEvents {
  onStatus(s: IMStatus): void;
  onDmMessage(m: import('discord.js').Message): void;   // 已过 §3.3 过滤链 1/2/4(owner 过滤在 DiscordIM 做,便于热更 ownerUserId)
  onButtonInteraction(i: import('discord.js').ButtonInteraction): void; // 已 deferUpdate
}
export interface DiscordGateway {
  connect(token: string): Promise<void>;   // login + ready;4004/4014 → onStatus(error)
  destroy(): Promise<void>;
  readonly client: import('discord.js').Client | null;  // connected 后非 null
  readonly appId: string;                   // application id(ready 后)
  readonly botTag: string;                  // e.g. "mybot#0000"
}
export function createDiscordGateway(ev: DiscordGatewayEvents): DiscordGateway;
```

实现要点:`new Client({ intents: [Guilds, DirectMessages], partials: [Partials.Channel] })`;`messageCreate` 过滤 self/bot/非 DM + LRU(512)去重后转发;`interactionCreate` 只处理 `isButton()`,先 `deferUpdate()` 再转发;`shardDisconnect/shardResume/shardReconnecting` 映射 connecting,致命关闭码映射 error。

- [ ] Step 1 失败测试:去重 LRU 逻辑(抽成纯函数 `createDedup(cap)`)、关闭码→IMStatus 映射表
- [ ] Step 2–4 实现并全绿(Client 本体不在单测内起网络)
- [ ] Step 5 Commit `feat(lizi-im): discord gateway wrapper`

### Task 5: DiscordIM 入站 + 附件

**Files:**
- Create: `packages/lizi-im/src/discord/index.ts`(类骨架见验收文件 §4①;本 Task 实现 lifecycle + onMessage 链路)
- Create: `packages/lizi-im/src/discord/inbound.ts`(`normalizeDmMessage` 纯函数 + 附件下载)
- Modify: `packages/lizi-im/src/index.ts`(导出 `createDiscordIM`、`DiscordIM`)
- Test: `packages/lizi-im/src/discord/__tests__/inbound.test.ts`

**Interfaces(Consumes/Produces):**
```ts
// inbound.ts
export async function normalizeDmMessage(
  m: MessageLike,                      // 测试友好的最小结构(content/author/channelId/id/attachments)
  ctx: { contextId: string; mediaDir: string; download: (url: string, dest: string) => Promise<void> },
): Promise<IMMessageEvent>;
// index.ts
export function createDiscordIM(host: IMHost, opts?: DiscordIMOptions): DiscordIM;
```

- init():secrets 读 token/ownerUserId,无 token → idle;有 → gateway.connect;
  onDmMessage 里做 owner 过滤(≠ownerUserId 丢弃)→ normalize → messageHandlers。
- 附件:image/file 下载到 `paths.discordMediaDir`;>50 MiB 或 sticker/语音 → unsupported(type: `oversize`/`sticker`/`audio`);下载失败 → `download`。

- [ ] Step 1 失败测试(mock download):纯文本归一化各字段;图片附件落盘路径;>50 MiB 进 unsupported 且不调 download;sticker 进 unsupported
- [ ] Step 2–4 实现全绿(DiscordIM 用注入 gateway 工厂便于 mock)
- [ ] Step 5 Commit `feat(lizi-im): DiscordIM inbound pipeline`

### Task 6: DiscordIM 出站(文本/文件/reaction)

**Files:**
- Modify: `packages/lizi-im/src/discord/index.ts`(sendText/sendMarkdownText/sendFile/reactToMessage/removeMessageReaction/getStatus)
- Create: `packages/lizi-im/src/discord/outbound.ts`(DM channel 解析缓存 + 分段发送纯逻辑)
- Test: `packages/lizi-im/src/discord/__tests__/outbound.test.ts`

**Interfaces(Produces):**
```ts
// outbound.ts
export function createDmResolver(client: ClientLike): (userId: string) => Promise<DMChannelLike>; // Map 缓存
export async function sendChunked(ch: DMChannelLike, text: string): Promise<{ firstMessageId: string }>;
```

- sendFile:statSync >8 MiB → `{ok:false,reason:'TOO_LARGE'}`;send({files:[...]}) 413 → TOO_LARGE,其余 → UPLOAD_FAIL。
- reaction token = emoji 字符;remove 用 `reactions.resolve(emoji).users.remove(self)`。

- [ ] Step 1 失败测试(mock channel):分段调用次数与首段 id;8 MiB 边界;413 归因
- [ ] Step 2–4 实现全绿 → Step 5 Commit `feat(lizi-im): DiscordIM outbound text/file/reactions`

### Task 7: 卡片 + interaction

**Files:**
- Create: `packages/lizi-im/src/discord/components.ts`
- Modify: `packages/lizi-im/src/discord/index.ts`(sendInteractiveCard/updateInteractiveCard/patchMarkdownCard/onCardAction)
- Test: `packages/lizi-im/src/discord/__tests__/components.test.ts`

**Interfaces(Produces):**
```ts
export function buildCardMessage(spec: InteractiveCardSpec): { embeds: [EmbedData]; components: ActionRowData[] };
// title→embed.title, body(markdownToDiscord)→embed.description;buttons 按 5/行 分行,≤5 行;
// type: primary→Primary, danger→Danger, default→Secondary;custom_id = encodeCustomId(...)
export function parseInteraction(i: ButtonInteractionLike): IMCardActionEvent | null; // decodeCustomId null → null(调用方回"卡片已过期")
```

- [ ] Step 1 失败测试:6 个按钮分两行;spec→embed 快照;interaction 往返出 buttonId+payload;过期 ref → null
- [ ] Step 2–4 实现全绿(update/patch 走 decodeMessageId + REST edit,patch 清 components)
- [ ] Step 5 Commit `feat(lizi-im): discord interactive cards`

### Task 8: 流式

**Files:**
- Create: `packages/lizi-im/src/discord/streamingText.ts`(结构对照 `slack/streamingText.ts`)
- Modify: `packages/lizi-im/src/discord/index.ts`(startStreamingText)
- Test: `packages/lizi-im/src/discord/__tests__/streamingText.test.ts`(vi.useFakeTimers)

**Interfaces(Produces):**
```ts
export function startStreaming(deps: {
  send: (text: string) => Promise<string>;        // 返回编码 messageId
  edit: (messageId: string, text: string) => Promise<void>;
  markdownToDiscord: typeof markdownToDiscord;
  chunk: typeof chunkDiscordText;
  resolveImageUrl?: (url: string) => string;
  uploadImages: (messageId: string, absPaths: string[]) => Promise<void>;
}, initial?: string): Promise<StreamingTextHandle>;
```

行为:1300ms 节流 edit;缓冲 >1900 字符停止中间编辑(避免编辑失败),finalize 时首段 edit + 余量 chunk 后补发;`addExtraImageAbsPath` 收集,finalize 时与文内 xdt-image 一起上传。

- [ ] Step 1 失败测试(fake timers):600ms 内两次 append 只 1 次 edit;finalize 立即出全文;3000 字符 finalize → 1 次 edit + 1 次补发;close 后不再 edit
- [ ] Step 2–4 实现全绿 → Step 5 Commit `feat(lizi-im): discord streaming text`

### Task 9: host 接线(desktop main)

**Files:**
- Modify: `apps/desktop/src/shared/sessionSource.ts`(`SessionSource` 加 `'discord'`)
- Modify: `apps/desktop/src/main/localDb/schema.ts:15`(`SESSION_SOURCES` 加 `'discord'`;drizzle TS enum,无 migration)
- Modify: `apps/desktop/src/main/im/shared/types.ts:24`(`ImChannelName` 加 `'discord'`)
- Create: `apps/desktop/src/main/im/discord/uiText.ts`(完整 `ImUiTextPack`,thread 段省略;文案抄 slack/uiText.ts 改"Discord";`PROCESSING_EMOJI = '👀'`)
- Create: `apps/desktop/src/main/im/discord/adapter.ts`(`buildDiscordAdapter` — 全量代码在验收文件 §4②,原样落地)
- Create: `apps/desktop/src/main/im/discord/index.ts`(`wireDiscordOrchestrator`,对照 slack/index.ts)
- Modify: `apps/desktop/src/main/im/host.ts`(paths.discordMediaDir;`discordIm = createDiscordIM(host,{resolveImageUrl})`;createIM 数组加入)
- Modify: `apps/desktop/src/main/im/index.ts`(`DISCORD_CONFIG` 抄 SLACK_CONFIG 取值;接线 + binding cleanup 加 discord 分支,见 `:157` 注释)
- Test: 跑既有 `apps/desktop` im 相关测试套件

**Interfaces(Consumes):** Task 1–8 的 `createDiscordIM`;shared 编排层现有 `createImOrchestrator`。

- [ ] Step 1 依序改类型(sessionSource → schema → ImChannelName),`pnpm --filter desktop build` 编译过(uiText 缺字段会在此暴露)
- [ ] Step 2 adapter/uiText/index 落地,host.ts 接线
- [ ] Step 3 `pnpm --filter desktop test` 全绿,**feishu characterization 无改动**
- [ ] Step 4 `pnpm electron:dev` 起 app,desktop 无崩溃、feishu/slack 状态不受影响
- [ ] Step 5 Commit `feat(desktop): wire discord im channel`

### Task 10: Settings UI + i18n

**Files:**
- Create: `apps/desktop/src/renderer/components/settings/DiscordBotSection.tsx`
- Create: `apps/desktop/src/renderer/hooks/useDiscordBot.ts`(ipc:`im:discord:set-config/get-status/disconnect`,订阅 `im:discord:status`;结构抄 useFeishuBot)
- Modify: `apps/desktop/src/renderer/components/settings/ImBotSection.tsx`(挂载新 Section)
- Modify: i18n `zh-CN/en/ja/ko` `common.json`(表单/状态/四步引导文案,内容见技术方案 §5)

- [ ] Step 1 hooks + Section 实现(表单校验:token 非空;userId 纯数字 snowflake)
- [ ] Step 2 `pnpm electron:dev` 手测:V1(有效 token connect 显示 bot tag)/ V2(坏 token 明确报错)/ V3(disconnect→idle→重连)/ V4(重启自动重连)
- [ ] Step 3 四语言 key 齐全,无 fallback warning
- [ ] Step 4 Commit `feat(desktop): discord bot settings UI`

### Task 11: 端到端验收 + 回归

- [ ] Step 1 真实 bot 手测验收文件 V5–V16 逐条打勾(结果回填验收文件,附截图)
- [ ] Step 2 `pnpm --filter lizi-im test && pnpm --filter desktop test` 全绿(V17/V18)
- [ ] Step 3 更新 `feature-discord-bot.md` 状态行 + 本计划 checkbox;文档与实现不一致处同步修正
- [ ] Step 4 Commit `docs: discord bot P1 acceptance results` → 发 PR(标题 `feat: discord bot channel (P1 DM)`,body 链三份文档)

---

## Self-Review 记录

- 覆盖:验收 V1–V4→Task 10;V5/V6/V13/V14→Task 5+9;V7→Task 8;V8→Task 3;V9→Task 5;V10→Task 6;V11/V12→Task 7+9;V15→Task 4;V16→Task 9(编排层自带);V17/V18→各 Task Step + Task 11。
- 类型一致性:`encodeMessageId/decodeMessageId/encodeCustomId/decodeCustomId/markdownToDiscord/chunkDiscordText/createDiscordGateway/createDiscordIM` 全文单一拼写;常量与技术方案 §2 一致。
- 已知留白(有意):ipc 频道名以 feishu `registerIpc` 实际命名为准(Task 5 实现时对齐);`DISCORD_CONFIG` 取值抄 SLACK_CONFIG(产品未另行指定)。
