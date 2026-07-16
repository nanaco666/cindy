---
id: providers
title: Connecting XD Gateway in Model Providers
summary: Connect XD Gateway for Gateway-backed Claude Code, Codex, voice input, and utility models in Settings > Model Providers.
tab: providers
status: draft
---
Claude Code, Codex, voice input, and lightweight utility models can use XD Gateway for pay-per-token model access. Without a connected XD Gateway key, Gateway-backed models and Gateway-backed voice input providers cannot authenticate.

**Setting up XD Gateway:**

- Open Settings > Model Providers.
- Find XD Gateway and click Connect.
- Paste your XD Gateway API key in the dialog. The key is stored encrypted on this device and synced across your signed-in devices.

**Status badge meanings in Model Providers:**

- **Connected** — this device has a usable XD Gateway key.
- Not connected — click Connect and enter the key.

**Notes:**

- Direct service keys such as Mivo, Brave Search, and Tavily are configured on the matching ghost detail pages under Settings > Ghosts.
- Replacing the Gateway key takes effect immediately for new turns; existing in-flight requests use the previous key until they finish.
