import type { ComputerDriverStatus } from '@cindy/mcps';
import type { BrowserWindow } from 'electron';

import type {
  ComputerUsePermissionPane,
  ComputerUseSetupFailure,
  ComputerUseSetupIntent,
  ComputerUseSetupSnapshot,
  ComputerUseSetupStartRequest,
} from '../../shared/computerUseSetup.js';

type SetupSnapshot = ComputerUseSetupSnapshot<ComputerDriverStatus>;

interface SetupEnableResult {
  codexMcpRefreshed: boolean;
}

export interface ComputerUseSetupServiceDeps {
  getStatus: (options?: {
    forcePermissionProbe?: boolean;
    freshPermissionProbe?: boolean;
    bypassPermissionProbeCache?: boolean;
    passivePermissionProbeOnly?: boolean;
  }) => Promise<ComputerDriverStatus>;
  installDriver: () => Promise<{ status: ComputerDriverStatus }>;
  requestPermissions: (options: {
    status: ComputerDriverStatus;
    openedPane?: ComputerUsePermissionPane;
    ownerWindow: BrowserWindow | null;
    isCancelled: () => boolean;
  }) => Promise<{ status: ComputerDriverStatus }>;
  setEnabled: (enabled: boolean) => Promise<SetupEnableResult>;
  cancelPermissionGrant: () => void;
  closePermissionGuide: () => void;
  onStatusChanged: (snapshot: SetupSnapshot) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  permissionPollIntervalMs?: number;
  permissionPollTimeoutMs?: number;
}

const DEFAULT_PERMISSION_POLL_INTERVAL_MS = 1_500;
const DEFAULT_PERMISSION_POLL_TIMEOUT_MS = 300_000;

function isPermissionReady(status: ComputerDriverStatus): boolean {
  return !status.permissionState?.required || status.permissionState.status === 'granted';
}

function isPermissionInconclusive(status: ComputerDriverStatus): boolean {
  return status.permissionState?.required === true && status.permissionState.status === 'unknown';
}

/**
 * Owns the single Computer Use install/permission operation for the Main
 * process lifetime. Renderer mounts are observers, never lifecycle owners.
 */
export class ComputerUseSetupService {
  private generation = 0;
  private inFlight: Promise<SetupSnapshot> | null = null;
  private enableAfterReady = false;
  private snapshot: SetupSnapshot = {
    operationId: 0,
    active: false,
    phase: 'idle',
    intent: null,
    status: null,
    failure: null,
    codexMcpRefreshed: null,
  };

  constructor(private readonly deps: ComputerUseSetupServiceDeps) {}

  getSnapshot(): SetupSnapshot {
    return { ...this.snapshot };
  }

  start(
    request: ComputerUseSetupStartRequest,
    ownerWindow: BrowserWindow | null = null,
  ): Promise<SetupSnapshot> {
    if (request.intent === 'enable') this.enableAfterReady = true;
    if (this.inFlight) {
      const intent: ComputerUseSetupIntent = this.enableAfterReady ? 'enable' : 'permissions-only';
      if (this.snapshot.intent !== intent) this.publish({ intent });
      return this.inFlight;
    }

    const operationId = ++this.generation;
    this.enableAfterReady = request.intent === 'enable';
    this.publish({
      operationId,
      active: true,
      phase: 'checking-permissions',
      intent: request.intent,
      failure: null,
      codexMcpRefreshed: null,
    });
    const run = this.run(operationId, request, ownerWindow)
      .catch(() => {
        if (!this.isCurrent(operationId)) return this.getSnapshot();
        const failure = this.failureFromPhase(this.snapshot.phase);
        this.publish({ active: false, phase: 'error', failure });
        return this.getSnapshot();
      })
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
    this.inFlight = run;
    return run;
  }

  cancel(): SetupSnapshot {
    if (!this.snapshot.active && this.snapshot.phase !== 'error') return this.getSnapshot();
    ++this.generation;
    this.inFlight = null;
    this.enableAfterReady = false;
    this.deps.cancelPermissionGrant();
    this.deps.closePermissionGuide();
    this.publish({
      operationId: this.generation,
      active: false,
      phase: 'cancelled',
      intent: null,
      failure: null,
      codexMcpRefreshed: null,
    });
    return this.getSnapshot();
  }

