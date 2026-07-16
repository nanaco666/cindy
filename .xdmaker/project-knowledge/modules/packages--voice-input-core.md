---
id: packages--voice-input-core
type: module
covers:
  - packages/voice-input-core/**
depends_on: []
last_synced_commit: 59f566cf71cd4b30742d47a65d9ee3badb417462
last_synced_at: '2026-07-06T05:03:42.299Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# packages--voice-input-core

## 是什么

`@lizi/voice-input-core` 是语音输入功能的 provider-neutral 核心包，实现了 click-to-dictate 的完整状态机（idle → listening → submitting → refining → done）、ASR 文本的 LLM 后处理 (refinement)、用户编辑驱动的词典自动学习 (dictionary advisor)、外部编辑器粘贴文本的编辑检测 (external edit inspector)，以及一个包裹任意 `AsrProvider` 的握手期音频缓冲装饰器 (`BufferedAsrProvider`)。零运行时依赖，不依赖 Electron/Node API，由 desktop app 的 main/renderer 层与 mobile app 的 session 层分别消费。

## 关键抽象 / 核心代码地标

- **`VoiceInputController`** (`src/VoiceInputController.ts`) — 状态机核心。协调 `AsrProvider`（外部注入的语音识别实现）和可选的 `DictationRefiner`，管理 start/stop/cancel 生命周期、optimistic refinement（stop 时即刻发起 refine 请求以降低感知延迟）、ASR stall watchdog（基于 voiced RMS 而非原始音频时长，避免静默思考触发假警告）、以及网络恢复（transport error/disconnected 时 `AsrProvider.recover()`，上限 `ASR_NETWORK_RECOVERY_MAX_ATTEMPTS = 3`）。
- **`BufferedAsrProvider`** (`src/BufferedAsrProvider.ts`) — 装饰任意 `AsrProvider`，使音频可以在其 start()/连接握手仍在进行时被 append。背景：为隐藏连接延迟，采集与 ASR 连接并发启动，但部分 provider（例如握手完成前 appendAudio 是 no-op 的 fallback provider）会静默丢弃握手期间的音频。该 wrapper 统一处理：握手未完成前的 appendAudio 本地缓冲、start() resolve 后按顺序回放；握手中 stop() 不阻塞（cancel 必须立即返回），握手结算后再丢弃缓冲并拆除 inner provider；握手中途被放弃的 run 永不复活（用 run token 判断陈旧续体）；flushAudio() 会等握手结算后才提交，避免短语音因提前 stop 变成空文本。`recover` 仅当 inner provider 当前暴露 `recover` 时才透传（部分 provider 是 fallback 链选定 active 候选后才动态赋值 recover，无条件定义会让恢复"假成功"掩盖死连接）。draining 阶段（新 run 等待并拆除上一个 run 未完成的握手）产生的 inner 事件会被吞掉、不转发给新 run 的订阅者，否则新 run 会被上个 run 的 socket 拆除事件误判为自己的传输层刚断。desktop 与 mobile 的 controller 均用它包裹底层 AsrProvider。
- **`DictationRefiner`** (`src/DictationRefiner.ts`) — LLM 后处理层。接收 `TextModelClient`（host 注入的模型调用能力）和 `DictationRefinementContext`（用户词典、光标上下文、voiceInputHistory、replyToMessage 等），构建 prompt 并调用模型，返回 `RefinementResult`。内建中文 ASR 清理 system prompt (`DEFAULT_DICTATION_REFINER_SYSTEM_PROMPT`，当前版本 `dictation-refinement.zh.v16`)，host 可通过 `systemPrompt` 选项覆盖（覆盖后需同步 `promptVersion`，否则会静默复用旧缓存 key）。prompt 字段按 cache-friendliness 排序：稳定上下文前置，per-request 动态字段（`dictationText`、`replyToMessage`、`userDictionaryMatches`）后置。内含 `buildUserDictionaryMatches()` 用于将 `dictionaryAliasHints` 按 dictationText 匹配裁剪为 prompt 可见子集。**发散度兜底** (`isRefinementDiverged`)：仅在使用包内置默认 prompt (`usesBundledDefaultPrompt`) 时生效，用代码（而非 prompt）拦截模型忽略"只整理、不回答"硬性禁止、擅自回答/总结/翻译 dictation 的情况——判定条件是输出的**内容字符数**（字母/数字/CJK，忽略空白与 markdown 符号）同时满足绝对长度 ≥48 且 ≥ 输入内容长度的 3 倍；命中则 reject（`rejectionReason: 'diverged_too_far'`），controller 保留用户原始 ASR 文本。用内容字符而非原始长度计算，是为了让"整理成列表/加 Markdown 结构"这类只增加排版符号、不增加实质内容的合法润色不会误触发。
- **`DictationDictionaryAdvisor`** (`src/DictationDictionaryAdvisor.ts`) — 词典自动学习。比较 beforeText（ASR/refine 输出，可选结合 `rawTranscriptText` 拿到 refine 之前的原始误识别）和 afterText（用户手动修正后），通过 LLM 判断是否应将纠正对添加到自动词典。输出 `add_candidate`/`add_entry`/`update_entry` 动作。内建 skip gate 过滤无信号修改（`empty_text`/`same_text`/`formatting_only`/`large_rewrite`，见 `getDictationDictionaryAdviceSkipReason`）。硬编码安全上界防止大请求。
- **`DictationExternalEditInspector`** (`src/DictationExternalEditInspector.ts`) — 纯函数 `inspectExternalEditedInsertedText()`，用于外部编辑器（非 app 内）场景：通过 selectionBefore/selectionAfter 文本锚点恢复用户对粘贴文本的编辑，为 DictationDictionaryAdvisor 提供 beforeText/afterText 差异证据。
  - `DictationExternalTextContext` 新增可选字段 `fullFieldContent`（完整输入框文本）、`selectionLocation`、`selectionLength`，平台能提供时优先用全字段做锚点搜索，避免光标移走后侧翼文本不再包围粘贴区的问题。
  - 内部拆出 `buildExpectedWindow` / `buildCurrentWindow`：有 `fullFieldContent` + 坐标时构建全字段窗口，否则退回 selectionBefore/After 拼接。
  - 第三层兜底 `inspectApproximateEditedText`：在锚点法和 replacement 法都失败时，用 LCS（最长公共子串，`longestCommonSubstringLength`）判断 currentWindow 与 insertedText 的重叠强度，满足阈值则将清理后的 currentWindow 整体视为 editedText，返回 reason `'approximate_replacement_text_extracted'`（有别于正常 replacement 路径的 `'replacement_text_extracted'`）。用于 Feishu 等会隐藏 pre-paste chrome 的外部应用。
  - LCS 守卫 `hasStrongInsertedTextOverlap`：inserted 或 edited 任一方字符数 < 6 时直接返回 false（拒绝极短文本）；最小重叠阈值为 `Math.min(12, Math.max(5, ceil(length * 0.45)))`。
- **`VoiceTimelineLogger`** (`src/VoiceTimelineLogger.ts`) — 轻量 timeline 事件记录器，in-memory 存储 + 可选外部 sink。host 注入 sink 对接统一日志系统。
- **`streamingJson.ts`** — `extractJsonStringFieldSnapshot(text, field)`：从流式、可能不完整的 JSON 文本中提取某个字符串字段当前的最佳可用值（含转义序列解析），供 refine/advisor 流式返回时给 UI 渲染 preview-only 快照；最终结果仍必须解析完整 JSON 才算数。
- **`types.ts`** — 所有公共类型定义，包括 `AsrProvider` 接口（`start/stop/appendAudio/flushAudio/onEvent` + 可选 `recover/dispose`）、`VoiceInputCallbacks`、`VoiceTimelineEvent` 联合类型、`SpeechSegment`、`EditableRange`、`DictationRefinementContext` 等。

## 模块边界

**依赖**：零运行时依赖。devDependencies 仅 vitest、eslint、typescript。

**被依赖**：被 `apps/desktop` 与 `apps/mobile` 共同消费：
- `apps/desktop/src/main/voice-input/` — 注入具体 ASR provider（OpenAI Realtime Whisper、LiteLLM、ElevenLabs Scribe）、TextModelClient（Codex Responses）、构建 DictationRefiner 和 DictationDictionaryAdvisor 实例。
- `apps/desktop/src/renderer/voice-input/` — 消费类型定义（`VoiceInputRendererEvent`、`SpeechSegment`、`EditableRange` 等）用于 IPC 事件解析和 UI 渲染。
- `apps/desktop/src/shared/voiceInputData.ts` — 共享类型。
- `apps/mobile/src/session/mobileVoiceController.ts` — mobile adapter，镜像 desktop 同款模型：realtime ASR 驱动可见 draft，stop 提交 ASR 文本，流式 refinement 替换同一段 composer range；用 `BufferedAsrProvider` 包裹底层 AsrProvider 应对并发 connect/capture，用 `DictationRefiner` 走 mobile 自己的 TextModelClient。mobile-only 的周边逻辑（credential store、prewarm、history store、词典学习落地等，见 `apps/mobile/src/session/mobileVoice*.ts`）不属于此包边界。

**对外接口形态**：纯 TypeScript 源码导出（`"main": "./src/index.ts"`），无构建产物。���各 host 的 vite/esbuild/metro bundler 直接消费。所有具体平台能力（麦克风采集、模型 API key、日志写盘）通过构造函数参数注入。

## 不要做的事

- **不要在此包引入 Electron / Node.js API**。这是 provider-neutral 核心，平台能力（getUserMedia、文件系统、进程管理）属于 desktop/mobile host 层。
- **不要在 `VoiceInputController` 中对 ASR partial 空隙自动触发 recover**。OpenAI realtime 可以合法地暂停 partial delta 10+ 秒，仍然在 flush 时返回完整 transcript。recover 只由显式 transport error/disconnected 驱动。此决策经过实际 bug 验证（recover 触发导致 mid-dictation 丢词）。
- **不要改变 `DictationRefiner` prompt payload 的字段顺序**。字段顺序是 prompt-cache 策略的一部分：稳定字段在前 → 更长的 provider prefix 可复用。`dictationText`、`replyToMessage`、`userDictionaryMatches` 故意放在最后。
- **不要将 `dictionaryAliasHints` 原始列表转发给模型**。它可能很大且包含无关项；只有 `buildUserDictionaryMatches()` 的匹配子集才进入 prompt，且有 MAX_USER_DICTIONARY_MATCHES / MAX_USER_DICTIONARY_MATCHES_CHARS 硬上界。
- **不要让 stall watchdog 计算原始音频时长**。只计 voiced chunk（RMS ≥ 300 的 PCM16），否则静默思考暂停会触发误警告。
- **network recovery 上限是 `ASR_NETWORK_RECOVERY_MAX_ATTEMPTS = 3`**（仅对显式 transport error/disconnected 事件重试，不对 partial 空隙重试）；provider 自身仍需保证 replay/merge 安全，超过上限直接把失败暴露给用户。不要放宽此上限，也不要把它用于 partial 空隙触发。
- **不要放松 `DictationRefiner` 的发散度兜底 (`isRefinementDiverged`)，也不要让它在非 bundled 默认 prompt 下生效**。它是代码而非 prompt 层面拦截模型擅自回答/总结/翻译 dictation 的确定性 backstop（design rule 9），判定标准是内容字符长度（忽略空白/标点/markdown），故意只在使用包内默认 prompt 时启用——host 注入自定义 prompt 可能故意要翻译/改写，该启发式会误判。
- **不要在 `DictationDictionaryAdvisor` 输出中信任模型产出的 term/alias 而不校验**。`normalizeAdvisorActions()` 硬性要求 term 存在于 afterText、alias 存在于 beforeText，防止模型幻觉。
- **不要放宽 `inspectApproximateEditedText` 的 LCS 阈值或移除短文本守卫**。当前阈值 `Math.min(12, Math.max(5, ceil(len*0.45)))` 且 inserted/edited 任一方 < 6 字符时直接拒绝，是为了避免把完全不相关的 currentWindow 误认为用户编辑结果；放宽会引入假阳性词典条目。
- **不要绕开 `BufferedAsrProvider` 自己再手写握手期间的音频缓冲/回放逻辑**。任何并发 connect+capture 的 host 都应该复用这个 wrapper，而不是各自实现一套 buffer-and-replay，否则会重新引入它已修复的竞态类问题（陈旧续体复活、握手中 stop 阻塞、abandoned socket 泄漏）。

## 演进备忘

_仅追加。每次重大改动留一行：日期 - 做了什么 - 原因。_

- 2026-05-22 — `DictationExternalEditInspector` 新增 `fullFieldContent`/`selectionLocation`/`selectionLength` 支持全字段锚点搜索，并在锚点/replacement 两层均失败时追加 LCS 近似兜底（`inspectApproximateEditedText`）——解决 Feishu 等外部 app 光标移位或隐藏 pre-paste chrome 导致词典学习静默失败的问题。
- 2026-05-22 — 近似兜底路径的 reason 码从 `replacement_text_extracted` 改为专用的 `approximate_replacement_text_extracted`；`hasStrongInsertedTextOverlap` 新增 < 6 字符短文本拒绝守卫，LCS 阈值上界由 8 提高到 12、系数由 0.35 提高到 0.45——收紧假阳性，避免极短粘贴文本误触近似词典学习。
