/**
 * feishu/service.ts — `createFeishuService(opts)` top-level factory.
 *
 * Wires client + token + media + upload + utils + MCP server into a single
 * `FeishuService` so hosts only see one entry point. Mirrors the pattern of
 * `createLiziGoogleService` in ../google/service.ts.
 *
 * The host injects only Electron-specific adapters (safeStorage-backed
 * tokenStore, nativeImage-based compressor, net.fetch, BrowserWindow
 * broadcasts); everything below is portable Node code.
 */

import type { FeishuMcpDeps, LiziMcpLogger } from '../types.js';
import type {
  FeishuService,
  FeishuServiceOptions,
} from './types.js';
import { createFeishuClient } from './client.js';
import { createFeishuTokenManager } from './token.js';
import { createFeishuMediaStore } from './media.js';
import {
  FEISHU_IMAGE_MAX_BYTES,
  uploadFeishuImage,
} from './upload.js';
import { mimeFromHeaders, streamToBuffer } from './utils.js';
import { createFeishuMcpServer } from './mcp/server.js';

export function createFeishuService(
  opts: FeishuServiceOptions,
): FeishuService {
  const logger: LiziMcpLogger | undefined = opts.logger;

  const client = createFeishuClient({ logger });
  const token = createFeishuTokenManager({ ...opts.token, logger });
  const media = createFeishuMediaStore({ ...opts.media, logger });

  const upload = {
    uploadImage: uploadFeishuImage,
    IMAGE_MAX_BYTES: FEISHU_IMAGE_MAX_BYTES,
  } as const;

  const utils = {
    streamToBuffer,
    mimeFromHeaders,
  } as const;

  // Low-level deps shape that createLiziMcpProviders({ feishu }) consumes.
  // Lazily-resolving wrappers (no captured client/token snapshot) so future
  // service mutations propagate.
  const mcp: FeishuMcpDeps = {
    getFeishuClient: () => client.getClient(),
    safeCall: (fn) => client.safeCall(fn),
    resolveP2pChatId: (larkClient, openId, authOpts) =>
      client.resolveP2pChatId(larkClient, openId, authOpts),
    ensureToken: () => token.ensureToken(),
    forceRefresh: () => token.forceRefresh(),
    getOrDownloadMedia: (fileToken, fetcher) =>
      media.getOrDownload(fileToken, fetcher),
    uploadFeishuImage: (params) => upload.uploadImage(params),
    feishuImageMaxBytes: upload.IMAGE_MAX_BYTES,
    streamToBuffer: utils.streamToBuffer,
    mimeFromHeaders: utils.mimeFromHeaders,
    logger,
  };

  return {
    client,
    token,
    media,
    upload,
    utils,
    mcp,
    toMcpDeps: () => mcp,
    createMcpServer: () => createFeishuMcpServer(mcp),
  };
}
