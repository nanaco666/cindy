/**
 * hook-control/outbound 单测: xdt 引用收集/去重/限额与正文变换。
 * IO 全注入(readFile / resolveImageUrl), 不碰真盘。
 */

import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { collectOutboundAttachments, hasOutboundRefs, guessMime, xdtFileUrlToAbsPath } from '../outbound';

const log = { warn: vi.fn() };

beforeEach(() => {
  log.warn.mockClear();
});

function deps(
  files: Record<string, Buffer>,
  opts: {
    allowedFileRoots?: string[];
    realpaths?: Record<string, string>;
  } = {},
) {
  return {
    resolveImageUrl: (url: string) => ({ absPath: url.replace('xdt-image://', '/cache/') }),
    allowedFileRoots: opts.allowedFileRoots,
    realpath: vi.fn(async (absPath: string) => opts.realpaths?.[path.resolve(absPath)] ?? path.resolve(absPath)),
    readFile: vi.fn(async (absPath: string) => {
      const buf = files[absPath];
      if (!buf) throw new Error(`ENOENT: ${absPath}`);
      return buf;
    }),
    log,
  };
}

describe('collectOutboundAttachments', () => {
  it('图片引用 + 旁路图去重收集, 正文替换成提示; 文件链接剥离', async () => {
    const text = '成果:\n![效果图](xdt-image://img1.png)\n详见 [报告](xdt-file:///out/report.md) 收工';
    const r = await collectOutboundAttachments(text, ['/cache/img1.png', '/cache/extra.png'], deps({
      '/cache/img1.png': Buffer.from('png1'),
      '/cache/extra.png': Buffer.from('png2'),
      '/out/report.md': Buffer.from('# 报告'),
    }, { allowedFileRoots: ['/out'] }));
    expect(r.attachments.map((a) => a.name)).toEqual(['img1.png', 'extra.png', 'report.md']);
    expect(r.attachments[0].mimeType).toBe('image/png');
    expect(r.attachments[2].mimeType).toBe('application/octet-stream');
    expect(r.text).toContain('🖼️ _效果图(已作为附件发送)_');
    expect(r.text).not.toContain('xdt-image://');
    expect(r.text).not.toContain('xdt-file://');
    expect(r.skipped).toBe(0);
  });

  it('读盘失败 / 解析失败只跳过并计数, 不抛错', async () => {
    const text = '![a](xdt-image://gone.png) [b](xdt-file:///tmp/missing.bin)';
    const r = await collectOutboundAttachments(text, [], {
      resolveImageUrl: () => {
        throw new Error('not found');
      },
      allowedFileRoots: ['/tmp'],
      realpath: async (absPath: string) => path.resolve(absPath),
      readFile: async () => {
        throw new Error('ENOENT');
      },
      log,
    });
    expect(r.attachments).toHaveLength(0);
    expect(r.skipped).toBe(2);
    // 正文变换照常发生(引用不能留在回帖里)
    expect(r.text).not.toContain('xdt-file://');
  });

  it('同一路径重复引用只收一份', async () => {
    const text = '![x](xdt-image://same.png) 再看一遍 ![x](xdt-image://same.png)';
    const r = await collectOutboundAttachments(text, ['/cache/same.png'], deps({
      '/cache/same.png': Buffer.from('bytes'),
    }));
    expect(r.attachments).toHaveLength(1);
  });

  it('不读取 allowedFileRoots 之外的 xdt-file 本地路径', async () => {
    const d = deps({
      '/repo/report.md': Buffer.from('ok'),
      '/Users/me/.ssh/id_rsa': Buffer.from('secret'),
    }, { allowedFileRoots: ['/repo'] });

    const r = await collectOutboundAttachments(
      '[报告](xdt-file:///repo/report.md) [secret](xdt-file:///Users/me/.ssh/id_rsa)',
      [],
      d,
    );

    expect(r.attachments.map((a) => a.name)).toEqual(['report.md']);
    expect(d.readFile).toHaveBeenCalledWith('/repo/report.md');
    expect(d.readFile).not.toHaveBeenCalledWith('/Users/me/.ssh/id_rsa');
    expect(r.skipped).toBe(1);
    expect(r.text).not.toContain('xdt-file://');
  });

  it('未提供 allowedFileRoots 时 fail-closed, 不读取 xdt-file', async () => {
    const d = deps({ '/repo/report.md': Buffer.from('ok') });

    const r = await collectOutboundAttachments('[报告](xdt-file:///repo/report.md)', [], d);

    expect(r.attachments).toHaveLength(0);
    expect(d.readFile).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
  });

  it('拒绝 realpath 指向 workspace 外的 symlink 路径', async () => {
    const d = deps({
      '/repo/link-to-secret': Buffer.from('secret'),
    }, {
      allowedFileRoots: ['/repo'],
      realpaths: {
        [path.resolve('/repo')]: path.resolve('/repo'),
        [path.resolve('/repo/link-to-secret')]: path.resolve('/Users/me/.ssh/id_rsa'),
      },
    });

    const r = await collectOutboundAttachments('[secret](xdt-file:///repo/link-to-secret)', [], d);

    expect(r.attachments).toHaveLength(0);
    expect(d.readFile).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
  });

  it('多 allowed roots 时单个 root realpath 失败仍继续检查后续 root', async () => {
    const d = deps({
      '/repo/sub/report.md': Buffer.from('ok'),
    }, {
      allowedFileRoots: ['/repo', '/repo/sub'],
    });
    d.realpath.mockImplementation(async (absPath: string) => {
      if (path.resolve(absPath) === path.resolve('/repo')) throw new Error('ENOENT');
      return path.resolve(absPath);
    });

    const r = await collectOutboundAttachments('[报告](xdt-file:///repo/sub/report.md)', [], d);

    expect(r.attachments.map((a) => a.name)).toEqual(['report.md']);
    expect(d.readFile).toHaveBeenCalledWith('/repo/sub/report.md');
    expect(r.skipped).toBe(0);
  });
});

describe('辅助函数', () => {
  it('xdtFileUrlToAbsPath: Windows 盘符路径剥掉多余前导斜杠(2026-07-16 实踩:附件被判目录外静默丢弃)', () => {
    expect(xdtFileUrlToAbsPath('xdt-file:///C:\\Users\\x\\wd\\hello.txt')).toBe('C:\\Users\\x\\wd\\hello.txt');
    expect(xdtFileUrlToAbsPath('xdt-file:///C:/Users/x/wd/hello.txt')).toBe('C:/Users/x/wd/hello.txt');
    // Unix 绝对路径不受影响(前导 / 就是根)
    expect(xdtFileUrlToAbsPath('xdt-file:///home/u/f.txt')).toBe('/home/u/f.txt');
    // URL 编码照常解
    expect(xdtFileUrlToAbsPath('xdt-file:///C:/Users/x/%E6%8A%A5%E5%91%8A.md')).toBe('C:/Users/x/报告.md');
    // decode 失败(孤立 %)回落 raw 后仍剥盘符前导斜杠
    expect(xdtFileUrlToAbsPath('xdt-file:///C:\\dir\\a 50%.txt')).toBe('C:\\dir\\a 50%.txt');
  });

  it('hasOutboundRefs / guessMime', () => {
    expect(hasOutboundRefs('纯文本')).toBe(false);
    expect(hasOutboundRefs('![a](xdt-image://x)')).toBe(true);
    expect(hasOutboundRefs('[a](xdt-file:///x)')).toBe(true);
    expect(guessMime('/a/b.PNG')).toBe('image/png');
    expect(guessMime('/a/b.tar.gz')).toBe('application/octet-stream');
  });
});
