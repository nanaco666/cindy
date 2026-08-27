import { randomUUID } from 'node:crypto';

import { app, BrowserWindow, ipcMain } from 'electron';
import { and, eq } from 'drizzle-orm';
import type { Maker } from '@cindy/maker-core';

import type {
  BotLifecycleActionRequest,
  BotLifecycleActionResult,
} from '../../shared/botLifecycle.js';
import { getDbClient } from '../localDb/client/current.js';
import { deleteBotProfileAndDetachSessionsInDb } from '../localDb/ipc/sessions.js';
import {
  botAutomationLinks,
  botLifecycleEvents,
  botProfiles,
  botRoutes,
  botSessionLinks,
} from '../localDb/schema.js';
import { removeBotProfileFolder } from './botProfileFolder.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import { awaitReadyWithTimeout } from './schedule.js';
import type { BotDelegationService } from './botDelegationService.js';
import type { BotDeliveryOutboxService } from './botDeliveryOutboxService.js';
import {
  releaseAllBotWorkspaceLeases,
  retainBotWorkspaceLeases,
} from './botWorkspaceLeaseLifecycle.js';
import { resolveBotCanonicalSession } from './botCanonicalSessionRegistry.js';

const log = createLogger('maker-ipc:bot-lifecycle');

type RouteSuspendStatus = 'active' | 'offline' | 'recovering' | 'error';
type AutomationSuspendStatus = 'active' | 'error';

export interface BotLifecycleServiceDeps {
  maker: Maker;
  getDelegationService: () => BotDelegationService | null;
  getOutboxService: () => BotDeliveryOutboxService | null;
  pauseSchedule?: (scheduleId: string) => Promise<void>;
  resumeSchedule?: (scheduleId: string) => Promise<void>;
  retainWorktrees?: (botId: string) => Promise<number>;
  releaseWorktrees?: (botId: string) => Promise<number>;
  deleteProfileAndDetachSessions?: (
    botId: string,
    sessionIds: string[],
    keepTaskHistory: boolean,
  ) => Promise<void>;
  now?: () => number;
  /** Resume durable work owned by the Bot after lifecycle state is active. */
  onResumed?: (botId: string) => void | Promise<void>;
  /** Refresh hidden runtime services after any lifecycle ownership change. */
  onLifecycleChanged?: (botId: string) => void | Promise<void>;
}

const lifecycleLocks = new Map<
  string,
  { action: BotLifecycleActionRequest['action']; promise: Promise<BotLifecycleActionResult> }
>();

function withBotLifecycleLock(
  botId: string,
  action: BotLifecycleActionRequest['action'],
  run: () => Promise<BotLifecycleActionResult>,
): Promise<BotLifecycleActionResult> {
  const current = lifecycleLocks.get(botId);
  if (current?.action === action) return current.promise;
  const start = current ? current.promise.catch(() => undefined).then(run) : run();
  const next = start.finally(() => {
    if (lifecycleLocks.get(botId)?.promise === next) lifecycleLocks.delete(botId);
  });
  lifecycleLocks.set(botId, { action, promise: next });
  return next;
}

function broadcastBotLifecycleChanged(payload: {
  botId: string;
  action: BotLifecycleActionRequest['action'];
}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(MAKER_PUSH.BOT_LIFECYCLE_CHANGED, payload);
    } catch (error) {
      log.warn('Bot lifecycle broadcast failed', { error: String(error) });
    }
  }
}