  private async run(
    operationId: number,
    request: ComputerUseSetupStartRequest,
    ownerWindow: BrowserWindow | null,
  ): Promise<SetupSnapshot> {
    let status = await this.deps.getStatus({ passivePermissionProbeOnly: true });
    if (!this.isCurrent(operationId)) return this.getSnapshot();
    this.publish({ status });

    if (!status.installed) {
      this.publish({ phase: 'installing' });
      const installed = await this.deps.installDriver();
      if (!this.isCurrent(operationId)) return this.getSnapshot();
      status = installed.status;
      this.publish({ status });
      if (!status.installed) {
        this.publish({ active: false, phase: 'error', failure: 'install' });
        return this.getSnapshot();
      }
    }

    if (status.permissionState?.platform === 'macos') {
      this.publish({ phase: 'checking-permissions' });
      status = await this.deps.getStatus({
        forcePermissionProbe: true,
        freshPermissionProbe: true,
        bypassPermissionProbeCache: true,
      });
      if (!this.isCurrent(operationId)) return this.getSnapshot();
      this.publish({ status });
    }

    if (isPermissionInconclusive(status)) {
      this.publish({ active: false, phase: 'error', failure: 'permission' });
      return this.getSnapshot();
    }

    if (!isPermissionReady(status)) {
      this.publish({ phase: 'requesting-permissions' });
      const granted = await this.deps.requestPermissions({
        status,
        ownerWindow,
        isCancelled: () => !this.isCurrent(operationId),
        ...(request.openedPane ? { openedPane: request.openedPane } : {}),
      });
      if (!this.isCurrent(operationId)) return this.getSnapshot();
      status = granted.status;
      this.publish({ status });
      if (!isPermissionReady(status)) {
        status = await this.waitForPermissions(operationId, status);
        if (!this.isCurrent(operationId)) return this.getSnapshot();
      }
    }

    if (!isPermissionReady(status)) {
      this.publish({ active: false, phase: 'error', failure: 'permission', status });
      return this.getSnapshot();
    }

    if (this.enableAfterReady) {
      this.publish({ phase: 'enabling', intent: 'enable' });
      const result = await this.deps.setEnabled(true);
      if (!this.isCurrent(operationId)) return this.getSnapshot();
      this.publish({ codexMcpRefreshed: result.codexMcpRefreshed });
    }

    this.publish({ active: false, phase: 'ready', status, failure: null });
    return this.getSnapshot();
  }

  private async waitForPermissions(
    operationId: number,
    initialStatus: ComputerDriverStatus,
  ): Promise<ComputerDriverStatus> {
    this.publish({ phase: 'waiting-permissions' });
    const now = this.deps.now ?? Date.now;
    const sleep =
      this.deps.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
    const intervalMs = this.deps.permissionPollIntervalMs ?? DEFAULT_PERMISSION_POLL_INTERVAL_MS;
    const deadline =
      now() + (this.deps.permissionPollTimeoutMs ?? DEFAULT_PERMISSION_POLL_TIMEOUT_MS);
    let status = initialStatus;

    while (this.isCurrent(operationId) && now() < deadline) {
      await sleep(intervalMs);
      if (!this.isCurrent(operationId)) break;
      status = await this.deps.getStatus({
        forcePermissionProbe: true,
        bypassPermissionProbeCache: true,
      });
      if (!this.isCurrent(operationId)) break;
      this.publish({ status });
      if (isPermissionReady(status)) return status;
    }
    return status;
  }

  private isCurrent(operationId: number): boolean {
    return this.generation === operationId && this.snapshot.active;
  }

  private publish(patch: Partial<SetupSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.deps.onStatusChanged(this.getSnapshot());
  }

  private failureFromPhase(phase: SetupSnapshot['phase']): ComputerUseSetupFailure {
    if (phase === 'installing') return 'install';
    if (phase === 'enabling') return 'enable';
    return 'permission';
  }
}
