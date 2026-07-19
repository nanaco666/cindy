/**
 * provider-access-policy — account/runtime gates for user-selectable model providers.
 *
 * Routing keeps consuming the full active catalog. This projection only controls the
 * providers and models exposed as selectable capabilities to product surfaces.
 */

import type { Catalog } from '@lizi/model-providers';

export type ProviderAccessMembershipKind = 'personal' | 'org';

export interface ProviderAccessContext {
  isPackaged: boolean;
  membershipKind: ProviderAccessMembershipKind | null | undefined;
}

const CINDY_AI_PROVIDER_ID = 'xd';

/** Cindy AI is an organization-only selectable provider in packaged releases. */
export function isProviderSelectable(providerId: string, context: ProviderAccessContext): boolean {
  return !(
    context.isPackaged &&
    context.membershipKind === 'personal' &&
    providerId === CINDY_AI_PROVIDER_ID
  );
}

/**
 * Return the catalog projection exposed to provider lists and availableModels.
 * Preserve the original object when no gate applies so dev/org behavior keeps
 * the same references and allocation profile.
 */
export function filterProviderCatalogForAccount(
  catalog: Catalog,
  context: ProviderAccessContext,
): Catalog {
  if (isProviderSelectable(CINDY_AI_PROVIDER_ID, context)) return catalog;
  const providers = catalog.providers.filter((provider) =>
    isProviderSelectable(provider.id, context),
  );
  return providers.length === catalog.providers.length ? catalog : { ...catalog, providers };
}
