export type ComputerUseSetupIntent = 'enable' | 'permissions-only';

export type ComputerUsePermissionPane = 'accessibility' | 'screen-recording';

export type ComputerUseSetupPhase =
  | 'idle'
  | 'installing'
  | 'checking-permissions'
  | 'requesting-permissions'
  | 'waiting-permissions'
  | 'enabling'
  | 'ready'
  | 'error'
  | 'cancelled';

export type ComputerUseSetupFailure = 'install' | 'permission' | 'enable';

export interface ComputerUseSetupStartRequest {
  intent: ComputerUseSetupIntent;
  openedPane?: ComputerUsePermissionPane;
}

export interface ComputerUseSetupSnapshot<TStatus> {
  operationId: number;
  active: boolean;
  phase: ComputerUseSetupPhase;
  intent: ComputerUseSetupIntent | null;
  status: TStatus | null;
  failure: ComputerUseSetupFailure | null;
  codexMcpRefreshed: boolean | null;
}

/** Runtime validation for the privileged Main-owned setup command. */
export function parseComputerUseSetupStartRequest(
  value: unknown,
): ComputerUseSetupStartRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  const keys = Object.keys(request);
  if (keys.some((key) => key !== 'intent' && key !== 'openedPane')) return null;
  if (request.intent !== 'enable' && request.intent !== 'permissions-only') return null;
  if (
    request.openedPane !== undefined &&
    request.openedPane !== 'accessibility' &&
    request.openedPane !== 'screen-recording'
  ) {
    return null;
  }
  return {
    intent: request.intent,
    ...(request.openedPane ? { openedPane: request.openedPane } : {}),
  };
}
