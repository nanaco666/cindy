# Help Assistant 架构重构方案

> **状态：已实现（2026-05-30）**。本方案已落地——help 改为 AI 多轮 chat thread，
> keyword matcher 已整体移除。下文第 1 节"现状与根因"描述的是重构前的旧实现，保留作为背景。
> 实现与本文档基本一致，少量取舍：消息气泡采用 user 右 / assistant 左的聊天式布局、
> no-answer 以空 assistant 气泡承载、in-flight 结果用 epoch 守卫丢弃。
>
> 目标：解决帮助助手"胡言乱语 + 无法通过二次提问纠正"的问题。
> 范围：`apps/desktop` 的 main + renderer + preload；不涉及 server / packages。

---

## 1. 现状与根因

### 1.1 当前数据流

```
HelpQnaBox.tsx
  └─ useHelpQna.ask(query)
       └─ window.electronAPI.maker.helpAsk(query, locale)   ← 单次 IPC,无 thread 概念
            └─ main/maker-ipc/help.ts: registerMakerHelpIpc
                 ├─ matchHelpTopic(query)                    ← 关键词匹配,命中即短路
                 │    └─ return { kind: 'deterministic', ... }
                 └─ 否则 aiFallback → maker.oneShot          ← 完全无上下文的一次性调用
                      └─ return { kind: 'ai', answer }
```

renderer 侧 `helpQnaStore` 保留最近 3 条独立卡片(`MAX_ENTRIES=3`),每张卡都是一次孤立 Q/A,没有任何线程关联。

### 1.2 两个根因

| # | 现象 | 根因 | 代码位置 |
|---|---|---|---|
| R1 | "归档会话能找回来吗?" 被回答成"打开 Settings > 导入" | `matchHelpTopic` 是硬短路 + keywords 过宽。`import-session` 收录了 `对话/会话/conversation/session/import/导入`,任何含 `会话` 的问题都被强制定向到 Import,AI 永远没机会发言 | `apps/desktop/src/main/maker-ipc/help.ts:14-70,91-106,219-227` |
| R2 | 用户追问"不是导入,是归档" 仍然得到 Import 答案 | 后端无 thread,前端也只是独立卡片堆叠。每次 `ask()` 重新走匹配器,再次被同一个关键词命中。前后两次提问之间在数据流上完全无关 | `apps/desktop/src/renderer/hooks/useHelpQna.ts:17-31` + `apps/desktop/src/renderer/lib/helpQnaStore.ts` |

R1 让"第一答就错",R2 让"用户没法纠错"。两者叠加 = 用户体感"胡言乱语且无法修复"。

---

## 2. 设计目标

1. **AI 主导**:LLM 看到完整的产品 topic 知识 + 完整对话历史后再回答;不再被关键词矩阵抢答。
2. **多轮可纠错**:用户可以在同一个 thread 里追问 / 否定 / 澄清,模型能看到上文。
3. **跳转 action 仍然可靠**:LLM 输出结构化标记,main 端用代码强校验白名单,不让模型"自由发明" tab 名。
4. **Panel 关闭后保留最近一次完整对话**:用户拿到答案后会离开 panel 去实际尝试,若失败需要回到原来的对话里继续反馈/追问;所以下次打开 panel 默认恢复上次的完整 thread,而不是空白起步。用户主动点"新会话"才清空。
5. **行为不依赖关键词匹配器** —— 完全移除 `matchHelpTopic` / `HELP_TOPICS.keywords`,topics 退化为"喂给 LLM 的产品知识卡片"。

非目标:
- 不做跨设备同步、不做长期持久化对话历史。
- 不替换底层 agent(继续用 `maker.oneShot`,只是改 prompt 形态)。
- 不引入新的 LLM SDK / 新进程。

---

## 3. 新数据流总览

