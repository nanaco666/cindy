/**
 * forge.test.ts — 意识锻造打包(packGhostDir)单测。
 * 纯 Node 直测(规则 14):tmpdir 造源码目录 → 打包 → 用 GhostManager
 * 的 inspect 反向验证产物能被装入侧认可(两侧同一契约不漂移)。
 * 规则 23:全部路径在 os.tmpdir 下,收尾清理。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { packGhostDir, FORGE_GUIDE } from '../forge';
import { GhostManager } from '../GhostManager';

let workDir: string;

beforeEach(async () => {
  workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-forge-test-'));
});

afterEach(async () => {
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

const GOOD_MANIFEST = {
  schemaVersion: 2,
  id: 'demo',
  name: '演示意识',
  version: '1.0.0',
  kind: 'chip',
  entry: 'main.js',
  slots: ['tool'],
  tools: [{ name: 'do_thing', description: '做点事' }],
};

/** 造一个源码目录;files 为相对路径 → 内容。 */
async function makeSrcDir(files: Record<string, string>): Promise<string> {
  const dir = path.join(workDir, 'src');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content);
  }
  return dir;
}

describe('packGhostDir', () => {
  it('happy path:产物落源码目录(id-version.cindy),且能被装入侧 inspect 认可', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(GOOD_MANIFEST),
      'main.js': '// brain',
      'assets/readme.txt': 'hi',
    });
    const r = await packGhostDir(dir);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.cindyPath).toBe(path.join(dir, 'demo-1.0.0.cindy'));
    expect(r.manifest.id).toBe('demo');

    // 装入侧同一契约验证:inspect 直接吃打包产物。
    const manager = new GhostManager({ getRootDir: () => path.join(workDir, 'ghosts') });
    const inspected = await manager.inspect(r.cindyPath);
    expect('manifest' in inspected, JSON.stringify(inspected)).toBe(true);

    await fs.promises.rm(r.cindyPath, { force: true });
  });

  it('打包跳过开发残留:.git / node_modules / 隐藏文件 / 旧 .cindy 不进包', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(GOOD_MANIFEST),
      'main.js': '// brain',
      '.git/HEAD': 'ref',
      '.DS_Store': 'junk',
      'node_modules/x/package.json': '{}',
      'old.cindy': 'stale zip',
    });
    const r = await packGhostDir(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await fs.promises.readFile(r.cindyPath));
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    expect(names.sort()).toEqual(['ghost.json', 'main.js']);
    await fs.promises.rm(r.cindyPath, { force: true });
  });

  it('目录不存在 / 清单坏 / 声明的入口文件缺失 → 结构化拒绝', async () => {
    expect((await packGhostDir(path.join(workDir, 'nope'))).ok).toBe(false);

    const badManifest = await makeSrcDir({ 'ghost.json': '{not json' });
    const r1 = await packGhostDir(badManifest);
    expect(r1).toMatchObject({ ok: false, errorCode: 'MANIFEST_INVALID' });

    const missingEntry = path.join(workDir, 'src2');
    await fs.promises.mkdir(missingEntry, { recursive: true });
    await fs.promises.writeFile(path.join(missingEntry, 'ghost.json'), JSON.stringify(GOOD_MANIFEST));
    const r2 = await packGhostDir(missingEntry); // entry: main.js 没写
    expect(r2).toMatchObject({ ok: false, errorCode: 'ENTRY_MISSING' });
  });

  it('形态收敛:老声明型清单(v1 / kind: declaration)打包被拒', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify({
        schemaVersion: 1,
        id: 'legacy',
        name: '老声明型',
        version: '1.0.0',
        kind: 'declaration',
        panel: { title: '静态面板', body: '一段文字' },
      }),
    });
    const r = await packGhostDir(dir);
    expect(r).toMatchObject({ ok: false, errorCode: 'MANIFEST_INVALID' });

    // kind 单独非法(schemaVersion 已是 2)同样被拒,错误话术点名 chip。
    const dir2 = await makeSrcDir({
      'ghost.json': JSON.stringify({ ...GOOD_MANIFEST, kind: 'declaration' }),
      'main.js': '// brain',
    });
    const r2 = await packGhostDir(dir2);
    expect(r2).toMatchObject({ ok: false, errorCode: 'MANIFEST_INVALID' });
    if (r2.ok) return;
    expect(r2.message).toContain('chip');
  });
});

describe('FORGE_GUIDE', () => {
  it('手册覆盖关键章节(身份卡/工具面/管子/聊天卡片/订阅拦截/网络代发/系统提示/沙箱红线/打包)', () => {
    for (const marker of [
      'ghost.json',
      '两段式',
      'call_tool',
      'tool-result',
      'cindy-request',
      'card-update',
      "type: 'notify'",
      'notify 槽',
      'will-user-message',
      'will-assistant-message',
      'event-verdict',
      'data-ghost-action',
      'data-ghost-prompt',
      'card-action',
      'spawnCallId',
      // 媒体回锚(2026-07-14):常驻过程卡模式下轮询结果把媒体挂回提交卡下方。
      'xdt_anchor_card_id',
      // 音频播放器卡(2026-07-14):交卷字段 xdt_audio_tracks 渲染音频卡。
      'xdt_audio_tracks',
      // 卡内音频播放器(2026-07-14):data-ghost-audio 插槽 + 防重令牌。
      'data-ghost-audio',
      'xdt_audio_in_card',
      'cindy.fetch',
      'network 槽',
      '媒体上传',
      '凭证明文永不进沙箱',
      '/secrets',
      // 收单契约(2026-07-13 宿主凭证渲染退役):user 凭证一律 settingsHtml 收单。
      '一次性交给主机保险库',
      '尾 4 位',
      'exchange',
      'tokenPath',
      'login-email',
      // 飞书登录态令牌(2026-07-16,lizi_feishu 意识化前置):主机现取注入。
      'login-feishu-token',
      // 多连接(connections,2026-07-14):声明形态 / 设置页协议 / 主机受信确认。
      'connections',
      '/connections',
      'maxConnections',
      '受信确认',
      'CONFIRM_DENIED',
      'uploadDir',
      'dir_deposit',
      // fs 槽(2026-07-14):三档代写(私有目录/工作目录/save 票据)。
      'fs-request',
      "root: 'data'",
      "root: 'workdir'",
      "root: 'save'",
      'save_deposit.token',
      '沙箱红线',
      'ghost_forge_pack',
      '/preview/',
      'settingsHtml',
      'settingsHeight',
      "fetch('/kv')",
    ]) {
      expect(FORGE_GUIDE).toContain(marker);
    }
  });
});
