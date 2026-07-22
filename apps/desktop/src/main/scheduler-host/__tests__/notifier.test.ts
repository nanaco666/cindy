import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { Schedule, ScheduleRun } from '@lizi/maker-scheduler';
import type { FeishuIM } from 'lizi-im';

import { showDesktopSessionEvent } from '../../notificationService';
import { DesktopNotifier } from '../notifier';

vi.mock('../../notificationService', () => ({
  showDesktopSessionEvent: vi.fn(),
}));

const schedule = {
  id: 'schedule-1',
  name: '每日检查',
  notify: { desktop: true, feishu: false },
} as Schedule;

function run(status: ScheduleRun['status']): ScheduleRun {
  return {
    id: 'run-1',
    scheduleId: schedule.id,
    sessionId: 'session-1',
    firedAt: 1,
    finishedAt: 2,
    status,
  };
}

function createNotifier(): DesktopNotifier {
  return new DesktopNotifier({
    getMainWindow: () => null as BrowserWindow | null,
    feishuIm: {} as FeishuIM,
    logger: { warn: vi.fn() },
  });
}

describe('DesktopNotifier desktop status mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps a successful run to done', async () => {
    const notifier = createNotifier();

    await notifier.notify(schedule, run('success'));

    expect(showDesktopSessionEvent).toHaveBeenCalledWith(expect.any(Function), {
      sessionId: 'session-1',
      title: '每日检查',
      kind: 'done',
    });
  });

  it.each(['failed', 'aborted', 'interrupted'] as const)(
    'maps an incomplete %s run to error',
    async (status) => {
      const notifier = createNotifier();

      await notifier.notify(schedule, run(status));

      expect(showDesktopSessionEvent).toHaveBeenCalledWith(expect.any(Function), {
        sessionId: 'session-1',
        title: '每日检查',
        kind: 'error',
      });
    },
  );
});
