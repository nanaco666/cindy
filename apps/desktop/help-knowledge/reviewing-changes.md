---
id: reviewing-changes
title: Reviewing the agent's file changes
summary: Open the diff panel to see every file the agent edited in the session, as unified git-style diffs.
status: draft
---
When the agent edits or writes files, a **diff panel** lets you scan everything that changed across the session.

**Opening it:**

- Look at the **top-right chip stack** above the chat — when the agent has edited at least one file, a compact diff chip (icon + file count) appears. Hover for the tooltip with totals; click to open the panel.
- The chip is hidden when there are zero changes; it appears the moment the first Edit / Write / MultiEdit lands.

**Inside the panel:**

- Files are listed and **collapsed by default**. Click a file row to expand its hunks.
- Diffs are **unified format** (red removed / green added), showing the full file diff (no surrounding-context fold).
- A file with multiple edits shows a `×N` badge plus per-hunk `+/-` stats.

**Panel chrome:**

- **Resize** by dragging the left edge; the width is saved per panel in localStorage.
- **Close** with ESC or by clicking the backdrop; the panel slides out.
- **Double-click the resize handle** to reset to the default width (480px).

**Notes:**

- The panel is **view-only** — there's no "accept hunk", "revert hunk", or "copy diff" button. The agent's edits are already on disk; this is purely for inspection.
- Updates are **batched after a turn finishes**, not streamed live during the agent's edits — so a long edit-heavy turn shows everything at once when it completes.
