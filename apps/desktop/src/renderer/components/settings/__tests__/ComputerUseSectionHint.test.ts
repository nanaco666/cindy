import { describe, expect, it } from 'vitest';

import { getComputerPermissionIdentityHintKey } from '../ComputerUseSection';

describe('getComputerPermissionIdentityHintKey', () => {
  it('maps legacy-identity-migration to the legacy hint key', () => {
    expect(getComputerPermissionIdentityHintKey('legacy-identity-migration')).toBe(
      'settings.computerUse.directControl.permissions.legacyIdentityMigrationHint',
    );
  });

  it('maps foreign-daemon-identity to the foreign hint key', () => {
    expect(getComputerPermissionIdentityHintKey('foreign-daemon-identity')).toBe(
      'settings.computerUse.directControl.permissions.foreignDaemonIdentityHint',
    );
  });

  it('returns null for arbitrary free-text reason strings', () => {
    expect(getComputerPermissionIdentityHintKey('stale grant detected')).toBeNull();
    expect(getComputerPermissionIdentityHintKey('some-other-code')).toBeNull();
    expect(getComputerPermissionIdentityHintKey('')).toBeNull();
  });

  it('returns null for null and undefined', () => {
    expect(getComputerPermissionIdentityHintKey(null)).toBeNull();
    expect(getComputerPermissionIdentityHintKey(undefined)).toBeNull();
  });
});
