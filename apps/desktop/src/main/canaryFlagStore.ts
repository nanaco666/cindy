/**
 * canaryFlagStore.ts
 * ---------------------------------------------------------------------------
 * canary-release V0.1
 *
 * Persists the per-user "isCanary" flag locally so manifestService (which runs
 * on the background poll, *before* renderer mounts and even before login on a
 * fresh install) can decide which manifest URL to fetch from CDN.
 *
 * Storage: plain JSON file at userData/canary-flag.json. The flag is not
 * sensitive — it just toggles between two public CDN URLs — so we don't bother
 * with safeStorage encryption. Plain file also means the value survives
 * safeStorage being unavailable (rare edge case on Linux without keyring).
 *
 * Lifecycle:
 *   - Written by authManager after login / token-refresh / startup-resume when
 *     the server-side User.isCanary === true
 *   - Cleared by authManager when the server returns isCanary === false, AND
 *     on logout (via clearAuth)
 *   - Read by manifestService.fetchManifest() to switch URL between
 *     manifest-{platform}.json and manifest-{platform}-canary.json
 *
 * Why not a module-level variable: the background update poll fires before
 * authManager.initialize() resolves on cold start, so we need a value that
 * survives across launches.
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

import { createLogger } from './logger';

const log = createLogger('canaryFlagStore');

const FLAG_FILE = 'canary-flag.json';

function getFlagPath(): string {
  return path.join(app.getPath('userData'), FLAG_FILE);
}

/**
 * Returns true iff the local flag file exists and contains `{ canary: true }`.
 * Any I/O error or malformed payload → false (fail-safe to stable channel).
 */
export function read(): boolean {
  try {
    const raw = fs.readFileSync(getFlagPath(), 'utf-8');
    const parsed = JSON.parse(raw) as { canary?: unknown };
    return parsed.canary === true;
  } catch {
    return false;
  }
}

export function write(): void {
  try {
    fs.writeFileSync(getFlagPath(), JSON.stringify({ canary: true }));
  } catch (err) {
    log.error('write failed:', err);
  }
}

export function clear(): void {
  try {
    fs.unlinkSync(getFlagPath());
  } catch {
    // ENOENT is fine — flag was never written or already gone
  }
}

/**
 * Convenience: sync local flag to a server-provided value in one call.
 * Used by authManager on every login/refresh/me response that carries isCanary.
 */
export function sync(isCanary: boolean): void {
  if (isCanary) write();
  else clear();
}
