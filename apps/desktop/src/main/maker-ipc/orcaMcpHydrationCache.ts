type OrcaRole = 'lead' | 'worker';

interface OrcaRoleCreateOpts {
  orcaRole?: OrcaRole | null;
  vendorOptions?: Record<string, unknown>;
}

export const knownNonOrcaSessionIds = new Set<string>();

export function readOrcaRoleFromVendorOptions(
  vendorOptions: Record<string, unknown> | undefined,
): OrcaRole | null {
  const role = vendorOptions?.orcaRole;
  return role === 'lead' || role === 'worker' ? role : null;
}

// Direct CREATE_SESSION reuse of an existing Orca session id must pass
// orcaRole/vendorOptions.orcaRole; otherwise this cache will skip the later DB
// lookup. Current normal entrypoints do pass the role and are covered by tests.
export function markKnownNonOrcaIfApplicable(sessionId: string, o: OrcaRoleCreateOpts): void {
  const role = readOrcaRoleFromVendorOptions(o.vendorOptions);
  if (role === 'lead' || role === 'worker') return;
  if (o.orcaRole === 'lead' || o.orcaRole === 'worker') return;
  knownNonOrcaSessionIds.add(sessionId);
}
