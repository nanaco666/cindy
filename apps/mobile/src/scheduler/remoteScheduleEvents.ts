import { useSyncExternalStore } from 'react';
import {
  projectScheduleEvent,
  type ScheduleEventProjection,
} from '@lizi/maker-shared/schedule-events';

export interface RemoteScheduleEventSnapshot {
  lastProjection: ScheduleEventProjection | null;
  runsVersion: number;
  scheduleListVersion: number;
  sessionIndexVersion: number;
  unreadVersion: number;
  version: number;
}

const emptySnapshot: RemoteScheduleEventSnapshot = Object.freeze({
  lastProjection: null,
  runsVersion: 0,
  scheduleListVersion: 0,
  sessionIndexVersion: 0,
  unreadVersion: 0,
  version: 0,
});

const snapshots = new Map<string, RemoteScheduleEventSnapshot>();
const subs = new Set<() => void>();

function emit(): void {
  for (const sub of subs) sub();
}

export const remoteScheduleEventStore = {
  apply(deviceId: string, payload?: unknown): void {
    if (!deviceId) return;
    const projection = projectScheduleEvent(payload);
    const prev = snapshots.get(deviceId) ?? emptySnapshot;
    snapshots.set(deviceId, {
      lastProjection: projection,
      runsVersion: prev.runsVersion + (projection.refresh.runRefresh.mode === 'none' ? 0 : 1),
      scheduleListVersion: prev.scheduleListVersion + (projection.refresh.scheduleList ? 1 : 0),
      sessionIndexVersion: prev.sessionIndexVersion + (projection.refresh.sessionIndex ? 1 : 0),
      unreadVersion: prev.unreadVersion + (projection.refresh.unreadSummary ? 1 : 0),
      version: prev.version + 1,
    });
    emit();
  },

  clearDevice(deviceId: string): void {
    if (!snapshots.delete(deviceId)) return;
    emit();
  },

  clearAll(): void {
    if (snapshots.size === 0) return;
    snapshots.clear();
    emit();
  },

  getSnapshot(deviceId: string): RemoteScheduleEventSnapshot {
    return snapshots.get(deviceId) ?? emptySnapshot;
  },

  getVersion(deviceId: string): number {
    return this.getSnapshot(deviceId).version;
  },

  subscribe(cb: () => void): () => void {
    subs.add(cb);
    return () => subs.delete(cb);
  },
};

export function useRemoteScheduleEventSnapshot(deviceId: string): RemoteScheduleEventSnapshot {
  return useSyncExternalStore(
    remoteScheduleEventStore.subscribe,
    () => remoteScheduleEventStore.getSnapshot(deviceId),
  );
}

export function useRemoteScheduleEventVersion(deviceId: string): number {
  return useSyncExternalStore(
    remoteScheduleEventStore.subscribe,
    () => remoteScheduleEventStore.getVersion(deviceId),
  );
}
