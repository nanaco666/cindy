import type { RemoteSchedule, RemoteScheduleRun } from './scheduleTypes';

export const DELETE_PREVIEW_RUN_LIMIT = 10_000;

export type ScheduleGeneratedSessionDisposition = 'keep' | 'archive' | 'delete';

export interface ScheduleDeletePreview {
  sessionIds: string[];
  sessionCount: number;
  inflightCount: number;
}

export interface ScheduleDeleteTarget {
  id: string;
  name: string;
  source?: RemoteSchedule['source'];
  workingDir?: string;
  projectConfigId?: string;
}

export interface GeneratedSessionDispositionPatch {
  status?: 'archived' | 'deleted';
  pinnedAt?: string | null;
}

export function buildScheduleDeleteTarget(schedule: RemoteSchedule): ScheduleDeleteTarget {
  return {
    id: schedule.id,
    name: schedule.name,
    source: schedule.source,
    workingDir: schedule.workingDir,
    projectConfigId: schedule.projectConfigId,
  };
}

export function collectGeneratedSessionIds(
  runs: readonly RemoteScheduleRun[],
  knownSessionIds: readonly string[] = [],
): string[] {
  const ids = new Set<string>();
  for (const id of knownSessionIds) {
    if (id) ids.add(id);
  }
  for (const run of runs) {
    if (run.sessionId) ids.add(run.sessionId);
  }
  return [...ids];
}

export function buildScheduleDeletePreview(
  runs: readonly RemoteScheduleRun[],
  inflightCount = 0,
  knownSessionIds: readonly string[] = [],
): ScheduleDeletePreview {
  const sessionIds = collectGeneratedSessionIds(runs, knownSessionIds);
  return {
    sessionIds,
    sessionCount: sessionIds.length,
    inflightCount: Math.max(0, Math.trunc(inflightCount) || 0),
  };
}

export function buildGeneratedSessionDispositionPatch(
  disposition: ScheduleGeneratedSessionDisposition,
): GeneratedSessionDispositionPatch | null {
  if (disposition === 'keep') return null;
  if (disposition === 'archive') return { status: 'archived', pinnedAt: null };
  return { status: 'deleted' };
}

export function isProjectAutomationSchedule(target: ScheduleDeleteTarget): boolean {
  return target.source === 'project' && !!target.workingDir && !!target.projectConfigId;
}

export function describeScheduleDeletePreview(preview: ScheduleDeletePreview): string {
  const sessionPart = preview.sessionCount === 0
    ? '没有找到由它生成的会话'
    : `找到 ${preview.sessionCount} 个由它生成的会话`;
  if (preview.inflightCount > 0) {
    return `${sessionPart}，还有 ${preview.inflightCount} 次执行正在进行`;
  }
  return sessionPart;
}
