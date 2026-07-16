/**
 * slack/inboundAttachments.test.ts — 入站附件的媒体总仓提升分支回归(迁移第 3 步)。
 * 与 discord inbound.test.ts 同口径:提升成功(absPath=仓内、url 透传、删老目录
 * 临时副本)、提升失败回落老目录(附件不丢)、非图片不走总仓。
 * 文件全部落 os.tmpdir() 并收尾清理(规则 23)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { SlackIM } from '../index.js';
import type { SlackRelayInboundEvent, SlackRelayTransport } from '../transport.js';
import type { IMHost, IMHostMediaCache, IMMessageEvent } from '../../types.js';

const tmpRoots: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-inbound-'));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

const CINDY_URL = `cindy-media://blobs/${'b'.repeat(64)}.png`;

function makeHost(mediaDir: string, media?: IMHostMediaCache): IMHost {
  return {
    paths: { feishuMediaDir: tempDir(), slackMediaDir: mediaDir },
    ...(media ? { media } : {}),
    secrets: {
      isAvailable: () => false,
      write: () => false,
      read: () => null,
      remove: () => {},
    },
    ipc: { handle: () => {}, broadcast: () => {} },
    httpPostForm: async () => ({ status: 200, body: {} }),
  } as unknown as IMHost;
}

function makeTransport() {
  let onEvent: ((e: SlackRelayInboundEvent) => void) | null = null;
  const transport = {
    subscribe(handlers: { onEvent(e: SlackRelayInboundEvent): void }) {
      onEvent = handlers.onEvent;
      return () => {};
    },
    call: vi.fn(async () => ({ ok: true })),
    uploadFile: vi.fn(async () => ({ ok: true })),
    downloadFile: vi.fn(async (_fileId: string, dest: string) => {
      fs.writeFileSync(dest, 'slack-image-bytes');
      return { ok: true };
    }),
    getLinkStatus: vi.fn(async () => ({ linked: false })),
  } as unknown as SlackRelayTransport & { downloadFile: ReturnType<typeof vi.fn> };
  return {
    transport,
    async emitMessage(e: Extract<SlackRelayInboundEvent, { kind: 'message' }>) {
      onEvent?.(e);
      // handleInboundMessage 是 async void:等两拍让下载/提升链路走完
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

function messageEvent(
  files: Array<{ id: string; name: string; mimetype: string; size: number }>,
): Extract<SlackRelayInboundEvent, { kind: 'message' }> {
  return { kind: 'message', channelId: 'D1', ts: '1718000000.1', text: 'see files', files };
}

async function collectInbound(
  mediaDir: string,
  media: IMHostMediaCache | undefined,
  files: Array<{ id: string; name: string; mimetype: string; size: number }>,
): Promise<IMMessageEvent> {
  const { transport, emitMessage } = makeTransport();
  const im = new SlackIM(makeHost(mediaDir, media), transport);
  const received: IMMessageEvent[] = [];
  im.onMessage((e) => received.push(e));
  await im.init();
  await emitMessage(messageEvent(files));
  await im.dispose();
  expect(received).toHaveLength(1);
  return received[0]!;
}

describe('SlackIM 入站附件 × 媒体总仓', () => {
  it('图片提升进总仓:absPath=仓内路径、url 透传、删老目录临时副本;file 不走总仓', async () => {
    const mediaDir = tempDir();
    const cacheImage = vi.fn(async ({ token }: { token: string }) => ({
      absPath: `/blobs/${token}.png`,
      url: CINDY_URL,
    }));
    const media: IMHostMediaCache = {
      cacheImage,
      getCachedImage: vi.fn(async () => null),
      resolveMediaUrl: vi.fn(() => null),
    };

    const event = await collectInbound(mediaDir, media, [
      { id: 'F001', name: 'photo.png', mimetype: 'image/png', size: 1024 },
      { id: 'F002', name: 'notes.pdf', mimetype: 'application/pdf', size: 1024 },
    ]);

    expect(cacheImage).toHaveBeenCalledTimes(1);
    expect(cacheImage.mock.calls[0]![0]).toMatchObject({
      integration: 'slack',
      token: 'F001',
      mimeType: 'image/png',
    });
    expect(event.attachments[0]).toMatchObject({
      kind: 'image',
      absPath: '/blobs/F001.png',
      url: CINDY_URL,
    });
    // 提升成功后老目录临时副本被删
    expect(fs.existsSync(path.join(mediaDir, 'F001_photo.png'))).toBe(false);
    // 非图片不走总仓,留在老目录,无 url
    expect(event.attachments[1]).toMatchObject({
      kind: 'file',
      absPath: path.join(mediaDir, 'F002_notes.pdf'),
    });
    expect(event.attachments[1]).not.toHaveProperty('url');
    expect(event.unsupported).toEqual([]);
  });

  it('cacheImage 抛错:回落老目录副本,附件不丢、无 url', async () => {
    const mediaDir = tempDir();
    const media: IMHostMediaCache = {
      cacheImage: vi.fn(async () => {
        throw new Error('db not ready');
      }),
      getCachedImage: vi.fn(async () => null),
      resolveMediaUrl: vi.fn(() => null),
    };

    const event = await collectInbound(mediaDir, media, [
      { id: 'F003', name: 'photo.png', mimetype: 'image/png', size: 1024 },
    ]);

    const legacyPath = path.join(mediaDir, 'F003_photo.png');
    expect(event.attachments[0]).toMatchObject({ kind: 'image', absPath: legacyPath });
    expect(event.attachments[0]).not.toHaveProperty('url');
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(event.unsupported).toEqual([]);
  });

  it('无 media 注入:图片走迁移前老目录路径(行为不回归)', async () => {
    const mediaDir = tempDir();
    const event = await collectInbound(mediaDir, undefined, [
      { id: 'F004', name: 'photo.png', mimetype: 'image/png', size: 1024 },
    ]);

    expect(event.attachments[0]).toMatchObject({
      kind: 'image',
      absPath: path.join(mediaDir, 'F004_photo.png'),
    });
    expect(event.attachments[0]).not.toHaveProperty('url');
  });
});
