/**
 * unified-downloader — M7: Cancel & cleanup contracts.
 * ---------------------------------------------------------------------------
 * Tech spec: .sivi/docs/tech_specs/unified-downloader-frontend.md (M7)
 *
 * The cancel logic lives where it actually fires:
 *   - In-flight cancel  → transport.ts (AbortSignal handler aborts net.request)
 *   - Backoff cancel    → retry.ts (sleepInterruptible)
 *   - Queued cancel     → scheduler.ts (tryStart short-circuits aborted tasks)
 *
 * cleanup() lives on the scheduler; this file simply re-exports the
 * conceptual seam so callers can `import { cleanup } from './downloader/cancel'`
 * if they ever need to. Most callers just use the Facade in index.ts.
 */

export { } ; // intentional empty namespace — see header
