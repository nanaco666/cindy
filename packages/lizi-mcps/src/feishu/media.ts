/**
 * feishu/media.ts — Local cache for Feishu media (images / files).
 *
 * Layout:
 *   {rootDir}/
 *     ├── images/
 *     │   ├── {file_token}.{ext}            ← original
 *     │   ├── {file_token}.preview.jpg      ← Claude-friendly compressed (optional)
 *     │   └── {file_token}.meta.json        ← {mime, originalBytes, compressed?}
 *     └── files/
 *         ├── {file_token}.{ext}
 *         └── {file_token}.meta.json
 *
 * Cache rules:
 *   - file_token is globally unique and stable in Feishu → safe to cache forever.
 *   - Concurrent downloads of the same token deduplicate via an in-flight Map.
 *   - Compression triggers when an image is > byteThreshold OR its long edge >
 *     longEdgeMax (host-injected `compressImage` callback). The original is
 *     always kept on disk; the compressed version is what gets returned as
 *     inline base64.
 *
 * Originally apps/desktop/src/main/feishuMediaStore.ts. Electron-specific
 * pieces (`app.getPath`, `nativeImage`) are now host-injected via
 * `FeishuMediaStoreOptions` so the package is host-agnostic.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

import type { FeishuMediaResult } from '../types.js';
import type {
  FeishuMediaFacade,
  FeishuMediaStoreOptions,
} from './types.js';

// ── Constants ───────────────────────────────────────────────────────────────

/** Inline-to-Claude size cap. Images larger than this get a compressed preview. */
export const COMPRESSION_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10 MB
/** Long-edge cap for Claude-friendly vision input. */
export const COMPRESSION_LONG_EDGE = 1568;

const FILE_TOKEN_RE = /^[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LEN = 200;

const IMAGE_MIME_PREFIX = 'image/';
const IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
};

const FILE_EXT_BY_MIME: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/json': '.json',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.ms-excel': '.xls',
  'application/msword': '.doc',
  'application/vnd.ms-powerpoint': '.ppt',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/markdown': '.md',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
};

interface MetaSidecar {
  mime: string;
  originalBytes: number;
  ext: string;
  hasPreview: boolean;
  previewExt?: string;
  /**
   * host 媒体总仓地址(迁移第 3b 步):存在即原图字节在 host 仓(cindy-media),
   * rootDir 不落图片字节,原图路径经 mediaVault.resolveUrl 推导。
   */
  vaultUrl?: string;
  /** preview 字节的 host 仓地址(hasPreview 且走仓时存在)。 */
  previewVaultUrl?: string;
}

/** host 仓能收的图片 mime(与 cindy-media blobStore 白名单对齐;jpg 别名由 host 归一)。 */
const VAULT_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

/** Caller-supplied fetcher: takes the file_token and returns raw bytes + mime. */
export type MediaFetcher = (
  fileToken: string,
) => Promise<{ buffer: Buffer; mimeType: string }>;

// ── Helpers ─────────────────────────────────────────────────────────────────

function assertSafeToken(token: string): void {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LEN) {
    throw new Error('feishu-media: file_token must be a non-empty string up to 200 chars');
  }
  if (!FILE_TOKEN_RE.test(token)) {
    throw new Error('feishu-media: file_token may only contain [A-Za-z0-9_-]');
  }
}

function isImageMime(mime: string): boolean {
  return mime.toLowerCase().startsWith(IMAGE_MIME_PREFIX);
}

