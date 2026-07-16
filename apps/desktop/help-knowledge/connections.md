---
id: connections
title: Connecting external accounts
summary: External accounts (Slack, Google, Jira / Confluence, GitHub, GitLab) are connected on their ghost detail pages under Settings > Ghosts; Codex sign-in lives in Settings > Model Providers.
tab: connections
status: draft
---
External account connections have moved out of the old "Third-Party Platforms" section — each integration now lives on its own ghost detail page under **Settings > Ghosts**, and the ghost's tools use the account you connect there.

**Where to connect what:**

- **Slack** — handled by the Cindy Slack ghost. Connect on Settings > Ghosts > Cindy Slack (read-write or read-only; existing Slack connections are migrated automatically).
- **Google** (Gmail / Calendar / Drive / Sheets) — handled by the Filo Google ghost (Settings > Ghosts > Filo Google).
- **Jira / Confluence** — handled by the XD Atlassian ghost (Settings > Ghosts > XD Atlassian; existing connections are migrated automatically).
- **GitHub** — handled by the Cindy GitHub ghost (Settings > Ghosts > Cindy GitHub; existing PAT connections are migrated automatically).
- **GitLab** — handled by the Cindy GitLab ghost (Settings > Ghosts > Cindy GitLab; existing PAT connections are migrated automatically).
- **Codex** — sign in under Settings > Model Providers (separate from the Codex CLI binary the app ships with).
- **FeiShu** (sign-in + bot) — see the FeiShu bot topic; it lives in its own settings section.
- **XD Gateway** — Settings > Model Providers. Mivo and web-search keys are configured on the matching ghost detail pages (XD Mivo / Cindy Web Search).

**Managing connections:**

- Each ghost detail page shows the connected accounts (with status) and lets you reconnect, disconnect, or switch the default account.
- Disconnect removes the local token only; you may also want to revoke access on the provider's side.
- A connection error usually means the token expired or was revoked on the provider's side; reconnect to refresh.