```
HelpAssistantPanel (open=true)
  └─ HelpQnaThread (新组件)
       ├─ MessageList                 ← 渲染当前 thread 的 messages[]
       ├─ Composer (input + 发送)
       └─ "新会话" 按钮                ← 用户主动清空 thread + 清空持久化

       内部数据:
         helpThreadStore (单例) {
           messages: HelpMessage[],   // [{role:'user'|'assistant', content, action?}]
           pending: boolean,
         }
         持久化:每次 messages 变更后 debounce 写入 localStorage(键 xdt-help-thread-v1)

       Panel 首次挂载(app 启动后第一次打开):
         hydrate from localStorage → 恢复上次完整 thread(若存在)

       发送时:
         appendUserMessage(text)
         setPending(true)
         result = await electronAPI.maker.helpAsk({ messages, locale })   ← IPC 签名改造
         appendAssistantMessage(result)
         setPending(false)
         persistDebounced()

       Panel 关闭(unmount)时:
         什么都不做 —— store 与持久化都保留,下次打开直接看到原 thread
         (pending 中关闭也安全:IPC resolve 后仍会写入 store 并持久化,下次打开能看到完整问答)

       "新会话"按钮:
         helpThreadStore.reset() + localStorage.removeItem(键)
```

main 侧:

```
ipcMain.handle(HELP_ASK, async (_e, payload) => {
  // payload: { messages: HelpMessage[], locale }
  validateMessages(payload.messages)              // 长度 / 字段 / 角色合法性
  const agentKind = await pickHelpAgent(maker, await getMostRecentSessionAgent())
  if (!agentKind) return { kind: 'no-answer' }
  const prompt = buildHelpPrompt({
    systemTopics: HELP_TOPICS,                    // 产品知识卡片,作为 system 上下文
    history: payload.messages,
    locale: payload.locale,
    agentKind,
  })
  const raw = await maker.oneShot(agentKind, prompt, buildOneShotOptions(agentKind))
  return parseAssistantOutput(raw)                // 提取 <action /> + 剥离标签 + 校验白名单
})
```

---

## 4. 关键设计细节

### 4.1 IPC 契约改造

**`apps/desktop/src/shared/helpTypes.ts`** 改为:

```ts
export type HelpRole = 'user' | 'assistant'

export interface HelpMessage {
  role: HelpRole
  content: string
  // 仅 assistant 消息可能带,用于 UI 渲染跳转按钮
  action?: HelpAction
}

export type HelpAction =
  | { kind: 'settings-tab'; tab: SettingsTabId }   // 沿用现有 SettingsTab union
  | { kind: 'none' }

export interface HelpAskRequest {
  messages: HelpMessage[]   // 至少 1 条 user message;最后一条必须是 user
  locale: 'zh-CN' | 'en' | 'ja' | 'ko'
}

export type HelpAnswerResult =
  | { kind: 'ai'; answer: string; action?: HelpAction }
  | { kind: 'no-answer' }
```

变化点:
- 不再有 `kind: 'deterministic'`(matcher 已删)。
- `helpAsk` 入参从 `(query, locale)` 变成 `(request: HelpAskRequest)`。
- preload 类型 + `vite-env.d.ts` 同步更新。

### 4.2 移除关键词匹配器

- 删除 `matchHelpTopic` / `normalizeQuery` / `tokenMatchesKeyword` / `HELP_TOPICS` 里的 `keywords` 字段。
- `HELP_TOPICS` 改名为 `HELP_TOPIC_CARDS`,仅保留 `{ id, tab, answers }`,作为 prompt 知识源。
- 删除 `apps/desktop/src/main/__tests__/helpTopicMatcher.test.ts`,替换为 prompt 构造 + 输出解析的单测。

### 4.3 Prompt 构造