function lifecycleResult(
  botId: string,
  action: BotLifecycleActionRequest['action'],
  status: BotLifecycleActionResult['status'],
  affected: Partial<BotLifecycleActionResult['affected']>,
  warnings: string[] = [],
): BotLifecycleActionResult {
  return {
    botId,
    action,
    status,
    affected: {
      sessions: affected.sessions ?? 0,
      routes: affected.routes ?? 0,
      automations: affected.automations ?? 0,
      delegations: affected.delegations ?? 0,
      deliveries: affected.deliveries ?? 0,
      worktrees: affected.worktrees ?? 0,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export function createBotLifecycleService(deps: BotLifecycleServiceDeps) {
  const now = deps.now ?? Date.now;
  const pauseSchedule = deps.pauseSchedule ?? (async (scheduleId: string) => {
    const { scheduler } = await awaitReadyWithTimeout();
    await scheduler.pause(scheduleId);
  });
  const resumeSchedule = deps.resumeSchedule ?? (async (scheduleId: string) => {
    const { scheduler } = await awaitReadyWithTimeout();
    await scheduler.resume(scheduleId);
  });
  const retainWorktrees = deps.retainWorktrees ?? retainBotWorkspaceLeases;
  const releaseWorktrees = deps.releaseWorktrees ?? releaseAllBotWorkspaceLeases;
  const deleteProfileAndDetachSessions =
    deps.deleteProfileAndDetachSessions ?? deleteBotProfileAndDetachSessionsInDb;
  const notifyLifecycleChanged = async (
    botId: string,
    action: BotLifecycleActionRequest['action'],
  ): Promise<void> => {
    broadcastBotLifecycleChanged({ botId, action });
    await deps.onLifecycleChanged?.(botId);
  };

  const readProfile = async (botId: string) => {
    const [profile] = await getDbClient()
      .drizzle.select()
      .from(botProfiles)
      .where(eq(botProfiles.id, botId))
      .limit(1);
    if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
    return profile;
  };

  const readCanonicalSessionId = async (botId: string): Promise<string | null> => {
    const canonical = await resolveBotCanonicalSession(botId);
    return canonical.status === 'resolved' ? canonical.sessionId : null;
  };

  const closeBotSessions = async (botId: string): Promise<{ count: number; warnings: string[] }> => {
    const links = await getDbClient()
      .drizzle.select({ sessionId: botSessionLinks.sessionId })
      .from(botSessionLinks)
      .where(eq(botSessionLinks.botId, botId));
    const ids = [...new Set(links.map((row) => row.sessionId))];
    const settled = await Promise.allSettled(ids.map((sessionId) => deps.maker.closeSession(sessionId)));
    const warnings = settled.flatMap((result, index) =>
      result.status === 'rejected'
        ? [`SESSION_CLOSE_FAILED:${ids[index]}:${String(result.reason)}`]
        : [],
    );
    return { count: ids.length, warnings };
  };

  const pause = async (botId: string): Promise<BotLifecycleActionResult> => {
    const profile = await readProfile(botId);
    const canonicalSessionId = await readCanonicalSessionId(botId);
    if (profile.status === 'archived' || profile.status === 'deleting') {
      throwIpcError('PRECONDITION_FAILED', `Bot 当前状态为 ${profile.status}`);
    }
    const db = getDbClient().drizzle;
    const [routes, automations] = await Promise.all([
      db.select().from(botRoutes).where(eq(botRoutes.botId, botId)),
      db.select().from(botAutomationLinks).where(eq(botAutomationLinks.botId, botId)),
    ]);
    const schedulesToPause = automations
      .filter((row) => row.suspendedStatus === 'active' || row.status === 'active')
      .map((row) => row.scheduleId)
      .filter((value): value is string => !!value);
    const at = now();
    const paused = await getDbClient().tx<{ routes: number; automations: number }>(
      'bots.pauseLifecycle',
      {
        botId,
        canonicalSessionId,
        expectedProfileStatus: profile.status,
        at,
        eventId: randomUUID(),
      },
    );

    const warnings: string[] = [];
    const uniqueSchedulesToPause = [...new Set(schedulesToPause)];
    const scheduleResults = await Promise.allSettled(
      uniqueSchedulesToPause.map((scheduleId) => pauseSchedule(scheduleId)),
    );
    scheduleResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        warnings.push(
          `SCHEDULE_PAUSE_FAILED:${uniqueSchedulesToPause[index]}:${String(result.reason)}`,
        );
      }
    });
    if (warnings.length > 0) {
      // Profile/routes/links are already paused, so no new run can be claimed. Do not
      // continue closing tasks, detaching worktrees or archiving the Bot until every
      // in-flight Scheduler run has acknowledged cancellation. A retry is idempotent:
      // suspendedStatus keeps the original active schedules discoverable.
      await db.insert(botLifecycleEvents).values({
        id: randomUUID(),
        botId,
        sessionId: canonicalSessionId,
        eventType: 'pause-failed',
        payloadJson: JSON.stringify({ warnings }),
        createdAt: now(),
      });
      throwIpcError(
        'PRECONDITION_FAILED',
        '部分 Bot Automation 无法安全停止，Bot 已保持暂停；请重试后再删除',
      );
    }
    const delegationService = deps.getDelegationService();
    const outboxService = deps.getOutboxService();
    const [delegations, deliveries, closed] = await Promise.all([
      delegationService?.cancelDelegationsForBot(
        botId,
        'The Bot was paused by the user.',
      ) ?? Promise.resolve(0),
      outboxService?.suspendForBot(botId) ?? Promise.resolve(0),
      closeBotSessions(botId),
    ]);
    warnings.push(...closed.warnings);
    const completedAt = now();
    await db.insert(botLifecycleEvents).values({
      id: randomUUID(),
      botId,
      sessionId: canonicalSessionId,
      eventType: warnings.length > 0 ? 'paused-with-warnings' : 'paused',
      payloadJson: JSON.stringify({ warnings }),
      createdAt: completedAt,
    });
    const result = lifecycleResult(
      botId,
      'pause',
      'paused',
      {
        sessions: closed.count,
        routes: paused.routes,
        automations: paused.automations,
        delegations,
        deliveries,
      },
      warnings,
    );
    await notifyLifecycleChanged(botId, 'pause');
    return result;
  };

  const resume = async (botId: string): Promise<BotLifecycleActionResult> => {
    const profile = await readProfile(botId);
    const canonicalSessionId = await readCanonicalSessionId(botId);
    if (profile.status === 'archived' || profile.status === 'deleting') {
      throwIpcError('PRECONDITION_FAILED', `Bot 当前状态为 ${profile.status}`);
    }
    const db = getDbClient().drizzle;
    const [routes, automations] = await Promise.all([
      db
        .select()
        .from(botRoutes)
        .where(and(eq(botRoutes.botId, botId), eq(botRoutes.status, 'paused'))),
      db
        .select()
        .from(botAutomationLinks)
        .where(and(eq(botAutomationLinks.botId, botId), eq(botAutomationLinks.status, 'paused'))),
    ]);
    const suspendedRoutes = routes.filter(
      (row): row is typeof row & { suspendedStatus: RouteSuspendStatus } =>
        row.suspendedStatus !== null,
    );
    const suspendedAutomations = automations.filter(
      (row): row is typeof row & { suspendedStatus: AutomationSuspendStatus } =>
        row.suspendedStatus !== null,
    );
    const schedulesToResume = suspendedAutomations
      .filter((row) => row.suspendedStatus === 'active' && row.scheduleId)
      .map((row) => row.scheduleId!);
    const uniqueSchedulesToResume = [...new Set(schedulesToResume)];
    const scheduleResults = await Promise.allSettled(
      uniqueSchedulesToResume.map((scheduleId) => resumeSchedule(scheduleId)),
    );
    const failures = scheduleResults.flatMap((result, index) =>
      result.status === 'rejected'
        ? [`SCHEDULE_RESUME_FAILED:${uniqueSchedulesToResume[index]}:${String(result.reason)}`]
        : [],
    );
    if (failures.length > 0) {
      await db.insert(botLifecycleEvents).values({
        id: randomUUID(),
        botId,
        sessionId: canonicalSessionId,
        eventType: 'resume-failed',
        payloadJson: JSON.stringify({ warnings: failures }),
        createdAt: now(),
      });
      throwIpcError('PRECONDITION_FAILED', '部分 Bot Automation 无法恢复，Bot 仍保持暂停');
    }

    const at = now();
    const resumed = await getDbClient().tx<{ routes: number; automations: number }>(
      'bots.resumeLifecycle',
      {
        botId,
        canonicalSessionId,
        expectedProfileStatus: profile.status,
        at,
        eventId: randomUUID(),
      },
    );
    const deliveries = await (deps.getOutboxService()?.resumeForBot(botId) ?? Promise.resolve(0));
    const result = lifecycleResult(botId, 'resume', 'active', {
      routes: resumed.routes,
      automations: resumed.automations,
      deliveries,
    });
    await notifyLifecycleChanged(botId, 'resume');
    await deps.onResumed?.(botId);
    return result;
  };

  /**
   * Permanent deletion still needs the existing fail-closed shutdown transaction.
   * This is deliberately private: v1 does not expose Bot archive/restore as a product lifecycle.
   */
  const prepareForDeletion = async (request: {
    botId: string;
    worktreeDisposition?: BotLifecycleActionRequest['worktreeDisposition'];
  }): Promise<{ warnings: string[] }> => {
    let profile = await readProfile(request.botId);
    if (profile.status === 'deleting') {
      throwIpcError('PRECONDITION_FAILED', 'Bot 正在永久删除');
    }
    if (profile.status === 'archived') {
      return { warnings: [] };
    }

    if (profile.status !== 'paused') {
      await pause(request.botId);
      profile = await readProfile(request.botId);
    }

    const canonicalSessionId = await readCanonicalSessionId(request.botId);
    const at = now();
    await getDbClient().tx<{ sessions: number }>('bots.archiveLifecycle', {
      botId: request.botId,
      canonicalSessionId,
      expectedProfileStatus: profile.status,
      worktreeDisposition: request.worktreeDisposition ?? 'retain',
      at,
      eventId: randomUUID(),
    });

    const warnings: string[] = [];
    try {
      await (
        deps.getOutboxService()?.cancelForBot(request.botId, 'Bot prepared for deletion')
        ?? Promise.resolve(0)
      );
    } catch (error) {
      warnings.push(`OUTBOX_CANCEL_FAILED:${String(error)}`);
    }
    try {
      await (request.worktreeDisposition === 'recycle'
        ? releaseWorktrees(request.botId)
        : retainWorktrees(request.botId));
    } catch (error) {
      warnings.push(`WORKTREE_DISPOSITION_FAILED:${String(error)}`);
    }
    return { warnings };
  };

  const remove = async (
    request: BotLifecycleActionRequest,
  ): Promise<BotLifecycleActionResult> => {
    const profile = await readProfile(request.botId);
    if (request.confirmName !== profile.displayName) {
      throwIpcError('INVALID_PARAMS', '请输入完整 Bot 名称以确认永久删除');
    }
    if (profile.status === 'deleting') {
      throwIpcError('PRECONDITION_FAILED', 'Bot 已在永久删除流程中');
    }
    let preparationWarnings: string[] = [];
    if (profile.status !== 'archived') {
      const prepared = await prepareForDeletion({
        botId: request.botId,
        worktreeDisposition: request.worktreeDisposition ?? 'retain',
      });
      preparationWarnings = prepared.warnings;
    } else if (request.worktreeDisposition === 'recycle') {
      await releaseWorktrees(request.botId);
    } else {
      await retainWorktrees(request.botId);
    }

    const db = getDbClient().drizzle;
    const links = await db
      .select({ sessionId: botSessionLinks.sessionId })
      .from(botSessionLinks)
      .where(eq(botSessionLinks.botId, request.botId));
    const sessionIds = [...new Set(links.map((row) => row.sessionId))];
    const [delegations, deliveries, closed] = await Promise.all([
      deps.getDelegationService()?.cancelDelegationsForBot(
        request.botId,
        'The Bot was permanently deleted by the user.',
      ) ?? Promise.resolve(0),
      deps.getOutboxService()?.cancelForBot(request.botId, 'Bot permanently deleted')
        ?? Promise.resolve(0),
      closeBotSessions(request.botId),
    ]);

    await deleteProfileAndDetachSessions(
      request.botId,
      sessionIds,
      request.keepTaskHistory === true,
    );

    /*
      伙伴的家一起走 —— `<userData>/bots/<botId>/` 里躺着 SOUL.md、用户画像、
      技能正文,全是用户内容。数据库行删了却把它留在盘上,就是一份没人管得着、
      也没人看得见的残留。

      删失败不改变「已删除」这个结论(数据库那边已经是终态了),但要记一笔:
      沉默地留下用户内容是隐私问题,不是小事。
    */
    try {
      await removeBotProfileFolder(app.getPath('userData'), request.botId);
    } catch (cause) {
      log.warn('remove bot profile folder failed', {
        botId: request.botId,
        error: String(cause),
      });
    }

    const result = lifecycleResult(request.botId, 'delete', 'deleted', {
      sessions: sessionIds.length,
      delegations,
      deliveries,
    }, [...preparationWarnings, ...closed.warnings]);
    await notifyLifecycleChanged(request.botId, 'delete');
    return result;
  };

  const run = (request: BotLifecycleActionRequest): Promise<BotLifecycleActionResult> =>
    withBotLifecycleLock(request.botId, request.action, async () => {
      if (request.action === 'pause') return pause(request.botId);
      if (request.action === 'resume') return resume(request.botId);
      if (request.action === 'delete') return remove(request);
      throwIpcError('PRECONDITION_FAILED', `${request.action} 尚未接入 Bot 生命周期协调器`);
    });

  return { run };
}

export function registerBotLifecycleHandlers(deps: BotLifecycleServiceDeps): void {
  const service = createBotLifecycleService(deps);
  ipcMain.handle(MAKER_INVOKE.BOT_LIFECYCLE_ACTION, async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body = requireObject(raw, 'request');
    const botId = requireString(body.botId, 'botId');
    const action = requireString(body.action, 'action');
    if (!['pause', 'resume', 'delete'].includes(action)) {
      throwIpcError('INVALID_PARAMS', '未知 Bot 生命周期操作');
    }
    return service.run({
      botId,
      action: action as BotLifecycleActionRequest['action'],
      confirmName: typeof body.confirmName === 'string' ? body.confirmName : undefined,
      worktreeDisposition:
        body.worktreeDisposition === 'retain' || body.worktreeDisposition === 'recycle'
          ? body.worktreeDisposition
          : undefined,
      keepTaskHistory: body.keepTaskHistory === true,
    });
  });
}
