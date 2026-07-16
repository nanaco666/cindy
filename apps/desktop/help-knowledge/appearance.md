---
id: appearance
title: Appearance, theme, language and notifications
summary: Theme, theme family, display language, and desktop / FeiShu notifications — all in Settings > General.
tab: general
status: draft
---
Settings > General controls how the app looks and how it notifies you.

**Appearance:**

- **Theme**: light, dark, or system (follows your OS).
- **Theme family**: pick from the registered theme families; each family supplies its own colors for light and dark. The app uses a VSCode-style token system (see DESIGN.md) so themes only override what they need.
- **Export / open local theme files**: power-user — export the current theme's tokens to a file or open a local theme JSON for inspection / sharing.

**Language:**

- Display language: System / English / 中文 / 日本語 / 한국어. Affects UI text only; agent replies follow your prompt and personalization, not this setting.

**Notifications:**

- **Desktop notification on session finished** — OS-level ping when an agent completes its reply.
- **FeiShu DM on session finished** — requires the FeiShu bot to be configured (see the FeiShu bot topic).

**Notes:**

- Theme changes apply immediately; no restart needed.
- Language changes apply immediately, but a few static strings may need a window reload to update.
