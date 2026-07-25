---
id: updates-and-about
title: App updates, version and logs
summary: How auto-updates apply; where to find the app and agent versions, the debug-log toggle, and the logs folder.
tab: about
status: draft
---
Cindy checks for updates automatically and downloads them in the background. When an update is ready, you're prompted to **relaunch** the app to apply it.

**Settings > About:**

- **App version** — the desktop app's release.
- **Claude Code version** / **Codex version** — the bundled agent CLIs the app ships with (these update with the app, not separately).
- **Debug log toggle** — turn on more verbose logging when reproducing a problem. Leave it off for normal use.
- **Open logs folder** — opens the logs directory in your OS file browser, useful when you need to attach logs to a bug report.

**Notes:**

- Auto-update only triggers a relaunch prompt — it never restarts you mid-session unexpectedly.
- If you want to skip auto-update temporarily, you can dismiss the relaunch prompt; the update applies next time you start the app.
- The Claude Code / Codex versions you see here are what the **app's bundled agents** run as — they're independent from any Claude / Codex CLI you have installed globally on your shell.
