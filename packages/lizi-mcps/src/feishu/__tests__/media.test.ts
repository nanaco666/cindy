/**
 * media.test.ts
 * ---------------------------------------------------------------------------
 * Locks in the contract for the local media cache:
 *   - file_token validation (rejects path-traversal / control chars)
 *   - cache miss → calls the fetcher exactly once + writes original + meta
 *   - cache hit → does NOT call the fetcher
 *   - in-flight dedup → concurrent calls share the same fetch
 *   - non-image MIMEs do not produce inline base64
 *   - large image → calls compressImage callback, stores preview, picks preview URL
 *
 * Migrated from apps/desktop/src/main/__tests__/feishuMediaStore.test.ts after
 * the store was extracted into lizi-mcps. The Electron `nativeImage` mock is
 * replaced by a plain `compressImage` callback (the whole point of the
 * extraction).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import {
  createFeishuMediaStore,
  type CompressImageFn,
  type FeishuMediaFacade,
} from '../index.js';
import type { FeishuMediaVault } from '../types.js';

let rootDir: string;
let store: FeishuMediaFacade;
let compressImage: CompressImageFn;

function makeStore(opts: { compressImage?: CompressImageFn } = {}): FeishuMediaFacade {
  return createFeishuMediaStore({
    rootDir,
    compressImage: opts.compressImage,
    createXdtImageUrl: (token, kind, ext) => {
      const safeExt = ext.startsWith('.') ? ext : `.${ext}`;
      const filename =
        kind === 'image-preview' ? `${token}.preview${safeExt}` : `${token}${safeExt}`;
      const host = kind === 'file' ? 'feishu-media-files' : 'feishu-media-images';
      return `xdt-image://${host}/${filename}`;
    },
  });
}

beforeEach(async () => {
  rootDir = path.join(os.tmpdir(), `feishu-media-test-${randomUUID()}`);
  await fs.rm(rootDir, { recursive: true, force: true });
  // Default compressor: anything > 1MB triggers a fake JPEG preview, smaller stays inline.
  compressImage = vi.fn((buffer, _mime, _opts) => {
    if (buffer.byteLength <= 1024 * 1024) return null;
    return { buffer: Buffer.from('FAKE-JPEG-PREVIEW'), mime: 'image/jpeg', ext: '.jpg' };
  });
  store = makeStore({ compressImage });
});

describe('createFeishuMediaStore', () => {
  it('rejects file_tokens with path-traversal characters', async () => {
    const fetcher = vi.fn();
    await expect(store.getOrDownload('../etc/passwd', fetcher)).rejects.toThrow(/may only contain/);
    await expect(store.getOrDownload('a/b', fetcher)).rejects.toThrow(/may only contain/);
    await expect(store.getOrDownload('a\\b', fetcher)).rejects.toThrow(/may only contain/);
    await expect(store.getOrDownload('', fetcher)).rejects.toThrow(/non-empty/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cache miss → fetches once, writes original + meta, returns inline base64 for small image', async () => {
    const buf = Buffer.from('PNG-FAKE-BYTES');
    const fetcher = vi.fn(async () => ({ buffer: buf, mimeType: 'image/png' }));

    const result = await store.getOrDownload('tokABC123', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.fromCache).toBe(false);
    expect(result.isImage).toBe(true);
    expect(result.mimeType).toBe('image/png');
    expect(result.originalBytes).toBe(buf.byteLength);
    expect(result.inline?.base64).toBe(buf.toString('base64'));
    expect(result.preview).toBeUndefined();
    expect(result.xdtImageUrl).toBe('xdt-image://feishu-media-images/tokABC123.png');

    const onDisk = await fs.readFile(result.originalPath);
    expect(onDisk.equals(buf)).toBe(true);
    const metaPath = path.join(store.getRoot(), 'images', 'tokABC123.meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
    expect(meta.mime).toBe('image/png');
    expect(meta.hasPreview).toBe(false);
  });

  it('cache hit → does NOT call the fetcher and returns fromCache=true', async () => {
    const buf = Buffer.from('CACHED-BYTES');
    const fetcher1 = vi.fn(async () => ({ buffer: buf, mimeType: 'image/png' }));
    await store.getOrDownload('tokCache', fetcher1);

    const fetcher2 = vi.fn();
    const result = await store.getOrDownload('tokCache', fetcher2);
    expect(fetcher2).not.toHaveBeenCalled();
    expect(result.fromCache).toBe(true);
    expect(result.inline?.base64).toBe(buf.toString('base64'));
  });

  it('large image → calls compressImage callback, stores preview, original kept on disk', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 0xff);
    const fetcher = vi.fn(async () => ({ buffer: big, mimeType: 'image/jpeg' }));

    const result = await store.getOrDownload('tokBig', fetcher);
    expect(compressImage).toHaveBeenCalledTimes(1);
    expect(result.preview).toBeDefined();
    expect(result.preview!.mimeType).toBe('image/jpeg');
    expect(result.preview!.base64).toBe(Buffer.from('FAKE-JPEG-PREVIEW').toString('base64'));
    const orig = await fs.readFile(result.originalPath);
    expect(orig.byteLength).toBe(big.byteLength);
    expect(result.inline).toBeUndefined();
    expect(result.xdtImageUrl).toBe('xdt-image://feishu-media-images/tokBig.preview.jpg');
  });

  it('non-image MIME → only path returned, no inline/preview, no xdtImageUrl', async () => {
    const buf = Buffer.from('PDF-FAKE');
    const fetcher = vi.fn(async () => ({ buffer: buf, mimeType: 'application/pdf' }));

    const result = await store.getOrDownload('tokPdf', fetcher);
    expect(result.isImage).toBe(false);
    expect(result.inline).toBeUndefined();
    expect(result.preview).toBeUndefined();
    expect(result.xdtImageUrl).toBeUndefined();
    expect(result.originalPath.endsWith('.pdf')).toBe(true);
    expect(result.originalPath.includes(path.join('files'))).toBe(true);
  });

  it('without a compressImage callback, oversized images stay inline as original bytes', async () => {
    const noCompressStore = makeStore({ compressImage: undefined });
    const big = Buffer.alloc(2 * 1024 * 1024, 0xfe);
    const fetcher = vi.fn(async () => ({ buffer: big, mimeType: 'image/png' }));

    const result = await noCompressStore.getOrDownload('tokNoComp', fetcher);
    expect(result.preview).toBeUndefined();
    expect(result.inline?.base64).toBe(big.toString('base64'));
    expect(result.xdtImageUrl).toBe('xdt-image://feishu-media-images/tokNoComp.png');
  });

  describe('mediaVault(host 媒体总仓,迁移第 3b 步)', () => {
    let vaultDir: string;
    let putCalls: Array<{ token: string; variant: string; mimeType: string }>;
    let vault: FeishuMediaVault;

    function makeVault(): FeishuMediaVault {
      let seq = 0;
      const byUrl = new Map<string, string>();
      return {
        put: async ({ token, variant, buffer, mimeType }) => {
          putCalls.push({ token, variant, mimeType });
          seq += 1;
          const absPath = path.join(vaultDir, `blob-${seq}`);
          await fs.writeFile(absPath, buffer);
          const url = `cindy-media://blobs/${'0'.repeat(63)}${seq}.png`;
          byUrl.set(url, absPath);
          return { absPath, url };
        },
        resolveUrl: (url) => byUrl.get(url) ?? null,
      };
    }

    function makeVaultStore(): FeishuMediaFacade {
      return createFeishuMediaStore({
        rootDir,
        compressImage,
        mediaVault: vault,
        createXdtImageUrl: (token, kind, ext) => {
          const safeExt = ext.startsWith('.') ? ext : `.${ext}`;
          const filename =
            kind === 'image-preview' ? `${token}.preview${safeExt}` : `${token}${safeExt}`;
          const host = kind === 'file' ? 'feishu-media-files' : 'feishu-media-images';
          return `xdt-image://${host}/${filename}`;
        },
      });
    }

    beforeEach(async () => {
      vaultDir = path.join(rootDir, 'vault');
      await fs.mkdir(vaultDir, { recursive: true });
      putCalls = [];
      vault = makeVault();
    });

    it('小图入仓:原图进 vault,rootDir 只留 meta,URL=vault 地址;命中回放不重下', async () => {
      const vstore = makeVaultStore();
      const buf = Buffer.from('PNG-VAULT-BYTES');
      const fetcher = vi.fn(async () => ({ buffer: buf, mimeType: 'image/png' }));

      const r = await vstore.getOrDownload('tokVault1', fetcher);
      expect(putCalls).toEqual([{ token: 'tokVault1', variant: 'original', mimeType: 'image/png' }]);
      expect(r.xdtImageUrl).toMatch(/^cindy-media:\/\/blobs\//);
      expect(r.inline?.base64).toBe(buf.toString('base64'));
      // rootDir/images 只有 meta,没有图片字节
      const imagesEntries = await fs.readdir(path.join(rootDir, 'images'));
      expect(imagesEntries).toEqual(['tokVault1.meta.json']);
      const meta = JSON.parse(
        await fs.readFile(path.join(rootDir, 'images', 'tokVault1.meta.json'), 'utf-8'),
      );
      expect(meta.vaultUrl).toBe(r.xdtImageUrl);

      const fetcher2 = vi.fn();
      const hit = await vstore.getOrDownload('tokVault1', fetcher2);
      expect(fetcher2).not.toHaveBeenCalled();
      expect(hit.fromCache).toBe(true);
      expect(hit.originalPath).toBe(r.originalPath);
    });

    it('大图:原图 + preview 各入仓一次,URL=preview vault 地址', async () => {
      const vstore = makeVaultStore();
      const big = Buffer.alloc(2 * 1024 * 1024, 0xaa);
      const fetcher = vi.fn(async () => ({ buffer: big, mimeType: 'image/jpeg' }));

      const r = await vstore.getOrDownload('tokVaultBig', fetcher);
      expect(putCalls.map((c) => c.variant)).toEqual(['original', 'preview']);
      expect(r.preview?.base64).toBe(Buffer.from('FAKE-JPEG-PREVIEW').toString('base64'));
      const meta = JSON.parse(
        await fs.readFile(path.join(rootDir, 'images', 'tokVaultBig.meta.json'), 'utf-8'),
      );
      expect(r.xdtImageUrl).toBe(meta.previewVaultUrl);
    });

    it('vault 文件被逐出(未来 LRU):命中回放失败 → 清 meta 重下自愈,不硬抛', async () => {
      const vstore = makeVaultStore();
      const buf = Buffer.from('EVICT-ME');
      const fetcher1 = vi.fn(async () => ({ buffer: buf, mimeType: 'image/png' }));
      const first = await vstore.getOrDownload('tokEvict', fetcher1);
      await fs.rm(first.originalPath, { force: true }); // 模拟回收器逐出

      const fetcher2 = vi.fn(async () => ({ buffer: buf, mimeType: 'image/png' }));
      const again = await vstore.getOrDownload('tokEvict', fetcher2);
      expect(fetcher2).toHaveBeenCalledTimes(1); // 重下了
      expect(again.fromCache).toBe(false);
      expect(again.xdtImageUrl).toMatch(/^cindy-media:\/\//);
    });

    it('preview 被逐出(原图仍在):同样清 meta 重下自愈', async () => {
      const vstore = makeVaultStore();
      const big = Buffer.alloc(2 * 1024 * 1024, 0xbb);
      const fetcher1 = vi.fn(async () => ({ buffer: big, mimeType: 'image/jpeg' }));
      const first = await vstore.getOrDownload('tokPrevEvict', fetcher1);
      await fs.rm(first.preview!.path, { force: true }); // 只逐出 preview

      const fetcher2 = vi.fn(async () => ({ buffer: big, mimeType: 'image/jpeg' }));
      const again = await vstore.getOrDownload('tokPrevEvict', fetcher2);
      expect(fetcher2).toHaveBeenCalledTimes(1);
      expect(again.preview?.base64).toBe(Buffer.from('FAKE-JPEG-PREVIEW').toString('base64'));
    });

    it('混合形态(原图在仓、preview 回落 rootDir):渲染 URL 指 rootDir preview 而非全尺寸原图(review P2)', async () => {
      // put 第二次(preview)抛错 → 原图在仓、preview 落 rootDir
      let putCount = 0;
      const realVault = makeVault();
      vault = {
        put: async (p) => {
          putCount += 1;
          if (putCount === 2) throw new Error('preview put fails');
          return realVault.put(p);
        },
        resolveUrl: (u) => realVault.resolveUrl(u),
      };
      const vstore = makeVaultStore();
      const big = Buffer.alloc(2 * 1024 * 1024, 0xcc);
      const fetcher = vi.fn(async () => ({ buffer: big, mimeType: 'image/jpeg' }));

      const r = await vstore.getOrDownload('tokMixed', fetcher);
      expect(r.xdtImageUrl).toBe('xdt-image://feishu-media-images/tokMixed.preview.jpg');
      // preview 字节确实在 rootDir
      const previewOnDisk = await fs.readFile(
        path.join(rootDir, 'images', 'tokMixed.preview.jpg'),
      );
      expect(previewOnDisk.equals(Buffer.from('FAKE-JPEG-PREVIEW'))).toBe(true);
    });

    it('vault.put 抛错:回落 rootDir 老行为(xdt-image URL),下载不失败', async () => {
      vault = {
        put: async () => {
          throw new Error('db not ready');
        },
        resolveUrl: () => null,
      };
      const vstore = makeVaultStore();
      const buf = Buffer.from('FALLBACK-BYTES');
      const fetcher = vi.fn(async () => ({ buffer: buf, mimeType: 'image/png' }));

      const r = await vstore.getOrDownload('tokFallback', fetcher);
      expect(r.xdtImageUrl).toBe('xdt-image://feishu-media-images/tokFallback.png');
      const onDisk = await fs.readFile(path.join(rootDir, 'images', 'tokFallback.png'));
      expect(onDisk.equals(buf)).toBe(true);
    });

    it('白名单外图片(svg)不走 vault,落 rootDir 老路径', async () => {
      const vstore = makeVaultStore();
      const fetcher = vi.fn(async () => ({
        buffer: Buffer.from('<svg/>'),
        mimeType: 'image/svg+xml',
      }));
      const r = await vstore.getOrDownload('tokSvg', fetcher);
      expect(putCalls).toEqual([]);
      expect(r.xdtImageUrl).toBe('xdt-image://feishu-media-images/tokSvg.svg');
    });

    it('非图片文件不走 vault,落 files/ 老路径', async () => {
      const vstore = makeVaultStore();
      const fetcher = vi.fn(async () => ({
        buffer: Buffer.from('PDF'),
        mimeType: 'application/pdf',
      }));
      const r = await vstore.getOrDownload('tokVaultPdf', fetcher);
      expect(putCalls).toEqual([]);
      expect(r.originalPath.includes(path.join('files'))).toBe(true);
    });
  });

  it('concurrent downloads of the same token dedup to a single fetch', async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { buffer: Buffer.from('X'), mimeType: 'image/png' };
    });

    const [a, b, c] = await Promise.all([
      store.getOrDownload('tokConc', fetcher),
      store.getOrDownload('tokConc', fetcher),
      store.getOrDownload('tokConc', fetcher),
    ]);
    expect(calls).toBe(1);
    expect(a.originalPath).toBe(b.originalPath);
    expect(b.originalPath).toBe(c.originalPath);
  });
});