```text
You are the built-in product help assistant for xdt-maker desktop.

The user is already inside the app — never explain download or login steps unless asked.

Below are the product surfaces you may refer the user to. ONLY use these tab ids:
- import          → Import Codex / Claude conversations
- api-keys        → XD Proxy API Key configuration
- feishu-bot      → FeiShu bot binding and notifications
- voice-input     → Microphone, language, shortcuts, refinement
- personalization → Memory, Compat Mode, tips

If your answer involves going to one of those tabs, end your reply with exactly:
<action tab="<id>" />

If no tab is relevant, do not emit any action tag.

Rules:
- Reply in {locale_name}.
- Keep replies short (≤3 sentences, no bullet lists unless absolutely needed).
- Do not invent tab ids. Do not emit multiple <action /> tags.
- If the user pushes back on a previous answer, treat the latest user message as authoritative.

Conversation so far:
USER: ...
ASSISTANT: ...
USER: ...        ← 最后一条总是 user
```

要点:
- topics 以"产品手册"形式喂入,不再用关键词命中。
- action 用 `<action tab="..." />` 轻量 XML,正则提取后剥离,比 JSON 输出更稳定(CLAUDE.md 第 16 条:能用代码做的判断不甩给 prompt——白名单校验在代码里)。
- 用 `USER:` / `ASSISTANT:` 拼对话,而不是真的 multi-turn API,沿用 `maker.oneShot` 不动底层。

### 4.4 输出解析

```ts
const ACTION_TAG_RE = /<action\s+tab="([a-z-]+)"\s*\/?>/i
const ALLOWED_TABS = new Set<SettingsTabId>(['import','api-keys','feishu-bot','voice-input','personalization'])

function parseAssistantOutput(raw: string): HelpAnswerResult {
  const trimmed = raw.trim()
  if (!trimmed) return { kind: 'no-answer' }
  const m = trimmed.match(ACTION_TAG_RE)
  const answer = trimmed.replace(ACTION_TAG_RE, '').trim()
  if (!answer) return { kind: 'no-answer' }
  if (m && ALLOWED_TABS.has(m[1] as SettingsTabId)) {
    return { kind: 'ai', answer, action: { kind: 'settings-tab', tab: m[1] as SettingsTabId } }
  }
  return { kind: 'ai', answer }
}
```

- 不在白名单的 `tab` 直接丢弃 action,正文照常返回(代码兜底,不信任 LLM)。
- 多个 `<action />` 只取第一个匹配。

### 4.5 Thread 存储(单一 store,带持久化)

新建 `apps/desktop/src/renderer/lib/helpThreadStore.ts`,替换 `helpQnaStore.ts`。整个帮助助手只有一个 thread,没有"最近列表"这类二级存储 —— 用户要么看到上次的对话,要么主动开了新会话。

```ts
interface HelpThreadState {
  messages: HelpMessage[]
  pending: boolean
}

API:
- hydrate()                    // app 启动后首次访问 store 时从 localStorage 读取
- appendUserMessage(text)
- appendAssistantMessage(result)
- setPending(bool)
- reset()                      // 仅"新会话"按钮触发,同时清 localStorage
```

#### 持久化策略

- 介质:`localStorage`,键 `xdt-help-thread-v1`。renderer 进程独占,无 IPC,无 main 依赖。
- 写入时机:`messages` 变更后 150ms debounce 写一次;`setPending` 不持久化。
- 只持久化**已稳定的消息**;pending 状态不写,避免下次打开看到"半截 spinner"。
- IPC 调用中途用户关闭 panel:`ask()` 是 fire-and-forget 风格,resolve 时 store 依然存在(模块级单例),会正常 append + 持久化。下次打开就能看到完整 Q&A。
- 容量:上限 12 条消息。超出时截掉中间历史,保留首条 user + 最近 8 条。同一份截断逻辑 main 端 prompt 拼装也用(见 §6),前后端口径一致避免 LLM 看到的历史与 UI 不一致。
- 版本:键带 `v1` 后缀,结构升级时直接改键名丢弃旧数据(帮助场景无须迁移)。

#### Panel 生命周期挂钩

