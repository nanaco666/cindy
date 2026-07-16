/**
 * feishu/types.ts — Feishu service public interface.
 *
 * `createFeishuService(opts)` returns a `FeishuService` that bundles client +
 * token + media + upload + utils + MCP server. Hosts inject Electron-specific
 * adapters (safeStorage, nativeImage, net.fetch, BrowserWindow broadcasts) via
 * the `FeishuServiceOptions` callbacks; the package itself stays Electron-free.
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type {
  FeishuApiResult,
  FeishuMcpDeps,
  FeishuMediaResult,
  LiziMcpLogger,
  UploadImageResult,
} from '../types.js';

/**
 * Internal alias — kept un-exported to avoid colliding with the same name in
 * sibling service modules (`google/types.ts`). Sibling modules each define
 * their own private `MaybePromise<T>` instead of sharing.
 */
type MaybePromise<T> = T | Promise<T>;

// ── Token store (host-injected secure RT persistence) ───────────────────────

export interface FeishuTokenStore {
  readRefreshToken(): MaybePromise<string | null>;
  writeRefreshToken(value: string): MaybePromise<boolean>;
  removeRefreshToken(): MaybePromise<void>;
}

// ── Auth state broadcast ────────────────────────────────────────────────────

export type FeishuAuthStatus =
  | 'not_connected'
  | 'connected'
  | 'expired';

export interface FeishuAuthState {
  status: FeishuAuthStatus;
  hasRefreshToken: boolean;
}

// ── Token manager options (sub-piece of service options) ────────────────────

export interface FeishuTokenManagerOptions {
  tokenStore: FeishuTokenStore;
  fetchImplementation: typeof fetch;
  serverApiBaseUrl: string;
  /**
   * Optional callback to refresh the host JWT when the server returns 401
   * during a Feishu RT exchange. Should return true if the JWT was renewed
   * (and `setJwt(newJwt)` called as part of that flow); false to give up.
   */
  onJwtRefreshNeeded?: () => MaybePromise<boolean>;
  onAuthStateChange?: (state: FeishuAuthState) => void;
  logger?: LiziMcpLogger;
}

// ── Media store options ─────────────────────────────────────────────────────

export interface CompressedImageOutput {
  buffer: Buffer;
  mime: string;
  ext: string;
}

export interface CompressImageOptions {
  /** Long-edge cap in pixels (host re-samples down to this when image exceeds). */
  longEdgeMax: number;
  /** Byte-size cap above which compression is forced even if dimensions are OK. */
  byteThreshold: number;
}

/**
 * Host-supplied image compressor. Return null to indicate the original
 * should be inlined (image not decodable / animated / SVG / already small).
 */
export type CompressImageFn = (
  buffer: Buffer,
  mime: string,
  opts: CompressImageOptions,
) => CompressedImageOutput | null;

/**
 * host 媒体总仓存取回调(cindy-media,迁移第 3b 步)。注入后,可入仓图片
 * (png/jpeg/gif/webp)的原图与 preview 字节改存 host 内容寻址仓;meta
 * sidecar 仍留 rootDir 当 token 索引。包侧只摸字节和字符串(host 决定
 * 落盘/记账/URL 形态)。
 */
export interface FeishuMediaVault {
  /** 字节入仓;variant 区分原图与压缩 preview(host 用独立 token 键索引)。 */
  put(params: {
    token: string;
    variant: 'original' | 'preview';
    buffer: Buffer;
    mimeType: string;
  }): Promise<{ absPath: string; url: string }>;
  /** 仓地址 → 绝对路径;文件缺失/不认识返回 null(调用方按缓存失效重下自愈)。 */
  resolveUrl(url: string): string | null;
}

export interface FeishuMediaStoreOptions {
  /** Absolute path to the cache root (e.g. {userData}/cc-agent/feishu-media). */
  rootDir: string;
  /** Build the renderer-facing URL for a cached file. Host owns the URL scheme. */
  createXdtImageUrl(
    fileToken: string,
    kind: 'image-original' | 'image-preview' | 'file',
    ext: string,
  ): string;
  /**
   * Optional image compressor. When omitted, oversized images are not
   * downsampled — the original bytes are inlined as base64 (Node tests
   * default behavior; desktop wires nativeImage).
   */
  compressImage?: CompressImageFn;
  /** 可选 host 媒体总仓;缺省时全部字节落 rootDir(老行为,测试/无仓 host)。 */
  mediaVault?: FeishuMediaVault;
  logger?: LiziMcpLogger;
}

// ── Top-level service options ───────────────────────────────────────────────

export interface FeishuServiceOptions {
  token: Omit<FeishuTokenManagerOptions, 'logger'>;
  media: Omit<FeishuMediaStoreOptions, 'logger'>;
  logger?: LiziMcpLogger;
}

// ── Public sub-facets exposed on the service ────────────────────────────────

export interface FeishuClientFacade {
  getClient(): lark.Client;
  safeCall<T extends { code?: number; msg?: string; data?: unknown }>(
    fn: () => Promise<T>,
  ): Promise<FeishuApiResult>;
  resolveP2pChatId(
    client: lark.Client,
    openId: string,
    authOpts: ReturnType<typeof lark.withUserAccessToken>,
  ): Promise<FeishuApiResult>;
}

export interface FeishuTokenFacade {
  init(): Promise<void>;
  ensureToken(): Promise<{ token: string } | { error: 'AUTH_EXPIRED' }>;
  forceRefresh(): Promise<{ token: string } | { error: 'AUTH_EXPIRED' }>;
  setJwt(jwt: string | null): void;
  storeFeishuToken(data: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }): Promise<{ success: boolean }>;
  clearFeishuTokens(): Promise<void>;
  handleResume(): void;
  dispose(): void;
  /** True if a refresh_token currently exists on disk (post-init). */
  hasRefreshToken(): boolean;
  /** Current in-memory access_token (may be null). */
  getAccessToken(): string | null;
}

export interface FeishuMediaFacade {
  getRoot(): string;
  getImagesDir(): string;
  getFilesDir(): string;
  getOrDownload(
    fileToken: string,
    fetcher: (token: string) => Promise<{ buffer: Buffer; mimeType: string }>,
  ): Promise<FeishuMediaResult>;
  getXdtImageUrl(
    fileToken: string,
    kind: 'image-original' | 'image-preview' | 'file',
    ext: string,
  ): string;
  /** Inline-to-Claude size cap in bytes. */
  readonly COMPRESSION_THRESHOLD_BYTES: number;
  /** Long-edge cap in pixels for Claude vision sweet-spot. */
  readonly COMPRESSION_LONG_EDGE: number;
}

export interface FeishuUploadFacade {
  uploadImage(params: {
    client: lark.Client;
    absPath: string;
    imageType?: 'message' | 'avatar';
    authOpts?: ReturnType<typeof lark.withUserAccessToken>;
  }): Promise<UploadImageResult>;
  readonly IMAGE_MAX_BYTES: number;
}

export interface FeishuUtilsFacade {
  streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer>;
  mimeFromHeaders(headers: unknown): string;
}

export interface FeishuService {
  client: FeishuClientFacade;
  token: FeishuTokenFacade;
  media: FeishuMediaFacade;
  upload: FeishuUploadFacade;
  utils: FeishuUtilsFacade;
  /** Low-level deps shape consumed by `createLiziMcpProviders({ feishu })`. */
  mcp: FeishuMcpDeps;
  toMcpDeps(): FeishuMcpDeps;
  createMcpServer(): McpServer;
}
