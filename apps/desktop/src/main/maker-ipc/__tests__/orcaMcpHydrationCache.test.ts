import { describe, expect, it, beforeEach } from 'vitest';

import {
  knownNonOrcaSessionIds,
  markKnownNonOrcaIfApplicable,
} from '../orcaMcpHydrationCache';

describe('orca MCP hydration cache', () => {
  beforeEach(() => {
    knownNonOrcaSessionIds.clear();
  });

  it('marks direct non-Orca create-session calls as known non-Orca', () => {
    markKnownNonOrcaIfApplicable('session-1', {});
    expect(knownNonOrcaSessionIds.has('session-1')).toBe(true);
  });

  it('does not mark explicit Orca worker vendorOptions as non-Orca', () => {
    markKnownNonOrcaIfApplicable('session-1', {
      vendorOptions: { orcaRole: 'worker' },
    });
    expect(knownNonOrcaSessionIds.has('session-1')).toBe(false);
  });

  it('does not mark explicit Orca role create opts as non-Orca', () => {
    markKnownNonOrcaIfApplicable('session-1', { orcaRole: 'lead' });
    expect(knownNonOrcaSessionIds.has('session-1')).toBe(false);
  });
});