```
HelpAssistantPanel mount (首次):
  helpThreadStore.hydrate()           // 从 localStorage 恢复

HelpAssistantPanel open false → true (后续打开):
  无操作,store 已经是上次状态(模块级单例 + 已持久化)

HelpAssistantPanel open true → false (关闭):
  无操作,store 与持久化都不动

"新会话"按钮:
  helpThreadStore.reset()             // 清空内存
  localStorage.removeItem('xdt-help-thread-v1')
```

> 注:`hydrate` 在 store 模块首次被 import 时自动跑一次即可(模块顶部副作用),不需要组件层调用。这样无论从 HelpAssistantPanel 还是其它入口访问 store,状态都已就绪。

### 4.6 UI 形态(替换 `HelpQnaBox`)

```
┌───────────────────────────────────────┐
│ Help Assistant                  [新会话] ✕ │
├───────────────────────────────────────┤
│  USER:  归档会话还能找回来吗?           │   ← 首次打开若上次有对话则直接渲染历史
│  ASSIST: 在 ... 可以... [打开 个性化] │   ← 跳转按钮跟在对应 assistant 气泡内
│  USER:  我说的不是导入,是归档          │
│  ASSIST: 抱歉,归档...                 │
│  ⋯ (pending spinner 占位)            │
├───────────────────────────────────────┤
│ [输入框..........................发送] │
└───────────────────────────────────────┘

空状态(首次安装 / 用户刚点完"新会话"):
┌───────────────────────────────────────┐
│ Help Assistant                  [新会话] ✕ │
├───────────────────────────────────────┤
│  (居中提示) 直接提问:覆盖问题的快速答案 │
├───────────────────────────────────────┤
│ [输入框..........................发送] │
└───────────────────────────────────────┘
```

- 单一 thread,垂直堆叠;不再是 3 张独立卡片。
- "新会话"按钮放在 panel header(靠近关闭按钮),仅在 `messages.length > 0` 时显示;点击 = `reset()` + 清持久化。
- pending 期间禁用输入框 + 发送按钮(沿用现状)。pending 中点"新会话":同样允许,reset 即可(in-flight IPC 结果到达时 store 已重置,append 时检查 messages 为空则丢弃该结果,避免污染新会话)。

文件级改动:
- 新建 `HelpThreadView.tsx`(MessageList + Composer + 空态)。
- 改 `HelpAssistantPanel.tsx`:header 区域加"新会话"按钮;不需要 unmount 钩子。
- 删除 `HelpQnaBox.tsx` / `useHelpQna.ts` / `helpQnaStore.ts` / `__tests__/helpQnaStore.test.ts`。

### 4.7 Agent 选择 & oneShot 选项

保持现状不变:
- `getMostRecentSessionAgent` + `pickHelpAgent` 复用。
- `buildOneShotOptions` 沿用 `claude-haiku-4-5 / maxTokens=220` 与 `gpt-5.4-mini / 20s timeout`。
- 多轮场景下 history 进 prompt 体积可控(每条 user/assistant 平均 < 100 token,5 轮 < 1k token)。

---

## 5. 文件变更清单

### 新增

| 路径 | 作用 |
|---|---|
| `apps/desktop/src/renderer/lib/helpThreadStore.ts` | 单例 thread store + localStorage 持久化(替换 `helpQnaStore.ts`) |
| `apps/desktop/src/renderer/components/settings/HelpThreadView.tsx` | 新的聊天式 UI(替换 `HelpQnaBox.tsx`) |
| `apps/desktop/src/main/__tests__/helpPrompt.test.ts` | prompt 构造 + 输出解析单测 |
| `apps/desktop/src/renderer/__tests__/helpThreadStore.test.ts` | hydrate / append / reset / debounce 持久化 / 截断 |

### 修改

