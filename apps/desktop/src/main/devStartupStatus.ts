import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type DesktopDevMode = 'remote' | 'local' | 'unknown';
export type DesktopDevInstanceState = 'starting' | 'ready' | 'failed';

/** Dev-only runtime provenance persisted under the effective userData directory. */
export interface DesktopDevInstanceRecord {
  schemaVersion: 1;
  instanceId: string;
  pid: number;
  startedAtMs: number;
  updatedAtMs: number;
  rootDir: string;
  commit: string | null;
  mode: DesktopDevMode;
  passive: boolean;
  isolated: boolean;
  userDataDir: string;
  state: DesktopDevInstanceState;
  failure?: {
    code: string;
    message: string;
    detail?: Record<string, unknown>;
  };
}

export interface BeginDesktopDevInstanceOptions {
  userDataDir: string;
  rootDir: string;
  commit?: string | null;
  mode?: DesktopDevMode;
  passive: boolean;
  isolated: boolean;
  pid?: number;
  startedAtMs?: number;
  instanceId?: string;
}

let trackedInstance: { filePath: string; record: DesktopDevInstanceRecord } | null = null;

function atomicWriteJson(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function updateExternalStartupStatus(
  state: 'ready' | 'failed',
  detail: Record<string, unknown>,
): void {
  const statusPath = process.env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE;
  if (!statusPath) return;

  try {
    if (readJson(statusPath)?.state !== 'pending') return;
    atomicWriteJson(statusPath, { state, pid: process.pid, at: Date.now(), ...detail });
  } catch {
    // Startup reporting is diagnostic-only; never turn a report failure into the app failure.
  }
}

function updateTrackedInstance(
  state: DesktopDevInstanceState,
  failure?: DesktopDevInstanceRecord['failure'],
): void {
  if (!trackedInstance) return;
  const record: DesktopDevInstanceRecord = {
    ...trackedInstance.record,
    state,
    updatedAtMs: Date.now(),
    ...(failure ? { failure } : {}),
  };
  try {
    atomicWriteJson(trackedInstance.filePath, record);
    trackedInstance.record = record;
  } catch {
    // Runtime provenance is best-effort and must never stop the product from opening.
  }
}

/**
 * Register this Electron main process before single-instance/passive lock arbitration.
 * The returned cleanup only removes the record when its random instanceId still owns it.
 */
export function beginDesktopDevInstance(
  options: BeginDesktopDevInstanceOptions,
): () => void {
  const pid = options.pid ?? process.pid;
  const startedAtMs = options.startedAtMs ?? Date.now();
  const record: DesktopDevInstanceRecord = {
    schemaVersion: 1,
    instanceId: options.instanceId ?? randomUUID(),
    pid,
    startedAtMs,
    updatedAtMs: startedAtMs,
    rootDir: path.resolve(options.rootDir),
    commit: options.commit ?? null,
    mode: options.mode ?? 'unknown',
    passive: options.passive,
    isolated: options.isolated,
    userDataDir: path.resolve(options.userDataDir),
    state: 'starting',
  };
  const filePath = path.join(record.userDataDir, '.dev-instances', `${pid}.json`);

  try {
    atomicWriteJson(filePath, record);
    trackedInstance = { filePath, record };
  } catch {
    trackedInstance = null;
  }

  return () => {
    if (trackedInstance?.record.instanceId === record.instanceId) trackedInstance = null;
    try {
      if (readJson(filePath)?.instanceId === record.instanceId) {
        fs.rmSync(filePath, { force: true });
      }
    } catch {
      // A stale record is harmless: desktop:whoami verifies that the PID is alive.
    }
  };
}

/** Notify an external restart helper only after the main BrowserWindow can render. */
export function markDesktopDevReady(): void {
  updateTrackedInstance('ready');
  updateExternalStartupStatus('ready', {
    instance: trackedInstance?.record ?? null,
  });
}

/** Preserve the first concrete main-process startup failure for the waiting restart command. */
export function markDesktopDevStartupFailed(
  code: string,
  message: string,
  detail?: Record<string, unknown>,
): void {
  const failure = { code, message, ...(detail ? { detail } : {}) };
  updateTrackedInstance('failed', failure);
  updateExternalStartupStatus('failed', { code, message, ...(detail ? { detail } : {}) });
}
