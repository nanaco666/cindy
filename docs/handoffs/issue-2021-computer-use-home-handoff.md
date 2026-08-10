# Issue #2021 · Computer Use cross-device handoff

Source device stopped on 2026-08-10 because of memory pressure.

The canonical Chinese handoff was generated at:

`/Users/huangxiaowen/Documents/我的项目/Cindy/issue2021-home-computer-handoff.md`

Use these transfer-only checkpoints from `nanaco666/cindy`:

- PR-1: `handoff/issue-2021-pr1-pi-generation` at `0e0913ca744c410cade8335355865c1b91b40847`
- PR-2: `handoff/issue-2021-pr2-exit-cleanup` at `84ead873a62bd9f1b404cf6b8c754de4567e37d8`
- PR-3: `handoff/issue-2021-pr3-main-owned-setup` at `bb43c6caf2693d0c5d00d8d77d8d13b53c7ee5c6`

Rules:

- One PR per normal Cindy session and independent worktree.
- Do not use Orca workers.
- Start each recovery branch from the latest `makecindy/cindy` main.
- Apply the relevant checkpoint with `git cherry-pick --no-commit <sha>`.
- Review and validate the diff, then create a new final DCO-signed commit. The WIP checkpoint is not review-ready.
- Do not combine the three checkpoints.

Status:

- PR-1 targeted tests 29/29 and Desktop typecheck passed; full unit gate did not finish.
- PR-2 targeted Computer Use/lifecycle tests 161/161 and Desktop typecheck passed; Node 22 full unit gate did not finish.
- PR-3 is incomplete. Main-owned setup state/IPC and Renderer integration were started. Remove unrelated Prettier churn before continuing, then complete remount/cancel/platform tests.

Product decisions:

- `builtinTools.computer.enabled` remains the enablement truth.
- Uninstall removes the plugin from Installed, returns it to Recommended/uninstalled, and turns off the shared Computer Control setting only.
- Do not uninstall the CUA Driver or revoke OS permissions.
- Do not run `cua-driver stop` on Cindy quit.
- Keep the Settings Computer Control card.

