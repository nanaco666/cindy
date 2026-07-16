/**
 * XD Feishu · 电子脑 —— 内置的飞书服务意识(登录态令牌模式,仅 open.feishu.cn)。
 *
 * 工作方式:
 * - 域名白名单代发:cindy.fetch 只能到 ghost.json 声明的 open.feishu.cn,请求由
 *   主机代发,沙箱零直连;user access token 取自主机飞书登录态
 *   (source:'login-feishu-token',主机自动刷新),本文件没有也不可能有任何
 *   token 字节——用户用飞书登录即用,零配置;
 * - 工具面 = 两段式目录(FORGE_GUIDE §3.5):只声明 list_tools / call_tool 两个
 *   元工具,44 个精品操作 + 100+ 只读直通接口按类目放在本文件的 OPS 表里——与老
 *   lizi_feishu MCP 的渐进式外形一致(recommended / more 两组),主 agent 零学习
 *   成本;改工具只更新意识、不发应用版本;
 * - 直通面(GEN_OPS)由 scripts/gen-feishu-ghost-ops.mts 从 lizi-mcps vendored
 *   的官方定义烘焙(过滤策略同老 MCP:只读 GET + 协作域 + user token),调用
 *   形状固定 args = { path, params, data } 三段;
 * - 本地文件语义全部走过户票据:上传本地文件 = ghost_call 顶层 dir(单文件过户,
 *   uploadDir.fileField)、上传聊天图片 = 顶层 attachments(总仓指纹 upload)、
 *   下载落盘 = 顶层 save_dir(as:'file');文档/消息里的图片经 as:'media' 落
 *   媒体总仓,只交回取件地址——绝对路径与字节都不进沙箱;
 * - 交卷护栏:超 50KB(或调用方点名 out_file)时经 fs 槽把完整 JSON 写进会话
 *   工作目录只交路径——老 MCP out_file 泄洪的等价回归;raw=true 拿原样 JSON;
 * - 写操作(发消息 / 改文档 / 改表格 / 删记录等)描述里带「执行前与用户确认」
 *   约定,与老 MCP 的 mutation-confirm 规则同口径。
 */

/* global cindy */

var API = 'https://open.feishu.cn';
/** 交卷体量护栏(与 cindy-github 同款)。 */
var RESULT_MAX_CHARS = 50 * 1000;

/* ── 基础工具 ───────────────────────────────────────────────────────── */

function fail(message) {
  return { ok: false, message: message };
}

function qs(params) {
  var parts = [];
  for (var k in params) {
    if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
    var v = params[k];
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      for (var i = 0; i < v.length; i++) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v[i])));
    } else {
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    }
  }
  return parts.length ? '?' + parts.join('&') : '';
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * 飞书业务码 → 人话。99991668/99991672 = user access token 失效(主机已在
 * HTTP 401 时自动强刷重试;业务码形态的失效走这里,引导重新登录)。
 */
function classifyFeishu(status, code, msg) {
  if (code === 99991668 || code === 99991672 || status === 401) {
    return '飞书登录态已失效——请用户退出登录后重新用飞书登录(主机会自动刷新令牌,若反复出现请重新登录)';
  }
  if (code === 99991400 || status === 429) {
    return '飞书接口限流,请稍后重试';
  }
  var text = '飞书 API 返回错误' + (code !== null && code !== undefined ? '(code ' + code + ')' : '(HTTP ' + status + ')') + ':' + String(msg || '').slice(0, 300);
  if (code === 99991679 || /permission|scope|Access denied|无权限/i.test(String(msg || ''))) {
    text += '\n提示:若为权限 / scope 报错,需在飞书开放平台为应用添加对应 scope(代码外配置),或该资源确实不对当前账号开放。';
  }
  return text;
}

/**
 * 统一的飞书 OpenAPI 调用。凭证由主机注入,这里只管 URL / 方法 / 体。
 * 飞书信封 { code, msg, data }:HTTP 2xx 且 code===0 才算成功,成功返回
 * { data }(信封里的 data 段;无信封时给原文)。限流自动退避重试 2 次。
 */
async function api(opts) {
  var attempt = 0;
  for (;;) {
    var req = {
      url: opts.url,
      method: opts.method || 'GET',
      headers: {},
      callId: opts.callId,
    };
    if (opts.body !== undefined) {
      req.headers['Content-Type'] = 'application/json';
      req.body = JSON.stringify(opts.body);
    }
    var r = await cindy.fetch(req);
    if (!r.ok) return { err: r.message };
    var d = null;
    if (r.body) {
      try { d = JSON.parse(r.body); } catch (e) { d = null; }
    }
    var bizCode = d && typeof d.code === 'number' ? d.code : null;
    var failed = r.status < 200 || r.status >= 300 || (bizCode !== null && bizCode !== 0);
    if (!failed) {
      return {
        data: d ? (d.data !== undefined ? d.data : d) : null,
        envelope: d,
        status: r.status,
        headers: r.headers || {},
      };
    }
    var isRateLimited = bizCode === 99991400 || r.status === 429;
    if (isRateLimited && attempt < 2) {
      attempt++;
      await sleep(500 * Math.pow(3, attempt - 1));
      continue;
    }
    var msg = (d && (d.msg || d.message)) || (typeof r.body === 'string' ? r.body.slice(0, 300) : '');
    return { err: classifyFeishu(r.status, bizCode, msg) };
  }
}

/**
 * 瘦身:飞书响应里的头像多档 URL 对 LLM 无用(avatar / avatar_72 / avatar_240
 * / avatar_640 / avatar_origin / avatar_url…),递归剥掉压体量;其余原样保留
 * (飞书信封本身不像 GitHub 那样带大量 API 链接字段)。raw=true 时跳过。
 */
function slim(value) {
  if (Array.isArray(value)) return value.map(slim);
  if (value && typeof value === 'object') {
    var out = {};
    for (var k in value) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
      if (k === 'avatar' || k.indexOf('avatar_') === 0) continue;
      out[k] = slim(value[k]);
    }
    return out;
  }
  return value;
}

/**
 * 交卷:默认瘦身;超长(或调用方点名 out_file)时经 fs 槽把完整 JSON 写进会话
 * 工作目录,只交回文件路径——老 MCP out_file 泄洪的等价回归。写盘跟随会话
 * 权限模式,被拒/失败/远程工作区时回落截断 + 分页提示。
 */
async function deliver(data, raw, outFile, callId) {
  var payload = raw ? data : slim(data === undefined ? null : data);
  var text = JSON.stringify(payload === undefined ? null : payload);
  if (!outFile && text.length <= RESULT_MAX_CHARS) return { ok: true, result: { data: payload } };
  var spillNote = null;
  if (callId) {
    var fileName = outFile || 'feishu-result-' + String(callId).slice(0, 8) + '.json';
    var w = await cindy.send({
      type: 'fs-request', op: 'write', root: 'workdir',
      path: fileName, content: text, callId: callId,
    });
    if (w && w.ok) {
      return {
        ok: true,
        result: {
          saved_to: w.path,
          bytes: w.bytes,
          hint: '完整结果已写入会话工作目录的该相对路径,用文件工具读取或交给脚本处理',
        },
      };
    }
    spillNote = w && w.message ? '落盘未成功(' + w.message + ')' : '落盘未成功';
  }
  if (text.length <= RESULT_MAX_CHARS) {
    return { ok: true, result: { data: payload, note: spillNote } };
  }
  return {
    ok: true,
    result: {
      truncated: true,
      hint:
        (spillNote ? spillNote + ';' : '') +
        '响应过大已截断——用 page_size / page_token 分页,或换更窄的操作(如读单条)',
      preview: text.slice(0, RESULT_MAX_CHARS),
    },
  };
}

/* ── 媒体 / 文件通道助手(过户票据语义,FORGE_GUIDE §4.7) ─────────── */

/** 从 args.attachments 条目里抽总仓指纹(64 位十六进制;容忍 cindy-media://blobs/<hash>.<ext> 形态)。 */
function extractHash(entry) {
  if (typeof entry !== 'string') return null;
  var m = entry.match(/[a-f0-9]{64}/);
  return m ? m[0] : null;
}

/**
 * 下载媒体(图片等)进媒体总仓:as:'media',字节不进沙箱,只回取件地址。
 * 非媒体类型 / 失败时返回 { err }。
 */
async function mediaSave(url, callId, label) {
  var r = await cindy.fetch({
    url: url,
    as: 'media',
    label: label,
    timeoutMs: 120000,
    callId: callId,
  });
  if (!r.ok) return { err: r.message };
  if (!r.media) {
    var snippet = typeof r.body === 'string' ? r.body.slice(0, 300) : '';
    var d = null;
    try { d = JSON.parse(snippet); } catch (e) { d = null; }
    return { err: classifyFeishu(r.status, d && d.code, (d && d.msg) || snippet) };
  }
  return { media: r.media };
}

/** 下载任意类型文件到用户目录:须 save_dir 票据(as:'file')。 */
async function saveFile(url, a, callId, suggestedName) {
  if (!a.save_deposit || !a.save_deposit.token) {
    return { err: '下载需要落盘目录——请主 agent 调 ghost_call 时把目标目录绝对路径放在顶层 save_dir 参数' };
  }
  var r = await cindy.fetch({
    url: url,
    as: 'file',
    saveTo: { token: a.save_deposit.token, filename: a.filename || suggestedName },
    timeoutMs: 300000,
    callId: callId,
  });
  if (!r.ok) return { err: r.message };
  if (!r.file) {
    var snippet = typeof r.body === 'string' ? r.body.slice(0, 300) : '';
    var d = null;
    try { d = JSON.parse(snippet); } catch (e) { d = null; }
    return { err: classifyFeishu(r.status, d && d.code, (d && d.msg) || snippet) };
  }
  return {
    result: {
      downloaded: true,
      dir_name: a.save_deposit.dir_name,
      file_name: r.file.file_name,
      bytes: r.file.bytes,
      note: '已存到 ' + a.save_deposit.dir_name + '/' + r.file.file_name,
    },
  };
}

/**
 * 上传"总仓媒体"(聊天图片经 attachments 过户 / 本意识名下产物):
 * upload 通道,主机验归属读字节代组 multipart。返回 api() 同款信封处理。
 */
async function uploadMedia(url, hashes, field, fields, callId) {
  var r = await cindy.fetch({
    url: url,
    method: 'POST',
    upload: { hashes: hashes, field: field || 'file', fields: fields || undefined },
    timeoutMs: 300000,
    callId: callId,
  });
  return parseUploadResponse(r);
}

/**
 * 上传"本地文件"(主 agent 经 ghost_call 顶层 dir 过户的单文件):
 * uploadDir 通道 + fileField 精确字段名。
 */
async function uploadWorkdirFile(url, depositToken, fileField, fields, callId) {
  var r = await cindy.fetch({
    url: url,
    method: 'POST',
    uploadDir: { token: depositToken, fields: fields || undefined, fileField: fileField || 'file' },
    timeoutMs: 300000,
    callId: callId,
  });
  return parseUploadResponse(r);
}

function parseUploadResponse(r) {
  if (!r.ok) return { err: r.message };
  var d = null;
  if (r.body) {
    try { d = JSON.parse(r.body); } catch (e) { d = null; }
  }
  var bizCode = d && typeof d.code === 'number' ? d.code : null;
  if (r.status < 200 || r.status >= 300 || (bizCode !== null && bizCode !== 0)) {
    var msg = (d && (d.msg || d.message)) || (typeof r.body === 'string' ? r.body.slice(0, 300) : '');
    return { err: classifyFeishu(r.status, bizCode, msg) };
  }
  return { data: d ? (d.data !== undefined ? d.data : d) : null };
}

/* ── 时间解析(老 MCP time.ts 的沙箱版) ────────────────────────────── */

/**
 * 把 unix 秒 / unix 毫秒 / RFC3339(带 Z 或 ±hh:mm 偏移)统一成 unix 秒字符串。
 * 无时区的裸本地时间("2026-07-16 10:00")按 time_zone 参数解析:数字偏移
 * ("+08:00")直接算;IANA 名字尽力用 Intl 换算,环境不支持时按 +08:00 兜底。
 * 解析失败返回 null(调用方报参数错)。
 */
function parseTs(input, timeZone) {
  if (input === undefined || input === null || input === '') return null;
  var s = String(input).trim();
  if (/^\d{13}$/.test(s)) return String(Math.floor(Number(s) / 1000));
  if (/^\d{9,12}$/.test(s)) return s;
  // RFC3339 带时区:Date.parse 可靠。
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    var t = Date.parse(s.replace(' ', 'T'));
    return isNaN(t) ? null : String(Math.floor(t / 1000));
  }
  // 裸日期/时间:按 time_zone 解析。
  var m = s.replace(' ', 'T').match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) {
    var loose = Date.parse(s);
    return isNaN(loose) ? null : String(Math.floor(loose / 1000));
  }
  var utcGuess = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0),
  );
  var offsetMin = tzOffsetMinutes(timeZone, utcGuess);
  return String(Math.floor(utcGuess / 1000) - offsetMin * 60);
}

/** time_zone("+08:00" 数字偏移或 IANA 名)→ 相对 UTC 的分钟偏移。 */
function tzOffsetMinutes(timeZone, atUtcMs) {
  var tz = timeZone || 'Asia/Shanghai';
  var m = String(tz).match(/^([+-])(\d{2}):?(\d{2})$/);
  if (m) return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  try {
    var fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    var parts = {};
    var arr = fmt.formatToParts(new Date(atUtcMs));
    for (var i = 0; i < arr.length; i++) parts[arr[i].type] = arr[i].value;
    var asUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour === '24' ? 0 : parts.hour), Number(parts.minute), Number(parts.second),
    );
    return Math.round((asUtc - atUtcMs) / 60000);
  } catch (e) {
    return 480; // Intl 不可用:按 +08:00 兜底(产品主用户群时区)
  }
}

/* ── 飞书 URL 解析(read_by_url 与 docx/sheet/bitable 工具共用) ────── */

/**
 * 解析飞书链接:识别 /wiki/<token>、/docx/<token>、/docs/<token>、
 * /base/<token>、/sheets/<token>、/minutes/<token>,容忍 *.feishu.cn /
 * *.larksuite.com 域与查询参数。返回 { kind, token, query } 或 null。
 */
