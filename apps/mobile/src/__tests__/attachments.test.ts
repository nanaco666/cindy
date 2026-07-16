import { describe, expect, it } from 'vitest';
import {
  attachmentDisplayLabel,
  basenameRemotePath,
  buildAttachmentPersistFileRefs,
  buildAttachmentPersistImageRefs,
  buildMobileRemoteFileAttachment,
  buildMobileUploadedAttachment,
  MOBILE_MAX_ATTACHMENT_BYTES,
  categorizeMobileAttachment,
  extractRemoteFileExt,
} from '@/session/attachments';
import { parseAttachmentOssRef } from '@/session/attachmentOssRef';

describe('mobile remote file attachments', () => {
  it('parses macOS and Windows remote paths without using local platform path rules', () => {
    expect(basenameRemotePath('/repo/docs/spec.pdf')).toBe('spec.pdf');
    expect(basenameRemotePath('C:\\repo\\docs\\notes.md')).toBe('notes.md');
    expect(extractRemoteFileExt('.env.example')).toBe('.env.example');
    expect(extractRemoteFileExt('Dockerfile')).toBe('');
  });

  it('mirrors the desktop attachment categories for common remote files', () => {
    expect(categorizeMobileAttachment('screenshot.png')).toBe('image');
    expect(categorizeMobileAttachment('spec.pdf')).toBe('pdf');
    expect(categorizeMobileAttachment('report.docx')).toBe('office');
    expect(categorizeMobileAttachment('SessionScreen.tsx')).toBe('text');
    expect(categorizeMobileAttachment('Dockerfile')).toBe('text');
    expect(categorizeMobileAttachment('archive.zip')).toBeNull();
  });

  it('builds desktop-compatible serialized attachment and persisted file refs', () => {
    const attachment = buildMobileRemoteFileAttachment('/repo/docs/spec.pdf', {
      id: 'file-1',
      size: 2048,
    });

    expect(attachment).toEqual({
      id: 'file-1',
      name: 'spec.pdf',
      path: '/repo/docs/spec.pdf',
      ext: '.pdf',
      size: 2048,
      category: 'pdf',
      mimeType: 'application/pdf',
    });
    expect(buildAttachmentPersistFileRefs([attachment!])).toEqual([
      { name: 'spec.pdf', path: '/repo/docs/spec.pdf' },
    ]);
    expect(attachmentDisplayLabel(attachment!)).toBe('spec.pdf · 2.0 KB');
  });

  it('builds desktop-compatible OSS attachment refs for uploaded mobile files', () => {
    const attachment = buildMobileUploadedAttachment({
      id: 'upload-1',
      ossKey: 'xdt-maker/device-link/user-1/spec.pdf',
      name: '/local/spec.pdf',
      size: 4096,
      mimeType: 'application/pdf',
    });

    expect(attachment).toMatchObject({
      id: 'upload-1',
      name: 'spec.pdf',
      ext: '.pdf',
      size: 4096,
      category: 'pdf',
      mimeType: 'application/pdf',
      originalName: 'spec.pdf',
    });
    expect(parseAttachmentOssRef(attachment!.path)).toEqual({
      ossKey: 'xdt-maker/device-link/user-1/spec.pdf',
      mimeType: 'application/pdf',
      originalName: 'spec.pdf',
    });
    expect(buildAttachmentPersistFileRefs([attachment!])).toEqual([
      { name: 'spec.pdf', path: attachment!.path },
    ]);
  });

  it('round-trips uploaded attachment refs with CJK original names', () => {
    const attachment = buildMobileUploadedAttachment({
      ossKey: 'xdt-maker/device-link/user-1/report.pdf',
      name: '需求文档.pdf',
      size: 1024,
      mimeType: 'application/pdf',
    });

    expect(parseAttachmentOssRef(attachment!.path)).toEqual({
      ossKey: 'xdt-maker/device-link/user-1/report.pdf',
      mimeType: 'application/pdf',
      originalName: '需求文档.pdf',
    });
  });

  it('uses image refs for image persisted content and file refs for non-images', () => {
    const image = buildMobileUploadedAttachment({
      ossKey: 'xdt-maker/device-link/user-1/photo.png',
      name: 'photo.png',
      size: 1024,
      mimeType: 'image/png',
    });
    const file = buildMobileUploadedAttachment({
      ossKey: 'xdt-maker/device-link/user-1/spec.pdf',
      name: 'spec.pdf',
      size: 1024,
      mimeType: 'application/pdf',
    });

    // 字段名必须是 originalName(桌面 ImageRef schema):写成 `name` 会被桌面
    // renderer 的图片校验静默过滤,手机贴图在桌面版整个不渲染(2026-07 实踩)。
    expect(buildAttachmentPersistImageRefs([image!, file!])).toEqual([{
      url: image!.url,
      originalName: 'photo.png',
      mimeType: 'image/png',
    }]);
    expect(buildAttachmentPersistFileRefs([image!, file!])).toEqual([{
      name: 'spec.pdf',
      path: file!.path,
    }]);
  });

  it('uses the same OSS ref as image url so desktop can materialize uploaded images', () => {
    const attachment = buildMobileUploadedAttachment({
      ossKey: 'xdt-maker/device-link/user-1/photo.png',
      name: 'photo.png',
      size: 1024,
      mimeType: 'image/png',
    });

    expect(attachment?.category).toBe('image');
    expect(attachment?.url).toBe(attachment?.path);
    expect(parseAttachmentOssRef(attachment!.url!)).toMatchObject({
      ossKey: 'xdt-maker/device-link/user-1/photo.png',
      originalName: 'photo.png',
    });
  });

  it('rejects uploaded mobile files outside desktop attachment limits', () => {
    expect(buildMobileUploadedAttachment({
      ossKey: 'xdt-maker/device-link/user-1/archive.zip',
      name: 'archive.zip',
      size: 1024,
    })).toBeNull();
    expect(buildMobileUploadedAttachment({
      ossKey: 'xdt-maker/device-link/user-1/spec.pdf',
      name: 'spec.pdf',
      size: MOBILE_MAX_ATTACHMENT_BYTES + 1,
    })).toBeNull();
  });
});
