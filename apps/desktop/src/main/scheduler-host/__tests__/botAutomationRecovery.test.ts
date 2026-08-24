import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Maker } from '@cindy/maker-core';
import type { FireContext, Schedule, ScheduleRunner } from '@cindy/maker-scheduler';

const currentDbMocks = vi.hoisted(() => ({
  tx: vi.fn(),
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({ tx: currentDbMocks.tx }),
}));

import * as schema from '../../localDb/schema';
import {
  botAutomationRuns,
  botSessionLinks,
  scheduleRuns,
  sessions,
} from '../../localDb/schema';
import {
  BotAutomationScheduleRunner,
  isCanonicalBotRoutine,
  reconcileBotAutomationRuns,
  requireStrictAutomationRuntime,
} from '../bot-automation-runner';

function createDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE bot_profiles (
      id TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL DEFAULT 'Bot',
      description TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT '🤖',
      avatar_color TEXT NOT NULL DEFAULT 'violet',
      canonical_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      current_version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE bot_profile_versions (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      identity_source TEXT NOT NULL DEFAULT '',
      capabilities_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE schedule_runs (
      id TEXT PRIMARY KEY NOT NULL,
      schedule_id TEXT NOT NULL,
      status TEXT NOT NULL,
      result_text TEXT,
      finished_at INTEGER,
      heartbeat_at INTEGER
    );
    CREATE TABLE bot_automation_links (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL,
      schedule_id TEXT,
      project_binding_id TEXT,
      target_route_id TEXT,
      created_with_profile_version INTEGER NOT NULL DEFAULT 1,
      durable_note_namespace TEXT,
      execution_policy_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      suspended_status TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE bot_automation_runs (
      id TEXT PRIMARY KEY NOT NULL,
      automation_link_id TEXT NOT NULL,
      schedule_run_id TEXT,
      session_id TEXT,
      workspace_lease_id TEXT,
      profile_version INTEGER NOT NULL DEFAULT 1,
      project_binding_id_snapshot TEXT,
      target_route_id_snapshot TEXT,
      target_route_owner_generation_snapshot INTEGER,
      working_dir_snapshot TEXT,
      remote_host_id_snapshot TEXT,
      worktree_path_snapshot TEXT,
      delivery_outbox_id TEXT,
      delivery_status TEXT NOT NULL DEFAULT 'not-requested',
      delivery_error TEXT,
      execution_plan_json TEXT NOT NULL DEFAULT '{}',
      result_text_snapshot TEXT,
      output_artifacts_json TEXT NOT NULL DEFAULT '[]',
      error_message TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE TABLE bot_runtime_snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      profile_version INTEGER NOT NULL,
      agent_kind TEXT NOT NULL,
      working_dir TEXT NOT NULL,
      memory_scope_key TEXT,
      configured_json TEXT NOT NULL DEFAULT '{}',
      resolved_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      prepared_at INTEGER NOT NULL DEFAULT 0,
      applied_at INTEGER,
      failed_at INTEGER,
      failure_json TEXT
    );
    CREATE TABLE bot_session_links (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      profile_version INTEGER NOT NULL DEFAULT 1,
      role TEXT NOT NULL,
      channel_id TEXT,
      route_key TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER
    );
    CREATE TABLE bot_project_bindings (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL,
      project_key TEXT NOT NULL,
      working_dir TEXT NOT NULL,
      remote_host_id TEXT,
      default_branch TEXT,
      workspace_policy TEXT NOT NULL DEFAULT 'none',
      is_default INTEGER NOT NULL DEFAULT 0,
      allowed_paths_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE bot_workspace_leases (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL,
      project_binding_id TEXT NOT NULL,
      lease_key TEXT NOT NULL DEFAULT 'shared',
      anchor_session_id TEXT,
      worktree_path TEXT,
      base_repo TEXT NOT NULL,
      branch TEXT,
      source_branch TEXT,
      remote_host_id TEXT,
      generation INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      last_heartbeat_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      released_at INTEGER
    );
    CREATE TABLE bot_workspace_attachments (
      id TEXT PRIMARY KEY NOT NULL,
      lease_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      access TEXT NOT NULL DEFAULT 'read-write',
      created_at INTEGER NOT NULL DEFAULT 0,
      detached_at INTEGER
    );
    CREATE TABLE bot_routes (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL,
      current_session_id TEXT,
      channel_id TEXT,
      owner_generation INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active'
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function executionPlan(
  targetSessionId: string | null,
  targetRouteId: string | null = null,
  ownerGeneration: number | null = null,
): string {
  return JSON.stringify({
    version: 1,
    createdAt: 1,
    deadlineAt: 100,
    botId: 'bot-1',
    profile: {},
    workspace: null,
    delivery: { targetRouteId, ownerGeneration, targetSessionId },
    limits: {},
    delegation: { mode: 'none', targets: [] },
  });
}

describe('Bot automation restart recovery', () => {
  beforeEach(() => {
    currentDbMocks.tx.mockReset();
    currentDbMocks.tx.mockResolvedValue(undefined);
  });

  it('recognizes only same-profile canonical turns as Hermes routines', () => {
    expect(isCanonicalBotRoutine({
      targetRouteId: null,
      canonicalSessionId: 'canonical',
      targetSessionId: 'canonical',
    })).toBe(true);
    expect(isCanonicalBotRoutine({
      targetRouteId: 'telegram-route',
      canonicalSessionId: 'canonical',
      targetSessionId: 'canonical',
    })).toBe(false);
    expect(isCanonicalBotRoutine({
      targetRouteId: null,
      canonicalSessionId: 'canonical',
      targetSessionId: 'worker',
    })).toBe(false);
  });

  it('runs a same-profile Routine directly in the canonical Session', async () => {
    const { sqlite, db } = createDb();
    sqlite.prepare("INSERT INTO sessions (id, status, updated_at) VALUES ('canonical', 'active', 1)").run();
    sqlite.prepare(`
      INSERT INTO bot_profiles (
        id, display_name, canonical_session_id, status, current_version, created_at, updated_at
      ) VALUES ('bot-1', 'Routine Bot', 'stale-mirror', 'active', 2, 1, 1)
    `).run();
    sqlite.prepare(`
      INSERT INTO bot_profile_versions (
        id, bot_id, version, identity_source, capabilities_json, created_at
      ) VALUES ('version-1', 'bot-1', 1, 'You are Routine Bot.', ?, 1)
    `).run(JSON.stringify({
      automation: true,
      permissions: 'trusted',
      harness: 'codex',
      model: 'gpt-5.6-sol',
    }));
    sqlite.prepare(`
      INSERT INTO bot_profile_versions (
        id, bot_id, version, identity_source, capabilities_json, created_at
      ) VALUES ('version-2', 'bot-1', 2, 'Pending identity.', '{}', 2)
    `).run();
    sqlite.prepare(`
      INSERT INTO bot_session_links (
        id, bot_id, session_id, profile_version, role, created_at
      ) VALUES ('canonical-link', 'bot-1', 'canonical', 1, 'canonical', 1)
    `).run();
    sqlite.prepare(`
      INSERT INTO bot_runtime_snapshots (
        id, bot_id, session_id, profile_version, agent_kind, working_dir,
        resolved_json, status, prepared_at, applied_at
      ) VALUES (
        'runtime-1', 'bot-1', 'canonical', 1, 'codex', '/existing/project',
        '{"unavailableSkills":[],"memoryRefs":[]}', 'applied', 1, 1
      )
    `).run();
    sqlite.prepare(`
      INSERT INTO bot_automation_links (
        id, bot_id, schedule_id, created_with_profile_version,
        durable_note_namespace, execution_policy_json, status, created_at, updated_at
      ) VALUES (
        'automation-1', 'bot-1', 'schedule-1', 1,
        'automation:automation-1', '{}', 'active', 1, 1
      )
    `).run();

    const createSession = vi.fn();
    const closeSession = vi.fn(async () => undefined);
    const enqueueDelivery = vi.fn(async () => ({ id: 'outbox-should-not-exist' }));
    const delegateFire = vi.fn<ScheduleRunner['fire']>(async (delegatedSchedule) => ({
      sessionId: delegatedSchedule.targetSessionId ?? '',
      resultText: 'Routine result',
    }));
    const runner = new BotAutomationScheduleRunner({
      delegate: { fire: delegateFire },
      maker: { createSession, closeSession } as unknown as Maker,
      getDb: () => db,
      enqueueDelivery,
    });
    const schedule: Schedule = {
      id: 'schedule-1',
      name: 'Daily report',
      prompt: 'Summarize the current project.',
      source: 'bot',
      kind: 'cron',
      cronExpr: '0 9 * * *',
      timezone: 'Asia/Singapore',
      recurring: true,
      manual: false,
      agentKind: 'codex',
      workspaceKind: 'project',
      workingDir: '/schedule/should-not-override',
      useWorktree: false,
      notify: { desktop: false, feishu: false },
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    };
    const ctx: FireContext = {
      runId: 'schedule-run-1',
      firedAt: 2,
      signal: new AbortController().signal,
      onSessionBound: vi.fn(async () => undefined),
    };

    await expect(runner.fire(schedule, ctx)).resolves.toEqual({
      sessionId: 'canonical',
      resultText: 'Routine result',
    });

    expect(createSession).not.toHaveBeenCalled();
    expect(delegateFire).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Summarize the current project.',
        targetSessionId: 'canonical',
        model: undefined,
        providerId: undefined,
        effort: undefined,
        workingDir: undefined,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(enqueueDelivery).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
    expect(currentDbMocks.tx).toHaveBeenCalledWith(
      'bots.finalizeAutomationRun',
      expect.objectContaining({
        sessionId: 'canonical',
        status: 'success',
        preserveSessionLink: true,
      }),
    );
    expect(db.select({ role: botSessionLinks.role }).from(botSessionLinks)
      .where(eq(botSessionLinks.sessionId, 'canonical')).get())
      .toEqual({ role: 'canonical' });
    expect(db.select({ status: sessions.status }).from(sessions)
      .where(eq(sessions.id, 'canonical')).get())
      .toEqual({ status: 'active' });
    sqlite.close();
  });

  it('fails closed before dispatch when the frozen runtime is degraded', async () => {
    const { sqlite, db } = createDb();
    sqlite.prepare(`
      INSERT INTO bot_runtime_snapshots (
        id, bot_id, session_id, profile_version, agent_kind, working_dir,
        resolved_json, status, prepared_at
      ) VALUES ('runtime-1', 'bot-1', 'automation-session', 3, 'pi', '/tmp/bot', ?, 'degraded', 10)
    `).run(JSON.stringify({ unavailableSkills: ['release-review'] }));
    const plan = {
      version: 1 as const,
      createdAt: 1,
      deadlineAt: 100,
      botId: 'bot-1',
      profile: {
        profileVersion: 3,
        agentKind: 'pi' as const,
        model: 'grok-4.5',
        capabilitiesSha256: 'capabilities',
        identitySha256: 'identity',
        skills: ['release-review'],
        skillMode: 'allowlist' as const,
        mcpServers: [],
        mcpMode: 'inherit' as const,
        toolsets: [],
        toolsetMode: 'inherit' as const,
        memoryEnabled: true,
        automationEnabled: true,
      },
      workspace: null,
      delivery: { targetRouteId: null, ownerGeneration: null },
      limits: { timeoutMs: 99, budgetTokens: null, maxDelegationDepth: 1 },
      delegation: { mode: 'none' as const, targets: [] },
    };

    await expect(
      requireStrictAutomationRuntime(db, 'automation-session', plan),
    ).rejects.toThrow(/degraded/);

    sqlite.prepare(`
      UPDATE bot_runtime_snapshots
      SET status = 'applied', resolved_json = '{"unavailableSkills":[],"memoryRefs":[]}'
      WHERE id = 'runtime-1'
    `).run();
    await expect(
      requireStrictAutomationRuntime(db, 'automation-session', plan),
    ).resolves.toBeUndefined();
    sqlite.close();
  });

  it('persists and delivers a captured completion before archiving its task', async () => {
    const { sqlite, db } = createDb();
    sqlite.prepare("INSERT INTO sessions (id, status, updated_at) VALUES ('parent', 'active', 1), ('mirror-old', 'active', 1), ('child', 'active', 1)").run();
    sqlite.prepare("INSERT INTO bot_profiles (id, canonical_session_id) VALUES ('bot-1', 'mirror-old')").run();
    sqlite.prepare("INSERT INTO schedules (id, name) VALUES ('schedule-1', 'Daily report')").run();
    sqlite.prepare("INSERT INTO schedule_runs (id, schedule_id, status) VALUES ('schedule-run-1', 'schedule-1', 'running')").run();
    sqlite.prepare("INSERT INTO bot_automation_links (id, bot_id, schedule_id) VALUES ('automation-1', 'bot-1', 'schedule-1')").run();
    sqlite.prepare(`
      INSERT INTO bot_automation_runs (
        id, automation_link_id, schedule_run_id, session_id,
        delivery_status, execution_plan_json, result_text_snapshot, status, updated_at
      ) VALUES ('automation-run-1', 'automation-1', 'schedule-run-1', 'child',
        'not-requested', ?, 'Recovered report.', 'completing', 10)
    `).run(executionPlan('parent'));
    sqlite.prepare(`
      INSERT INTO bot_session_links (id, bot_id, session_id, role, channel_id, route_key)
      VALUES ('canonical-link', 'bot-1', 'parent', 'canonical', NULL, NULL)
    `).run();
    sqlite.prepare(`
      INSERT INTO bot_session_links (id, bot_id, session_id, role, channel_id, route_key)
      VALUES ('link-1', 'bot-1', 'child', 'route', 'bot-1:local', 'automation:schedule-run-1')
    `).run();

    const enqueueDelivery = vi.fn(async () => ({ id: 'outbox-1' }));
    const archiveSession = vi.fn(async (sessionId: string) => {
      db.update(sessions)
        .set({ status: 'archived', updatedAt: 20 })
        .where(eq(sessions.id, sessionId))
        .run();
    });
    const closeSession = vi.fn(async () => undefined);
    await reconcileBotAutomationRuns({
      getDb: () => db,
      maker: { closeSession } as unknown as Maker,
      archiveSession,
      enqueueDelivery,
    });

    expect(enqueueDelivery).toHaveBeenCalledWith(expect.objectContaining({
      botId: 'bot-1',
      sessionId: 'parent',
      idempotencyKey: 'bot-automation-completion:schedule-run-1',
      payload: expect.objectContaining({
        targetSessionId: 'parent',
        message: expect.stringContaining('Recovered report.'),
      }),
    }));
    expect(
      db.select({
        status: botAutomationRuns.status,
        outboxId: botAutomationRuns.deliveryOutboxId,
        deliveryStatus: botAutomationRuns.deliveryStatus,
      }).from(botAutomationRuns).get(),
    ).toEqual({ status: 'success', outboxId: 'outbox-1', deliveryStatus: 'queued' });
    expect(
      db.select({ status: scheduleRuns.status, resultText: scheduleRuns.resultText })
        .from(scheduleRuns).get(),
    ).toEqual({ status: 'success', resultText: 'Recovered report.' });
    expect(db.select({ status: sessions.status }).from(sessions).where(
      eq(sessions.id, 'child'),
    ).get()).toEqual({ status: 'archived' });
    expect(db.select({ role: botSessionLinks.role }).from(botSessionLinks)
      .where(eq(botSessionLinks.sessionId, 'child')).get())
      .toEqual({ role: 'history' });
    expect(archiveSession).toHaveBeenCalledWith('child');
    expect(closeSession).toHaveBeenCalledWith('child');
    sqlite.close();
  });

  it('does not duplicate or archive a same-profile canonical Routine on recovery', async () => {
    const { sqlite, db } = createDb();
    sqlite.prepare("INSERT INTO sessions (id, status, updated_at) VALUES ('canonical', 'active', 1)").run();
    sqlite.prepare("INSERT INTO bot_profiles (id, canonical_session_id) VALUES ('bot-1', 'mirror-old')").run();
    sqlite.prepare("INSERT INTO schedules (id, name) VALUES ('schedule-1', 'Daily report')").run();
    sqlite.prepare("INSERT INTO schedule_runs (id, schedule_id, status) VALUES ('schedule-run-1', 'schedule-1', 'running')").run();
    sqlite.prepare("INSERT INTO bot_automation_links (id, bot_id, schedule_id) VALUES ('automation-1', 'bot-1', 'schedule-1')").run();
    sqlite.prepare(`
      INSERT INTO bot_session_links (id, bot_id, session_id, role, channel_id, route_key)
      VALUES ('canonical-link', 'bot-1', 'canonical', 'canonical', NULL, NULL)
    `).run();
    sqlite.prepare(`
      INSERT INTO bot_automation_runs (
        id, automation_link_id, schedule_run_id, session_id,
        delivery_status, execution_plan_json, result_text_snapshot, status, updated_at
      ) VALUES ('automation-run-1', 'automation-1', 'schedule-run-1', 'canonical',
        'not-requested', ?, 'Canonical result.', 'completing', 10)
    `).run(executionPlan('canonical'));

    const enqueueDelivery = vi.fn(async () => ({ id: 'outbox-should-not-exist' }));
    const archiveSession = vi.fn(async () => undefined);
    const closeSession = vi.fn(async () => undefined);
    await reconcileBotAutomationRuns({
      getDb: () => db,
      maker: { closeSession } as unknown as Maker,
      archiveSession,
      enqueueDelivery,
    });

    expect(enqueueDelivery).not.toHaveBeenCalled();
    expect(archiveSession).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
    expect(db.select({ role: botSessionLinks.role }).from(botSessionLinks)
      .where(eq(botSessionLinks.sessionId, 'canonical')).get())
      .toEqual({ role: 'canonical' });
    expect(db.select({ status: sessions.status }).from(sessions)
      .where(eq(sessions.id, 'canonical')).get())
      .toEqual({ status: 'active' });
    sqlite.close();
  });

  it('restores the frozen IM Route target when a completing run recovers after restart', async () => {
    const { sqlite, db } = createDb();
    sqlite.prepare("INSERT INTO sessions (id, status, updated_at) VALUES ('canonical', 'active', 1), ('route-task', 'active', 1), ('child', 'active', 1)").run();
    sqlite.prepare("INSERT INTO bot_profiles (id, canonical_session_id) VALUES ('bot-1', 'canonical')").run();
    sqlite.prepare("INSERT INTO schedules (id, name) VALUES ('schedule-1', 'Route report')").run();
    sqlite.prepare("INSERT INTO schedule_runs (id, schedule_id, status) VALUES ('schedule-run-1', 'schedule-1', 'running')").run();
    sqlite.prepare("INSERT INTO bot_automation_links (id, bot_id, schedule_id) VALUES ('automation-1', 'bot-1', 'schedule-1')").run();
    sqlite.prepare(`
      INSERT INTO bot_routes (
        id, bot_id, current_session_id, channel_id, owner_generation, status
      ) VALUES ('route-1', 'bot-1', 'route-task', 'telegram-account-1', 7, 'active')
    `).run();
    sqlite.prepare(`
      INSERT INTO bot_automation_runs (
        id, automation_link_id, schedule_run_id, session_id,
        target_route_id_snapshot, target_route_owner_generation_snapshot,
        delivery_status, execution_plan_json, result_text_snapshot, status, updated_at
      ) VALUES ('automation-run-1', 'automation-1', 'schedule-run-1', 'child',
        'route-1', 7, 'not-requested', ?, 'Recovered route report.', 'completing', 10)
    `).run(executionPlan('route-task', 'route-1', 7));
    sqlite.prepare(`
      INSERT INTO bot_session_links (id, bot_id, session_id, role, channel_id, route_key)
      VALUES ('link-1', 'bot-1', 'child', 'route', 'bot-1:local', 'automation:schedule-run-1')
    `).run();

    const enqueueDelivery = vi.fn(async () => ({ id: 'outbox-route-1' }));
    await reconcileBotAutomationRuns({
      getDb: () => db,
      maker: { closeSession: vi.fn(async () => undefined) } as unknown as Maker,
      archiveSession: vi.fn(async () => undefined),
      enqueueDelivery,
    });

    expect(enqueueDelivery).toHaveBeenCalledWith(expect.objectContaining({
      botId: 'bot-1',
      channelId: 'telegram-account-1',
      routeId: 'route-1',
      sessionId: 'route-task',
      ownerGeneration: 7,
      idempotencyKey: 'bot-automation-completion:schedule-run-1',
      payload: expect.objectContaining({
        targetSessionId: 'route-task',
        message: expect.stringContaining('Recovered route report.'),
      }),
    }));
    expect(db.select({
      status: botAutomationRuns.status,
      outboxId: botAutomationRuns.deliveryOutboxId,
      deliveryStatus: botAutomationRuns.deliveryStatus,
    }).from(botAutomationRuns).get()).toEqual({
      status: 'success',
      outboxId: 'outbox-route-1',
      deliveryStatus: 'queued',
    });
    sqlite.close();
  });

  it('does not redirect a recovered completion after the canonical task was renewed', async () => {
    const { sqlite, db } = createDb();
    sqlite.prepare("INSERT INTO sessions (id, status, updated_at) VALUES ('old-canonical', 'archived', 1), ('new-canonical', 'active', 1), ('child', 'active', 1)").run();
    sqlite.prepare("INSERT INTO bot_profiles (id, canonical_session_id) VALUES ('bot-1', 'new-canonical')").run();
    sqlite.prepare("INSERT INTO schedules (id, name) VALUES ('schedule-1', 'Daily report')").run();
    sqlite.prepare("INSERT INTO schedule_runs (id, schedule_id, status) VALUES ('schedule-run-1', 'schedule-1', 'running')").run();
    sqlite.prepare("INSERT INTO bot_automation_links (id, bot_id, schedule_id) VALUES ('automation-1', 'bot-1', 'schedule-1')").run();
    sqlite.prepare(`
      INSERT INTO bot_automation_runs (
        id, automation_link_id, schedule_run_id, session_id,
        delivery_status, execution_plan_json, result_text_snapshot, status, updated_at
      ) VALUES ('automation-run-1', 'automation-1', 'schedule-run-1', 'child',
        'not-requested', ?, 'Recovered report.', 'completing', 10)
    `).run(executionPlan('old-canonical'));

    const enqueueDelivery = vi.fn(async () => ({ id: 'outbox-1' }));
    await reconcileBotAutomationRuns({
      getDb: () => db,
      maker: { closeSession: vi.fn(async () => undefined) } as unknown as Maker,
      enqueueDelivery,
    });

    expect(enqueueDelivery).not.toHaveBeenCalled();
    expect(db.select({
      deliveryStatus: botAutomationRuns.deliveryStatus,
      deliveryError: botAutomationRuns.deliveryError,
    }).from(botAutomationRuns).get()).toEqual({
      deliveryStatus: 'enqueue-failed',
      deliveryError: 'Bot canonical task changed while the automation was running',
    });
    sqlite.close();
  });

  it('does not redirect a recovered Route completion when its task changed without a generation change', async () => {
    const { sqlite, db } = createDb();
    sqlite.prepare("INSERT INTO sessions (id, status, updated_at) VALUES ('old-route-task', 'archived', 1), ('new-route-task', 'active', 1), ('child', 'active', 1)").run();
    sqlite.prepare("INSERT INTO bot_profiles (id, canonical_session_id) VALUES ('bot-1', NULL)").run();
    sqlite.prepare("INSERT INTO schedules (id, name) VALUES ('schedule-1', 'Route report')").run();
    sqlite.prepare("INSERT INTO schedule_runs (id, schedule_id, status) VALUES ('schedule-run-1', 'schedule-1', 'running')").run();
    sqlite.prepare("INSERT INTO bot_automation_links (id, bot_id, schedule_id) VALUES ('automation-1', 'bot-1', 'schedule-1')").run();
    sqlite.prepare(`
      INSERT INTO bot_routes (
        id, bot_id, current_session_id, channel_id, owner_generation, status
      ) VALUES ('route-1', 'bot-1', 'new-route-task', 'telegram-account-1', 7, 'active')
    `).run();
    sqlite.prepare(`
      INSERT INTO bot_automation_runs (
        id, automation_link_id, schedule_run_id, session_id,
        target_route_id_snapshot, target_route_owner_generation_snapshot,
        delivery_status, execution_plan_json, result_text_snapshot, status, updated_at
      ) VALUES ('automation-run-1', 'automation-1', 'schedule-run-1', 'child',
        'route-1', 7, 'not-requested', ?, 'Recovered route report.', 'completing', 10)
    `).run(executionPlan('old-route-task', 'route-1', 7));

    const enqueueDelivery = vi.fn(async () => ({ id: 'outbox-route-1' }));
    await reconcileBotAutomationRuns({
      getDb: () => db,
      maker: { closeSession: vi.fn(async () => undefined) } as unknown as Maker,
      enqueueDelivery,
    });

    expect(enqueueDelivery).not.toHaveBeenCalled();
    expect(db.select({
      deliveryStatus: botAutomationRuns.deliveryStatus,
      deliveryError: botAutomationRuns.deliveryError,
    }).from(botAutomationRuns).get()).toEqual({
      deliveryStatus: 'enqueue-failed',
      deliveryError: 'Target route task changed while the automation was running',
    });
    sqlite.close();
  });

  it('does not dynamically redirect a legacy recovered completion without a task snapshot', async () => {
    const { sqlite, db } = createDb();
    sqlite.prepare("INSERT INTO sessions (id, status, updated_at) VALUES ('parent', 'active', 1), ('child', 'active', 1)").run();
    sqlite.prepare("INSERT INTO bot_profiles (id, canonical_session_id) VALUES ('bot-1', 'parent')").run();
    sqlite.prepare("INSERT INTO schedules (id, name) VALUES ('schedule-1', 'Legacy report')").run();
    sqlite.prepare("INSERT INTO schedule_runs (id, schedule_id, status) VALUES ('schedule-run-1', 'schedule-1', 'running')").run();
    sqlite.prepare("INSERT INTO bot_automation_links (id, bot_id, schedule_id) VALUES ('automation-1', 'bot-1', 'schedule-1')").run();
    sqlite.prepare(`
      INSERT INTO bot_automation_runs (
        id, automation_link_id, schedule_run_id, session_id,
        delivery_status, execution_plan_json, result_text_snapshot, status, updated_at
      ) VALUES ('automation-run-1', 'automation-1', 'schedule-run-1', 'child',
        'not-requested', '{}', 'Legacy report.', 'completing', 10)
    `).run();

    const enqueueDelivery = vi.fn(async () => ({ id: 'outbox-1' }));
    await reconcileBotAutomationRuns({
      getDb: () => db,
      maker: { closeSession: vi.fn(async () => undefined) } as unknown as Maker,
      enqueueDelivery,
    });

    expect(enqueueDelivery).not.toHaveBeenCalled();
    expect(db.select({
      deliveryStatus: botAutomationRuns.deliveryStatus,
      deliveryError: botAutomationRuns.deliveryError,
    }).from(botAutomationRuns).get()).toEqual({
      deliveryStatus: 'enqueue-failed',
      deliveryError: 'Bot automation delivery task snapshot is unavailable; completion was not redirected',
    });
    sqlite.close();
  });

  it('does not deliver a recovered completion after the Bot was paused', async () => {
    const { sqlite, db } = createDb();
    sqlite.prepare("INSERT INTO sessions (id, status, updated_at) VALUES ('parent', 'active', 1), ('child', 'active', 1)").run();
    sqlite.prepare("INSERT INTO bot_profiles (id, canonical_session_id, status) VALUES ('bot-1', 'parent', 'paused')").run();
    sqlite.prepare("INSERT INTO schedules (id, name) VALUES ('schedule-1', 'Daily report')").run();
    sqlite.prepare("INSERT INTO schedule_runs (id, schedule_id, status) VALUES ('schedule-run-1', 'schedule-1', 'running')").run();
    sqlite.prepare("INSERT INTO bot_automation_links (id, bot_id, schedule_id) VALUES ('automation-1', 'bot-1', 'schedule-1')").run();
    sqlite.prepare(`
      INSERT INTO bot_automation_runs (
        id, automation_link_id, schedule_run_id, session_id,
        delivery_status, result_text_snapshot, status, updated_at
      ) VALUES ('automation-run-1', 'automation-1', 'schedule-run-1', 'child',
        'not-requested', 'Recovered report.', 'completing', 10)
    `).run();
    sqlite.prepare(`
      INSERT INTO bot_session_links (id, bot_id, session_id, role, channel_id, route_key)
      VALUES ('link-1', 'bot-1', 'child', 'route', 'bot-1:local', 'automation:schedule-run-1')
    `).run();

    const enqueueDelivery = vi.fn(async () => ({ id: 'outbox-1' }));
    await reconcileBotAutomationRuns({
      getDb: () => db,
      maker: { closeSession: vi.fn(async () => undefined) } as unknown as Maker,
      enqueueDelivery,
    });

    expect(enqueueDelivery).not.toHaveBeenCalled();
    expect(db.select({
      status: botAutomationRuns.status,
      deliveryStatus: botAutomationRuns.deliveryStatus,
      deliveryError: botAutomationRuns.deliveryError,
    }).from(botAutomationRuns).get()).toEqual({
      status: 'success',
      deliveryStatus: 'enqueue-failed',
      deliveryError: 'Bot is no longer active; completion was not delivered',
    });
    sqlite.close();
  });

  it('does not deliver a recovered Route completion after the Bot was paused', async () => {
    const { sqlite, db } = createDb();
    sqlite.prepare("INSERT INTO sessions (id, status, updated_at) VALUES ('route-task', 'active', 1), ('child', 'active', 1)").run();
    sqlite.prepare("INSERT INTO bot_profiles (id, canonical_session_id, status) VALUES ('bot-1', NULL, 'paused')").run();
    sqlite.prepare("INSERT INTO schedules (id, name) VALUES ('schedule-1', 'Route report')").run();
    sqlite.prepare("INSERT INTO schedule_runs (id, schedule_id, status) VALUES ('schedule-run-1', 'schedule-1', 'running')").run();
    sqlite.prepare("INSERT INTO bot_automation_links (id, bot_id, schedule_id) VALUES ('automation-1', 'bot-1', 'schedule-1')").run();
    sqlite.prepare(`
      INSERT INTO bot_routes (
        id, bot_id, current_session_id, channel_id, owner_generation, status
      ) VALUES ('route-1', 'bot-1', 'route-task', 'telegram-account-1', 7, 'active')
    `).run();
    sqlite.prepare(`
      INSERT INTO bot_automation_runs (
        id, automation_link_id, schedule_run_id, session_id,
        target_route_id_snapshot, target_route_owner_generation_snapshot,
        delivery_status, result_text_snapshot, status, updated_at
      ) VALUES ('automation-run-1', 'automation-1', 'schedule-run-1', 'child',
        'route-1', 7, 'not-requested', 'Recovered route report.', 'completing', 10)
    `).run();

    const enqueueDelivery = vi.fn(async () => ({ id: 'outbox-route-1' }));
    await reconcileBotAutomationRuns({
      getDb: () => db,
      maker: { closeSession: vi.fn(async () => undefined) } as unknown as Maker,
      enqueueDelivery,
    });

    expect(enqueueDelivery).not.toHaveBeenCalled();
    expect(db.select({
      status: botAutomationRuns.status,
      deliveryStatus: botAutomationRuns.deliveryStatus,
      deliveryError: botAutomationRuns.deliveryError,
    }).from(botAutomationRuns).get()).toEqual({
      status: 'success',
      deliveryStatus: 'enqueue-failed',
      deliveryError: 'Bot is no longer active; completion was not delivered',
    });
    sqlite.close();
  });

  it('does not deliver a recovered completion after its Automation was paused', async () => {
    const { sqlite, db } = createDb();
    sqlite.prepare("INSERT INTO sessions (id, status, updated_at) VALUES ('parent', 'active', 1), ('child', 'active', 1)").run();
    sqlite.prepare("INSERT INTO bot_profiles (id, canonical_session_id) VALUES ('bot-1', 'parent')").run();
    sqlite.prepare("INSERT INTO schedules (id, name, status) VALUES ('schedule-1', 'Daily report', 'paused')").run();
    sqlite.prepare("INSERT INTO schedule_runs (id, schedule_id, status) VALUES ('schedule-run-1', 'schedule-1', 'running')").run();
    sqlite.prepare("INSERT INTO bot_automation_links (id, bot_id, schedule_id, status) VALUES ('automation-1', 'bot-1', 'schedule-1', 'paused')").run();
    sqlite.prepare(`
      INSERT INTO bot_automation_runs (
        id, automation_link_id, schedule_run_id, session_id,
        delivery_status, result_text_snapshot, status, updated_at
      ) VALUES ('automation-run-1', 'automation-1', 'schedule-run-1', 'child',
        'not-requested', 'Recovered report.', 'completing', 10)
    `).run();

    const enqueueDelivery = vi.fn(async () => ({ id: 'outbox-1' }));
    await reconcileBotAutomationRuns({
      getDb: () => db,
      maker: { closeSession: vi.fn(async () => undefined) } as unknown as Maker,
      enqueueDelivery,
    });

    expect(enqueueDelivery).not.toHaveBeenCalled();
    expect(db.select({
      deliveryStatus: botAutomationRuns.deliveryStatus,
      deliveryError: botAutomationRuns.deliveryError,
    }).from(botAutomationRuns).get()).toEqual({
      deliveryStatus: 'enqueue-failed',
      deliveryError: 'Bot automation is no longer active; completion was not delivered',
    });
    sqlite.close();
  });

  it('repairs a Scheduler run interrupted after the Bot result was durably completed', async () => {
    const { sqlite, db } = createDb();
    sqlite.prepare("INSERT INTO sessions (id, status, updated_at) VALUES ('child', 'active', 1)").run();
    sqlite.prepare("INSERT INTO bot_profiles (id, canonical_session_id) VALUES ('bot-1', NULL)").run();
    sqlite.prepare("INSERT INTO schedules (id, name) VALUES ('schedule-1', 'Crash window')").run();
    sqlite.prepare(`
      INSERT INTO schedule_runs (id, schedule_id, status, result_text, finished_at)
      VALUES ('schedule-run-1', 'schedule-1', 'interrupted', NULL, 20)
    `).run();
    sqlite.prepare("INSERT INTO bot_automation_links (id, bot_id, schedule_id) VALUES ('automation-1', 'bot-1', 'schedule-1')").run();
    sqlite.prepare(`
      INSERT INTO bot_automation_runs (
        id, automation_link_id, schedule_run_id, session_id,
        delivery_status, result_text_snapshot, status, updated_at, finished_at
      ) VALUES ('automation-run-1', 'automation-1', 'schedule-run-1', 'child',
        'not-requested', 'Durable result.', 'success', 19, 19)
    `).run();
    sqlite.prepare(`
      INSERT INTO bot_session_links (id, bot_id, session_id, role, channel_id, route_key)
      VALUES ('link-1', 'bot-1', 'child', 'route', 'bot-1:local', 'automation:schedule-run-1')
    `).run();

    await reconcileBotAutomationRuns({
      getDb: () => db,
      maker: { closeSession: vi.fn(async () => undefined) } as unknown as Maker,
      archiveSession: async (sessionId) => {
        db.update(sessions)
          .set({ status: 'archived', updatedAt: 21 })
          .where(eq(sessions.id, sessionId))
          .run();
      },
    });

    expect(
      db.select({ status: scheduleRuns.status, resultText: scheduleRuns.resultText })
        .from(scheduleRuns)
        .get(),
    ).toEqual({ status: 'success', resultText: 'Durable result.' });
    expect(db.select({ status: botAutomationRuns.status }).from(botAutomationRuns).get())
      .toEqual({ status: 'success' });
    expect(db.select({ status: sessions.status }).from(sessions).get())
      .toEqual({ status: 'archived' });
    sqlite.close();
  });

  it.each(['failed', 'aborted', 'skipped'] as const)(
    'repairs a Scheduler run left %s after the Bot result was durably completed',
    async (scheduleStatus) => {
      const { sqlite, db } = createDb();
      sqlite.prepare("INSERT INTO sessions (id, status, updated_at) VALUES ('child', 'active', 1)").run();
      sqlite.prepare("INSERT INTO bot_profiles (id, canonical_session_id) VALUES ('bot-1', NULL)").run();
      sqlite.prepare("INSERT INTO schedules (id, name) VALUES ('schedule-1', 'Crash window')").run();
      sqlite.prepare(`
        INSERT INTO schedule_runs (id, schedule_id, status, result_text, finished_at)
        VALUES ('schedule-run-1', 'schedule-1', ?, NULL, 20)
      `).run(scheduleStatus);
      sqlite.prepare("INSERT INTO bot_automation_links (id, bot_id, schedule_id) VALUES ('automation-1', 'bot-1', 'schedule-1')").run();
      sqlite.prepare(`
        INSERT INTO bot_automation_runs (
          id, automation_link_id, schedule_run_id, session_id,
          delivery_status, result_text_snapshot, status, updated_at, finished_at
        ) VALUES ('automation-run-1', 'automation-1', 'schedule-run-1', 'child',
          'not-requested', 'Durable result.', 'success', 19, 19)
      `).run();

      await reconcileBotAutomationRuns({
        getDb: () => db,
        maker: { closeSession: vi.fn(async () => undefined) } as unknown as Maker,
        archiveSession: vi.fn(async () => undefined),
      });

      expect(
        db.select({ status: scheduleRuns.status, resultText: scheduleRuns.resultText })
          .from(scheduleRuns)
          .get(),
      ).toEqual({ status: 'success', resultText: 'Durable result.' });
      sqlite.close();
    },
  );
});
