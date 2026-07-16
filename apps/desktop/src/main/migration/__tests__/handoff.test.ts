/**
 * handoff 交接模块测试:导出枚举/解密失败跳过、导入重加密/漂移告警/失败中断、
 * 三兜底删除规则。假 crypto 注入,零 Electron;全部 os.tmpdir(规则 23)。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HANDOFF_MAX_AGE_MS,
  HANDOFF_REL_PATH,
  deleteHandoff,
  deleteHandoffIfStale,
  exportHandoff,
  importHandoff,
  readHandoff,
  type HandoffCrypto,
} from '../handoff';

/** 假加密后端:old 侧 = `old(<明文>)` 的 base64,new 侧 = `new(<明文>)` 的 base64。 */
function fakeCrypto(tag: string, opts?: { failOn?: string[] }): HandoffCrypto {
  return {
    isAvailable: () => true,
    decryptFromBase64(encB64) {
      const raw = Buffer.from(encB64, 'base64').toString('utf8');
      const m = /^\w+\((.*)\)$/s.exec(raw);
      if (!m) throw new Error('cannot decrypt');
      return m[1];
    },
    encryptToBase64(plaintext) {
      if (opts?.failOn?.includes(plaintext)) throw new Error('encrypt boom');
      return Buffer.from(`${tag}(${plaintext})`, 'utf8').toString('base64');
    },
  };
}

function writeEnc(userDataDir: string, store: string, plaintext: string, tag = 'old'): string {
  const dir = path.join(userDataDir, 'safe-storage');
  fs.mkdirSync(dir, { recursive: true });
  const content = Buffer.from(`${tag}(${plaintext})`, 'utf8').toString('base64');
  fs.writeFileSync(path.join(dir, `${store}.enc`), content, 'utf-8');
  return content;
}

let oldUd: string;
let newUd: string;
beforeEach(() => {
  oldUd = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-handoff-old-'));
  newUd = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-handoff-new-'));
});
afterEach(() => {
  fs.rmSync(oldUd, { recursive: true, force: true });
  fs.rmSync(newUd, { recursive: true, force: true });
});

function doExport(crypto = fakeCrypto('old')) {
  return exportHandoff({
    userDataDir: oldUd,
    crypto,
    sourceApp: 'xdt-maker',
    sourceVersion: '0.0.130',
    platform: 'darwin',
    nowIso: '2026-07-09T00:00:00.000Z',
  });
}

describe('exportHandoff', () => {
  it('动态枚举全部 .enc,解密导出,条目按键名排序', () => {
    writeEnc(oldUd, 'github_token', 'ghp_secret');
    writeEnc(oldUd, 'api_key', 'sk-123');
    const r = doExport();
    expect(r.ok).toBe(true);
    expect(r.entryCount).toBe(2);
    const handoff = readHandoff(r.handoffPath)!;
    expect(handoff.entries.map((e) => e.store)).toEqual(['api_key', 'github_token']);
    expect(Buffer.from(handoff.entries[0].plaintextB64, 'base64').toString('utf8')).toBe('sk-123');
    expect(handoff.entries[0].relPath).toBe('safe-storage/api_key.enc');
  });

  it('safe-storage 目录不存在 → 合法空导出;解不开的键跳过并登记', () => {
    expect(doExport()).toMatchObject({ ok: true, entryCount: 0, skippedStores: [] });

    writeEnc(oldUd, 'good_key', 'v');
    fs.writeFileSync(path.join(oldUd, 'safe-storage', 'broken.enc'), Buffer.from('garbage').toString('base64'));
    const r = doExport();
    expect(r.entryCount).toBe(1);
    expect(r.skippedStores).toEqual(['broken']);
  });

  it('safeStorage 不可用 → 失败不落盘', () => {
    const crypto = { ...fakeCrypto('old'), isAvailable: () => false };
    const r = doExport(crypto);
    expect(r.ok).toBe(false);
    expect(fs.existsSync(r.handoffPath)).toBe(false);
  });

  it('fails export when safe-storage enumeration returns an I/O error', () => {
    const readdir = vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    try {
      const r = doExport();
      expect(r).toMatchObject({
        ok: false,
        entryCount: 0,
        skippedStores: [],
        error: 'permission denied',
      });
      expect(fs.existsSync(r.handoffPath)).toBe(false);
    } finally {
      readdir.mockRestore();
    }
  });

  it('每次导出无条件覆盖旧交接文件(P1-3:不复用陈旧明文)', () => {
    writeEnc(oldUd, 'api_key', 'old-value');
    doExport();
    writeEnc(oldUd, 'api_key', 'new-value');
    doExport();
    const handoff = readHandoff(path.join(oldUd, HANDOFF_REL_PATH))!;
    expect(Buffer.from(handoff.entries[0].plaintextB64, 'base64').toString('utf8')).toBe('new-value');
  });
});

