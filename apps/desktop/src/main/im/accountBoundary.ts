/**
 * Synchronous ingress gate for the current authenticated account boundary.
 * Transport shutdown may await network I/O, but no newly delivered event may
 * enter account-scoped orchestration after logout has started.
 */
let active = true;

export function activateImAccountBoundary(): void {
  active = true;
}

export function deactivateImAccountBoundary(): void {
  active = false;
}

export function isImAccountBoundaryActive(): boolean {
  return active;
}
