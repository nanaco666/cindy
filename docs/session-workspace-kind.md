# Session workspace kind

## Problem

Codex Desktop has two product concepts that both carry a `cwd`:

- Project sessions: the `cwd` is the project root and should appear under sidebar Projects.
- Projectless conversations: the `cwd` is still needed for execution, files, and resume, but it is not a project root.

Relying on `working_dir` alone makes imported Codex projectless conversations look like XDMaker projects.

## Source of Truth

Codex Desktop marks projectless conversations in:

```text
<codex-home>/.codex-global-state.json
```

under:

```json
{
  "projectless-thread-ids": ["..."]
}
```

The Codex `threads.cwd` value is not enough to distinguish the two cases because projectless threads still have a non-empty cwd.

## XDMaker Model

XDMaker stores this distinction as `sessions.workspace_kind`:

- `project`: `working_dir` is a project root and participates in Projects grouping.
- `dialogue`: `working_dir` is only the conversation execution/file directory and must not participate in Projects grouping.

`working_dir` remains preserved for dialogue sessions so imported Codex conversations can continue using their original folders.

## Import Rules

Codex import:

- If the thread id is in `projectless-thread-ids`, import as `workspace_kind = 'dialogue'`.
- Otherwise import as `workspace_kind = 'project'`.
- Re-import always updates `workspace_kind` from Codex global state, even when the local row has a newer `updated_at`. This fixes older rows that were imported before XDMaker understood projectless Codex conversations.
- Migration `0024_reclassify_codex_projectless_dialogues` applies the same repair once on existing local rows using Codex global state, so previously imported projectless conversations move out of Projects without requiring the user to re-import manually.

Claude Code import:

- Import as `workspace_kind = 'project'`.
- Claude JSONL sessions do not have the same Codex projectless marker.

## New XDMaker Sessions

For sessions created in XDMaker:

- New Maker without a selected folder creates `workspace_kind = 'dialogue'`.
- If that dialogue does not provide `working_dir`, main allocates an app-managed
  directory under:

  ```text
  <userData>/dialogues/YYYY-MM-DD/<session-id>/
  ```

  On macOS dev builds this resolves under:

  ```text
  ~/Library/Application Support/xdt-maker/dialogues/YYYY-MM-DD/<session-id>/
  ```

- Creating from a project/file context creates `workspace_kind = 'project'`.
- A dialogue may still have an explicit `working_dir`. Imported Codex
  projectless conversations keep their original Codex `cwd`; future XDT UI can
  also pass an explicit directory with `workspace_kind = 'dialogue'`.

This lets XDMaker use its own folder policy for new dialogues while staying compatible with imported Codex dialogue folders.

## UI Rules

Sidebar grouping uses `workspace_kind`, not just `working_dir`:

- `dialogue` sessions render in the Dialogue section.
- `project` sessions render under Projects if they have a valid `working_dir`.
- Project filters exclude dialogue sessions, even if a dialogue has `working_dir`.
- Dialogue is a top-level sidebar unit, not a pseudo-project. In project-grouped mode,
  Projects renders first and Dialogue renders underneath it, even when there are no dialogue sessions.
- Project ordering/manual drag only applies to real Projects. Dialogue keeps its own section boundary;
  its sessions are sorted inside that section by a Dialogue-specific setting.
- Dialogue sort currently supports recency, oldest-first time, and title sorting. It is intentionally
  kept as runtime UI state for now, not a new persisted preference, to avoid introducing another
  desktop storage permission path. If it is persisted later, it should go through the app's existing
  settings storage rather than ad hoc renderer storage.
- New Maker hides worktree/branch Advanced controls while the draft has no selected project. Those
  controls depend on a real git project directory and are restored once the user selects a project.
  The UI also clears any stale worktree-enabled state when returning to a pure dialogue draft, so a
  hidden control cannot still affect send behavior.

Settings import scan uses the same distinction:

- Project candidates expose `projectDir`.
- Dialogue candidates keep `cwd` but do not expose it as `projectDir`.

## MR Notes

The important design point is that `working_dir` is operational state, while `workspace_kind` is product/sidebar ownership. They must stay separate.

Without that separation, a Codex projectless conversation with a valid cwd will be indistinguishable from a real project session.
