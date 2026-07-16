---
id: personalization
title: Custom instructions (personalization)
summary: Standing instructions the agents follow across every session — in Settings > Personalization.
tab: personalization
status: draft
---
Personalization is where you give the agents standing instructions that apply to **every** session — tone, language, conventions, things you want the agent to always keep in mind.

**Setting it up:**

- Open Settings > Personalization.
- Write your instructions in the text area, then save.
- Useful examples: "respond in Chinese", "default to TypeScript", "prefer pnpm over npm", "always check tests before reporting done".

**Other things on this page:**

- **Memory** — agent's long-term memory across sessions (see the Memory topic).
- **Compat Mode** — for non-Anthropic models (see the Models and Compat Mode topic).

**Notes:**

- Changes apply to **new turns**; they don't rewrite previous messages in current sessions.
- Per-session overrides (a stricter rule for one specific session) are best done in that session's first message, not here.
- Don't put secrets here — instructions are sent with every prompt.
