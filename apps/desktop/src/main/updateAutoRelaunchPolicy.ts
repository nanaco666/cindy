import {
  getUpdateRelaunchScreenBlockReason,
  type UpdateRelaunchScreenBlockReason,
  type UpdateSystemIdleState,
} from './updateRelaunchSafety';

export const AUTO_UPDATE_IDLE_THRESHOLD_SECONDS = 10 * 60;
export const AUTO_UPDATE_RESUME_COOLDOWN_MS = 60 * 1000;
export const AUTO_UPDATE_BUSY_QUIET_PERIOD_MS = 60 * 1000;

export type AutoRelaunchBlockReason =
  | 'disabled'
  | 'dev'
  | 'not-ready'
  | 'relaunching'
  | 'migration-requires-confirmation'
  | 'busy'
  | 'recent-busy'
  | 'recent-resume'
  | 'user-active'
  | UpdateRelaunchScreenBlockReason;

export interface AutoRelaunchReadinessInput {
  enabled: boolean;
  isDev: boolean;
  status: string;
  isRelaunching: boolean;
  /** 品牌迁移必须由用户点击“重启完成升级”，不能走空闲自动重启。 */
  requiresUserConfirmation: boolean;
  hasBusyTasks: boolean;
  idleTimeSeconds: number;
  idleState: UpdateSystemIdleState;
  /** macOS cannot present an update-launched window while loginwindow owns the screen. */
  blockWhenScreenLocked: boolean;
  nowMs: number;
  lastBusyAtMs: number | null;
  lastResumeAtMs: number | null;
  idleThresholdSeconds?: number;
  busyQuietPeriodMs?: number;
  resumeCooldownMs?: number;
}

export function getAutoRelaunchBlockReason(
  input: AutoRelaunchReadinessInput,
): AutoRelaunchBlockReason | null {
  const idleThresholdSeconds = input.idleThresholdSeconds ?? AUTO_UPDATE_IDLE_THRESHOLD_SECONDS;
  const busyQuietPeriodMs = input.busyQuietPeriodMs ?? AUTO_UPDATE_BUSY_QUIET_PERIOD_MS;
  const resumeCooldownMs = input.resumeCooldownMs ?? AUTO_UPDATE_RESUME_COOLDOWN_MS;

  if (!input.enabled) return 'disabled';
  if (input.isDev) return 'dev';
  if (input.status !== 'ready') return 'not-ready';
  if (input.isRelaunching) return 'relaunching';
  if (input.requiresUserConfirmation) return 'migration-requires-confirmation';
  if (input.hasBusyTasks) return 'busy';
  if (input.lastBusyAtMs !== null && input.nowMs - input.lastBusyAtMs < busyQuietPeriodMs) {
    return 'recent-busy';
  }
  if (
    input.lastResumeAtMs !== null
    && input.nowMs - input.lastResumeAtMs < resumeCooldownMs
  ) {
    return 'recent-resume';
  }
  const screenBlockReason = getUpdateRelaunchScreenBlockReason(
    input.idleState,
    input.blockWhenScreenLocked,
  );
  if (screenBlockReason) return screenBlockReason;
  if (input.idleState === 'active') return 'user-active';
  if (input.idleTimeSeconds < idleThresholdSeconds) return 'user-active';
  return null;
}
