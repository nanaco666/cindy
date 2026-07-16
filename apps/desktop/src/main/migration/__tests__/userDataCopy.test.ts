/**
 * Cindy 首启自拷测试(B′ §4):锚定 glob 语义、目录剪枝、preflight 磁盘余量、
 * journal 幂等(done 跳过 / copying 重拷 / reset 强制重拷)、真实排除清单
 * 端到端。全部走 os.tmpdir(规则 23),零 Electron。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COPY_MUST_KEEP_PREFIXES, USER_DATA_COPY_EXCLUDES } from '../copyExcludes';
import {
  COPY_JOURNAL_REL_PATH,
  isExcluded,
  resetCopyJournal,
  runLegacyDataCopy,
  shouldPruneDir,
  type RunDataCopyArgs,
} from '../userDataCopy';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('锚定 glob 匹配(与执行器时代 Rust 语义对齐)', () => {
  const pats = ['logs/**', 'updates/**', 'migration/state.json', 'voice-input/xdt-macos-*',
    'browser-runtime/browser/*/user-data/Cache/**'];

  it('尾部 ** 至少吞一段(目录名本身不命中)', () => {
    expect(isExcluded('updates', pats, false)).toBe(false);
    expect(isExcluded('updates/cindy-Setup.exe', pats, false)).toBe(true);
    expect(isExcluded('logs/a/b/c.log', pats, false)).toBe(true);
  });

  it('精确文件与单段 * 通配', () => {
    expect(isExcluded('migration/state.json', pats, false)).toBe(true);
    expect(isExcluded('migration/handoff.json', pats, false)).toBe(false);
    expect(isExcluded('voice-input/xdt-macos-helper', pats, false)).toBe(true);
    expect(isExcluded('voice-input/recordings/a.wav', pats, false)).toBe(false);
  });

  it('中段 * 与深嵌套 **;锚定语义不做任意深度模糊匹配', () => {
    expect(isExcluded('browser-runtime/browser/work/user-data/Cache/f_0001', pats, false)).toBe(true);
    expect(isExcluded('browser-runtime/browser/work/user-data/Local Storage/x', pats, false)).toBe(false);
    // 锚定:非根部的 logs 不被 'logs/**' 命中
    expect(isExcluded('brain/logs/x.log', pats, false)).toBe(false);
  });

  it('Windows 大小写不敏感 + 反斜杠归一', () => {
    expect(isExcluded('Updates\\Cindy-Setup.exe', pats, true)).toBe(true);
    expect(isExcluded('LOGS/a.log', pats, true)).toBe(true);
    expect(isExcluded('LOGS/a.log', pats, false)).toBe(false);
  });

  it('singleton 排除只锚定 userData 根，不误杀嵌套同名文件', () => {
    expect(isExcluded('SingletonLock', USER_DATA_COPY_EXCLUDES, false)).toBe(true);
    expect(isExcluded('SingletonCookie', USER_DATA_COPY_EXCLUDES, false)).toBe(true);
    expect(isExcluded('SingletonSocket', USER_DATA_COPY_EXCLUDES, false)).toBe(true);
    expect(isExcluded('brain/SingletonLock', USER_DATA_COPY_EXCLUDES, false)).toBe(false);
  });

  it('shouldPruneDir:仅 <dir>/** 前缀精确命中才剪枝', () => {
    expect(shouldPruneDir('logs', pats, false)).toBe(true);
    expect(shouldPruneDir('browser-runtime/browser/work/user-data/Cache', pats, false)).toBe(true);
    expect(shouldPruneDir('browser-runtime/browser/work/user-data', pats, false)).toBe(false);
    expect(shouldPruneDir('migration', pats, false)).toBe(false);
  });
});

describe('runLegacyDataCopy', () => {
  let oldUd: string;
  let newUd: string;
  beforeEach(() => {
    oldUd = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-copy-old-'));
    newUd = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-copy-new-'));
  });
  afterEach(() => {
    fs.rmSync(oldUd, { recursive: true, force: true });
    fs.rmSync(newUd, { recursive: true, force: true });
  });

  function seed(rel: string, content = 'x'): void {
    const p = path.join(oldUd, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }

  function args(overrides: Partial<RunDataCopyArgs> = {}): RunDataCopyArgs {
    return {
      legacyUserDataDir: oldUd,
      newUserDataDir: newUd,
      targetDbFilePrefix: 'cindy',
      excludes: USER_DATA_COPY_EXCLUDES,
      platform: 'win32',
      log,
      nowIso: () => '2026-07-13T00:00:00.000Z',
      ...overrides,
    };
  }

  it('端到端:必迁内容全拷、排除清单全跳、进度回调、journal=done', () => {
    // 必迁样本(每个 MUST_KEEP 前缀放一个文件)
    for (const keep of COPY_MUST_KEEP_PREFIXES) {
      seed(keep.includes('.') ? keep : `${keep}/data.bin`, `keep:${keep}`);
    }
    seed('xdt-maker-main.db', 'sqlite');
    // 排除样本
    seed('updates/cindy-Setup.exe', 'payload');
    seed('logs/app.log');
    seed('migration/state.json', '{}');
    seed('claude-code/2.1.0/claude.exe');
    seed('Cache/f_000001');
    seed('SingletonLock', 'legacy-lock');
    fs.writeFileSync(path.join(newUd, 'SingletonLock'), 'live-cindy-lock');

    const progress: number[] = [];
    const r = runLegacyDataCopy(args({
      onProgress: (p) => progress.push(p.copiedFiles),
    }));
    expect(r).toMatchObject({ ok: true, skipped: false });

    for (const keep of COPY_MUST_KEEP_PREFIXES) {
      const rel = keep.includes('.') ? keep : `${keep}/data.bin`;
      expect(fs.existsSync(path.join(newUd, rel)), rel).toBe(true);
    }
    expect(fs.existsSync(path.join(newUd, 'xdt-maker-main.db'))).toBe(true);
    expect(fs.existsSync(path.join(newUd, 'updates'))).toBe(false);
    expect(fs.existsSync(path.join(newUd, 'logs'))).toBe(false);
    expect(fs.existsSync(path.join(newUd, 'migration', 'state.json'))).toBe(false);
    expect(fs.existsSync(path.join(newUd, 'claude-code'))).toBe(false);
    expect(fs.existsSync(path.join(newUd, 'Cache'))).toBe(false);
    expect(fs.readFileSync(path.join(newUd, 'SingletonLock'), 'utf8')).toBe('live-cindy-lock');
    // 进度单调,最后一次 = 总数
    if (r.ok) expect(progress[progress.length - 1]).toBe(r.copiedFiles);
  });

  it('preflight:余量不足 → INSUFFICIENT_DISK 且不动盘;探测不到 → 放行', () => {
    seed('brain/notes.md', 'x'.repeat(1000));
    const r = runLegacyDataCopy(args({ freeBytesFor: () => 100 }));
    expect(r).toMatchObject({ ok: false, code: 'INSUFFICIENT_DISK' });
    expect(fs.existsSync(path.join(newUd, 'brain'))).toBe(false);

    const r2 = runLegacyDataCopy(args({ freeBytesFor: () => null }));
    expect(r2).toMatchObject({ ok: true });
  });

  it('journal 幂等:done 默认跳过;未确认首启/复制中断/reset 均整体重拷', () => {
    seed('brain/notes.md', 'v1');
    seed('brain/removed-before-retry.md', 'stale');
    expect(runLegacyDataCopy(args())).toMatchObject({ ok: true, skipped: false });

    // done → 跳过(源变更不感知)
    seed('brain/notes.md', 'v2');
    expect(runLegacyDataCopy(args())).toMatchObject({ ok: true, skipped: true });
    expect(fs.readFileSync(path.join(newUd, 'brain', 'notes.md'), 'utf8')).toBe('v1');

    // 首启尚未确认时不信任 done：覆盖“拷完后被强杀、用户回老 app 继续写入”的窗口。
    expect(runLegacyDataCopy(args({ trustCompletedJournal: false }))).toMatchObject({
      ok: true,
      skipped: false,
    });
    expect(fs.readFileSync(path.join(newUd, 'brain', 'notes.md'), 'utf8')).toBe('v2');

    // reset(健康检查失败退出前调用)→ 清上轮 payload 后重拷；源侧已删文件
    // 不残留，Cindy 自己新建且不在 copiedPaths 的文件不被误删。
    fs.rmSync(path.join(oldUd, 'brain', 'removed-before-retry.md'));
    const cindyOnly = path.join(newUd, 'cindy-runtime', 'own-state.json');
    fs.mkdirSync(path.dirname(cindyOnly), { recursive: true });
    fs.writeFileSync(cindyOnly, 'keep');
    resetCopyJournal(newUd);
    expect(runLegacyDataCopy(args())).toMatchObject({ ok: true, skipped: false });
    expect(fs.readFileSync(path.join(newUd, 'brain', 'notes.md'), 'utf8')).toBe('v2');
    expect(fs.existsSync(path.join(newUd, 'brain', 'removed-before-retry.md'))).toBe(false);
    expect(fs.readFileSync(cindyOnly, 'utf8')).toBe('keep');

    // 半途崩溃:journal 停在 copying → 整体重拷
    const journalPath = path.join(newUd, COPY_JOURNAL_REL_PATH);
    const j = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    fs.writeFileSync(journalPath, JSON.stringify({ ...j, state: 'copying' }));
    seed('brain/notes.md', 'v3');
    expect(runLegacyDataCopy(args())).toMatchObject({ ok: true, skipped: false });
    expect(fs.readFileSync(path.join(newUd, 'brain', 'notes.md'), 'utf8')).toBe('v3');
  });

  it('目标已有非 journal 所有的 Cindy profile 时拒绝合并且不动盘', () => {
    seed('brain/notes.md', 'legacy');
    const targetDb = path.join(newUd, 'cindy-existing-user.db');
    fs.writeFileSync(targetDb, 'cindy-profile');

    expect(runLegacyDataCopy(args())).toMatchObject({
      ok: false,
      code: 'TARGET_PROFILE_EXISTS',
    });
    expect(fs.readFileSync(targetDb, 'utf8')).toBe('cindy-profile');
    expect(fs.existsSync(path.join(newUd, 'brain', 'notes.md'))).toBe(false);
    expect(fs.existsSync(path.join(newUd, COPY_JOURNAL_REL_PATH))).toBe(false);
  });

  it('目标主库由既有 journal 所有时允许整体重拷', () => {
    seed('cindy-migrated-user.db', 'v1');
    expect(runLegacyDataCopy(args())).toMatchObject({ ok: true, skipped: false });

    seed('cindy-migrated-user.db', 'v2');
    expect(runLegacyDataCopy(args({ trustCompletedJournal: false }))).toMatchObject({
      ok: true,
      skipped: false,
    });
    expect(fs.readFileSync(path.join(newUd, 'cindy-migrated-user.db'), 'utf8')).toBe('v2');
  });

  it('复制后将明文 handoff 强制收紧为 0600', () => {
    seed('migration/handoff.json', '{"plaintextB64":"secret"}');
    const chmod = vi.spyOn(fs, 'chmodSync');

    const r = runLegacyDataCopy(args({ platform: 'darwin' }));

    expect(r).toMatchObject({ ok: true, skipped: false });
    expect(chmod).toHaveBeenCalledWith(path.join(newUd, 'migration', 'handoff.json'), 0o600);
    chmod.mockRestore();
  });

  it('journal copiedPaths 越界时 fail closed,不删除目标根外文件', () => {
    seed('brain/notes.md', 'v1');
    const outside = path.join(path.dirname(newUd), `${path.basename(newUd)}-outside.txt`);
    fs.writeFileSync(outside, 'keep');
    const journalPath = path.join(newUd, COPY_JOURNAL_REL_PATH);
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(journalPath, JSON.stringify({
      schemaVersion: 1,
      state: 'copying',
      startedAt: '2026-07-13T00:00:00.000Z',
      copiedPaths: [`../${path.basename(outside)}`],
    }));

    expect(runLegacyDataCopy(args())).toMatchObject({ ok: false, code: 'COPY_FAILED' });
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
    fs.rmSync(outside, { force: true });
  });

  it('删除旧 payload 失败前先把 done journal 降为 copying', () => {
    seed('brain/notes.md', 'v1');
    expect(runLegacyDataCopy(args())).toMatchObject({ ok: true, skipped: false });
    const copiedPath = path.join(newUd, 'brain', 'notes.md');
    fs.rmSync(copiedPath, { force: true });
    fs.mkdirSync(copiedPath);

    expect(runLegacyDataCopy(args({ trustCompletedJournal: false }))).toMatchObject({
      ok: false,
      code: 'COPY_FAILED',
    });
    const journal = JSON.parse(
      fs.readFileSync(path.join(newUd, COPY_JOURNAL_REL_PATH), 'utf8'),
    );
    expect(journal.state).toBe('copying');
  });

  it('源目录读失败 → COPY_FAILED(不抛出)', () => {
    const r = runLegacyDataCopy(args({
      legacyUserDataDir: path.join(oldUd, 'does-not-exist'),
    }));
    expect(r).toMatchObject({ ok: false, code: 'COPY_FAILED' });
  });

  it('symlink 跳过并告警,不中断拷贝', () => {
    seed('brain/notes.md');
    try {
      fs.symlinkSync(path.join(oldUd, 'brain', 'notes.md'), path.join(oldUd, 'link.md'));
    } catch {
      return; // Windows 无 symlink 权限时跳过本用例
    }
    const r = runLegacyDataCopy(args());
    expect(r).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(newUd, 'link.md'))).toBe(false);
  });
});
