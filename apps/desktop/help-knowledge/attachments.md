---
id: attachments
title: Attaching files and images, and referencing code
summary: Paste / drag images, @-mention files or directories, and add extra reference directories from the composer.
status: draft
---
You can give the agent more than plain text.

**Images:**

- **Paste** an image from the clipboard, or **drag** image files onto the composer.
- Accepted formats: **PNG, JPEG, WEBP** (GIF is not supported — you'll see a toast if you try).
- Per-image size cap: **5 MB** (after the app's internal transcode).
- Per-message attachment cap: **9 images**. Excess files are dropped with a toast telling you how many were skipped.
- Thumbnails appear above the input; click one to open a full-screen lightbox preview (remove from there, or ESC to close).

**`@`-mention to reference files / directories / agents:**

- Type `@` to open the picker. It shows files, directories, and registered agents in one flat list.
- Scope: your session's working directory **plus** any extra reference directories you've added (below).
- Matching is fuzzy, with a boost for prefix matches on the filename.

**Extra reference directories (read-only context for the agent):**

- Click the folder-list button to the right of the permission selector in the composer to add a directory; pick it from the OS folder dialog.
- Per-session; up to **10** extra directories per session.
- Directories that are subdirectories of the current working directory are silently skipped (already covered). Parent directories are flagged with a warning.
- The agent gets read-only access to these directories — it can grep / read but writes go to the working directory.

**Notes:**

- Image attachments are sent with that user message only; they're not implicitly re-included on subsequent turns.
- The `@`-mention just inserts a reference string into your prompt — it's the agent's job to actually open / read the referenced item.