function extFromMime(mime: string): string {
  const lower = mime.toLowerCase();
  return IMAGE_EXT_BY_MIME[lower] ?? FILE_EXT_BY_MIME[lower] ?? '.bin';
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createFeishuMediaStore(
  opts: FeishuMediaStoreOptions,
): FeishuMediaFacade {
  const log = opts.logger;
  const inflight = new Map<string, Promise<FeishuMediaResult>>();

  function getRoot(): string {
    return opts.rootDir;
  }
  function getImagesDir(): string {
    return path.join(opts.rootDir, 'images');
  }
  function getFilesDir(): string {
    return path.join(opts.rootDir, 'files');
  }
  function dirForMime(mime: string): string {
    return isImageMime(mime) ? getImagesDir() : getFilesDir();
  }
  function metaPath(dir: string, token: string): string {
    return path.join(dir, `${token}.meta.json`);
  }

  function getXdtImageUrl(
    fileToken: string,
    kind: 'image-original' | 'image-preview' | 'file',
    ext: string,
  ): string {
    assertSafeToken(fileToken);
    return opts.createXdtImageUrl(fileToken, kind, ext.startsWith('.') ? ext : `.${ext}`);
  }

  async function readMeta(
    token: string,
  ): Promise<{ dir: string; meta: MetaSidecar } | null> {
    for (const dir of [getImagesDir(), getFilesDir()]) {
      try {
        const raw = await fs.readFile(metaPath(dir, token), 'utf-8');
        return { dir, meta: JSON.parse(raw) as MetaSidecar };
      } catch {
        // not in this dir, try next
      }
    }
    return null;
  }

  async function writeMetaFile(
    dir: string,
    token: string,
    meta: MetaSidecar,
  ): Promise<void> {
    await fs.writeFile(metaPath(dir, token), JSON.stringify(meta, null, 2), 'utf-8');
  }

  function buildXdtImageUrlForResult(
    token: string,
    mime: string,
    originalExt: string,
    meta: MetaSidecar,
  ): string | undefined {
    if (!isImageMime(mime)) return undefined;
    if (meta.hasPreview && meta.previewExt) {
      return getXdtImageUrl(token, 'image-preview', meta.previewExt);
    }
    return getXdtImageUrl(token, 'image-original', originalExt);
  }

  /**
   * 渲染 URL 选择(vault 形态感知):优先 preview(压缩小图),其中 preview
   * 在仓给仓地址、在 rootDir(混合形态/legacy)给老协议地址——绝不在有
   * preview 时退给全尺寸原图(review P2:混合形态曾误指原图)。
   */
  function pickRenderUrl(
    token: string,
    mime: string,
    originalExt: string,
    meta: MetaSidecar,
  ): string | undefined {
    if (!isImageMime(mime)) return undefined;
    if (meta.previewVaultUrl) return meta.previewVaultUrl;
    if (meta.hasPreview && meta.previewExt) {
      return getXdtImageUrl(token, 'image-preview', meta.previewExt);
    }
    return meta.vaultUrl ?? getXdtImageUrl(token, 'image-original', originalExt);
  }

  function maybeCompress(buffer: Buffer, mime: string) {
    const lower = mime.toLowerCase();
    if (!isImageMime(lower)) return null;
    if (lower === 'image/gif' || lower === 'image/svg+xml') return null;
    if (!opts.compressImage) return null;
    return opts.compressImage(buffer, lower, {
      longEdgeMax: COMPRESSION_LONG_EDGE,
      byteThreshold: COMPRESSION_THRESHOLD_BYTES,
    });
  }

  /**
   * 命中回放。vault 形态(meta.vaultUrl 存在)下若仓内文件缺失(未来回收器
   * LRU 逐出属正常事件)返回 null 让调用方重下自愈——不同于 legacy 形态的
   * "cache corrupt" 硬抛(那是 meta 与文件不该分离的异常)。
   */
  async function loadFromCache(
    token: string,
    dir: string,
    meta: MetaSidecar,
  ): Promise<FeishuMediaResult | null> {
    let originalPath: string;
    if (meta.vaultUrl) {
      const resolved = opts.mediaVault?.resolveUrl(meta.vaultUrl) ?? null;
      if (!resolved || !existsSync(resolved)) {
        log?.debug?.(`[feishuMedia] vault miss for ${token}, re-downloading`);
        return null;
      }
      originalPath = resolved;
    } else {
      originalPath = path.join(dir, `${token}${meta.ext}`);
      if (!existsSync(originalPath)) {
        throw new Error(
          `feishu-media: cache corrupt for ${token} (meta ok, file missing)`,
        );
      }
    }

    let preview: FeishuMediaResult['preview'];
    let inline: FeishuMediaResult['inline'];

    if (isImageMime(meta.mime)) {
      if (meta.hasPreview && meta.previewExt) {
        let previewPath: string | null;
        if (meta.previewVaultUrl) {
          previewPath = opts.mediaVault?.resolveUrl(meta.previewVaultUrl) ?? null;
          if (!previewPath || !existsSync(previewPath)) {
            log?.debug?.(`[feishuMedia] vault preview miss for ${token}, re-downloading`);
            return null;
          }
        } else {
          previewPath = path.join(dir, `${token}.preview${meta.previewExt}`);
        }
        const buf = await fs.readFile(previewPath);
        preview = {
          path: previewPath,
          mimeType: meta.previewExt === '.jpg' ? 'image/jpeg' : meta.mime,
          bytes: buf.byteLength,
          base64: buf.toString('base64'),
        };
      } else {
        const buf = await fs.readFile(originalPath);
        inline = {
          mimeType: meta.mime,
          bytes: buf.byteLength,
          base64: buf.toString('base64'),
        };
      }
    }

    return {
      isImage: isImageMime(meta.mime),
      mimeType: meta.mime,
      originalPath,
      originalBytes: meta.originalBytes,
      xdtImageUrl: pickRenderUrl(token, meta.mime, meta.ext, meta),
      fromCache: true,
      preview,
      inline,
    };
  }

  async function getOrDownload(
    fileToken: string,
    fetcher: MediaFetcher,
  ): Promise<FeishuMediaResult> {
    assertSafeToken(fileToken);

    const existing = inflight.get(fileToken);
    if (existing) return existing;

    const promise = (async () => {
      const cached = await readMeta(fileToken);
      if (cached) {
        const replayed = await loadFromCache(fileToken, cached.dir, cached.meta);
        if (replayed) return replayed;
        // vault 文件被逐出:清掉过期 meta 与混合形态遗留的 rootDir 字节
        // (preview / 回落原图)走重下,不留孤儿文件(review P2)。
        await fs.rm(metaPath(cached.dir, fileToken), { force: true }).catch(() => {});
        if (cached.meta.previewExt) {
          await fs
            .rm(path.join(cached.dir, `${fileToken}.preview${cached.meta.previewExt}`), { force: true })
            .catch(() => {});
        }
        await fs
          .rm(path.join(cached.dir, `${fileToken}${cached.meta.ext}`), { force: true })
          .catch(() => {});
      }

      await fs.mkdir(getImagesDir(), { recursive: true });
      await fs.mkdir(getFilesDir(), { recursive: true });

      const { buffer, mimeType } = await fetcher(fileToken);
      const ext = extFromMime(mimeType);
      const dir = dirForMime(mimeType);

      const meta: MetaSidecar = {
        mime: mimeType,
        originalBytes: buffer.byteLength,
        ext,
        hasPreview: false,
      };

      // 可入仓图片走 host 媒体总仓(迁移第 3b 步):原图与 preview 字节都进仓,
      // rootDir 只留 meta 索引;仓不可用/入仓失败回落老目录(缓存问题不挡下载)。
      const vault = opts.mediaVault;
      const useVault = vault && VAULT_IMAGE_MIMES.has(mimeType.toLowerCase());
      let originalPath: string | null = null;
      if (useVault) {
        try {
          const put = await vault.put({
            token: fileToken,
            variant: 'original',
            buffer,
            mimeType,
          });
          originalPath = put.absPath;
          meta.vaultUrl = put.url;
        } catch (err) {
          log?.warn?.(
            `[feishuMedia] vault put failed for ${fileToken}, falling back to rootDir: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (!originalPath) {
        originalPath = path.join(dir, `${fileToken}${ext}`);
        await fs.writeFile(originalPath, buffer);
      }

      let preview: FeishuMediaResult['preview'];
      let inline: FeishuMediaResult['inline'];

      if (isImageMime(mimeType)) {
        const compressed = maybeCompress(buffer, mimeType);
        if (compressed) {
          meta.hasPreview = true;
          meta.previewExt = compressed.ext;
          let previewPath: string | null = null;
          if (meta.vaultUrl && vault) {
            try {
              const put = await vault.put({
                token: fileToken,
                variant: 'preview',
                buffer: compressed.buffer,
                mimeType: compressed.mime,
              });
              previewPath = put.absPath;
              meta.previewVaultUrl = put.url;
            } catch {
              // preview 入仓失败:回落 rootDir(原图已在仓,混合形态可回放)。
            }
          }
          if (!previewPath) {
            previewPath = path.join(dir, `${fileToken}.preview${compressed.ext}`);
            await fs.writeFile(previewPath, compressed.buffer);
          }
          preview = {
            path: previewPath,
            mimeType: compressed.mime,
            bytes: compressed.buffer.byteLength,
            base64: compressed.buffer.toString('base64'),
          };
        } else {
          inline = {
            mimeType,
            bytes: buffer.byteLength,
            base64: buffer.toString('base64'),
          };
        }
      }

      await writeMetaFile(dir, fileToken, meta);

      log?.debug?.(
        `[feishuMedia] cached ${fileToken} mime=${mimeType} bytes=${buffer.byteLength} preview=${meta.hasPreview} vault=${!!meta.vaultUrl}`,
      );

      return {
        isImage: isImageMime(mimeType),
        mimeType,
        originalPath,
        originalBytes: buffer.byteLength,
        xdtImageUrl: pickRenderUrl(fileToken, mimeType, ext, meta),
        fromCache: false,
        preview,
        inline,
      };
    })();

    inflight.set(fileToken, promise);
    try {
      return await promise;
    } finally {
      inflight.delete(fileToken);
    }
  }

  return {
    getRoot,
    getImagesDir,
    getFilesDir,
    getOrDownload,
    getXdtImageUrl,
    COMPRESSION_THRESHOLD_BYTES,
    COMPRESSION_LONG_EDGE,
  };
}
