/**
 * stageMigration 编排测试:下载幂等复用、staged/handoff_ready 推进、
 * 版本作废重下(P1-5)、handoff 无条件重导出(P1-3)、失败路径落 failed。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HANDOFF_REL_PATH, type HandoffCrypto } from '../handoff';
import { readMarker, transitionMarker, writeJsonAtomic } from '../markerStore';
import { stageMigration, type StageMigrationArgs } from '../stage';
import { migrationPayloadTargetPath } from '../../updateArtifacts';

let ud: string;
beforeEach(() => {
  ud = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-stage-test-'));
});
afterEach(() => {
  fs.rmSync(ud, { recursive: true, force: true });
});

function okCrypto(): HandoffCrypto {
  return {
    isAvailable: () => true,
    decryptFromBase64: (b64) => Buffer.from(b64, 'base64').toString('utf8'),
    encryptToBase64: (p) => Buffer.from(p, 'utf8').toString('base64'),
  };
}

function makeArgs(overrides: Partial<StageMigrationArgs> = {}): StageMigrationArgs {
  const payloadTargetPath = migrationPayloadTargetPath(ud, 'cindy-1.0.0-Setup.exe');
  return {
    markerPath: path.join(ud, 'migration', 'state.json'),
    source: {
      app: 'xdt-maker', version: '0.0.130', installDir: path.join(ud, 'inst-old'),
      userDataDir: ud, uninstallDisplayNamePrefix: 'xdt-maker',
    },
    target: {
      app: 'cindy', installDir: path.join(ud, 'inst-new'),
      userDataDir: path.join(ud, '..', 'Cindy-ud'), exeName: 'cindy.exe',
    },
    payload: { url: 'https://cdn/x/cindy-1.0.0-Setup.exe', sha256: 'a'.repeat(64), version: '1.0.0' },
    payloadTargetPath,
    download: vi.fn(async ({ targetPath }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'payload-bytes');
    }),
    handoffCrypto: null, // 默认按 Windows 形态
    newMigrationId: () => 'mig-fixed',
    nowIso: () => '2026-07-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('stageMigration', () => {
  it('全新迁移(win):下载 → staged → handoff_ready(handoff=null)', async () => {
    const args = makeArgs();
    const r = await stageMigration(args);
    expect(r.ok).toBe(true);
    const marker = readMarker(args.markerPath)!;
    expect(marker.state).toBe('handoff_ready');
    expect(marker.migrationId).toBe('mig-fixed');
    expect(marker.handoff).toBeNull();
    expect(marker.target).toMatchObject({
      version: '1.0.0', payloadSha256: 'a'.repeat(64), payloadPath: args.payloadTargetPath,
    });
    expect(args.download).toHaveBeenCalledTimes(1);
  });

  it('mac:handoff 导出并登记进 marker;重入时无条件重新导出(P1-3)', async () => {
    // 预置一个 safe-storage 密钥,导出应包含它
    const ssDir = path.join(ud, 'safe-storage');
    fs.mkdirSync(ssDir, { recursive: true });
    fs.writeFileSync(path.join(ssDir, 'api_key.enc'), Buffer.from('sk-1', 'utf8').toString('base64'));

    const args = makeArgs({ handoffCrypto: okCrypto() });
    const r1 = await stageMigration(args);
    expect(r1.ok).toBe(true);
    const marker1 = readMarker(args.markerPath)!;
    expect(marker1.handoff).not.toBeNull();
    const handoffSha1 = marker1.handoff!.sha256;

    // 用户改了凭证后失败重入 → handoff 必须重导出(内容哈希变化)
    fs.writeFileSync(path.join(ssDir, 'api_key.enc'), Buffer.from('sk-2', 'utf8').toString('base64'));
    writeJsonAtomic(args.markerPath, { ...marker1, state: 'failed' });
    const r2 = await stageMigration(args);
    expect(r2.ok).toBe(true);
    expect(readMarker(args.markerPath)!.handoff!.sha256).not.toBe(handoffSha1);
  });

  it('重入时在盘 payload 仍交给 downloader 重验 sha；版本不符同样重下(P1-5)', async () => {
    const args = makeArgs();
    await stageMigration(args);
    // 模拟回到可重入态(handoff_ready 不是 stage 的合法起点)
    writeJsonAtomic(args.markerPath, { ...readMarker(args.markerPath)!, state: 'failed' });
    fs.writeFileSync(args.payloadTargetPath, 'corrupted-after-stage');
    await stageMigration(args);
    expect(args.download).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(args.payloadTargetPath, 'utf8')).toBe('payload-bytes');

    // 老渠道发了 1.0.1:同一 marker 重入必须作废旧包重下；旧包预算即使耗尽，
    // 修正版也重新获得完整预算。
    writeJsonAtomic(args.markerPath, {
      ...readMarker(args.markerPath)!,
      state: 'failed',
      attempt: 5,
    });
    const args2 = {
      ...args,
      payload: { ...args.payload, version: '1.0.1', sha256: 'b'.repeat(64) },
      payloadTargetPath: migrationPayloadTargetPath(ud, 'cindy-1.0.1-Setup.exe'),
    };
    const r = await stageMigration(args2);
    expect(r.ok).toBe(true);
    expect(args.download).toHaveBeenCalledTimes(3);
    const marker = readMarker(args.markerPath)!;
    expect(marker.target.version).toBe('1.0.1');
    expect(marker.migrationId).toBe('mig-fixed'); // 一场迁移一个 id,重 stage 不换
    expect(marker.attempt).toBe(0);
    expect(fs.existsSync(args.payloadTargetPath)).toBe(false);
  });

  it('下载失败:不写 marker,静默返回等下轮', async () => {
    const args = makeArgs({ download: vi.fn(async () => { throw new Error('net down'); }) });
    const r = await stageMigration(args);
    expect(r).toMatchObject({ ok: false, step: 'download' });
    expect(readMarker(args.markerPath)).toBeNull();
  });

  it('handoff 导出失败:marker 落 failed(HANDOFF_EXPORT_FAILED)', async () => {
    const args = makeArgs({
      handoffCrypto: { ...okCrypto(), isAvailable: () => false },
    });
    const r = await stageMigration(args);
    expect(r).toMatchObject({ ok: false, step: 'handoff' });
    const marker = readMarker(args.markerPath)!;
    expect(marker.state).toBe('failed');
    expect(marker.lastError?.code).toBe('HANDOFF_EXPORT_FAILED');
  });

  it('handoff 导出后读取失败:不 reject，marker 落 failed', async () => {
    const args = makeArgs({
      handoffCrypto: okCrypto(),
      readHandoffContent: () => { throw new Error('handoff locked by AV'); },
    });
    await expect(stageMigration(args)).resolves.toMatchObject({
      ok: false,
      step: 'handoff',
      error: 'handoff locked by AV',
    });
    expect(readMarker(args.markerPath)).toMatchObject({
      state: 'failed',
      lastError: { code: 'HANDOFF_EXPORT_FAILED' },
    });
    expect(fs.existsSync(path.join(ud, HANDOFF_REL_PATH))).toBe(false);
  });

  it('handoff_ready 最终写入抛错时清理 handoff 并落 failed', async () => {
    const transitionState: NonNullable<StageMigrationArgs['transitionState']> =
      (markerPath, transitionArgs) => {
        if (transitionArgs.to === 'handoff_ready') throw new Error('state write denied');
        return transitionMarker(markerPath, transitionArgs);
      };
    const args = makeArgs({ handoffCrypto: okCrypto(), transitionState });

    await expect(stageMigration(args)).resolves.toMatchObject({
      ok: false,
      step: 'handoff',
      error: 'state write denied',
    });
    expect(readMarker(args.markerPath)).toMatchObject({
      state: 'failed',
      lastError: { code: 'HANDOFF_EXPORT_FAILED' },
    });
    expect(fs.existsSync(path.join(ud, HANDOFF_REL_PATH))).toBe(false);
  });

  it('非法起点(in-progress)被矩阵拒绝,marker 原样', async () => {
    const args = makeArgs();
    await stageMigration(args);
    const before = readMarker(args.markerPath)!;
    // handoff_ready 状态下盲调 stage → staged 转移非法(handoff_ready 不在前驱)
    // 注:staged 的合法前驱是 ∅/failed/staged/fallback_active
    const r = await stageMigration(args);
    expect(r).toMatchObject({ ok: false, step: 'stage' });
    expect(readMarker(args.markerPath)).toEqual(before);
  });
});
