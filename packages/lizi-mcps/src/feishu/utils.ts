/**
 * feishu/utils.ts — generic stream/header helpers used by every Feishu
 * download path (drive.media.download, im.v1.messageResource.get, ...).
 *
 * Pure (no host deps); originally lived in apps/desktop/src/main/feishuStreamUtils.ts.
 */

import type { Readable } from 'node:stream';

export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
  }
  return Buffer.concat(chunks);
}

export function mimeFromHeaders(headers: unknown): string {
  if (!headers || typeof headers !== 'object') return 'application/octet-stream';
  const h = headers as Record<string, unknown>;
  const raw =
    (h['content-type'] as string | undefined) ??
    (h['Content-Type'] as string | undefined) ??
    'application/octet-stream';
  return raw.split(';')[0].trim() || 'application/octet-stream';
}
