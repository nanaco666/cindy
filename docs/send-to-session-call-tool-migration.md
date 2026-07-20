# `send_to_session` 调用方迁移指引

> 类型:迁移指引 / 记录 · 状态:参考 · 相关代码:`packages/lizi-mcps` xdt-helper(`send_to_session` → `handoff` 类目 / `call_tool`)。

## 背景

`send_to_session` 原本是 `cindy_helper` MCP server 里**唯一一个直接顶层注册**的业务工具(其余如 `set_current_session_title` / `rename_sessions` 都注册在内部 registry,走 `list_tools` / `call_tool` 渐进式发现)。

问题:用户想"改 session 名"时,AI 容易**误选** `send_to_session`——它名字带 `session`(撞"操作 session"意图)、又在顶层一步可调;而它不传 `target_session_id` 就会 create 一个新会话,造成凭空建出空会话(见 issue #287)。

本次改动:把 `send_to_session` 从顶层下线,归入 `cindy_helper` 的**新独立类目 `handoff`**,改为经 `call_tool` 调用。改名工具(`set_current_session_title` / `rename_sessions`)在 `control` 类,与 `handoff` 隔离——这样改名场景在「顶层」和「`list_tools(control)` 返回」两层都接触不到 `send_to_session`,从源头消除误选。

**参数、create / jump 语义、返回结构、错误码全部不变**,只是调用入口从"顶层直达"变成"经 `call_tool`"。

## 谁受影响

任何 skill / 自动化 prompt 里直接写了 `mcp__cindy_helper__send_to_session(...)` 的人。不改 → 调用因"工具不存在"失败。

## 怎么改(唯一要做的)

把直达调用包进 `call_tool`,参数原样塞进 `args`:

**Before**

```
mcp__cindy_helper__send_to_session({
  target_session_id: "<sid>",   // 省略 = 新建会话(create);传 = 投递到已有会话(jump)
  message: "...",
  title: "..."                  // create 时新会话标题
})
```

**After**

```
mcp__cindy_helper__call_tool({
  name: "send_to_session",
  args: {
    target_session_id: "<sid>",
    message: "...",
    title: "..."
  }
})
```

## 自查 3 步

1. 在你的 skill / prompt 文件里 grep `send_to_session`。
2. 把每一处 `mcp__cindy_helper__send_to_session({...})` 按上面包一层 `call_tool({ name: 'send_to_session', args: {...} })`。
3. 需要时让 agent 先 `list_tools({category:'handoff'})` 确认它在、schema 没变。

## 两端兼容性(codex / Claude Code 都能用)

本改动**已在 Claude Code 和 Codex 两端实测**(create + jump 均通过),迁移后你的 skill 在两端都能用。两端的工具加载机制不同,只需注意一点:

| | 工具加载机制 | 你要做的 |
|---|---|---|
| **Codex** | 连上 MCP server 后全量加载,`call_tool` 永远在 | 直接 `call_tool({ name: 'send_to_session', args })`,无需额外处理 |
| **Claude Code** | 按需加载(ToolSearch),`call_tool` 不保证一上来就在 agent 手里 | 在 skill 指令里**显式引导"先发现再调用"**(见下) |

**两端通用的稳妥写法**(强烈建议直接加进 skill 指令):

> 调用前先用 `list_tools({ category: 'handoff' })` 确认 `send_to_session` 可用,再用 `call_tool({ name: 'send_to_session', args: {...} })` 执行。

Claude Code 上这句会让 agent 主动把 `call_tool` 加载进来,避免"发现了工具却没有执行入口";Codex 上不写也行(全量加载),写了也无害——**所以无脑加上,一份指令两端通用**。(`maker-github-issue` skill 已按此写法迁移,可直接参考。)

## 迁移后自测(两端各一次)

改完后,在 **Codex** 和 **Claude Code** 会话里各触发一次你的 skill,确认 `send_to_session` 经 `call_tool` 正常工作(投递成功、返回 `ok`)。重点测 **Claude Code**——它是唯一需要留意 `call_tool` 按需加载的一端;Codex 全量加载,预期稳。

## 不需要改的

- 业务参数、返回处理(`target_session_id` / `wake_kind` / 各 `errorCode`)、绑定逻辑全不动——只是外面多包了一层 `call_tool`。
- 如果你只是"往已有会话发消息"或"为业务对象新建会话",用法和以前一模一样。

## 关联

- issue #287(MCP 工具发现与 handoff 防误用流程)。
- 仓库内 `maker-github-issue` skill 已在本次改动同步迁移(create / jump 两处),可作为改写参考:`.claude/skills/maker-github-issue/skill.md`。
