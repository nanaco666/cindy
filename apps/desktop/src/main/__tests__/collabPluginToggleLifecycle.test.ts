import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/** Orca runtime operations that a project-level plugin policy toggle must never invoke. */
const ORCA_TEARDOWN_MARKERS = [
  'disableOrcaInternal',
  'disableOrca',
  'archiveWorkersByTeam',
  'endTeam',
] as const;

describe('collaboration plugin toggle lifecycle invariants', () => {
  it('changes future-session plugin policy without tearing down active collaboration', () => {
    const registerSource = fs.readFileSync(
      path.resolve(__dirname, '../maker-ipc/register.ts'),
      'utf8',
    );
    const handlerStart = registerSource.indexOf(
      'ipcMain.handle(MAKER_INVOKE.PLUGINS_SET_PROJECT_ENABLED',
    );
    const nextHandlerStart = registerSource.indexOf(
      'ipcMain.handle(MAKER_INVOKE.PLUGINS_CLEAR_PROJECT_ENABLED',
      handlerStart,
    );

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(nextHandlerStart).toBeGreaterThan(handlerStart);

    const handlerSource = registerSource.slice(handlerStart, nextHandlerStart);
    expect(handlerSource).toContain(
      'getPluginRegistry().setProjectEnabled(id, workingDir, enabled)',
    );
    for (const marker of ORCA_TEARDOWN_MARKERS) {
      expect(handlerSource, `${marker} must stay outside the project plugin toggle`).not.toContain(
        marker,
      );
    }
  });
});
