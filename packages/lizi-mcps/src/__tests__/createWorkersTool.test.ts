/** create_workers 批量编排回归：真实汇总、hard-limit 短路与连续失败。 */

import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import { registerCreateWorkersTool } from '../xdt-helper/create_workers.js';
import type { CreateWorkerDeps, CreateWorkerSpec } from '../xdt-helper/create_worker.js';

function parse(result: XdtHelperToolResult) {
  const [block] = result.content;
  if (block?.type !== 'text') throw new Error('Expected first MCP content block to be text');
  return JSON.parse(block.text);
}

function worker(index: number): CreateWorkerSpec {
  return {
    role: 'developer',
    agent: 'codex',
    label: `worker_${index}`,
    initial_task: `task ${index}`,
  };
}

function setup(createWorker: CreateWorkerDeps['createWorker']) {
  const registry = new XdtHelperToolRegistry();
  registerCreateWorkersTool(registry, { sessionId: 'lead-1', createWorker });
  return registry;
}

function created(index: number, hardLimit: number) {
  return {
    ok: true as const,
    workerId: `worker-id-${index}`,
    workerSessionId: `worker-session-${index}`,
    limit: {
      workerHardLimit: hardLimit,
      occupiedSlots: index,
      remainingSlots: hardLimit - index,
    },
  };
}

function hardLimitFailure(hardLimit: number) {
  return {
    ok: false as const,
    errorCode: 'WORKER_LIMIT_HARD_EXCEEDED' as const,
    message: `hard limit ${hardLimit} reached`,
    limit: {
      workerHardLimit: hardLimit,
      occupiedSlots: hardLimit,
      remainingSlots: 0,
    },
  };
}

describe('create_workers tool', () => {
  it('routes multi-worker requests to one deterministic batch tool', () => {
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>();
    const registry = setup(createWorker);

    expect(registry.get('create_workers')?.description).toContain(
      '用户一次要求创建多个 Worker 时必须使用本工具，不要并行或连续多次调用 create_worker。',
    );
  });

  it('rejects duplicate labels before creating any worker', async () => {
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>();
    const registry = setup(createWorker);

    const result = await registry.call('create_workers', {
      workers: [worker(1), { ...worker(2), label: 'WORKER_1' }],
    });

    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('stops a hard=3 batch after the first limit failure and summarizes all nine requests', async () => {
    let call = 0;
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async () => {
      call += 1;
      return call <= 3 ? created(call, 3) : hardLimitFailure(3);
    });
    const registry = setup(createWorker);

    const result = parse(await registry.call('create_workers', {
      workers: Array.from({ length: 9 }, (_, index) => worker(index + 1)),
    }));

    expect(result).toMatchObject({
      ok: true,
      request_count: 9,
      attempted_count: 4,
      success_count: 3,
      failure_count: 6,
      skipped_count: 5,
      stopped_early: true,
      stop_reason: 'WORKER_LIMIT_HARD_EXCEEDED',
      limit: { hard_limit: 3, occupied_slots: 3, remaining_slots: 0 },
      user_report: '本批请求创建 9 个 Worker，实际创建成功 3 个，失败 6 个；当前 hard limit 为 3，已占用 3 个槽位，其中 5 个请求在达到上限后未再尝试。可在协同设置中提高 hard limit、复用已有 Worker，或归档不再需要的 Worker 后分批执行剩余任务。',
    });
    expect(createWorker).toHaveBeenCalledTimes(4);
    expect(result.results.map((entry: { status: string }) => entry.status)).toEqual([
      'created', 'created', 'created', 'failed', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped',
    ]);
    expect(result.suggestions).toHaveLength(3);
  });

  it('reports the default hard=8 boundary for the ninth request', async () => {
    let call = 0;
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async () => {
      call += 1;
      return call <= 8 ? created(call, 8) : hardLimitFailure(8);
    });
    const registry = setup(createWorker);

    const result = parse(await registry.call('create_workers', {
      workers: Array.from({ length: 9 }, (_, index) => worker(index + 1)),
    }));

    expect(result).toMatchObject({
      request_count: 9,
      attempted_count: 9,
      success_count: 8,
      failure_count: 1,
      skipped_count: 0,
      limit: { hard_limit: 8, occupied_slots: 8, remaining_slots: 0 },
    });
  });

  it('keeps real per-item outcomes when a non-limit failure occurs between successes', async () => {
    const outcomes = [
      created(1, 8),
      { ok: false as const, errorCode: 'DUPLICATE_LABEL' as const, message: 'duplicate label' },
      created(2, 8),
    ];
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async () => outcomes.shift()!);
    const registry = setup(createWorker);

    const result = parse(await registry.call('create_workers', {
      workers: [worker(1), worker(2), worker(3)],
    }));

    expect(result).toMatchObject({
      attempted_count: 3,
      success_count: 2,
      failure_count: 1,
      skipped_count: 0,
      stopped_early: false,
      user_report: '本批请求创建 3 个 Worker，实际创建成功 2 个，失败 1 个。请按逐项结果核对每个 Worker 的真实终态。',
    });
    expect(result.results).toEqual([
      expect.objectContaining({ label: 'worker_1', status: 'created', worker_id: 'worker-id-1' }),
      expect.objectContaining({ label: 'worker_2', status: 'failed', error_code: 'DUPLICATE_LABEL' }),
      expect.objectContaining({ label: 'worker_3', status: 'created', worker_id: 'worker-id-2' }),
    ]);
  });

  it('reports consecutive non-limit failures without inventing created workers', async () => {
    const outcomes = [
      { ok: false as const, errorCode: 'INVALID_PARAMS' as const, message: 'bad model' },
      { ok: false as const, errorCode: 'NO_PROVIDER_FOR_AGENT' as const, message: 'provider missing' },
      { ok: false as const, errorCode: 'INTERNAL' as const, message: 'bootstrap failed' },
    ];
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async () => outcomes.shift()!);
    const registry = setup(createWorker);

    const result = parse(await registry.call('create_workers', {
      workers: [worker(1), worker(2), worker(3)],
    }));

    expect(result).toMatchObject({
      attempted_count: 3,
      success_count: 0,
      failure_count: 3,
      skipped_count: 0,
      stopped_early: false,
    });
    expect(result.results.every((entry: { status: string }) => entry.status === 'failed')).toBe(true);
    expect(result.results.some((entry: { worker_id?: string }) => entry.worker_id)).toBe(false);
  });
});
