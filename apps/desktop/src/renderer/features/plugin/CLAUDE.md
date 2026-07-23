# Plugin Management UI

> Parent map: [`../../../../../../CLAUDE.md`](../../../../../../CLAUDE.md) / [`../../../../../../AGENTS.md`](../../../../../../AGENTS.md)
>
> [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

## Boundary

This module owns the renderer-only Plugin management surface and the shared Plugin/Skill page shell. It consumes the existing Ghost preload/shared contracts; it must not duplicate or modify installation, runtime, permission enforcement, OAuth, media, or project-preference persistence logic from main.

## Data and interaction rules

- Installed and restorable data comes from `window.electronAPI.ghosts` and `useInstalledGhosts`.
- Origin is host-owned provisioning metadata, never a publisher claim.
- This page edits global enablement through `ghosts.setEnabled`. Existing project-scoped preferences remain host-owned and are not exposed or mutated by the new Plugin page.
- List/detail adapters expose only manifest and install-record facts. Marketplace metrics or inferred source/location labels are forbidden.
- Plugin package icons are rendered from `InstalledGhost.iconDataUrl`; packages without one receive a restrained, theme-aware functional symbol selected from local renderer icons. The host does not maintain a parallel brand icon registry.
- Plugin and Skill retain one shared width, toolbar, search behavior, and transition system through `PluginManagementLayout`.
- The "团队共享"(enterprise) group is membership-gated: only `useAuth().user.membershipKind === 'org'` renders the enterprise filter tab or lists enterprise-origin entries (catalog and installed shortcuts). Personal or missing identity fails closed to hidden. Detail deep links stay reachable so already-installed enterprise plugins remain manageable.

## Inventory

- `GhostPluginPage.tsx` — coordinates catalog filtering, installed/restorable states, installation, global enablement, and command launch. Command launch is gated by `ghosts.setupStatus` (host-evaluated readiness): when required credentials/connections/kv params are missing the page shows a confirm dialog and routes into the detail configuration section instead. Supports `/plugins?ghost=<id>` deep links into a plugin detail.
- `GhostPluginDetailView.tsx` — renders configuration, Tool descriptions, complete permissions, host-verified package trust/signature status, and factual installed metadata.
- `PluginManagementLayout.tsx` — shared Plugin/Skill tabs, search toolbar, width, and page shell.
- `plugin-motion.css` — shared compositor-friendly page, tab, and stagger transitions.
- `GhostPluginIcon.tsx` — renders package-owned PNG/SVG assets and the shared functional fallback symbol across catalog, detail, and composer surfaces.
- `lib/ghostPluginViewModel.ts` — adapts Ghost install records, host-owned origin/trust facts, and manifests into renderer-safe list/detail models and classifies functional fallback icon kinds.
- `lib/ghostPluginDetailModel.ts` — normalizes the manifest-authored Plugin description for detail presentation; permissions render directly from the shared Ghost contract.
- `lib/ghostSetupGateModel.ts` — formats the setup-gate dialog description from the host-evaluated `GhostSetupStatus` (missing vs reauth wording).
- `__tests__/PluginManagementLayout.test.tsx` — shared shell regression coverage.
- `__tests__/GhostPluginCard.test.tsx` — installed/restorable card action coverage.
- `__tests__/GhostPluginDetailSections.test.tsx` — Tool, permission, and metadata disclosure coverage.
- `__tests__/ghostSetupGateModel.test.ts` — setup-gate dialog description formatting coverage.
- `__tests__/ghostPluginViewModel.test.ts` — membership-gated enterprise group visibility coverage.

## Verification

Run the three module tests plus the two adjacent `cindy-brain` adapter tests, then lint changed TypeScript/TSX, run i18n validation, and audit the final diff against the current upstream main ref.
