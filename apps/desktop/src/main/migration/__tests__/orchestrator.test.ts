/**
 * 迁移编排层测试(B′):启动决策执行(跳板/reconcile/重入)、campaign stage
 * 编排、执行窗口(安装 + 拉起)、argv 解析。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIRST_RUN_SENTINEL_REL_PATH } from '../firstRun';
import { HANDOFF_REL_PATH, readHandoff, type HandoffCrypto } from '../handoff';
import { readMarker, transitionMarker, writeJsonAtomic } from '../markerStore';
import {
  executeMigrationWindow,
  expectedInstallFile,
  MARKER_REL_PATH,
  migratedLaunchArgsFor,
  parseMigratedLaunchArgs,
  prepareMigrationCampaign,
  resolveLegacyLaunchPath,
  resolveLegacyProcessName,
  runTransitionStartup,
  type ExecutionWindowDeps,
  type MigrationCampaignDeps,
  type TransitionStartupDeps,
} from '../orchestrator';
import { DEFAULT_MAX_ATTEMPTS, type MigrationMarker, type MigrationState } from '../types';

let oldUd: string;
let newUd: string;
beforeEach(() => {
  oldUd = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-orch-old-'));
  newUd = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-orch-new-'));
});
afterEach(() => {
  fs.rmSync(oldUd, { recursive: true, force: true });
  fs.rmSync(newUd, { recursive: true, force: true });
});

const NOW_ISO = '2026-07-10T00:00:00.000Z';
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function writeMarker(state: MigrationState, extra: Partial<MigrationMarker> = {}): string {
  const markerPath = path.join(oldUd, MARKER_REL_PATH);
  const marker: MigrationMarker = {
    schemaVersion: 1, migrationId: 'mig-1', state, attempt: 1,
    maxAttempts: DEFAULT_MAX_ATTEMPTS, updatedAt: NOW_ISO, updatedBy: 'old-app',
    source: {
      app: 'xdt-maker', version: '0.0.130', installDir: 'C:\\old',
      userDataDir: oldUd, uninstallDisplayNamePrefix: 'xdt-maker',
    },
    target: {
      app: 'cindy', version: '1.0.0', payloadPath: path.join(oldUd, 'updates', 'cindy.exe'),
      payloadSha256: 'abc', installDir: 'C:\\new', userDataDir: newUd, exeName: 'cindy.exe',
    },
    handoff: null, lastError: null,
    ...extra,
  };
  writeJsonAtomic(markerPath, marker);
  return markerPath;
}

function writeSentinel(): void {
  const p = path.join(newUd, FIRST_RUN_SENTINEL_REL_PATH);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    schemaVersion: 1,
    migrationId: 'mig-1',
    legacyUserDataDir: oldUd,
  }));
}

function writeReceipt(): void {
  writeJsonAtomic(path.join(newUd, 'migration', 'receipt.json'), {
    schemaVersion: 1,
    migrationId: 'mig-1',
    legacyUserDataDir: oldUd,
    confirmedAt: NOW_ISO,
    healthyLaunchCount: 1,
  });
}

function startupDeps(overrides: Partial<TransitionStartupDeps> = {}): TransitionStartupDeps {
  return {
    platform: 'win32',
    oldUserDataDir: oldUd,
    probeTargetRunning: vi.fn(async () => false),
    spawnTarget: vi.fn(async () => 'alive' as const),
    log,
    nowIso: () => NOW_ISO,
    ...overrides,
  };
}

describe('runTransitionStartup', () => {
  it('无 marker → 正常启动', async () => {
    const cleanupStaleHandoff = vi.fn(() => true);
    const r = await runTransitionStartup(startupDeps({ cleanupStaleHandoff }));
    expect(r).toMatchObject({ action: 'continue', decision: 'no-marker' });
    expect(cleanupStaleHandoff).toHaveBeenCalledWith(null);
  });

  it('confirmed + Cindy 已在跑 → 不 spawn 直接退出', async () => {
    writeMarker('confirmed');
    const spawnTarget = vi.fn(async () => 'alive' as const);
    const cleanupMigrationPayloads = vi.fn();
    const r = await runTransitionStartup(startupDeps({
      probeTargetRunning: vi.fn(async () => true), spawnTarget, cleanupMigrationPayloads,
    }));
    expect(r.action).toBe('quit');
    expect(r.detail).toBe('already-running');
    expect(spawnTarget).not.toHaveBeenCalled();
    expect(cleanupMigrationPayloads).toHaveBeenCalledOnce();
  });

  it('give-up 启动路径清理已无用途的迁移 payload', async () => {
    writeMarker('failed', {
      attempt: 5,
      maxAttempts: 5,
      lastError: { code: 'LAUNCH_FAILED', message: 'boom', at: NOW_ISO },
    });
    const cleanupMigrationPayloads = vi.fn();

    const r = await runTransitionStartup(startupDeps({ cleanupMigrationPayloads }));

    expect(r).toMatchObject({ action: 'continue', decision: 'give-up' });
    expect(cleanupMigrationPayloads).toHaveBeenCalledOnce();
  });

  it('confirmed + spawn 短时退出但复测在跑 = 单实例让位 → 成功退出(P0-1)', async () => {
    writeMarker('confirmed');
    const probe = vi.fn(async () => false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const r = await runTransitionStartup(startupDeps({
      probeTargetRunning: probe, spawnTarget: vi.fn(async () => 'exited' as const),
    }));
    expect(r.action).toBe('quit');
    expect(r.detail).toBe('yielded-to-running-instance');
  });

  it('confirmed + 真拉不起来 → fallback_active,老 app 继续跑', async () => {
    const markerPath = writeMarker('confirmed');
    const r = await runTransitionStartup(startupDeps({
      spawnTarget: vi.fn(async () => 'exited' as const),
    }));
    expect(r.action).toBe('continue');
    expect(readMarker(markerPath)!.state).toBe('fallback_active');
  });

  it('fallback_active + 跳板重试成功 → 回写 confirmed 并退出', async () => {
    const markerPath = writeMarker('fallback_active');
    const r = await runTransitionStartup(startupDeps());
    expect(r.action).toBe('quit');
    expect(readMarker(markerPath)!.state).toBe('confirmed');
  });

  it('launched + Cindy 在跑 → wait,不介入(首启自拷进行中)', async () => {
    writeMarker('launched');
    const r = await runTransitionStartup(startupDeps({
      probeTargetRunning: vi.fn(async () => true),
    }));
    expect(r).toMatchObject({ action: 'continue', decision: 'wait' });
  });

  it('launched + Cindy 不在跑 → 作为交棒失败计入 retry 预算', async () => {
    writeMarker('launched');
    const r = await runTransitionStartup(startupDeps());
    expect(r).toMatchObject({
      action: 'continue', decision: 'retry',
      pendingRetry: { countAttempt: true, restage: false },
    });
  });

  it('launched + 新侧 sentinel → reconcile 置 confirmed 后跳板(铁律)', async () => {
    const markerPath = writeMarker('launched');
    writeSentinel();
    writeReceipt();
    const r = await runTransitionStartup(startupDeps({
      probeTargetRunning: vi.fn(async () => true),
    }));
    expect(r.action).toBe('quit');
    expect(readMarker(markerPath)!.state).toBe('confirmed');
  });

  it('仅有 sentinel、缺 receipt → 不得 reconcile-confirm', async () => {
    const markerPath = writeMarker('launched');
    writeSentinel();
    const r = await runTransitionStartup(startupDeps({
      probeTargetRunning: vi.fn(async () => false),
    }));
    expect(r.decision).toBe('retry');
    expect(readMarker(markerPath)!.state).toBe('launched');
  });

  it('sentinel/receipt migrationId 与旧 marker 不匹配 → 不得确认', async () => {
    const markerPath = writeMarker('launched', { migrationId: 'mig-other' });
    writeSentinel();
    writeReceipt();
    const r = await runTransitionStartup(startupDeps());
    expect(r.decision).toBe('retry');
    expect(readMarker(markerPath)!.state).toBe('launched');
  });

  it('reconcile 写回前 marker 被清理 → 用已验证快照重建 confirmed', async () => {
    const markerPath = writeMarker('launched');
    writeSentinel();
    writeReceipt();
    const r = await runTransitionStartup(startupDeps({
      probeTargetRunning: vi.fn(async () => {
        fs.rmSync(markerPath, { force: true });
        return true;
      }),
    }));
    expect(r.action).toBe('quit');
    expect(readMarker(markerPath)).toMatchObject({
      migrationId: 'mig-1',
      state: 'confirmed',
      updatedBy: 'old-app',
      source: { app: 'xdt-maker' },
      target: { app: 'cindy' },
      lastError: null,
    });
  });

  it('failed → pendingRetry 透传给 campaign', async () => {
    writeMarker('failed', {
      lastError: { code: 'INSTALL_FAILED', message: 'x', at: NOW_ISO },
    });
    const r = await runTransitionStartup(startupDeps());
    expect(r).toMatchObject({
      action: 'continue', decision: 'retry',
      pendingRetry: { countAttempt: true, restage: false },
    });
  });
});

// ── campaign ───────────────────────────────────────────────────────────────

function campaignDeps(overrides: Partial<MigrationCampaignDeps> = {}): MigrationCampaignDeps {
  const payloadPath = path.join(oldUd, 'updates', 'cindy-setup.exe');
  return {
    platform: 'win32',
    oldUserDataDir: oldUd,
    source: {
      app: 'xdt-maker', version: '0.0.130', installDir: 'C:\\old',
      userDataDir: oldUd, uninstallDisplayNamePrefix: 'xdt-maker',
    },
    target: {
      app: 'cindy', installDir: 'C:\\new', userDataDir: newUd, exeName: 'cindy.exe',
    },
    payload: { url: 'https://cdn/cindy/setup.exe', sha256: 'abc', version: '1.0.0' },
    payloadTargetPath: payloadPath,
    download: vi.fn(async ({ targetPath }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'payload');
    }),
    handoffCrypto: null,
    probeTargetRunning: vi.fn(async () => false),
    newMigrationId: () => 'mig-new',
    log,
    nowIso: () => NOW_ISO,
    ...overrides,
  };
}

describe('prepareMigrationCampaign', () => {
  it('全新迁移:下载 → staged → handoff_ready(win 无交接)', async () => {
    const r = await prepareMigrationCampaign(campaignDeps());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.marker.state).toBe('handoff_ready');
      expect(r.marker.target.version).toBe('1.0.0');
    }
  });

  it('fallback_active + 新侧 sentinel → 重装重入(P0-3;Cindy 首启见 sentinel 自然跳过自拷)', async () => {
    writeMarker('fallback_active');
    writeSentinel();
    writeReceipt();
    const r = await prepareMigrationCampaign(campaignDeps());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.marker.state).toBe('handoff_ready');
  });

  it('无 marker 但新侧已激活 → 跳过,绝不重迁(防覆盖铁律)', async () => {
    writeSentinel();
    writeReceipt();
    const r = await prepareMigrationCampaign(campaignDeps());
    expect(r).toMatchObject({ ok: false, skipped: true });
  });

  it('无 marker 但 Cindy 已运行 → 跳过且不下载/不创建 campaign', async () => {
    const download = vi.fn(async () => {});
    const r = await prepareMigrationCampaign(campaignDeps({
      probeTargetRunning: vi.fn(async () => true),
      download,
    }));
    expect(r).toEqual({
      ok: false,
      skipped: true,
      reason: 'target app already running without marker',
    });
    expect(download).not.toHaveBeenCalled();
    expect(readMarker(path.join(oldUd, MARKER_REL_PATH))).toBeNull();
  });

  it('in-progress + Cindy 在跑 → 跳过等待', async () => {
    writeMarker('installed');
    const r = await prepareMigrationCampaign(campaignDeps({
      probeTargetRunning: vi.fn(async () => true),
    }));
    expect(r).toMatchObject({ ok: false, skipped: true });
  });

  it('failed 真失败重入 → attempt+1(计数语义)', async () => {
    writeMarker('failed', {
      attempt: 2,
      lastError: { code: 'INSTALL_FAILED', message: 'x', at: NOW_ISO },
    });
    const r = await prepareMigrationCampaign(campaignDeps());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.marker.attempt).toBe(3);
  });

  it('failed 旧版本预算耗尽后仍接受 manifest 修正版并重置 attempt', async () => {
    writeMarker('failed', {
      attempt: DEFAULT_MAX_ATTEMPTS,
      target: {
        app: 'cindy', version: '0.9.0', payloadPath: path.join(oldUd, 'updates', 'bad.exe'),
        payloadSha256: 'bad', installDir: 'C:\\new', userDataDir: newUd, exeName: 'cindy.exe',
      },
      lastError: { code: 'INSTALL_FAILED', message: 'bad payload', at: NOW_ISO },
    });

    const r = await prepareMigrationCampaign(campaignDeps());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.marker.target.version).toBe('1.0.0');
      expect(r.marker.attempt).toBe(0);
    }
  });

  it('confirmed → 跳过(跳板由启动路径负责)', async () => {
    writeMarker('confirmed');
    const r = await prepareMigrationCampaign(campaignDeps());
    expect(r).toMatchObject({ ok: false, skipped: true });
  });

  it('handoff_ready + 同版本 payload 在盘 → 复用 payload 但刷新 handoff', async () => {
    const payloadPath = path.join(oldUd, 'updates', 'cindy-setup.exe');
    fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
    fs.writeFileSync(payloadPath, 'payload');
    writeMarker('handoff_ready', {
      target: {
        app: 'cindy', version: '1.0.0', payloadPath, payloadSha256: 'abc',
        installDir: 'C:\\new', userDataDir: newUd, exeName: 'cindy.exe',
      },
    });
    const safeStorageDir = path.join(oldUd, 'safe-storage');
    fs.mkdirSync(safeStorageDir, { recursive: true });
    fs.writeFileSync(path.join(safeStorageDir, 'api_key.enc'), 'encrypted-new');
    const handoffCrypto: HandoffCrypto = {
      isAvailable: () => true,
      decryptFromBase64: vi.fn(() => 'new-secret'),
      encryptToBase64: vi.fn(() => ''),
    };
    const download = vi.fn(async () => {});
    const r = await prepareMigrationCampaign(campaignDeps({ download, handoffCrypto }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.marker.state).toBe('handoff_ready');
    expect(download).toHaveBeenCalledOnce();
    const handoff = readHandoff(path.join(oldUd, HANDOFF_REL_PATH))!;
    expect(Buffer.from(handoff.entries[0].plaintextB64, 'base64').toString('utf8')).toBe('new-secret');
  });

  it('handoff_ready + 版本作废(N+2)→ 降级 failed 后立即重 stage(P1-5)', async () => {
    writeMarker('handoff_ready', {
      target: {
        app: 'cindy', version: '0.9.0', payloadPath: path.join(oldUd, 'updates', 'old.exe'),
        payloadSha256: 'old', installDir: 'C:\\new', userDataDir: newUd, exeName: 'cindy.exe',
      },
    });
    const r = await prepareMigrationCampaign(campaignDeps());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.marker.state).toBe('handoff_ready');
      expect(r.marker.target.version).toBe('1.0.0');
    }
  });

  it('handoff_ready 降级后即使随后下载失败也立即清理旧 handoff', async () => {
    const handoffPath = path.join(oldUd, HANDOFF_REL_PATH);
    const handoffTempPath = path.join(
      path.dirname(handoffPath),
      `.${path.basename(handoffPath)}.tmp-test`,
    );
    fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
    fs.writeFileSync(handoffPath, '{"plaintextB64":"secret"}');
    fs.writeFileSync(handoffTempPath, '{"plaintextB64":"temp-secret"}');
    const markerPath = writeMarker('handoff_ready', {
      handoff: { path: handoffPath, createdAt: NOW_ISO, sha256: 'abc' },
    });

    const r = await prepareMigrationCampaign(campaignDeps({
      download: vi.fn(async () => { throw new Error('network down'); }),
    }));

    expect(r).toMatchObject({ ok: false, skipped: false, step: 'download' });
    expect(readMarker(markerPath)!.state).toBe('failed');
    expect(fs.existsSync(handoffPath)).toBe(false);
    expect(fs.existsSync(handoffTempPath)).toBe(false);
  });

  it('并发推进导致降级被拒时也清理已失效 handoff', async () => {
    const handoffPath = path.join(oldUd, HANDOFF_REL_PATH);
    const handoffTempPath = path.join(
      path.dirname(handoffPath),
      `.${path.basename(handoffPath)}.tmp-test`,
    );
    fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
    fs.writeFileSync(handoffPath, '{"plaintextB64":"secret"}');
    fs.writeFileSync(handoffTempPath, '{"plaintextB64":"temp-secret"}');
    const markerPath = writeMarker('handoff_ready', {
      handoff: { path: handoffPath, createdAt: NOW_ISO, sha256: 'abc' },
    });

    const r = await prepareMigrationCampaign(campaignDeps({
      probeTargetRunning: vi.fn(async () => {
        writeJsonAtomic(markerPath, { ...readMarker(markerPath)!, state: 'confirmed' });
        return false;
      }),
    }));

    expect(r).toEqual({ ok: false, skipped: true, reason: 'reentry demote rejected' });
    expect(readMarker(markerPath)!.state).toBe('confirmed');
    expect(fs.existsSync(handoffPath)).toBe(false);
    expect(fs.existsSync(handoffTempPath)).toBe(false);
  });

  it('中断的 in-progress 重入:先合法降级 failed 再重 stage(纯中断不计 attempt)', async () => {
    writeMarker('installed', { attempt: 1 });
    const r = await prepareMigrationCampaign(campaignDeps());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.marker.state).toBe('handoff_ready');
      expect(r.marker.attempt).toBe(1); // 无 lastError → 不消耗重试预算
    }
  });

  it('下载失败 → 不写 marker,可重试', async () => {
    const r = await prepareMigrationCampaign(campaignDeps({
      download: vi.fn(async () => { throw new Error('net down'); }),
    }));
    expect(r).toMatchObject({ ok: false, skipped: false, step: 'download' });
    expect(readMarker(path.join(oldUd, MARKER_REL_PATH))).toBeNull();
  });
});

// ── 执行窗口(安装 + 拉起) ────────────────────────────────────────────────

function windowDeps(overrides: Partial<ExecutionWindowDeps> = {}): ExecutionWindowDeps {
  return {
    platform: 'win32',
    oldUserDataDir: oldUd,
    probeTargetRunning: vi.fn(async () => false),
    installPayload: vi.fn(async () => {}),
    refreshHandoff: vi.fn(async () => ({
      path: path.join(oldUd, HANDOFF_REL_PATH),
      createdAt: NOW_ISO,
      sha256: 'test-handoff',
    })),
    launchTarget: vi.fn(async () => true),
    fileExists: () => true,
    log,
    nowIso: () => NOW_ISO,
    ...overrides,
  };
}

describe('executeMigrationWindow', () => {
  it('主路径:handoff_ready → installed → launched,拉起参数带双 flag', async () => {
    const markerPath = writeMarker('handoff_ready');
    const launchTarget = vi.fn(async () => true);
    const r = await executeMigrationWindow(windowDeps({ launchTarget }));
    expect(r).toEqual({ ok: true });
    expect(readMarker(markerPath)!.state).toBe('launched');
    expect(launchTarget).toHaveBeenCalledWith(
      path.join('C:\\new', 'cindy.exe'),
      [
        '--migrated-from=xdt-maker',
        `--legacy-user-data=${oldUd}`,
        '--legacy-install-dir=C:\\old',
        '--legacy-uninstall-prefix=xdt-maker',
      ],
    );
  });

  it('macOS 安装前刷新 handoff，并让安装消费刷新后的 marker', async () => {
    const handoffPath = path.join(oldUd, HANDOFF_REL_PATH);
    const markerPath = writeMarker('handoff_ready', {
      handoff: { path: handoffPath, createdAt: '2026-07-09T00:00:00.000Z', sha256: 'old' },
    });
    const refreshed = {
      path: handoffPath,
      createdAt: NOW_ISO,
      sha256: 'fresh',
    };
    const refreshHandoff = vi.fn(async () => refreshed);
    const installPayload = vi.fn(async (marker: MigrationMarker) => {
      expect(marker.handoff).toEqual(refreshed);
    });

    const r = await executeMigrationWindow(windowDeps({
      platform: 'darwin',
      refreshHandoff,
      installPayload,
    }));

    expect(r).toEqual({ ok: true });
    expect(refreshHandoff).toHaveBeenCalledOnce();
    expect(installPayload).toHaveBeenCalledOnce();
    expect(readMarker(markerPath)!.handoff).toEqual(refreshed);
  });

  it('非 handoff_ready(含无 marker)→ 放弃且不动 marker', async () => {
    expect((await executeMigrationWindow(windowDeps())).ok).toBe(false);
    const markerPath = writeMarker('launched');
    const r = await executeMigrationWindow(windowDeps());
    expect(r.ok).toBe(false);
    expect(readMarker(markerPath)!.state).toBe('launched');
  });

  it('Cindy 已在跑 → 放弃(上轮 launched 的进程还活着)', async () => {
    const handoffPath = path.join(oldUd, HANDOFF_REL_PATH);
    const handoffTempPath = path.join(
      path.dirname(handoffPath),
      `.${path.basename(handoffPath)}.tmp-test`,
    );
    fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
    fs.writeFileSync(handoffPath, '{"plaintextB64":"secret"}');
    fs.writeFileSync(handoffTempPath, '{"plaintextB64":"temp-secret"}');
    writeMarker('handoff_ready', {
      handoff: { path: handoffPath, createdAt: NOW_ISO, sha256: 'abc' },
    });
    const installPayload = vi.fn(async () => {});
    const r = await executeMigrationWindow(windowDeps({
      probeTargetRunning: vi.fn(async () => true), installPayload,
    }));
    expect(r.ok).toBe(false);
    expect(installPayload).not.toHaveBeenCalled();
    expect(fs.existsSync(handoffPath)).toBe(false);
    expect(fs.existsSync(handoffTempPath)).toBe(false);
  });

  it('安装抛错 → failed(INSTALL_FAILED)', async () => {
    const markerPath = writeMarker('handoff_ready');
    const r = await executeMigrationWindow(windowDeps({
      installPayload: vi.fn(async () => { throw new Error('nsis exit 2'); }),
    }));
    expect(r.ok).toBe(false);
    const m = readMarker(markerPath)!;
    expect(m.state).toBe('failed');
    expect(m.lastError?.code).toBe('INSTALL_FAILED');
  });

  it.each(['install', 'launch'] as const)(
    'macOS %s 失败且 marker 落 failed 后删除 handoff 正文与临时文件',
    async (failedStep) => {
      const handoffPath = path.join(oldUd, HANDOFF_REL_PATH);
      const handoffTempPath = path.join(
        path.dirname(handoffPath),
        `.${path.basename(handoffPath)}.tmp-test`,
      );
      fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
      fs.writeFileSync(handoffPath, '{"plaintextB64":"secret"}');
      fs.writeFileSync(handoffTempPath, '{"plaintextB64":"temp-secret"}');
      const markerPath = writeMarker('handoff_ready', {
        handoff: { path: handoffPath, createdAt: NOW_ISO, sha256: 'abc' },
      });

      const r = await executeMigrationWindow(windowDeps({
        platform: 'darwin',
        ...(failedStep === 'install'
          ? { installPayload: vi.fn(async () => { throw new Error('ditto failed'); }) }
          : { launchTarget: vi.fn(async () => false) }),
      }));

      expect(r.ok).toBe(false);
      expect(readMarker(markerPath)!.state).toBe('failed');
      expect(fs.existsSync(handoffPath)).toBe(false);
      expect(fs.existsSync(handoffTempPath)).toBe(false);
    },
  );

  it('failed marker 写入抛错时仍删除 handoff 正文与临时文件', async () => {
    const handoffPath = path.join(oldUd, HANDOFF_REL_PATH);
    const handoffTempPath = path.join(
      path.dirname(handoffPath),
      `.${path.basename(handoffPath)}.tmp-test`,
    );
    fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
    fs.writeFileSync(handoffPath, '{"plaintextB64":"secret"}');
    fs.writeFileSync(handoffTempPath, '{"plaintextB64":"temp-secret"}');
    const markerPath = writeMarker('handoff_ready', {
      handoff: { path: handoffPath, createdAt: NOW_ISO, sha256: 'abc' },
    });

    const r = await executeMigrationWindow(windowDeps({
      platform: 'darwin',
      installPayload: vi.fn(async () => { throw new Error('ditto failed'); }),
      transitionState: (filePath, args) => {
        if (args.to === 'failed') throw new Error('state.json locked');
        return transitionMarker(filePath, args);
      },
    }));

    expect(r).toMatchObject({ ok: false, reason: 'INSTALL_FAILED: ditto failed' });
    expect(readMarker(markerPath)!.state).toBe('handoff_ready');
    expect(fs.existsSync(handoffPath)).toBe(false);
    expect(fs.existsSync(handoffTempPath)).toBe(false);
  });

  it.each(['rejected', 'thrown'] as const)(
    '安装成功后 installed marker 写入 %s 仍清理 handoff',
    async (failureMode) => {
      const handoffPath = path.join(oldUd, HANDOFF_REL_PATH);
      const handoffTempPath = path.join(
        path.dirname(handoffPath),
        `.${path.basename(handoffPath)}.tmp-test`,
      );
      fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
      fs.writeFileSync(handoffPath, '{"plaintextB64":"secret"}');
      fs.writeFileSync(handoffTempPath, '{"plaintextB64":"temp-secret"}');
      const markerPath = writeMarker('handoff_ready', {
        handoff: { path: handoffPath, createdAt: NOW_ISO, sha256: 'abc' },
      });
      const transitionState: NonNullable<ExecutionWindowDeps['transitionState']> =
        (filePath, args) => {
          if (args.to === 'handoff_ready') return transitionMarker(filePath, args);
          if (failureMode === 'thrown') throw new Error('state.json locked');
          return { ok: false, reason: 'transition rejected for test' };
        };

      const r = await executeMigrationWindow(windowDeps({
        platform: 'darwin',
        transitionState,
      }));

      expect(r).toMatchObject({ ok: false });
      expect(readMarker(markerPath)!.state).toBe('handoff_ready');
      expect(fs.existsSync(handoffPath)).toBe(false);
      expect(fs.existsSync(handoffTempPath)).toBe(false);
    },
  );

  it('Cindy 已存活后 launched marker 写入抛错仍按成功退场', async () => {
    const markerPath = writeMarker('handoff_ready');
    const launchTarget = vi.fn(async () => true);
    const transitionState: NonNullable<ExecutionWindowDeps['transitionState']> =
      (path, args) => {
        if (args.to === 'launched') throw new Error('state.json locked');
        return transitionMarker(path, args);
      };

    const r = await executeMigrationWindow(windowDeps({ launchTarget, transitionState }));

    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('LAUNCH_FAILED') });
    expect(launchTarget).toHaveBeenCalledOnce();
    expect(readMarker(markerPath)!).toMatchObject({
      state: 'failed',
      lastError: { code: 'LAUNCH_FAILED' },
    });
  });

  it('fails safely and clears handoff when launched marker transition is rejected', async () => {
    const handoffPath = path.join(oldUd, HANDOFF_REL_PATH);
    fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
    fs.writeFileSync(handoffPath, '{"plaintextB64":"secret"}');
    const markerPath = writeMarker('handoff_ready', {
      handoff: { path: handoffPath, createdAt: NOW_ISO, sha256: 'abc' },
    });
    const transitionState: NonNullable<ExecutionWindowDeps['transitionState']> =
      (filePath, args) => {
        if (args.to === 'launched') return { ok: false, reason: 'state changed' };
        return transitionMarker(filePath, args);
      };

    const r = await executeMigrationWindow(windowDeps({ transitionState }));

    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('LAUNCH_FAILED') });
    expect(readMarker(markerPath)!).toMatchObject({
      state: 'failed',
      lastError: { code: 'LAUNCH_FAILED' },
    });
    expect(fs.existsSync(handoffPath)).toBe(false);
  });

  it('安装后落位验证失败 → failed(INSTALL_FAILED)', async () => {
    const markerPath = writeMarker('handoff_ready');
    const r = await executeMigrationWindow(windowDeps({ fileExists: () => false }));
    expect(r.ok).toBe(false);
    expect(readMarker(markerPath)!.lastError?.code).toBe('INSTALL_FAILED');
  });

  it('拉起后短窗未观察到目标存活 → failed(LAUNCH_FAILED),旧 app 不应退场', async () => {
    const markerPath = writeMarker('handoff_ready');
    const r = await executeMigrationWindow(windowDeps({
      launchTarget: vi.fn(async () => false),
    }));
    expect(r.ok).toBe(false);
    expect(readMarker(markerPath)!.lastError?.code).toBe('LAUNCH_FAILED');
  });

  it('expectedInstallFile / migratedLaunchArgsFor 平台形态', () => {
    writeMarker('handoff_ready');
    const marker = readMarker(path.join(oldUd, MARKER_REL_PATH))!;
    expect(expectedInstallFile(marker, 'win32')).toBe(path.join('C:\\new', 'cindy.exe'));
    expect(expectedInstallFile(marker, 'darwin')).toBe(
      path.join('C:\\new', 'Contents', 'MacOS', 'cindy.exe'),
    );
    expect(migratedLaunchArgsFor(marker)).toEqual([
      '--migrated-from=xdt-maker',
      `--legacy-user-data=${oldUd}`,
      '--legacy-install-dir=C:\\old',
      '--legacy-uninstall-prefix=xdt-maker',
    ]);
  });
});

describe('parseMigratedLaunchArgs', () => {
  it('argv 解析:两参齐全才生效', () => {
    expect(parseMigratedLaunchArgs(['--migrated-from=xdt-maker'])).toBeNull();
    expect(parseMigratedLaunchArgs([
      'cindy.exe',
      '--migrated-from=xdt-maker',
      `--legacy-user-data=${oldUd}`,
      '--legacy-install-dir=C:\\old',
      '--legacy-uninstall-prefix=xdt-maker',
    ])).toEqual({
      sourceApp: 'xdt-maker',
      legacyUserDataDir: oldUd,
      legacyInstallDir: 'C:\\old',
      legacyUninstallDisplayNamePrefix: 'xdt-maker',
    });
    expect(parseMigratedLaunchArgs([
      'cindy.exe', '--migrated-from=xdt-maker', `--legacy-user-data=${oldUd}`,
    ])).toEqual({ sourceApp: 'xdt-maker', legacyUserDataDir: oldUd });
  });

  it('旧 marker 缺失时从启动参数恢复回滚启动路径', () => {
    const launchArgs = {
      sourceApp: 'xdt-maker',
      legacyUserDataDir: oldUd,
      legacyInstallDir: 'C:\\fallback',
    };
    expect(resolveLegacyLaunchPath(launchArgs, null, 'win32')).toBe(
      path.win32.join('C:\\fallback', 'xdt-maker.exe'),
    );
    expect(resolveLegacyLaunchPath(
      { ...launchArgs, legacyInstallDir: '/Applications/XDMaker.app' },
      null,
      'darwin',
    )).toBe('/Applications/XDMaker.app');
  });

  it('旧 marker 与启动参数都缺安装目录时不猜测路径', () => {
    expect(resolveLegacyLaunchPath({
      sourceApp: 'xdt-maker',
      legacyUserDataDir: oldUd,
    }, null, 'win32')).toBeNull();
  });

  it('macOS 进程名使用 executableName，不使用 .app bundle 展示名', () => {
    const launchArgs = {
      sourceApp: 'xdt-maker',
      legacyUserDataDir: oldUd,
      legacyInstallDir: '/Applications/XDMaker.app',
    };
    const oldMarker: MigrationMarker = {
      schemaVersion: 1,
      migrationId: 'mig-1',
      state: 'launched',
      attempt: 1,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      updatedAt: NOW_ISO,
      updatedBy: 'old-app',
      source: {
        app: 'xdt-maker',
        version: '0.0.130',
        installDir: '/Applications/XDMaker.app',
        userDataDir: oldUd,
        uninstallDisplayNamePrefix: 'xdt-maker',
      },
      target: {
        app: 'cindy',
        version: '1.0.0',
        payloadPath: '/tmp/Cindy.zip',
        payloadSha256: 'sha256',
        installDir: '/Applications/Cindy.app',
        userDataDir: newUd,
        exeName: 'cindy',
      },
      handoff: null,
      lastError: null,
    };
    expect(resolveLegacyProcessName(launchArgs, null, 'darwin')).toBe('xdt-maker');
    expect(resolveLegacyProcessName(launchArgs, oldMarker, 'darwin')).toBe('xdt-maker');
    expect(resolveLegacyProcessName(launchArgs, null, 'win32')).toBe('xdt-maker.exe');
  });
});
