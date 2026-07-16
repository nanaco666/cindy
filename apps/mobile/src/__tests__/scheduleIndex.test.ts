import { describe, expect, it, vi } from 'vitest';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import {
  loadSessionScheduleIndex,
  replaceSessionScheduleIndexEntries,
} from '@/session/scheduleIndex';
import type { RemoteSessionScheduleInfo } from '@/session/sessionList';

function makerWithSchedules(
  listRuns: (scheduleId: string, limit?: number) => Promise<unknown>,
): Pick<MobileMakerTransport, 'schedule'> {
  return {
    schedule: {
      list: async () => [
        { id: 'sched-1', name: '巡检', status: 'active' },
        { id: 'broken', name: '失败任务', status: 'active' },
      ],
      listRuns,
    },
  } as unknown as Pick<MobileMakerTransport, 'schedule'>;
}

describe('scheduleIndex', () => {
  it('loads schedule unread and running metadata without failing the whole index on one bad schedule', async () => {
    const listRuns = vi.fn(async (scheduleId: string) => {
      if (scheduleId === 'broken') throw new Error('remote schedule runs unavailable');
      return [
        {
          id: 'run-unread',
          scheduleId: 'sched-1',
          sessionId: 'session-1',
          status: 'success',
          firedAt: Date.parse('2026-01-01T00:01:00.000Z'),
        },
        {
          id: 'run-running',
          scheduleId: 'sched-1',
          sessionId: 'session-1',
          status: 'running',
          firedAt: Date.parse('2026-01-01T00:02:00.000Z'),
        },
      ];
    });

    const index = await loadSessionScheduleIndex(makerWithSchedules(listRuns));

    expect(listRuns).toHaveBeenCalledWith('sched-1', 50);
    expect(listRuns).toHaveBeenCalledWith('broken', 50);
    expect(index.get('session-1')).toMatchObject({
      running: true,
      scheduleId: 'sched-1',
      scheduleName: '巡检',
      unreadCount: 1,
      unreadRunIds: ['run-unread'],
    });
  });

  it('replaces only entries for the refreshed device sessions', () => {
    const current = new Map([
      ['session-1', { scheduleId: 'old', scheduleName: 'Old', unreadRunIds: ['old-run'], unreadCount: 1, running: false, latestRunAt: 1 }],
      ['other-device-session', { scheduleId: 'keep', scheduleName: 'Keep', unreadRunIds: ['keep-run'], unreadCount: 1, running: false, latestRunAt: 1 }],
    ]);
    const next = new Map([
      ['session-1', { scheduleId: 'new', scheduleName: 'New', unreadRunIds: [], unreadCount: 0, running: true, latestRunAt: 2 }],
      ['outside-refreshed-window', { scheduleId: 'ignored', scheduleName: 'Ignored', unreadRunIds: ['ignored'], unreadCount: 1, running: false, latestRunAt: 2 }],
    ]);

    const merged = replaceSessionScheduleIndexEntries(current, ['session-1', 'session-2'], next);

    expect(merged.get('session-1')).toMatchObject({ running: true, scheduleId: 'new' });
    expect(merged.get('other-device-session')).toMatchObject({ scheduleId: 'keep' });
    expect(merged.has('outside-refreshed-window')).toBe(false);
  });

  it('keeps the existing map reference when a refresh is value-equivalent', () => {
    const current = new Map<string, RemoteSessionScheduleInfo>([
      ['session-1', { scheduleId: 'sched-1', scheduleName: 'Daily', scheduleStatus: 'active', unreadRunIds: ['run-1'], unreadCount: 1, running: true, latestRunAt: 2 }],
      ['other-device-session', { scheduleId: 'keep', scheduleName: 'Keep', scheduleStatus: 'active', unreadRunIds: [], unreadCount: 0, running: false, latestRunAt: 1 }],
    ]);
    const next = new Map<string, RemoteSessionScheduleInfo>([
      ['session-1', { scheduleId: 'sched-1', scheduleName: 'Daily', scheduleStatus: 'active', unreadRunIds: ['run-1'], unreadCount: 1, running: true, latestRunAt: 2 }],
    ]);

    const merged = replaceSessionScheduleIndexEntries(current, ['session-1'], next);

    expect(merged).toBe(current);
  });

  it('updates the map when only schedule status changes', () => {
    const current = new Map<string, RemoteSessionScheduleInfo>([
      ['session-1', { scheduleId: 'sched-1', scheduleName: 'Daily', scheduleStatus: 'active', unreadRunIds: [], unreadCount: 0, running: false, latestRunAt: 2 }],
    ]);
    const next = new Map<string, RemoteSessionScheduleInfo>([
      ['session-1', { scheduleId: 'sched-1', scheduleName: 'Daily', scheduleStatus: 'paused', unreadRunIds: [], unreadCount: 0, running: false, latestRunAt: 2 }],
    ]);

    const merged = replaceSessionScheduleIndexEntries(current, ['session-1'], next);

    expect(merged).not.toBe(current);
    expect(merged.get('session-1')?.scheduleStatus).toBe('paused');
  });
});
