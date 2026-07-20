---
id: integrations
title: What Cindy integrates with
summary: Supported external services — FeiShu, Slack, Google, Jira / Confluence, GitHub, GitLab (via plugins) — and what's not supported.
tab: connections
status: draft
---
At a glance, Cindy integrates with:

- **FeiShu (Lark)** — sign-in (OAuth) and DM-style bot notifications. See the FeiShu bot topic.
- **Slack** — one Slack binding (Settings > Slack toggle) powers both directions: the Slack channel bot for receiving tasks, and agent Slack tools (search / read history / post as the bound user via Slack's hosted MCP) available in every session.
- **Google** — Gmail / Calendar / Drive / Sheets, via the Filo Google plugin (Plugins > Filo Google).
- **Jira / Confluence** — via the XD Atlassian plugin (Plugins > XD Atlassian; one OAuth covers both).
- **GitHub / GitLab** — via the Cindy GitHub and Cindy GitLab plugins (Plugins).
- **The coding agents** — Claude Code and Codex can reach pay-per-token models through **Cindy AI** in Settings > Model Providers.
- **Mivo** (optional) — image / video / music / 3D generation via the built-in XD Mivo plugin; add your Mivo key on its plugin detail page under Plugins.

**Not supported:**

- There is no built-in Discord or Microsoft Teams integration. If you want chat notifications, use the FeiShu bot.
- There's no native Linear integration as a first-party feature — those would have to come via an MCP a user installs themselves.

**Notes:**

- Most of these connections are accessed by the agents through their tools (plugins / MCPs), not directly by the desktop app. Connecting on the plugin detail page is what gives its tools access to your account.
