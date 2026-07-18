---
id: plan-mode
title: Reviewing and approving plans
summary: When the agent proposes a plan, approve it, edit it, or send feedback before it proceeds.
status: draft
---
For larger tasks the agent may first propose a **plan**, shown as a card in the chat. You decide whether to approve, edit, or send feedback before any code runs.

**Card controls:**

- **Approve** — the agent receives the (possibly edited) plan and starts executing.
- **Feedback** — opens a text row; what you write is sent back to the agent as a denial reason. The agent can then propose a revised plan or take a different path.
- **Edit** — open the plan markdown in the card and edit it directly. Edits are auto-saved (debounced) to a plan file on disk; on Approve the edited version is what the agent uses.
- **Expand / Half / Minimize** — change the card's display size to read or skim it.

**How it appears:**

- The agent emits a `plan_review` event with the plan markdown; the app renders the card in the chat thread and pauses the agent until you respond.

**Notes:**

- This is Cindy's own flow (renderer ↔ main IPC `resolveInteraction`), not the same as the Claude Code SDK's `ExitPlanMode` tool — different mechanics under the hood.
- An approved plan card stays in your chat history with an "approved" state; you can scroll back to it.
- If you close the window while a plan card is open, the agent is still paused waiting for your decision — reopen the session to resolve it.
