import { readFileSync } from 'node:fs';
import { createContext, Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type HostMessageHandler = (message: Record<string, unknown>) => Promise<void>;

interface CindyFetchRequest {
  url: string;
  method?: string;
  body?: string;
  upload?: { hashes: string[] };
}

interface CindyMessage {
  type: string;
  ok?: boolean;
  result?: Record<string, unknown>;
  message?: string;
}

const mivoSource = readFileSync(
  new URL('../../../../resources/builtin-ghosts/xd-mivo/main.js', import.meta.url),
  'utf8',
);

function imageIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => index.toString(16).padStart(24, '0'));
}

function createMivoHarness() {
  let handler: HostMessageHandler | undefined;
  const requests: CindyFetchRequest[] = [];
  const messages: CindyMessage[] = [];
  let uploadSequence = 100;

  const cindy = {
    onHostMessage: vi.fn((nextHandler: HostMessageHandler) => {
      handler = nextHandler;
    }),
    send: vi.fn(async (message: CindyMessage) => {
      messages.push(message);
    }),
    fetch: vi.fn(async (request: CindyFetchRequest) => {
      requests.push(request);
      if (request.url.endsWith('/message/chat')) {
        return { ok: true, status: 200, body: JSON.stringify({ object_id: 'chat-video-1' }) };
      }
      if (request.url.endsWith('/file/') && request.upload) {
        const uploaded = request.upload.hashes.map(() => ({
          object_id: (uploadSequence++).toString(16).padStart(24, '0'),
        }));
        return { ok: true, status: 200, body: JSON.stringify(uploaded) };
      }
      if (request.url.endsWith('/message')) {
        return { ok: true, status: 200, body: JSON.stringify({ object_id: 'video-job-1' }) };
      }
      throw new Error(`unexpected cindy.fetch request: ${request.url}`);
    }),
  };

  const context = createContext({
    cindy,
    setTimeout,
    clearTimeout,
    URL,
    encodeURIComponent,
  });
  new Script(mivoSource, { filename: 'builtin-ghosts/xd-mivo/main.js' }).runInContext(context);
  if (!handler) throw new Error('XD Mivo did not register its host-message handler');

  return {
    requests,
    async submit(args: Record<string, unknown>) {
      messages.length = 0;
      await handler!({ type: 'tool-call', tool: 'submit_gen_video', callId: 'call-1', args });
      const result = messages.findLast((message) => message.type === 'tool-result');
      if (!result) throw new Error('XD Mivo did not return a tool-result');
      return result;
    },
    messageRequest() {
      const request = requests.findLast((entry) => entry.url.endsWith('/message'));
      if (!request?.body) throw new Error('XD Mivo did not submit a video message');
      return JSON.parse(request.body) as Record<string, unknown>;
    },
  };
}

describe('内置意识 xd-mivo 视频模型路由', () => {
  it.each([
    ['Seedance_2_0_Fast', 0],
    ['Seedance_2_0_Fast', 1],
    ['Seedance_2_0_Fast', 9],
    ['Seedance_1_0_Pro', 0],
    ['Seedance_1_0_Pro', 2],
    ['kling-v3-omni', 0],
    ['kling-v3-omni', 1],
    ['kling-v3-omni', 7],
  ])('%s 接受 %i 张参考图', async (modelVersion, count) => {
    const harness = createMivoHarness();
    const result = await harness.submit({ prompt: '镜头缓慢推进', modelVersion, images: imageIds(count) });

    expect(result.ok).toBe(true);
  });

  it.each([
    ['Seedance_2_0_Fast', 10, '最多接受 9 张'],
    ['Seedance_1_0_Pro', 1, '必须提供 2 张'],
    ['Seedance_1_0_Pro', 3, '必须提供 2 张'],
    ['kling-v3-omni', 8, '最多接受 7 张'],
  ])('%s 拒绝 %i 张参考图', async (modelVersion, count, expectedMessage) => {
    const harness = createMivoHarness();
    const result = await harness.submit({ prompt: '镜头缓慢推进', modelVersion, images: imageIds(count) });

    expect(result.ok).toBe(false);
    expect(result.message).toContain(expectedMessage);
    expect(harness.requests.some((request) => request.url.endsWith('/message'))).toBe(false);
  });

  it('Seedance 3.0 pro 别名按首帧、尾帧顺序构造网页兼容请求', async () => {
    const harness = createMivoHarness();
    const [firstFrame, lastFrame] = imageIds(2);
    const result = await harness.submit({
      prompt: '从白天过渡到夜晚',
      modelVersion: 'pro',
      images: [firstFrame, lastFrame],
    });

    expect(result.ok).toBe(true);
    expect(harness.messageRequest()).toEqual({
      chatSessionId: 'chat-video-1',
      messageType: 'video',
      modelType: 'ARK',
      modelFormat: { version: 'Seedance_1_0_Pro' },
      action: 'generate_video',
      payload: {
        images: [],
        videoRatio: '16:9',
        prompt: '从白天过渡到夜晚',
        duration: 5,
        resolution: '720P',
        firstFrame,
        lastFrame,
      },
      title: '作视频',
    });
  });

  it('合并附件后超限时在上传前拒绝', async () => {
    const harness = createMivoHarness();
    const result = await harness.submit({
      prompt: '多图参考',
      modelVersion: 'kling',
      images: imageIds(7),
      attachments: ['a'.repeat(64)],
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('最多接受 7 张');
    expect(harness.requests.some((request) => request.url.endsWith('/file/'))).toBe(false);
    expect(harness.requests.some((request) => request.url.endsWith('/message'))).toBe(false);
  });

  it('Seedance 3.0 保持显式首帧在前、附件尾帧在后', async () => {
    const harness = createMivoHarness();
    const [firstFrame] = imageIds(1);
    const result = await harness.submit({
      prompt: '首尾帧衔接',
      modelVersion: 'seedance3',
      images: [firstFrame],
      attachments: ['b'.repeat(64)],
    });

    expect(result.ok).toBe(true);
    const request = harness.messageRequest();
    expect(request.payload).toMatchObject({
      images: [],
      firstFrame,
      lastFrame: '000000000000000000000064',
    });
  });
});
