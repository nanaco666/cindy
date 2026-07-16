/**
 * hook-control/attachments.ts
 * ---------------------------------------------------------------------------
 * 入站附件(base64)的纯解码 + 校验 —— 只挑出 agent 可消费的图片、解出字节。
 *
 * 刻意只依赖 node 内建 + 类型, 不 import electron / cindy-media / maker-host:
 * 真正落盘(写 cindy-media 媒体总仓, 依赖 app.getPath)由 session-runner 承担, 本文件
 * 保持纯函数便于单测直接 import(session-runner 顶层拉整条 maker + electron 链,
 * 直接测它会连带加载失败)。图片白名单权威来源是 hook-protocol 的
 * isSupportedImageMime(png/jpeg/gif/webp), 与 provider 下载端同一份, 避免两端
 * 宽窄不一致导致图片被传过来又静默丢弃。
 */

import { isSupportedImageMime, type TaskAttachment } from '@cindy/slack-hook-protocol';

/** 解码后的图片附件(字节 + 元信息); session-runner 据此写 cindy-media 媒体总仓。 */
export interface DecodedImage {
  bytes: Buffer;
  mimeType: string;
  /** 对端原文件名(仅作显示 originalName / 扩展名推断参考, 不参与落盘路径)。 */
  name: string | null;
}

/** 只放行 agent 可消费的图片(白名单权威来源: hook-protocol, 与 provider 下载端一致)。 */
export function isImageMime(mime: string): boolean {
  return isSupportedImageMime(mime);
}

/**
 * 解码入站 base64 附件, 过滤出受支持的图片并解出字节。非图片 / 不支持格式 /
 * 空字节一律跳过(只 warn, 不抛), 不影响其它附件。返回的字节不落盘 —— 由调用方
 * 交给 cindy-media ingest(内容指纹落盘, 不信任对端 name)。
 */
export function decodeSupportedImages(
  attachments: TaskAttachment[],
  log: { warn(msg: string): void },
): DecodedImage[] {
  const out: DecodedImage[] = [];
  for (const att of attachments) {
    if (!isImageMime(att.mimeType)) {
      log.warn(`hook attachment skipped (unsupported mime ${att.mimeType})`);
      continue;
    }
    // 规范化 MIME: 统一小写、别名 image/jpg -> image/jpeg。下游 imageCacheStore
    // 按精确小写 key 查扩展名/渲染 mime, 不归一会落成 .bin 导致渲染类型错。
    const m = att.mimeType.trim().toLowerCase();
    const mimeType = m === 'image/jpg' ? 'image/jpeg' : m;
    // Buffer.from(,'base64') 对非法字符宽松跳过、不抛; 空/全非法 -> 空字节, 由长度判丢弃
    const bytes = Buffer.from(att.dataBase64, 'base64');
    if (bytes.length === 0) continue;
    out.push({ bytes, mimeType, name: att.name });
  }
  return out;
}
