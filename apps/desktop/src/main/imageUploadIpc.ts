/**
 * imageUpload — Main 端 IPC
 * ---------------------------------------------------------------------------
 * 渲染端不直接做网络通讯（CLAUDE.md 设计规范 #1）。
 * Renderer 拿到 server 签好的 putUrl 后，把字节交给 main，由 main 用
 * `net.fetch` PUT 到 OSS；返回 { ok, status }。
 *
 * Channel:
 *   image-upload:put-to-oss   { putUrl, contentType, bytes: ArrayBuffer }
 *                             → { ok: boolean, status: number, error?: string }
 */

import { ipcMain, net } from 'electron';

import { createLogger } from './logger.js';

const log = createLogger('image-upload:ipc');

export const IMAGE_UPLOAD_CHANNELS = {
  PUT_TO_OSS: 'image-upload:put-to-oss',
} as const;

export interface PutToOssParams {
  putUrl: string;
  contentType: string;
  /** 待上传字节（结构化克隆通过 IPC 传过来）。 */
  bytes: ArrayBuffer;
}

export interface PutToOssResult {
  ok: boolean;
  status: number;
  error?: string;
}

let registered = false;

export function registerImageUploadIpc(): void {
  if (registered) return;
  registered = true;
  log.info('registering image-upload:* IPC handlers');

  ipcMain.handle(
    IMAGE_UPLOAD_CHANNELS.PUT_TO_OSS,
    async (_event, params: PutToOssParams): Promise<PutToOssResult> => {
      if (!params || typeof params.putUrl !== 'string' || !params.bytes) {
        return { ok: false, status: 0, error: '参数非法' };
      }
      try {
        const resp = await net.fetch(params.putUrl, {
          method: 'PUT',
          headers: { 'Content-Type': params.contentType },
          body: params.bytes,
        });
        if (!resp.ok) {
          // OSS 错误体一般是 XML，读出来便于排查（不抛给 renderer 原文，避免泄露 bucket 信息）
          const txt = await resp.text().catch(() => '');
          log.warn(
            `OSS PUT failed: status=${resp.status} contentType=${params.contentType} body=${txt.slice(0, 300)}`,
          );
          return { ok: false, status: resp.status, error: `OSS 返回 ${resp.status}` };
        }
        return { ok: true, status: resp.status };
      } catch (err) {
        log.error(`OSS PUT exception: ${String(err)}`);
        return { ok: false, status: 0, error: '网络异常' };
      }
    },
  );
}
