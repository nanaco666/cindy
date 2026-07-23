import { describe, expect, it } from 'vitest';

import type { Catalog, CatalogModel, Provider } from '@cindy/model-providers';

import { deriveAvailableModels } from '../catalog-to-descriptors.js';
import {
  filterProviderCatalogForAccount,
  isProviderSelectable,
} from '../provider-access-policy.js';

function model(id: string): CatalogModel {
  return {
    id,
    name: id,
    contextWindow: 200_000,
    efforts: [],
    defaultEffort: null,
  };
}

function provider(id: string, models: CatalogModel[]): Provider {
  return {
    id,
    name: id,
    source: 'builtin',
    agents: ['claude-code'],
    auth: { method: id === 'xd' ? 'managed' : 'oauth' },
    routing: {},
    models: { 'claude-code': models },
  };
}

function catalog(): Catalog {
  return {
    version: 'test',
    providers: [
      provider('anthropic', [model('shared-model')]),
      provider('xd', [model('shared-model'), model('xd-only-model')]),
    ],
  };
}

describe('provider access policy', () => {
  it('hides Cindy AI only for packaged personal memberships', () => {
    expect(isProviderSelectable('xd', { isPackaged: true, membershipKind: 'personal' })).toBe(
      false,
    );
    expect(isProviderSelectable('xd', { isPackaged: false, membershipKind: 'personal' })).toBe(
      true,
    );
    expect(isProviderSelectable('xd', { isPackaged: true, membershipKind: 'org' })).toBe(true);
    expect(
      isProviderSelectable('anthropic', { isPackaged: true, membershipKind: 'personal' }),
    ).toBe(true);
  });

  it('removes the provider and its exclusive models from packaged personal capabilities', () => {
    const filtered = filterProviderCatalogForAccount(catalog(), {
      isPackaged: true,
      membershipKind: 'personal',
    });

    expect(filtered.providers.map((item) => item.id)).toEqual(['anthropic']);
    expect(deriveAvailableModels(filtered, 'claude-code').map((item) => item.id)).toEqual([
      'shared-model',
    ]);
  });

  it('preserves the original catalog for dev personal and packaged org accounts', () => {
    const input = catalog();
    expect(
      filterProviderCatalogForAccount(input, {
        isPackaged: false,
        membershipKind: 'personal',
      }),
    ).toBe(input);
    expect(
      filterProviderCatalogForAccount(input, {
        isPackaged: true,
        membershipKind: 'org',
      }),
    ).toBe(input);
  });
});
