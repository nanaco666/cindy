/**
 * 迁移 marker 状态机契约测试(B′):转移矩阵穷举、原子读写容错、
 * 老 app 启动决策(sentinel 铁律 / 重入计数 / 版本作废回归)。
 * 全部走 os.tmpdir 临时目录(规则 23),零 Electron 依赖。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readMarker,
  transitionMarker,
  writeJsonAtomic,
} from '../markerStore';
import { decideStartupAction, type StartupDecisionInput } from '../startupDecision';
import { isLegalTransition } from '../transitions';
import {
  DEFAULT_MAX_ATTEMPTS,
  type MigrationMarker,
  type MigrationState,
  type MigrationWriter,
} from '../types';

const ALL_STATES: readonly MigrationState[] = [
  'staged', 'handoff_ready', 'installed', 'launched',
  'confirmed', 'failed', 'fallback_active',
];
const ALL_WRITERS: readonly MigrationWriter[] = ['old-app', 'new-app'];

function makeMarker(overrides: Partial<MigrationMarker> = {}): MigrationMarker {
  return {
    schemaVersion: 1,
    migrationId: 'mig-0001',
    state: 'staged',
    attempt: 0,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    updatedAt: new Date(1_700_000_000_000).toISOString(),
    updatedBy: 'old-app',
    source: {
      app: 'xdt-maker', version: '0.0.130', installDir: 'C:/inst/old',
      userDataDir: 'C:/ud/old', uninstallDisplayNamePrefix: 'xdt-maker',
    },
    target: {
      app: 'cindy', version: '1.0.0', payloadPath: 'C:/ud/old/updates/cindy.exe',
      payloadSha256: 'abc', installDir: 'C:/inst/new', userDataDir: 'C:/ud/new',
      exeName: 'cindy.exe',
    },
    handoff: null,
    lastError: null,
    ...overrides,
  };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-migration-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('transitions 矩阵(B′)', () => {
  // 穷举 (from × to × writer),白名单显式列出,其余必须全部拒绝——
  // 矩阵改动时本表必须同步改,防止误开放非法转移。
  const LEGAL: Array<[MigrationState | null, MigrationState, MigrationWriter]> = [
    [null, 'staged', 'old-app'],
    ['failed', 'staged', 'old-app'],
    ['staged', 'staged', 'old-app'],
    ['fallback_active', 'staged', 'old-app'],
    ['staged', 'handoff_ready', 'old-app'],
    ['handoff_ready', 'handoff_ready', 'old-app'],
    ['handoff_ready', 'installed', 'old-app'],
    ['installed', 'launched', 'old-app'],
    ['launched', 'confirmed', 'new-app'],
    ['fallback_active', 'confirmed', 'old-app'],
    ['confirmed', 'fallback_active', 'old-app'],
    ...(['old-app', 'new-app'] as const).flatMap((w) =>
      (['staged', 'handoff_ready', 'installed', 'launched'] as const)
        .map((from) => [from, 'failed', w] as [MigrationState, MigrationState, MigrationWriter])),
  ];

  it('白名单内全部放行', () => {
    for (const [from, to, writer] of LEGAL) {
      expect(isLegalTransition(from, to, writer).ok, `${from} -> ${to} by ${writer}`).toBe(true);
    }
  });

  it('白名单外全部拒绝(穷举 8×7×2)', () => {
    const legalKeys = new Set(LEGAL.map(([f, t, w]) => `${f}|${t}|${w}`));
    for (const from of [null, ...ALL_STATES]) {
      for (const to of ALL_STATES) {
        for (const writer of ALL_WRITERS) {
          if (legalKeys.has(`${from}|${to}|${writer}`)) continue;
          const r = isLegalTransition(from, to, writer);
          expect(r.ok, `${from} -> ${to} by ${writer} should be rejected`).toBe(false);
          expect(r.reason).toBeTruthy();
        }
      }
    }
  });

  it('sentinel override 仅对 old-app→confirmed 生效', () => {
    expect(isLegalTransition('installed', 'confirmed', 'old-app', { sentinelOverride: true }).ok).toBe(true);
    expect(isLegalTransition('installed', 'confirmed', 'new-app', { sentinelOverride: true }).ok).toBe(false);
    expect(isLegalTransition('installed', 'launched', 'new-app', { sentinelOverride: true }).ok).toBe(false);
  });
});

describe('markerStore', () => {
  it('原子写 + 读回一致,tmp 文件不残留', () => {
    const file = path.join(tmpDir, 'migration', 'state.json');
    const marker = makeMarker();
    writeJsonAtomic(file, marker);
    expect(readMarker(file)).toEqual(marker);
    const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('损坏 / 缺 schemaVersion / 不存在的 marker 一律按 null 处理', () => {
    const file = path.join(tmpDir, 'state.json');
    expect(readMarker(file)).toBeNull();
    fs.writeFileSync(file, '{ not json');
    expect(readMarker(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, state: 'staged', migrationId: 'x' }));
    expect(readMarker(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, state: 'staged', migrationId: 'x' }));
    expect(readMarker(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ ...makeMarker(), target: { app: 'cindy' } }));
    expect(readMarker(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ ...makeMarker(), attempt: '1' }));
    expect(readMarker(file)).toBeNull();
  });

  it('transitionMarker 合法转移落盘并统一写 state/updatedAt/updatedBy', () => {
    const file = path.join(tmpDir, 'state.json');
    writeJsonAtomic(file, makeMarker({ state: 'staged' }));
    const r = transitionMarker(file, {
      to: 'handoff_ready', by: 'old-app', nowIso: '2026-07-09T00:00:00.000Z',
    });
    expect(r.ok).toBe(true);
    const onDisk = readMarker(file)!;
    expect(onDisk.state).toBe('handoff_ready');
    expect(onDisk.updatedBy).toBe('old-app');
    expect(onDisk.updatedAt).toBe('2026-07-09T00:00:00.000Z');
  });

  it('transitionMarker 非法转移拒绝且不落盘(并发方已推进场景)', () => {
    const file = path.join(tmpDir, 'state.json');
    // 模拟:重入方以为还能回 staged,实际已推进到 launched(归 Cindy 确认)。
    writeJsonAtomic(file, makeMarker({ state: 'launched' }));
    const r = transitionMarker(file, { to: 'staged', by: 'old-app' });
    expect(r.ok).toBe(false);
    expect(readMarker(file)!.state).toBe('launched');
  });
});

describe('startupDecision(老 app 启动决策,B′)', () => {
  function input(overrides: Partial<StartupDecisionInput> = {}): StartupDecisionInput {
    return {
      marker: null,
      cindyRunning: false,
      newSideSentinel: false,
      expectedTargetVersion: '1.0.0',
      ...overrides,
    };
  }
  const at = new Date(1_700_000_000_000).toISOString();

  it('无 marker → none;confirmed → 跳板;fallback_active → 逃生舱重试', () => {
    expect(decideStartupAction(input()).kind).toBe('none');
    expect(decideStartupAction(input({ marker: makeMarker({ state: 'confirmed' }) })).kind).toBe('trampoline');
    expect(decideStartupAction(input({ marker: makeMarker({ state: 'fallback_active' }) })).kind).toBe('fallback-retry');
  });

  it('铁律:新侧有 sentinel 且 marker 未达 confirmed → reconcile-confirm', () => {
    for (const state of ['installed', 'launched', 'failed'] as const) {
      const d = decideStartupAction(input({ marker: makeMarker({ state }), newSideSentinel: true }));
      expect(d.kind, state).toBe('reconcile-confirm');
    }
    // confirmed / fallback_active 属"已知晓新侧成功"的后置状态,sentinel 是
    // 预期而非分歧——不 reconcile(fallback 的出路是重装重入)。
    expect(decideStartupAction(input({
      marker: makeMarker({ state: 'confirmed' }), newSideSentinel: true,
    })).kind).toBe('trampoline');
    expect(decideStartupAction(input({
      marker: makeMarker({ state: 'fallback_active' }), newSideSentinel: true,
    })).kind).toBe('fallback-retry');
  });

  it('staged / handoff_ready 归老 app 所有 → 直接 retry(不计 attempt)', () => {
    for (const state of ['staged', 'handoff_ready'] as const) {
      expect(decideStartupAction(input({ marker: makeMarker({ state }) })))
        .toEqual({ kind: 'retry', countAttempt: false, restage: false });
    }
  });

  it('in-progress:Cindy 在跑 → wait;不在跑 → installed 纯重入 / launched 计失败', () => {
    for (const state of ['installed', 'launched'] as const) {
      const m = makeMarker({ state });
      expect(decideStartupAction(input({ marker: m, cindyRunning: true })).kind).toBe('wait');
      expect(decideStartupAction(input({ marker: m })))
        .toEqual({ kind: 'retry', countAttempt: state === 'launched', restage: false });
    }
  });

  it('installed 纯中断(无 lastError)不计 attempt;带 lastError 计', () => {
    const crashed = decideStartupAction(input({
      marker: makeMarker({
        state: 'installed',
        lastError: { code: 'INSTALL_FAILED', message: 'x', at },
      }),
    }));
    expect(crashed).toEqual({ kind: 'retry', countAttempt: true, restage: false });
  });

  it('failed → retry(计数);attempt 耗尽 → give-up(纯中断不受限)', () => {
    const failed = makeMarker({
      state: 'failed',
      lastError: { code: 'INSTALL_FAILED', message: 'x', at },
    });
    expect(decideStartupAction(input({ marker: failed })).kind).toBe('retry');
    expect(decideStartupAction(input({
      marker: { ...failed, attempt: DEFAULT_MAX_ATTEMPTS },
    })).kind).toBe('give-up');
    // installed 纯中断不消耗预算:attempt 已满仍可重入
    expect(decideStartupAction(input({
      marker: makeMarker({ state: 'installed', attempt: DEFAULT_MAX_ATTEMPTS }),
    })).kind).toBe('retry');
    // launched 后目标消失且无 sentinel 视为交棒失败,预算耗尽后 give-up。
    expect(decideStartupAction(input({
      marker: makeMarker({ state: 'launched', attempt: DEFAULT_MAX_ATTEMPTS }),
    })).kind).toBe('give-up');
  });

  it('P1-5 回归:目标版本与当前期望不符 → restage(staged/failed/重入路径一致)', () => {
    for (const state of ['staged', 'failed', 'installed'] as const) {
      const d = decideStartupAction(input({
        marker: makeMarker({
          state,
          target: { ...makeMarker().target, version: '0.9.0' },
          lastError: state === 'failed' ? { code: 'INSTALL_FAILED', message: 'x', at } : null,
        }),
      }));
      expect(d).toMatchObject({ kind: 'retry', restage: true });
    }
  });

  it('旧 payload 预算耗尽后，修正版版本仍优先 restage 并重新计预算', () => {
    for (const state of ['failed', 'launched'] as const) {
      expect(decideStartupAction(input({
        marker: makeMarker({
          state,
          attempt: DEFAULT_MAX_ATTEMPTS,
          target: { ...makeMarker().target, version: '1.0.0' },
          lastError: { code: 'INSTALL_FAILED', message: 'bad payload', at },
        }),
        expectedTargetVersion: '1.0.1',
      }))).toEqual({ kind: 'retry', countAttempt: false, restage: true });
    }
  });

  it('未知状态(未来 schema)保守 wait', () => {
    const m = makeMarker({ state: 'something_new' as MigrationState });
    expect(decideStartupAction(input({ marker: m })).kind).toBe('wait');
  });
});
