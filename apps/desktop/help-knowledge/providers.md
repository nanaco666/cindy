---
id: providers
title: Connecting Cindy AI in Model Providers
summary: Connect Cindy AI for Claude Code, Codex, voice input, and utility models in Settings > Model Providers.
tab: providers
status: draft
---
Claude Code, Codex, voice input, and lightweight utility models can use Cindy AI for pay-per-token model access. Without a connected Cindy AI key, Cindy AI models and Cindy AI voice input providers cannot authenticate.

**Setting up Cindy AI:**

- Open Settings > Model Providers.
- Find Cindy AI and click Connect.
- Paste your Cindy AI key in the dialog. The key is stored encrypted on this device and synced across your signed-in devices.

**Status badge meanings in Model Providers:**

- **Connected** — this device has a usable Cindy AI key.
- Not connected — click Connect and enter the key.

**Notes:**

- Direct service keys such as Mivo, Brave Search, and Tavily are configured on the matching plugin detail pages under Plugins.
- Replacing the Cindy AI key takes effect immediately for new turns; existing in-flight requests use the previous key until they finish.
