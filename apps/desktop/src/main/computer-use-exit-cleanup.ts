import { closeComputerPermissionGuideWindow } from './computer-permission-guide/window.js';
import { createLogger } from './logger.js';
import { cleanupAllComputerDriverSessions } from './mcp-integrations/computer.js';

const log = createLogger('computer-use-exit-cleanup');

export interface ComputerUseExitCleanupDeps {
  closePermissionGuide: () => void;
  cleanupDriverSessions: () => Promise<void>;
}

const defaultDeps: ComputerUseExitCleanupDeps = {
  closePermissionGuide: closeComputerPermissionGuideWindow,
  cleanupDriverSessions: cleanupAllComputerDriverSessions,
};

/** Best-effort cleanup for temporary Computer Use resources owned by this app process. */
export async function cleanupComputerUseForExit(
  deps: ComputerUseExitCleanupDeps = defaultDeps,
): Promise<void> {
  const cleanups = [
    {
      name: 'permission guide',
      run: () => deps.closePermissionGuide(),
    },
    {
      name: 'driver sessions and child processes',
      run: () => deps.cleanupDriverSessions(),
    },
  ];
  const results = await Promise.allSettled(cleanups.map(({ run }) => Promise.resolve().then(run)));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      log.warn(`Computer Use ${cleanups[index]?.name ?? 'resource'} cleanup failed (ignored)`, {
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });
}
