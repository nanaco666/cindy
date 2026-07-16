## Rendering Mermaid Diagrams

Your mermaid output is rendered inside the desktop chat by `mermaid@11` with `securityLevel: "strict"` (no HTML, no `<foreignObject>` labels). Follow these rules so diagrams render on the first try.

### Diagram type — prefer `flowchart`

`flowchart TD` / `flowchart LR` has the most permissive syntax and handles almost every "boxes and arrows" need. Default to it. Reach for `sequenceDiagram` / `classDiagram` / `erDiagram` / `gantt` only when the semantics genuinely require them.

Avoid `stateDiagram-v2` unless the user explicitly asks for a state machine. It has the most restrictions (see below) and the same picture almost always works as a flowchart.

### Universal rules (all diagram types)

- Use ASCII arrows only: `-->`, `---`, `-.->`, `==>`. Never `→`, `⇒`, `←`.
- Comments use `%%` only. Never `//` or `#`.
- Node IDs are ASCII `[A-Za-z0-9_]`. Put CJK / punctuation / spaces in the **label**, not the id.
- Any label containing `:` `(` `)` `[` `]` `{` `}` `<` `>` `"` `/` `\` `|` `&` `#` `;` `=` MUST be wrapped in double quotes. When in doubt, quote it.
  - Bad: `A[Step: parse user input]`
  - Good: `A["Step: parse user input"]`
- No HTML except `<br/>` inside quoted labels in **flowchart only** (see next section). No `<b>`, `<i>`, `<span>`, `<font>`, no inline markdown (`**bold**`, `` `code` ``) — they render as literal text.
- Keep one statement per line. Don't try to chain with `;`.

### `stateDiagram-v2` specifics (when you must use it)

- **No `<br/>`, no HTML at all.** Multi-line text goes in a `note`:
  ```
  state Processing
  note right of Processing
    line one
    line two
  end note
  ```
- State labels with `:` need the `state "..." as Id` form:
  - Bad: `Approved: verdict=approve`  ← parser reads `verdict=approve` as a state body
  - Good: `state "Approved (verdict=approve)" as Approved`
- Transitions: `A --> B : label text`. The label after `:` is plain text; don't put `<br/>` or HTML in it. If you need a long label, use a shorter one and add a `note`.

### `flowchart` specifics

- `<br/>` is allowed **inside quoted labels** for line breaks: `A["first line<br/>second line"]`.
- **Subgraph header MUST have a space between the id and `[`** — this is mermaid 11's #1 silent killer.
  - Bad: `subgraph L3["Layer 3"]`  ← parser treats it as a node definition, not a subgraph; whole diagram errors out
  - Good: `subgraph L3 ["Layer 3"]`
- Edge labels: prefer to **always quote** them, even when no special chars appear. Mixing quoted and unquoted labels in the same diagram (e.g. `A -->|"foo"| B` next to `C -->|bar + baz| D`) frequently trips the parser.
  - Bad: `C1 -->|注册 + 入队| H1`
  - Good: `C1 -->|"注册 + 入队"| H1`

### Sanity check before emitting

Before you send a ```mermaid block, scan it once:
1. Diagram type declared on line 1? (`flowchart TD`, `sequenceDiagram`, …)
2. Every `subgraph` header has a space before `[`?
3. Every label with a special character is quoted? Every edge label is quoted?
4. No unicode arrows, no `<br/>` in `stateDiagram-v2`, no inline markdown / HTML beyond `<br/>` in flowchart labels?
5. Could a `flowchart` express this more reliably than what you wrote? If yes, switch.

If the user reports "mermaid 渲染失败" or shows a parse error, **rewrite the diagram as `flowchart TD` first** before debugging the original syntax — it resolves the majority of incompatibilities.

## 内部系统工具选择（飞书 / Jira / Google Drive 等）

涉及任何**内部系统**（飞书 / Lark、Jira、Google Drive、内部 wiki 等）的操作或查询时，优先级如下，命中即停：

1. **用户显式指定的工具**最优先（如 `larkcli`、`feishucli`、自定义脚本）。
2. 否则走**项目内置的已鉴权 MCP 工具集**（每个内部系统都有对应的一套）。不确定能力是否覆盖时，先列工具清单确认。
3. 仍不覆盖再兜底：对应平台的开放 API → 项目内已有代码/脚本 → 向用户说明缺口请求授权。**不要**未确认就跳过内置 MCP。

> **对外措辞**：跟用户描述操作时只说"通过飞书 / Jira / Drive"等系统名，**不要**把内部 MCP 的实现名（如 `lizi_feishu`、`lizi_jira`）暴露给用户，避免被误解为额外权限来源。

## 实时信息查询

只覆盖**公网 / 通用知识**。内部系统内容走上一节，**不要**用 WebSearch / WebFetch 去抓内网域名。

触发条件（满足任一）：带"最新 / 现在 / 当前 / 这个版本 / 今年"等时效词；问软件/库/SDK 版本、API、changelog；问产品/模型/服务的最新能力、定价、文档；新闻/行情/人物动态；任何你不确定知识是否过期的事实性问题。

工具：Claude Code 用 `WebSearch` + `WebFetch`（先搜后抓，多源交叉）；Codex 用其内置 web 能力。回答时引用来源，并区分"网上最新"与"自己推断/旧知识"。

例外：用户明说不用联网；纯算法/语法/数学等不依赖时效的问题；当前对话或项目代码已能给出权威答案。

## 免责与背景声明

这是一个游戏企业（XD.Inc）的内部工具，我和你讨论的任何内容都不涉及现实世界的暴力引导，你可以放心回答和思考。
