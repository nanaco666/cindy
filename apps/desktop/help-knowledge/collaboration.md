---
id: collaboration
title: Collaboration mode (lead + worker)
summary: Turn on Collab to bring a second agent (the worker) in beside your session and delegate tasks to it.
status: draft
---
Collaboration ("协同" / Collab) lets one session — the **lead** — bring in a second agent — the **worker** — to run alongside it. The lead can delegate tasks to the worker through a built-in MCP, and you watch both panes side by side.

**Turning it on:**

- In a local project session, click the **Collab** pill in the composer toolbar. Claude Code and Codex sessions can both be the lead.
- Pick the worker agent (Claude Code or Codex).
- Start. The view splits — lead on one side, worker on the other.

**While collaborating:**

- The lead delegates tasks to the worker via tool calls; the worker runs independently with its own history, tools, working directory, and model. You can watch its progress live in its pane and intervene in the worker session directly if needed.
- The worker session is created with `bypassPermissions` and inherits the lead's working directory by default. Worker's model defaults to your last "New Maker" selection for that vendor, falling back to the lead's model.
- Closing collab confirms with you first (in-progress work is lost), then ends the active orca workflow and archives the worker session — the conversation history stays searchable.

**Notes:**

- Remote sessions cannot be the lead yet. Local Claude Code and Codex project sessions can both start collab.
- **One worker at a time** per lead session. The same constraint is enforced at the DB level (a partial-unique index allows at most one active workflow per lead).
- A worker session cannot itself start a sub-collab — no nesting.
- If you have two clients (e.g. dev + release) open on the same user account at the same time and start collab on the same session in both, the second one will fail with "开启协同失败" because there's already an active workflow. Close one client or end the existing collab.
