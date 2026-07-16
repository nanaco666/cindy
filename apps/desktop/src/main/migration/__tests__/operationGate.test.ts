import { describe, expect, it, vi } from 'vitest';

import { MigrationOperationGate } from '../operationGate';

describe('MigrationOperationGate', () => {
  it('执行窗口等待当前 campaign 完整结束后才进入', async () => {
    const gate = new MigrationOperationGate();
    const finishCampaign = gate.tryStartCampaign();
    expect(finishCampaign).toBeTypeOf('function');
    const entered = vi.fn();
    const executionPromise = gate.tryStartExecution().then((finish) => {
      entered();
      return finish;
    });

    await Promise.resolve();
    expect(entered).not.toHaveBeenCalled();
    finishCampaign?.();
    const finishExecution = await executionPromise;
    expect(finishExecution).toBeTypeOf('function');
    expect(gate.isCampaignActive).toBe(false);
    expect(gate.isExecutionActive).toBe(true);
    finishExecution?.();
    expect(gate.isExecutionActive).toBe(false);
  });

  it('执行窗口期间拒绝新 campaign，释放后允许下一轮重试', async () => {
    const gate = new MigrationOperationGate();
    const finishExecution = await gate.tryStartExecution();
    expect(gate.tryStartCampaign()).toBeNull();
    finishExecution?.();

    const finishCampaign = gate.tryStartCampaign();
    expect(finishCampaign).toBeTypeOf('function');
    finishCampaign?.();
  });

  it('同一时刻只允许一个 campaign，release 幂等', () => {
    const gate = new MigrationOperationGate();
    const finish = gate.tryStartCampaign();
    expect(gate.tryStartCampaign()).toBeNull();
    finish?.();
    finish?.();
    expect(gate.isCampaignActive).toBe(false);
  });
});
