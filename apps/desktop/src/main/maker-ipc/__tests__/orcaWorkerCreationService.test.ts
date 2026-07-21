import type { AgentKind } from '@lizi/maker-core';
import { describe, expect, it, vi } from 'vitest';

import {
  buildNoProviderMessage,
  createOrcaWorkerCreationService,
  type OrcaWorkerCreationDeps,
} from '../orcaWorkerCreationService';
import type { DispatchWorkerTaskResult, OrcaWorkerStatus } from '../orcaTeamService';
import type { MakerSessionCreateOpts } from '../sessionRequest';
import { CredentialModeSwitchBusyError } from '../../maker-host/codex-credential-switch';
import { isActiveWorkerStatus } from '../../../shared/orca-worker-status';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKER_SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';

function createDeps(overrides: Partial<OrcaWorkerCreationDeps> = {}) {
  const calls: string[] = [];
  const ids = ['worker-1'];
  const reservations = new Set<string>();
  const deps: OrcaWorkerCreationDeps = {
    getActiveTeamByLead: vi.fn(async (leadSessionId) => (
      leadSessionId === 'lead-1' ? { id: 'team-1', leadSessionId: 'lead-1' } : null
    )),
    listWorkersByLead: vi.fn(async () => []),
    isActiveWorkerStatus: vi.fn(isActiveWorkerStatus),
    readCollaborationSettings: vi.fn(() => ({ workerSoftLimit: 3, workerHardLimit: 5 })),
    getLeadSessionRow: vi.fn(async () => ({
      id: 'lead-1',
      agentKind: 'codex' as const,
      workingDir: 'C:\\repo',
      model: 'gpt-5.5',
      effort: 'medium',
      permissionMode: 'default',
      fastMode: false,
    })),
    getWorkerDefaults: vi.fn(() => ({})),
    getAvailableModels: vi.fn((agent: AgentKind) => (
      agent === 'codex'
        ? [
            { id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
            { id: 'gpt-5.4', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
            { id: 'gpt-5.4-mini', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
            { id: 'codex/budget', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
          ]
        : [{ id: 'claude-sonnet-4-6', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' }]
    )),
    getProviderAvailability: vi.fn(async () => ({
      'claude-code': ['XD Gateway'],
      codex: ['XD Gateway'],
    })),
    readClaudeApiKey: vi.fn((): string | null => 'sk-test'),
    reserveWorkerCreation: vi.fn(async ({ label }) => {
      const canonical = label.toLowerCase();
      if (reservations.has(canonical)) {
        return { ok: false as const, errorCode: 'WORKER_CREATION_IN_PROGRESS' as const };
      }
      reservations.add(canonical);
      return { ok: true as const, occupiedSlotsBefore: 0 };
    }),
    renewWorkerCreationReservation: vi.fn(async () => true),
    releaseWorkerCreationReservation: vi.fn(async () => undefined),
    createId: vi.fn(() => ids.shift() ?? `id-${ids.length}`),
    createSessionId: vi.fn(() => WORKER_SESSION_ID),
    buildCreateOptsWithStderr: vi.fn((opts: MakerSessionCreateOpts) => opts),
    bootstrapSession: vi.fn(async (opts: MakerSessionCreateOpts) => {
      calls.push(`bootstrapSession:${opts.id}`);
      return {
        session: {
          id: opts.id ?? WORKER_SESSION_ID,
          agentKind: opts.agentKind,
        },
        didInjectOrcaInstructions: true,
        didInjectProjectContext: false,
      };
    }),
    addOrUpdateWorker: vi.fn(async (worker) => {
      calls.push(`addOrUpdateWorker:${worker.id}`);
    }),
    markOrcaRoleIfNeeded: vi.fn(async (sessionId, role) => {
      calls.push(`markOrcaRoleIfNeeded:${sessionId}:${role}`);
    }),
    dispatchWorkerTask: vi.fn(async (params) => {
      calls.push(`dispatchWorkerTask:${params.targetSessionId}`);
      return {
        dispatched: true,
        dispatchOutcome: {
          kind: 'session-dispatch',
          source: params.dispatchMeta.source,
          dispatched: true,
        },
        agentKind: 'codex',
        wakeKind: 'resumed',
        targetTitle: 'Worker',
        targetLastUserSendAt: null,
      } satisfies DispatchWorkerTaskResult;
    }),
    broadcastSessionCreated: vi.fn((sessionId) => {
      calls.push(`broadcastSessionCreated:${sessionId}`);
    }),
    broadcastOrcaWorkerChanged: vi.fn((leadSessionId) => {
      calls.push(`broadcastOrcaWorkerChanged:${leadSessionId}`);
    }),
    closeWorkerSession: vi.fn(async (sessionId) => {
      calls.push(`closeWorkerSession:${sessionId}`);
    }),
    archiveWorkerSession: vi.fn(async (sessionId) => {
      calls.push(`archiveWorkerSession:${sessionId}`);
    }),
    forgetWorkerSession: vi.fn((sessionId) => {
      calls.push(`forgetWorkerSession:${sessionId}`);
    }),
    removeWorker: vi.fn(async (workerId) => {
      calls.push(`removeWorker:${workerId}`);
    }),
    ...overrides,
  };
  return {
    calls,
    deps,
    service: createOrcaWorkerCreationService(deps),
  };
}

describe('OrcaWorkerCreationService', () => {
  const workerStatus = (status: OrcaWorkerStatus): OrcaWorkerStatus => status;

  it('returns NOT_FOUND without side effects when the lead has no active team', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.createWorker({
        leadSessionId: 'missing-lead',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'NOT_FOUND',
      message: 'no active team for this lead',
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it('rejects duplicate labels before bootstrapping a worker session', async () => {
    const { deps, service } = createDeps({
      listWorkersByLead: vi.fn(async () => [{ id: 'worker-existing', label: 'reviewer', status: workerStatus('idle') }]),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'DUPLICATE_LABEL',
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it('rejects labels outside the shared worker label contract before reading worker slots', async () => {
    for (const label of ['bad label', '中文', 'x'.repeat(33)]) {
      const { deps, service } = createDeps();

      await expect(
        service.createWorker({
          leadSessionId: 'lead-1',
          role: 'reviewer',
          agent: 'codex',
          label,
        }),
      ).resolves.toMatchObject({
        ok: false,
        errorCode: 'INVALID_PARAMS',
      });

      expect(deps.listWorkersByLead).not.toHaveBeenCalled();
      expect(deps.bootstrapSession).not.toHaveBeenCalled();
      expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
      expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
    }
  });

  it('persists trimmed worker labels after validating the shared label contract', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: ' Reviewer_1 ',
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        label: 'reviewer_1',
      },
    });

    expect(deps.addOrUpdateWorker).toHaveBeenCalledWith(expect.objectContaining({
      label: 'reviewer_1',
    }));
  });

  it('allows only one full create lifecycle for concurrent case-insensitive labels', async () => {
    const { deps, service } = createDeps();
    const results = await Promise.all([
      service.createWorker({ leadSessionId: 'lead-1', role: 'tester', agent: 'codex', label: 'tester' }),
      service.createWorker({ leadSessionId: 'lead-1', role: 'tester', agent: 'codex', label: 'TESTER' }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.errorCode === 'WORKER_CREATION_IN_PROGRESS')).toHaveLength(1);
    expect(deps.bootstrapSession).toHaveBeenCalledTimes(1);
    expect(deps.addOrUpdateWorker).toHaveBeenCalledTimes(1);
    expect(deps.markOrcaRoleIfNeeded).toHaveBeenCalledTimes(1);
  });

  it('counts terminal workers toward the hard limit before any creation side effects', async () => {
    const { deps, service } = createDeps({
      readCollaborationSettings: vi.fn(() => ({ workerSoftLimit: 2, workerHardLimit: 4 })),
      listWorkersByLead: vi.fn(async () => [
        { id: 'worker-1', label: 'one', status: workerStatus('idle') },
        { id: 'worker-2', label: 'two', status: workerStatus('running') },
        { id: 'worker-3', label: 'three', status: workerStatus('done') },
        { id: 'worker-4', label: 'four', status: workerStatus('error') },
      ]),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'WORKER_LIMIT_HARD_EXCEEDED',
    });

    expect(deps.getAvailableModels).not.toHaveBeenCalled();
    expect(deps.getProviderAvailability).not.toHaveBeenCalled();
    expect(deps.getLeadSessionRow).not.toHaveBeenCalled();
    expect(deps.reserveWorkerCreation).not.toHaveBeenCalled();
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it('rejects unavailable explicit models before reading lead defaults', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
        model: 'gpt-unknown',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: expect.stringContaining('gpt-unknown'),
    });

    expect(deps.getLeadSessionRow).not.toHaveBeenCalled();
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
  });

  it('rejects worker creation when the target agent has no connected provider, suggesting another agent', async () => {
    const { deps, service } = createDeps({
      getProviderAvailability: vi.fn(async () => ({ 'claude-code': ['XD Gateway'], codex: [] })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'NO_PROVIDER_FOR_AGENT',
      message: expect.stringContaining('Claude Code'),
    });

    expect(deps.getLeadSessionRow).not.toHaveBeenCalled();
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it('rejects worker creation when no agent has a connected provider, without an agent suggestion', async () => {
    const { deps, service } = createDeps({
      getProviderAvailability: vi.fn(async () => ({ 'claude-code': [], codex: [] })),
    });

    const result = await service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'NO_PROVIDER_FOR_AGENT' });
    if (!result.ok) {
      expect(result.message).toContain('设置 → 模型供应商');
      expect(result.message).not.toContain('改用');
    }

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND when the lead session row is missing', async () => {
    const { deps, service } = createDeps({
      getLeadSessionRow: vi.fn(async () => null),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'NOT_FOUND',
      message: 'lead session lead-1 not found',
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
  });

  it('rejects a budget Codex model when no api key is configured', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'codex/budget' })),
      readClaudeApiKey: vi.fn((): string | null => null),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'BUDGET_MODEL_REQUIRES_API_MODE',
      message: expect.stringContaining('codex/budget'),
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it('rejects explicit minimal effort for a Codex GPT worker at the creation boundary', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
        model: 'gpt-5.4-mini',
        effort: 'minimal',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: expect.stringContaining('minimal'),
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
  });

  it('normalizes inherited minimal effort from worker defaults to low for a Codex GPT worker', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.4-mini', effort: 'minimal', fastMode: false })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'gpt-5.4-mini',
        effort: 'low',
      },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.4-mini',
      effort: 'low',
    }));
  });

  it('normalizes inherited minimal effort from the lead session to low for a Codex GPT worker', async () => {
    const { deps, service } = createDeps({
      getLeadSessionRow: vi.fn(async () => ({
        id: 'lead-1',
        agentKind: 'codex' as const,
        workingDir: 'C:\\repo',
        model: 'gpt-5.4-mini',
        effort: 'minimal',
        permissionMode: 'default',
        fastMode: false,
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'gpt-5.4-mini',
        effort: 'low',
      },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.4-mini',
      effort: 'low',
    }));
  });

  it('normalizes inherited max effort to xhigh when the selected model uses Codex effort names', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.4-mini', effort: 'max', fastMode: false })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'gpt-5.4-mini',
        effort: 'xhigh',
      },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.4-mini',
      effort: 'xhigh',
    }));
  });

  it('rejects explicit max effort when the selected Codex model only supports xhigh', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
        model: 'gpt-5.4-mini',
        effort: 'max',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: expect.stringContaining('max'),
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
  });

  it('rejects explicit minimal effort for a Claude Code worker at the creation boundary', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'claude-code',
        label: 'reviewer',
        model: 'claude-sonnet-4-6',
        effort: 'minimal',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: expect.stringContaining('minimal'),
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
  });

  it('normalizes inherited minimal effort to low for a Claude Code worker', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'claude-sonnet-4-6', effort: 'minimal' })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'claude-code',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'claude-sonnet-4-6',
        effort: 'low',
      },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-sonnet-4-6',
      effort: 'low',
    }));
  });

  it('disables fast mode when the selected model capability does not support it', async () => {
    const { deps, service } = createDeps({
      getAvailableModels: vi.fn((agent: AgentKind) => (
        agent === 'codex'
          ? [{ id: 'gpt-no-fast', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', supportsFastMode: false }]
          : [{ id: 'claude-sonnet-4-6', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' }]
      )),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
        model: 'gpt-no-fast',
        fast: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'gpt-no-fast',
        fastMode: false,
      },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-no-fast',
      fastMode: false,
    }));
  });

  it('keeps medium effort for a Codex GPT worker', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.4-mini', effort: 'medium', fastMode: false })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'gpt-5.4-mini',
        effort: 'medium',
      },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.4-mini',
      effort: 'medium',
    }));
  });

  it('creates a worker with resolved defaults without dispatching or broadcasting from the creation boundary', async () => {
    const { calls, deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.4', effort: 'high', fastMode: true })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      teamId: 'team-1',
      workerId: 'worker-1',
      workerSessionId: WORKER_SESSION_ID,
      softLimitExceeded: false,
    });

    expect(deps.createSessionId).toHaveBeenCalledTimes(1);
    expect(WORKER_SESSION_ID).toMatch(UUID_V4_RE);
    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      id: WORKER_SESSION_ID,
      agentKind: 'codex',
      workingDir: 'C:\\repo',
      model: 'gpt-5.4',
      effort: 'high',
      fastMode: true,
      permissionMode: 'bypassPermissions',
      title: 'Worker · reviewer · reviewer',
      orcaRole: 'worker',
      vendorOptions: expect.objectContaining({
        orcaRole: 'worker',
        orcaWorkflowId: 'team-1',
        orcaLeadSessionId: 'lead-1',
        orcaWorkerId: 'worker-1',
        orcaWorkerSessionId: WORKER_SESSION_ID,
      }),
    }));
    expect(deps.addOrUpdateWorker).toHaveBeenCalledWith(expect.objectContaining({
      id: 'worker-1',
      teamId: 'team-1',
      sessionId: WORKER_SESSION_ID,
      status: 'idle',
      label: 'reviewer',
      role: 'reviewer',
      focused: false,
    }));
    expect(calls).toEqual([
      `bootstrapSession:${WORKER_SESSION_ID}`,
      'addOrUpdateWorker:worker-1',
      `markOrcaRoleIfNeeded:${WORKER_SESSION_ID}:worker`,
    ]);
  });

  it('reports soft-limit overflow while still creating the worker', async () => {
    const { deps, service } = createDeps({
      readCollaborationSettings: vi.fn(() => ({ workerSoftLimit: 1, workerHardLimit: 3 })),
      listWorkersByLead: vi.fn(async () => [{ id: 'worker-existing', label: 'existing', status: workerStatus('idle') }]),
      reserveWorkerCreation: vi.fn(async () => ({ ok: true as const, occupiedSlotsBefore: 1 })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      softLimitExceeded: true,
    });

    expect(deps.bootstrapSession).toHaveBeenCalledTimes(1);
    expect(deps.addOrUpdateWorker).toHaveBeenCalledTimes(1);
  });

  it('maps credential busy during worker bootstrap to BUSY without creating a worker row', async () => {
    const { deps, service } = createDeps({
      bootstrapSession: vi.fn(async () => {
        throw new CredentialModeSwitchBusyError(['busy-session']);
      }),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'BUSY',
    });

    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    expect(deps.markOrcaRoleIfNeeded).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it('archives a bootstrapped worker session when persistence fails', async () => {
    const { calls, deps, service } = createDeps({
      addOrUpdateWorker: vi.fn(async () => {
        calls.push('addOrUpdateWorker:throw');
        throw new Error('insert failed');
      }),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INTERNAL',
      message: 'insert failed',
    });

    expect(calls).toEqual([
      `bootstrapSession:${WORKER_SESSION_ID}`,
      'addOrUpdateWorker:throw',
      `closeWorkerSession:${WORKER_SESSION_ID}`,
      `forgetWorkerSession:${WORKER_SESSION_ID}`,
      `archiveWorkerSession:${WORKER_SESSION_ID}`,
    ]);
    expect(deps.markOrcaRoleIfNeeded).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it('recognizes SQLite expression-index conflicts regardless of quote style', async () => {
    const { deps, service } = createDeps({
      addOrUpdateWorker: vi.fn(async () => {
        throw new Error("UNIQUE constraint failed: index 'uniq_orca_workers_team_label'");
      }),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'DUPLICATE_LABEL',
    });

    expect(deps.archiveWorkerSession).toHaveBeenCalledWith(WORKER_SESSION_ID);
  });

  it('removes the worker link when role marking fails after persistence', async () => {
    const { calls, deps, service } = createDeps({
      markOrcaRoleIfNeeded: vi.fn(async () => {
        calls.push('markOrcaRoleIfNeeded:throw');
        throw new Error('role failed');
      }),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INTERNAL',
      message: 'role failed',
    });

    expect(calls).toEqual([
      `bootstrapSession:${WORKER_SESSION_ID}`,
      'addOrUpdateWorker:worker-1',
      'markOrcaRoleIfNeeded:throw',
      `closeWorkerSession:${WORKER_SESSION_ID}`,
      `forgetWorkerSession:${WORKER_SESSION_ID}`,
      `archiveWorkerSession:${WORKER_SESSION_ID}`,
      'removeWorker:worker-1',
    ]);
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });
});

describe('buildNoProviderMessage', () => {
  it('suggests the other agent when it has a connected provider', () => {
    const msg = buildNoProviderMessage('codex', { 'claude-code': ['XD Gateway'], codex: [] });
    expect(msg).toContain('Codex 当前没有可用的模型供应商');
    expect(msg).toContain('改用');
    expect(msg).toContain('Claude Code(已连接:XD Gateway)');
  });

  it('omits the agent suggestion when no agent has a connected provider', () => {
    const msg = buildNoProviderMessage('claude-code', { 'claude-code': [], codex: [] });
    expect(msg).toContain('Claude Code 当前没有可用的模型供应商');
    expect(msg).toContain('设置 → 模型供应商');
    expect(msg).not.toContain('改用');
  });
});
