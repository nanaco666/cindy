import { app, BrowserWindow, nativeImage, net, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import {
  createFeishuService,
  type FeishuAuthState,
  type FeishuService,
  type FeishuTokenStore,
} from 'lizi-mcps';

import { createLogger } from '../logger.js';
import * as cindyMediaBlobStore from '../cindy-media/blobStore.js';
import { integrationCacheKey, integrationCachePut } from '../cindy-media/integrationCache.js';
import * as authManager from '../authManager.js';
import { API_BASE_URL_DEV_FALLBACK } from '../../shared/endpoints.js';

const log = createLogger('feishu');

const SAFE_STORAGE_RT_KEY = 'feishu_refresh_token';

let feishuService: FeishuService | null = null;

function safeStorageDir(): string {
  return path.join(app.getPath('userData'), 'safe-storage');
}

function readRefreshToken(): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const fp = path.join(safeStorageDir(), `${SAFE_STORAGE_RT_KEY}.enc`);
    if (!fs.existsSync(fp)) return null;
    const buf = Buffer.from(fs.readFileSync(fp, 'utf-8'), 'base64');
    return safeStorage.decryptString(buf);
  } catch (err) {
    log.error(
      'readRefreshToken failed:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function writeRefreshToken(value: string): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    const encrypted = safeStorage.encryptString(value);
    fs.mkdirSync(safeStorageDir(), { recursive: true });
    fs.writeFileSync(
      path.join(safeStorageDir(), `${SAFE_STORAGE_RT_KEY}.enc`),
      encrypted.toString('base64'),
      'utf-8',
    );
    return true;
  } catch (err) {
    log.error(
      'writeRefreshToken failed:',
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

function removeRefreshToken(): void {
  try {
    fs.unlinkSync(path.join(safeStorageDir(), `${SAFE_STORAGE_RT_KEY}.enc`));
  } catch {
    // ENOENT ok
  }
}

const tokenStore: FeishuTokenStore = {
  readRefreshToken,
  writeRefreshToken,
  removeRefreshToken,
};

function broadcastAuthState(state: FeishuAuthState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('feishu:auth-state', state);
    }
  }
}

/**
 * Electron-specific image compressor — re-encodes oversized images to JPEG q=85
 * with a long-edge cap so they fit Claude's vision input window. GIF / SVG /
 * non-decodable images return null (caller inlines the original).
 */
function compressImageWithNativeImage(
  buffer: Buffer,
  _mime: string,
  opts: { longEdgeMax: number; byteThreshold: number },
): { buffer: Buffer; mime: string; ext: string } | null {
  const img = nativeImage.createFromBuffer(buffer);
  if (img.isEmpty()) return null;

  const size = img.getSize();
  const longEdge = Math.max(size.width, size.height);
  const tooBig = buffer.byteLength > opts.byteThreshold;
  const tooLong = longEdge > opts.longEdgeMax;
  if (!tooBig && !tooLong) return null;

  let resized = img;
  if (tooLong) {
    const ratio = opts.longEdgeMax / longEdge;
    resized = img.resize({
      width: Math.round(size.width * ratio),
      height: Math.round(size.height * ratio),
      quality: 'good',
    });
  }
  // Always re-encode as JPEG q=85; mirrors the original feishuMediaStore policy.
  // Original is preserved on disk by the caller, so PNG transparency loss is OK.
  const out = resized.toJPEG(85);
  return { buffer: out, mime: 'image/jpeg', ext: '.jpg' };
}

function getServerApiBaseUrl(): string {
  return import.meta.env.VITE_API_BASE_URL || API_BASE_URL_DEV_FALLBACK;
}

export function getFeishuService(): FeishuService {
  if (!feishuService) {
    feishuService = createFeishuService({
      token: {
        tokenStore,
        fetchImplementation: net.fetch.bind(net) as unknown as typeof fetch,
        serverApiBaseUrl: getServerApiBaseUrl(),
        // 401 → ask authManager to renew the host JWT; on success it pushes the
        // new JWT back via service.token.setJwt() (see authManager.refresh()).
        onJwtRefreshNeeded: () => authManager.refresh(),
        onAuthStateChange: broadcastAuthState,
      },
      media: {
        // Path MUST match RESERVED_HOSTS in main/imageCacheStore.ts so the
        // xdt-image:// protocol handler resolves to the same files.
        rootDir: path.join(app.getPath('userData'), 'cc-agent', 'feishu-media'),
        createXdtImageUrl: (token, kind, ext) => {
          const safeExt = ext.startsWith('.') ? ext : `.${ext}`;
          const filename =
            kind === 'image-preview'
              ? `${token}.preview${safeExt}`
              : `${token}${safeExt}`;
          const host =
            kind === 'file' ? 'feishu-media-files' : 'feishu-media-images';
          return `xdt-image://${host}/${encodeURIComponent(filename)}`;
        },
        compressImage: compressImageWithNativeImage,
        // 媒体总仓(迁移第 3b 步,规则 25):可入仓图片的原图/preview 字节改存
        // cindy-media(isCache=true,MCP 下载缓存语义,吃回收器 LRU),token 索引
        // 与 lizi-im 的 feishu 入站共用 `feishu:<token>` 命名空间(同一 image_key
        // 两边只存一份)。rootDir 仍服务 meta 索引与非图片文件。
        mediaVault: {
          put: async ({ token, variant, buffer, mimeType }) => {
            const key = integrationCacheKey(
              'feishu',
              variant === 'preview' ? `${token}#preview` : token,
            );
            const hit = await integrationCachePut({
              cacheKey: key,
              integration: 'feishu',
              buffer,
              mimeType,
            });
            return { absPath: hit.absPath, url: hit.url };
          },
          resolveUrl: (url) => {
            try {
              return url.startsWith('cindy-media://')
                ? cindyMediaBlobStore.resolveSafe(url).absPath
                : null;
            } catch {
              return null;
            }
          },
        },
      },
      logger: log,
    });
  }
  return feishuService;
}
