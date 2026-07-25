---
id: connections
title: Connecting external accounts
summary: External accounts (Google, Jira / Confluence, GitHub, GitLab) are connected on their plugin detail pages under Plugins; Slack is bound via the Slack toggle in Settings; Codex sign-in lives in Settings > Model Providers.
tab: connections
status: draft
---
External account connections have moved out of the old "Third-Party Platforms" section — each integration now lives on its own plugin detail page under **Plugins**, and the plugin's tools use the account you connect there.

**Where to connect what:**

- **Slack** — bound via the Slack toggle in Settings (one browser authorization covers both the Slack channel bot and agent Slack tools). Bindings made before 2026-07 lack tool permission — toggle off and on once to re-authorize.
- **Google** (Gmail / Calendar / Drive / Sheets) — handled by the Filo Google plugin (Plugins > Filo Google).
- **Jira / Confluence** — handled by the XD Atlassian plugin (Plugins > XD Atlassian; existing connections are migrated automatically).
- **GitHub** — handled by the Cindy GitHub plugin (Plugins > Cindy GitHub; existing PAT connections are migrated automatically).
- **GitLab** — handled by the Cindy GitLab plugin (Plugins > Cindy GitLab; existing PAT connections are migrated automatically).
- **Codex** — sign in under Settings > Model Providers (separate from the Codex CLI binary the app ships with).
- **FeiShu** (sign-in + bot) — see the FeiShu bot topic; it lives in its own settings section.
- **Cindy AI** — Settings > Model Providers. Mivo and web-search keys are configured on the matching plugin detail pages (XD Mivo / Cindy Web Search).

**Managing connections:**

- Each plugin detail page shows the connected accounts (with status) and lets you reconnect, disconnect, or switch the default account.
- Disconnect removes the local token only; you may also want to revoke access on the provider's side.
- A connection error usually means the token expired or was revoked on the provider's side; reconnect to refresh.
