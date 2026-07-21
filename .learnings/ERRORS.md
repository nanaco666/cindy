# Errors

## 2026-07-21 — Oversized multi-file patch failed on stale context

- **Command:** one large `apply_patch` spanning maker-shared, desktop, mobile, and IM files.
- **Failure:** patch verification could not find the expected import context in `apps/mobile/app/sessions/[sessionId].tsx`; the patch was rejected atomically.
- **Cause:** the patch assumed an import layout that differed from the rebased source.
- **Prevention:** inspect each target's current context and apply small, independently verifiable patches per file or concern.

## 2026-07-21 — Mobile Vitest parsed the React Native Flow entry

- **Command:** `pnpm --filter mobile test -- src/__tests__/fullAccessConfirmation.test.ts`.
- **Failure:** Rollup could not parse `react-native/index.js` at `import typeof`.
- **Cause:** the new unit test imported a module that references `react-native` without using the repository's usual Vitest mock boundary.
- **Prevention:** mock `react-native` before importing React Native-dependent mobile helpers in Vitest tests.

## 2026-07-21 — Root-level ESLint has no flat config

- **Command:** `pnpm exec eslint <changed files>` from the repository root.
- **Failure:** ESLint 9 could not find `eslint.config.js`.
- **Cause:** lint configuration is package-scoped rather than available at the monorepo root.
- **Prevention:** use package-provided lint scripts where present; otherwise rely on the package typecheck and test entrypoints instead of invoking root ESLint directly.
