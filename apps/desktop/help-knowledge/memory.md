---
id: memory
title: Memory across conversations
summary: Toggle Maker Memory globally, enable / disable per agent entry, and reset what's remembered — in Settings > Personalization.
tab: personalization
status: draft
---
Memory lets the agents carry context across your conversations — facts about you, your projects, and how you like to work. Without it, every session starts blank.

**Where it lives:**

- Settings > Personalization > Memory.

**Controls:**

- **Maker Memory** — the master toggle. Off = no agent uses memory.
- **Per-agent-entry toggles** — enable / disable native memory independently for Claude Code and Codex. Models from other providers use the setting of the entry they run through.
- **Status** — the section shows each agent entry's memory state at a glance.
- **Reset** — clears what's been remembered for that agent entry. Asks for confirmation first; reset is not undoable.

**What memory is, what it isn't:**

- It's the **agent's** long-term memory across sessions — typically saved as notes the agent writes to itself (a few lines at the end of a session).
- It's **not** the in-session chat history (that's always persisted to the session itself).
- It's **not** related to your Personalization custom instructions (those are standing instructions you write; memory is what the agent writes about you).

**Notes:**

- Memory takes effect on the next agent turn — toggling off mid-conversation doesn't retroactively scrub current context.
- If you change machines or wipe the user data, memory does not migrate (it lives in the local DB).
