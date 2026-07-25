---
id: models-and-compat
title: Choosing a model and Compat Mode
summary: Pick the session's model in the composer; enable Compat Mode for gpt-5.4-family models in Personalization.
tab: personalization
status: draft
---
You pick the model a session uses from the **model dropdown in the composer toolbar**. Models are grouped by provider (Anthropic, OpenAI, Google, Moonshot, Zhipu, etc.). The default depends on the agent kind (Claude Code defaults to a Claude sonnet; Codex defaults to a gpt model).

**Switching mid-session:**

- Open the dropdown, pick a different model. It takes effect on the next turn.

**Compat Mode (when you need it):**

- Required for **gpt-5.4 / gpt-5.4-mini** models (and similar non-Anthropic third-party models). Without it, requests fail or strip required fields.
- Why: Claude Code's SDK sends Anthropic-specific fields (`thinking`, `cache_control`, etc.) that non-Anthropic backends reject. Compat Mode routes requests through a local loopback proxy that scrubs those fields before forwarding.

**Turning Compat Mode on:**

- Open Settings > Personalization, find **Compat Mode** under the Tips section, toggle it on.
- Takes effect for **new sessions** — existing sessions keep using whatever mode they started with.

**Notes:**

- Default for Compat Mode is **off** — only flip it when you actually pick a model that needs it.
- Claude and Anthropic models do not need Compat Mode (it's a no-op for them but adds latency).
- If you suddenly see "400" errors after switching to a non-Anthropic model, Compat Mode is almost always the missing piece.
