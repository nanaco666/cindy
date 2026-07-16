/**
 * decodeSupportedImages 单测: 入站 base64 附件 -> 受支持图片的解码字节。
 * 纯函数(不落盘 / 不碰 electron); 落盘安全由 imageCacheStore 自身的测试覆盖。
 */

import { describe, expect, it } from 'vitest';

import type { TaskAttachment } from '@cindy/slack-hook-protocol';

import { decodeSupportedImages } from '../attachments';

const noopLog = { warn: () => {} };

/** 1x1 PNG 的 base64(合法字节)。 */
const PNG_1PX_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function att(overrides: Partial<TaskAttachment> = {}): TaskAttachment {
  return { name: 'shot.png', mimeType: 'image/png', dataBase64: PNG_1PX_B64, ...overrides };
}

describe('decodeSupportedImages', () => {
  it('受支持图片: 解出字节, mimeType / name 透传', () => {
    const out = decodeSupportedImages([att()], noopLog);
    expect(out).toHaveLength(1);
    expect(out[0].mimeType).toBe('image/png');
    expect(out[0].name).toBe('shot.png');
    expect(out[0].bytes.length).toBeGreaterThan(0);
  });

  it('name 原样透传(不参与落盘路径, 落盘安全在 imageCacheStore 层保证)', () => {
    const out = decodeSupportedImages([att({ name: '../../evil.png' })], noopLog);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('../../evil.png');
  });

  it('非图片 MIME 跳过', () => {
    const out = decodeSupportedImages(
      [att({ mimeType: 'application/pdf' }), att({ mimeType: 'text/plain' })],
      noopLog,
    );
    expect(out).toHaveLength(0);
  });

  it('不支持的图片格式跳过(bmp/svg/heic 等 —— 与协议权威白名单对齐)', () => {
    const out = decodeSupportedImages(
      [
        att({ mimeType: 'image/bmp' }),
        att({ mimeType: 'image/svg+xml' }),
        att({ mimeType: 'image/heic' }),
        att({ mimeType: 'image/png' }), // 仅这张放行
      ],
      noopLog,
    );
    expect(out).toHaveLength(1);
    expect(out[0].mimeType).toBe('image/png');
  });

  it('空 base64 跳过, 不影响其它附件', () => {
    const out = decodeSupportedImages([att({ dataBase64: '' }), att()], noopLog);
    expect(out).toHaveLength(1);
  });

  it('多图各自解出独立字节', () => {
    const out = decodeSupportedImages([att(), att({ mimeType: 'image/jpeg' })], noopLog);
    expect(out).toHaveLength(2);
    expect(out[0].mimeType).toBe('image/png');
    expect(out[1].mimeType).toBe('image/jpeg');
  });
});
