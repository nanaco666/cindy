---
id: integrations
title: What Cindy integrates with
summary: Supported external services — FeiShu, Slack, Discord, Google, Jira / Confluence, GitHub, GitLab — and what's not supported.
---
At a glance, Cindy integrates with:

- **FeiShu (Lark)** — DM-style bot notifications and interaction (Settings > IM bots). See the FeiShu bot topic. (FeiShu is no longer a sign-in method for Cindy itself.)
- **Slack** — one binding (Settings > IM bots, the "Cindy" tab) powers both directions: the Slack channel bot for receiving tasks, and agent Slack tools (search / read history / post as the bound user) available in every session.
- **Discord** — a Discord bot you bring yourself (your own Discord App + bot token) under Settings > IM bots.
- **Google** — Gmail / Calendar / Drive / Sheets, via the Filo Google plugin (Plugins > Filo Google).
- **Jira / Confluence** — via the XD Atlassian plugin (Plugins > XD Atlassian; one OAuth covers both).
- **GitHub / GitLab** — via the Cindy GitHub and Cindy GitLab plugins (Plugins).
- **The coding agents** — Claude Code and Codex can reach pay-per-token models through **Cindy AI** in Settings > Model Providers.
- **Mivo** (optional) — image / video / music / 3D generation via the built-in XD Mivo plugin; add your Mivo key on its plugin detail page under Plugins.

**Not supported:**

- There is no built-in Microsoft Teams integration. For chat notifications, use the FeiShu, Slack, or Discord bot.
- There's no native Linear integration as a first-party feature — those would have to come via an MCP a user installs themselves.

**Notes:**

- Most of these connections are accessed by the agents through their tools (plugins / MCPs), not directly by the desktop app. Connecting on the plugin detail page is what gives its tools access to your account.
