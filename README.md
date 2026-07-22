<p align="center">
  <img src="apps/mobile/assets/splash/cindy-splash-illustration.webp" alt="Cindy" width="200" />
</p>

<h1 align="center">Cindy Client</h1>

<p align="center">
  <strong>CONSIDER IT DONE.</strong><br />
  An all-in-one AI assistant that operates your computer to get real work done — not just answer questions.
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License" /></a>
  <a href="https://github.com/makecindy/cindy/actions/workflows/ci.yml"><img src="https://github.com/makecindy/cindy/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-22%2B-brightgreen.svg" alt="Node" /></a>
  <a href="https://pnpm.io"><img src="https://img.shields.io/badge/pnpm-10-orange.svg" alt="pnpm" /></a>
</p>

<p align="center">
  🌐 <a href="https://cindy.com.cn">cindy.com.cn</a> (China) · <a href="https://cindy.app">cindy.app</a> (Global)
</p>

Cindy runs locally on your own machine, uses your files and logged-in apps, and
is powered by [Claude Code](https://www.anthropic.com/claude-code) and Codex as
its underlying agent engines. It can drive your browser, computer, and phone,
coordinate multiple agents as a team, and dispatch tasks from IM and schedules.

This repository is the open-source **client** for Cindy — the desktop and mobile
apps plus their shared packages, organized as a pnpm monorepo.

## What's in this repo

| Path | Description |
| --- | --- |
| `apps/desktop` | Electron desktop client |
| `apps/mobile` | Expo / React Native mobile client |
| `packages/*` | Shared client capabilities (auth, device-link, agent orchestration, model providers, …) |
| `apps/*-bin` | Vendored agent/tool binaries bundled with the desktop app (claude-code, codex, ripgrep, android-platform-tools) |
| `cindy-protocol/` | Wire protocol shared with the server (git submodule) |

**Not in this repo:** the backend service (`cindy-server`) lives in a separate
repository and is not part of this monorepo. The client is free software; the
hosted experience requires a Cindy account (download & pricing on the website).

## Prerequisites

- **Node.js** 22 LTS or newer
- **pnpm** 10.x (v11 is not yet supported)
- **Git LFS**

## Getting started

```bash
git clone --recurse-submodules https://github.com/makecindy/cindy.git
cd cindy
git lfs pull
pnpm install
```

Already cloned without submodules:

```bash
git submodule update --init --recursive
```

The protocol version is pinned to the commit recorded by this repo. When
upgrading the protocol, the server's submodule pointer must be upgraded in
lockstep to avoid wire-protocol drift.

## Development

### Desktop

```bash
# Connect to the remote API (default)
pnpm restart:desktop:remote

# Connect to a locally running server
pnpm restart:desktop:local
```

`restart:desktop:remote` accepts `--region=cn` (default) / `--region=global`, and
supports isolated sandboxes and passive multi-instance modes. See
[`AGENTS.md`](AGENTS.md) for the full launch-flag reference and the desktop
dev/runtime contract.

### Mobile

```bash
pnpm mobile:sim:start
pnpm --filter mobile typecheck
pnpm --filter mobile test
```

Full mobile dev & release workflow:
[`apps/mobile/docs/dev-and-release-workflow.md`](apps/mobile/docs/dev-and-release-workflow.md)
and [`apps/mobile/RELEASING.md`](apps/mobile/RELEASING.md).

## Testing & validation

```bash
pnpm test:unit                              # full unit gate (required before every PR)

pnpm --filter desktop typecheck
pnpm --filter desktop db:validate
pnpm --filter desktop test:migration-replay
pnpm --filter mobile  typecheck
pnpm --filter mobile  test
```

Database schema changes are **append-only**: historical migrations are frozen by
`apps/desktop/drizzle/migration-baseline.json`, and any change must add a new
migration rather than editing an existing one.

## Architecture

- [`DESIGN.md`](DESIGN.md) — visual design system, color tokens, and UI conventions
- [`AGENTS.md`](AGENTS.md) — engineering rules, launch/runtime contracts, and module boundaries
- [`docs/dev-rules/`](docs/dev-rules/) — deep-dive architecture docs (e.g. Orca multi-agent orchestration)

## Contributing

Contributions go through pull requests into `main`. Before opening a PR:

1. Run `pnpm test:unit` and make sure it passes.
2. Fill in the PR description per [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md).

The engineering rules in [`AGENTS.md`](AGENTS.md) are authoritative for code
style, platform (macOS/Windows) parity, i18n, theming, and review severity.

## Security

Never commit credentials or authorization files to the working tree. If you
discover a security issue, please report it privately rather than opening a
public issue. <!-- TODO: add SECURITY.md with a contact/disclosure address -->

## License / 许可证

Except as otherwise noted, the source code in this repository is licensed under
the [Apache License, Version 2.0](LICENSE).

Model weights, datasets, prompts, trademarks, and other separately identified
materials may be subject to their own license terms and are not automatically
covered by the repository-level Apache-2.0 grant. Third-party open-source
components retain their own copyright and license. Their attribution notices and
SPDX SBOMs are managed under [`docs/legal/`](docs/legal/), with artifact-specific
outputs in [`docs/legal/notices/`](docs/legal/notices/). See [`NOTICE`](NOTICE)
for this project's copyright and attribution information.
