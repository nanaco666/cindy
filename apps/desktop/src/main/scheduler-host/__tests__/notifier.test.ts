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

function createNotifier(opts?: {
  sendMarkdownText?: ReturnType<typeof vi.fn>;
  shouldNotifyDesktop?: () => boolean;
}): {
  notifier: DesktopNotifier;
  sendMarkdownText: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  const sendMarkdownText = opts?.sendMarkdownText ?? vi.fn(async () => ({ messageId: 'msg-1' }));
  const warn = vi.fn();
  const notifier = new DesktopNotifier({
    getMainWindow: () => null as BrowserWindow | null,
    feishuIm: {
      getOwnerOpenId: vi.fn(() => 'ou_owner'),
      sendMarkdownText,
    } as unknown as FeishuIM,
    logger: { warn },
    shouldNotifyDesktop: opts?.shouldNotifyDesktop ?? (() => true),
  });
  return { notifier, sendMarkdownText, warn };
}

describe('DesktopNotifier desktop status mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps a successful run to done', async () => {
    const { notifier } = createNotifier();

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
      const { notifier } = createNotifier();

      await notifier.notify(schedule, run(status));

      expect(showDesktopSessionEvent).toHaveBeenCalledWith(expect.any(Function), {
        sessionId: 'session-1',
        title: '每日检查',
        kind: 'error',
      });
    },
  );

  it('does not show a scheduler toast when the shared desktop gate is closed', async () => {
    const { notifier } = createNotifier({ shouldNotifyDesktop: () => false });

    await notifier.notify(schedule, run('success'));

    expect(showDesktopSessionEvent).not.toHaveBeenCalled();
  });

  it('renders and sends a successful Feishu notification', async () => {
    const { notifier, sendMarkdownText } = createNotifier();
    const feishuSchedule = {
      ...schedule,
      notify: { desktop: false, feishu: true },
    } as Schedule;

    await notifier.notify(feishuSchedule, run('success'));

    expect(sendMarkdownText).toHaveBeenCalledWith(
      'ou_owner',
      expect.stringContaining('✅ **每日检查**'),
    );
  });

  it('swallows a Feishu send failure after logging it', async () => {
    const sendError = new Error('Feishu unavailable');
    const sendMarkdownText = vi.fn(async () => Promise.reject(sendError));
    const { notifier, warn } = createNotifier({ sendMarkdownText });
    const feishuSchedule = {
      ...schedule,
      notify: { desktop: false, feishu: true },
    } as Schedule;

    await expect(notifier.notify(feishuSchedule, run('failed'))).resolves.toBeUndefined();

    expect(sendMarkdownText).toHaveBeenCalledWith(
      'ou_owner',
      expect.stringContaining('❌ **每日检查**'),
    );
    expect(warn).toHaveBeenCalledWith('feishu notify failed', sendError);
  });
});
