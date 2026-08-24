import { describe, expect, it } from 'vitest';

import { botGroupPermissionDecision } from '../BotGroupInteractionPanel';

describe('Bot group interaction presentation', () => {
  it('reuses the existing permission result without losing Session-scoped updates', () => {
    expect(botGroupPermissionDecision({
      behavior: 'allow',
      updatedInput: { command: 'pnpm test' },
      updatedPermissions: [{ type: 'addRules', destination: 'session' }],
    })).toEqual({
      kind: 'permission',
      behavior: 'allow',
      updatedInput: { command: 'pnpm test' },
      permissionUpdates: [{ type: 'addRules', destination: 'session' }],
    });
  });

  it('maps an explicit denial to the real Session resolver decision', () => {
    expect(botGroupPermissionDecision({
      behavior: 'deny',
      message: 'User denied',
    })).toEqual({
      kind: 'permission',
      behavior: 'deny',
      reason: 'User denied',
    });
  });
});
