import fs from 'node:fs';

/** Notify an external restart helper only after the main BrowserWindow can render. */
export function markDesktopDevReady(): void {
  const statusPath = process.env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE;
  if (!statusPath) return;

  const tempPath = `${statusPath}.${process.pid}.tmp`;
  try {
    const current = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as { state?: unknown };
    if (current.state !== 'pending') return;
    fs.writeFileSync(
      tempPath,
      `${JSON.stringify({ state: 'ready', pid: process.pid, at: Date.now() })}\n`,
      { mode: 0o600 },
    );
    fs.renameSync(tempPath, statusPath);
  } catch {
    // Readiness reporting is diagnostic-only; never make the app fail to show.
    fs.rmSync(tempPath, { force: true });
  }
}
