/**
 * 内置意识 cindy-feishu 的装配级冒烟(与 builtinMivoVideo.test.ts 同范式:
 * node vm 加载真 main.js + 假 cindy 环境驱动)。
 *
 * 护住什么:44 精品 + 123 直通共 167 个操作的注册完整性、两段式目录形态、
 * 空参/深参调用不出现装配级错误(is not defined / Cannot read)、gop 路径
 * 模板缺参报错、票据语义(save_dir / dir / attachments)的引导话术、以及
 * manifest 与 main.js 的一致性(secret source / 元工具名)。
 * 端点级行为对齐老 MCP 由移植时逐条核对保证,这里不重复断言。
 */
import { readFileSync } from 'node:fs';
import { createContext, Script } from 'node:vm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { validateGhostManifest } from '../../../shared/ghost.js';

const ghostDir = new URL('../../../../resources/builtin-ghosts/cindy-feishu/', import.meta.url);
const mainSource = readFileSync(new URL('main.js', ghostDir), 'utf8');
const rawManifest = JSON.parse(readFileSync(new URL('ghost.json', ghostDir), 'utf8')) as Record<string, unknown>;

type HostMessageHandler = (message: Record<string, unknown>) => Promise<void>;

interface SentMessage {
  type: string;
  ok?: boolean;
  callId?: string;
  result?: Record<string, unknown>;
  message?: string;
  [k: string]: unknown;
}

interface FetchRequest {
  url: string;
  method?: string;
  body?: string;
  as?: string;
  upload?: { hashes: string[]; field?: string; fields?: Record<string, string> };
  uploadDir?: { token: string; fileField?: string; fields?: Record<string, string> };
  saveTo?: { token: string; filename?: string };
  [k: string]: unknown;
}

function createHarness() {
  let handler: HostMessageHandler | undefined;
  const sent: SentMessage[] = [];
  const requests: FetchRequest[] = [];
  const cindy = {
    onHostMessage: (next: HostMessageHandler) => { handler = next; },
    send: vi.fn(async (message: SentMessage) => {
      sent.push(message);
      if (message.type === 'fs-request') {
        return { ok: true, op: 'write', path: message.path, bytes: 1 };
      }
      return { ok: true };
    }),
    fetch: vi.fn(async (request: FetchRequest) => {
      requests.push(request);
      if (request.as === 'media') {
        return { ok: true, status: 200, media: { url: 'cindy-media://blobs/x.png', hash: 'a'.repeat(64), ext: '.png' } };
      }
      if (request.as === 'file') {
        return { ok: true, status: 200, file: { file_name: 'f.bin', bytes: 3 } };
      }
      return {
        ok: true, status: 200, headers: {},
        body: JSON.stringify({ code: 0, msg: 'ok', data: { items: [], has_more: false } }),
      };
    }),
  };
  const context = createContext({
    cindy,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Intl, Date, JSON, Math, Promise, URL,
    BroadcastChannel: class {
      postMessage() {}
      addEventListener() {}
      removeEventListener() {}
    },
    fetch: async () => ({ json: async () => ({}), status: 204 }),
  });
  new Script(mainSource, { filename: 'cindy-feishu/main.js' }).runInContext(context);
  if (!handler) throw new Error('onHostMessage 未注册');
  const call = async (tool: string, args: Record<string, unknown>) => {
    const before = sent.length;
    await handler!({ type: 'tool-call', tool, args, callId: 'test-call-1234' });
    const results = sent.slice(before).filter((m) => m.type === 'tool-result');
    expect(results).toHaveLength(1);
    return results[0];
  };
  return { call, sent, requests };
}

