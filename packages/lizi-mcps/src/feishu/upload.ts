/**
 * feishu/upload.ts — share-able image uploader for Feishu im.image.create.
 *
 * Used by both the `im_upload_image` MCP tool (with user_access_token) and
 * the bot reply path (with bot app credentials). Client + auth opts must be
 * supplied by the caller because MCP and bot use different token flows.
 *
 * Pure (no host deps); originally lived in apps/desktop/src/main/feishuImageUploader.ts.
 */

import fs from 'node:fs';

import * as lark from '@larksuiteoapi/node-sdk';

import type { UploadImageResult } from '../types.js';

export const FEISHU_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export type ImageType = 'message' | 'avatar';

export async function uploadFeishuImage(params: {
  client: lark.Client;
  absPath: string;
  imageType?: ImageType;
  authOpts?: ReturnType<typeof lark.withUserAccessToken>;
}): Promise<UploadImageResult> {
  const { client, absPath, imageType = 'message', authOpts } = params;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return { ok: false, code: 'FILE_NOT_FOUND', absPath };
  }
  if (stat.size === 0) {
    return { ok: false, code: 'INVALID_FILE', absPath, size: 0 };
  }
  if (stat.size > FEISHU_IMAGE_MAX_BYTES) {
    return {
      ok: false,
      code: 'FILE_TOO_LARGE',
      absPath,
      size: stat.size,
      limit: FEISHU_IMAGE_MAX_BYTES,
    };
  }

  try {
    const res = await client.im.image.create(
      {
        data: {
          image_type: imageType,
          image: fs.createReadStream(absPath),
        },
      },
      authOpts,
    );
    const imageKey = (res as { image_key?: string } | null)?.image_key;
    if (!imageKey) {
      return {
        ok: false,
        code: 'UPLOAD_FAILED',
        absPath,
        message: `no image_key in response: ${JSON.stringify(res)?.slice(0, 200)}`,
      };
    }
    return { ok: true, imageKey };
  } catch (err) {
    const base = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    // 飞书的真正错误码/文案在 axios error 的 response.data 里 —— err.message
    // 只有 "Request failed with status code 400",对排查无用。把 body 拼进去
    // 让上层日志能直接看到 99991005 / 230099 之类的具体原因。
    let body = '';
    if (err && typeof err === 'object' && 'response' in err) {
      try {
        const r = (err as { response?: { status?: number; data?: unknown } }).response;
        body = ` status=${r?.status} body=${JSON.stringify(r?.data)?.slice(0, 500)}`;
      } catch {
        // ignore
      }
    }
    return { ok: false, code: 'UPLOAD_FAILED', absPath, message: `${base}${body}` };
  }
}
