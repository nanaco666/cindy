/**
 * Synchronous ingress gate for the current authenticated account boundary.
 * Transport shutdown may await network I/O, but no newly delivered event may
 * enter account-scoped orchestration after logout has started.
 */
export type ImAccountGeneration = number;

let active = true;
let generation: ImAccountGeneration = 0;

export function activateImAccountBoundary(): void {
  if (active) return;
  generation += 1;
  active = true;
}

export function deactivateImAccountBoundary(): void {
  if (!active) return;
  active = false;
  generation += 1;
}

/** Capture the active account generation at synchronous event ingress. */
export function captureImAccountGeneration(): ImAccountGeneration | null {
  return active ? generation : null;
}

/** Reject queued work captured by a logged-out or replaced account. */
export function isImAccountGenerationCurrent(token: ImAccountGeneration): boolean {
  return active && token === generation;
}