| 路径 | 改动 |
|---|---|
| `apps/desktop/src/shared/helpTypes.ts` | 改造 `HelpAnswerResult`,新增 `HelpMessage` / `HelpAskRequest` |
| `apps/desktop/src/main/maker-ipc/help.ts` | 删 matcher,改 IPC handler 入参,重写 `buildHelpPrompt`,加 `parseAssistantOutput` |
| `apps/desktop/src/preload/preload.ts` | `helpAsk` 签名 → 接 `HelpAskRequest` |
| `apps/desktop/src/renderer/vite-env.d.ts` | `electronAPI.maker.helpAsk` 类型同步 |
| `apps/desktop/src/renderer/components/settings/HelpAssistantPanel.tsx` | 替换内容组件 + 挂 unmount 钩子 |
| `apps/desktop/src/renderer/components/settings/HelpSection.tsx` | 不变(仅入口按钮) |
| i18n 文案(`zh-CN/en/ja/ko`) | 新增"最近提问 / 新会话 / 输入占位"等键 |

### 删除

| 路径 | 原因 |
|---|---|
| `apps/desktop/src/renderer/lib/helpQnaStore.ts` | 被 `helpThreadStore` 替代 |
| `apps/desktop/src/renderer/hooks/useHelpQna.ts` | UI 直接用 store + IPC,不再需要 hook 包装(也可以保留,看实现时哪种更顺手) |
| `apps/desktop/src/renderer/components/settings/HelpQnaBox.tsx` | 被 `HelpThreadView` 替代 |
| `apps/desktop/src/main/__tests__/helpTopicMatcher.test.ts` | matcher 已删 |
| `apps/desktop/src/renderer/__tests__/helpQnaStore.test.ts` | store 已删 |

---

## 6. 边界与失败兜底

| 场景 | 行为 |
|---|---|
| LLM 不可用(无 agent / 鉴权失败) | 返回 `{ kind: 'no-answer' }`,UI 显示一段统一的"暂时无法回答,请直接查阅左侧 overview"提示,不退化到关键词匹配 |
| LLM 返回空字符串 | 同上,`no-answer` |
| LLM 输出非白名单 tab | 丢 action,正文照样展示 |
| LLM 输出多个 `<action />` | 取第一个,其余忽略 |
| `messages` 为空 / 末尾不是 user | IPC handler 返回 `no-answer`(不抛错,UI 看到的就是"没答案") |
| Thread 过长 | 当 messages > 12 条时截掉中间历史,保留首条 user + 最近 8 条;renderer 与 main 共用同一份截断函数(放在 `helpTypes.ts` 旁的纯函数文件),保证持久化 / UI 渲染 / prompt 拼装看到的历史完全一致 |
| localStorage 不可用(Electron 配置异常 / 隐私模式) | `helpThreadStore` 静默降级为纯内存,当前会话内功能正常,关闭 app 后历史丢失 |
| `localStorage.setItem` 失败(配额满) | catch 后只打 debug 日志,不影响 in-memory store;下次成功的写入会覆盖 |
| pending 中用户点"新会话" | 立即 reset + 清持久化;late 到达的 assistant 结果在 append 时检查 `messages.length === 0` 时丢弃,避免污染新会话 |
| 旧版本 app 残留的 `xdt-help-qna-*` 之类老键 | 不处理,新键名带 `v1` 后缀;老键自然过期,不写迁移代码 |

---

## 7. 测试计划

**单测**
1. `parseAssistantOutput`:正常 / 无 action / 非法 tab / 多 action / 空字符串 / 标签夹在文本中间 / 大小写。
2. `buildHelpPrompt`:locale 注入正确 / topic 卡片完整 / history 序列化顺序 / 末尾必须是 user。
3. `truncateHistory`(共享纯函数):≤12 不动 / >12 时保留首条 user + 最近 8 / 顺序不变。
4. `helpThreadStore`:
   - hydrate 从合法 JSON / 非法 JSON / 空 / localStorage 抛错四种情况
   - append/reset/pending 状态正确切换
   - debounce 写入(用 fake timers 验证 150ms 内多次 append 只写一次)
   - reset 同步清空 localStorage
   - pending 中 reset 后 late assistant 结果被丢弃