describe('importHandoff', () => {
  function stageNewSide(): void {
    // 模拟执行器把 userData(含交接文件与 .enc)整体拷到新侧。
    fs.cpSync(oldUd, newUd, { recursive: true, force: true });
  }

  it('重加密写回全部条目,新侧可用新 crypto 读出,成功后删新侧交接文件', () => {
    writeEnc(oldUd, 'api_key', 'sk-123');
    writeEnc(oldUd, 'jira_refresh_token', 'jrt');
    doExport();
    stageNewSide();

    const newCrypto = fakeCrypto('new');
    const r = importHandoff({ newUserDataDir: newUd, crypto: newCrypto });
    expect(r).toMatchObject({ ok: true, importedCount: 2, driftWarnings: [] });

    const reEncrypted = fs.readFileSync(path.join(newUd, 'safe-storage', 'api_key.enc'), 'utf8');
    expect(newCrypto.decryptFromBase64(reEncrypted)).toBe('sk-123');
    expect(fs.existsSync(path.join(newUd, HANDOFF_REL_PATH))).toBe(false);
  });

  it('新侧 .enc 与导出时哈希不一致 → 以 handoff 为准导入 + drift 告警(§6)', () => {
    writeEnc(oldUd, 'api_key', 'sk-123');
    doExport();
    stageNewSide();
    // 导出后老 app 又改过数据(窗口极小但存在)——拷过来的文件与 handoff 哈希不符。
    writeEnc(newUd, 'api_key', 'sk-456');

    const newCrypto = fakeCrypto('new');
    const r = importHandoff({ newUserDataDir: newUd, crypto: newCrypto });
    expect(r.ok).toBe(true);
    expect(r.driftWarnings).toEqual(['api_key']);
    const reEncrypted = fs.readFileSync(path.join(newUd, 'safe-storage', 'api_key.enc'), 'utf8');
    expect(newCrypto.decryptFromBase64(reEncrypted)).toBe('sk-123'); // handoff 为准
  });

  it('任一条目重加密失败 → 整体失败且不删交接文件(健康检查走 failed 路径重试)', () => {
    writeEnc(oldUd, 'a_key', 'ok-value');
    writeEnc(oldUd, 'b_key', 'boom-value');
    doExport();
    stageNewSide();

    const r = importHandoff({
      newUserDataDir: newUd,
      crypto: fakeCrypto('new', { failOn: ['boom-value'] }),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('b_key');
    expect(fs.existsSync(path.join(newUd, HANDOFF_REL_PATH))).toBe(true);
  });

  it('越界 relPath 被跳过并告警，不向 userData 外写凭证', () => {
    writeEnc(oldUd, 'api_key', 'sk-123');
    const exported = doExport();
    const handoff = readHandoff(exported.handoffPath)!;
    handoff.entries.unshift({
      ...handoff.entries[0],
      store: 'escape',
      relPath: '../escaped.enc',
    });
    fs.writeFileSync(exported.handoffPath, JSON.stringify(handoff));
    stageNewSide();

    const outside = path.join(path.dirname(newUd), 'escaped.enc');
    fs.rmSync(outside, { force: true });
    const r = importHandoff({ newUserDataDir: newUd, crypto: fakeCrypto('new') });
    expect(r).toMatchObject({ ok: true, importedCount: 1, pathWarnings: ['escape'] });
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('交接文件缺失/损坏 → 明确失败', () => {
    expect(importHandoff({ newUserDataDir: newUd, crypto: fakeCrypto('new') }).ok).toBe(false);
  });
});

describe('deleteHandoffIfStale(老 app 启动兜底,§6 规则 3)', () => {
  const NOW = Date.parse('2026-07-09T00:00:00.000Z');

  it('长驻态(failed/fallback_active/confirmed/无 marker)→ 删', () => {
    for (const state of ['failed', 'fallback_active', 'confirmed', null] as const) {
      writeEnc(oldUd, 'k', 'v');
      doExport();
      expect(deleteHandoffIfStale({ userDataDir: oldUd, markerState: state, nowMs: NOW + 1000 })).toBe(true);
      expect(fs.existsSync(path.join(oldUd, HANDOFF_REL_PATH))).toBe(false);
    }
  });

  it('in-progress 且未超期 → 保留;超期(7 天)→ 删', () => {
    writeEnc(oldUd, 'k', 'v');
    doExport(); // createdAt = 2026-07-09T00:00:00Z
    expect(deleteHandoffIfStale({ userDataDir: oldUd, markerState: 'installed', nowMs: NOW + 60_000 })).toBe(false);
    expect(fs.existsSync(path.join(oldUd, HANDOFF_REL_PATH))).toBe(true);
    expect(deleteHandoffIfStale({
      userDataDir: oldUd, markerState: 'installed', nowMs: NOW + HANDOFF_MAX_AGE_MS + 1,
    })).toBe(true);
  });

  it('无交接文件 → no-op', () => {
    expect(deleteHandoffIfStale({ userDataDir: oldUd, markerState: 'failed', nowMs: NOW })).toBe(false);
  });

  it('损坏 final 在长驻态或超过 TTL 时删除，进行中的新鲜文件保留', () => {
    const handoffPath = path.join(oldUd, HANDOFF_REL_PATH);
    fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
    fs.writeFileSync(handoffPath, '{"plaintextB64":"secret"');
    expect(deleteHandoffIfStale({
      userDataDir: oldUd,
      markerState: 'handoff_ready',
      nowMs: Date.now(),
    })).toBe(false);
    expect(fs.existsSync(handoffPath)).toBe(true);

    expect(deleteHandoffIfStale({
      userDataDir: oldUd,
      markerState: 'failed',
      nowMs: Date.now(),
    })).toBe(true);
    expect(fs.existsSync(handoffPath)).toBe(false);

    fs.writeFileSync(handoffPath, '{"plaintextB64":"secret"');
    fs.utimesSync(handoffPath, new Date(NOW), new Date(NOW));
    expect(deleteHandoffIfStale({
      userDataDir: oldUd,
      markerState: 'handoff_ready',
      nowMs: NOW + HANDOFF_MAX_AGE_MS + 1,
    })).toBe(true);
  });

  it('原子写被强杀遗留的临时明文无论 marker 状态都立即清理', () => {
    const migrationDir = path.join(oldUd, 'migration');
    fs.mkdirSync(migrationDir, { recursive: true });
    const tempPath = path.join(migrationDir, '.handoff.json.tmp-123-456');
    fs.writeFileSync(tempPath, 'plaintext-secret');

    expect(deleteHandoffIfStale({
      userDataDir: oldUd,
      markerState: 'handoff_ready',
      nowMs: NOW,
    })).toBe(true);
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  it('常规 deleteHandoff 同时扫掉 final 与同目录临时明文', () => {
    writeEnc(oldUd, 'k', 'v');
    const exported = doExport();
    const tempPath = path.join(path.dirname(exported.handoffPath), '.handoff.json.tmp-789-012');
    fs.writeFileSync(tempPath, 'plaintext-secret');

    deleteHandoff(exported.handoffPath);
    expect(fs.existsSync(exported.handoffPath)).toBe(false);
    expect(fs.existsSync(tempPath)).toBe(false);
  });
});
