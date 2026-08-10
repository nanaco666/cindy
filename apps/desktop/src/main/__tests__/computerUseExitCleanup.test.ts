import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { cleanupComputerUseForExit } from '../computer-use-exit-cleanup.js';

const bootstrapSource = readFileSync(new URL('../bootstrap-electron.ts', import.meta.url), 'utf8');

describe('Computer Use exit cleanup', () => {
  it('is registered in the bounded async quit phase', () => {
    expect(bootstrapSource).toContain(
      "onQuit('computer-use', cleanupComputerUseForExit, 'async');",
    );
    expect(bootstrapSource.indexOf("onQuit('computer-use'")).toBeLessThan(
      bootstrapSource.indexOf('installQuitHandler(6000);'),
    );
  });

  it('closes the guide and cleans driver-owned resources on every idempotent call', async () => {
    const closePermissionGuide = vi.fn();
    const cleanupDriverSessions = vi.fn().mockResolvedValue(undefined);

    await cleanupComputerUseForExit({ closePermissionGuide, cleanupDriverSessions });
    await cleanupComputerUseForExit({ closePermissionGuide, cleanupDriverSessions });

    expect(closePermissionGuide).toHaveBeenCalledTimes(2);
    expect(cleanupDriverSessions).toHaveBeenCalledTimes(2);
  });

  it('attempts every cleanup and swallows individual failures', async () => {
    const closePermissionGuide = vi.fn(() => {
      throw new Error('guide close failed');
    });
    const cleanupDriverSessions = vi.fn().mockRejectedValue(new Error('driver cleanup failed'));

    await expect(
      cleanupComputerUseForExit({ closePermissionGuide, cleanupDriverSessions }),
    ).resolves.toBeUndefined();
    expect(closePermissionGuide).toHaveBeenCalledOnce();
    expect(cleanupDriverSessions).toHaveBeenCalledOnce();
  });
});
