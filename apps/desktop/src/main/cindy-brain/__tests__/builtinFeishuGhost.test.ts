/**
 * 内置意识 xd-feishu 的装配级冒烟(与 builtinMivoVideo.test.ts 同范式:
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

const ghostDir = new URL('../../../../resources/builtin-ghosts/xd/xd-feishu/', import.meta.url);
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

function createHarness(fetchOverride?: (request: FetchRequest) => unknown | undefined) {
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
      const overridden = fetchOverride?.(request);
      if (overridden !== undefined) return overridden;
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
  new Script(mainSource, { filename: 'xd-feishu/main.js' }).runInContext(context);
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

describe('builtin xd-feishu ghost', () => {
  it('ghost.json 过 validateGhostManifest,凭证是 oauth + tokenBroker:feishu 单条', () => {
    const v = validateGhostManifest(rawManifest);
    expect(v.ok, v.ok ? '' : v.reason).toBe(true);
    if (!v.ok) return;
    // accounts.feishu.cn 只为 oauth.authorizeUrl 的白名单校验而列;Bearer 注入
    // 仍由 inject.hosts 钳在 open.feishu.cn。
    expect(v.manifest.network?.hosts).toEqual(['open.feishu.cn', 'accounts.feishu.cn']);
    const secret = v.manifest.network?.secrets?.[0];
    expect(v.manifest.network?.secrets).toHaveLength(1);
    expect(secret?.source).toBe('oauth');
    expect(secret?.oauth?.tokenBroker).toBe('feishu');
    // PKCE 缺省开(飞书 broker exchange 吃 codeVerifier);refresh token 依赖
    // offline_access scope,漏了会被 server 按 502 打回。
    expect(secret?.oauth?.pkce).not.toBe(false);
    // scope 全集起点 = 老客户端飞书登录链的申请串逐字搬入(276a55b3f~1
    // authManager 的 authorize scope,生产验证过、控制台必然已开通)——
    // 能力面与迁移前零差别的 parity 契约。改动它 = 改动新用户权限面,且
    // 混入未开通 scope 会 20027 整页拒绝,必须有意为之。
    // 追加(issue #333):`vc:room:readonly` —— 直通接口 vc.v1.meetingList.get
    // (GET /open-apis/vc/v1/meeting_list 查询会议明细)所需权限,老登录链未申请
    // 导致缺 scope 报 99991679;控制台(cli_a94d4cf642381cd4)已开通该历史权限
    // (支持 user_access_token),故有意打破 parity 补入。存量用户需重新授权。
    expect(secret?.oauth?.scopes).toEqual([
      'offline_access',
      'docx:document',
      'bitable:app',
      'wiki:wiki',
      'drive:drive',
      'im:message',
      'im:message.send_as_user',
      'im:message:readonly',
      'im:chat:readonly',
      'im:resource',
      'search:message',
      'calendar:calendar',
      'contact:contact.base:readonly',
      'contact:user.email:readonly',
      'contact:user.department:readonly',
      'contact:user.department_path:readonly',
      'contact:department.base:readonly',
      'contact:user:search',
      'minutes:minutes:readonly',
      'minutes:minutes.artifacts:read',
      'minutes:minutes.search:read',
      'vc:meeting.meetingevent:read',
      'vc:meeting.meetingid:read',
      'vc:record:readonly',
      'vc:reserve:readonly',
      'vc:room:readonly',
      'task:task:read',
      'task:tasklist:read',
      'task:section:read',
      'task:custom_field:read',
      'task:comment:read',
      'task:attachment:read',
    ]);
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
    const result = r.result as { media_url?: string; xdt_image_url?: string; hash?: string; xdt_media_inline?: boolean };
    expect(result.media_url).toBe('cindy-media://blobs/x.png');
    expect(result.xdt_image_url).toBe('cindy-media://blobs/x.png');
    expect(result.hash).toBe('a'.repeat(64));
    // 内联意图令牌:主机层据此把"别嵌 markdown"禁令换成内联指引(图文并茂)。
    expect(result.xdt_media_inline).toBe(true);
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

  it('list_tools 随类目打包共享使用规则(老 MCP bundledRules 同款)', async () => {
    const r = await harness.call('list_tools', { category: 'docx' });
    expect(r.ok).toBe(true);
    const result = r.result as {
      recommended: Array<{ name: string; rules?: string[] }>;
      rules?: Record<string, string>;
    };
    // 精品工具条目引用规则 key。
    const docxRead = result.recommended.find((t) => t.name === 'docx_read');
    expect(docxRead?.rules).toEqual(['read']);
    const docxAppend = result.recommended.find((t) => t.name === 'docx_append_blocks');
    expect(docxAppend?.rules).toEqual(['docx-edit', 'mutation-confirm']);
    // 顶层 rules 打包全文:read(读取行为规范)+ 写约定 + 直通说明。
    expect(Object.keys(result.rules ?? {}).sort()).toEqual(
      ['docx-edit', 'generated-tools', 'mutation-confirm', 'read'],
    );
    expect(result.rules!.read).toContain('总原则:文字 + 附件 并茂');
    expect(result.rules!.read).toContain('完整性硬规矩');
    expect(result.rules!.read).toContain('display_hints');
    expect(result.rules!['mutation-confirm']).toContain('AskUserQuestion');
    // im 类目:read 规则经 im_read_messages 带入,generated-tools 经直通面带入。
    const im = await harness.call('list_tools', { category: 'im' });
    const imRules = (im.result as { rules?: Record<string, string> }).rules ?? {};
    expect(Object.keys(imRules)).toContain('read');
    expect(Object.keys(imRules)).toContain('mutation-confirm');
  });

  it('docx_read 返回对齐老 MCP:评论/user_map/available_images/五套清单/display_hints', async () => {
    const blocks = [
      { block_id: 'b1', block_type: 3, heading1: { elements: [{ text_run: { content: '第一节' } }], style: { folded: true } } },
      {
        block_id: 'b2', block_type: 2,
        text: {
          elements: [
            { text_run: { content: '旧规则', text_element_style: { strikethrough: true } } },
            { text_run: { content: '新规则' } },
            { mention_user: { user_id: 'ou_abc' } },
            { mention_doc: { token: 'doxAAA', obj_type: 22, url: 'https://feishu.cn/docx/doxAAA', title: '引用文档' } },
          ],
        },
      },
      { block_id: 'b3', block_type: 27, image: { token: 'imgTok1' } },
      { block_id: 'b4', block_type: 30, sheet: { token: 'shtX_tab1' } },
      { block_id: 'b5', block_type: 17, todo: { elements: [{ text_run: { content: '待办一' } }], style: { done: true } } },
    ];
    const env = (data: unknown) => ({
      ok: true, status: 200, headers: {},
      body: JSON.stringify({ code: 0, msg: 'ok', data }),
    });
    const h2 = createHarness((req) => {
      if (req.url.includes('/raw_content')) return env({ content: '正文 @ou_abc 测试' });
      if (req.url.includes('/blocks')) return env({ items: blocks, has_more: false });
      if (/\/documents\/D1$/.test(req.url.split('?')[0])) return env({ document: { title: '测试文档' } });
      if (req.url.includes('/comments')) {
        return env({
          items: [{
            comment_id: 'c1', user_id: 'ou_abc', quote: '引用段', is_solved: false,
            reply_list: {
              replies: [{
                reply_id: 'r1', user_id: 'ou_def',
                content: { elements: [{ type: 'text_run', text_run: { text: '同意 ' } }, { type: 'person', person: { user_id: 'ou_abc' } }] },
              }],
            },
          }],
          has_more: false,
        });
      }
      if (req.url.includes('/contact/v3/users/batch')) {
        return env({ items: [{ open_id: 'ou_abc', name: '张三' }, { open_id: 'ou_def', name: '李四' }] });
      }
      if (req.url.includes('/metas/batch_query')) {
        return env({
          metas: [
            { doc_token: 'shtX', title: '数据表', url: 'https://xindong.feishu.cn/sheets/shtX' },
            { doc_token: 'doxAAA', title: '引用文档' },
          ],
          failed_list: [],
        });
      }
      return undefined;
    });
    const r = await h2.call('call_tool', { name: 'docx_read', args: { document_id: 'D1', max_images: 1 } });
    expect(r.ok).toBe(true);
    const doc = (r.result as { data: Record<string, any> }).data;
    // 正文与老字段名。
    expect(doc.text).toBe('正文 @ou_abc 测试');
    expect(doc.text_truncated).toBe(false);
    // 评论:user_name 已解析,回复里 @ou_xxx → @姓名(ou_xxx)。
    expect(doc.comment_count).toBe(1);
    expect(doc.comments[0].user_name).toBe('张三');
    expect(doc.comments[0].replies[0].user_name).toBe('李四');
    expect(doc.comments[0].replies[0].text).toBe('同意 @张三(ou_abc)');
    expect(doc.user_map).toEqual({ ou_abc: '张三', ou_def: '李四' });
    // 图片清单 + 下载标记。
    expect(doc.image_count).toBe(1);
    expect(doc.available_images[0]).toMatchObject({
      index: 1, file_token: 'imgTok1', section_hint: '第一节', downloaded: true,
    });
    expect(doc.images[0].xdt_image_url).toBe('cindy-media://blobs/x.png');
    expect(doc.xdt_image_urls).toEqual(['cindy-media://blobs/x.png']);
    // 五套清单。
    expect(doc.strikethroughs[0]).toMatchObject({ text: '~~旧规则~~新规则', section_hint: '第一节' });
    expect(doc.mentioned_docs[0]).toMatchObject({ token: 'doxAAA', obj_type: 'docx', title: '引用文档' });
    expect(doc.folded_sections[0]).toMatchObject({ level: 1, text: '第一节' });
    expect(doc.todos[0]).toMatchObject({ done: true, text: '待办一', section_hint: '第一节' });
    // 内嵌 sheet:drive.meta 回填标题,canonical URL 补回 ?sheet= 子定位。
    expect(doc.embedded_blocks[0]).toMatchObject({
      type_name: 'sheet', ref: 'shtX_tab1', title: '数据表',
      url: 'https://xindong.feishu.cn/sheets/shtX?sheet=tab1',
    });
    // 预格式化清单(老版第二 text block → display_hints 字段)。
    expect(doc.display_hints).toContain('📊 本文档总览');
    expect(doc.display_hints).toContain('删除线内容');
    expect(doc.display_hints).toContain('`shtX_tab1`');
    // 读文档操作声明内联意图令牌(交卷体顶层,与 data 平级)。
    expect((r.result as { xdt_media_inline?: boolean }).xdt_media_inline).toBe(true);
  });

  it('元工具边界:未知操作/未知类目报错并给指路', async () => {
    const unknown = await harness.call('call_tool', { name: 'no_such_op', args: {} });
    expect(unknown.ok).toBe(false);
    expect(String(unknown.message)).toContain('list_tools');
    const badCat = await harness.call('list_tools', { category: 'nope' });
    expect(badCat.ok).toBe(false);
  });
});
