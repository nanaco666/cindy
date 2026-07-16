/**
 * Cindy 首启健康检查 + 延迟卸载决策测试(§5)。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FIRST_RUN_SENTINEL_REL_PATH,
  RECEIPT_REL_PATH,
  UNINSTALL_MIN_DAYS_MS,
  UNINSTALL_MIN_HEALTHY_LAUNCHES,
  cleanupConfirmedHandoffs,
  classifyFirstRunFinalization,
  failFirstRunMigration,
  hasCompletedMigrationReceipt,
  recordHealthyLaunch,
  runFirstRunHealthCheck,
  selectLegacyWindowsUninstallCommand,
  shouldUninstallOldApp,
  type FirstRunDeps,
} from '../firstRun';
import { HANDOFF_REL_PATH, type HandoffCrypto } from '../handoff';
import { readMarker, readReceipt, writeJsonAtomic } from '../markerStore';
import {
  DEFAULT_MAX_ATTEMPTS,
  type LegacyInstallIdentity,
  type MigrationMarker,
  type MigrationReceipt,
} from '../types';
import { migrationPayloadTargetPath } from '../../updateArtifacts';

let oldUd: string;
let newUd: string;
beforeEach(() => {
  oldUd = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-firstrun-old-'));
  newUd = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-firstrun-new-'));
});
afterEach(() => {
  fs.rmSync(oldUd, { recursive: true, force: true });
  fs.rmSync(newUd, { recursive: true, force: true });
});

const NOW = '2026-07-10T00:00:00.000Z';
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const installIdentity: LegacyInstallIdentity = {
  schemaVersion: 1,
  executableRelativePath: 'xdt-maker.exe',
  dev: '1',
  ino: '2',
  size: '3',
  mtimeNs: '4',
  birthtimeNs: '5',
};

function writeOldMarker(state: MigrationMarker['state']): string {
  const markerPath = path.join(oldUd, 'migration', 'state.json');
  const marker: MigrationMarker = {
    schemaVersion: 1, migrationId: 'mig-1', state, attempt: 1,
    maxAttempts: DEFAULT_MAX_ATTEMPTS, updatedAt: NOW, updatedBy: 'old-app',
    source: { app: 'xdt-maker', version: '0.0.130', installDir: 'x', userDataDir: oldUd, uninstallDisplayNamePrefix: 'xdt-maker' },
    target: { app: 'cindy', version: '1.0.0', payloadPath: 'p', payloadSha256: 's', installDir: 'y', userDataDir: newUd, exeName: 'cindy.exe' },
    handoff: null, lastError: null,
  };
  writeJsonAtomic(markerPath, marker);
  return markerPath;
}

function okCrypto(): HandoffCrypto {
  return {
    isAvailable: () => true,
    decryptFromBase64: (b64) => Buffer.from(b64, 'base64').toString('utf8'),
    encryptToBase64: (p) => Buffer.from(p, 'utf8').toString('base64'),
  };
}

function deps(overrides: Partial<FirstRunDeps> = {}): FirstRunDeps {
  return {
    newUserDataDir: newUd,
    legacyUserDataDir: oldUd,
    handoffCrypto: null,
    openDb: vi.fn(async () => {}),
    verifySafeStorage: vi.fn(async () => {}),
    log,
    nowIso: () => NOW,
    ...overrides,
  };
}

describe('runFirstRunHealthCheck', () => {
  it('win 全通过:sentinel/receipt 落盘、老 marker confirmed、老侧 handoff 兜底删', async () => {
    const markerPath = writeOldMarker('launched');
    fs.mkdirSync(path.join(oldUd, 'migration'), { recursive: true });
    fs.writeFileSync(path.join(oldUd, HANDOFF_REL_PATH), '{}'); // 老侧残留
    const migrationPayload = migrationPayloadTargetPath(oldUd, 'Cindy-1.0.0.zip');
    fs.mkdirSync(path.dirname(migrationPayload), { recursive: true });
    fs.writeFileSync(migrationPayload, 'payload');

    const r = await runFirstRunHealthCheck(deps({ legacyInstallIdentity: installIdentity }));
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(newUd, FIRST_RUN_SENTINEL_REL_PATH))).toBe(true);
    const receipt = readReceipt(path.join(newUd, RECEIPT_REL_PATH))!;
    expect(receipt).toMatchObject({
      migrationId: 'mig-1',
      healthyLaunchCount: 1,
      legacyUserDataDir: oldUd,
      legacyApp: 'xdt-maker',
      legacyInstallDir: 'x',
      legacyUninstallDisplayNamePrefix: 'xdt-maker',
      legacyInstallIdentity: installIdentity,
    });
    expect(readMarker(markerPath)!.state).toBe('confirmed');
    expect(fs.existsSync(path.join(oldUd, HANDOFF_REL_PATH))).toBe(false);
    expect(fs.existsSync(migrationPayload)).toBe(false);
  });

  it('mac:handoff 导入成功并重加密;导入失败 → failed 且新侧交接文件被删', async () => {
    writeOldMarker('launched');
    // 新侧放一份交接文件(模拟拷贝到位)
    const handoff = {
      schemaVersion: 1, createdAt: NOW, platform: 'darwin', sourceApp: 'xdt-maker', sourceVersion: 'v',
      entries: [{
        store: 'api_key', relPath: 'safe-storage/api_key.enc', contentType: 'text',
        plaintextB64: Buffer.from('sk-1').toString('base64'), encryptedSha256: 'x',
      }],
    };
    fs.mkdirSync(path.join(newUd, 'migration'), { recursive: true });
    fs.writeFileSync(path.join(newUd, HANDOFF_REL_PATH), JSON.stringify(handoff));

    const ok = await runFirstRunHealthCheck(deps({ handoffCrypto: okCrypto() }));
    expect(ok.ok).toBe(true);
    expect(fs.existsSync(path.join(newUd, 'safe-storage', 'api_key.enc'))).toBe(true);

    // 第二轮:交接文件缺失(已删)而平台需要 → 失败,marker 落 failed
    const markerPath = writeOldMarker('launched');
    const bad = await runFirstRunHealthCheck(deps({ handoffCrypto: okCrypto() }));
    expect(bad).toMatchObject({ ok: false, failedStep: 'handoff-import' });
    expect(readMarker(markerPath)!.state).toBe('failed');
    expect(readMarker(markerPath)!.lastError?.code).toBe('HEALTH_CHECK_FAILED');
  });

  it('openDb 失败 → failed + 新侧交接文件被删(明文兜底,P1-2)', async () => {
    const markerPath = writeOldMarker('launched');
    fs.mkdirSync(path.join(newUd, 'migration'), { recursive: true });
    fs.writeFileSync(path.join(newUd, HANDOFF_REL_PATH), '{"schemaVersion":1,"entries":[]}');

    const relaunchLegacy = vi.fn(async () => {});
    const r = await runFirstRunHealthCheck(deps({
      openDb: vi.fn(async () => { throw new Error('db locked'); }),
      relaunchLegacy,
    }));
    expect(r).toMatchObject({ ok: false, failedStep: 'open-db' });
    expect(fs.existsSync(path.join(newUd, HANDOFF_REL_PATH))).toBe(false);
    expect(readMarker(markerPath)!.state).toBe('failed');
    // 失败路径绝不写 sentinel
    expect(fs.existsSync(path.join(newUd, FIRST_RUN_SENTINEL_REL_PATH))).toBe(false);
    expect(relaunchLegacy).toHaveBeenCalledOnce();
  });

  it('老 app 尚未退出时失败不重复拉起旧安装', async () => {
    writeOldMarker('launched');
    for (const userDataDir of [oldUd, newUd]) {
      const handoffPath = path.join(userDataDir, HANDOFF_REL_PATH);
      fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
      fs.writeFileSync(handoffPath, '{"plaintextB64":"secret"}');
    }
    const relaunchLegacy = vi.fn(async () => {});
    const r = await runFirstRunHealthCheck(deps({
      waitOldAppExit: vi.fn(async () => { throw new Error('still running'); }),
      relaunchLegacy,
    }));
    expect(r).toMatchObject({ ok: false, failedStep: 'wait-old-exit' });
    expect(relaunchLegacy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(oldUd, HANDOFF_REL_PATH))).toBe(false);
    expect(fs.existsSync(path.join(newUd, HANDOFF_REL_PATH))).toBe(false);
  });

  it('marker 非 launched(执行器崩在末步):confirmed 被矩阵拒绝但流程成功,靠 sentinel 让老 app reconcile', async () => {
    const markerPath = writeOldMarker('installed');
    const r = await runFirstRunHealthCheck(deps());
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(newUd, FIRST_RUN_SENTINEL_REL_PATH))).toBe(true);
    expect(readMarker(markerPath)!.state).toBe('installed'); // 未被非法改写
  });

  it('首启开始时 marker 已缺失 → 不确认，拉回旧 app', async () => {
    const relaunchLegacy = vi.fn(async () => {});
    const r = await runFirstRunHealthCheck(deps({
      legacyApp: 'xdt-maker',
      legacyInstallDir: '/Applications/XDMaker.app',
      legacyUninstallDisplayNamePrefix: 'XDMaker',
      relaunchLegacy,
    }));
    expect(r).toMatchObject({ ok: false, failedStep: 'confirm-marker' });
    expect(fs.existsSync(path.join(newUd, FIRST_RUN_SENTINEL_REL_PATH))).toBe(false);
    expect(readReceipt(path.join(newUd, RECEIPT_REL_PATH))).toBeNull();
    expect(relaunchLegacy).toHaveBeenCalledOnce();
  });

  it('failed marker 写盘抛错也继续拉回旧 app', async () => {
    writeOldMarker('launched');
    const relaunchLegacy = vi.fn(async () => {});
    const r = await runFirstRunHealthCheck(deps({
      openDb: vi.fn(async () => { throw new Error('db locked'); }),
      transitionState: () => { throw new Error('marker disk full'); },
      relaunchLegacy,
    }));
    expect(r).toMatchObject({ ok: false, failedStep: 'open-db' });
    expect(relaunchLegacy).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('failed-transition write failed'));
  });

  it('partial finalization 回退会把旧侧 marker 降级 failed 并拉回旧 app', async () => {
    const markerPath = writeOldMarker('launched');
    const relaunchLegacy = vi.fn(async () => {});
    const r = await failFirstRunMigration({
      newUserDataDir: newUd,
      legacyUserDataDir: oldUd,
      relaunchLegacy,
      log,
      nowIso: () => NOW,
    }, 'partial-finalization', 'sentinel/receipt mismatch');
    expect(r).toMatchObject({ ok: false, failedStep: 'partial-finalization' });
    expect(readMarker(markerPath)).toMatchObject({
      state: 'failed',
      lastError: { code: 'HEALTH_CHECK_FAILED' },
    });
    expect(relaunchLegacy).toHaveBeenCalledOnce();
  });

  it('receipt 持久化失败时清理 finalization 半成品并回拉老 app', async () => {
    const markerPath = writeOldMarker('launched');
    fs.mkdirSync(path.join(newUd, 'migration'), { recursive: true });
    fs.writeFileSync(path.join(newUd, HANDOFF_REL_PATH), '{"schemaVersion":1,"entries":[]}');
    const relaunchLegacy = vi.fn(async () => {});

    const r = await runFirstRunHealthCheck(deps({
      persistReceipt: (filePath) => {
        fs.writeFileSync(filePath, '{}');
        throw new Error('disk full');
      },
      relaunchLegacy,
    }));

    expect(r).toMatchObject({ ok: false, failedStep: 'persist-finalization' });
    expect(fs.existsSync(path.join(newUd, FIRST_RUN_SENTINEL_REL_PATH))).toBe(false);
    expect(fs.existsSync(path.join(newUd, RECEIPT_REL_PATH))).toBe(false);
    expect(fs.existsSync(path.join(newUd, HANDOFF_REL_PATH))).toBe(false);
    expect(readMarker(markerPath)!.state).toBe('failed');
    expect(relaunchLegacy).toHaveBeenCalledOnce();
  });

  it('路径重写失败不阻塞 confirmed', async () => {
    writeOldMarker('launched');
    const r = await runFirstRunHealthCheck(deps({
      rewriteAbsolutePaths: vi.fn(async () => { throw new Error('busy'); }),
    }));
    expect(r.ok).toBe(true);
  });
});

describe('recordHealthyLaunch / shouldUninstallOldApp', () => {
  function receipt(overrides: Partial<MigrationReceipt> = {}): MigrationReceipt {
    return {
      schemaVersion: 1, migrationId: 'mig-1', legacyUserDataDir: oldUd,
      confirmedAt: NOW, healthyLaunchCount: 3, ...overrides,
    };
  }
  const AFTER_WINDOW = Date.parse(NOW) + UNINSTALL_MIN_DAYS_MS + 1;

  it('recordHealthyLaunch 计数 +1;无 receipt 时 no-op', () => {
    const receiptPath = path.join(newUd, RECEIPT_REL_PATH);
    recordHealthyLaunch(newUd); // 不存在 → 不抛
    writeJsonAtomic(receiptPath, receipt({ healthyLaunchCount: 1 }));
    recordHealthyLaunch(newUd);
    expect(readReceipt(receiptPath)!.healthyLaunchCount).toBe(2);
  });

  it('recordHealthyLaunch 写失败仅告警，不阻断 confirmed 启动', () => {
    const receiptPath = path.join(newUd, RECEIPT_REL_PATH);
    writeJsonAtomic(receiptPath, receipt({ healthyLaunchCount: 1 }));
    const onError = vi.fn();

    expect(() => recordHealthyLaunch(newUd, {
      persistReceipt: () => { throw new Error('disk full'); },
      onError,
    })).not.toThrow();

    expect(readReceipt(receiptPath)!.healthyLaunchCount).toBe(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk full' }));
  });

  it('confirmed 后重启可幂等补清新旧两侧 handoff', () => {
    for (const userDataDir of [oldUd, newUd]) {
      const handoffPath = path.join(userDataDir, HANDOFF_REL_PATH);
      fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
      fs.writeFileSync(handoffPath, '{"plaintextB64":"secret"}');
    }

    cleanupConfirmedHandoffs(newUd, receipt());
    expect(fs.existsSync(path.join(oldUd, HANDOFF_REL_PATH))).toBe(false);
    expect(fs.existsSync(path.join(newUd, HANDOFF_REL_PATH))).toBe(false);
    expect(() => cleanupConfirmedHandoffs(newUd, receipt())).not.toThrow();
  });

  it('双条件 + marker==confirmed + 无老进程,全满足才放行', () => {
    const base = { receipt: receipt(), oldMarkerState: 'confirmed', oldAppRunning: false, nowMs: AFTER_WINDOW };
    expect(shouldUninstallOldApp(base)).toBe(true);
    // 时间不满
    expect(shouldUninstallOldApp({ ...base, nowMs: Date.parse(NOW) + 1000 })).toBe(false);
    // 次数不满
    expect(shouldUninstallOldApp({ ...base, receipt: receipt({ healthyLaunchCount: UNINSTALL_MIN_HEALTHY_LAUNCHES - 1 }) })).toBe(false);
    // fallback 逃生舱保护(P1-4)
    expect(shouldUninstallOldApp({ ...base, oldMarkerState: 'fallback_active' })).toBe(false);
    // 跳板正在跑(P2-3)
    expect(shouldUninstallOldApp({ ...base, oldAppRunning: true })).toBe(false);
    // marker 是安装归属凭证；读不到时 fail closed，避免误删后来重装的旧 app
    expect(shouldUninstallOldApp({ ...base, oldMarkerState: null })).toBe(false);
    // 无 receipt → 永不
    expect(shouldUninstallOldApp({ ...base, receipt: null })).toBe(false);
  });
});

describe('classifyFirstRunFinalization', () => {
  const completeReceipt: MigrationReceipt = {
    schemaVersion: 1,
    migrationId: 'mig-1',
    legacyUserDataDir: 'old',
    confirmedAt: NOW,
    healthyLaunchCount: 1,
  };

  it('sentinel 与 receipt 必须成对存在', () => {
    const sentinel = {
      schemaVersion: 1 as const,
      migrationId: 'mig-1',
      legacyUserDataDir: 'old',
    };
    expect(classifyFirstRunFinalization(false, null, null)).toBe('none');
    expect(classifyFirstRunFinalization(true, sentinel, completeReceipt)).toBe('complete');
    expect(classifyFirstRunFinalization(true, null, completeReceipt)).toBe('partial');
    expect(classifyFirstRunFinalization(false, sentinel, completeReceipt)).toBe('partial');
    expect(classifyFirstRunFinalization(true, sentinel, {
      ...completeReceipt, migrationId: 'other',
    })).toBe('partial');
  });
});

describe('hasCompletedMigrationReceipt', () => {
  it('只有完整且匹配的 sentinel/receipt 才开放旧 UID 本地库认领', () => {
    expect(hasCompletedMigrationReceipt(newUd)).toBe(false);

    const receiptPath = path.join(newUd, RECEIPT_REL_PATH);
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, '{"schemaVersion":2}');
    expect(hasCompletedMigrationReceipt(newUd)).toBe(false);

    fs.writeFileSync(receiptPath, '{"schemaVersion":1}');
    expect(hasCompletedMigrationReceipt(newUd)).toBe(false);
    const sentinelPath = path.join(newUd, FIRST_RUN_SENTINEL_REL_PATH);
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, JSON.stringify({
      schemaVersion: 1,
      migrationId: 'mig-1',
      legacyUserDataDir: 'old',
    }));
    fs.writeFileSync(receiptPath, JSON.stringify({
      schemaVersion: 1,
      migrationId: 'mig-1',
      legacyUserDataDir: 'old',
      confirmedAt: NOW,
      healthyLaunchCount: 1,
    }));
    expect(hasCompletedMigrationReceipt(newUd)).toBe(true);
  });
});

describe('selectLegacyWindowsUninstallCommand', () => {
  const identity = { displayNamePrefix: 'xdt-maker', installDir: 'C:\\Apps\\XDMaker' };
  const exact = {
    displayName: 'xdt-maker 0.0.130',
    installLocation: 'c:\\apps\\xdmaker\\',
    quietUninstallString: '"C:\\Apps\\XDMaker\\Uninstall.exe" /S',
  };

  it('品牌前缀与安装目录精确匹配且候选唯一时返回命令', () => {
    expect(selectLegacyWindowsUninstallCommand([exact], identity)).toBe(
      '"C:\\Apps\\XDMaker\\Uninstall.exe" /S',
    );
  });

  it('同前缀其它安装目录、缺 InstallLocation 或多候选均 fail closed', () => {
    expect(selectLegacyWindowsUninstallCommand([
      { ...exact, installLocation: 'C:\\Apps\\XDMaker-Tools' },
    ], identity)).toBeNull();
    expect(selectLegacyWindowsUninstallCommand([
      { ...exact, installLocation: undefined },
    ], identity)).toBeNull();
    expect(selectLegacyWindowsUninstallCommand([exact, { ...exact }], identity)).toBeNull();
  });
});
