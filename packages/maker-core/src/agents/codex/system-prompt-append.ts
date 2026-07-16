// Maker engine 层追加到 Codex 默认 base prompt 后面的引擎级内容。
// agent 端在 codex/index.ts 把本常量 + runtimeConfig.systemPrompt 两段拼成
// developerInstructions, 通过 thread/start 注入 codex 子进程
// (协议见 codex-rs/app-server-protocol/src/protocol/v2.rs:3803)。
//
// 真正的内容写在同目录的 system-prompt-append.md，vite 编译时通过 ?raw 内联为字符串。
//
// 当前 .md 是空的 —— 所有产品级规则（mermaid 渲染、内部系统 MCP 路由、实时信息查询、
// 音频播放器、免责声明）都在 host 层维护：
//   apps/desktop/src/main/maker-host/host-system-prompt.md  (vendor-neutral)
//   apps/desktop/src/main/maker-host/codex-system-prompt.md (Codex host 专属；当前为空——
//   原「绘图走 codex imagegen」规则已删，画图路由交给意识(Ghost)触发体系)
// 由 host 通过 runtimeConfig.systemPrompt 注入，跟本常量在 startSession 拼成一段
// (拼接顺序见 ./index.ts 内 developerInstructions 那段)。
//
// 只有当某条规则**仅在 Codex 引擎层生效**（如 codex-rs 协议细节、approvalPolicy /
// sandbox 行为等真正不可移植到其他 vendor 的内容）时，才往 .md 里加。任何
// vendor-neutral / 依赖桌面端能力的规则一律放 host 层，避免再次出现两份 .md 字节级
// 重复的局面。
import promptText from './system-prompt-append.md?raw';

export const SYSTEM_PROMPT_APPEND = promptText.trim();