**手动验收**(必须覆盖,对应原 bug)
1. 打开 Help Assistant,问"已归档的会话还能找回来吗" → 答案必须是关于"归档/恢复"的内容,不能是 Import。
2. 紧接着问"不是导入,是 xdt-maker 内部归档" → 模型能看到上文,纠正自己之前的回答。
3. 关闭 panel,再打开 → 上次完整对话(含两轮 Q&A 和跳转按钮)原样恢复;可在原 thread 继续追问"那归档之后再打开新对话会丢吗" → 模型回答带前面两轮上下文。
4. 点 panel header 的"新会话" → 立即清空 + 持久化清空;关闭再打开依然是空白态。
5. 跳转按钮仍然工作:问"怎么配 API Key" → 模型答 + `<action tab="api-keys" />` → UI 显示"打开 API Keys"按钮 → 点击跳转。
6. 跨 app 重启:问完一轮后完全退出 app,重新启动并打开 Help Assistant → 上次对话恢复。
7. macOS + Windows 双平台跑同样流程(CLAUDE.md 第 15 条)。

---

## 8. 风险与权衡

| 风险 | 影响 | 缓解 |
|---|---|---|
| 每次提问都打 LLM(无 deterministic 短路) | 增加 ~1s 延迟 + 少量 token 成本 | 帮助场景低频,且 haiku-4-5 / gpt-5.4-mini 已经是低成本档;UI 已有 pending spinner 体感可接受 |
| Prompt 中 history 增长导致 token 上涨 | 极端情况下接近 maxTokens 上限 | §6 的"thread 过长截断"策略;实际 5 轮内不会触发 |
| LLM 仍可能给出错误答案 | 用户体感"还是不准" | 接受 —— 但用户**能继续追问纠正,且离开 panel 去尝试后还能回到原对话反馈**,这是相对当前架构的核心改进。同时 Help overview(`HelpSection`)中的静态指引保持权威 |
| `localStorage` 在某些 Electron 配置下被禁用 / 写入失败 | 跨启动恢复失效 | 静默降级为纯内存,当前会话内功能正常 |
| 持久化的对话被用户视为"敏感" | 用户问的可能是配置 / 路径相关内容 | 帮助助手的输入本身不要求敏感信息,且数据只落本地 `localStorage`(不上云、不同步);"新会话"按钮可一键清除。若后续有合规要求,可在 §10 中扩展"退出登录时清空" |
| `<action />` 标签在某些模型输出里被 Markdown 转义 | action 提取失败 | 正则用大小写不敏感 + 容忍空格;失败时正文照常显示,只是没跳转按钮(可接受降级) |

---

## 9. 实施顺序(按 PR 粒度建议)

> 仅顺序建议,不在本文档承诺工期。

1. 类型 + IPC 契约改造(`helpTypes.ts` / `help.ts` / `preload.ts` / `vite-env.d.ts`)+ 共享 `truncateHistory` 纯函数与对应单测。
2. 删除关键词 matcher + 老测试。
3. renderer 新 store(`helpThreadStore`,含 hydrate + debounce 持久化)与单测。
4. UI 替换(`HelpThreadView` + `HelpAssistantPanel` header 加"新会话"按钮)+ i18n。
5. 删除旧文件(`HelpQnaBox` / `useHelpQna` / `helpQnaStore` 及测试)。
6. 手动双平台验收(含跨 app 重启场景)。

---

## 10. 不在本次范围

- 后端持久化对话 / 跨设备同步:不做。
- 把 help assistant 升级为带工具调用的真 agent(可以读取/修改设置项):不做,超出 scope。
- 对 `HelpSection`(overview)做内容/结构调整:不做。
