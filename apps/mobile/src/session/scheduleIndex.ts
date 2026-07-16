import { createMobileMakerTransport, type MobileMakerTransport, type RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { isTransientRemoteError } from '@/device-link/remoteRetry';
import { normalizeScheduleList, normalizeScheduleRuns } from '@/scheduler/scheduleModel';
import type { RemoteScheduleRun } from '@/scheduler/types';
import { buildSessionScheduleIndex, type RemoteSessionScheduleInfo } from '@/session/sessionList';

const SCHEDULE_INDEX_RUN_LIMIT = 50;

type LoadSessionScheduleIndexOptions = {
  throwOnTransientRunListError?: boolean;
};

export async function loadSessionScheduleIndex(
  maker: Pick<MobileMakerTransport, 'schedule'>,
  options: LoadSessionScheduleIndexOptions = {},
): Promise<Map<string, RemoteSessionScheduleInfo>> {
  const schedules = normalizeScheduleList(await maker.schedule.list());
  const pairs = await Promise.all(schedules.map(async (schedule) => {
    let runs: RemoteScheduleRun[] = [];
    try {
      runs = normalizeScheduleRuns(await maker.schedule.listRuns(schedule.id, SCHEDULE_INDEX_RUN_LIMIT));
    } catch (error) {
      if (options.throwOnTransientRunListError && isTransientRemoteError(error)) throw error;
      runs = [];
    }
    return [schedule.id, runs] as const;
  }));
  return buildSessionScheduleIndex(schedules, new Map(pairs));
}

export function loadDeviceSessionScheduleIndex(
  deviceId: string,
  invoke: RemoteInvoke,
): Promise<Map<string, RemoteSessionScheduleInfo>> {
  return loadSessionScheduleIndex(createMobileMakerTransport({ deviceId, invoke }));
}

export function replaceSessionScheduleIndexEntries(
  current: Map<string, RemoteSessionScheduleInfo>,
  sessionIds: Iterable<string>,
  next: Map<string, RemoteSessionScheduleInfo>,
): Map<string, RemoteSessionScheduleInfo> {
  const ids = new Set(sessionIds);
  const merged = new Map(current);
  for (const sessionId of ids) merged.delete(sessionId);
  for (const [sessionId, info] of next) {
    if (ids.has(sessionId)) merged.set(sessionId, info);
  }
  return scheduleInfoMapsEqual(current, merged) ? current : merged;
}

function scheduleInfoMapsEqual(
  a: ReadonlyMap<string, RemoteSessionScheduleInfo>,
  b: ReadonlyMap<string, RemoteSessionScheduleInfo>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [sessionId, info] of a) {
    const next = b.get(sessionId);
    if (!next || !scheduleInfoEqual(info, next)) return false;
  }
  return true;
}

function scheduleInfoEqual(a: RemoteSessionScheduleInfo, b: RemoteSessionScheduleInfo): boolean {
  return a.scheduleId === b.scheduleId
    && a.scheduleName === b.scheduleName
    && a.unreadCount === b.unreadCount
    && a.running === b.running
    && a.latestRunAt === b.latestRunAt
    && a.scheduleStatus === b.scheduleStatus
    && stringListsEqual(a.unreadRunIds, b.unreadRunIds);
}

function stringListsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}
