/**
 * attachmentOssRef.test.ts — 出方向附件 OSS 引用串编解码契约。
 */
import { describe, it, expect } from 'vitest';
import {
  buildAttachmentOssRef,
  parseAttachmentOssRef,
  isAttachmentOssRef,
  ATTACH_OSS_SCHEME,
} from '../../shared/attachmentOssRef';

describe('attachmentOssRef', () => {
  it('build/parse 往返(含含斜杠的 ossKey + CJK 文件名)', () => {
    const ref = {
      ossKey: 'xdt-maker/device-link/user-aaa/uuid.png',
      mimeType: 'image/png',
      originalName: '截图 1.png',
    };
    const s = buildAttachmentOssRef(ref);
    expect(s.startsWith(`${ATTACH_OSS_SCHEME}://m/`)).toBe(true);
    expect(parseAttachmentOssRef(s)).toEqual(ref);
  });

  it('mimeType/originalName 可省略', () => {
    const s = buildAttachmentOssRef({ ossKey: 'k/x.bin' });
    expect(parseAttachmentOssRef(s)).toEqual({ ossKey: 'k/x.bin', mimeType: undefined, originalName: undefined });
  });

  it('isAttachmentOssRef 只认本 scheme', () => {
    expect(isAttachmentOssRef(buildAttachmentOssRef({ ossKey: 'k' }))).toBe(true);
    expect(isAttachmentOssRef('xdt-image://s/a.png')).toBe(false);
    expect(isAttachmentOssRef('/abs/path.png')).toBe(false);
    expect(isAttachmentOssRef(42)).toBe(false);
  });

  it('畸形引用 → null', () => {
    expect(parseAttachmentOssRef('xdt-image://s/a.png')).toBeNull();
    expect(parseAttachmentOssRef(`${ATTACH_OSS_SCHEME}://m/!!!notbase64!!!`)).toBeNull();
    expect(parseAttachmentOssRef(`${ATTACH_OSS_SCHEME}://m/`)).toBeNull();
  });
});
