/**
 * 排除清单单源一致性 / 跳板判定(P0-1)测试。
 */

import { describe, expect, it } from 'vitest';

import { COPY_MUST_KEEP_PREFIXES, USER_DATA_COPY_EXCLUDES } from '../copyExcludes';
import { decideTrampolineOutcome } from '../trampoline';

describe('copyExcludes 单源一致性', () => {
  it('排除清单绝不误杀必迁内容(§4.1 保留例外)', () => {
    // 排除 glob 的首段绝不允许命中必迁前缀;migration/ 下只允许精确排
    // state.json(handoff.json 必须随拷)。
    for (const exclude of USER_DATA_COPY_EXCLUDES) {
      for (const keep of COPY_MUST_KEEP_PREFIXES) {
        const excludeHead = exclude.split('/')[0];
        const keepHead = keep.split('/')[0];
        if (excludeHead.toLowerCase() !== keepHead.toLowerCase()) continue;
        // 同首段时,排除项必须比保留项更深(精确到子路径),且不等于保留项
        expect(exclude.toLowerCase(), `"${exclude}" would kill "${keep}"`).not.toBe(keep.toLowerCase());
        expect(
          exclude.split('/').length,
          `"${exclude}" 与必迁前缀 "${keep}" 同首段,必须写成更深的精确路径`,
        ).toBeGreaterThan(1);
        expect(keep.toLowerCase().startsWith(`${exclude.toLowerCase().replace(/\/\*\*$/, '')}/`)).toBe(false);
      }
    }
  });

  it('迁移元数据排除精确到文件,handoff.json 不受影响', () => {
    expect(USER_DATA_COPY_EXCLUDES).toContain('migration/state.json');
    expect(USER_DATA_COPY_EXCLUDES).not.toContain('migration/**');
  });
});

describe('decideTrampolineOutcome(P0-1 单实例让位回归)', () => {
  it('spawn 前已在运行 → 成功且不 spawn', () => {
    expect(decideTrampolineOutcome({
      alreadyRunningBefore: true, spawnOutcome: null, runningAfterExit: false,
    })).toEqual({ kind: 'success', via: 'already-running' });
  });

  it('spawn 存活 → 成功', () => {
    expect(decideTrampolineOutcome({
      alreadyRunningBefore: false, spawnOutcome: 'alive', runningAfterExit: false,
    })).toEqual({ kind: 'success', via: 'spawned' });
  });

  it('P0-1 必现场景:短时退出但系统中有 Cindy = 让位,判成功不判 fallback', () => {
    expect(decideTrampolineOutcome({
      alreadyRunningBefore: false, spawnOutcome: 'exited', runningAfterExit: true,
    })).toEqual({ kind: 'success', via: 'yielded-to-running-instance' });
  });

  it('短时退出且确无实例 / spawn 报错 → fallback', () => {
    expect(decideTrampolineOutcome({
      alreadyRunningBefore: false, spawnOutcome: 'exited', runningAfterExit: false,
    }).kind).toBe('fallback');
    expect(decideTrampolineOutcome({
      alreadyRunningBefore: false, spawnOutcome: 'spawn-error', runningAfterExit: false,
    }).kind).toBe('fallback');
  });
});
