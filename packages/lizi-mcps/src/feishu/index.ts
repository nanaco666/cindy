/**
 * feishu/index.ts — public exports for the Feishu service module.
 *
 * Hosts typically only need `createFeishuService(opts)` from `service.ts`;
 * the lower-level pieces (`createFeishuClient`, `createFeishuTokenManager`,
 * `createFeishuMediaStore`, `createFeishuMcpServer`, helper utils) are
 * re-exported here so advanced/test code can compose them directly.
 */

export * from './types.js';

export { createFeishuClient } from './client.js';
export type { CreateFeishuClientOptions } from './client.js';

export { createFeishuTokenManager } from './token.js';

export {
  COMPRESSION_THRESHOLD_BYTES,
  COMPRESSION_LONG_EDGE,
  createFeishuMediaStore,
} from './media.js';
export type { MediaFetcher } from './media.js';

export {
  FEISHU_IMAGE_MAX_BYTES,
  uploadFeishuImage,
} from './upload.js';
export type { ImageType } from './upload.js';

export { mimeFromHeaders, streamToBuffer } from './utils.js';

export { createFeishuMcpServer, createFeishuMcpServerWithRegistry } from './mcp/server.js';
export { FeishuToolRegistry } from './mcp/toolRegistry.js';
export type {
  FeishuToolContentBlock,
  FeishuToolDef,
  FeishuToolHandler,
  FeishuToolResult,
  FeishuToolSummary,
  ToolCategory,
} from './mcp/toolRegistry.js';
export {
  extractImagesWithSection,
  extractEmbeddedBlocks,
  type ImageManifestEntry,
  type EmbeddedBlockEntry,
} from './mcp/blockManifest.js';

export { createFeishuService } from './service.js';