function parseFeishuUrl(input) {
  var s = String(input || '').trim();
  var m = s.match(/https?:\/\/[^/]+\/(wiki|docx|docs|base|sheets|minutes|file)\/([A-Za-z0-9]+)(?:[?#]([^ ]*))?/);
  if (!m) return null;
  var query = {};
  if (m[3]) {
    var pairs = m[3].split('&');
    for (var i = 0; i < pairs.length; i++) {
      var kv = pairs[i].split('=');
      if (kv[0]) query[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
    }
  }
  return { kind: m[1], token: m[2], query: query };
}

/** 翻页拉全(内部聚合;上限 pages 页防失控)。fetchPage(pageToken) → {err}|{data:{items,page_token,has_more}}。 */
async function paginateAll(fetchPage, maxPages) {
  var items = [];
  var token = undefined;
  for (var i = 0; i < (maxPages || 20); i++) {
    var r = await fetchPage(token);
    if (r.err) return { err: r.err };
    var d = r.data || {};
    var arr = d.items || [];
    for (var j = 0; j < arr.length; j++) items.push(arr[j]);
    if (!d.has_more || !d.page_token) break;
    token = d.page_token;
  }
  return { items: items };
}

/* ── 操作目录 ───────────────────────────────────────────────────────────
 * 每个操作:{ cat, desc, params(参数说明,给 list_tools 与纠错回显), run,
 * gen?(直通面标记), write?(写操作标记,list_tools 提示确认约定) }。
 * run(a, callId) 返回 { err } | { data } | { result }(result = 已定型交卷体)。
 * 参数记法:* = 必填;pp = page_size?/page_token?。
 * ──────────────────────────────────────────────────────────────────── */

var PP_DOC = 'page_size?:int, page_token?:string';

var CATEGORIES = {
  misc: '按飞书 URL 读内容 / 搜索并阅读 / 素材下载',
  docx: '云文档:读全文 / 块级增删改 / 建表格 / 传图',
  wiki: '知识库:空间 / 节点树 / 读节点 / 建节点',
  bitable: '多维表格:表 / 字段 / 记录全生命周期',
  sheet: '电子表格:页签 / 读写区间 / 追加行',
  im: '消息:会话列表 / 读消息 / 搜消息 / 发消息 / 传图传文件',
  contact: '通讯录:搜人 / 查用户',
  calendar: '日历:列日程 / 查日程 / 建日程',
  minutes: '会议:按日期定位会议纪要 / 妙记 / 录制内容',
  drive: '云空间文件(只读直通):文件列表 / 元数据 / 权限',
  vc: '视频会议(只读直通):会议 / 录制 / 报表',
  task: '任务(只读直通,task v2):任务 / 清单 / 评论',
};

var OPS = {};

function op(name, cat, desc, params, run) {
  OPS[name] = { cat: cat, desc: desc, params: params, run: run };
}

/** 写操作注册(list_tools 展示「执行前与用户确认」约定,老 MCP mutation-confirm 同口径)。 */
function wop(name, cat, desc, params, run) {
  OPS[name] = { cat: cat, desc: desc, params: params, run: run, write: true };
}

/* ── 直通面(GEN_OPS):args 固定 { path, params, data } 三段 ─────────── */

/** :param 逐段替换(与老 MCP genTools.fillPath 同语义)。 */
function fillPath(template, pathArgs) {
  var missing = null;
  var out = template.replace(/:([A-Za-z0-9_]+)/g, function (_full, key) {
    var v = pathArgs ? pathArgs[key] : undefined;
    if (v === undefined || v === null || v === '') {
      missing = missing || key;
      return ':' + key;
    }
    return encodeURIComponent(String(v));
  });
  if (missing) return { missing: missing };
  return { url: out };
}

/** 直通操作注册(由 scripts/gen-feishu-ghost-ops.mts 生成的表驱动)。 */
function gop(name, cat, method, path, desc, spec) {
  OPS[name] = {
    cat: cat,
    desc: desc,
    params: (spec || '(无参数)') + ' —— args 固定 path / params / data 三段',
    gen: true,
    run: async function (a, c) {
      var filled = fillPath(path, a.path || {});
      if (filled.missing) {
        return { err: '路径参数 ' + filled.missing + ' 必填,请放在 args.path.' + filled.missing };
      }
      var url = API + filled.url + qs(a.params || {});
      var r = await api({ url: url, method: method, body: method === 'GET' ? undefined : a.data, callId: c });
      if (r.err) return { err: r.err + '\nendpoint: ' + method + ' ' + path };
      return { data: r.data };
    },
  };
}

/* ═══ 精品操作(从老 lizi_feishu MCP server.ts 逐一移植) ═══════════ */

// <PART:MISC>
/* ═══ PART:MISC —— misc / minutes / contact / calendar 精品操作 ═══════════
 * 从老 lizi_feishu MCP(packages/lizi-mcps/src/feishu/mcp/server.ts)移植。
 * 依赖拼接后 main.js 提供的骨架助手(api / qs / pg / fail / mediaSave /
 * saveFile / parseTs / tzOffsetMinutes / parseFeishuUrl / paginateAll /
 * op / wop / API)以及 PART:DOCX_WIKI 提供的 readDocCore / resolveWikiNode,
 * 本文件不重复定义。
 *
 * 与老版的刻意差异(其余逐一对齐):
 * - 图片/媒体不回 base64 内容块:image 走媒体总仓(mediaSave → media_url),
 *   file 走 save_dir 过户票据落盘(saveFile);
 * - meeting_content 命中唯一场且要正文时经 readDocCore 读全文(图同上语义)。
 */

/* ── misc 私有辅助 ──────────────────────────────────────────────────── */

/** 老 MCP searchDocs 同款:POST /suite/docs-api/search/object(SDK 未覆盖的老端点)。 */
async function miscSearchDocs(query, docsTypes, count, callId) {
  return api({
    url: API + '/open-apis/suite/docs-api/search/object',
    method: 'POST',
    body: { search_key: query, count: count, docs_types: docsTypes },
    callId: callId,
  });
}

/** 限并发 async map(老 MCP mapWithConcurrency 同款;单日会议/多篇文档量级小,3 路防限流)。 */
async function miscMapConcurrent(items, concurrency, fn) {
  var out = new Array(items.length);
  var cursor = 0;
  async function worker() {
    for (;;) {
      var i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  var n = Math.max(1, Math.min(concurrency, items.length || 1));
  var workers = [];
  for (var k = 0; k < n; k++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

/** 列序号 → 字母(1→A, 27→AA;电子表格默认读取范围用)。 */
function miscColLetter(n) {
  var s = '';
  var v = Math.max(1, Math.floor(n));
  while (v > 0) {
    var rem = (v - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s;
}

/**
 * 读多维表格:tableId 有值时读该表前 20 条记录预览,否则列全部数据表
 * (老 read_by_url 的 base 分支同款行为)。
 */
async function miscReadBitableCore(appToken, tableId, callId) {
  if (tableId) {
    var rec = await api({
      url: API + '/open-apis/bitable/v1/apps/' + encodeURIComponent(appToken) +
        '/tables/' + encodeURIComponent(tableId) + '/records' + qs({ page_size: 20 }),
      callId: callId,
    });
    if (rec.err) return { err: rec.err };
    var rd = rec.data || {};
    return {
      data: {
        resource_type: 'bitable',
        app_token: appToken,
        table_id: tableId,
        records: rd.items || [],
        total: rd.total,
        has_more: !!rd.has_more,
        page_token: rd.has_more ? rd.page_token : undefined,
        hint: '仅前 20 条预览;完整读取/筛选用 bitable 类操作',
      },
    };
  }
  var tb = await api({
    url: API + '/open-apis/bitable/v1/apps/' + encodeURIComponent(appToken) + '/tables',
    callId: callId,
  });
  if (tb.err) return { err: tb.err };
  return {
    data: {
      resource_type: 'bitable',
      app_token: appToken,
      tables: (tb.data && tb.data.items) || [],
      hint: '读记录:URL 带 ?table= 重调 read_by_url,或用 bitable 类操作',
    },
  };
}

/**
 * 读电子表格:v3 sheets/query 列页签 → 选 URL ?sheet= 指定页签(缺省首个)→
 * 按页签真实行列数拼精确 range 走 v2 values 读取(老 readSheetRange 的
 * "列页签 + 读取"主路径;内嵌 bitable 页签不深挖,提示改走 bitable 操作)。
 */
async function miscReadSheetCore(spreadsheetToken, urlQuery, callId) {
  var tabs = await api({
    url: API + '/open-apis/sheets/v3/spreadsheets/' + encodeURIComponent(spreadsheetToken) + '/sheets/query',
    callId: callId,
  });
  if (tabs.err) return { err: tabs.err };
  var sheets = (tabs.data && tabs.data.sheets) || [];
  var listed = [];
  for (var i = 0; i < sheets.length; i++) {
    listed.push({
      sheet_id: sheets[i].sheet_id,
      title: sheets[i].title,
      index: sheets[i].index,
      hidden: sheets[i].hidden,
      resource_type: sheets[i].resource_type,
    });
  }
  var hint = urlQuery && urlQuery.sheet;
  var target = null;
  for (var j = 0; j < sheets.length; j++) {
    if (hint && sheets[j].sheet_id === hint) { target = sheets[j]; break; }
  }
  if (!target) {
    for (var k = 0; k < sheets.length; k++) {
      if (sheets[k].sheet_id) { target = sheets[k]; break; }
    }
  }
  if (!target) return { err: '该电子表格下没有可读取的页签' };
  var out = {
    resource_type: 'sheet',
    spreadsheet_token: spreadsheetToken,
    sheet_id: target.sheet_id,
    sheet_title: target.title,
    sheets: listed,
  };
  if (target.resource_type && target.resource_type !== 'sheet') {
    out.note = '目标页签类型为 ' + target.resource_type +
      '(如内嵌多维表格),本操作只读网格页签;该页签请用 bitable 类操作按记录读取';
    return { data: out };
  }
  var gp = target.grid_properties || {};
  var rowCount = gp.row_count || 0;
  var colCount = gp.column_count || 0;
  if (rowCount <= 0 || colCount <= 0) {
    out.range = target.sheet_id + '!A1:A1';
    out.values = [];
    return { data: out };
  }
  var range = target.sheet_id + '!A1:' + miscColLetter(colCount) + rowCount;
  var vr = await api({
    url: API + '/open-apis/sheets/v2/spreadsheets/' + encodeURIComponent(spreadsheetToken) +
      '/values/' + encodeURIComponent(range) + '?valueRenderOption=ToString',
    callId: callId,
  });
  if (vr.err) return { err: vr.err };
  var valueRange = (vr.data && vr.data.valueRange) || {};
  var values = Array.isArray(valueRange.values) ? valueRange.values : [];
  out.range = valueRange.range || range;
  out.row_count = values.length;
  out.values = values;
  return { data: out };
}

/* ── misc:URL 读取 / 搜索阅读 / 素材下载 ──────────────────────────── */

op(
  'read_by_url',
  'misc',
  '按飞书 URL 直接读内容(wiki/docx/docs/base/sheets 全支持)。docx 与 wiki 文档节点:返回全文 + 图片清单 + 评论 + 待办(wiki 自动解析到真实对象,bitable/sheet 节点自动分派);/base/*:列数据表(URL 带 ?table= 时读该表前 20 条记录);/sheets/*:列页签 + 读 URL ?sheet= 指定(缺省首个)网格页签的单元格。max_images>0 时按序把图存进媒体总仓并给回 media_url——总结时用 ![](media_url) 嵌进对应章节展示;默认 0 只给 images 清单(含 file_token/section),需要哪张再调 media_download 单拉。文档里的外部链接绝不代为访问,只做成超链交给用户',
  'url*:string(飞书链接), max_images?:int(0-20,默认 0)',
  async function (a, c) {
    if (!a.url) return { err: '需要 url(飞书文档/表格/知识库链接)' };
    var parsed = parseFeishuUrl(a.url);
    if (!parsed) {
      return { err: '无法识别的飞书链接:' + a.url + '(支持 /wiki /docx /docs /base /sheets 路径)' };
    }
    var maxImages = Math.max(0, Math.min(20, Number(a.max_images) || 0));
    if (parsed.kind === 'wiki') {
      var n = await resolveWikiNode(parsed.token, undefined, c);
      if (n.err) return { err: n.err };
      var node = n.node;
      if (node.obj_type === 'bitable') return miscReadBitableCore(node.obj_token, parsed.query.table, c);
      if (node.obj_type === 'sheet') return miscReadSheetCore(node.obj_token, parsed.query, c);
      if (node.obj_type === 'docx' || node.obj_type === 'doc') {
        var wr = await readDocCore(node.obj_token, maxImages, c);
        if (wr.err) return { err: wr.err };
        return { data: wr.doc };
      }
      return { err: 'wiki 节点类型 ' + node.obj_type + ' 暂不支持读取(支持 docx / sheet / bitable)' };
    }
    if (parsed.kind === 'docx' || parsed.kind === 'docs') {
      var dr = await readDocCore(parsed.token, maxImages, c);
      if (dr.err) return { err: dr.err };
      return { data: dr.doc };
    }
    if (parsed.kind === 'sheets') return miscReadSheetCore(parsed.token, parsed.query, c);
    if (parsed.kind === 'base') return miscReadBitableCore(parsed.token, parsed.query.table, c);
    if (parsed.kind === 'minutes') {
      return { err: '妙记链接请改用 meeting_content(按日期+会议名定位),或 minutes 类直通接口' };
    }
    return { err: '暂不支持 /' + parsed.kind + ' 链接(云盘文件请用 drive 类操作,素材下载用 media_download)' };
  },
);

op(
  'search_and_read',
  'misc',
  '搜索飞书云文档/知识库/多维表格并逐篇读回内容,跨文档汇总场景用。docx 与 wiki 文档返回全文 + 图片清单 + 评论(总结时评论务必一起带上);wiki 节点自动解析(bitable/sheet 分派对应读法);bitable 返回数据表列表。max_images 是每篇的图片配额(下载进媒体总仓给 media_url),多篇场景慎用大值',
  'query*:string(关键词), max_docs?:int(默认 5,最多 20), type?:wiki|docx|bitable(限定范围,缺省全搜), max_images?:int(每篇 0-20,默认 0)',
  async function (a, c) {
    if (!a.query) return { err: '需要 query(搜索关键词)' };
    var typeMap = { wiki: [15], docx: [22], bitable: [8] };
    var docsTypes = a.type ? typeMap[a.type] : [8, 15, 22];
    if (!docsTypes) return { err: 'type 只支持 wiki / docx / bitable' };
    var maxDocs = Math.max(1, Math.min(20, Number(a.max_docs) || 5));
    var maxImages = Math.max(0, Math.min(20, Number(a.max_images) || 0));
    var sr = await miscSearchDocs(a.query, docsTypes, maxDocs, c);
    if (sr.err) return { err: sr.err };
    var entities = (sr.data && sr.data.docs_entities) || [];
    if (!entities.length) return { data: { documents: [], message: '没有搜到文档' } };
    var documents = await miscMapConcurrent(entities, 3, async function (entity) {
      var meta = {
        title: entity.title,
        url: entity.url,
        doc_token: entity.docs_token,
        docs_type: entity.docs_type,
      };
      if (!entity.docs_token) { meta.error = '缺 docs_token'; return meta; }
      // bitable:保持表列表形态(无图无评论)。
      if (entity.docs_type === 8) {
        var bt = await miscReadBitableCore(entity.docs_token, undefined, c);
        if (bt.err) meta.error = bt.err; else meta.content = bt.data;
        return meta;
      }
      // wiki:先解析 obj_token 再按 obj_type 分派。
      var targetToken = entity.docs_token;
      if (entity.docs_type === 15) {
        var n = await resolveWikiNode(entity.docs_token, undefined, c);
        if (n.err) { meta.error = n.err; return meta; }
        if (!n.node || !n.node.obj_token) { meta.error = '无法解析 wiki 节点'; return meta; }
        if (n.node.obj_type === 'bitable') {
          var wb = await miscReadBitableCore(n.node.obj_token, undefined, c);
          if (wb.err) meta.error = wb.err; else meta.content = wb.data;
          return meta;
        }
        if (n.node.obj_type === 'sheet') {
          var ws = await miscReadSheetCore(n.node.obj_token, null, c);
          if (ws.err) meta.error = ws.err; else meta.content = ws.data;
          return meta;
        }
        targetToken = n.node.obj_token;
      }
      // docx(或 wiki 解析出的 docx)。
      var r = await readDocCore(targetToken, maxImages, c);
      if (r.err) meta.error = r.err; else meta.content = r.doc;
      return meta;
    });
    return { data: { documents: documents } };
  },
);

op(
  'media_download',
  'misc',
  '下载飞书素材。两条路径:云文档/云盘素材(file_token 来自文档返回的 images/file 块,只传 file_token;多维表格附件可能需要 extra);IM 消息资源(file_token 传 im 消息里的 file_key,并必须带 message_id)。resource_type=image(默认):存进媒体总仓,返回 media_url——在最终回复的 markdown 里用 ![](media_url) 展示;resource_type=file(PDF/zip 等真附件):落盘到用户目录,需要主 agent 调 ghost_call 时在顶层传 save_dir。静默执行:下载过程不要口播,只在最终回复里嵌图/列附件清单',
  'file_token*:string(素材 token 或 IM file_key), message_id?:string(IM 消息资源必传,如 om_*), resource_type?:image|file(默认 image), extra?:string(云文档路径的 extra 参数,多维表格附件用), filename?:string(file 落盘时的文件名)',
  async function (a, c) {
    if (!a.file_token) return { err: '需要 file_token(云文档素材 token 或 IM 消息 file_key)' };
    var kind = a.resource_type || 'image';
    if (kind !== 'image' && kind !== 'file') return { err: 'resource_type 只支持 image / file(缺省 image)' };
    var url;
    if (a.message_id) {
      url = API + '/open-apis/im/v1/messages/' + encodeURIComponent(a.message_id) +
        '/resources/' + encodeURIComponent(a.file_token) + qs({ type: kind });
    } else {
      url = API + '/open-apis/drive/v1/medias/' + encodeURIComponent(a.file_token) +
        '/download' + qs({ extra: a.extra });
    }
    if (kind === 'file') {
      return saveFile(url, a, c, a.filename || ('feishu-' + String(a.file_token).slice(0, 16)));
    }
    var m = await mediaSave(url, c, 'feishu media ' + a.file_token);
    if (m.err) {
      return {
        err: m.err +
          '\n(若该素材不是图片/媒体类型,请传 resource_type:"file" 并让主 agent 在 ghost_call 顶层带 save_dir 落盘)',
      };
    }
    return {
      result: {
        file_token: a.file_token,
        media_url: m.media.url,
        hash: m.media.hash,
        note: '已入媒体总仓;在最终回复的 markdown 里用 ![](media_url) 展示,不要口播下载过程',
      },
    };
  },
);

/* ── minutes 私有辅助(meetingNotes.ts 纯函数移植,mn 前缀) ─────────── */

/** 浅合并(沙箱不用对象展开语法)。 */
function mnAssign(target, extra) {
  for (var k in extra) {
    if (Object.prototype.hasOwnProperty.call(extra, k)) target[k] = extra[k];
  }
  return target;
}

// 智能纪要标题形如「智能纪要:06-18 | 小镇周会 2026年6月18日」;
// 「MM-DD |」前缀时有时无,分隔符 | / ｜、冒号半角/全角都可能。
var MN_TITLE_RE = /^智能纪要[:：]\s*(?:\d{1,2}-\d{1,2}\s*[|｜]\s*)?(.+?)\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*$/;

/** 解析智能纪要标题 → { meetingName, year, month, day };非该格式返回 null。 */
function mnParseNotesTitle(title) {
  var m = MN_TITLE_RE.exec(String(title || '').trim());
  if (!m) return null;
  var meetingName = m[1].trim();
  if (!meetingName) return null;
  return { meetingName: meetingName, year: Number(m[2]), month: Number(m[3]), day: Number(m[4]) };
}

// 目标日期接受:2026-06-18 / 2026/6/18 / 2026年6月18日。
var MN_TARGET_DATE_RE = /^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?$/;

/** 归一化目标日期 → { year, month, day };非法返回 null。 */
function mnParseTargetDate(date) {
  var m = MN_TARGET_DATE_RE.exec(String(date || '').trim());
  if (!m) return null;
  var year = Number(m[1]);
  var month = Number(m[2]);
  var day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year: year, month: month, day: day };
}

/** 构造 docx 搜索 query:`智能纪要 <会议名> <YYYY年M月D日>`(月/日不补零,匹配飞书标题格式)。 */
function mnBuildNotesQuery(meetingName, d) {
  return '智能纪要 ' + String(meetingName).trim() + ' ' + d.year + '年' + d.month + '月' + d.day + '日';
}

/** 会议名匹配:去空格后双向子串容错。 */
function mnNameMatches(titleName, targetName) {
  var a = String(titleName || '').replace(/\s+/g, '');
  var b = String(targetName || '').replace(/\s+/g, '');
  if (!a || !b) return false;
  return a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
}

/**
 * 从候选 docx 里挑「会议名匹配 + 日期完全一致」的智能纪要,按 token 去重——
 * 确定性闸门,防止搜索 ranking 把同系列别的日期那篇顶上来。
 */
function mnPickMatchingNotes(candidates, targetName, target) {
  var out = [];
  var seen = {};
  for (var i = 0; i < candidates.length; i++) {
    var cand = candidates[i];
    if (!cand.token || seen[cand.token]) continue;
    var parsed = mnParseNotesTitle(cand.title);
    if (!parsed) continue;
    if (parsed.year !== target.year || parsed.month !== target.month || parsed.day !== target.day) continue;
    if (!mnNameMatches(parsed.meetingName, targetName)) continue;
    seen[cand.token] = 1;
    out.push(cand);
  }
  return out;
}

/**
 * instanceView 实例 → 「当天真实会议」归一化 + 按开始时间升序:
 * 排除全天事件(无 start timestamp)/已取消/空标题。
 */
function mnPickDayMeetingInstances(items) {
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.status === 'cancelled') continue;
    var startSeconds = Number(it.startTimestamp);
    if (!it.startTimestamp || !isFinite(startSeconds)) continue;
    var summary = String(it.summary || '').trim();
    if (!summary) continue;
    var endNum = Number(it.endTimestamp);
    var endSeconds = it.endTimestamp && isFinite(endNum) ? endNum : null;
    out.push({
      summary: summary,
      startSeconds: startSeconds,
      endSeconds: endSeconds,
      attendeeAbility: it.attendeeAbility || null,
      organizerDisplayName: it.organizerDisplayName || null,
    });
  }
  out.sort(function (x, y) { return x.startSeconds - y.startSeconds; });
  return out;
}

/** 「docx 命中 / 妙记命中 / 本人是否组织者」→ 状态标签(docx 优先)。 */
function mnClassifyMeetingContentStatus(input) {
  if (input.docHit) return 'got_notes_doc';
  if (input.minutesHit) return 'got_minutes';
  return input.isSelfOrganizer ? 'missing_no_record' : 'missing_not_organizer';
}

/** 从飞书录制 URL(https://meetings.feishu.cn/minutes/<token>)解析 minutes_token。 */
function mnParseMinutesTokenFromUrl(url) {
  var match = String(url || '').match(/\/minutes\/([a-z0-9]+)\/?(?:\?.*)?$/);
  return match ? match[1] : null;
}

/**
 * 解析 VC meeting_list 的时间字符串 → Unix 秒:纯数字(Unix 秒)或
 * "2022.12.23 11:16:59 (GMT+08:00)" 人类可读格式。
 */
function mnParseVcMeetingTime(timeStr) {
  var trimmed = String(timeStr || '').trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  var m = trimmed.match(/^(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  var tzMatch = trimmed.match(/\(GMT([+-])(\d{2}):(\d{2})\)/);
  var offsetMs = 8 * 60 * 60000; // 默认 +08:00
  if (tzMatch) {
    var sign = tzMatch[1] === '+' ? 1 : -1;
    offsetMs = sign * (parseInt(tzMatch[2], 10) * 60 + parseInt(tzMatch[3], 10)) * 60000;
  }
  var utcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - offsetMs;
  return Math.floor(utcMs / 1000);
}

function mnPad2(n) {
  return (n < 10 ? '0' : '') + n;
}

/** Unix 秒 → 指定时区的 'YYYY-MM-DD HH:mm'(复用骨架 tzOffsetMinutes)。 */
function mnFormatSecondsInZone(seconds, timeZone) {
  var off = tzOffsetMinutes(timeZone, seconds * 1000);
  var iso = new Date((seconds + off * 60) * 1000).toISOString();
  return iso.slice(0, 10) + ' ' + iso.slice(11, 16);
}

/** Unix 秒 → 指定时区的 'YYYY-MM-DD'。 */
function mnYmdInZone(seconds, timeZone) {
  return mnFormatSecondsInZone(seconds, timeZone).slice(0, 10);
}

/** 每场会 status → 一句中文覆盖率概览。 */
function mnBuildSummaryLine(date, events) {
  var n = events.length;
  if (n === 0) return date + ' 当天没有会议(或你无访问权)。';
  var got = 0;
  var missNotOrg = 0;
  var missNoRec = 0;
  for (var i = 0; i < events.length; i++) {
    var s = events[i].status;
    if (s === 'got_notes_doc' || s === 'got_minutes') got++;
    else if (s === 'missing_not_organizer') missNotOrg++;
    else if (s === 'missing_no_record') missNoRec++;
  }
  var parts = [got + ' 场拿到纪要'];
  if (missNotOrg) parts.push(missNotOrg + ' 场因非组织者拿不到妙记');
  if (missNoRec) parts.push(missNoRec + ' 场未开妙记/未生成纪要');
  return date + ' 共 ' + n + ' 场会:' + parts.join(',') + '。';
}

/* ── minutes 私有辅助(server.ts 编排段移植) ────────────────────────── */

/**
 * 按会议名 + 日期定位智能纪要 docx:两段式搜索(会议名+完整中文日期 强信号 /
 * 仅会议名 宽召回)+ mnPickMatchingNotes 代码侧严格校验。
 */
async function mnFindNotesDocs(meetingName, target, callId) {
  var queries = [mnBuildNotesQuery(meetingName, target), '智能纪要 ' + String(meetingName).trim()];
  var candidates = [];
  var seen = {};
  var lastErr = null;
  for (var qi = 0; qi < queries.length; qi++) {
    var res = await miscSearchDocs(queries[qi], [22], 20, callId);
    if (res.err) { lastErr = res.err; continue; }
    var entities = (res.data && res.data.docs_entities) || [];
    for (var i = 0; i < entities.length; i++) {
      var e = entities[i];
      if (e.docs_token && !seen[e.docs_token]) {
        seen[e.docs_token] = 1;
        candidates.push({ title: e.title || '', token: e.docs_token, url: e.url || '' });
      }
    }
    // 强 query 已命中确切日期就不必再宽搜。
    if (mnPickMatchingNotes(candidates, meetingName, target).length > 0) break;
  }
  if (!candidates.length && lastErr) return { err: lastErr };
  return { matches: mnPickMatchingNotes(candidates, meetingName, target) };
}

/** POST /minutes/v1/minutes/search —— create_time 时间窗内搜本人可见的妙记。 */
async function mnMinutesSearchByWindow(startRfc, endRfc, query, pageSize, callId) {
  var body = { filter: { create_time: { start_time: startRfc, end_time: endRfc } } };
  if (query && String(query).trim()) body.query = String(query).trim();
  var r = await api({
    url: API + '/open-apis/minutes/v1/minutes/search' + qs({ page_size: pageSize }),
    method: 'POST',
    body: body,
    callId: callId,
  });
  if (r.err) return { err: r.err, hits: [] };
  var items = (r.data && r.data.items) || [];
  var hits = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    hits.push({
      token: item.token || '',
      url: (item.meta_data && item.meta_data.app_link) || '',
      display_info: item.display_info || '',
      description: (item.meta_data && item.meta_data.description) || '',
    });
  }
  return { hits: hits };
}

/** GET /minutes/v1/minutes/{token}/artifacts —— 妙记 AI 产物(总结/待办/章节)。 */
async function mnMinutesGetArtifacts(minuteToken, callId) {
  return api({
    url: API + '/open-apis/minutes/v1/minutes/' + encodeURIComponent(minuteToken) + '/artifacts',
    callId: callId,
  });
}

/**
 * VC meeting_list 列时间窗内实际发生(已结束)的会议,自动翻页;
 * 权限不足时 graceful 降级 { ok: false }(调用方转日历路径)。
 */
async function mnVcMeetingListDay(startSec, endSec, callId) {
  var all = [];
  var pageToken;
  for (var page = 0; page < 20; page++) {
    var r = await api({
      url: API + '/open-apis/vc/v1/meeting_list' + qs({
        start_time: startSec,
        end_time: endSec,
        meeting_status: 2, // ended
        page_size: 50,
        page_token: pageToken,
      }),
      callId: callId,
    });
    if (r.err) return { ok: false };
    var d = r.data || {};
    var list = d.meeting_list || [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item.meeting_id) continue;
      var start = item.meeting_start_time ? mnParseVcMeetingTime(item.meeting_start_time) : null;
      if (start === null) continue;
      var end = item.meeting_end_time ? mnParseVcMeetingTime(item.meeting_end_time) : null;
      all.push({
        meetingId: item.meeting_id,
        topic: item.meeting_topic || '',
        startSeconds: start,
        endSeconds: end !== null ? end : start,
        hasAiNote: !!item.ai_note || !!item.has_related_document,
        organizer: item.organizer || null,
      });
    }
    if (d.has_more && d.page_token) pageToken = d.page_token;
    else break;
  }
  all.sort(function (x, y) { return x.startSeconds - y.startSeconds; });
  return { ok: true, meetings: all };
}

/** VC recording API → minutes_token(recording.url 形如 meetings.feishu.cn/minutes/<token>)。 */
async function mnVcGetRecordingMinutesToken(meetingId, callId) {
  var r = await api({
    url: API + '/open-apis/vc/v1/meetings/' + encodeURIComponent(meetingId) + '/recording',
    callId: callId,
  });
  if (r.err) return null;
  var url = r.data && r.data.recording && r.data.recording.url;
  return url ? mnParseMinutesTokenFromUrl(url) : null;
}

/**
 * calendarEvent instance_view 展开单日实例(重复日程按当天那次返回,
 * 这是「按天不漏」的基石;接口不分页,窗口须 <40 天,单日天然满足)。
 */
async function mnInstanceViewDay(calendarId, startSec, endSec, callId) {
  var r = await api({
    url: API + '/open-apis/calendar/v4/calendars/' + encodeURIComponent(calendarId) +
      '/events/instance_view' + qs({ start_time: startSec, end_time: endSec }),
    callId: callId,
  });
  if (r.err) return { err: r.err };
  var rawItems = (r.data && r.data.items) || [];
  var items = [];
  for (var i = 0; i < rawItems.length; i++) {
    var it = rawItems[i];
    items.push({
      summary: it.summary,
      status: it.status,
      startTimestamp: it.start_time && it.start_time.timestamp,
      endTimestamp: it.end_time && it.end_time.timestamp,
      attendeeAbility: it.attendee_ability,
      organizerDisplayName: it.event_organizer && it.event_organizer.display_name,
    });
  }
  return { items: items };
}

/**
 * 单场会内容定位(VC 路径与日历路径共用):
 * ① VC 标记有 AI 纪要 → recording URL 直取 minutes_token;
 * ② 智能纪要 docx(发全员,内容最全);③ 本人妙记时间窗搜索(±15 分钟容差);
 * ④ 都没有 → 按来源/组织者标 missing 状态并写明原因(不装作没这场会)。
 */
async function mnLocateMeetingContent(row, tz, callId) {
  var base = {
    summary: row.summary,
    start_time: mnFormatSecondsInZone(row.startSeconds, tz),
    end_time: row.endSeconds !== null && row.endSeconds !== undefined
      ? mnFormatSecondsInZone(row.endSeconds, tz)
      : null,
    organizer: row.organizer || null,
    is_self_organizer: !!row.isSelfOrganizer,
  };
  // 快捷路径:VC 标记有 AI 纪要 → 直接通过 recording URL 拿 minutes_token。
  if (row.vcMeetingId && row.vcHasNote) {
    var mt = await mnVcGetRecordingMinutesToken(row.vcMeetingId, callId);
    if (mt) {
      return mnAssign(base, {
        source: 'minutes',
        status: 'got_minutes',
        minute_url: 'https://meetings.feishu.cn/minutes/' + mt,
        minute_token: mt,
      });
    }
  }
  // 路A:智能纪要 docx(按该场实例真实日期搜,跨零点场景不错日)。
  var instDate = mnParseTargetDate(mnYmdInZone(row.startSeconds, tz));
  if (instDate) {
    var found = await mnFindNotesDocs(row.summary, instDate, callId);
    if (!found.err && found.matches.length > 0) {
      var doc = found.matches[0];
      return mnAssign(base, {
        source: 'notes_doc',
        status: 'got_notes_doc',
        doc_url: doc.url,
        doc_token: doc.token,
      });
    }
  }
  // 路B:妙记时间窗搜索(±15 分钟容差,录制时间与日历不完全一致)。
  var BUFFER = 15 * 60;
  var endSeconds = row.endSeconds !== null && row.endSeconds !== undefined
    ? row.endSeconds
    : row.startSeconds + 3600;
  var startRfc = new Date((row.startSeconds - BUFFER) * 1000).toISOString();
  var endRfc = new Date((endSeconds + BUFFER) * 1000).toISOString();
  var ms = await mnMinutesSearchByWindow(startRfc, endRfc, row.summary, 20, callId);
  if (ms.hits && ms.hits.length > 0) {
    var wanted = String(row.summary).replace(/\s+/g, '');
    var best = null;
    for (var i = 0; i < ms.hits.length; i++) {
      if (String(ms.hits[i].display_info).replace(/\s+/g, '').indexOf(wanted) >= 0) {
        best = ms.hits[i];
        break;
      }
    }
    if (!best) best = ms.hits[0];
    if (best.token) {
      return mnAssign(base, {
        source: 'minutes',
        status: 'got_minutes',
        minute_url: best.url,
        minute_token: best.token,
      });
    }
  }
  // 兜底:VC 来源统一 missing_no_record;日历来源按组织者启发式分两类。
  if (row.vcMeetingId) {
    return mnAssign(base, {
      source: 'none',
      status: 'missing_no_record',
      reason: '该会议已确认参加,但未找到可访问的妙记或智能纪要。可能未开启妙记录制。',
    });
  }
  var status = mnClassifyMeetingContentStatus({
    docHit: false,
    minutesHit: false,
    isSelfOrganizer: base.is_self_organizer,
  });
  var reason = status === 'missing_not_organizer'
    ? '你不是这场会的组织者' + (row.organizer ? '(组织者:' + row.organizer + ')' : '') +
      ',妙记在组织者名下,飞书限制无法读取。可让组织者开启「自动生成会议纪要并发送给全体参会人」,或把纪要 docx 链接发你用 read_by_url 读。'
    : '这场会你可管理但没找到纪要,大概率没开妙记/未生成智能纪要。';
  return mnAssign(base, { source: 'none', status: status, reason: reason });
}

/* ── minutes:按日期定位会议纪要 / 妙记 / 录制内容 ─────────────────── */

op(
  'meeting_content',
  'minutes',
  '获取飞书会议内容(AI 总结/待办/章节/纪要正文)——「总结我某天的会 / 看某场会讲了啥 / 拿会议纪要」的唯一入口,不要自己先调 calendar_list_events 拼。以 date 为核心:优先用 VC meeting_list 枚举当天实际发生的会,权限不可用时降级日历 instance_view 展开当天实例(重复例会按当天那次算,不漏会);每场会逐一定位内容——智能纪要 docx(发全员,最全)优先,没命中再搜本人妙记(±15 分钟窗)。不传 meeting_name=当天全部会的清单+每场状态;传了=只看匹配的那(几)场,命中唯一一场且需要正文时直接给全文(docx 经 readDocCore,图片清单同 read_by_url)。拿不到的会也在 events 里(status=missing_*,reason 写明原因):非组织者拿不到妙记是飞书硬限制,不是漏会',
  'date*:string(YYYY-MM-DD,也接受 2026/6/18、2026年6月18日), meeting_name?:string(标题关键词,双向子串匹配), time_zone?:string(默认 Asia/Shanghai), calendar_id?:string(默认 primary), include_content?:bool(默认:传了 meeting_name 读全文、不传只给清单)',
  async function (a, c) {
    var target = mnParseTargetDate(a.date);
    if (!target) {
      return { err: 'date 需为 YYYY-MM-DD(也接受 2026/6/18、2026年6月18日),收到:' + a.date };
    }
    var tz = a.time_zone && String(a.time_zone).trim() ? String(a.time_zone).trim() : 'Asia/Shanghai';
    var calId = a.calendar_id || 'primary';
    var dateKey = target.year + '-' + mnPad2(target.month) + '-' + mnPad2(target.day);
    var startSec = parseTs(dateKey + ' 00:00:00', tz);
    var endSec = parseTs(dateKey + ' 23:59:59', tz);
    if (!startSec || !endSec) return { err: '日期解析失败:' + a.date };

    // ① 主路径:VC meeting_list(实际发生的会,不丢不漏);失败/为空降级日历 instance_view。
    var rows = null;
    var vc = await mnVcMeetingListDay(startSec, endSec, c);
    if (vc.ok && vc.meetings.length > 0) {
      rows = [];
      for (var i = 0; i < vc.meetings.length; i++) {
        var m = vc.meetings[i];
        rows.push({
          summary: m.topic || '(无主题)',
          startSeconds: m.startSeconds,
          endSeconds: m.endSeconds,
          organizer: m.organizer,
          isSelfOrganizer: false,
          vcMeetingId: m.meetingId,
          vcHasNote: m.hasAiNote,
        });
      }
    } else {
      var view = await mnInstanceViewDay(calId, startSec, endSec, c);
      if (view.err) return { err: view.err };
      var insts = mnPickDayMeetingInstances(view.items);
      rows = [];
      for (var j = 0; j < insts.length; j++) {
        var inst = insts[j];
        rows.push({
          summary: inst.summary,
          startSeconds: inst.startSeconds,
          endSeconds: inst.endSeconds,
          organizer: inst.organizerDisplayName,
          isSelfOrganizer: inst.attendeeAbility === 'can_modify_event',
        });
      }
    }

    // ② 可选会议名过滤(双向子串);没匹配时把当天全部会名回给 agent 自纠。
    var nameFilter = a.meeting_name && String(a.meeting_name).trim();
    var all = rows;
    if (nameFilter) {
      rows = [];
      for (var f = 0; f < all.length; f++) {
        if (mnNameMatches(all[f].summary, nameFilter)) rows.push(all[f]);
      }
      if (!rows.length) {
        var names = [];
        for (var g = 0; g < all.length; g++) names.push(all[g].summary);
        return {
          data: {
            date: dateKey,
            time_zone: tz,
            calendar_id: calId,
            events: [],
            summary_line: all.length
              ? dateKey + ' 没有名称匹配「' + nameFilter + '」的会。当天的会有:' + names.join('、') +
                '。换个会议名,或不传 meeting_name 看全部。'
              : dateKey + ' 当天没有任何会议(或你无访问权)。',
          },
        };
      }
    }

    // ③ 逐场(并发 3)定位内容。
    var events = await miscMapConcurrent(rows, 3, function (row) {
      return mnLocateMeetingContent(row, tz, c);
    });

    // ④ 命中唯一一场且需要正文 → 直接给全文。
    var wantContent = a.include_content !== undefined ? !!a.include_content : !!nameFilter;
    if (events.length === 1 && wantContent) {
      var e = events[0];
      if (e.source === 'notes_doc' && e.doc_token) {
        var docRead = await readDocCore(e.doc_token, 0, c);
        if (!docRead.err) {
          return {
            data: {
              source: 'notes_doc',
              meeting_name: e.summary,
              date: dateKey,
              doc_url: e.doc_url,
              doc_token: e.doc_token,
              doc: docRead.doc,
            },
          };
        }
      }
      if (e.source === 'minutes' && e.minute_token) {
        var art = await mnMinutesGetArtifacts(e.minute_token, c);
        if (!art.err) {
          var d = art.data || {};
          var summary = typeof d.summary === 'string' ? d.summary : '';
          return {
            data: {
              source: 'minutes',
              meeting_name: e.summary,
              date: dateKey,
              minute_url: e.minute_url,
              minute_token: e.minute_token,
              summary: summary,
              todos: Array.isArray(d.minute_todos) ? d.minute_todos : [],
              chapters: Array.isArray(d.minute_chapters) ? d.minute_chapters : [],
              hint: summary
                ? undefined
                : '该妙记暂无 AI 总结(可能尚未生成、被关闭、或无 minutes:minutes.artifacts:read 权限)。',
            },
          };
        }
      }
    }

    // ⑤ 清单返回。
    return {
      data: {
        date: dateKey,
        time_zone: tz,
        calendar_id: calId,
        events: events,
        summary_line: mnBuildSummaryLine(dateKey, events),
      },
    };
  },
);

/* ── contact:搜人 / 查用户 ─────────────────────────────────────────── */

op(
  'contact_search',
  'contact',
  '搜索/查询飞书用户,二选一:query=姓名模糊搜索(先走 search/v1/user,失败自动降级遍历通讯录按姓名双向子串匹配);open_id=按 ID 精确拉取完整信息。返回 open_id/name/email 等。不支持按邮箱搜;若目的是发消息且姓名搜不到,可向用户要邮箱改走 im_send_message(receive_id_type=email)',
  'query?:string(姓名关键词,与 open_id 二选一), open_id?:string(传了走精确单查,忽略 query), page_size?:int(默认 50,仅姓名搜索)',
  async function (a, c) {
    if (a.open_id) {
      var g = await api({
        url: API + '/open-apis/contact/v3/users/' + encodeURIComponent(a.open_id) +
          qs({ user_id_type: 'open_id' }),
        callId: c,
      });
      if (g.err) return { err: g.err };
      return { data: g.data };
    }
    if (!a.query) return { err: 'query 与 open_id 至少传一个' };
    var pageSize = a.page_size || 50;
    var s = await api({
      url: API + '/open-apis/search/v1/user' + qs({ page_size: pageSize, user_id_type: 'open_id' }),
      method: 'POST',
      body: { query: a.query },
      callId: c,
    });
    if (!s.err) return { data: s.data };
    // 降级:遍历通讯录按姓名双向子串匹配(最多 20 页或凑满 10 人)。
    var matched = [];
    var q = String(a.query).toLowerCase();
    var pageToken;
    for (var page = 0; page < 20 && matched.length < 10; page++) {
      var l = await api({
        url: API + '/open-apis/contact/v3/users' +
          qs({ page_size: pageSize, user_id_type: 'open_id', page_token: pageToken }),
        callId: c,
      });
      if (l.err) {
        return { err: '搜索接口失败:' + s.err + '\n遍历通讯录降级也失败:' + l.err };
      }
      var items = (l.data && l.data.items) || [];
      for (var i = 0; i < items.length; i++) {
        var name = String(items[i].name || '');
        var lower = name.toLowerCase();
        if (!lower) continue;
        if (lower.indexOf(q) >= 0 || q.indexOf(lower) >= 0) {
          matched.push({ name: name, open_id: items[i].open_id || '', email: items[i].email });
        }
      }
      if (l.data && l.data.has_more && l.data.page_token) pageToken = l.data.page_token;
      else break;
    }
    return {
      data: {
        users: matched,
        total_matched: matched.length,
        hint: matched.length
          ? undefined
          : '未找到匹配的用户;若要发消息可向用户索要邮箱,改走 im_send_message(receive_id_type=email)',
      },
    };
  },
);

op(
  'contact_get_user',
  'contact',
  '按 open_id 获取单个飞书用户完整信息(姓名/邮箱/手机/部门等,需通讯录权限)',
  'open_id*:string, department_id_type?:department_id|open_department_id(返回部门 ID 类型,可选)',
  async function (a, c) {
    if (!a.open_id) return { err: '需要 open_id' };
    var r = await api({
      url: API + '/open-apis/contact/v3/users/' + encodeURIComponent(a.open_id) +
        qs({ user_id_type: 'open_id', department_id_type: a.department_id_type }),
      callId: c,
    });
    if (r.err) return { err: r.err };
    return { data: r.data };
  },
);

op(
  'contact_batch_get_users',
  'contact',
  '按 open_id 列表批量获取飞书用户信息(单次最多 50 个),适合渲染消息发送者/日程参与者列表',
  'open_ids*:arr<string>(1-50 个), department_id_type?:department_id|open_department_id(可选)',
  async function (a, c) {
    var ids = a.open_ids;
    if (!Array.isArray(ids) || !ids.length) return { err: '需要 open_ids(open_id 字符串数组,1-50 个)' };
    if (ids.length > 50) return { err: 'open_ids 单次最多 50 个,收到 ' + ids.length + ' 个——请分批调用' };
    var r = await api({
      url: API + '/open-apis/contact/v3/users/batch' +
        qs({ user_ids: ids, user_id_type: 'open_id', department_id_type: a.department_id_type }),
      callId: c,
    });
    if (r.err) return { err: r.err };
    return { data: r.data };
  },
);

/* ── calendar:列日程 / 查日程 / 建日程 ─────────────────────────────── */

op(
  'calendar_list_events',
  'calendar',
  '查询飞书日历日程列表。start_time/end_time 支持 Unix 秒/毫秒、RFC3339,无时区的"YYYY-MM-DD HH:mm"按 time_zone 解析(默认 Asia/Shanghai)。注意:重复日程只返回母事件(start_time 是系列首次时间);要「某天实际有哪些会/会议纪要」请直接用 meeting_content(内部按天展开实例)',
  'start_time*:string, end_time*:string, time_zone?:string(如 Asia/Shanghai 或 +08:00), calendar_id?:string(默认 primary), page_size?:int(默认 50), page_token?:string',
  async function (a, c) {
    var st = parseTs(a.start_time, a.time_zone);
    if (!st) return { err: 'start_time 无法解析:' + a.start_time + '(支持 Unix 秒/毫秒、RFC3339、或 "YYYY-MM-DD HH:mm" 配合 time_zone)' };
    var et = parseTs(a.end_time, a.time_zone);
    if (!et) return { err: 'end_time 无法解析:' + a.end_time + '(格式同 start_time)' };
    var calId = a.calendar_id || 'primary';
    var r = await api({
      url: API + '/open-apis/calendar/v4/calendars/' + encodeURIComponent(calId) + '/events' +
        qs({ start_time: st, end_time: et, page_size: a.page_size || 50, page_token: a.page_token }),
      callId: c,
    });
    if (r.err) return { err: r.err };
    var d = r.data || {};
    return {
      data: {
        events: d.items || [],
        has_more: !!d.has_more,
        page_token: d.has_more ? d.page_token : undefined,
      },
    };
  },
);

op(
  'calendar_get_event',
  'calendar',
  '获取飞书日程详情(参与者、地点、会议链接等)',
  'event_id*:string, calendar_id?:string(默认 primary)',
  async function (a, c) {
    if (!a.event_id) return { err: '需要 event_id' };
    var calId = a.calendar_id || 'primary';
    var r = await api({
      url: API + '/open-apis/calendar/v4/calendars/' + encodeURIComponent(calId) +
        '/events/' + encodeURIComponent(a.event_id),
      callId: c,
    });
    if (r.err) return { err: r.err };
    return { data: r.data };
  },
);

wop(
  'calendar_create_event',
  'calendar',
  '创建飞书日程并可邀请参与者(对方会收到邀请通知)。执行前与用户确认;邀请参与者时必须先 contact_search 搜到 open_id,并向用户确认「要给 XX 发日程邀请吗?」,明确同意后才创建。start_time/end_time 支持 Unix 秒/毫秒、RFC3339,无时区时间按 time_zone 解析(默认 Asia/Shanghai)',
  'summary*:string(标题), start_time*:string, end_time*:string, time_zone?:string, description?:string, attendee_open_ids?:arr<string>(contact_search 搜人获取), attendee_emails?:arr<string>(搜不到 open_id 时邮箱兜底), location?:string, calendar_id?:string(默认 primary)',
  async function (a, c) {
    if (!a.summary) return { err: '需要 summary(日程标题)' };
    var st = parseTs(a.start_time, a.time_zone);
    if (!st) return { err: 'start_time 无法解析:' + a.start_time + '(支持 Unix 秒/毫秒、RFC3339、或 "YYYY-MM-DD HH:mm" 配合 time_zone)' };
    var et = parseTs(a.end_time, a.time_zone);
    if (!et) return { err: 'end_time 无法解析:' + a.end_time + '(格式同 start_time)' };
    var calId = a.calendar_id || 'primary';
    var body = {
      summary: a.summary,
      start_time: { timestamp: st },
      end_time: { timestamp: et },
      need_notification: true,
    };
    if (a.description) body.description = a.description;
    if (a.location) body.location = { name: a.location };
    var r = await api({
      url: API + '/open-apis/calendar/v4/calendars/' + encodeURIComponent(calId) + '/events',
      method: 'POST',
      body: body,
      callId: c,
    });
    if (r.err) return { err: r.err };

    var attendees = [];
    var ids = Array.isArray(a.attendee_open_ids) ? a.attendee_open_ids : [];
    for (var i = 0; i < ids.length; i++) attendees.push({ type: 'user', user_id: ids[i] });
    var emails = Array.isArray(a.attendee_emails) ? a.attendee_emails : [];
    for (var j = 0; j < emails.length; j++) attendees.push({ type: 'third_party', third_party_email: emails[j] });

    if (attendees.length > 0) {
      var eventId = r.data && r.data.event && r.data.event.event_id;
      if (eventId) {
        var ar = await api({
          url: API + '/open-apis/calendar/v4/calendars/' + encodeURIComponent(calId) +
            '/events/' + encodeURIComponent(eventId) + '/attendees' + qs({ user_id_type: 'open_id' }),
          method: 'POST',
          body: { attendees: attendees },
          callId: c,
        });
        if (ar.err) {
          return {
            data: {
              event: r.data && r.data.event,
              attendee_warning: '日程已创建但添加参与者失败:' + ar.err,
            },
          };
        }
      }
    }
    return { data: r.data };
  },
);
// </PART:MISC>

// <PART:DOCX_WIKI>
/* ═══ PART:DOCX_WIKI —— 云文档(docx)与知识库(wiki)精品操作 ═══════════════
 * 从老 lizi_feishu MCP server.ts 移植(docx 8 个 + wiki 4 个)。依赖骨架助手:
 * api / qs / fail / mediaSave / uploadMedia / uploadWorkdirFile / extractHash /
 * parseFeishuUrl / paginateAll / op / wop / API(本段不重复定义)。
 *
 * 与老 MCP 的刻意差异:
 * - 图片不再回 base64 图片块(沙箱交卷是纯 JSON):max_images>0 时经媒体总仓
 *   下载,交回 media_url(cindy-media:// 取件地址,渲染器可显示、用户可查看);
 * - docx_upload_image 的 file_path 参数被过户票据取代:聊天/总仓图片走顶层
 *   attachments(指纹),本地文件走顶层 dir(dir_deposit 单文件过户);
 * - 块清单解析是精简版(图片清单 + 内嵌块提示 + todo 项),评论 / 折叠章节 /
 *   mention / 删除线等锦上添花项未移植。
 *
 * 共享契约(part-misc 会调用,签名勿动):
 *   readDocCore(documentId, maxImages, callId) → {err}|{doc:{document_id,title,content,images,embedded_blocks,todos}}
 *   resolveWikiNode(nodeToken, spaceId, callId) → {err}|{node:{node_token,obj_type,obj_token,title,space_id,has_child}}
 * ════════════════════════════════════════════════════════════════════════ */

/** 用户侧文档跳转域名(与 OpenAPI 域名无关;老 MCP docLinks.ts 同值)。 */
var DOC_LINK_BASE = 'https://feishu.cn';

function docxDocUrl(documentId) {
  return DOC_LINK_BASE + '/docx/' + documentId;
}

/* ── 精简版块清单解析(老 blockManifest.ts 的沙箱缩水版) ────────────── */

/** 纯文本类块 block_type → 飞书 payload 字段名(docx 写工具用)。 */
var DOCX_BLOCK_TYPE_FIELD = {
  2: 'text',
  3: 'heading1', 4: 'heading2', 5: 'heading3', 6: 'heading4', 7: 'heading5',
  8: 'heading6', 9: 'heading7', 10: 'heading8', 11: 'heading9',
  12: 'bullet',
  13: 'ordered',
  14: 'code',
  15: 'quote',
  22: 'divider',
  27: 'image',
};

var DOCX_BLOCK_TYPE_DESC =
  '块类型:2=文本段落,3-11=H1~H9 标题,12=无序列表项,13=有序列表项,14=代码块,15=引用,22=分割线,27=图片(空壳,建后用 docx_upload_image 绑图)';

/**
 * 已被 raw_content 正文覆盖(或纯容器)的块类型——不算内嵌对象。
 * 不在此集合的一律进 embedded_blocks 提示(未知新类型宁可多报不漏报)。
 * 数字来源:飞书 BlockType 官方枚举(老 blockManifest.ts 已核对,勿凭感觉改)。
 */
var DOCX_TEXT_FLOW_TYPES = {
  1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1, 11: 1,
  12: 1, 13: 1, 14: 1, 15: 1, 17: 1, 19: 1, 22: 1, 24: 1, 25: 1, 27: 1,
  32: 1, 34: 1, 44: 1, 45: 1, 46: 1, 47: 1,
};

/** 内嵌对象 block_type → 友好名(缺省 'block_<n>')。 */
var DOCX_EMBED_TYPE_NAMES = {
  18: 'bitable', 20: 'chat_card', 21: 'diagram', 23: 'file', 26: 'iframe',
  28: 'isv', 29: 'mindnote', 30: 'sheet', 31: 'table', 33: 'view',
  35: 'task', 36: 'okr', 40: 'add_ons', 41: 'jira_issue', 42: 'wiki_catalog',
  43: 'board', 48: 'link_preview', 49: 'source_synced', 50: 'reference_synced',
  51: 'sub_page_list', 52: 'ai_template',
};

/** 拼接一组飞书 inline elements 里 text_run 的可见文本。 */
function docxJoinTextRuns(elements) {
  if (!Array.isArray(elements)) return '';
  var parts = [];
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    var content = el && el.text_run && el.text_run.content;
    if (typeof content === 'string' && content.length > 0) parts.push(content);
  }
  return parts.join('').trim();
}

/** 标题块(3-11)的可见文本;level = block_type - 2。 */
function docxHeadingText(block, level) {
  var shape = block['heading' + level];
  return docxJoinTextRuns(shape && shape.elements);
}

/** 内嵌对象的 best-effort 引用 token / URL(拿不到给 undefined)。 */
function docxEmbedRef(block, type) {
  var v;
  if (type === 23) { v = block.file && block.file.token; }
  else if (type === 26) {
    v = block.iframe && ((block.iframe.component && block.iframe.component.url) || block.iframe.url);
  }
  else if (type === 18) { v = block.bitable && block.bitable.token; }
  else if (type === 30) { v = block.sheet && block.sheet.token; }
  else if (type === 43) {
    v = (block.board && block.board.token) || (block.whiteboard && block.whiteboard.token);
  }
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * 一次遍历块树,产出精简三清单:
 *   images:          [{ file_token, section, block_id }](同 token 去重)
 *   embedded_blocks: [{ block_id, block_type, type, section, token?, title? }]
 *                    (表格 / 嵌入 sheet / bitable / iframe / 文件附件等的
 *                    token 与类型提示;bitable/sheet 的 token 可能是
 *                    "主token_子id" 复合形态,续读时取下划线前段)
 *   todos:           [{ block_id, done, text, section }]
 * section = 就近前置标题文本,文档开头给 '(开头)'。
 */
function docxBlocksLite(blocks) {
  var images = [];
  var seenImages = {};
  var embedded = [];
  var todos = [];
  var currentHeading = '';
  var list = Array.isArray(blocks) ? blocks : [];

  for (var i = 0; i < list.length; i++) {
    var block = list[i];
    if (!block || typeof block !== 'object') continue;
    var type = block.block_type;
    if (typeof type !== 'number') continue;
    var section = currentHeading || '(开头)';
    var blockId = typeof block.block_id === 'string' ? block.block_id : undefined;

    if (type >= 3 && type <= 11) {
      var text = docxHeadingText(block, type - 2);
      if (text) currentHeading = text;
      continue;
    }

    if (type === 27) {
      var token = block.image && block.image.token;
      if (typeof token !== 'string' || token.length === 0) continue;
      if (seenImages[token]) continue;
      seenImages[token] = 1;
      images.push({ file_token: token, section: section, block_id: blockId });
      continue;
    }

    if (type === 17) {
      var todo = block.todo || {};
      todos.push({
        block_id: blockId,
        done: todo.style && todo.style.done === true,
        text: docxJoinTextRuns(todo.elements) || '(无内容)',
        section: section,
      });
      continue;
    }

    if (DOCX_TEXT_FLOW_TYPES[type]) continue;

    var entry = {
      block_id: blockId,
      block_type: type,
      type: DOCX_EMBED_TYPE_NAMES[type] || ('block_' + type),
      section: section,
    };
    var ref = docxEmbedRef(block, type);
    if (ref) entry.token = ref;
    if (type === 23 && block.file && typeof block.file.name === 'string' && block.file.name) {
      entry.title = block.file.name;
    }
    embedded.push(entry);
  }
  return { images: images, embedded_blocks: embedded, todos: todos };
}

/* ── 共享契约函数 ───────────────────────────────────────────────────── */

/**
 * 解析 wiki 节点(GET /open-apis/wiki/v2/spaces/get_node?token=...)。
 * spaceId 仅为契约占位(该接口按 token 全局解析,不需要 space_id)。
 */
async function resolveWikiNode(nodeToken, spaceId, callId) {
  var r = await api({
    url: API + '/open-apis/wiki/v2/spaces/get_node' + qs({ token: nodeToken }),
    callId: callId,
  });
  if (r.err) return { err: r.err };
  var node = r.data && r.data.node;
  if (!node || !node.obj_token) {
    return { err: '未找到该知识库节点(token: ' + String(nodeToken) + ')——确认 token 正确且当前账号有访问权限' };
  }
  return {
    node: {
      node_token: node.node_token,
      obj_type: node.obj_type,
      obj_token: node.obj_token,
      title: node.title,
      space_id: node.space_id,
      has_child: node.has_child,
    },
  };
}

/**
 * 读 docx 全文(readDocWithImageManifest 的沙箱版):正文纯文本 + 标题 +
 * 精简块清单;maxImages>0 时前 N 张图经媒体总仓下载,成功的填 media_url
 * (取件地址),失败的该项附 note 不阻断全文。
 */
async function readDocCore(documentId, maxImages, callId) {
  var encId = encodeURIComponent(String(documentId));
  var results = await Promise.all([
    api({ url: API + '/open-apis/docx/v1/documents/' + encId + '/raw_content', callId: callId }),
    api({ url: API + '/open-apis/docx/v1/documents/' + encId, callId: callId }),
    paginateAll(function (pageToken) {
      return api({
        url: API + '/open-apis/docx/v1/documents/' + encId + '/blocks' + qs({ page_size: 500, page_token: pageToken }),
        callId: callId,
      });
    }, 40),
  ]);
  var rawR = results[0];
  if (rawR.err) return { err: rawR.err };
  var blocksR = results[2];
  if (blocksR.err) return { err: blocksR.err };

  var title = '';
  var docR = results[1];
  if (!docR.err && docR.data && docR.data.document && typeof docR.data.document.title === 'string') {
    title = docR.data.document.title;
  }
  var content = rawR.data && typeof rawR.data.content === 'string' ? rawR.data.content : '';

  var lite = docxBlocksLite(blocksR.items);
  var images = lite.images;

  var max = Number(maxImages);
  max = isFinite(max) && max > 0 ? Math.min(Math.floor(max), 20) : 0;
  if (max > 0 && images.length > 0) {
    var toFetch = images.slice(0, max);
    await Promise.all(toFetch.map(function (entry) {
      return (async function () {
        var label = entry.section && entry.section !== '(开头)' ? entry.section : (title || '飞书文档图片');
        var r = await mediaSave(
          API + '/open-apis/drive/v1/medias/' + encodeURIComponent(entry.file_token) + '/download',
          callId,
          label,
        );
        if (r.media) entry.media_url = r.media.url;
        else entry.note = '图片下载失败:' + String(r.err || '').slice(0, 200);
      })();
    }));
  }

  return {
    doc: {
      document_id: documentId,
      title: title,
      content: content,
      images: images,
      embedded_blocks: lite.embedded_blocks,
      todos: lite.todos,
    },
  };
}

/* ── docx 编辑内部助手 ──────────────────────────────────────────────── */

/**
 * 文档定位:飞书 wiki/docx/docs URL 或裸 document_id → document_id。
 * wiki 节点自动解析到 obj_token,非 docx 类型拒绝(防误改表格)。
 */
async function resolveDocxDocumentId(urlOrId, callId) {
  var s = String(urlOrId || '').trim();
  if (!s) return { err: '需要 url_or_document_id(飞书 wiki/docx URL 或裸 document_id)' };
  var parsed = parseFeishuUrl(s);
  if (parsed && parsed.kind === 'wiki') {
    var w = await resolveWikiNode(parsed.token, undefined, callId);
    if (w.err) return { err: w.err };
    if (w.node.obj_type !== 'docx') {
      return { err: '该 wiki 节点是 ' + String(w.node.obj_type) + ' 类型,docx 编辑工具只支持 docx;请改用对应类型的工具(obj_token: ' + w.node.obj_token + ')' };
    }
    return { documentId: w.node.obj_token };
  }
  if (parsed && (parsed.kind === 'docx' || parsed.kind === 'docs')) {
    return { documentId: parsed.token };
  }
  if (/^[A-Za-z0-9]+$/.test(s)) return { documentId: s };
  return { err: '无法识别文档定位:仅支持飞书 wiki/docx/docs URL 或裸 document_id,收到 ' + s.slice(0, 120) };
}

/**
 * 由 { block_type, text?, raw? } 组装单个飞书子块 payload。
 * raw 透传优先;22/27 空壳;其余纯文本类查 DOCX_BLOCK_TYPE_FIELD。
 * 返回 { block } 或 { err }。
 */
function buildDocxBlockChild(spec) {
  if (!spec || typeof spec !== 'object' || typeof spec.block_type !== 'number') {
    return { err: '每个块需要 block_type(int)。' + DOCX_BLOCK_TYPE_DESC };
  }
  if (spec.raw && typeof spec.raw === 'object') {
    var out = { block_type: spec.block_type };
    for (var k in spec.raw) {
      if (Object.prototype.hasOwnProperty.call(spec.raw, k)) out[k] = spec.raw[k];
    }
    return { block: out };
  }
  if (spec.block_type === 22) return { block: { block_type: 22, divider: {} } };
  if (spec.block_type === 27) return { block: { block_type: 27, image: {} } };
  var fieldName = DOCX_BLOCK_TYPE_FIELD[spec.block_type];
  if (!fieldName) {
    return { err: '不支持的 block_type: ' + spec.block_type + '。' + DOCX_BLOCK_TYPE_DESC + ';富文本/特殊块请用 raw 字段透传完整 JSON。' };
  }
  var block = { block_type: spec.block_type };
  block[fieldName] = {
    elements: [{ text_run: { content: typeof spec.text === 'string' ? spec.text : '' } }],
    style: {},
  };
  return { block: block };
}

/** blocks 数组 → children payload。返回 { children } 或 { err }。 */
function buildDocxChildren(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { err: 'blocks 必须是非空数组,每项 { block_type, text?, raw? }。' + DOCX_BLOCK_TYPE_DESC };
  }
  var children = [];
  for (var i = 0; i < blocks.length; i++) {
    var b = buildDocxBlockChild(blocks[i]);
    if (b.err) return { err: 'blocks[' + i + '] 无效:' + b.err };
    children.push(b.block);
  }
  return { children: children };
}

/* ── 参数说明共用片段 ───────────────────────────────────────────────── */

var DOCX_URL_P = 'url_or_document_id*:string(飞书 wiki/docx URL 或裸 document_id;wiki 节点自动解析到 obj_token,非 docx 类型拒绝)';
var DOCX_BLOCKS_P = 'blocks*:[{block_type*:int(' + DOCX_BLOCK_TYPE_DESC + '), text?:string(纯文本内容), raw?:object(完整飞书 block JSON,富文本/特殊块透传,覆盖 text)}]';

/* ═══ docx 操作注册 ═════════════════════════════════════════════════ */

op(
  'docx_read',
  'docx',
  '读取飞书云文档完整内容:正文纯文本 + 图片清单 images(含就近章节 section)+ 内嵌块提示 embedded_blocks(表格/电子表格/多维表格/iframe/附件的 token 与类型)+ 任务项 todos(含完成态)。默认 max_images=0 只给清单不下图;max_images>0 时前 N 张图下载进媒体总仓,交回 media_url 取件地址(cindy-media://,回复里用 markdown 图片语法嵌入即可显示)。改/删块前先用本工具看清结构(根块 block_id == document_id)。',
  'document_id*:string, max_images?:int(0-20,默认0)',
  async function (a, c) {
    if (!a.document_id) return { err: '需要 document_id' };
    var r = await readDocCore(String(a.document_id), a.max_images, c);
    if (r.err) return { err: r.err };
    return { data: r.doc };
  },
);

op(
  'docx_list_block_children',
  'docx',
  '读取指定块的直接子块(含每个子块的 block_id,是块级编辑的定位入口)。用法:读文档根传 block_id=document_id;读表格(block_type=31)拿单元格(32);再对单元格读内部文本块。写字时更新单元格内的文本块,不要直接更新 table_cell 容器。改/删任何块前都先用本工具(或 docx_read)拿准 block_id。',
  DOCX_URL_P + ', block_id*:string(父块 block_id), page_size?:int(1-500,默认500), page_token?:string, document_revision_id?:int(默认-1=最新版)',
  async function (a, c) {
    if (!a.block_id) return { err: '需要 block_id(读文档根传 document_id)' };
    var resolved = await resolveDocxDocumentId(a.url_or_document_id, c);
    if (resolved.err) return { err: resolved.err };
    var documentId = resolved.documentId;
    var r = await api({
      url: API + '/open-apis/docx/v1/documents/' + encodeURIComponent(documentId) +
        '/blocks/' + encodeURIComponent(String(a.block_id)) + '/children' +
        qs({
          page_size: a.page_size || 500,
          page_token: a.page_token,
          document_revision_id: a.document_revision_id === undefined ? -1 : a.document_revision_id,
        }),
      callId: c,
    });
    if (r.err) return { err: r.err };
    var d = r.data || {};
    return {
      data: {
        document_id: documentId,
        parent_block_id: a.block_id,
        children: d.items || [],
        has_more: d.has_more,
        page_token: d.page_token,
      },
    };
  },
);

wop(
  'docx_append_blocks',
  'docx',
  '在飞书文档末尾追加一个或多个块(段落/标题/列表/代码块/引用/分割线等)。不传 parent_block_id 默认追加到文档根末尾;传了则追加到该父块子块末尾。执行前与用户确认(写哪个文档、追加什么内容);成功后把返回的 document_url 以 markdown 链接给用户核对。',
  DOCX_URL_P + ', parent_block_id?:string(默认=document_id 文档根), ' + DOCX_BLOCKS_P,
  async function (a, c) {
    var resolved = await resolveDocxDocumentId(a.url_or_document_id, c);
    if (resolved.err) return { err: resolved.err };
    var documentId = resolved.documentId;
    var built = buildDocxChildren(a.blocks);
    if (built.err) return { err: built.err };
    var parentBlockId = a.parent_block_id || documentId;
    var r = await api({
      url: API + '/open-apis/docx/v1/documents/' + encodeURIComponent(documentId) +
        '/blocks/' + encodeURIComponent(parentBlockId) + '/children',
      method: 'POST',
      body: { children: built.children },
      callId: c,
    });
    if (r.err) return { err: r.err };
    var d = r.data || {};
    return {
      data: {
        appended: built.children.length,
        children: d.children,
        document_revision_id: d.document_revision_id,
        document_url: docxDocUrl(documentId),
      },
    };
  },
);

wop(
  'docx_insert_blocks',
  'docx',
  '在指定父块的子块列表中按 index 插入一个或多个块。index 是父块 children 数组位置(0=最前;不传=末尾,等同 docx_append_blocks)。先 docx_list_block_children 看清现有子块序号再定 index。执行前与用户确认;成功后把 document_url 以 markdown 链接给用户核对。',
  DOCX_URL_P + ', parent_block_id*:string(插入到文档根传 document_id), index?:int(>=0;省略=末尾), ' + DOCX_BLOCKS_P,
  async function (a, c) {
    if (!a.parent_block_id) return { err: '需要 parent_block_id(插入到文档根传 document_id)' };
    var resolved = await resolveDocxDocumentId(a.url_or_document_id, c);
    if (resolved.err) return { err: resolved.err };
    var documentId = resolved.documentId;
    var built = buildDocxChildren(a.blocks);
    if (built.err) return { err: built.err };
    var body = { children: built.children };
    if (a.index !== undefined && a.index !== null) body.index = a.index;
    var r = await api({
      url: API + '/open-apis/docx/v1/documents/' + encodeURIComponent(documentId) +
        '/blocks/' + encodeURIComponent(String(a.parent_block_id)) + '/children',
      method: 'POST',
      body: body,
      callId: c,
    });
    if (r.err) return { err: r.err };
    var d = r.data || {};
    return {
      data: {
        inserted: built.children.length,
        children: d.children,
        document_revision_id: d.document_revision_id,
        document_url: docxDocUrl(documentId),
      },
    };
  },
);

wop(
  'docx_create_table',
  'docx',
  '在飞书文档里创建真表格块(block_type=31):只发表格骨架,飞书自动生成全部单元格(32)与其中的空文本块;可选 rows_data 一次性按行优先把文字灌进单元格(内部自动读回单元格再 batch_update)。飞书硬限制:单次建表最多 9 行 × 9 列(行含表头);header_row=true 时第一行是表头。建完后补/改文字走 docx_list_block_children + docx_update_block。执行前与用户确认;成功后把 document_url 以 markdown 链接给用户核对。',
  DOCX_URL_P + ', parent_block_id?:string(默认=document_id 文档根末尾), index?:int(>=0;省略=末尾), rows*:int(1-9,含表头), columns*:int(1-9), header_row?:bool(默认false), rows_data?:string[][](行优先;行/列可少于 rows/columns,不足留空,多出忽略)',
  async function (a, c) {
    var rows = Math.floor(Number(a.rows));
    var columns = Math.floor(Number(a.columns));
    if (!(rows >= 1 && rows <= 9) || !(columns >= 1 && columns <= 9)) {
      return { err: 'rows / columns 必须是 1-9 的整数(飞书单次建表上限 9×9,行含表头);更大的表请拆分' };
    }
    var resolved = await resolveDocxDocumentId(a.url_or_document_id, c);
    if (resolved.err) return { err: resolved.err };
    var documentId = resolved.documentId;
    var encId = encodeURIComponent(documentId);
    var parentBlockId = a.parent_block_id || documentId;

    // 1) 建表骨架:只发 table 块,飞书自动补全单元格 + 空文本块。
    var property = { row_size: rows, column_size: columns };
    if (a.header_row) property.header_row = true;
    var body = { children: [{ block_type: 31, table: { property: property } }] };
    if (a.index !== undefined && a.index !== null) body.index = a.index;
    var createR = await api({
      url: API + '/open-apis/docx/v1/documents/' + encId + '/blocks/' + encodeURIComponent(parentBlockId) + '/children',
      method: 'POST',
      body: body,
      callId: c,
    });
    if (createR.err) return { err: createR.err };
    var created = (createR.data && createR.data.children) || [];
    var tableBlockId = created[0] && created[0].block_id;

    var rowsData = a.rows_data;
    var hasContent = false;
    if (Array.isArray(rowsData)) {
      for (var ri = 0; ri < rowsData.length && !hasContent; ri++) {
        var row = rowsData[ri];
        if (!Array.isArray(row)) continue;
        for (var ci = 0; ci < row.length; ci++) {
          if (row[ci] && String(row[ci]).length > 0) { hasContent = true; break; }
        }
      }
    }
    if (!tableBlockId || !hasContent) {
      return { data: { table_block_id: tableBlockId, rows: rows, columns: columns, document_url: docxDocUrl(documentId) } };
    }

    // 2) 读回自动生成的单元格(行优先;单表 ≤81 格,一页足够)。
    var cellsR = await api({
      url: API + '/open-apis/docx/v1/documents/' + encId + '/blocks/' + encodeURIComponent(tableBlockId) +
        '/children' + qs({ page_size: 500, document_revision_id: -1 }),
      callId: c,
    });
    if (cellsR.err) {
      return {
        data: {
          table_block_id: tableBlockId, rows: rows, columns: columns,
          fill_warning: '表格已创建,但读取单元格失败,内容未填充。可用 docx_list_block_children + docx_update_block 手动补,或重试。',
          document_url: docxDocUrl(documentId),
        },
      };
    }
    var cells = (cellsR.data && cellsR.data.items) || [];

    // 3) 行优先映射内容 → 单元格首个文本块,组 batch_update 请求。
    var requests = [];
    for (var r2 = 0; r2 < rows; r2++) {
      for (var c2 = 0; c2 < columns; c2++) {
        var contentCell = rowsData[r2] && rowsData[r2][c2];
        if (!contentCell) continue;
        var cell = cells[r2 * columns + c2];
        var textId = cell && cell.children && cell.children[0];
        if (!textId) continue;
        requests.push({
          block_id: textId,
          update_text_elements: { elements: [{ text_run: { content: String(contentCell) } }] },
        });
      }
    }

    // 4) 分批写入(batch_update 按 50 条保守切片)。
    var filled = 0;
    for (var i = 0; i < requests.length; i += 50) {
      var chunk = requests.slice(i, i + 50);
      var upd = await api({
        url: API + '/open-apis/docx/v1/documents/' + encId + '/blocks/batch_update',
        method: 'PATCH',
        body: { requests: chunk },
        callId: c,
      });
      if (upd.err) {
        return {
          data: {
            table_block_id: tableBlockId, rows: rows, columns: columns, filled_cells: filled,
            fill_warning: '表格已创建,前 ' + filled + ' 个单元格已写入,后续 batch_update 失败:' + upd.err + '。可重试或用 docx_update_block 手动补。',
            document_url: docxDocUrl(documentId),
          },
        };
      }
      filled += chunk.length;
    }
    return { data: { table_block_id: tableBlockId, rows: rows, columns: columns, filled_cells: filled, document_url: docxDocUrl(documentId) } };
  },
);

wop(
  'docx_update_block',
  'docx',
  '更新单个块的文本内容(text 整段替换该块所有 text elements,适用于纯文本/标题/列表/引用);富文本/复杂样式用 raw_update 透传完整 patch payload(如 update_text_style / update_table_property)。只改文本不改块类型;换类型请删了重建。先 docx_read / docx_list_block_children 拿准 block_id 与原内容,执行前与用户确认;成功后把 document_url 以 markdown 链接给用户核对。',
  DOCX_URL_P + ', block_id*:string, text?:string(与 raw_update 二选一), raw_update?:object(完整 patch data,直接透传)',
  async function (a, c) {
    if (!a.block_id) return { err: '需要 block_id(从 docx_read / docx_list_block_children 返回里拿)' };
    if (a.text === undefined && !a.raw_update) return { err: 'text 与 raw_update 必须提供其一' };
    var resolved = await resolveDocxDocumentId(a.url_or_document_id, c);
    if (resolved.err) return { err: resolved.err };
    var documentId = resolved.documentId;
    var body = a.raw_update && typeof a.raw_update === 'object'
      ? a.raw_update
      : { update_text_elements: { elements: [{ text_run: { content: typeof a.text === 'string' ? a.text : '' } }] } };
    var r = await api({
      url: API + '/open-apis/docx/v1/documents/' + encodeURIComponent(documentId) +
        '/blocks/' + encodeURIComponent(String(a.block_id)),
      method: 'PATCH',
      body: body,
      callId: c,
    });
    if (r.err) return { err: r.err };
    var d = r.data || {};
    return { data: { updated: true, block: d.block, document_url: docxDocUrl(documentId) } };
  },
);

wop(
  'docx_delete_blocks',
  'docx',
  '删除指定父块下 [start_index, end_index) 区间的子块(左闭右开)。【危险,不可撤销】执行前必须先 docx_read / docx_list_block_children 列出区间内每个块的内容,与用户确认"要删这几段"拿到明确同意再动手。这是块级删除,不是删整篇文档。成功后把 document_url 以 markdown 链接给用户核对。',
  DOCX_URL_P + ', parent_block_id*:string(删根级块传 document_id), start_index*:int(>=0,包含), end_index*:int(不包含)',
  async function (a, c) {
    if (!a.parent_block_id) return { err: '需要 parent_block_id(删根级块传 document_id)' };
    var start = Math.floor(Number(a.start_index));
    var end = Math.floor(Number(a.end_index));
    if (!(start >= 0) || !(end >= 0)) return { err: 'start_index / end_index 必须是 >=0 的整数' };
    if (end <= start) return { err: 'end_index 必须大于 start_index(左闭右开)' };
    var resolved = await resolveDocxDocumentId(a.url_or_document_id, c);
    if (resolved.err) return { err: resolved.err };
    var documentId = resolved.documentId;
    var r = await api({
      url: API + '/open-apis/docx/v1/documents/' + encodeURIComponent(documentId) +
        '/blocks/' + encodeURIComponent(String(a.parent_block_id)) + '/children/batch_delete',
      method: 'DELETE',
      body: { start_index: start, end_index: end },
      callId: c,
    });
    if (r.err) return { err: r.err };
    var d = r.data || {};
    return {
      data: {
        deleted_range: [start, end],
        document_revision_id: d.document_revision_id,
        document_url: docxDocUrl(documentId),
      },
    };
  },
);

wop(
  'docx_upload_image',
  'docx',
  '把图片上传并绑定到文档里已存在的空图片块(block_type=27)。完整流程:1) docx_insert_blocks 插入 block_type=27 空块拿到 block_id;2) 调本工具。图片来源走过户票据(不收本地路径参数):聊天/总仓里的图片让主 agent 把取件地址(或指纹)放 ghost_call 顶层 attachments;用户本地图片文件让主 agent 放顶层 dir(单文件过户)。单张 ≤20MB;与 IM 的 image_key 不通用。执行前与用户确认;成功后把 document_url 以 markdown 链接给用户核对。',
  DOCX_URL_P + ', block_id*:string(空图片块 block_id), file_name?:string(默认 image.png) —— 图片字节经顶层 attachments(总仓图片)或顶层 dir(本地文件过户)提供',
  async function (a, c) {
    if (!a.block_id) return { err: '需要 block_id(先用 docx_insert_blocks 插入 block_type=27 空块拿到)' };
    var resolved = await resolveDocxDocumentId(a.url_or_document_id, c);
    if (resolved.err) return { err: resolved.err };
    var documentId = resolved.documentId;

    // '{bytes}' 是主机占位符,上传时自动替换为文件真实字节数。
    var fields = {
      parent_type: 'docx_image',
      parent_node: a.block_id,
      size: '{bytes}',
      file_name: a.file_name || 'image.png',
    };
    var up = null;
    var hash = Array.isArray(a.attachments) && a.attachments.length > 0 ? extractHash(a.attachments[0]) : null;
    if (hash) {
      up = await uploadMedia(API + '/open-apis/drive/v1/medias/upload_all', [hash], 'file', fields, c);
    } else if (a.dir_deposit && a.dir_deposit.token) {
      up = await uploadWorkdirFile(API + '/open-apis/drive/v1/medias/upload_all', a.dir_deposit.token, 'file', fields, c);
    } else {
      return { err: '需要图片来源:聊天/总仓图片请主 agent 调 ghost_call 时放顶层 attachments(取件地址),本地图片文件放顶层 dir(单文件过户)' };
    }
    if (up.err) return { err: up.err };
    var fileToken = up.data && up.data.file_token;
    if (typeof fileToken !== 'string' || fileToken.length === 0) {
      return { err: '素材上传成功但飞书未返回 file_token,无法绑定图片块' };
    }

    // 写回图片块(与老 MCP 同款:documentBlock.patch + replace_image)。
    var patch = await api({
      url: API + '/open-apis/docx/v1/documents/' + encodeURIComponent(documentId) +
        '/blocks/' + encodeURIComponent(String(a.block_id)),
      method: 'PATCH',
      body: { replace_image: { token: fileToken } },
      callId: c,
    });
    if (patch.err) {
      return { err: '素材已上传(file_token: ' + fileToken + '),但写回图片块失败:' + patch.err + '——文档中可能留下空图片块,可重试本工具' };
    }
    return {
      data: {
        uploaded: true,
        file_token: fileToken,
        block_id: a.block_id,
        document_url: docxDocUrl(documentId),
      },
    };
  },
);

/* ═══ wiki 操作注册 ═════════════════════════════════════════════════ */

op(
  'wiki_list_spaces',
  'wiki',
  '列出当前用户可访问的飞书知识空间(可按名称本地过滤),用于先拿 space_id 再调 wiki_list_children / wiki_create_node。',
  'query?:string(名称包含过滤,本地), page_size?:int(1-50,默认20), page_token?:string',
  async function (a, c) {
    var r = await api({
      url: API + '/open-apis/wiki/v2/spaces' + qs({ page_size: a.page_size || 20, page_token: a.page_token }),
      callId: c,
    });
    if (r.err) return { err: r.err };
    var d = r.data || {};
    var items = d.items || [];
    var q = a.query ? String(a.query).trim().toLowerCase() : '';
    var spaces = [];
    for (var i = 0; i < items.length; i++) {
      var s = items[i];
      if (q && String(s.name || '').toLowerCase().indexOf(q) < 0) continue;
      spaces.push({
        name: s.name,
        description: s.description,
        space_id: s.space_id,
        space_type: s.space_type,
        visibility: s.visibility,
        open_sharing: s.open_sharing,
      });
    }
    return { data: { spaces: spaces, has_more: d.has_more, page_token: d.page_token, filtered_by_query: a.query } };
  },
);

op(
  'wiki_read',
  'wiki',
  '读取飞书知识库节点内容:先解析节点,docx 节点返回全文(正文 + 图片清单 + 内嵌块提示 + todos,同 docx_read;max_images>0 时图片经媒体总仓下载,交回 media_url 取件地址,markdown 嵌入即可显示);bitable / sheet 节点不读内容,返回 obj_token 并指路对应类目工具继续读。',
  'node_id*:string(wiki 节点 token), space_id?:string(可选,解析用不到), max_images?:int(0-20,默认0,仅 docx 节点有效)',
  async function (a, c) {
    if (!a.node_id) return { err: '需要 node_id(wiki 节点 token,来自 wiki URL 或 wiki_list_children)' };
    var w = await resolveWikiNode(String(a.node_id), a.space_id, c);
    if (w.err) return { err: w.err };
    var node = w.node;
    if (node.obj_type === 'bitable') {
      return {
        data: {
          node: node,
          hint: '该节点是多维表格,本工具不读表内容——用 bitable 类目工具继续(app_token = obj_token:' + node.obj_token + ',先 bitable_list_tables 再 bitable_list_records)',
        },
      };
    }
    if (node.obj_type === 'sheet') {
      return {
        data: {
          node: node,
          hint: '该节点是电子表格,本工具不读表内容——用 sheet 类目工具继续(spreadsheet_token = obj_token:' + node.obj_token + ',先 sheet_list_sheets 再 sheet_read_range)',
        },
      };
    }
    var r = await readDocCore(node.obj_token, a.max_images, c);
    if (r.err) return { err: r.err };
    return {
      data: {
        node_token: node.node_token,
        space_id: node.space_id,
        obj_type: node.obj_type,
        document: r.doc,
      },
    };
  },
);

op(
  'wiki_list_children',
  'wiki',
  '列出飞书知识库节点的全部子节点(内部自动翻页拉完所有分页,一次拿全)。子节点的 node_token 可继续传给 wiki_read / wiki_list_children。',
  'space_id*:string, node_id*:string(父节点 token)',
  async function (a, c) {
    if (!a.space_id || !a.node_id) return { err: '需要 space_id 与 node_id(父节点 token)' };
    var r = await paginateAll(function (pageToken) {
      return api({
        url: API + '/open-apis/wiki/v2/spaces/' + encodeURIComponent(String(a.space_id)) + '/nodes' +
          qs({ parent_node_token: a.node_id, page_size: 50, page_token: pageToken }),
        callId: c,
      });
    }, 40);
    if (r.err) return { err: r.err };
    var children = [];
    for (var i = 0; i < r.items.length; i++) {
      var n = r.items[i];
      children.push({
        node_token: n.node_token,
        title: n.title,
        obj_type: n.obj_type,
        obj_token: n.obj_token,
        has_child: n.has_child,
      });
    }
    return { data: { children: children } };
  },
);

wop(
  'wiki_create_node',
  'wiki',
  '在飞书知识库指定空间/父节点下创建新节点(默认 docx 新文档;不传 parent_node_token 建在空间根目录)。执行前与用户确认(至少列出:space_id、父节点、标题、文档类型)。以登录用户身份操作,无父节点容器编辑权限会失败。成功返回 node_token / obj_token / url,docx 类型可继续用 docx_append_blocks 写内容;回复末尾把 url 以 markdown 链接给用户。',
  'space_id*:string, title*:string, parent_node_token?:string(不传=空间根), obj_type?:string(docx|doc|sheet|bitable|mindnote|file|slides,默认 docx)',
  async function (a, c) {
    if (!a.space_id) return { err: '需要 space_id(从 wiki URL 或 wiki_list_spaces 拿)' };
    if (!a.title || !String(a.title).trim()) return { err: '需要 title(文档标题,非空)' };
    var objType = a.obj_type || 'docx';
    var body = { obj_type: objType, node_type: 'origin', title: String(a.title) };
    if (a.parent_node_token) body.parent_node_token = a.parent_node_token;
    var r = await api({
      url: API + '/open-apis/wiki/v2/spaces/' + encodeURIComponent(String(a.space_id)) + '/nodes',
      method: 'POST',
      body: body,
      callId: c,
    });
    if (r.err) return { err: r.err };
    var node = r.data && r.data.node;
    if (!node || !node.node_token) return { err: '飞书未返回 node_token,创建结果不明——去知识库确认后重试' };
    return {
      data: {
        node_token: node.node_token,
        obj_token: node.obj_token,
        obj_type: node.obj_type,
        title: node.title || a.title,
        space_id: node.space_id || a.space_id,
        url: DOC_LINK_BASE + '/wiki/' + node.node_token,
        hint: objType === 'docx'
          ? '已建好空文档,可用 docx_append_blocks(传 url 或 obj_token)往里面写内容'
          : '节点已建好,后续编辑请用对应类型的工具',
      },
    };
  },
);
// </PART:DOCX_WIKI>

// <PART:BITABLE_SHEET>
/* ═══ BITABLE + SHEET 精品操作(移植自老 lizi_feishu MCP server.ts:bitable 12 个 + sheet 4 个) ═══ */

/* -- bitable 局部助手(bt 前缀,避免与其它 part 冲突) -- */

var BT_FIELD_DOC =
  '{field_name*:string(表内唯一), type*: text|number|single_select|multi_select|date|checkbox|user|link|raw, ' +
  'options?:string[](单选/多选必填,候选项名), date_formatter?:string(date 展示格式,默认 yyyy/MM/dd), ' +
  'user_multiple?:bool(user 是否多选,默认 false), number_formatter?:string(如 "0"/"0.00",默认 "0"), ' +
  'raw_type?:int(type=raw 必填,飞书原生 type 数字), raw_ui_type?:string, raw_property?:object(type=raw 时透传完整 property)}';

var BT_VALUE_DOC =
  '字段值类型:文本/链接 "abc" 或 {text,link};数字/复选框 123/true;单选 "选项名"(不存在会自动创建);' +
  '多选/人员 ["A","B"]/[{id:"open_id"}];日期传 Unix 毫秒时间戳;稀有类型按飞书官方 schema 传';

/** 友好字段规格 → 飞书字段 payload(老 MCP buildBitableField 同款映射:
 *  text=1 number=2 single_select=3 multi_select=4 date=5 checkbox=7 user=11 link(Url)=15;raw 透传)。
 *  返回 { field } | { err }。 */
function btField(spec) {
  if (!spec || typeof spec !== 'object' || !spec.field_name || !spec.type) {
    return { err: '字段定义需要 field_name 与 type;规格:' + BT_FIELD_DOC };
  }
  var name = String(spec.field_name);
  var i;
  var opts;
  switch (spec.type) {
    case 'text':
      return { field: { field_name: name, type: 1, ui_type: 'Text' } };
    case 'number':
      return {
        field: {
          field_name: name, type: 2, ui_type: 'Number',
          property: { formatter: spec.number_formatter !== undefined ? spec.number_formatter : '0' },
        },
      };
    case 'single_select':
    case 'multi_select':
      if (!Array.isArray(spec.options) || spec.options.length === 0) {
        return { err: spec.type + ' 字段必须提供 options(候选项名称列表)' };
      }
      opts = [];
      for (i = 0; i < spec.options.length; i++) opts.push({ name: String(spec.options[i]) });
      return {
        field: {
          field_name: name,
          type: spec.type === 'single_select' ? 3 : 4,
          ui_type: spec.type === 'single_select' ? 'SingleSelect' : 'MultiSelect',
          property: { options: opts },
        },
      };
    case 'date':
      return {
        field: {
          field_name: name, type: 5, ui_type: 'DateTime',
          property: { date_formatter: spec.date_formatter !== undefined ? spec.date_formatter : 'yyyy/MM/dd' },
        },
      };
    case 'checkbox':
      return { field: { field_name: name, type: 7, ui_type: 'Checkbox' } };
    case 'user':
      return {
        field: {
          field_name: name, type: 11, ui_type: 'User',
          property: { multiple: spec.user_multiple !== undefined ? Boolean(spec.user_multiple) : false },
        },
      };
    case 'link':
      return { field: { field_name: name, type: 15, ui_type: 'Url' } };
    case 'raw': {
      if (typeof spec.raw_type !== 'number') {
        return { err: 'type=raw 时必须提供 raw_type(飞书原生 type 数字,见 open.feishu.cn 字段类型表)' };
      }
      var out = { field_name: name, type: spec.raw_type };
      if (spec.raw_ui_type) out.ui_type = spec.raw_ui_type;
      if (spec.raw_property) out.property = spec.raw_property;
      return { field: out };
    }
    default:
      return { err: '未知字段类型:' + spec.type + ';规格:' + BT_FIELD_DOC };
  }
}

/** 批量构建字段;任一失败即整体报错(老 MCP INVALID_ARGS 同口径)。 */
function btFields(list) {
  var built = [];
  for (var i = 0; i < list.length; i++) {
    var r = btField(list[i]);
    if (r.err) return { err: '第 ' + (i + 1) + ' 个字段:' + r.err };
    built.push(r.field);
  }
  return { fields: built };
}

/** 拼可点击的多维表格 URL(table_id / view_id 可选)。 */
function btUrl(appToken, tableId, viewId) {
  var url = 'https://feishu.cn/base/' + appToken;
  var parts = [];
  if (tableId) parts.push('table=' + tableId);
  if (viewId) parts.push('view=' + viewId);
  return parts.length ? url + '?' + parts.join('&') : url;
}

/** bitable REST 路径前缀(路径段逐一 encodeURIComponent)。 */
function btBase(appToken, tableId) {
  var p = API + '/open-apis/bitable/v1/apps/' + encodeURIComponent(appToken);
  if (tableId) p += '/tables/' + encodeURIComponent(tableId);
  return p;
}

/* -- bitable 读操作 -- */

op('bitable_list_tables', 'bitable',
  '列出多维表格(app)中的所有数据表。返回每张表的 table_id / name / revision',
  'app_token*:string',
  async function (a, c) {
    if (!a.app_token) return { err: '需要 app_token' };
    var r = await paginateAll(function (t) {
      return api({ url: btBase(a.app_token) + '/tables' + qs({ page_size: 100, page_token: t }), callId: c });
    });
    if (r.err) return { err: r.err };
    var items = [];
    for (var i = 0; i < r.items.length; i++) {
      items.push({ table_id: r.items[i].table_id, name: r.items[i].name, revision: r.items[i].revision });
    }
    return { data: { tables: items } };
  });

op('bitable_list_fields', 'bitable',
  '获取数据表的字段 schema(写记录前必读:字段名大小写敏感,错一个字整批失败)。返回 field_id / field_name / type / property',
  'app_token*:string, table_id*:string',
  async function (a, c) {
    if (!a.app_token || !a.table_id) return { err: '需要 app_token 与 table_id' };
    var r = await paginateAll(function (t) {
      return api({ url: btBase(a.app_token, a.table_id) + '/fields' + qs({ page_size: 100, page_token: t }), callId: c });
    });
    if (r.err) return { err: r.err };
    var items = [];
    for (var i = 0; i < r.items.length; i++) {
      var f = r.items[i];
      items.push({ field_id: f.field_id, field_name: f.field_name, type: f.type, property: f.property });
    }
    return { data: { fields: items } };
  });

op('bitable_list_records', 'bitable',
  '查询数据表记录,可带飞书 filter 表达式筛选;结果多时用分页或收窄 filter',
  'app_token*:string, table_id*:string, filter?:string(如 AND(CurrentValue.[状态]="进行中")), ' + PP_DOC + '(page_size 默认 20)',
  async function (a, c) {
    if (!a.app_token || !a.table_id) return { err: '需要 app_token 与 table_id' };
    var r = await api({
      url: btBase(a.app_token, a.table_id) + '/records' +
        qs({ page_size: a.page_size || 20, page_token: a.page_token, filter: a.filter }),
      callId: c,
    });
    if (r.err) return { err: r.err };
    var d = r.data || {};
    var out = { records: d.items || [], total: d.total };
    if (d.has_more) {
      out.has_more = true;
      out.page_token = d.page_token;
      out.hint = '还有更多记录:收窄 filter 或用 page_token 翻页';
    }
    return { data: out };
  });

/* -- bitable 写操作(全部「执行前与用户确认」) -- */

wop('bitable_create_app', 'bitable',
  '创建一个新的多维表格(Base 文件),返回 app_token + 可点击 URL,后续用 bitable_create_table 加表、bitable_create_records 写记录;执行前与用户确认。成功后回复末尾附 [飞书多维表格](url) 链接',
  'name*:string(云空间显示的文件名), folder_token?:string(目标文件夹,不传落到根目录), time_zone?:string(默认 Asia/Shanghai)',
  async function (a, c) {
    if (!a.name) return { err: '需要 name(多维表格名称)' };
    var body = { name: a.name, time_zone: a.time_zone || 'Asia/Shanghai' };
    if (a.folder_token) body.folder_token = a.folder_token;
    var r = await api({ url: API + '/open-apis/bitable/v1/apps', method: 'POST', body: body, callId: c });
    if (r.err) return { err: r.err };
    var app = (r.data || {}).app;
    if (!app || !app.app_token) return { err: '飞书未返回 app_token' };
    return {
      data: {
        app_token: app.app_token,
        name: app.name || a.name,
        default_table_id: app.default_table_id,
        folder_token: app.folder_token,
        time_zone: app.time_zone,
        url: app.url || btUrl(app.app_token, app.default_table_id),
        hint: '已建好空多维表格,可用 bitable_create_table 加表 / bitable_create_records 写记录',
      },
    };
  });

wop('bitable_create_table', 'bitable',
  '在已有多维表格里创建数据表,可同时声明初始字段(友好枚举 + raw 透传);执行前与用户确认。成功后回复末尾附 [飞书多维表格](url) 链接',
  'app_token*:string, name*:string(app 内唯一), default_view_name?:string, fields?:[' + BT_FIELD_DOC + '](不传 = 只有自动生成的索引字段)',
  async function (a, c) {
    if (!a.app_token || !a.name) return { err: '需要 app_token 与 name' };
    var table = { name: a.name };
    if (a.default_view_name) table.default_view_name = a.default_view_name;
    if (Array.isArray(a.fields) && a.fields.length > 0) {
      var built = btFields(a.fields);
      if (built.err) return { err: built.err };
      table.fields = built.fields;
    }
    var r = await api({ url: btBase(a.app_token) + '/tables', method: 'POST', body: { table: table }, callId: c });
    if (r.err) return { err: r.err };
    var d = r.data || {};
    return {
      data: {
        table_id: d.table_id,
        default_view_id: d.default_view_id,
        field_ids: d.field_id_list,
        url: btUrl(a.app_token, d.table_id, d.default_view_id),
      },
    };
  });

wop('bitable_delete_table', 'bitable',
  '删除多维表格中的一个数据表——不可恢复!先 bitable_list_tables 确认目标 table_id,执行前与用户确认',
  'app_token*:string, table_id*:string',
  async function (a, c) {
    if (!a.app_token || !a.table_id) return { err: '需要 app_token 与 table_id' };
    var r = await api({ url: btBase(a.app_token, a.table_id), method: 'DELETE', callId: c });
    if (r.err) return { err: r.err };
    return { data: { deleted: true, app_token: a.app_token, table_id: a.table_id, url: btUrl(a.app_token) } };
  });

wop('bitable_create_field', 'bitable',
  '在数据表里新增字段(type 友好枚举 + 各自专属参数;稀有类型 type=raw 透传);执行前与用户确认',
  'app_token*:string, table_id*:string, field*:' + BT_FIELD_DOC,
  async function (a, c) {
    if (!a.app_token || !a.table_id) return { err: '需要 app_token 与 table_id' };
    var built = btField(a.field);
    if (built.err) return { err: built.err };
    var r = await api({ url: btBase(a.app_token, a.table_id) + '/fields', method: 'POST', body: built.field, callId: c });
    if (r.err) return { err: r.err };
    var f = (r.data || {}).field || {};
    return {
      data: {
        field_id: f.field_id, field_name: f.field_name, type: f.type,
        url: btUrl(a.app_token, a.table_id),
      },
    };
  });

wop('bitable_update_field', 'bitable',
  '修改已有字段(整体覆盖:可改名、改类型)——改类型可能丢列数据!先 bitable_list_fields 看当前定义,执行前与用户确认并说清丢数据风险',
  'app_token*:string, table_id*:string, field_id*:string, field*:' + BT_FIELD_DOC + '(新的完整定义)',
  async function (a, c) {
    if (!a.app_token || !a.table_id || !a.field_id) return { err: '需要 app_token / table_id / field_id' };
    var built = btField(a.field);
    if (built.err) return { err: built.err };
    var r = await api({
      url: btBase(a.app_token, a.table_id) + '/fields/' + encodeURIComponent(a.field_id),
      method: 'PUT', body: built.field, callId: c,
    });
    if (r.err) return { err: r.err };
    var f = (r.data || {}).field || {};
    return {
      data: {
        field_id: f.field_id || a.field_id, field_name: f.field_name, type: f.type,
        url: btUrl(a.app_token, a.table_id),
      },
    };
  });

wop('bitable_delete_field', 'bitable',
  '删除一个字段——列数据全部丢失,不可恢复!先 bitable_list_fields 确认字段,执行前与用户确认',
  'app_token*:string, table_id*:string, field_id*:string',
  async function (a, c) {
    if (!a.app_token || !a.table_id || !a.field_id) return { err: '需要 app_token / table_id / field_id' };
    var r = await api({
      url: btBase(a.app_token, a.table_id) + '/fields/' + encodeURIComponent(a.field_id),
      method: 'DELETE', callId: c,
    });
    if (r.err) return { err: r.err };
    return { data: { deleted: true, field_id: a.field_id, url: btUrl(a.app_token, a.table_id) } };
  });

wop('bitable_create_records', 'bitable',
  '批量创建记录(单次 1-1000 条)。字段名必须与表 schema 完全一致——先 bitable_list_fields 核对;执行前与用户确认。成功后说明创建条数并附表格链接',
  'app_token*:string, table_id*:string, records*:[{fields:{字段名:值}}];' + BT_VALUE_DOC,
  async function (a, c) {
    if (!a.app_token || !a.table_id) return { err: '需要 app_token 与 table_id' };
    if (!Array.isArray(a.records) || a.records.length < 1 || a.records.length > 1000) {
      return { err: '需要 records 数组(1-1000 条,每项 {fields:{字段名:值}})' };
    }
    for (var i = 0; i < a.records.length; i++) {
      if (!a.records[i] || typeof a.records[i].fields !== 'object' || a.records[i].fields === null) {
        return { err: '第 ' + (i + 1) + ' 条记录缺少 fields 对象' };
      }
    }
    var r = await api({
      url: btBase(a.app_token, a.table_id) + '/records/batch_create',
      method: 'POST', body: { records: a.records }, callId: c,
    });
    if (r.err) return { err: r.err };
    var created = (r.data || {}).records || [];
    var ids = [];
    for (var j = 0; j < created.length; j++) if (created[j].record_id) ids.push(created[j].record_id);
    return { data: { created_count: created.length, record_ids: ids, url: btUrl(a.app_token, a.table_id) } };
  });

wop('bitable_update_records', 'bitable',
  '批量更新记录(单次 1-1000 条,部分更新:只传要改的字段);执行前与用户确认。成功后说明影响条数',
  'app_token*:string, table_id*:string, records*:[{record_id*:string, fields:{字段名:值}}];' + BT_VALUE_DOC,
  async function (a, c) {
    if (!a.app_token || !a.table_id) return { err: '需要 app_token 与 table_id' };
    if (!Array.isArray(a.records) || a.records.length < 1 || a.records.length > 1000) {
      return { err: '需要 records 数组(1-1000 条,每项 {record_id, fields})' };
    }
    for (var i = 0; i < a.records.length; i++) {
      var rec = a.records[i];
      if (!rec || !rec.record_id || typeof rec.fields !== 'object' || rec.fields === null) {
        return { err: '第 ' + (i + 1) + ' 条记录需要 record_id 与 fields' };
      }
    }
    var r = await api({
      url: btBase(a.app_token, a.table_id) + '/records/batch_update',
      method: 'POST', body: { records: a.records }, callId: c,
    });
    if (r.err) return { err: r.err };
    var updated = (r.data || {}).records || [];
    var ids = [];
    for (var j = 0; j < updated.length; j++) if (updated[j].record_id) ids.push(updated[j].record_id);
    return { data: { updated_count: updated.length, record_ids: ids, url: btUrl(a.app_token, a.table_id) } };
  });

wop('bitable_delete_records', 'bitable',
  '批量删除记录(按 record_id,单次 1-500 条)——不可恢复!先 bitable_list_records 拉到要删的 record_id,执行前与用户确认',
  'app_token*:string, table_id*:string, record_ids*:string[](1-500 个)',
  async function (a, c) {
    if (!a.app_token || !a.table_id) return { err: '需要 app_token 与 table_id' };
    if (!Array.isArray(a.record_ids) || a.record_ids.length < 1 || a.record_ids.length > 500) {
      return { err: '需要 record_ids 数组(1-500 个 record_id)' };
    }
    var r = await api({
      url: btBase(a.app_token, a.table_id) + '/records/batch_delete',
      method: 'POST', body: { records: a.record_ids }, callId: c,
    });
    if (r.err) return { err: r.err };
    var deleted = (r.data || {}).records || [];
    var n = 0;
    for (var i = 0; i < deleted.length; i++) if (deleted[i].deleted) n++;
    return { data: { deleted_count: n, requested_count: a.record_ids.length, url: btUrl(a.app_token, a.table_id) } };
  });

/* -- sheet 局部助手(sh 前缀) -- */

var SH_TARGET_DOC =
  'spreadsheet*:string(飞书 sheets URL、wiki sheet URL 或裸 spreadsheet_token;wiki 节点自动解析到 obj_token,非 sheet 类型会拒绝;URL 的 ?sheet=/table=/view= 参数会作为默认页签提示)';

/** 电子表格定位:URL(sheets/wiki)或裸 token → { token, sheetHint?, tableHint?, viewHint? } | { err }。 */
async function shResolve(input, callId) {
  var s = String(input || '').trim();
  if (!s) return { err: '需要 spreadsheet(URL 或 spreadsheet_token)' };
  var parsed = parseFeishuUrl(s);
  if (parsed) {
    var hints = {
      sheetHint: parsed.query.sheet || undefined,
      tableHint: parsed.query.table || undefined,
      viewHint: parsed.query.view || undefined,
    };
    if (parsed.kind === 'sheets') {
      return { token: parsed.token, sheetHint: hints.sheetHint, tableHint: hints.tableHint, viewHint: hints.viewHint };
    }
    if (parsed.kind === 'wiki') {
      var r = await api({ url: API + '/open-apis/wiki/v2/spaces/get_node' + qs({ token: parsed.token }), callId: callId });
      if (r.err) return { err: r.err };
      var node = (r.data || {}).node;
      if (!node || !node.obj_token) return { err: '未找到该 wiki 节点或无权访问' };
      if (node.obj_type !== 'sheet') {
        return { err: 'sheet 工具只支持飞书电子表格;该 wiki 节点是 ' + node.obj_type + ' 类型,请用对应工具' };
      }
      return { token: node.obj_token, sheetHint: hints.sheetHint, tableHint: hints.tableHint, viewHint: hints.viewHint };
    }
    return { err: '仅支持 feishu.cn/sheets/* / wiki/* URL,或裸 spreadsheet_token(收到的是 ' + parsed.kind + ' 链接)' };
  }
  if (/^[A-Za-z0-9]+$/.test(s)) return { token: s };
  return { err: '仅支持 feishu.cn/sheets/* / wiki/* URL,或裸 spreadsheet_token' };
}

function shUrl(token) {
  return 'https://feishu.cn/sheets/' + token;
}

function shV2Base(token) {
  return API + '/open-apis/sheets/v2/spreadsheets/' + encodeURIComponent(token);
}

/** v3 页签元数据(sheet_id / title / index / hidden / grid_properties / resource_type)。 */
async function shSheetsMeta(token, callId) {
  var r = await api({
    url: API + '/open-apis/sheets/v3/spreadsheets/' + encodeURIComponent(token) + '/sheets/query',
    callId: callId,
  });
  if (r.err) return { err: r.err };
  return { sheets: (r.data || {}).sheets || [] };
}

/** v2 metainfo(内嵌多维表格页签的 blockToken 只在这个老接口里给)。 */
async function shV2Meta(token, callId) {
  var r = await api({ url: shV2Base(token) + '/metainfo', callId: callId });
  if (r.err) return { err: r.err };
  return { sheets: (r.data || {}).sheets || [] };
}

function shV2SheetId(sheet) {
  var p = sheet.properties || {};
  return sheet.sheetId || sheet.sheet_id || p.sheetId || p.sheet_id;
}

/** v2 metainfo 页签 → 内嵌多维表格引用 {app_token, table_id, block_type?}(blockToken = `{appToken}_{tableId}`,首个下划线切分)。 */
function shBitableRef(sheet, tableHint) {
  var blockInfo = sheet.blockInfo || (sheet.properties && sheet.properties.blockInfo);
  var blockToken = blockInfo && (blockInfo.blockToken || blockInfo.block_token);
  if (!blockToken) return null;
  var idx = blockToken.indexOf('_');
  var appToken = idx === -1 ? blockToken : blockToken.slice(0, idx);
  var tableId = tableHint || (idx === -1 ? undefined : blockToken.slice(idx + 1));
  if (!appToken || !tableId || tableId.indexOf('tbl') !== 0) return null;
  var ref = { app_token: appToken, table_id: tableId };
  var bt = blockInfo.blockType || blockInfo.block_type;
  if (bt) ref.block_type = bt;
  return ref;
}

/** 定位目标页签:无 selector 取第一个;有则先按 sheet_id 再按 title 精确匹配,miss 时带可选页签清单报错。 */
function shTarget(sheets, selector) {
  var i;
  if (!selector) {
    for (i = 0; i < sheets.length; i++) if (sheets[i].sheet_id) return { sheet: sheets[i] };
    return { err: '电子表格下没有可读取的 sheet 页签' };
  }
  for (i = 0; i < sheets.length; i++) if (sheets[i].sheet_id === selector) return { sheet: sheets[i] };
  for (i = 0; i < sheets.length; i++) if (sheets[i].title === selector) return { sheet: sheets[i] };
  var avail = [];
  for (i = 0; i < sheets.length; i++) avail.push(sheets[i].sheet_id + '(' + (sheets[i].title || '') + ')');
  return { err: '找不到页签「' + selector + '」;sheet 参数传 sheet_id 或页签标题,可选:' + avail.join(' / ') };
}

/** 1-based 列号 → A1 列字母(1→A, 27→AA)。 */
function shColLetter(n) {
  var out = '';
  while (n > 0) {
    var rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/* -- sheet 读操作 -- */

op('sheet_list_sheets', 'sheet',
  '列出电子表格的所有页签:sheet_id / title / index / hidden / 行列数;内嵌多维表格页签额外给 resource_type=bitable 与解析出的 app_token/table_id。读多页签表格后面的页签前先用本工具拿 sheet_id',
  SH_TARGET_DOC,
  async function (a, c) {
    var resolved = await shResolve(a.spreadsheet, c);
    if (resolved.err) return { err: resolved.err };
    var meta = await shSheetsMeta(resolved.token, c);
    if (meta.err) return { err: meta.err };
    var all = meta.sheets;
    var refs = {};
    var hasBitable = false;
    var i;
    for (i = 0; i < all.length; i++) if (all[i].resource_type === 'bitable') hasBitable = true;
    if (hasBitable) {
      // best-effort:v2 metainfo 失败不影响整体列表,bitable 页签只是缺 app_token/table_id
      var v2 = await shV2Meta(resolved.token, c);
      var v2sheets = v2.err ? [] : v2.sheets;
      for (i = 0; i < v2sheets.length; i++) {
        var sid = shV2SheetId(v2sheets[i]);
        if (!sid) continue;
        var ref = shBitableRef(v2sheets[i], sid === resolved.sheetHint ? resolved.tableHint : undefined);
        if (ref) refs[sid] = ref;
      }
    }
    var sheets = [];
    for (i = 0; i < all.length; i++) {
      var s = all[i];
      var gp = s.grid_properties || {};
      var item = {
        sheet_id: s.sheet_id,
        title: s.title,
        index: s.index,
        hidden: s.hidden !== undefined ? s.hidden : false,
        row_count: gp.row_count || 0,
        column_count: gp.column_count || 0,
      };
      if (s.resource_type) item.resource_type = s.resource_type;
      var r2 = refs[s.sheet_id];
      if (r2) {
        item.app_token = r2.app_token;
        item.table_id = r2.table_id;
        if (r2.block_type) item.block_type = r2.block_type;
      }
      sheets.push(item);
    }
    return {
      data: {
        spreadsheet_token: resolved.token,
        sheet_count: sheets.length,
        sheets: sheets,
        url: shUrl(resolved.token),
      },
    };
  });

op('sheet_read_range', 'sheet',
  '读取电子表格指定页签:普通页签按 A1 range 返回单元格二维数组(不传 range 按真实 grid 尺寸精确读);内嵌多维表格页签自动解析 app_token/table_id 并返回前 20 条 records(此时省略 range)。默认读第一个页签,后面的页签传 sheet 参数或带 ?sheet= 的 URL',
  SH_TARGET_DOC + ', range?:string(A1 范围,如 A1:D20 或 Sheet1!A1:D20), sheet?:string(sheet_id 或页签标题;range 自带 "!" 前缀时忽略)',
  async function (a, c) {
    var resolved = await shResolve(a.spreadsheet, c);
    if (resolved.err) return { err: resolved.err };
    // 拆 range 的 "<页签>!" 前缀(按最后一个 "!" 切,带引号页签名去引号);前缀优先于 sheet 参数
    var rangeBody = a.range;
    var rangePrefix;
    if (a.range) {
      var sep = String(a.range).lastIndexOf('!');
      if (sep >= 0) {
        var rawPrefix = String(a.range).slice(0, sep);
        if (rawPrefix.length >= 2 && rawPrefix.charAt(0) === "'" && rawPrefix.charAt(rawPrefix.length - 1) === "'") {
          rangePrefix = rawPrefix.slice(1, -1).replace(/''/g, "'") || undefined;
        } else {
          rangePrefix = rawPrefix || undefined;
        }
        rangeBody = String(a.range).slice(sep + 1);
      }
    }
    var selector = rangePrefix || a.sheet || resolved.sheetHint;
    var meta = await shSheetsMeta(resolved.token, c);
    if (meta.err) return { err: meta.err };
    var t = shTarget(meta.sheets, selector);
    if (t.err) return { err: t.err };
    var target = t.sheet;
    // 内嵌多维表格页签:按记录读取
    if (target.resource_type === 'bitable') {
      if (a.range) return { err: '多维表格页签按记录读取,请省略 A1 range' };
      // URL 的 table/view 提示只属于 ?sheet= 指向的那个页签
      var applyHints = resolved.sheetHint
        ? target.sheet_id === resolved.sheetHint
        : !a.sheet && !rangePrefix;
      var tableHint = applyHints ? resolved.tableHint : undefined;
      var viewHint = applyHints ? resolved.viewHint : undefined;
      var v2 = await shV2Meta(resolved.token, c);
      if (v2.err) return { err: v2.err };
      var ref = null;
      for (var i = 0; i < v2.sheets.length; i++) {
        if (shV2SheetId(v2.sheets[i]) === target.sheet_id) {
          ref = shBitableRef(v2.sheets[i], tableHint);
          break;
        }
      }
      if (!ref) return { err: 'v2 metainfo 未返回可用的内嵌多维表格 blockToken(sheet_id: ' + target.sheet_id + ')' };
      var recs = await api({
        url: btBase(ref.app_token, ref.table_id) + '/records' + qs({ page_size: 20, view_id: viewHint }),
        callId: c,
      });
      if (recs.err) return { err: recs.err };
      var rd = recs.data || {};
      var out = {
        resource_type: 'bitable',
        spreadsheet_token: resolved.token,
        sheet_id: target.sheet_id,
        app_token: ref.app_token,
        table_id: ref.table_id,
        records: rd.items || [],
        total: rd.total,
        has_more: Boolean(rd.has_more),
      };
      if (target.title) out.sheet_title = target.title;
      if (ref.block_type) out.block_type = ref.block_type;
      if (viewHint) out.view_id = viewHint;
      if (rd.has_more) out.page_token = rd.page_token;
      return { data: out };
    }
    // 普通页签:定 range(不传按真实 grid 尺寸,避免超大默认范围触发 10MB 上限)
    var effectiveRange;
    if (rangeBody) {
      effectiveRange = target.sheet_id + '!' + rangeBody;
    } else {
      var gp = target.grid_properties || {};
      var rowCount = gp.row_count || 0;
      var colCount = gp.column_count || 0;
      if (rowCount <= 0 || colCount <= 0) {
        var empty = {
          spreadsheet_token: resolved.token,
          range: target.sheet_id + '!A1:A1',
          row_count: 0, column_count: 0, values: [],
        };
        if (target.title) empty.sheet_title = target.title;
        return { data: empty };
      }
      effectiveRange = target.sheet_id + '!A1:' + shColLetter(colCount) + rowCount;
    }
    var r = await api({
      url: shV2Base(resolved.token) + '/values/' + encodeURIComponent(effectiveRange) + qs({ valueRenderOption: 'ToString' }),
      callId: c,
    });
    if (r.err) return { err: r.err };
    var vr = (r.data || {}).valueRange || {};
    var values = Array.isArray(vr.values) ? vr.values : [];
    var maxCols = 0;
    for (var j = 0; j < values.length; j++) {
      if (Array.isArray(values[j]) && values[j].length > maxCols) maxCols = values[j].length;
    }
    var data = {
      spreadsheet_token: resolved.token,
      range: vr.range || effectiveRange,
      row_count: values.length,
      column_count: maxCols,
      values: values,
    };
    if (target.title) data.sheet_title = target.title;
    return { data: data };
  });

/* -- sheet 写操作(全部「执行前与用户确认」) -- */

wop('sheet_write_range', 'sheet',
  '覆盖写入指定 A1 范围的单元格值(会覆盖目标范围)——写前先 sheet_read_range 确认现状,执行前与用户确认。成功后说明影响行列数并附 [飞书电子表格](url) 链接',
  SH_TARGET_DOC + ', range*:string(目标 A1 范围,如 Sheet1!A2:C4), values*:any[][](按行写入;数字/布尔原生传、空格传 null/"", 公式传 "=SUM(A1:A5)")',
  async function (a, c) {
    if (!a.range) return { err: '需要 range(目标 A1 范围,如 Sheet1!A2:C4)' };
    if (!Array.isArray(a.values) || a.values.length < 1 || !Array.isArray(a.values[0])) {
      return { err: '需要 values(非空二维数组)' };
    }
    var resolved = await shResolve(a.spreadsheet, c);
    if (resolved.err) return { err: resolved.err };
    var r = await api({
      url: shV2Base(resolved.token) + '/values',
      method: 'PUT',
      body: { valueRange: { range: a.range, values: a.values } },
      callId: c,
    });
    if (r.err) return { err: r.err };
    var maxCols = 0;
    for (var i = 0; i < a.values.length; i++) {
      if (Array.isArray(a.values[i]) && a.values[i].length > maxCols) maxCols = a.values[i].length;
    }
    var out = r.data && typeof r.data === 'object' ? JSON.parse(JSON.stringify(r.data)) : {};
    out.spreadsheet_token = resolved.token;
    out.range = a.range;
    out.row_count = a.values.length;
    out.column_count = maxCols;
    out.url = shUrl(resolved.token);
    return { data: out };
  });

wop('sheet_append_rows', 'sheet',
  '在指定页签已有数据末尾追加若干行(API 自动定位末尾,不覆盖已有内容;单次最多 5000 行)——追加前先读表头确认列结构,执行前与用户确认。成功后说明追加行数并附 [飞书电子表格](url) 链接',
  SH_TARGET_DOC + ', range*:string(追加锚点,如 Sheet1!A1,用于指定目标页签与起始列), values*:any[][](要追加的行,≤5000)',
  async function (a, c) {
    if (!a.range) return { err: '需要 range(追加锚点范围,如 Sheet1!A1)' };
    if (!Array.isArray(a.values) || a.values.length < 1 || !Array.isArray(a.values[0])) {
      return { err: '需要 values(非空二维数组)' };
    }
    if (a.values.length > 5000) return { err: 'values 单次最多 5000 行(当前 ' + a.values.length + ' 行)' };
    var resolved = await shResolve(a.spreadsheet, c);
    if (resolved.err) return { err: resolved.err };
    var r = await api({
      url: shV2Base(resolved.token) + '/values_append',
      method: 'POST',
      body: { valueRange: { range: a.range, values: a.values } },
      callId: c,
    });
    if (r.err) return { err: r.err };
    var maxCols = 0;
    for (var i = 0; i < a.values.length; i++) {
      if (Array.isArray(a.values[i]) && a.values[i].length > maxCols) maxCols = a.values[i].length;
    }
    var out = r.data && typeof r.data === 'object' ? JSON.parse(JSON.stringify(r.data)) : {};
    out.spreadsheet_token = resolved.token;
    out.range = a.range;
    out.appended_rows = a.values.length;
    out.column_count = maxCols;
    out.url = shUrl(resolved.token);
    return { data: out };
  });
// </PART:BITABLE_SHEET>

// <PART:IM>
/* ═══ IM:消息(会话列表 / 读消息 / 搜消息 / 发消息 / 传图传文件) ═══════
 * 移植自老 lizi_feishu MCP server.ts 的 im 组 6 个精品工具。
 * 与老版唯一刻意差异:两个上传工具的 file_path 被过户票据取代——
 * 沙箱摸不到本地路径,图片走 attachments(总仓指纹)/ dir(本地单文件),
 * 文件走 dir(本地单文件),由主 agent 在 ghost_call 顶层交付。
 * 下面的 im* 前缀函数是本节私有助手,不与骨架助手重名。
 * ──────────────────────────────────────────────────────────────────── */

/**
 * open_id 集合 → 姓名映射(contact.user.batch,按 50 一批,API 上限)。
 * best-effort:某批失败只跳过该批,绝不抛错——与老 MCP resolveOpenIdsToNames 同语义。
 */
async function imResolveNames(openIds, callId) {
  var all = [];
  var seen = {};
  for (var i = 0; i < openIds.length; i++) {
    var id = openIds[i];
    if (!id || seen[id]) continue;
    seen[id] = 1;
    all.push(id);
  }
  var map = {};
  for (var j = 0; j < all.length; j += 50) {
    var chunk = all.slice(j, j + 50);
    var r = await api({
      url: API + '/open-apis/contact/v3/users/batch' + qs({ user_ids: chunk, user_id_type: 'open_id' }),
      callId: callId,
    });
    if (r.err) continue; // best-effort
    var items = (r.data && r.data.items) || [];
    for (var k = 0; k < items.length; k++) {
      if (items[k] && items[k].open_id && items[k].name) map[items[k].open_id] = items[k].name;
    }
  }
  return map;
}

/** 从消息列表收集 sender / mentions 里的 open_id,批量解析后给每条 sender 盖 sender_name。返回 user_map。 */
async function imStampSenderNames(messages, callId) {
  var openIds = [];
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (m && m.sender && m.sender.id_type === 'open_id' && m.sender.id) openIds.push(m.sender.id);
    if (m && Array.isArray(m.mentions)) {
      for (var j = 0; j < m.mentions.length; j++) {
        var men = m.mentions[j];
        if (men && men.id_type === 'open_id' && men.id) openIds.push(men.id);
      }
    }
  }
  var userMap = await imResolveNames(openIds, callId);
  for (var k = 0; k < messages.length; k++) {
    var msg = messages[k];
    var sid = msg && msg.sender ? msg.sender.id : null;
    if (sid && userMap[sid] !== undefined) msg.sender.sender_name = userMap[sid];
  }
  return userMap;
}

/**
 * thread_id 解析:omt_* 原样;om_* 经 GET messages/:id 取 items[].thread_id;
 * 其它前缀直接报参数错——与老 MCP resolveImThreadId 同语义。
 */
async function imResolveThreadId(threadOrMessageId, callId) {
  var s = String(threadOrMessageId || '');
  if (s.indexOf('omt_') === 0) return { thread_id: s };
  if (s.indexOf('om_') !== 0) {
    return { err: 'thread_id 必须以 omt_ 开头,或传入以 om_ 开头的主消息 message_id 用于自动解析 thread_id。' };
  }
  var r = await api({ url: API + '/open-apis/im/v1/messages/' + encodeURIComponent(s), callId: callId });
  if (r.err) return { err: r.err };
  var items = (r.data && r.data.items) || [];
  var threadId = null;
  for (var i = 0; i < items.length; i++) {
    if (items[i] && items[i].thread_id) { threadId = items[i].thread_id; break; }
  }
  if (!threadId) return { err: '未能从该 message_id(' + s + ')解析到 thread_id。' };
  return { thread_id: threadId };
}

/** 对方 open_id → 单聊 chat_id 反查(im/v1/chat_p2p/batch_query)——与老 MCP resolveP2pChatId 同语义。 */
async function imResolveP2pChatId(openId, callId) {
  var r = await api({
    url: API + '/open-apis/im/v1/chat_p2p/batch_query' + qs({ chatter_id_type: 'open_id' }),
    method: 'POST',
    body: { chatter_ids: [openId] },
    callId: callId,
  });
  if (r.err) return { err: r.err };
  var chats = (r.data && r.data.p2p_chats) || [];
  var chatId = null;
  for (var i = 0; i < chats.length; i++) {
    if (chats[i] && chats[i].chat_id) { chatId = chats[i].chat_id; break; }
  }
  if (!chatId) {
    return { err: '未找到与该用户(open_id=' + openId + ')的单聊会话。通常表示当前登录用户与对方没有历史单聊记录。' };
  }
  return { chat_id: chatId };
}

/** 群搜索 query 归一:已是 JSON 引号串就还原;含 - 时整串加引号(飞书搜索接口习惯)。 */
function imNormalizeChatQuery(query) {
  var q = query;
  try {
    var parsed = JSON.parse(q);
    if (typeof parsed === 'string') q = parsed;
  } catch (e) { /* 非 JSON 引号串,原样 */ }
  if (q.indexOf('-') < 0) return q;
  return JSON.stringify(q);
}

/** chat_modes 语义映射:topic → thread、group → default(去重保序)。 */
function imMapChatModes(modes) {
  var out = [];
  var seen = {};
  for (var i = 0; i < (modes || []).length; i++) {
    var wire = modes[i] === 'topic' ? 'thread' : 'default';
    if (seen[wire]) continue;
    seen[wire] = 1;
    out.push(wire);
  }
  return out;
}

/** msg_type=text 且 content 不是 JSON 对象串时自动包成 {"text":...}——与老 MCP normalizeImMessageContent 同语义。 */
function imNormalizeContent(msgType, content) {
  if (msgType !== 'text') return content;
  var alreadyJson = false;
  try {
    var parsed = JSON.parse(content);
    alreadyJson = typeof parsed === 'object' && parsed !== null;
  } catch (e) {
    alreadyJson = false;
  }
  return alreadyJson ? content : JSON.stringify({ text: content });
}

/* ── im_list_chats ── */

op(
  'im_list_chats',
  'im',
  '列出或搜索当前用户可见的飞书群组/对话。搜群优先传核心关键词(如「小镇工程师群」先搜「小镇工程师」或「工程师」——群名常带前缀/符号,核心词更易命中);结果太多再换窄词或加 exact_name:true 精确后过滤;群名含 - 会自动整串加引号。不带任何搜索参数时走列表模式,sort_type=ByActiveTimeDesc 可取「最近活跃会话」。',
  'query?:string(群名核心关键词,≤64 字,传入即走服务端群搜索), search_types?:string[](private/external/public_joined/public_not_joined), chat_modes?:string[](group=普通群/topic=话题群), member_ids?:string[](成员 open_id,≤50), is_manager?:bool(只看我管理的群), disable_search_by_user?:bool(禁按成员名搜), sort?:create_time|update_time|member_count(搜索排序,固定倒序), exact_name?:bool(按完整群名精确后过滤), sort_type?:ByCreateTimeAsc|ByActiveTimeDesc(仅列表模式), page_size?:int(默认 20,搜索模式 1-100), page_token?:string',
  async function (a, c) {
    var pageSize = Number(a.page_size) >= 1 ? Math.floor(Number(a.page_size)) : 20;
    var useSearch = Boolean(
      (a.query && String(a.query).trim()) ||
      (a.search_types && a.search_types.length) ||
      (a.chat_modes && a.chat_modes.length) ||
      (a.member_ids && a.member_ids.length) ||
      a.is_manager || a.disable_search_by_user || a.sort || a.exact_name,
    );

    if (useSearch) {
      var query = a.query ? String(a.query).trim() : '';
      if (!query && !(a.member_ids && a.member_ids.length)) {
        return { err: '搜索群组时必须传 query 或 member_ids。' };
      }
      if (query && Array.from(query).length > 64) return { err: 'query 最长 64 个字符。' };
      if (a.member_ids && a.member_ids.length > 50) return { err: 'member_ids 最多 50 个。' };

      var applied = Math.min(Math.max(pageSize, 1), 100);
      var body = {};
      if (query) body.query = imNormalizeChatQuery(query);
      var filter = {};
      if (a.search_types && a.search_types.length) filter.search_types = a.search_types;
      var chatModes = imMapChatModes(a.chat_modes);
      if (chatModes.length) filter.chat_modes = chatModes;
      if (a.member_ids && a.member_ids.length) filter.member_ids = a.member_ids;
      if (a.is_manager) filter.is_manager = true;
      if (a.disable_search_by_user) filter.disable_search_by_user = true;
      if (Object.keys(filter).length) body.filter = filter;
      var sorterMap = { create_time: 'create_time_desc', update_time: 'update_time_desc', member_count: 'member_count_desc' };
      if (a.sort && sorterMap[a.sort]) body.sorter = sorterMap[a.sort];
      else if (a.sort) return { err: 'sort 只支持 create_time / update_time / member_count。' };

      var r = await api({
        url: API + '/open-apis/im/v2/chats/search' + qs({ page_size: applied, page_token: a.page_token }),
        method: 'POST',
        body: body,
        callId: c,
      });
      if (r.err) return { err: r.err };

      var d = r.data || {};
      var rawChats = [];
      var items = d.items || [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!it) continue;
        rawChats.push(it.meta_data || it);
      }
      var nameFiltered = Boolean(a.exact_name && query);
      var chats = rawChats;
      if (nameFiltered) {
        chats = [];
        for (var j = 0; j < rawChats.length; j++) {
          if (rawChats[j] && rawChats[j].name === query) chats.push(rawChats[j]);
        }
      }
      var payload = { chats: chats, total: nameFiltered ? chats.length : (d.total !== undefined ? d.total : chats.length) };
      if (nameFiltered) {
        payload.exact_name = true;
        payload.search_total = d.total !== undefined ? d.total : rawChats.length;
      }
      if (d.has_more) {
        payload.has_more = true;
        payload.page_token = d.page_token;
        payload.hint = 'More chats available. Pass the page_token with the same search args to keep paginating.';
      }
      if (pageSize !== applied) {
        payload.requested_page_size = pageSize;
        payload.applied_page_size = applied;
        payload.hint = (payload.hint ? payload.hint + ' ' : '') + 'page_size was clamped to ' + applied + '.';
      }
      return { data: payload };
    }

    var lr = await api({
      url: API + '/open-apis/im/v1/chats' + qs({ page_size: pageSize, sort_type: a.sort_type, page_token: a.page_token }),
      callId: c,
    });
    if (lr.err) return { err: lr.err };
    var ld = lr.data || {};
    var listPayload = { chats: ld.items || [] };
    if (ld.has_more) {
      listPayload.has_more = true;
      listPayload.page_token = ld.page_token;
      listPayload.hint = 'More chats available. Pass the page_token to paginate.';
    }
    return { data: listPayload };
  },
);

/* ── im_read_messages ── */

op(
  'im_read_messages',
  'im',
  '读取飞书群组、单聊或话题串的聊天记录。默认 container_id_type=chat:读群聊传 container_id(chat_id);读单聊可只传对方 open_id(自动反查 p2p chat_id)。读话题回复传 container_id_type=thread + container_id(thread_id,omt_*),只有主消息 ID 时传 message_id(om_*)自动解析。chat 模式默认按创建时间倒序直接读最新;thread 模式默认升序按时间线读。每条消息 sender 已 best-effort 带 sender_name(自动批量解析 open_id→姓名),顶层带 user_map,无需再查通讯录;图片/文件消息可用 media_download 传 message_id + file_key 继续下载。强烈建议传 start_time 限定范围。',
  'container_id?:string(chat 模式 chat_id / thread 模式 thread_id), container_id_type?:chat|thread(默认 chat), open_id?:string(仅 chat 模式,自动反查单聊), message_id?:string(仅 thread 模式,om_* 主消息自动解析 thread_id), start_time?:string(Unix 秒/毫秒或 RFC3339;thread 模式不支持), end_time?:string(同 start_time,缺省到当前), time_zone?:string(解析无时区时间,如 Asia/Shanghai 或 +08:00), sort_type?:ByCreateTimeDesc|ByCreateTimeAsc, page_size?:int(1-50,默认 20,越界自动钳制), page_token?:string',
  async function (a, c) {
    var type = a.container_id_type || 'chat';
    if (type !== 'chat' && type !== 'thread') return { err: 'container_id_type 只支持 chat / thread。' };
    if (type === 'chat' && a.message_id) {
      return { err: 'message_id 仅用于 container_id_type=thread 的话题回复读取。读取普通群聊/单聊时请传 container_id 或 open_id。' };
    }
    if (type === 'thread' && a.open_id) {
      return { err: 'open_id 仅用于 container_id_type=chat 的单聊读取。读取话题回复时请传 container_id(thread_id) 或 message_id。' };
    }

    var targetContainerId = null;
    var sourceMessageId = null;
    if (type === 'thread') {
      if (a.start_time || a.end_time) {
        return { err: '飞书 thread 消息列表不支持 start_time/end_time 过滤。读取 thread 时请使用 page_token 翻页。' };
      }
      if (!a.container_id && !a.message_id) {
        return { err: 'container_id_type=thread 时,container_id(thread_id) 与 message_id 至少传一个。' };
      }
      if (a.container_id && String(a.container_id).indexOf('omt_') === 0) {
        if (a.message_id) {
          var resolved = await imResolveThreadId(a.message_id, c);
          if (resolved.err) return { err: resolved.err };
          if (resolved.thread_id !== a.container_id) {
            return { err: 'container_id(thread_id=' + a.container_id + ') 与 message_id 解析出的 thread_id(' + resolved.thread_id + ') 不一致。' };
          }
          sourceMessageId = a.message_id;
        }
        targetContainerId = a.container_id;
      } else if (a.container_id && a.message_id) {
        return { err: 'container_id_type=thread 时,container_id 传 thread_id(omt_*)即可;如果只有主消息 ID,只传 message_id(om_*)。' };
      } else if (a.message_id) {
        var r1 = await imResolveThreadId(a.message_id, c);
        if (r1.err) return { err: r1.err };
        targetContainerId = r1.thread_id;
        sourceMessageId = a.message_id;
      } else {
        var r2 = await imResolveThreadId(a.container_id, c);
        if (r2.err) return { err: r2.err };
        targetContainerId = r2.thread_id;
      }
    } else {
      if (!a.container_id && !a.open_id) {
        return { err: 'container_id 与 open_id 至少传一个。读取群聊传 container_id;读取单聊可传对方 open_id 自动反查 chat_id。' };
      }
      if (a.container_id && a.open_id) {
        return { err: 'container_id 与 open_id 只能传一个。已知 chat_id 时传 container_id;读取单聊时传对方 open_id。' };
      }
      targetContainerId = a.container_id || null;
      if (!targetContainerId) {
        var p2p = await imResolveP2pChatId(a.open_id, c);
        if (p2p.err) return { err: p2p.err };
        targetContainerId = p2p.chat_id;
      }
    }

    var startTs;
    if (a.start_time) {
      startTs = parseTs(a.start_time, a.time_zone);
      if (startTs === null) {
        return { err: 'start_time 无法解析(' + a.start_time + ')。支持 Unix 秒/毫秒时间戳或 RFC3339/ISO 时间;无时区的日期时间按 time_zone(默认 Asia/Shanghai)解析。' };
      }
    }
    var endTs;
    if (a.end_time) {
      endTs = parseTs(a.end_time, a.time_zone);
      if (endTs === null) {
        return { err: 'end_time 无法解析(' + a.end_time + ')。支持 Unix 秒/毫秒时间戳或 RFC3339/ISO 时间;无时区的日期时间按 time_zone(默认 Asia/Shanghai)解析。' };
      }
    }

    var requested = Number(a.page_size) >= 1 ? Math.floor(Number(a.page_size)) : 20;
    var effective = Math.min(Math.max(requested, 1), 50);
    var sortType = a.sort_type || (type === 'thread' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc');

    var lr = await api({
      url: API + '/open-apis/im/v1/messages' + qs({
        container_id_type: type,
        container_id: targetContainerId,
        page_size: effective,
        start_time: startTs,
        end_time: endTs,
        sort_type: sortType,
        page_token: a.page_token,
      }),
      callId: c,
    });
    if (lr.err) return { err: lr.err };

    var d = lr.data || {};
    var messages = d.items || [];
    var userMap = await imStampSenderNames(messages, c);

    var payload = {};
    if (type === 'thread') {
      payload.thread_id = targetContainerId;
      if (sourceMessageId) payload.source_message_id = sourceMessageId;
    }
    payload.messages = messages;
    payload.user_map = userMap;
    var hints = [];
    if (requested !== effective) {
      payload.requested_page_size = requested;
      payload.applied_page_size = effective;
      hints.push('page_size=' + requested + ' 超出飞书该接口允许范围 [1,50],已按 ' + effective + ' 取本页;需要更多请用 page_token 翻页。');
    }
    if (d.has_more) {
      payload.has_more = true;
      payload.page_token = d.page_token;
      hints.push('More messages available. Pass the page_token to paginate.');
    }
    if (hints.length) payload.hint = hints.join(' ');
    return { data: payload };
  },
);

/* ── im_search_messages ── */

op(
  'im_search_messages',
  'im',
  '按关键词搜索当前登录用户全部可见的飞书消息(跨所有群聊/单聊,可见范围与飞书客户端内搜索一致)。与 im_read_messages 互补:后者需要已知 chat_id,本操作用于「不知道在哪个会话、只记得关键词」时跨会话定位。默认 hydrate=true 对每条命中拉正文并补 sender_name,返回与 im_read_messages 一致的富消息(顶层带 user_map);hydrate=false 只返回 message_ids(更快,但不足以读正文/下载附件——im_read_messages 不接受裸 message_id)。注意:搜索需专用 search:message user scope(不蹭 im:message:readonly),单聊命中补水还需 p2p 读取 scope,未开通时搜索报 scope 错、单聊正文降级为 fetch_error。',
  'query*:string(关键词), from_ids?:string[](按发送者 open_id), chat_ids?:string[](限定会话), at_chatter_ids?:string[](按被@的人 open_id), from_type?:bot|user, chat_type?:group_chat|p2p_chat, message_type?:file|image|media(只搜资源消息), page_size?:int(1-20,默认 20,越界自动钳制), page_token?:string, hydrate?:bool(默认 true 补水成富消息;false 只回 message_ids)',
  async function (a, c) {
    var query = a.query ? String(a.query) : '';
    if (!query) return { err: 'query 必填(搜索关键词)。' };
    if (a.from_type && a.from_type !== 'bot' && a.from_type !== 'user') {
      return { err: 'from_type 只支持 bot / user。' };
    }
    if (a.chat_type && a.chat_type !== 'group_chat' && a.chat_type !== 'p2p_chat') {
      return { err: 'chat_type 只支持 group_chat / p2p_chat。' };
    }
    if (a.message_type && a.message_type !== 'file' && a.message_type !== 'image' && a.message_type !== 'media') {
      return { err: 'message_type 只支持 file / image / media。' };
    }
    var requested = Number(a.page_size) >= 1 ? Math.floor(Number(a.page_size)) : 20;
    var applied = Math.min(Math.max(requested, 1), 20);
    var hydrate = a.hydrate !== false; // 默认 true

    var body = { query: query };
    if (a.from_ids && a.from_ids.length) body.from_ids = a.from_ids;
    if (a.chat_ids && a.chat_ids.length) body.chat_ids = a.chat_ids;
    if (a.at_chatter_ids && a.at_chatter_ids.length) body.at_chatter_ids = a.at_chatter_ids;
    if (a.from_type) body.from_type = a.from_type;
    if (a.chat_type) body.chat_type = a.chat_type;
    if (a.message_type) body.message_type = a.message_type;

    var sr = await api({
      url: API + '/open-apis/search/v2/message' + qs({
        page_size: applied,
        user_id_type: 'open_id',
        page_token: a.page_token,
      }),
      method: 'POST',
      body: body,
      callId: c,
    });
    if (sr.err) return { err: sr.err };

    var sd = sr.data || {};
    var messageIds = [];
    var items = sd.items || [];
    for (var i = 0; i < items.length; i++) {
      if (typeof items[i] === 'string') messageIds.push(items[i]);
    }

    var base = { query: query, count: messageIds.length, has_more: Boolean(sd.has_more) };
    if (sd.has_more && sd.page_token) base.page_token = sd.page_token;

    // 轻量模式:只交 id。(hydrate=true 即使命中为空也走补水分支,保持
    // messages/user_map 的返回形状一致——老 MCP PR #328 review 口径。)
    if (!hydrate) {
      base.message_ids = messageIds;
      if (messageIds.length > 0) {
        base.hint = 'hydrate=false 只返回 message_id 列表,适合只需要 id 的场景(计数/去重/传递);要读正文/发送者/附件请用默认 hydrate=true(im_read_messages 不接受裸 message_id)。';
      }
      return { data: base };
    }

    // 补水:逐条 GET messages/:id 取正文,统一批量解析 open_id → 姓名。
    var messages = [];
    for (var j = 0; j < messageIds.length; j++) {
      var mid = messageIds[j];
      var mr = await api({ url: API + '/open-apis/im/v1/messages/' + encodeURIComponent(mid), callId: c });
      if (mr.err) {
        messages.push({ message_id: mid, fetch_error: String(mr.err).slice(0, 200) });
        continue;
      }
      var got = ((mr.data && mr.data.items) || [])[0];
      if (!got) {
        messages.push({ message_id: mid });
        continue;
      }
      messages.push(got);
    }
    base.user_map = await imStampSenderNames(messages, c);
    base.messages = messages;
    return { data: base };
  },
);

/* ── im_send_message ── */

wop(
  'im_send_message',
  'im',
  '以「当前登录用户」的身份发送飞书消息——接收方看到的发件人就是用户本人,等同于其在飞书 App 里手动发出。执行前必须与用户确认:复述发给谁(群名/人名 + id)和消息正文摘要,拿到明确同意才发。新发消息传 receive_id;回复已有消息传 message_id(om_*),回复模式默认 reply_in_thread=true 进入/创建该消息的话题流,回到主聊天流传 reply_in_thread:false。msg_type=text 时 content 直接传纯文本(自动包成 {"text":...});其他 msg_type 需传符合飞书规范的 JSON 字符串(如发图 msg_type:"image" + content:\'{"image_key":"<key>"}\'、发文件 msg_type:"file" + content:\'{"file_key":"<key>"}\')。已知对方邮箱或按姓名搜不到人时,可用 receive_id_type=email 直发。',
  'receive_id?:string(新发必填,按 receive_id_type 取值), receive_id_type?:open_id|chat_id|email|union_id|user_id(默认 open_id), message_id?:string(回复模式,om_*,与 receive_id 二选一), content*:string(text 直接传文本;其他类型传飞书规范 JSON 串), msg_type?:string(默认 text;常见 text/post/image/file/audio/media/sticker/interactive/share_chat/share_user), reply_in_thread?:bool(仅回复模式,默认 true), uuid?:string(幂等去重 key,1h 窗口)',
  async function (a, c) {
    if (a.content === undefined || a.content === null || a.content === '') {
      return { err: 'content 必填。msg_type=text 直接传文本,其他类型传飞书规范的 JSON 字符串。' };
    }
    if (!a.message_id && !a.receive_id) {
      return { err: '新发消息必须传 receive_id;回复消息必须传 message_id。' };
    }
    if (a.message_id && a.receive_id) {
      return { err: 'receive_id 与 message_id 只能传一个。传 message_id 表示回复消息,传 receive_id 表示新发消息。' };
    }
    if (a.message_id && String(a.message_id).indexOf('om_') !== 0) {
      return { err: 'message_id 必须是 om_ 开头的飞书消息 ID。' };
    }
    var idType = a.receive_id_type || 'open_id';
    var idTypes = ['open_id', 'chat_id', 'email', 'union_id', 'user_id'];
    if (idTypes.indexOf(idType) < 0) {
      return { err: 'receive_id_type 只支持 ' + idTypes.join(' / ') + '。' };
    }
    var msgType = a.msg_type || 'text';
    var payloadContent = imNormalizeContent(msgType, String(a.content));

    if (a.message_id) {
      var replyBody = {
        msg_type: msgType,
        content: payloadContent,
        reply_in_thread: a.reply_in_thread !== false, // 默认 true
      };
      if (a.uuid) replyBody.uuid = a.uuid;
      var rr = await api({
        url: API + '/open-apis/im/v1/messages/' + encodeURIComponent(a.message_id) + '/reply',
        method: 'POST',
        body: replyBody,
        callId: c,
      });
      if (rr.err) return { err: rr.err };
      return { data: rr.data };
    }

    var createBody = {
      receive_id: a.receive_id,
      msg_type: msgType,
      content: payloadContent,
    };
    if (a.uuid) createBody.uuid = a.uuid;
    var cr = await api({
      url: API + '/open-apis/im/v1/messages' + qs({ receive_id_type: idType }),
      method: 'POST',
      body: createBody,
      callId: c,
    });
    if (cr.err) return { err: cr.err };
    return { data: cr.data };
  },
);

/* ── im_upload_image ── */

wop(
  'im_upload_image',
  'im',
  '上传图片到飞书,返回 image_key,用于后续 im_send_message(msg_type=image, content:\'{"image_key":"<key>"}\') 发送。支持 JPEG/PNG/WEBP/GIF/TIFF/BMP/ICO,单张 ≤10MB。图片来源(与老版差异:沙箱无本地路径):聊天里的图片由主 agent 调 ghost_call 时放顶层 attachments(总仓指纹);本地图片文件由主 agent 放顶层 dir(单个文件的绝对路径)过户。上传后通常紧接着发消息给他人,执行前与用户确认目标与图片。',
  'image_type?:message|avatar(默认 message)。图片本体经 ghost_call 顶层票据交付:attachments(聊天图片)或 dir(本地单文件),二选一,attachments 优先',
  async function (a, c) {
    var imageType = a.image_type || 'message';
    if (imageType !== 'message' && imageType !== 'avatar') {
      return { err: 'image_type 只支持 message / avatar。' };
    }
    var url = API + '/open-apis/im/v1/images';
    var fields = { image_type: imageType };

    if (a.attachments && a.attachments.length) {
      var hash = null;
      for (var i = 0; i < a.attachments.length; i++) {
        hash = extractHash(a.attachments[i]);
        if (hash) break;
      }
      if (!hash) return { err: 'attachments 里没有可识别的媒体指纹(需 cindy-media 总仓 64 位十六进制 hash)。' };
      var r = await uploadMedia(url, [hash], 'image', fields, c);
      if (r.err) return { err: r.err };
      return { data: r.data };
    }

    if (a.dir_deposit && a.dir_deposit.token) {
      var w = await uploadWorkdirFile(url, a.dir_deposit.token, 'image', fields, c);
      if (w.err) return { err: w.err };
      return { data: w.data };
    }

    return { err: '没有图片可上传——图片经 ghost_call 顶层 attachments(聊天图片)或 dir(本地文件的绝对路径,单个文件)交付。' };
  },
);

/* ── im_upload_file ── */

wop(
  'im_upload_file',
  'im',
  '上传本地文件(视频/音频/文档等)到飞书,返回 file_key,用于后续 im_send_message 发送:msg_type=file + content:\'{"file_key":"<key>"}\'(音频用 msg_type=audio、视频用 media)。单文件 ≤30MB。文件来源(与老版差异:沙箱无本地路径):由主 agent 调 ghost_call 时把该文件的绝对路径放顶层 dir 参数(单个文件)过户。上传后通常紧接着发消息给他人,执行前与用户确认目标与文件。',
  'file_type*:opus|mp4|pdf|doc|xls|ppt|stream(opus=音频, mp4=视频, pdf/doc/xls/ppt=Office 文档, stream=其他任意二进制), file_name?:string(展示给接收方的文件名,缺省用过户文件名), duration?:number(音视频时长毫秒,仅 opus/mp4 有意义)。文件本体经 ghost_call 顶层 dir(单个文件的绝对路径)交付',
  async function (a, c) {
    var fileTypes = ['opus', 'mp4', 'pdf', 'doc', 'xls', 'ppt', 'stream'];
    if (!a.file_type || fileTypes.indexOf(a.file_type) < 0) {
      return { err: 'file_type 必填且只支持 ' + fileTypes.join(' / ') + '。' };
    }
    if (!a.dir_deposit || !a.dir_deposit.token) {
      return { err: '没有文件可上传——文件经 ghost_call 顶层 dir 参数交付(单个文件的绝对路径)。' };
    }
    var fileName = a.file_name && String(a.file_name).length > 0 ? String(a.file_name) : null;
    if (!fileName) {
      var rel = a.dir_deposit.rel_paths && a.dir_deposit.rel_paths[0] ? String(a.dir_deposit.rel_paths[0]) : '';
      var segs = rel.split(/[\\/]/);
      fileName = segs[segs.length - 1] || 'file';
    }
    var fields = { file_type: a.file_type, file_name: fileName };
    if (a.duration !== undefined && a.duration !== null && a.duration !== '') {
      fields.duration = String(a.duration);
    }
    var r = await uploadWorkdirFile(API + '/open-apis/im/v1/files', a.dir_deposit.token, 'file', fields, c);
    if (r.err) return { err: r.err };
    return { data: r.data };
  },
);
// </PART:IM>

/* ═══ 直通操作(烘焙自 lark-openapi-mcp vendored 定义) ═══════════════ */

// <GEN_OPS>
// 由 scripts/gen-feishu-ghost-ops.mts 生成(直通面 123 条,过滤同老 MCP genTools.ts);手改无效,重跑脚本再生成。
gop('base.v2.appRole.list', 'bitable', 'GET', '/open-apis/base/v2/apps/:app_token/roles', 'Docs-Base-Advanced Permission-Role-List roles-Get all roles according to app_token', 'path{app_token*} params?{page_size?:num,page_token?}');
gop('bitable.v1.appDashboard.list', 'bitable', 'GET', '/open-apis/bitable/v1/apps/:app_token/dashboards', 'Docs-Base-Dashboards-List dashboards-According to app_token, get all dashboards under app', 'path{app_token*} params?{page_size?:num,page_token?}');
gop('bitable.v1.app.get', 'bitable', 'GET', '/open-apis/bitable/v1/apps/:app_token', 'Docs-Base-App-Get App Info-Get App information through app_token', 'path{app_token*}');
gop('bitable.v1.appRole.list', 'bitable', 'GET', '/open-apis/bitable/v1/apps/:app_token/roles', 'Deprecated Version (Not Recommended)-Docs-Base-Role-List roles-Get all roles according to app_token', 'path?{app_token?} params?{page_size?:num,page_token?}');
gop('bitable.v1.appRoleMember.list', 'bitable', 'GET', '/open-apis/bitable/v1/apps/:app_token/roles/:role_id/members', 'Docs-Base-Advanced Permission-Member-List members-Get all members according to app_token and role_id', 'path{app_token*,role_id*} params?{page_size?:num,page_token?}');
gop('bitable.v1.appTableField.list', 'bitable', 'GET', '/open-apis/bitable/v1/apps/:app_token/tables/:table_id/fields', 'Docs-Base-Field-List fields-Get all fields according to app_token and table_id', 'path{app_token*,table_id*} params?{view_id?,text_field_as_array?:bool,page_token?,page_size?:num}');
gop('bitable.v1.appTableFormField.list', 'bitable', 'GET', '/open-apis/bitable/v1/apps/:app_token/tables/:table_id/forms/:form_id/fields', 'Docs-Base-Form-List form fields-Give all form fields according to app_token, table_id and form_id', 'path{app_token*,table_id*,form_id*} params?{page_size?:num,page_token?}');
gop('bitable.v1.appTableForm.get', 'bitable', 'GET', '/open-apis/bitable/v1/apps/:app_token/tables/:table_id/forms/:form_id', 'Docs-Base-Form-List form-Give form according to app_token, table_id and form_id', 'path{app_token*,table_id*,form_id*}');
gop('bitable.v1.appTable.list', 'bitable', 'GET', '/open-apis/bitable/v1/apps/:app_token/tables', 'Docs-Base-Table-List all tables-According to app_token, get all tables under app', 'path{app_token*} params?{page_token?,page_size?:num}');
gop('bitable.v1.appTableRecord.get', 'bitable', 'GET', '/open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/:record_id', 'Deprecated Version (Not Recommended)-Docs-Base-Get records-Get records', 'path{app_token*,table_id*,record_id*} params?{text_field_as_array?:bool,user_id_type?:enum(open_id|union_id|user_id),display_formula_ref?:bool,with_shared_url?:bool,automatic_fields?:bool}');
gop('bitable.v1.appTableRecord.list', 'bitable', 'GET', '/open-apis/bitable/v1/apps/:app_token/tables/:table_id/records', 'Deprecated Version (Not Recommended)-Docs-Base-List records-list records,Up to 500 lines at a time, paging is supported（Currently, the return of search reference fields are not supported. The search reference field can be converted into a formula field. The search reference is essentially a lookup formula）', 'path{app_token*,table_id*} params?{view_id?,filter?,sort?,field_names?,text_field_as_array?:bool,user_id_type?:enum(open_id|union_id|user_id),display_formula_ref?:bool,automatic_fields?:bool,page_token?,page_size?:num}');
gop('bitable.v1.appTableView.get', 'bitable', 'GET', '/open-apis/bitable/v1/apps/:app_token/tables/:table_id/views/:view_id', 'Docs-Base-View-Get View-This interface gets existing views based on view_id', 'path?{app_token?,table_id?,view_id?}');
gop('bitable.v1.appTableView.list', 'bitable', 'GET', '/open-apis/bitable/v1/apps/:app_token/tables/:table_id/views', 'Docs-Base-View-List Views-Get all views of the data table based on app_token and table_id', 'path?{app_token?,table_id?} params?{page_size?:num,page_token?,user_id_type?:enum(open_id|union_id|user_id)}');
gop('bitable.v1.appWorkflow.list', 'bitable', 'GET', '/open-apis/bitable/v1/apps/:app_token/workflows', 'Docs-Base-Automation-List automations-This interface is used to list the automations of base', 'path?{app_token?} params?{page_token?,page_size?:num}');
gop('calendar.v4.calendarAcl.list', 'calendar', 'GET', '/open-apis/calendar/v4/calendars/:calendar_id/acls', 'Calendar-Calendar access control-Obtain the ACL-Call this interface to get the access control list of the specified calendar as the current identity (application or user)', 'path{calendar_id*} params?{user_id_type?:enum(open_id|union_id|user_id),page_token?,page_size?:num}');
gop('calendar.v4.calendarEventAttendeeChatMember.list', 'calendar', 'GET', '/open-apis/calendar/v4/calendars/:calendar_id/events/:event_id/attendees/:attendee_id/chat_members', 'Calendar-Event attendee (Including meeting room)-Obtain the list of members of group invitees of an event-Call this interface with the current identity (app or user) to get the group member list of the group type invitees in the event', 'path{calendar_id*,event_id*,attendee_id*} params?{page_token?,page_size?:num,user_id_type?:enum(open_id|union_id|user_id)}');
gop('calendar.v4.calendarEventAttendee.list', 'calendar', 'GET', '/open-apis/calendar/v4/calendars/:calendar_id/events/:event_id/attendees', 'Calendar-Event attendee (Including meeting room)-Obtain event invitee list-Call this interface to retrieve the list of invitees for a event with the current identity (app or user)', 'path{calendar_id*,event_id*} params?{user_id_type?:enum(open_id|union_id|user_id),need_resource_customization?:bool,page_token?,page_size?:num}');
gop('calendar.v4.calendarEvent.get', 'calendar', 'GET', '/open-apis/calendar/v4/calendars/:calendar_id/events/:event_id', 'Calendar-Event management-Get Event-Call this interface with the current identity (app or user) to obtain the event information within a specified calendar, including the title of the event, time period, video conference information, public scope, and invitee rights, etc', 'path{calendar_id*,event_id*} params?{need_meeting_settings?:bool,need_attendee?:bool,max_attendee_num?:num,user_id_type?:enum(open_id|union_id|user_id)}');
gop('calendar.v4.calendarEvent.instanceView', 'calendar', 'GET', '/open-apis/calendar/v4/calendars/:calendar_id/events/instance_view', 'Calendar-Event management-Query event view-Call this interface with user identity to query the event view under a specified calendar. Unlike [Getting event list], the current interface will expand into multiple event instances according to the repetitiveness rules of the recurring event, and return the corresponding event instance information according to the queried time interval', 'path{calendar_id*} params{start_time*,end_time*,user_id_type?:enum(open_id|union_id|user_id)}');
gop('calendar.v4.calendarEvent.instances', 'calendar', 'GET', '/open-apis/calendar/v4/calendars/:calendar_id/events/:event_id/instances', 'Calendar-Event management-Get Event instances-Call this interface with the current identity (app or user) to obtain information about a specific recurring event in a specified calendar', 'path{calendar_id*,event_id*} params{start_time*,end_time*,page_size?:num,page_token?}');
gop('calendar.v4.calendarEvent.list', 'calendar', 'GET', '/open-apis/calendar/v4/calendars/:calendar_id/events', 'Calendar-Event management-Get Event List-Call this interface with the current identity (app or user) to obtain the event list under a specified calendar', 'path{calendar_id*} params?{page_size?:num,anchor_time?,page_token?,sync_token?,start_time?,end_time?,user_id_type?:enum(open_id|union_id|user_id)}');
gop('calendar.v4.calendar.get', 'calendar', 'GET', '/open-apis/calendar/v4/calendars/:calendar_id', 'Calendar-Calendar management-Query calendar information-Call this interface to query the information of a specified calendar with the current identity (application or user)', 'path{calendar_id*}');
gop('calendar.v4.calendar.list', 'calendar', 'GET', '/open-apis/calendar/v4/calendars', 'Calendar-Calendar management-Query the calendar list-Call this interface to page through and query the calendar list of the current identity (application or user)', 'params?{page_size?:num,page_token?,sync_token?}');
gop('calendar.v4.exchangeBinding.get', 'calendar', 'GET', '/open-apis/calendar/v4/exchange_bindings/:exchange_binding_id', 'Calendar-Synchronize Exchange calendar information-Query the binding status of the Exchange account-Call this interface to obtain the binding status of the Exchange account, including the synchronization status of the Exchange calendar', 'path{exchange_binding_id*} params?{user_id_type?:enum(open_id|union_id|user_id)}');
gop('contact.v3.department.batch', 'contact', 'GET', '/open-apis/contact/v3/departments/batch', 'Contacts-Department-Obtain bulk department information-Call this interface to obtain information about one or more departments, including department name, ID, parent department, person in charge, status, number of members, etc', 'params{department_ids*:arr,department_id_type?:enum(open_department_id|department_id),user_id_type?:enum(open_id|union_id|user_id)}');
gop('contact.v3.department.children', 'contact', 'GET', '/open-apis/contact/v3/departments/:department_id/children', 'Contacts-Department-Obtain the list of sub-departments-Call this interface to query the list of sub-departments under the specified department. The list contains information such as the department’s name, ID, parent department, person in charge, and status', 'path{department_id*} params?{user_id_type?:enum(open_id|union_id|user_id),department_id_type?:enum(department_id|open_department_id),fetch_child?:bool,page_size?:num,page_token?}');
gop('contact.v3.department.get', 'contact', 'GET', '/open-apis/contact/v3/departments/:department_id', 'Contacts-Department-Obtain single department information-Call this interface to obtain information about a single department, including department name, ID, parent department, person in charge, status, number of members, etc', 'path?{department_id?} params?{user_id_type?:enum(open_id|union_id|user_id),department_id_type?:enum(department_id|open_department_id)}');
gop('contact.v3.department.list', 'contact', 'GET', '/open-apis/contact/v3/departments', 'Deprecated Version (Not Recommended)-Contact-Department-Get Department Information List-This API is used to obtain the list of sub-departments of a department. [FAQs]', 'params?{user_id_type?:enum(open_id|union_id|user_id),department_id_type?:enum(department_id|open_department_id),parent_department_id?,fetch_child?:bool,page_token?,page_size?:num}');
gop('contact.v3.department.parent', 'contact', 'GET', '/open-apis/contact/v3/departments/parent', 'Contacts-Department-Obtain parent department information-Call this interface to recursively obtain the parent department information of the specified department, including department name, ID, person in charge, status, etc', 'params{user_id_type?:enum(open_id|union_id|user_id),department_id_type?:enum(department_id|open_department_id),department_id*,page_token?,page_size?:num}');
gop('contact.v3.jobTitle.get', 'contact', 'GET', '/open-apis/contact/v3/job_titles/:job_title_id', 'Contacts-Job title-Query a job title-Call this interface to obtain the information of the specified job title, including the job title’s ID, name, multi-language name, and enabled status', 'path?{job_title_id?}');
gop('contact.v3.jobTitle.list', 'contact', 'GET', '/open-apis/contact/v3/job_titles', 'Contacts-Job title-Query the list of job titles-Call this interface to obtain the job title information of the current tenant, including the job title ID, name, multi-language name, and enabled status', 'params?{page_size?:num,page_token?}');
gop('contact.v3.user.batch', 'contact', 'GET', '/open-apis/contact/v3/users/batch', 'Contacts-User-Obtain multiple users’ information-Call this interface to obtain the information of one or more users in the address book, including user ID, name, email, mobile phone number, status, department and other information', 'params{user_ids*:arr,user_id_type?:enum(open_id|union_id|user_id),department_id_type?:enum(open_department_id|department_id)}');
gop('contact.v3.user.findByDepartment', 'contact', 'GET', '/open-apis/contact/v3/users/find_by_department', 'Contacts-User-Obtain the list of users directly under a department-Call this interface to obtain the user information list directly under the specified department. User information includes user ID, name, email, mobile phone number, status and other information', 'params{user_id_type?:enum(open_id|union_id|user_id),department_id_type?:enum(department_id|open_department_id),department_id*,page_size?:num,page_token?}');
gop('contact.v3.user.get', 'contact', 'GET', '/open-apis/contact/v3/users/:user_id', 'Contacts-User-Obtain single user’s information-Call this interface to obtain the information of a user in the address book, including user ID, name, email, mobile phone number, status, department and other information', 'path{user_id*} params?{user_id_type?:enum(open_id|union_id|user_id),department_id_type?:enum(department_id|open_department_id)}');
gop('contact.v3.user.list', 'contact', 'GET', '/open-apis/contact/v3/users', 'Deprecated Version (Not Recommended)-Contact-User-Get User List-Obtain the list of users directly under the department based on the department ID.[FAQs]', 'params?{user_id_type?:enum(open_id|union_id|user_id),department_id_type?:enum(department_id|open_department_id),department_id?,page_token?,page_size?:num}');
gop('contact.v3.workCity.get', 'contact', 'GET', '/open-apis/contact/v3/work_cities/:work_city_id', 'Contacts-Work city-Query a work city-Call this interface to obtain the information of a specified work city, including the work city’s ID, name, multilingual name, and enabled status', 'path?{work_city_id?}');
gop('contact.v3.workCity.list', 'contact', 'GET', '/open-apis/contact/v3/work_cities', 'Contacts-Work city-Query the list of work cities-Call this interface to obtain information about all work cities under the current tenant, including the work city’s ID, name, multilingual name, and enabled status', 'params?{page_size?:num,page_token?}');
gop('docs.v1.content.get', 'docx', 'GET', '/open-apis/docs/v1/content', 'Docs-Common-Get docs content-You can obtain the docs content. Currently, only upgraded document content in markdown format is supported', 'params{doc_token*,doc_type*,content_type*,lang?:enum(zh|en|ja)}');
gop('docx.v1.chatAnnouncementBlockChildren.get', 'docx', 'GET', '/open-apis/docx/v1/chats/:chat_id/announcement/blocks/:block_id/children', 'Group Chat-Upgraded Group announcement-Block-Obtain all the child blocks', 'path{chat_id*,block_id*} params?{revision_id?:num,page_token?,page_size?:num,user_id_type?:enum(open_id|union_id|user_id)}');
gop('docx.v1.chatAnnouncementBlock.get', 'docx', 'GET', '/open-apis/docx/v1/chats/:chat_id/announcement/blocks/:block_id', 'Group Chat-Upgraded Group announcement-Block-Obtain the block content in group announcement', 'path{chat_id*,block_id*} params?{revision_id?:num,user_id_type?:enum(open_id|union_id|user_id)}');
gop('docx.v1.chatAnnouncementBlock.list', 'docx', 'GET', '/open-apis/docx/v1/chats/:chat_id/announcement/blocks', 'Group Chat-Upgraded Group announcement-Group announcement-Obtain all blocks of a group announcement', 'path{chat_id*} params?{page_size?:num,page_token?,revision_id?:num,user_id_type?:enum(open_id|union_id|user_id)}');
gop('docx.v1.chatAnnouncement.get', 'docx', 'GET', '/open-apis/docx/v1/chats/:chat_id/announcement', 'Group Chat-Upgraded Group announcement-Group announcement-Obtain the basic information of a group announcement-Obtain the basic information of the specified group announcement', 'path{chat_id*} params?{user_id_type?:enum(open_id|union_id|user_id)}');
gop('docx.v1.documentBlockChildren.get', 'docx', 'GET', '/open-apis/docx/v1/documents/:document_id/blocks/:block_id/children', 'Docs-Document-Block-Obtain all the child blocks-Query the Children Block of the specified Block', 'path{document_id*,block_id*} params?{document_revision_id?:num,page_token?,page_size?:num,user_id_type?:enum(open_id|union_id|user_id)}');
gop('docx.v1.documentBlock.get', 'docx', 'GET', '/open-apis/docx/v1/documents/:document_id/blocks/:block_id', 'Docs-Document-Block-Obtain the block content-Query the rich text content of the specified block', 'path{document_id*,block_id*} params?{document_revision_id?:num,user_id_type?:enum(open_id|union_id|user_id)}');
gop('docx.v1.documentBlock.list', 'docx', 'GET', '/open-apis/docx/v1/documents/:document_id/blocks', 'Docs-Document-Document-Obtain all blocks of a document-Perform a deep traversal of all blocks in the specified document and return them in pagination', 'path{document_id*} params?{page_size?:num,page_token?,document_revision_id?:num,user_id_type?:enum(open_id|union_id|user_id)}');
gop('docx.v1.document.get', 'docx', 'GET', '/open-apis/docx/v1/documents/:document_id', 'Docs-Document-Document-Obtain the basic information of a document-Obtains the document title and the latest revision ID', 'path{document_id*}');
gop('docx.v1.document.rawContent', 'docx', 'GET', '/open-apis/docx/v1/documents/:document_id/raw_content', 'Docs-Document-Document-Obtain the plain text content of the document-Obtains the plain text content of the document', 'path{document_id*} params?{lang?:num}');
gop('drive.v1.exportTask.get', 'drive', 'GET', '/open-apis/drive/v1/export_tasks/:ticket', 'Docs-Space-File-Export docs-Query export task results-According to the export task ID (ticket) returned by the [Create Export Task] interface, poll the export task result and return the token of the export file. You can use this token to call the [Download Export File] interface to download the exported file to your local device. For a complete understanding of the export file steps, refer to the [Export docs overview]', 'path{ticket*} params{token*}');
gop('drive.v1.fileComment.get', 'drive', 'GET', '/open-apis/drive/v1/files/:file_token/comments/:comment_id', 'Docs-Comment-Get a whole comment-Obtains a specified global comment in Docs. Local comments are not supported yet', 'path{file_token*,comment_id*} params{file_type*:enum(doc|sheet|file|docx),user_id_type?:enum(open_id|union_id|user_id)}');
gop('drive.v1.fileComment.list', 'drive', 'GET', '/open-apis/drive/v1/files/:file_token/comments', 'Docs-Comment-Get Document Comments in Pages-The API is used to obtain all the comment information of the document according to the cloud document Token, including comment and reply ID, reply content, user ID of the reviewer and reply person, etc. The API supports returning global comments as well as local comments (which can be distinguished by the "is_whole" field). The default is 50 comments per page', 'path{file_token*} params{file_type*:enum(doc|docx|sheet|file|slides),is_whole?:bool,is_solved?:bool,page_token?,page_size?:num,user_id_type?:enum(open_id|union_id|user_id)}');
gop('drive.v1.fileCommentReply.list', 'drive', 'GET', '/open-apis/drive/v1/files/:file_token/comments/:comment_id/replies', 'Docs-Comment-Get Replies List-This interface is used to obtain replies according to the comment ID and pagination parameters', 'path{file_token*,comment_id*} params{page_size?:num,page_token?,file_type*:enum(doc|docx|sheet|file|slides),user_id_type?:enum(open_id|union_id|user_id)}');
gop('drive.v1.file.getSubscribe', 'drive', 'GET', '/open-apis/drive/v1/files/:file_token/get_subscribe', 'Docs-Space-Event-Get Docs events subscription status-This interface is used to query the subscription status of cloud documents. To understand the configuration process and usage scenarios for event subscriptions, refer to [Event Overview]. To learn about the types of events supported by cloud documents, refer to [Event List]', 'path{file_token*} params{file_type*:enum(doc|docx|sheet|bitable|file|folder|slides),event_type?}');
gop('drive.v1.file.list', 'drive', 'GET', '/open-apis/drive/v1/files', 'Docs-Space-Folder-List items in folder-Get the list of files under the specified folder in the user’s cloud space. List item types include files, various online documents (doc, sheet, bitable, mindnote), and folders', 'params?{page_size?:num,page_token?,folder_token?,order_by?:enum(EditedTime|CreatedTime),direction?:enum(ASC|DESC),user_id_type?:enum(open_id|union_id|user_id)}');
gop('drive.v1.fileStatistics.get', 'drive', 'GET', '/open-apis/drive/v1/files/:file_token/statistics', 'Docs-Space-File-Obtain file’s statistics-This API is used to obtain file’s statistics, including the number of unique visitors (UVs), the number of page views (PVs), and the number of likes', 'path?{file_token?} params{file_type*:enum(doc|sheet|mindnote|bitable|wiki|file|docx)}');
gop('drive.v1.fileSubscription.get', 'drive', 'GET', '/open-apis/drive/v1/files/:file_token/subscriptions/:subscription_id', 'Docs-Docs Assistant-Subscription-Get subscription status-Get the status of the subscription based on the subscription ID', 'path?{file_token?,subscription_id?} data{file_type*:enum(doc|docx|wiki)}');
gop('drive.v1.file.taskCheck', 'drive', 'GET', '/open-apis/drive/v1/files/task_check', 'Docs-Space-Folder-Query Task Status-Query the status information of asynchronous tasks. Currently supports moving and deleting folder tasks', 'params{task_id*}');
gop('drive.v1.fileVersion.get', 'drive', 'GET', '/open-apis/drive/v1/files/:file_token/versions/:version_id', 'Docs-Space-Document Version-Get document version-Get document version. The document can be Feishu document or spreadsheet. The version information includes the version title, version ID, version creator, create time, and more', 'path{file_token*,version_id*} params{obj_type*:enum(docx|sheet),user_id_type?:enum(open_id|union_id|user_id)}');
gop('drive.v1.fileVersion.list', 'drive', 'GET', '/open-apis/drive/v1/files/:file_token/versions', 'Docs-Space-Document Version-List document version-Get all versions of the document. The document can be Feishu document or spreadsheet', 'path{file_token*} params{page_size*:num,page_token?,obj_type*:enum(docx|sheet),user_id_type?:enum(open_id|union_id|user_id)}');
gop('drive.v1.fileViewRecord.list', 'drive', 'GET', '/open-apis/drive/v1/files/:file_token/view_records', 'Docs-Space-File-Obtain document view records-Obtain the view records of files, including document, sheet, base, wiki, and more. The view records contains the ID, profile, and last view time of the viewers', 'path{file_token*} params{page_size*:num,page_token?,file_type*:enum(doc|docx|sheet|bitable|mindnote|wiki|file),viewer_id_type?:enum(user_id|union_id|open_id)}');
gop('drive.v1.importTask.get', 'drive', 'GET', '/open-apis/drive/v1/import_tasks/:ticket', 'Docs-Space-File-Import files-Query import task result-Polling the import results based on the `ticket` returned from [Create import task]. For details, see [Import file overview]', 'path{ticket*}');
gop('drive.v1.media.batchGetTmpDownloadUrl', 'drive', 'GET', '/open-apis/drive/v1/medias/batch_get_tmp_download_url', 'Docs-Space-Media-Get Temporary Download URL of Media-Obtain the temporary download URL of a material based on a `file_tokens`. The URL is valid for 24 hours', 'params{file_tokens*:arr,extra?}');
gop('drive.v1.permissionMember.auth', 'drive', 'GET', '/open-apis/drive/v1/permissions/:token/members/auth', 'Docs-Permission-Member-Check whether the current user has a specific permission-This API is used to check whether the current login user has a specific permission on a document based on a filetoken', 'path{token*} params{type*,action*}');
gop('drive.v1.permissionMember.list', 'drive', 'GET', '/open-apis/drive/v1/permissions/:token/members', 'Docs-Permission-Member-Obtain a collaborator list（New version）-This API is used to query collaborators based on a filetoken', 'path{token*} params{type*,fields?,perm_type?:enum(container|single_page)}');
gop('drive.v1.permissionPublic.get', 'drive', 'GET', '/open-apis/drive/v1/permissions/:token/public', 'Deprecated Version (Not Recommended)-Docs-Permission Setting v1-GetPermissionPublic-This interface is used to obtain permission settings for cloud documents according to filetoken', 'path{token*} params{type*}');
gop('drive.v2.fileLike.list', 'drive', 'GET', '/open-apis/drive/v2/files/:file_token/likes', 'Docs-Space-Like-List Document’s Likes-Get the list of likes for the specified document and returns by like time from near to far. This API supports paging', 'path{file_token*} params{file_type*:enum(doc|docx|file),page_size?:num,page_token?,user_id_type?:enum(open_id|union_id|user_id)}');
gop('drive.v2.permissionPublic.get', 'drive', 'GET', '/open-apis/drive/v2/permissions/:token/public', 'Docs-Permission-Setting-GetPermissionPublic-This interface is used to obtain permission settings for cloud documents according to filetoken', 'path{token*} params{type*}');
gop('im.v1.chatAnnouncement.get', 'im', 'GET', '/open-apis/im/v1/chats/:chat_id/announcement', 'Group Chat-Group announcement-Obtain group announcement information-Obtains the group announcement in a chat, with the same format as [Docs]', 'path{chat_id*} params?{user_id_type?:enum(open_id|union_id|user_id)}');
gop('im.v1.chat.get', 'im', 'GET', '/open-apis/im/v1/chats/:chat_id', 'Group Chat-Group management-Obtain group information-Obtains basic information such as group name, description, profile photo, and owner ID', 'path{chat_id*} params?{user_id_type?:enum(open_id|union_id|user_id)}');
gop('im.v1.chat.list', 'im', 'GET', '/open-apis/im/v1/chats', 'Group Chat-Group management-Obtain groups where the user or bot is a member-Get the list of groups where the user or bot represented by [access_token] is a member', 'params?{user_id_type?:enum(open_id|union_id|user_id),sort_type?:enum(ByCreateTimeAsc|ByActiveTimeDesc),page_token?,page_size?:num}');
gop('im.v1.chatMembers.get', 'im', 'GET', '/open-apis/im/v1/chats/:chat_id/members', 'Group Chat-Group member-Obtain group member list-Get the list of members of the group the user/bot is in', 'path{chat_id*} params?{member_id_type?:enum(open_id|union_id|user_id),page_size?:num,page_token?}');
gop('im.v1.chatMembers.isInChat', 'im', 'GET', '/open-apis/im/v1/chats/:chat_id/members/is_in_chat', 'Group Chat-Group member-Determine whether a user or bot is in a group-Determines whether a user or bot is in a group based on their access_token', 'path{chat_id*}');
gop('im.v1.chatModeration.get', 'im', 'GET', '/open-apis/im/v1/chats/:chat_id/moderation', 'Group Chat-Group management-Obtains the group member speech scopes-Obtains the group speech mode, the list of users who can speak, and more', 'path{chat_id*} params?{user_id_type?:enum(open_id|union_id|user_id),page_size?:num,page_token?}');
gop('im.v1.chat.search', 'im', 'GET', '/open-apis/im/v1/chats/search', 'Group Chat-Group management-Search for groups visible to a user or bot-Get the list of groups visible to the current identity (user or bot), including the groups the current identity belongs to and the groups that are open to the current identity. Supports keyword search and paged search', 'params?{user_id_type?:enum(open_id|union_id|user_id),query?,page_token?,page_size?:num}');
gop('im.v1.chatTab.listTabs', 'im', 'GET', '/open-apis/im/v1/chats/:chat_id/chat_tabs/list_tabs', 'Group Chat-Chat tab-Pull chat tabs-Get the chat tab information in the specified chat, including ID, name, type, and content', 'path{chat_id*}');
gop('im.v1.messageReaction.list', 'im', 'GET', '/open-apis/im/v1/messages/:message_id/reactions', 'Messaging-Message reaction-List message reactions-Get the list of reactions in the specified message, and support getting only reactions of a specific type', 'path{message_id*} params?{reaction_type?,page_token?,page_size?:num,user_id_type?:enum(open_id|union_id|user_id)}');
gop('im.v1.pin.list', 'im', 'GET', '/open-apis/im/v1/pins', 'Messaging-Pin-Get pins in group-Get all pin data within the specified time range in the chat', 'params{chat_id*,start_time?,end_time?,page_size?:num,page_token?}');
gop('minutes.v1.minute.get', 'minutes', 'GET', '/open-apis/minutes/v1/minutes/:minute_token', 'Minutes-Minutes Meta-Get minutes meta-Through this api, you can get a basic overview of Lark Minutes, including `owner_id`, `create_time`, title, cover picture, duration and URL', 'path{minute_token*} params?{user_id_type?:enum(open_id|union_id|user_id)}');
gop('minutes.v1.minuteMedia.get', 'minutes', 'GET', '/open-apis/minutes/v1/minutes/:minute_token/media', 'Minutes-Minutes audio or video file-Download minutes audio or video file-Get the audio or video file of minutes', 'path{minute_token*}');
gop('minutes.v1.minuteStatistics.get', 'minutes', 'GET', '/open-apis/minutes/v1/minutes/:minute_token/statistics', 'Minutes-Minutes statistics-Get minutes statistics-Through this API, you can get access statistics of Feishu Minutes, including PV, UV, visited user id, visited user timestamp', 'path{minute_token*} params?{user_id_type?:enum(open_id|union_id|user_id)}');
gop('sheets.v3.spreadsheet.get', 'sheet', 'GET', '/open-apis/sheets/v3/spreadsheets/:spreadsheet_token', 'Docs-Sheets-spreadsheet-Get spreadsheet information-This interface is used to obtain basic information for the spreadsheet, including the owner of the spreadsheet, URL links, and other related details', 'path?{spreadsheet_token?} params?{user_id_type?:enum(open_id|union_id|user_id)}');
gop('sheets.v3.spreadsheetSheetFilterViewCondition.get', 'sheet', 'GET', '/open-apis/sheets/v3/spreadsheets/:spreadsheet_token/sheets/:sheet_id/filter_views/:filter_view_id/conditions/:condition_id', 'Docs-Sheets-Filter view-filter view-Obtain Filter Condition-::: noteFor filter condition explanations, see [User guide for using filter conditions in the filter view]:::This API is used to obtain the filter conditions of a specified column in the filter view', 'path?{spreadsheet_token?,sheet_id?,filter_view_id?,condition_id?}');
gop('sheets.v3.spreadsheetSheetFilterViewCondition.query', 'sheet', 'GET', '/open-apis/sheets/v3/spreadsheets/:spreadsheet_token/sheets/:sheet_id/filter_views/:filter_view_id/conditions/query', 'Docs-Sheets-Filter view-filter view-Query Filter Condition-::: noteFor filter condition explanations, see [User guide for using filter conditions in the filter view]:::This API is used to query all filter conditions of a filter view. All filter conditions in the range of the filter view are returned', 'path?{spreadsheet_token?,sheet_id?,filter_view_id?}');
gop('sheets.v3.spreadsheetSheetFilterView.get', 'sheet', 'GET', '/open-apis/sheets/v3/spreadsheets/:spreadsheet_token/sheets/:sheet_id/filter_views/:filter_view_id', 'Docs-Sheets-Filter view-Obtain Filter View-This API is used to obtain the name and range of a specified filter view ID', 'path?{spreadsheet_token?,sheet_id?,filter_view_id?}');
gop('sheets.v3.spreadsheetSheetFilterView.query', 'sheet', 'GET', '/open-apis/sheets/v3/spreadsheets/:spreadsheet_token/sheets/:sheet_id/filter_views/query', 'Docs-Sheets-Filter view-Query Filter View-This API is used to query the basic information of all filter views in a sheet, including their IDs, names, and ranges', 'path?{spreadsheet_token?,sheet_id?}');
gop('sheets.v3.spreadsheetSheetFilter.get', 'sheet', 'GET', '/open-apis/sheets/v3/spreadsheets/:spreadsheet_token/sheets/:sheet_id/filter', 'Docs-Sheets-Filter-Obtain Filter-This API is used to obtain the filter details for a sheet', 'path?{spreadsheet_token?,sheet_id?}');
gop('sheets.v3.spreadsheetSheetFloatImage.get', 'sheet', 'GET', '/open-apis/sheets/v3/spreadsheets/:spreadsheet_token/sheets/:sheet_id/float_images/:float_image_id', 'Docs-Sheets-Floating image-Obtain Floating Image-::: noteFor information about floating images, see [Floating image guide]:::This API is used to obtain floating image information based on a float_image_id', 'path?{spreadsheet_token?,sheet_id?,float_image_id?}');
gop('sheets.v3.spreadsheetSheetFloatImage.query', 'sheet', 'GET', '/open-apis/sheets/v3/spreadsheets/:spreadsheet_token/sheets/:sheet_id/float_images/query', 'Docs-Sheets-Floating image-Query Floating Image-::: noteFor information about floating images, see [Floating image guide]:::This API returns information on all floating images in a sheet', 'path?{spreadsheet_token?,sheet_id?}');
gop('sheets.v3.spreadsheetSheet.get', 'sheet', 'GET', '/open-apis/sheets/v3/spreadsheets/:spreadsheet_token/sheets/:sheet_id', 'Docs-Sheets-sheet-Query a sheet-This interface is used to query worksheet information by worksheet ID, including the title, index, and whether the sheet is hidden', 'path{spreadsheet_token*,sheet_id*}');
gop('sheets.v3.spreadsheetSheet.query', 'sheet', 'GET', '/open-apis/sheets/v3/spreadsheets/:spreadsheet_token/sheets/query', 'Docs-Sheets-sheet-Get a sheet-This interface is used to get all worksheets and their properties under the spreadsheet, including ID, title, index, and whether the worksheet is hidden', 'path?{spreadsheet_token?}');
gop('task.v2.attachment.get', 'task', 'GET', '/open-apis/task/v2/attachments/:attachment_guid', 'Tasks-Attachment-Get Attachment-Providing an attachment GUID, get the detail of the attachment, including GUID, name, size, uploaded time, temporary downloadable url, etc', 'path{attachment_guid*} params?{user_id_type?}');
gop('task.v2.attachment.list', 'task', 'GET', '/open-apis/task/v2/attachments', 'Tasks-Attachment-List Attachment-List all attachments of a resource. The returned attachments supports paging and are sorted by upload time.Each attachment will return a temporary url available for download.Url is available for up to 3 minutes and can only be used for up to 3 times. If the limit is exceeded, you need to obtain a new temporary url through this api', 'params{page_size?:num,page_token?,resource_type?,resource_id*,user_id_type?}');
gop('task.v2.comment.get', 'task', 'GET', '/open-apis/task/v2/comments/:comment_id', 'Tasks-Comment-Get Comment-Given the ID of a comment, return the details of the comment, including information such as content, creator, creation time and update time', 'path{comment_id*} params?{user_id_type?}');
gop('task.v2.comment.list', 'task', 'GET', '/open-apis/task/v2/comments', 'Tasks-Comment-List Comments-Given a resource, returns a list of comments for that resource.Pagination is supported. Comments can return data in positive order (asc, oldest to newest) or reverse order (desc, oldest to newest) of creation time', 'params{page_size?:num,page_token?,resource_type?,resource_id*,direction?:enum(asc|desc),user_id_type?}');
gop('task.v2.customField.get', 'task', 'GET', '/open-apis/task/v2/custom_fields/:custom_field_guid', 'Tasks-Custom Field-Get Custom Field-By specifying a custom field GUID, get its detailed information', 'path{custom_field_guid*} params?{user_id_type?:enum(open_id|union_id|user_id)}');
gop('task.v2.customField.list', 'task', 'GET', '/open-apis/task/v2/custom_fields', 'Tasks-Custom Field-List Custom Field-Get a list of custom fields accessible to the calling identity. If the resource_type and resource_id parameters are not provided, all custom fields accessible to the calling identity are returned.If resource_type and resource_id are provided, the custom fields under that resource are returned. Currently resource_type only supports "tasklist", in which case resource_id should be a tasklist GUID.This API supports paging', 'params?{page_size?:num,page_token?,user_id_type?:enum(open_id|union_id|user_id),resource_type?,resource_id?}');
gop('task.v2.section.get', 'task', 'GET', '/open-apis/task/v2/sections/:section_guid', 'Tasks-Section-Get Section-Gets the details of a section, including name, creator, etc. If the section belongs to a tasklist, the summary of the tasklist is also returned', 'path{section_guid*} params?{user_id_type?}');
gop('task.v2.section.list', 'task', 'GET', '/open-apis/task/v2/sections', 'Tasks-Section-List Section-Get a list of section. Paging is supported. The returned results are sorted in the order in which the sections are placed on the UI', 'params{page_size?:num,page_token?,resource_type*,resource_id?,user_id_type?}');
gop('task.v2.section.tasks', 'task', 'GET', '/open-apis/task/v2/sections/:section_guid/tasks', 'Tasks-Section-List Tasks of Section-List tasks of a section. Paging is supported. Tasks are returned in the order as "custom" order of UI. This API supports simple filtering', 'path{section_guid*} params?{page_size?:num,page_token?,completed?:bool,created_from?,created_to?}');
gop('task.v2.task.get', 'task', 'GET', '/open-apis/task/v2/tasks/:task_guid', 'Tasks-Task-Get Task Details-This api is used to obtain task details, including task summary, description, time, members and other information', 'path{task_guid*} params?{user_id_type?}');
gop('task.v2.task.list', 'task', 'GET', '/open-apis/task/v2/tasks', 'Tasks-Task-List tasks-List all tasks of a specific type based on the calling identity. Paging is supported.Currently, only tasks of "my_tasks" are supported. The returned task data is in the order in which the tasks are list by "custom" order in the "Owned" in Task Center', 'params?{page_size?:num,page_token?,completed?:bool,type?,user_id_type?}');
gop('task.v2.taskSubtask.list', 'task', 'GET', '/open-apis/task/v2/tasks/:task_guid/subtasks', 'Tasks-Subtask-List Subtask-Get all subtasks of a task.Paging is supported, and data is returned in the order in which subtasks are placed on the Lark App UI', 'path?{task_guid?} params?{page_size?:num,page_token?,user_id_type?}');
gop('task.v2.task.tasklists', 'task', 'GET', '/open-apis/task/v2/tasks/:task_guid/tasklists', 'Tasks-Task-List tasklists of task-List the all lists where a task belongs to, including the tasklist GUID and section GUID.Only the tasklists that calling identity has read permission will be returned', 'path{task_guid*}');
gop('task.v2.tasklistActivitySubscription.get', 'task', 'GET', '/open-apis/task/v2/tasklists/:tasklist_guid/activity_subscriptions/:activity_subscription_guid', 'Tasks-Tasklist Activity Subscription-Get Activity Subscription-Providing a tasklist GUID and tasklist’s subscription GUID, get the details of the subscription data, including name, subscriber, list of event keys that can be notified, etc', 'path{tasklist_guid*,activity_subscription_guid*} params?{user_id_type?:enum(open_id|union_id|user_id)}');
gop('task.v2.tasklistActivitySubscription.list', 'task', 'GET', '/open-apis/task/v2/tasklists/:tasklist_guid/activity_subscriptions', 'Tasks-Tasklist Activity Subscription-List Activity Subscription-Given the tasklist GUID, list its all activity subscriptions. Results are sorted by subscription create time', 'path{tasklist_guid*} params?{limit?:num,user_id_type?:enum(open_id|union_id|user_id)}');
gop('task.v2.tasklist.get', 'task', 'GET', '/open-apis/task/v2/tasklists/:tasklist_guid', 'Tasks-Tasklist-Get Tasklist Details-Get the details of a tasklist, including list name, owner, list members, etc', 'path?{tasklist_guid?} params?{user_id_type?}');
gop('task.v2.tasklist.list', 'task', 'GET', '/open-apis/task/v2/tasklists', 'Tasks-Tasklist-List Tasklists-List all the tasklists the calling identity has read permission', 'params?{page_size?:num,page_token?,user_id_type?}');
gop('task.v2.tasklist.tasks', 'task', 'GET', '/open-apis/task/v2/tasklists/:tasklist_guid/tasks', 'Tasks-Tasklist-Get Tasks of Tasklist-Gets the summary of tasks belonging to a tasklist. This API supports pagination. Tasks in the tasklist are returned in the "custom" order.This API supports simple filtering by task completion status or task creation time range', 'path{tasklist_guid*} params?{page_size?:num,page_token?,completed?:bool,created_from?,created_to?,user_id_type?}');
gop('vc.v1.export.get', 'vc', 'GET', '/open-apis/vc/v1/exports/:task_id', 'Video Conferencing-Export-Query export task results-View the progress of asynchronous export', 'path?{task_id?}');
gop('vc.v1.meetingList.get', 'vc', 'GET', '/open-apis/vc/v1/meeting_list', 'Video Conferencing-Meeting data-Get meeting details-Get meeting details.For specific permission requirements, please refer to "Resource introduction"', 'params{start_time*,end_time*,meeting_status?:num,meeting_no?,user_id?,room_id?,meeting_type?:num,page_size?:num,page_token?,user_id_type?:enum(open_id|union_id|user_id)}');
gop('vc.v1.meeting.get', 'vc', 'GET', '/open-apis/vc/v1/meetings/:meeting_id', 'Video Conferencing-Meeting management-Obtain meeting details-Obtains the detailed data of a meeting', 'path?{meeting_id?} params?{with_participants?:bool,with_meeting_ability?:bool,user_id_type?:enum(open_id|union_id|user_id)}');
gop('vc.v1.meeting.listByNo', 'vc', 'GET', '/open-apis/vc/v1/meetings/list_by_no', 'Video Conferencing-Meeting management-List meetings of same meeting number-Obtains the meeting brief list associated with the meeting number for a specified time period (within 90 days)', 'params{meeting_no*,start_time*,end_time*,page_token?,page_size?:num}');
gop('vc.v1.meetingRecording.get', 'vc', 'GET', '/open-apis/vc/v1/meetings/:meeting_id/recording', 'Video Conferencing-Meeting record-Obtain recording files-Obtain recording files of a meeting.', 'path?{meeting_id?}');
gop('vc.v1.participantList.get', 'vc', 'GET', '/open-apis/vc/v1/participant_list', 'Video Conferencing-Meeting data-Get participant details-Get participant details. For specific permission requirements, please refer to "Resource introduction"', 'params{meeting_start_time*,meeting_end_time*,meeting_status?:num,meeting_no*,user_id?,room_id?,page_size?:num,page_token?,user_id_type?:enum(open_id|union_id|user_id)}');
gop('vc.v1.participantQualityList.get', 'vc', 'GET', '/open-apis/vc/v1/participant_quality_list', 'Video Conferencing-Meeting data-Get participant meeting quality data-Get participant meeting quality data.(Only supports ended meetings) For specific permission requirements, please refer to "Resource introduction"', 'params{meeting_start_time*,meeting_end_time*,meeting_no*,join_time*,user_id?,room_id?,page_size?:num,page_token?,user_id_type?:enum(open_id|union_id|user_id)}');
gop('vc.v1.reserve.get', 'vc', 'GET', '/open-apis/vc/v1/reserves/:reserve_id', 'Video Conferencing-Meeting reservation-Obtain a schedule-Obtains details about a schedule', 'path?{reserve_id?} params?{user_id_type?:enum(open_id|union_id|user_id)}');
gop('vc.v1.reserve.getActiveMeeting', 'vc', 'GET', '/open-apis/vc/v1/reserves/:reserve_id/get_active_meeting', 'Video Conferencing-Meeting reservation-Obtain an active meeting-Obtains a scheduled meeting that is currently active', 'path?{reserve_id?} params?{with_participants?:bool,user_id_type?:enum(open_id|union_id|user_id)}');
gop('vc.v1.resourceReservationList.get', 'vc', 'GET', '/open-apis/vc/v1/resource_reservation_list', 'Video Conferencing-Meeting data-Get meeting room reservation data-Get meeting room reservation data. For specific permission requirements, please refer to "Resource introduction"', 'params{room_level_id*,need_topic?:bool,start_time*,end_time*,room_ids*:arr,is_exclude?:bool,page_size?:num,page_token?}');
gop('wiki.v2.space.get', 'wiki', 'GET', '/open-apis/wiki/v2/spaces/:space_id', 'Docs-Wiki-Wiki space-Access to Wiki space information-This interface is used to query the information of the Wiki space according to the Wiki space ID.Space type:- Person Space: Managed by individuals. One person can only have one personal space, and no other administrators can be added.- Team Space: Managed by a team (multiple people), multiple administrators can be added.Space visibility:- Public Space: Visible to all users within the tenant and defaults to member permissions. Additional members cannot be added, but administrators can be added.- Private Space: Only visible to knowledge space administrators and members, administrators and members need to be added manually.Space sharing status:- Open: The wiki space has been published to web.- Closed: The wiki space hasn’t been published to web', 'path?{space_id?} params?{lang?}');
gop('wiki.v2.space.getNode', 'wiki', 'GET', '/open-apis/wiki/v2/spaces/get_node', 'Docs-Wiki-node-Get Wiki node information-Get wiki node inforamtion', 'params{token*,obj_type?:enum(doc|docx|sheet|mindnote|bitable|file|slides|wiki)}');
gop('wiki.v2.space.list', 'wiki', 'GET', '/open-apis/wiki/v2/spaces', 'Docs-Wiki-Wiki space-Get a list of Wiki spaces-This interface is used to get a list of Wiki spaces that have permission to access.This interface is a paging interface. Due to permission filtering, the return list may be empty, but the paging flag (has_more) is true, and can continue the paging request.For the description of each attribute of the Wiki space, please refer to [Access to Wiki space information]', 'params?{page_size?:num,page_token?}');
gop('wiki.v2.spaceMember.list', 'wiki', 'GET', '/open-apis/wiki/v2/spaces/:space_id/members', 'Docs-Wiki-Space member-Obtain Wiki space members-Obtain Wiki space members', 'path{space_id*} params?{page_size?:num,page_token?}');
gop('wiki.v2.spaceNode.list', 'wiki', 'GET', '/open-apis/wiki/v2/spaces/:space_id/nodes', 'Docs-Wiki-node-Get the list of child nodes in Wiki-This interface is used for pagination to get the list of child nodes of Wiki nodes.This interface is a paging interface. Due to permission filtering, the return list may be empty, but the paging flag (has_more) is true and can continue the paging request', 'path?{space_id?} params?{page_size?:num,page_token?,parent_node_token?}');
gop('wiki.v2.task.get', 'wiki', 'GET', '/open-apis/wiki/v2/tasks/:task_id', 'Docs-Wiki-Docs-Retrieve the result of Wiki task-This method is used to retrieve the result of a wiki task', 'path?{task_id?} params{task_type*}');
// </GEN_OPS>

/* ── list_tools / call_tool 元工具 ─────────────────────────────────── */

var MORE_PAGE_SIZE = 40;

function listTools(args) {
  var category = args && args.category ? String(args.category) : '';
  // 类目同义词归一(与老 MCP projectToCategory 一致)。
  var aliases = { sheets: 'sheet', base: 'bitable', docs: 'docx', directory: 'contact' };
  if (aliases[category]) category = aliases[category];
  if (!category) {
    var overview = {};
    for (var cat in CATEGORIES) {
      if (!Object.prototype.hasOwnProperty.call(CATEGORIES, cat)) continue;
      overview[cat] = { recommended: 0, more: 0, description: CATEGORIES[cat] };
    }
    for (var name in OPS) {
      if (!Object.prototype.hasOwnProperty.call(OPS, name)) continue;
      var slot = overview[OPS[name].cat];
      if (!slot) continue;
      if (OPS[name].gen) slot.more++;
      else slot.recommended++;
    }
    return {
      ok: true,
      result: {
        categories: overview,
        hint: '传 category 看该类目操作明细(recommended 精品优先;more 为只读直通接口,可用 q 过滤 / page 分页);执行用 call_tool({name, args})。写操作执行前先与用户确认。',
      },
    };
  }
  if (!CATEGORIES[category]) {
    return { ok: false, message: '未知类目:' + category + '(可用:' + Object.keys(CATEGORIES).join(' / ') + ')' };
  }
  var recommended = [];
  var more = [];
  var q = args && args.q ? String(args.q).toLowerCase() : '';
  for (var n in OPS) {
    if (!Object.prototype.hasOwnProperty.call(OPS, n)) continue;
    var entry = OPS[n];
    if (entry.cat !== category) continue;
    var item = { name: n, description: entry.desc, params: entry.params };
    if (entry.write) item.write = true;
    if (entry.gen) {
      if (q && n.toLowerCase().indexOf(q) < 0 && String(entry.desc).toLowerCase().indexOf(q) < 0) continue;
      more.push(item);
    } else {
      recommended.push(item);
    }
  }
  more.sort(function (x, y) { return x.name < y.name ? -1 : 1; });
  var page = args && Number(args.page) >= 1 ? Math.floor(Number(args.page)) : 1;
  var start = (page - 1) * MORE_PAGE_SIZE;
  var slice = more.slice(start, start + MORE_PAGE_SIZE);
  var result = {
    category: category,
    recommended: recommended,
    more: {
      tools: slice,
      total: more.length,
      page: page,
      has_more: start + MORE_PAGE_SIZE < more.length,
    },
    hint: '优先用 recommended(精品,含上传/下载/确认等完整语义);more 是只读直通接口,args 固定 path / params / data 三段。写操作(write:true)执行前先与用户确认。',
  };
  if (result.more.has_more) result.more.next_page = page + 1;
  return { ok: true, result: result };
}

async function callTool(args, callId) {
  var name = args && args.name ? String(args.name) : '';
  if (!name) return fail('需要 name(list_tools 可查)');
  var entry = OPS[name];
  if (!entry) {
    // 近似名提示(两段式约定:不 dump 全表)。
    var near = [];
    var lower = name.toLowerCase();
    for (var n in OPS) {
      if (!Object.prototype.hasOwnProperty.call(OPS, n)) continue;
      if (n.toLowerCase().indexOf(lower) >= 0 || lower.indexOf(n.toLowerCase()) >= 0) near.push(n);
      if (near.length >= 10) break;
    }
    return fail(
      '未知操作:' + name + '——用 list_tools 查目录(类目:' + Object.keys(CATEGORIES).join(' / ') + ')' +
      (near.length ? ';相近:' + near.join(' / ') : ''),
    );
  }
  var inner = args.args && typeof args.args === 'object' ? args.args : {};
  // save_dir / dir / attachments 票据由主机注入在 call_tool 这一层,下传给具体操作。
  if (args.save_deposit) inner.save_deposit = args.save_deposit;
  if (args.dir_deposit) inner.dir_deposit = args.dir_deposit;
  if (args.attachments && inner.attachments === undefined) inner.attachments = args.attachments;
  var out = await entry.run(inner, callId);
  if (out.err) {
    // 失败带上参数说明,供 AI 自纠重试(两段式约定)。
    return fail(out.err + '\n该操作参数:' + entry.params);
  }
  if (out.result) return { ok: true, result: out.result };
  var outFile = typeof args.out_file === 'string' && args.out_file ? args.out_file : null;
  return deliver(out.data, Boolean(args.raw), outFile, callId);
}

/* ── 设置页测试连接(BroadcastChannel;settings.js 先 /wake 再广播) ── */

var bc = new BroadcastChannel('xd-feishu');
var seenTestReqs = {};

bc.onmessage = function (ev) {
  var m = ev && ev.data;
  if (!m || m.type !== 'test-connection' || !m.reqId) return;
  if (seenTestReqs[m.reqId]) return;
  if (Object.keys(seenTestReqs).length > 200) seenTestReqs = {};
  seenTestReqs[m.reqId] = 1;
  void (async function () {
    var r = await api({ url: API + '/open-apis/authen/v1/user_info' });
    if (r.err) {
      bc.postMessage({ type: 'test-connection-result', reqId: m.reqId, ok: false, message: r.err });
      void cindy.send({ type: 'notify', text: '飞书连接测试失败:' + String(r.err).slice(0, 150), tone: 'error' });
      return;
    }
    var d = r.data || {};
    var display = d.name || d.en_name || '';
    try {
      var kv = await (await fetch('/kv')).json();
      kv = kv && typeof kv === 'object' ? kv : {};
      kv.connectedName = display;
      await fetch('/kv', { method: 'PUT', body: JSON.stringify(kv) });
    } catch (e) {
      /* 缓存写失败不影响测试结果 */
    }
    bc.postMessage({
      type: 'test-connection-result', reqId: m.reqId, ok: true,
      name: display, email: d.enterprise_email || d.email || '',
    });
    void cindy.send({ type: 'notify', text: '飞书连接成功:' + display, tone: 'success' });
  })();
};

/* ── 派单 ──────────────────────────────────────────────────────────── */

cindy.onHostMessage(async function (msg) {
  if (!msg || msg.type !== 'tool-call') return;
  try {
    var r;
    if (msg.tool === 'list_tools') {
      r = listTools(msg.args || {});
    } else if (msg.tool === 'call_tool') {
      r = await callTool(msg.args || {}, msg.callId);
    } else {
      r = fail('未知工具:' + msg.tool);
    }
    if (r.ok) {
      cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: r.result });
    } else {
      cindy.send({ type: 'tool-result', callId: msg.callId, ok: false, message: r.message });
    }
  } catch (err) {
    cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: false,
      message: '飞书工具执行失败:' + (err && err.message ? err.message : String(err)),
    });
  }
});