describe('builtin cindy-feishu ghost', () => {
  it('ghost.json 过 validateGhostManifest,凭证是 login-feishu-token 单条', () => {
    const v = validateGhostManifest(rawManifest);
    expect(v.ok, v.ok ? '' : v.reason).toBe(true);
    if (!v.ok) return;
    expect(v.manifest.network?.hosts).toEqual(['open.feishu.cn']);
    expect(v.manifest.network?.secrets?.map((s) => s.source)).toEqual(['login-feishu-token']);
    expect(v.manifest.tools?.map((t) => t.name)).toEqual(['list_tools', 'call_tool']);
  });

  let harness: ReturnType<typeof createHarness>;
  let allNames: string[] = [];

  beforeAll(async () => {
    harness = createHarness();
    const overview = await harness.call('list_tools', {});
    expect(overview.ok).toBe(true);
    const categories = Object.keys((overview.result as { categories: Record<string, unknown> }).categories);
    for (const category of categories) {
      let page = 1;
      for (;;) {
        const r = await harness.call('list_tools', { category, page });
        expect(r.ok, `list_tools(${category})`).toBe(true);
        const result = r.result as {
          recommended: Array<{ name: string }>;
          more: { tools: Array<{ name: string }>; has_more: boolean; next_page?: number };
        };
        allNames.push(...result.recommended.map((t) => t.name));
        allNames.push(...result.more.tools.map((t) => t.name));
        if (!result.more.has_more) break;
        page = result.more.next_page!;
      }
    }
  });

  it('两段式目录:44 精品 + 123 直通 = 167 个操作,无重名', () => {
    expect(allNames).toHaveLength(167);
    expect(new Set(allNames).size).toBe(167);
    // 精品面抽查(每类目至少一个老 MCP 同名工具在场)。
    for (const name of [
      'read_by_url', 'search_and_read', 'media_download', 'meeting_content',
      'docx_read', 'docx_upload_image', 'wiki_read', 'bitable_list_records',
      'sheet_read_range', 'im_send_message', 'im_upload_file', 'contact_search',
      'calendar_create_event',
    ]) {
      expect(allNames, name).toContain(name);
    }
  });

  it('全部 167 个操作空参调用不出现装配级错误(is not defined / Cannot read)', async () => {
    for (const name of allNames) {
      const r = await harness.call('call_tool', { name, args: {} });
      const message = String(r.message ?? '');
      expect(message, `${name}: ${message}`).not.toMatch(/is not defined|Cannot read|undefined is not/);
    }
  });

  it('直通操作:路径模板缺参报 INVALID 且指路 args.path;传参后按 GET 出网', async () => {
    const gen = allNames.find((n) => n.includes('.') && n.startsWith('wiki.'));
    expect(gen).toBeTruthy();
    const missing = await harness.call('call_tool', { name: 'docx.v1.document.rawContent', args: {} });
    expect(missing.ok).toBe(false);
    expect(String(missing.message)).toContain('args.path');
    const before = harness.requests.length;
    const ok = await harness.call('call_tool', {
      name: 'docx.v1.document.rawContent',
      args: { path: { document_id: 'doc 123' } },
    });
    expect(ok.ok).toBe(true);
    const req = harness.requests[before];
    expect(req.url).toContain('/open-apis/docx/v1/documents/doc%20123/raw_content');
    expect(req.method).toBe('GET');
  });

  it('media_download 图片路径:as:media 入总仓并交回取件地址 media_url', async () => {
    const r = await harness.call('call_tool', {
      name: 'media_download',
      args: { file_token: 'tok123' },
    });
    expect(r.ok).toBe(true);
    const result = r.result as { media_url?: string; hash?: string };
    expect(result.media_url).toBe('cindy-media://blobs/x.png');
    expect(result.hash).toBe('a'.repeat(64));
  });

  it('票据语义:下载缺 save_dir / 上传缺 dir·attachments 时报引导话术,不出网', async () => {
    const before = harness.requests.length;
    const dl = await harness.call('call_tool', {
      name: 'media_download',
      args: { file_token: 'tok', resource_type: 'file' },
    });
    expect(dl.ok).toBe(false);
    expect(String(dl.message)).toContain('save_dir');
    const up = await harness.call('call_tool', { name: 'im_upload_file', args: { file_type: 'pdf' } });
    expect(up.ok).toBe(false);
    expect(String(up.message)).toContain('dir');
    const img = await harness.call('call_tool', { name: 'im_upload_image', args: {} });
    expect(img.ok).toBe(false);
    expect(harness.requests.length).toBe(before);
  });

  it('上传走主机代组通道:attachments 指纹 → upload;dir 票据 → uploadDir.fileField', async () => {
    const hash = 'a'.repeat(64);
    await harness.call('call_tool', { name: 'im_upload_image', args: {}, attachments: [hash] });
    const uploadReq = harness.requests.find((r) => r.upload?.hashes?.includes(hash));
    expect(uploadReq).toBeTruthy();
    expect(uploadReq!.url).toContain('/open-apis/im/v1/images');

    const token = '11111111-2222-4333-8444-555555555555';
    await harness.call('call_tool', {
      name: 'im_upload_file',
      args: { file_type: 'pdf' },
      dir_deposit: { token, rel_paths: ['report.pdf'] },
    });
    const dirReq = harness.requests.find((r) => r.uploadDir?.token === token);
    expect(dirReq).toBeTruthy();
    expect(dirReq!.url).toContain('/open-apis/im/v1/files');
    expect(dirReq!.uploadDir!.fileField).toBe('file');
  });

  it('大结果泄洪:超 50KB 经 fs 槽写 workdir 只交路径(out_file 等价回归)', async () => {
    const r = await harness.call('call_tool', {
      name: 'contact_get_user',
      args: { open_id: 'ou_1' },
      out_file: 'tmp/feishu-user.json',
    });
    expect(r.ok).toBe(true);
    expect((r.result as { saved_to?: string }).saved_to).toBe('tmp/feishu-user.json');
    const fsReq = harness.sent.find((m) => m.type === 'fs-request');
    expect(fsReq?.root).toBe('workdir');
  });

  it('元工具边界:未知操作/未知类目报错并给指路', async () => {
    const unknown = await harness.call('call_tool', { name: 'no_such_op', args: {} });
    expect(unknown.ok).toBe(false);
    expect(String(unknown.message)).toContain('list_tools');
    const badCat = await harness.call('list_tools', { category: 'nope' });
    expect(badCat.ok).toBe(false);
  });
});
