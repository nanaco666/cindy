---
id: skills
title: Skills and SkillHub
summary: Browse, install, publish, and update agent skills in SkillHub; installed skills appear as slash commands.
status: draft
---
Skills are reusable agent capabilities you package as a folder and load into your sessions. SkillHub is the in-app browser for finding, installing, publishing, and updating them.

**Where skills live on disk:**

- Global (available to every session): `~/.claude/skills/<name>/` — on Windows that's `C:\Users\<you>\.claude\skills\<name>\`.
- Project-scoped (only inside one working directory): `<working-dir>/.claude/skills/<name>/`.
- Each skill is its own folder containing a required `SKILL.md` (the prompt/spec the agent reads). Sibling files and subfolders in that same folder are also visible to the agent.

**Using an installed skill:**

- Type `/` in the composer to open the slash-command palette; your installed skills show up there alongside built-in and agent commands. Pick one to run it.

**Publishing your own skill to SkillHub:**

- Open SkillHub, find the publish action, and point it at the skill's local folder. SkillHub zips the folder and uploads it — it reads your existing directory in place, it does not copy or move anything.
- On first publish, you set the skill's **visibility**: PUBLIC (anyone in the org) or DEPARTMENT_SCOPED (only the departments you choose).
- The local registry records what you published, so SkillHub knows it's "yours" for future updates.

**Updating an already-published skill:**

- On your own skill's detail page in SkillHub, you'll see a **"发布新版本 v{N+1}"** (Publish New Version) button.
- Edit the local folder however you want, click publish-new-version, and the version is **auto-incremented server-side** — you don't pick a version number.
- **Old versions stay live alongside the new one.** Other users who already installed v1 keep using v1 until they choose to update.
- The display name and description are sent on every republish, so editing those metadata fields just means doing a republish.

**Managing an already-published skill:**

- You can change who can see or use your published skill from the SkillHub management menu. The current options are public, shared with selected teams or departments, or private to you.
- You can unpublish a skill from the market. Unpublishing makes it private again and returns ownership to your personal scope; it does not remove copies that other users already installed.
- **Authorship is fixed.** Only the original author's account can publish new versions of a given skill (enforced server-side as `NOT_AUTHOR`).

**Browsing and installing others' skills:**

- SkillHub also lets you browse the marketplace and install skills from there into the global skills directory. You can request a specific version on install; the local registry tracks which version you have.

**Notes:**

- A skill folder without a `SKILL.md` won't be picked up — that file is mandatory at the folder root.
- Project-scoped skills only show up in sessions whose working directory matches; useful for skills that depend on a particular repo's conventions.
- Editing files inside an installed skill folder takes effect on the next session start; you don't need to "reinstall".
- Uninstalling only removes your local copy of a skill. For your own published skills, use unpublish or manage visibility when you want to change market availability.
