/**
 * XD Mivo · 电子脑 —— mivo(aigc.xindong.com)AIGC 平台意识(tool + network 槽)。
 *
 * 行为规格来源:.tmp-mivo-ghost-spec.md(mivo-mcp@0.6.0 下游移植版的 HTTP 层蒸馏,
 * 2026-07-13 main 分支代码为准)。13 个工具:生图(Nano/GPT/MJ/Niji)、抠图、超分、
 * MJ 按钮动作、视频(Seedance/Kling)、音乐(Suno)、音效(ElevenLabs)、3D
 * (Tripo/Seed3D)生成/轮询/格式转换/动作绑定、文件下载。
 *
 * 工作方式:
 * - 域名白名单代发:cindy.fetch 只能到 ghost.json 声明的 aigc.xindong.com
 *   (媒体下载 307 落 OSS,主机逐跳重验白名单),请求由主机代发,沙箱零直连;
 * - 凭证:mivo_api_key 由用户在意识设置页填写,主机经 exchange 声明二段式
 *   换取 session 令牌后注入 Authorization——本文件永远摸不到 key/令牌字节;
 * - 媒体:下载走 as:'media' 直落媒体总仓(字节不进沙箱),上传走
 *   upload:{hashes}(用户附件过户的总仓指纹,主机代组 multipart);
 * - 轮询:MCP 的 SSE 不搬,统一 REST GET /api/v1/message/{id} + setTimeout。
 *
 * 会话态(chat session 缓存 / last3dTaskId)都是模块级内存变量,
 * 沙箱重启即丢、按需重建(平台接受,见规格 §13.4 / §16)。
 */

/* global cindy */

'use strict';

var ENDPOINT = 'https://aigc.xindong.com';
var API = ENDPOINT + '/api/v1';

var POLL_INTERVAL_MS = 2500;    // REST 轮询间隔(替代 MCP 的 SSE 推送)
var MAX_TOOL_WAIT_MS = 105000;  // gpt_wait / 按钮 drain 单次工具调用最长内部等待
var DOWNLOAD_RETRY_DELAYS = [2000, 3000, 5000]; // 媒体下载失败/0 字节的重试节奏(规格 §0.8)

var HEX24_RE = /^[0-9a-fA-F]{24}$/;   // mivo fileId(MongoDB ObjectId)
var HASH64_RE = /^[0-9a-f]{64}$/i;    // 媒体总仓指纹(附件过户)

// 结果媒体按真实字节类型分流(mivo 会把 MJ Animate 的 mp4 塞进 images 桶,
// 不能信 bucket 名,规格 §5.1)。ext 来自 as:'media' 的落库回执。
var IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
var VIDEO_EXTS = ['.mp4', '.webm', '.mov'];

// ── 会话态(规格 §13.4:MCP 的 AsyncLocalStorage → 模块级变量)────────────
var chatSessions = {};             // chatType → chatSessionId(内存缓存,丢了重建)
var last3dTaskId = null;           // 最近一次 3D 任务(animate/convert 的兜底)
var pendingConversion = {};        // 3D 生成 jobId → 目标格式(FBX/OBJ):产物须经 convert 才算交付
var conversionRequiredFiles = {};  // GLB 中间产物 fileId → { taskId, format }(download_file 守卫)

/* ── 基础工具 ─────────────────────────────────────────────────────────── */

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function isObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** HTML 转义(自绘交互卡用;卡片经主机净化器白名单重建,这里做第一道)。 */
function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 版本别名归一键:trim → 小写 → 去空格/点/下划线/短横(规格 §1.3)。 */
function normKey(v) {
  return String(v === undefined || v === null ? '' : v).trim().toLowerCase().replace(/[\s._-]/g, '');
}

/**
 * 结构化工具错误:throw 出去由总分发器接住,整体 JSON 交卷(errorCode 供
 * AI 走分支,message 给用户转述)。errorCode 词表沿用 MCP(规格 §0.9)。
 */
function toolError(errorCode, message, extra) {
  var e = new Error(message);
  e.ghost = Object.assign({ ok: false, errorCode: errorCode, message: message }, extra || {});
  return e;
}

/**
 * 主机代发失败(白名单/凭证/网络)→ 结构化错误。凭证未配置的 message 带
 * 主机的填写指引,识别后转 MIVO_API_KEY_MISSING 并叮嘱不要 fallback 到
 * 其它绘图通道(规格 §0.9)。
 */
function hostFetchError(r, fallbackCode) {
  var msg = r && typeof r.message === 'string' && r.message ? r.message : '网络请求失败(主机代发未成功)';
  if (msg.indexOf('尚未配置') >= 0) {
    return toolError('MIVO_API_KEY_MISSING', msg, {
      guidance:
        '把 message 原样告诉用户:需要在 设置 → 意识 → XD Mivo 详情页填写 mivo_ 开头的 API Key' +
        '(aigc.xindong.com 登录后点右上角 MCP 按钮获取)。不要 fallback 到其它绘图/生成通道。',
    });
  }
  return toolError(fallbackCode || 'SUBMIT_FAILED', msg);
}

/**
 * mivo REST 调用(JSON in/out)。Authorization 由主机按 secrets 声明注入,
 * 401 主机自动重换令牌重试一次,仍 401 到这里按「token 无效或已过期」报。
 */
async function apiJson(method, path, bodyObj, callId, fallbackCode) {
  var req = { url: API + path, method: method, headers: { Accept: 'application/json' }, callId: callId };
  if (bodyObj !== null && bodyObj !== undefined) {
    req.headers['Content-Type'] = 'application/json';
    req.body = JSON.stringify(bodyObj);
  }
  var r = await cindy.fetch(req);
  if (!r || !r.ok) throw hostFetchError(r, fallbackCode);
  if (r.status === 401) throw toolError(fallbackCode, '认证失败:token 无效或已过期');
  var parsed = null;
  if (r.body) {
    try { parsed = JSON.parse(r.body); } catch (e) { parsed = null; }
  }
  if (r.status < 200 || r.status >= 300) {
    throw toolError(fallbackCode, 'API 请求失败: ' + r.status + ' - ' + String(r.body || '').slice(0, 300));
  }
  return parsed;
}

/** chat session:按 chatType 内存缓存复用(规格 §0.4),缺了现建。 */
async function ensureChatSession(chatType, callId) {
  if (chatSessions[chatType]) return chatSessions[chatType];
  var data = await apiJson('POST', '/message/chat', { type: chatType }, callId, 'SUBMIT_FAILED');
  var id = data && typeof data.object_id === 'string' ? data.object_id : '';
  if (!id) throw toolError('SUBMIT_FAILED', '创建 chat session 失败:响应缺少 object_id');
  chatSessions[chatType] = id;
  return id;
}

/**
 * createMessage 通用形状(规格 §0.5):
 * - modelFormat = override ?? (modelVersion ? {version} : {});
 * - NANOBANANA 强制注入 payload.provider = 'genai';
 * - title 仅明确给出时进 body。
 * 返回 object_id 即工具交给 LLM 的 jobId。
 */
async function createMessage(opts, callId) {
  var chatSessionId = await ensureChatSession(opts.chatType, callId);
  var modelFormat = opts.modelFormatOverride !== undefined
    ? opts.modelFormatOverride
    : (opts.modelVersion ? { version: opts.modelVersion } : {});
  var payload = Object.assign({}, opts.payload);
  if (opts.modelType === 'NANOBANANA') payload.provider = 'genai';
  var body = {
    chatSessionId: chatSessionId,
    messageType: opts.messageType,
    modelType: opts.modelType,
    modelFormat: modelFormat,
    action: opts.action,
    payload: payload,
  };
  if (opts.title) body.title = opts.title;
  var data = await apiJson('POST', '/message', body, callId, 'SUBMIT_FAILED');
  var id = data && typeof data.object_id === 'string' ? data.object_id : '';
  if (!id) throw toolError('SUBMIT_FAILED', '创建消息失败:响应缺少 object_id');
  return id;
}

/* ── 参考图解析与上传(规格 §1.5 / §0.7)───────────────────────────────── */

/** mivo 引用 → 24 位 fileId:mivo://image/{id} / http(s) URL 末段 / 裸 24 位。 */
function parseMivoRef(v) {
  var s = str(v);
  if (!s) return null;
  if (HEX24_RE.test(s)) return s;
  if (s.slice(0, 7) === 'mivo://') {
    var parts = s.slice(7).split('/');
    var id = parts.length > 1 ? String(parts[1]).split('?')[0] : '';
    return HEX24_RE.test(id) ? id : null;
  }
  if (/^https?:\/\//i.test(s)) {
    var last = (s.split('/').pop() || '').split('?')[0];
    return HEX24_RE.test(last) ? last : null;
  }
  return null;
}

/**
 * 附件指纹上传:POST /api/v1/file/,主机代组 multipart(字段名 file,
 * 单次 ≤4 文件所以分批)。响应是 JSON 数组,逐项取 object_id ?? _id,
 * 数量必须与上传数一致(规格 §0.7)。
 */
async function uploadHashes(hashes, callId) {
  // 主机 upload.hashes 只认小写指纹且拒重复:先小写归一 + 去重,
  // 结果按原顺序映射回去(同图重复引用共用同一 fileId)。
  var norm = [];
  var seen = {};
  for (var h0 = 0; h0 < hashes.length; h0++) {
    var hv = String(hashes[h0] || '').trim().toLowerCase();
    if (hv && !seen[hv]) { seen[hv] = true; norm.push(hv); }
  }
  var idByHash = {};
  for (var i = 0; i < norm.length; i += 4) {
    var batch = norm.slice(i, i + 4);
    var r = null;
    // 媒体全局闸「正忙」结构化错误:退避重试 3 次(2/3/5s),与下载同款兜底。
    for (var att = 0; att < 4; att++) {
      r = await cindy.fetch({
        url: API + '/file/',
        method: 'POST',
        upload: { hashes: batch, field: 'file' },
        callId: callId,
      });
      if (r && !r.ok && String(r.message || '').indexOf('正忙') >= 0 && att < 3) {
        await sleep([2000, 3000, 5000][att]);
        continue;
      }
      break;
    }
    if (!r || !r.ok) throw hostFetchError(r, 'SUBMIT_FAILED');
    if (r.status < 200 || r.status >= 300) {
      throw toolError('SUBMIT_FAILED', '参考图上传失败: HTTP ' + r.status + ' - ' + String(r.body || '').slice(0, 200));
    }
    var parsed = null;
    try { parsed = JSON.parse(r.body); } catch (e) { parsed = null; }
    if (!Array.isArray(parsed) || parsed.length !== batch.length) {
      throw toolError('SUBMIT_FAILED', '参考图上传失败:响应不是与上传数量一致的 FileMeta 数组');
    }
    for (var j = 0; j < parsed.length; j++) {
      var f = parsed[j];
      var id = isObj(f)
        ? (typeof f.object_id === 'string' && f.object_id ? f.object_id : (typeof f._id === 'string' ? f._id : ''))
        : '';
      if (!id) throw toolError('SUBMIT_FAILED', '参考图上传失败:响应缺少 object_id/_id');
      idByHash[batch[j]] = id;
    }
  }
  var ids = [];
  for (var k = 0; k < hashes.length; k++) {
    ids.push(idByHash[String(hashes[k] || '').trim().toLowerCase()]);
  }
  return ids;
}

/** 附件参数归一:主机把用户随消息过户的图注入 args.attachments(指纹数组)。 */
function attachmentHashes(attachments) {
  var out = [];
  (Array.isArray(attachments) ? attachments : []).forEach(function (a) {
    if (typeof a === 'string' && HASH64_RE.test(a.trim())) out.push(a.trim());
    else if (isObj(a) && typeof a.hash === 'string' && HASH64_RE.test(a.hash)) out.push(a.hash);
  });
  return out;
}

/**
 * 参考图列表解析(意识版 §1.5):mivo://、aigc URL、裸 24 位 id 纯字符串解析;
 * 64 位指纹当附件上传;args.attachments 追加在显式引用之后。本地绝对路径不
 * 支持——返回结构化错误引导用附件/mivo 引用。
 */
async function resolveImageRefs(list, attachments, callId, beforeUpload) {
  var slots = []; // { kind: 'id'|'hash', value }
  var bad = [];
  (Array.isArray(list) ? list : []).forEach(function (item) {
    var id = parseMivoRef(item);
    if (id) { slots.push({ kind: 'id', value: id }); return; }
    var s = str(item);
    if (HASH64_RE.test(s)) { slots.push({ kind: 'hash', value: s }); return; }
    bad.push(String(item));
  });
  if (bad.length) {
    throw toolError(
      'INVALID_ARGS',
      'mivo: 无法解析的图片引用: ' + bad.join(', ') +
        '。支持 mivo://image/{fileId} / aigc.xindong.com URL / 24 位 fileId;本地绝对路径不支持,' +
        '请让用户把图片作为附件随消息发来(附件会自动过户上传)。',
    );
  }
  attachmentHashes(attachments).forEach(function (h) { slots.push({ kind: 'hash', value: h }); });
  // 视频模型按「显式引用 + 附件」总数设上限。先校验再上传,避免非法调用
  // 已经把附件写进 mivo 后才返回 INVALID_ARGS。
  if (typeof beforeUpload === 'function') beforeUpload(slots.length);
  var hashes = [];
  slots.forEach(function (s) { if (s.kind === 'hash') hashes.push(s.value); });
  var uploaded = hashes.length ? await uploadHashes(hashes, callId) : [];
  var ui = 0;
  return slots.map(function (s) { return s.kind === 'id' ? s.value : uploaded[ui++]; });
}

/** 单图工具(抠图/超分/3D 单图)的输入解析:显式 image 优先,否则取首个附件。 */
async function resolveSingleImage(image, attachments, callId) {
  var s = str(image);
  if (s) {
    var id = parseMivoRef(s);
    if (id) return id;
    if (HASH64_RE.test(s)) return (await uploadHashes([s], callId))[0];
    throw toolError(
      'NO_IMAGE',
      '未能解析有效的输入图: ' + s +
        '。支持 mivo://image/{fileId} / aigc.xindong.com URL / 24 位 fileId;本地绝对路径不支持,' +
        '请让用户把图片作为附件随消息发来。',
    );
  }
  var atts = attachmentHashes(attachments);
  if (atts.length) return (await uploadHashes([atts[0]], callId))[0];
  throw toolError('NO_IMAGE', '未能解析有效的输入图:请传 image 参数(mivo:// / aigc URL / 24 位 fileId),或让用户把图片作为附件发来。');
}

/* ── 媒体下载落库(规格 §0.8)─────────────────────────────────────────── */

/**
 * GET /api/v1/file/download/{fileId} + as:'media' 直落媒体总仓。
 * ⚠️ 永远不用结果 JSON 里的 uri/cover 原样 GET(缺 /api/v1 前缀是 SPA 陷阱),
 * 一律抽 24 位 fileId 重拼本端点。失败/0 字节重试 3 次(2s/3s/5s,MJ/Niji
 * completed 后文件短暂未上架高发)。返回 {url,hash,ext,bytes} 或 null。
 */
var lastDownloadError = ''; // 最近一次下载失败的主机原因(downloadMedia 写,失败话术读)

async function downloadMedia(fileId, label, callId) {
  for (var attempt = 0; attempt <= DOWNLOAD_RETRY_DELAYS.length; attempt++) {
    try {
      var fetchArgs = { url: API + '/file/download/' + fileId, as: 'media', callId: callId };
      var lbl = String(label || '').trim().slice(0, 200);
      if (lbl) fetchArgs.label = lbl;
      var r = await cindy.fetch(fetchArgs);
      if (r && r.ok && r.media && r.media.bytes > 0) return r.media;
      // 把主机的结构化拒绝原因留底(白名单阻断/类型不支持/超限…),失败话术要带给用户。
      if (r && !r.ok && r.message) lastDownloadError = String(r.message);
      else if (r && r.ok && r.status) lastDownloadError = 'HTTP ' + r.status + '(非媒体响应)';
    } catch (e) { lastDownloadError = e && e.message ? String(e.message) : String(e); /* 走重试 */ }
    if (attempt < DOWNLOAD_RETRY_DELAYS.length) await sleep(DOWNLOAD_RETRY_DELAYS[attempt]);
  }
  return null;
}

/* ── 结果查询与解析(规格 §0.6 / §2.3 / §5)───────────────────────────── */

/** progress 宽容解析:数字直用;"55" / "55%" 这类数字串也认(部分引擎串型返回)。 */
function parseProgress(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    var n = parseFloat(v.replace('%', ''));
    if (isFinite(n)) return n;
  }
  return undefined;
}

/**
 * GET /api/v1/message/{id} 单次查询 → 归一化 { status, action, error, progress,
 * content }。status 缺省当 processing;action 顶层/content 双兜底(audio 任务
 * REST 响应 action 位置未核实,规格 §0.6);progress 同样 content 优先、顶层
 * 兜底,数字/数字串都认。
 */
async function pollOnce(jobId, callId) {
  var data = await apiJson('GET', '/message/' + encodeURIComponent(jobId), null, callId, 'POLL_FAILED');
  var content = data && isObj(data.content) ? data.content : {};
  var status = typeof content.status === 'string' && content.status ? content.status : 'processing';
  var action =
    (data && typeof data.action === 'string' && data.action) ||
    (typeof content.action === 'string' && content.action) || '';
  var error =
    (typeof content.error === 'string' && content.error) ||
    (data && typeof data.error === 'string' && data.error) || '';
  var progress = parseProgress(content.progress);
  if (progress === undefined && data) progress = parseProgress(data.progress);
  return {
    status: status,
    action: action,
    error: error,
    progress: progress,
    content: content,
  };
}

/** 在窗口内每 2.5s 查一次,终态或窗口耗尽返回最后一次归一化结果。 */
async function pollWindow(jobId, windowMs, callId, onProgress) {
  var deadline = Date.now() + windowMs;
  for (;;) {
    var norm = await pollOnce(jobId, callId);
    if (norm.status === 'completed' || norm.status === 'failed') return norm;
    // 进行中每 tick 回调(progress 可能 undefined——留给回调做心跳判断;
    // best-effort,回调炸了不断轮询)。
    if (onProgress) {
      try { onProgress(norm.progress); } catch (e) { /* 刷卡失败不影响轮询 */ }
    }
    if (Date.now() + POLL_INTERVAL_MS > deadline) return norm;
    await sleep(POLL_INTERVAL_MS);
  }
}

/** URL 末段抽 24 位 fileId(规格 §5.1)。 */
function extractFileIdFromUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  var last = (u.split('/').pop() || '').split('?')[0];
  return HEX24_RE.test(last) ? last : null;
}

function extractImageFileIds(arr) {
  var out = [];
  (Array.isArray(arr) ? arr : []).forEach(function (u) {
    var id = extractFileIdFromUrl(u);
    if (id && out.indexOf(id) < 0) out.push(id);
  });
  return out;
}

/** videos 桶双形态:字符串 URL 或 {id, uri, poster, url/path/fileId/file_id}(规格 §5.2)。 */
function extractVideoFileIds(arr) {
  var out = [];
  (Array.isArray(arr) ? arr : []).forEach(function (v) {
    var id = null;
    if (typeof v === 'string') {
      id = extractFileIdFromUrl(v);
    } else if (isObj(v)) {
      var direct = [v.id, v.fileId, v.file_id];
      for (var i = 0; i < direct.length; i++) {
        if (typeof direct[i] === 'string' && HEX24_RE.test(direct[i])) { id = direct[i]; break; }
      }
      if (!id) id = extractFileIdFromUrl(v.uri) || extractFileIdFromUrl(v.url) || extractFileIdFromUrl(v.path);
    }
    if (id && out.indexOf(id) < 0) out.push(id);
  });
  return out;
}

/** audios 桶:只收有 24 位 string id 的项(规格 §5.3)。 */
function extractRawAudios(arr) {
  var out = [];
  (Array.isArray(arr) ? arr : []).forEach(function (a) {
    if (isObj(a) && typeof a.id === 'string' && HEX24_RE.test(a.id)) out.push(a);
  });
  return out;
}

/** buttons 桶:customId 必须为 string 才收;label/emoji 空串按缺失(规格 §5.4)。 */
function extractButtons(arr) {
  var out = [];
  (Array.isArray(arr) ? arr : []).forEach(function (b) {
    if (!isObj(b) || typeof b.customId !== 'string' || !b.customId) return;
    var item = { customId: b.customId };
    if (typeof b.label === 'string' && b.label) item.label = b.label;
    if (typeof b.emoji === 'string' && b.emoji) item.emoji = b.emoji;
    out.push(item);
  });
  return out;
}

/** 175.96 → "2:55"(向下取整,规格 §2.4)。 */
function formatDuration(sec) {
  var s = Math.max(0, Math.floor(sec));
  var m = Math.floor(s / 60);
  var r = s % 60;
  return m + ':' + (r < 10 ? '0' + r : r);
}

/* ── 交互卡自绘(卡片交互 v2:MJ/Niji 按钮由意识自画,点击回传 card-action)── */

/**
 * 按钮样式:1:1 对标基座 ChatImageActions 的按钮(h-7/px-2.5/text-xs/rounded-md,
 * bg --msg-tool-card-bg=--surface-elevated、border --border-default、字色
 * --text-primary、hover --surface)。这四个底层 token 都在卡片主题白名单里,
 * 用 var() 引用即可跟随主机换肤;fallback 中性灰兜白名单缺失的极端情况。
 * 用 <style> 标签选择器(净化器不放行 class 属性,但保留标签选择器与 :hover)。
 */
var CARD_STYLE_BLOCK =
  '<style>' +
  'button{display:inline-flex;align-items:center;justify-content:center;height:28px;min-width:40px;' +
  'padding:0 10px;font-size:12px;font-weight:500;font-family:system-ui;line-height:1;' +
  'border:1px solid var(--border-default,rgba(127,127,127,.35));border-radius:6px;' +
  'background:var(--surface-elevated,rgba(127,127,127,.1));color:var(--text-primary,#7f7f7f);' +
  'cursor:pointer;transition:background-color .15s}' +
  'button:hover{background:var(--surface,rgba(127,127,127,.18))}' +
  '</style>';

/** card 槽供片(v2 交互卡):失败(限速/被拒/无 card 槽)不影响交卷,尽力而为。
 *  state 可选('working'/'done'),仅 card-action 后台干活链路带:主机据此
 *  点亮/熄灭会话侧栏的运行呼吸;tool-call 期间的供片不带(会话本就在运行态)。 */
function sendMivoCard(callId, html, height, state) {
  var msg = { type: 'card-update', callId: callId, v: 2, html: html, height: height };
  if (state === 'working' || state === 'done') msg.state = state;
  cindy.send(msg).catch(function () {});
}

/* ── 过程动画卡(参考 Cindy Art:🖌️ 摆动 + 文案呼吸,只动 transform/opacity,
 *    主机合成器动画白名单内;running/working 期间播放,settle 后主机自动换静态)── */

/**
 * 提交时登记的任务元数据(内存态,重启丢失 → 查无则不发过程卡,回退旧行为):
 * - 生图任务(MJ/Niji/GPT/Nano/分割/超分):{ kind:'img', prompt }。过程卡发在
 *   **交结果那次 poll 调用**的卡位,终态由 buildFinalResult 强制接管画卡
 *   (带按钮画交互卡、无按钮画纯图卡、失败画失败卡),不留死卡;
 * - 视频/音乐/音效/3D:{ kind:'persist', style, cardCallId, caption, lastCardAt,
 *   lastPct }。**常驻过程卡**模式——卡钉在**提交调用**的卡位(state:'working'
 *   打开跨调用更新窗口),后续轮询跨卡位刷进度,终态发 'done' 完成卡;真正的
 *   播放器/模型预览由**没供过卡的轮询调用**按基座默认渲染(卡里放不了播放器,
 *   绝不能把卡发在交结果的那次调用上)。
 */
var JOB_META = {};
/** 已发过程卡的 poll 调用(callId → 发卡时间戳 ms):终态必须自己接管画卡
 *  (过程卡已顶掉该调用的基座默认渲染,不接管会留一张"生成中"死卡)。 */
var PROGRESS_CARD_CALLS = {};

/** 主机对同一卡位限速 ≥1s/版:终态卡若跟过程卡贴太近会被静默丢(留下
 *  "生成中"死卡)。发终态前按发卡时间戳补足间隔(1.1s 留余量)。 */
async function ensureCardInterval(sentAt) {
  if (typeof sentAt !== 'number') return;
  var wait = 1100 - (Date.now() - sentAt);
  if (wait > 0) await sleep(wait);
}

/** 工具路径异常退出时的过程卡收口:发过就换失败卡再抛,不留"生成中"死卡。 */
async function failProgressCard(callId, err) {
  var sentAt = PROGRESS_CARD_CALLS[callId];
  if (typeof sentAt !== 'number') return;
  delete PROGRESS_CARD_CALLS[callId];
  await ensureCardInterval(sentAt);
  sendErrorCard(callId, (err && err.ghost && err.ghost.message) || (err && err.message) || String(err));
}

/** 各媒体形态的过程卡视觉(mivo 是媒体资产生成意识:生成就要有过程卡)。 */
var CARD_STYLES = {
  img:   { emoji: '🖌️', verb: '正在绘制', eta: '通常 30-60 秒' },
  video: { emoji: '🎬', verb: '正在生成视频', eta: '通常 1-5 分钟' },
  audio: { emoji: '🎵', verb: '正在创作音乐', eta: '通常 90-180 秒' },
  sfx:   { emoji: '🔊', verb: '正在生成音效', eta: '通常 15-25 秒' },
  model: { emoji: '🧊', verb: '正在生成 3D', eta: '通常 1-3 分钟' },
};

/** 绘制中动画卡:渐变画布 + 表情摆动(transform)+ 文案呼吸(opacity)。
 *  caption 可选(提示词一行,超长省略);state 透传('working' 驱动会话呼吸 +
 *  跨调用窗口);progress 可选(>0 才画静态进度条 + 百分比——0 视为"还没有
 *  真进度",维持 eta 文案,免得看着像卡死);styleKey 选形态,缺省 img。 */
function sendDrawingCard(callId, caption, state, progress, styleKey) {
  var st = CARD_STYLES[styleKey] || CARD_STYLES.img;
  var cap = caption
    ? '<div style="margin:0 0 8px;font-size:12px;color:#8a8a8a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">「' + esc(caption) + '」</div>'
    : '';
  var pct = typeof progress === 'number' && isFinite(progress) && progress > 0
    ? Math.min(100, Math.max(1, Math.round(progress)))
    : null;
  var tail = pct === null
    ? '<div style="font-size:10px;color:#a5a5a5">' + st.eta + '</div>'
    : '<div style="width:140px;height:3px;border-radius:2px;background:rgba(127,127,127,.22);overflow:hidden">' +
      '<div style="width:' + pct + '%;height:100%;border-radius:2px;background:rgba(127,127,127,.75)"></div>' +
      '</div>' +
      '<div style="font-size:10px;color:#a5a5a5">' + pct + '%</div>';
  // 布局对齐结果卡:画布通栏出血(与结果图同一左缘,无外层 padding),
  // 高度按卡片画布宽 458 取 16:9 ≈ 258px;题注贴画布上方(与画布同左缘)。
  sendMivoCard(
    callId,
    '<style>' +
      '@keyframes mv-bob{0%,100%{transform:translateY(0) rotate(-4deg)}50%{transform:translateY(-5px) rotate(4deg)}}' +
      '@keyframes mv-breathe{0%,100%{opacity:.45}50%{opacity:1}}' +
      '</style>' +
      '<div style="font-family:system-ui">' + cap +
      '<div style="height:258px;border-radius:10px;' +
      'background:linear-gradient(135deg,rgba(127,127,127,.16),rgba(127,127,127,.04) 55%,rgba(127,127,127,.12));' +
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px">' +
      '<div style="font-size:26px;line-height:1;animation:mv-bob 1.6s ease-in-out infinite">' + st.emoji + '</div>' +
      '<div style="font-size:12px;color:#8f8f8f;font-weight:500;animation:mv-breathe 1.6s ease-in-out infinite">' + st.verb + '</div>' +
      tail +
      '</div></div>',
    cap ? 290 : 262,
    state,
  );
}

/* ── 常驻过程卡(persist 模式:视频/音乐/音效/3D)───────────────────── */

function persistMetaOf(jobId) {
  var m = JOB_META[jobId];
  return m && m.kind === 'persist' ? m : null;
}

/** 提交时登记 + 立刻在提交调用卡位画 working 过程卡(打开跨调用窗口)。 */
function registerPersistCard(jobId, callId, style, caption) {
  JOB_META[jobId] = {
    kind: 'persist', style: style, cardCallId: callId,
    caption: str(caption), lastCardAt: Date.now(), lastPct: undefined,
  };
  sendDrawingCard(callId, str(caption) || null, 'working', undefined, style);
}

/**
 * 任务卡进度/心跳刷新(img 与 persist 两种模式通用;轮询 tick 调,progress
 * 可为 undefined):
 * - 有新百分比且距上版 ≥1.15s → 整版换新;
 * - 没进度时每 ≥60s 发一版同样内容作心跳——续主机会话呼吸的 TTL,
 *   也让"还活着"有据可查。
 */
function touchJobCard(jobId, progress) {
  var meta = JOB_META[jobId];
  if (!meta || !meta.cardCallId) return;
  var now = Date.now();
  if (now - meta.lastCardAt < 1150) return;
  var pct = typeof progress === 'number' && isFinite(progress) && progress > 0
    ? Math.min(100, Math.max(1, Math.round(progress)))
    : null;
  var changed = pct !== null && pct !== meta.lastPct;
  if (!changed && now - meta.lastCardAt < 60000) return;
  if (pct !== null) meta.lastPct = pct;
  meta.lastCardAt = now;
  sendDrawingCard(meta.cardCallId, meta.caption || null, 'working', meta.lastPct, meta.style);
}

var PERSIST_DONE_LABELS = { video: '视频已生成', audio: '音乐已创作完成', sfx: '音效已生成', model: '3D 模型已生成' };

/** 常驻卡完成卡:✅ + 题注 + "内容在下方"(播放器/预览由无卡的轮询调用渲染);
 *  音乐带封面时嵌封面图。 */
function sendPersistDoneCard(meta, coverUrl) {
  var cap = meta.caption
    ? '<div style="font-size:12px;color:#8a8a8a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">「' + esc(meta.caption) + '」</div>'
    : '';
  var cover = coverUrl
    ? '<img src="' + esc(coverUrl) + '" style="display:block;width:100%;height:auto;border-radius:8px;margin-top:10px">'
    : '';
  sendMivoCard(
    meta.cardCallId,
    '<div style="padding:12px;font-family:system-ui">' + cap +
      '<div style="' + (cap ? 'margin-top:8px;' : '') + 'display:flex;align-items:center;gap:8px">' +
      '<div style="font-size:16px;line-height:1">✅</div>' +
      '<div style="font-size:12px;color:#8f8f8f">' + (PERSIST_DONE_LABELS[meta.style] || '已生成完毕') + ',内容在下方 ↓</div>' +
      '</div>' + cover + '</div>',
    cover ? 430 : 120,
    'done',
  );
}

/**
 * 3D 完成卡:预览图直接画进卡里,img 带 data-ghost-model(GLB 的媒体总仓
 * 地址)——用户点击预览即在应用内 3D 查看器旋转查看;previews[i] 与
 * models[i] 按位配对。布局与过程卡同款通栏出血。
 */
async function finish3dCard(jobId, previewUrls, modelEntries) {
  var meta = persistMetaOf(jobId);
  if (!meta) return false;
  delete JOB_META[jobId];
  await ensureCardInterval(meta.lastCardAt);
  var cap = meta.caption
    ? '<div style="margin:0 0 8px;font-size:12px;color:#8a8a8a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">「' + esc(meta.caption) + '」</div>'
    : '';
  var imgs = '';
  for (var i = 0; i < previewUrls.length; i++) {
    var model = modelEntries[i];
    imgs += '<img src="' + esc(previewUrls[i]) + '"' +
      (model ? ' data-ghost-model="' + esc(model.url) + '"' : '') +
      ' style="display:block;width:100%;height:auto;border-radius:10px' + (i ? ';margin-top:6px' : '') + '">';
  }
  sendMivoCard(
    meta.cardCallId,
    '<div style="font-family:system-ui">' + cap + imgs +
      '<div style="margin-top:8px;display:flex;align-items:center;gap:8px">' +
      '<div style="font-size:14px;line-height:1">✅</div>' +
      '<div style="font-size:11px;color:#8f8f8f">3D 模型已生成,点击预览图即可旋转查看</div>' +
      '</div></div>',
    530,
    'done',
  );
  return true;
}

/**
 * 音频完成卡:1:1 复刻基座 ChatAudioCard / ChatSoundEffectCard——封面(96×96
 * 圆角 8)+ 标题(15px 半粗)+ tags(12px 两行截断)+ 宿主托管播放器插槽
 * (data-ghost-audio:宿主受信桥注入与基座同款的播放/进度/时间行,<audio>
 * 活在宿主文档)。配色走主机注入的工具卡 token(var(--msg-tool-card-*)),
 * fallback 取默认亮色主题实际值。播放器画进卡后,结果须带
 * xdt_audio_in_card: true 防基座重复渲染(手机端无卡片体系,忽略该令牌
 * 仍按 xdt_audio_tracks 渲染基座播放器)。
 */
async function finishAudioCard(jobId, renderTracks, isSfx) {
  var meta = persistMetaOf(jobId);
  if (!meta) return false;
  delete JOB_META[jobId];
  await ensureCardInterval(meta.lastCardAt);
  var cap = meta.caption
    ? '<div style="margin:0 0 8px;font-size:12px;color:#8a8a8a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">「' + esc(meta.caption) + '」</div>'
    : '';
  var blocks = '';
  var h = cap ? 30 : 0;
  for (var i = 0; i < renderTracks.length; i++) {
    var t = renderTracks[i];
    var slot = '<div data-ghost-audio="' + esc(t.xdt_audio_url) + '"' +
      (typeof t.duration_seconds === 'number' && isFinite(t.duration_seconds)
        ? ' data-ghost-audio-duration="' + (Math.round(t.duration_seconds * 100) / 100) + '"'
        : '') +
      ' style="min-height:28px"></div>';
    var boxStyle = (i ? 'margin-top:8px;' : '') +
      'border-radius:12px;border:1px solid var(--msg-tool-card-border,#d7d7d4);background:var(--msg-tool-card-bg,#ffffff)';
    if (isSfx) {
      // 音效精简卡:标题行 + 播放器行(对标 ChatSoundEffectCard 的密度)。
      blocks += '<div style="' + boxStyle + ';padding:12px 16px">' +
        '<div style="margin-bottom:8px;font-size:13px;font-weight:600;color:var(--msg-tool-card-text,#262626);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(t.title || '音效') + '</div>' +
        slot + '</div>';
      h += 82 + (i ? 8 : 0);
    } else {
      var cover = t.cover_url
        ? '<img src="' + esc(t.cover_url) + '" style="display:block;width:100%;height:100%;object-fit:cover">'
        // 无封面占位:渐变 + 音符,对标 ChatAudioCard 的 fallback 形态。
        : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,var(--msg-tool-card-chevron,#525252),var(--msg-tool-card-text,#262626));opacity:.4;font-size:30px;line-height:1">🎵</div>';
      var tags = t.tags
        ? '<div style="overflow:hidden;font-size:12px;line-height:1.45;color:var(--msg-tool-card-chevron,#525252);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">' + esc(t.tags) + '</div>'
        : '';
      blocks += '<div style="' + boxStyle + ';display:flex;align-items:center;gap:16px;padding:16px">' +
        '<div style="flex-shrink:0;overflow:hidden;border-radius:8px;width:96px;height:96px">' + cover + '</div>' +
        '<div style="display:flex;min-width:0;flex:1;flex-direction:column;gap:8px">' +
        '<div style="font-size:15px;font-weight:600;color:var(--msg-tool-card-text,#262626);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(t.title || '未命名') + '</div>' +
        tags + slot +
        '</div></div>';
      h += 130 + (i ? 8 : 0);
    }
  }
  sendMivoCard(
    meta.cardCallId,
    '<div style="font-family:system-ui">' + cap + blocks + '</div>',
    Math.min(900, h + 4),
    'done',
  );
  return true;
}

/** 常驻卡终态收口:成功发完成卡 / 失败发失败卡,都带 'done' 关窗熄呼吸。 */
async function finishPersistCard(jobId, ok, message, coverUrl) {
  var meta = persistMetaOf(jobId);
  if (!meta) return;
  delete JOB_META[jobId];
  await ensureCardInterval(meta.lastCardAt);
  if (ok) sendPersistDoneCard(meta, coverUrl);
  else sendErrorCard(meta.cardCallId, message || '任务失败', 'done');
}

/** customId 动作段:MJ::JOB::upsample::1::<id> → 'upsample';NANOBANANA::image::imgPrompt::0::<id> → 'imgPrompt'。 */
function actionSegOf(customId) {
  return String(customId || '').split('::')[2] || '';
}

/** imgPrompt 改写类按钮:需要用户输入提示词(卡上声明 data-ghost-prompt,
 *  宿主点击时弹输入框收集,文字随 card-action 的 prompt 回传——与老基座
 *  ChatImageActions 的 popover 同体验)。 */
function isPromptButton(b) {
  return actionSegOf(b.customId) === 'imgPrompt';
}

/**
 * 按钮显示文案:label 优先、emoji 兜底,都空则从 customId 结构推
 * (upsample::2 → U2,variation::3 → V3,reroll → 🔄)——与基座
 * ChatImageActions 的 buttonContent/fallbackLabel 同一套规则。
 */
function cardButtonLabel(b) {
  if (b.label && String(b.label).trim()) return String(b.label).trim();
  if (b.emoji && String(b.emoji).trim()) return String(b.emoji).trim();
  var parts = String(b.customId || '').split('::');
  if (parts.length < 4 || parts[1] !== 'JOB') return '⋯';
  if (parts[2] === 'upsample') return 'U' + parts[3];
  if (parts[2] === 'variation') return 'V' + parts[3];
  if (parts[2] === 'reroll') return '🔄';
  return parts[2].slice(0, 4).toUpperCase();
}

/**
 * 把 card-action 回传的 actionId 拆回 { jobId, customId }。画卡时按钮的
 * data-ghost-action 编码成 "父jobId::customId":第一段是 24 位父 jobId(不含
 * ::),其余用 :: 拼回原 customId——无状态,意识睡了/重启也能还原父任务号。
 */
function parseCardActionId(actionId) {
  var parts = String(actionId || '').split('::');
  if (parts.length < 2) return null;
  var jobId = parts.shift();
  var customId = parts.join('::');
  if (!jobId || !customId) return null;
  return { jobId: jobId, customId: customId };
}

/** 只下载完成态里的图片(按钮动作只出图,card-action 重绘用),失败略过。 */
async function downloadImagesForCard(content, jobId, callId) {
  var ids = extractImageFileIds(content && content.images);
  var urls = [];
  for (var i = 0; i < ids.length; i++) {
    var m = await downloadMedia(ids[i], 'mivo 结果 ' + jobId, callId);
    if (m && IMAGE_EXTS.indexOf(m.ext) >= 0) urls.push(m.url);
  }
  return urls;
}

/**
 * 交互卡:图片网格(裸 img,点击走主机 lightbox)+ 一排可点按钮(样式对标基座
 * ChatImageActions)。全部按钮都画:普通按钮(U/V/Reroll)点击直发 card-action;
 * imgPrompt 改写类加 data-ghost-prompt,宿主点击时弹输入框收提示词后随
 * card-action 回传。按钮 data-ghost-action = "父jobId::customId"。
 */
function buildInteractiveCardHtml(imageUrls, buttons, jobId) {
  var n = imageUrls.length;
  var gridStyle = n <= 1 ? 'display:block' : 'display:grid;grid-template-columns:repeat(2,1fr);gap:4px';
  var imgs = '';
  for (var i = 0; i < n; i++) {
    imgs += '<img src="' + esc(imageUrls[i]) + '" style="display:block;width:100%;height:auto;border-radius:6px;cursor:zoom-in">';
  }
  var btns = '';
  for (var j = 0; j < (buttons || []).length; j++) {
    var b = buttons[j];
    var promptAttr = isPromptButton(b) ? ' data-ghost-prompt="想怎么改这张图？输入提示词，回车发送"' : '';
    btns += '<button data-ghost-action="' + esc(jobId + '::' + b.customId) + '"' + promptAttr + '>' + esc(cardButtonLabel(b)) + '</button>';
  }
  var height = (n <= 1 ? 300 : 300 * Math.ceil(n / 2)) + (btns ? 44 : 4);
  return {
    html:
      CARD_STYLE_BLOCK +
      '<div style="font-family:system-ui">' +
      '<div style="' + gridStyle + '">' + imgs + '</div>' +
      (btns ? '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">' + btns + '</div>' : '') +
      '</div>',
    height: height,
  };
}

/** 画一张交互卡(图 + 按钮)到指定 callId。state 透传 sendMivoCard(可选)。 */
function sendInteractiveCard(callId, imageUrls, buttons, jobId, state) {
  var c = buildInteractiveCardHtml(imageUrls, buttons, jobId);
  sendMivoCard(callId, c.html, c.height, state);
}

/** 失败小卡(把真实原因给用户看)。state 透传(可选)。 */
function sendErrorCard(callId, message, state) {
  sendMivoCard(
    callId,
    '<div style="font-family:system-ui;padding:14px">' +
      '<div style="font-size:12px;color:#c0564f;font-weight:500">生成失败</div>' +
      '<div style="margin-top:4px;font-size:11px;color:#8a8a8a;white-space:pre-wrap">' + esc(message || '未知错误') + '</div>' +
      '</div>',
    90,
    state,
  );
}

/* ── 终态结果组装(poll_result / mivo_button_action 共用,规格 §2.4)────── */

/**
 * 把归一化轮询结果收敛成交给 LLM 的 JSON:
 * - failed:message = 错误原文,guidance 教 AI 原样转告;
 * - 未终态:教 AI 自动接力 poll_result,不询问用户;
 * - completed:images/videos 两桶合并下载、按真实 ext 分流(xdt_image_urls /
 *   xdt_video_urls 由聊天气泡直接渲染);音频画进任务卡(finishAudioCard:
 *   1:1 播放器卡,data-ghost-audio 插槽由宿主注入标准播放器),结果带
 *   xdt_audio_in_card 防基座重复渲染;xdt_audio_tracks 照常下发供手机端
 *   基座播放器用,同时落媒体库给 media 数组;MJ 按钮以数据形式给 buttons
 *   供 mivo_button_action 使用。
 */
async function buildFinalResult(jobId, norm, callId) {
  // 卡片收口契约:任务开过卡(img 模式的常驻卡位 meta.cardCallId)就必须由
  // 终态接管画卡——过程卡顶掉了那次调用的基座默认渲染,撒手会留"生成中"死卡。
  // PROGRESS_CARD_CALLS 只是"本调用炸单"的异常接管登记,正常终态走 meta。
  delete PROGRESS_CARD_CALLS[callId];
  var meta = JOB_META[jobId];
  var imgMeta = meta && meta.kind === 'img' && meta.cardCallId ? meta : null;

  if (norm.status === 'failed') {
    var errMsg = norm.error || '未知错误';
    if (imgMeta) {
      delete JOB_META[jobId];
      await ensureCardInterval(imgMeta.lastCardAt); // 限速余量:终态卡不贴上一版 <1s
      sendErrorCard(imgMeta.cardCallId, errMsg, 'done');
    }
    await finishPersistCard(jobId, false, errMsg); // 常驻卡(视频/音频等)失败收口
    return {
      ok: true,
      jobId: jobId,
      status: 'failed',
      message: errMsg,
      guidance: '任务失败: ' + errMsg + '。请把错误信息原样告诉用户。',
    };
  }
  if (norm.status !== 'completed') {
    // 本窗没等到终态:任务卡保持 working 原样(动画/呼吸/跨调用窗口都在),
    // 下一轮 poll 跨调用继续刷同一张卡——一个任务永远只有一张卡。
    var pending = {
      ok: true,
      jobId: jobId,
      status: norm.status || 'processing',
      message: '任务仍在进行中,请继续查询',
      guidance:
        '任务仍在进行中。请自动继续调用 poll_result 查询同一个 jobId,不要询问用户是否继续。可简短安抚用户耐心等待。',
    };
    if (typeof norm.progress === 'number') pending.progress = norm.progress;
    return pending;
  }

  var content = norm.content;
  // images/videos 两桶合并下载,靠字节类型(ext)区分,不信 bucket 名(§2.4-1)。
  var imageIds = extractImageFileIds(content.images);
  var videoIds = extractVideoFileIds(content.videos);
  var mediaIds = imageIds.slice();
  videoIds.forEach(function (id) { if (mediaIds.indexOf(id) < 0) mediaIds.push(id); });

  var imageUrls = [];
  var videoUrls = [];
  var otherMedia = [];
  var failedCount = 0;
  for (var i = 0; i < mediaIds.length; i++) {
    var m = await downloadMedia(mediaIds[i], 'mivo 结果 ' + jobId, callId);
    if (!m) { failedCount++; continue; }
    if (IMAGE_EXTS.indexOf(m.ext) >= 0) imageUrls.push(m.url);
    else if (VIDEO_EXTS.indexOf(m.ext) >= 0) videoUrls.push(m.url);
    else otherMedia.push({ url: m.url, hash: m.hash, ext: m.ext, bytes: m.bytes, kind: 'file' });
  }

  // 音频(Suno / ElevenLabs):action==='generate_sound_effect' → 音效,否则音乐。
  var rawAudios = extractRawAudios(content.audios);
  var isSfx = norm.action === 'generate_sound_effect';
  var tracks = [];
  var audioMedia = [];
  // 渲染轨(xdt_audio_tracks):逐轨带 cindy-media 地址 + 元数据,mcpServer 上提
  // 到顶层后聊天气泡渲染成播放器卡(音乐带封面/歌词,音效精简卡)。只收下载
  // 成功的轨——没有音频字节的轨画不了播放器,只留在 tracks[](模型侧元数据)。
  var audioTracksRender = [];
  for (var k = 0; k < rawAudios.length; k++) {
    var a = rawAudios[k];
    var am = await downloadMedia(a.id, a.title || ('mivo 音频 ' + jobId), callId);
    if (!am) failedCount++;
    else audioMedia.push({ url: am.url, hash: am.hash, ext: am.ext, bytes: am.bytes, kind: 'audio', title: a.title || '' });
    if (isSfx) {
      tracks.push({ kind: 'sound_effect', title: a.title || '' });
      if (am) audioTracksRender.push({ kind: 'sound_effect', xdt_audio_url: am.url, title: a.title || '' });
    } else {
      var t = { kind: 'music', title: a.title || '' };
      if (typeof a.duration === 'number') {
        t.duration_seconds = a.duration;
        t.duration_text = formatDuration(a.duration);
      }
      if (str(a.tags)) t.tags = a.tags;
      if (str(a.lyrics)) t.lyrics = a.lyrics;
      if (str(a.suno_id)) t.suno_id = a.suno_id;
      // 封面 best-effort(音乐才下,音效跳过;失败只少个封面,不计入 failed)。
      var coverId = extractFileIdFromUrl(str(a.cover));
      if (coverId) {
        var cm = await downloadMedia(coverId, (a.title || '音乐') + ' 封面', callId);
        if (cm) t.cover_url = cm.url;
      }
      tracks.push(t);
      if (am) {
        var rt = { kind: 'music', xdt_audio_url: am.url, title: t.title };
        if (typeof t.duration_seconds === 'number') rt.duration_seconds = t.duration_seconds;
        if (str(t.tags)) rt.tags = t.tags;
        if (str(t.lyrics)) rt.lyrics = t.lyrics;
        if (str(t.suno_id)) rt.suno_id = t.suno_id;
        if (str(t.cover_url)) rt.cover_url = t.cover_url;
        audioTracksRender.push(rt);
      }
    }
  }

  var buttons = extractButtons(content.buttons);
  var total = mediaIds.length + rawAudios.length;
  var message = '';
  if (failedCount > 0) {
    message = failedCount >= total && total > 0
      ? '图片下载失败(已重试 3 次)。任务本身已完成,但文件暂时无法获取。最后一次失败原因:' + (lastDownloadError || '未知') + '。请把该原因转告用户。'
      : failedCount + '/' + total + ' 个文件下载失败(已重试 3 次),其余已正常显示。';
  }

  var result = {
    ok: true,
    jobId: jobId,
    status: 'completed',
    progress: 100,
    message: message,
    image_count: imageUrls.length,
    video_count: videoUrls.length,
    audio_count: audioMedia.length,
  };
  // 带按钮(U/V/Reroll/imgPrompt)= 交互卡:图 + 按钮由意识自绘(card 槽),
  // 不走基座图气泡,避免卡片与气泡重复渲染同一张图。imgPrompt 改写类按钮由
  // 宿主弹输入框收提示词(data-ghost-prompt),与老基座 popover 同体验。
  var hasInteractive = buttons.length > 0 && imageUrls.length > 0;
  if (videoUrls.length) result.xdt_video_urls = videoUrls;
  // xdt_audio_tracks 照常下发:手机端(无卡片体系)据此渲染基座播放器;
  // 桌面端因下方的 xdt_audio_in_card 令牌跳过基座渲染(播放器在卡里)。
  if (audioTracksRender.length) result.xdt_audio_tracks = audioTracksRender;
  // 视频回锚:常驻卡任务(提交调用开的过程卡)完成时,把提交卡的 callId 作为
  // 锚点随结果返回(mcpServer 上提到顶层)——渲染层据此把视频播放器挂回提交
  // 卡正下方,替换"生成中"的视觉位置;批量提交+延后轮询时视频不再脱离卡片
  // 堆在轮询处。音频的回锚在下方 audioCardPainted 分支随 xdt_audio_in_card
  // 一起带(那里是验证锚:渲染层查卡验插槽)。
  if (videoUrls.length && meta && meta.kind === 'persist' && meta.cardCallId) {
    result.xdt_anchor_card_id = meta.cardCallId;
  }
  var media = audioMedia.concat(otherMedia);
  if (media.length) result.media = media;
  if (tracks.length) result.tracks = tracks;
  // buttons 数据保留:用户用文字(如「放大第二张」)时仍走 mivo_button_action 文本路径。
  if (buttons.length) result.buttons = buttons;

  // 终态画卡(img 模式):画回任务的常驻卡位(单轮 = 本调用;多轮 = 第一轮开
  // 的那张卡),state:'done' 关窗熄呼吸。图进了卡就不再走气泡(防重复渲染);
  // meta 查无(重启/老流程)且有按钮时回退画在本调用(旧行为)。
  var cardTarget = imgMeta ? imgMeta.cardCallId : (hasInteractive ? callId : null);
  var cardPaintedImages = false;
  if (imgMeta) {
    delete JOB_META[jobId];
    await ensureCardInterval(imgMeta.lastCardAt);
  }
  if (cardTarget && hasInteractive) {
    sendInteractiveCard(cardTarget, imageUrls, buttons, jobId, imgMeta ? 'done' : undefined);
    cardPaintedImages = true;
  } else if (cardTarget && imageUrls.length) {
    // 无按钮但有图(GPT/Nano/分割/超分):纯图卡收口。
    sendInteractiveCard(cardTarget, imageUrls, buttons, jobId, 'done');
    cardPaintedImages = true;
  } else if (cardTarget) {
    sendErrorCard(cardTarget, message || '结果文件下载失败,请稍后重试', 'done');
  }
  // 契约(2026-07 媒体送达):媒体地址字段是**数据通道**(IM/hook 出站靠它
  // 把图送到 Slack/飞书),画卡只附 xdt_images_in_card 令牌让桌面基座去重,
  // 绝不删字段——此前画卡后不下发地址,IM 用户永远收不到生成图(实踩)。
  if (imageUrls.length) {
    result.xdt_image_urls = imageUrls;
    if (cardPaintedImages) {
      result.xdt_images_in_card = true;
      // 跨调用画卡(多轮 poll 画回首轮卡位):回锚到持卡调用,渲染层凭锚取卡
      // 验证含图后才压基座(单轮画在本调用时结果自带 xdt_card_id,无需锚)。
      if (cardTarget && cardTarget !== callId && !result.xdt_anchor_card_id) {
        result.xdt_anchor_card_id = cardTarget;
      }
    }
  }

  // 常驻卡(视频/音乐/音效)完成收口:音频画 1:1 播放器卡(封面/标题/tags +
  // data-ghost-audio 插槽,宿主注入标准播放器);画成后带 xdt_audio_in_card
  // 令牌防基座重复渲染。画不成(音频全下载失败 / meta 查无)回退 ✅ 完成卡,
  // 有封面时嵌封面让用户至少看到成品脸。
  var audioCardPainted = audioTracksRender.length
    ? await finishAudioCard(jobId, audioTracksRender, isSfx)
    : false;
  if (audioCardPainted) {
    result.xdt_audio_in_card = true;
    // 令牌只是"待验证声明":配套回锚 callId,渲染层锚到这张卡、确认 html 里
    // 真含对应 data-ghost-audio 插槽后才压基座播放器;验证不过(card-update
    // 被静默拒/远程控制端看不到卡)自动回退基座渲染,音频永不消失。
    if (meta && meta.kind === 'persist' && meta.cardCallId) {
      result.xdt_anchor_card_id = meta.cardCallId;
    }
  } else {
    var doneCover = tracks.length && typeof tracks[0].cover_url === 'string' ? tracks[0].cover_url : undefined;
    await finishPersistCard(jobId, true, '', doneCover);
  }

  var g = [];
  if (imageUrls.length && !hasInteractive) g.push('已生成 ' + imageUrls.length + ' 张图片,已渲染在消息流中。不要在回复文本里再用 markdown 图片语法嵌入同一张图——会导致重复。');
  if (hasInteractive) g.push('已生成 ' + imageUrls.length + ' 张图片,连同 ' + buttons.length + ' 个可点击按钮(放大/变体/重roll/改写等)已画成一张交互卡片显示在消息流中,用户直接点按钮即可换新图(改写类按钮点击会弹输入框收提示词)。不要在回复里再用 markdown 嵌入这些图、也不要罗列按钮清单。用户若用文字表达(如「放大第二张」)才调用 mivo_button_action({ messageId: "' + jobId + '", customId: <原样透传 buttons[i].customId> });imgPrompt 类按钮记得带 prompt。');
  if (videoUrls.length) g.push('已生成 ' + videoUrls.length + ' 个视频,已渲染在消息流中。不要再用 markdown 把视频嵌一遍——会出现两个一模一样的播放器。基于内容简短点评即可,不要复述 prompt 原文。');
  if (audioMedia.length) g.push('已生成 ' + audioMedia.length + ' 条' + (isSfx ? '音效' : '音乐') + ',带播放器的卡片已画在任务卡位(封面/标题/进度条俱全),同时已存入本机媒体库。基于 tracks[] 的纯文本元数据简短介绍即可:不要用 markdown 链接再嵌入音频、不要展示 cindy-media:// 等技术字段、不要复述 prompt 原文' + (isSfx ? '' : ';用户问到歌词再用引用块展示 lyrics') + '。');
  if (otherMedia.length) g.push('另有 ' + otherMedia.length + ' 个文件已存入媒体库(见 media 字段)。');
  // 图片全下载失败画不成卡时的降级——告知 LLM 按钮仍可经文字路径触发。
  if (buttons.length && !hasInteractive) g.push('本次结果带 ' + buttons.length + ' 个按钮但图片未能显示。用户表达对应意图时(如「放大第二张」「把这张图改成…」)调用 mivo_button_action({ messageId: "' + jobId + '", customId: <原样透传 buttons[i].customId> });imgPrompt 类按钮必须带 prompt(用户的改图描述原文)。');
  if (message) g.push(message);
  if (!g.length) g.push('任务已完成,但没有返回媒体文件。');
  result.guidance = g.join('\n');
  return result;
}

/* ── 工具 1:submit_gen_image(规格 §1)──────────────────────────────── */

var IMAGE_MODEL_CANONICALS = [
  'gemini-3-pro-image-preview',
  'gemini-3.1-flash-image-preview',
  'gpt-image-2',
  'mj-v7.0',
  'niji-v7',
];
var GPT_ALIASES = ['gpt', 'gpt2', 'gpt20', 'gptimage2', 'gptimage20'];
var MJ_ALIASES = ['mj', 'mj7', 'mj70', 'mjv7', 'mjv70', 'midjourney', 'midjourney7', 'midjourneyv7', 'midjourneyv70'];
var NIJI_ALIASES = ['niji', 'niji7', 'nijiv7', 'nijijourney', 'nijijourney7', 'nijijourneyv7'];

var NANO_PRO_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '2:3', '3:2', '4:5', '5:4'];
var NANO_FLASH_RATIOS = ['1:1', '1:4', '4:1', '1:8', '8:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
var GPT_RATIOS = ['1:1', '2:3', '3:2', '16:9', '9:16'];

/** modelVersion 别名归一(规格 §1.3),归一失败即 INVALID_ARGS。 */
function normalizeImageModel(v) {
  var raw = str(v) || 'gemini-3-pro-image-preview';
  if (IMAGE_MODEL_CANONICALS.indexOf(raw) >= 0) return raw;
  var k = normKey(raw);
  for (var i = 0; i < IMAGE_MODEL_CANONICALS.length; i++) {
    if (normKey(IMAGE_MODEL_CANONICALS[i]) === k) return IMAGE_MODEL_CANONICALS[i];
  }
  if (GPT_ALIASES.indexOf(k) >= 0) return 'gpt-image-2';
  if (MJ_ALIASES.indexOf(k) >= 0) return 'mj-v7.0';
  if (NIJI_ALIASES.indexOf(k) >= 0) return 'niji-v7';
  throw toolError('INVALID_ARGS', '不支持的 modelVersion: ' + raw + '。支持: ' + IMAGE_MODEL_CANONICALS.join(', '));
}

/** GPT quality 中英别名归一(规格 §1.3)。 */
function normalizeQuality(v) {
  var raw = str(v) || 'auto';
  var k = normKey(raw);
  var table = {
    auto: ['auto', '自动', '默认'],
    low: ['low', 'lowquality', '低质量', '低清', '低'],
    medium: ['medium', 'mediumquality', '中等质量', '中质量', '中等', '中'],
    high: ['high', 'highquality', '高质量', '高清', '高'],
  };
  var keys = Object.keys(table);
  for (var i = 0; i < keys.length; i++) {
    if (table[keys[i]].indexOf(k) >= 0) return keys[i];
  }
  throw toolError('INVALID_ARGS', '不支持的 quality: ' + raw + '。支持: auto, low, medium, high');
}

async function submitGenImage(args, callId) {
  var prompt = str(args.prompt);
  if (!prompt) throw toolError('INVALID_ARGS', 'prompt 不能为空(使用用户原话)');
  var model = normalizeImageModel(args.modelVersion);
  var ratio = str(args.ratio) || '1:1';
  var resolution = str(args.resolution) || '1K';

  // 比例/分辨率本地拦截(规格 §1.3 superRefine;MJ/Niji 全比例都收不校验)。
  if (model === 'gemini-3-pro-image-preview') {
    if (NANO_PRO_RATIOS.indexOf(ratio) < 0) {
      throw toolError('INVALID_ARGS', 'gemini-3-pro-image-preview 不支持比例 ' + ratio + '。支持: ' + NANO_PRO_RATIOS.join(', '));
    }
    if (['1K', '2K', '4K'].indexOf(resolution) < 0) {
      throw toolError('INVALID_ARGS', 'gemini-3-pro-image-preview 不支持分辨率 ' + resolution + '。支持: 1K, 2K, 4K');
    }
  } else if (model === 'gemini-3.1-flash-image-preview') {
    if (NANO_FLASH_RATIOS.indexOf(ratio) < 0) {
      throw toolError('INVALID_ARGS', 'gemini-3.1-flash-image-preview 不支持比例 ' + ratio + '。支持: ' + NANO_FLASH_RATIOS.join(', '));
    }
    if (['512', '1K', '2K', '4K'].indexOf(resolution) < 0) {
      throw toolError('INVALID_ARGS', 'gemini-3.1-flash-image-preview 不支持分辨率 ' + resolution + '。支持: 512, 1K, 2K, 4K');
    }
  } else if (model === 'gpt-image-2') {
    if (GPT_RATIOS.indexOf(ratio) < 0) {
      throw toolError('INVALID_ARGS', 'gpt-image-2 不支持比例 ' + ratio + '。支持: ' + GPT_RATIOS.join(', '));
    }
  }

  var ids = await resolveImageRefs(args.images, args.attachments, callId);
  var payload;
  var jobId;

  if (model === 'gpt-image-2') {
    // 分支 B:GPT——quality 归一,无 resolution、无 provider、无 title(§1.4)。
    payload = { prompt: prompt, imgRatio: ratio, quality: normalizeQuality(args.quality), n: 1 };
    if (ids.length) payload.images = ids;
    jobId = await createMessage({
      chatType: 'freeform', messageType: 'image', modelType: 'GPT',
      modelVersion: model, action: 'mcp', payload: payload,
    }, callId);
    JOB_META[jobId] = { kind: 'img', prompt: prompt };
    return {
      ok: true, jobId: jobId,
      guidance: '图片生成任务已提交,jobId=' + jobId + '。请调用 poll_result({ jobId, mode: "gpt_wait" }) 等待结果(GPT 模型约 60 秒)。',
    };
  }

  if (model === 'mj-v7.0' || model === 'niji-v7') {
    // 分支 C:MJ/Niji 共用管线——modelFormat 是 override({v}/{niji}),
    // negativePrompt 非空才并入 no(空串会拼出非法 --no CLI 参数,§1.4)。
    var mf = model === 'niji-v7' ? { niji: '7' } : { v: '7.0' };
    var neg = str(args.negativePrompt);
    if (neg) mf.no = neg;
    payload = { prompt: prompt, images: ids, imgRatio: ratio, smarted: true };
    jobId = await createMessage({
      chatType: 'freeform', messageType: 'image', modelType: 'MJ',
      modelFormatOverride: mf, action: 'imagine', payload: payload, title: '作图',
    }, callId);
    // 登记任务元数据:后续 poll_result 等待期据此画"正在绘制"动画过程卡。
    JOB_META[jobId] = { kind: 'img', prompt: prompt };
    var mjLabel = model === 'niji-v7' ? 'Niji' : 'MJ';
    return {
      ok: true, jobId: jobId,
      guidance: '图片生成任务已提交,jobId=' + jobId + '。请调用 poll_result({ jobId }) 查询结果(' + mjLabel + ' 通常 30-60 秒完成,processing 时继续轮询)。',
    };
  }

  // 分支 A:Nanobanana(Pro/Flash)——provider:'genai' 由 createMessage 统一注入。
  payload = { prompt: prompt, imgRatio: ratio, resolution: resolution, n: 1 };
  if (ids.length) payload.images = ids;
  jobId = await createMessage({
    chatType: 'freeform', messageType: 'image', modelType: 'NANOBANANA',
    modelVersion: model, action: 'mcp', payload: payload,
  }, callId);
  JOB_META[jobId] = { kind: 'img', prompt: prompt };
  return {
    ok: true, jobId: jobId,
    guidance: '图片生成任务已提交,jobId=' + jobId + '。请调用 poll_result({ jobId }) 查询结果(约 20 秒内完成)。',
  };
}

/* ── 工具 2:poll_result(规格 §2)───────────────────────────────────── */

async function pollResult(args, callId) {
  var jobId = str(args.jobId);
  if (!jobId) throw toolError('INVALID_ARGS', 'jobId 不能为空');
  var mode = args.mode === 'gpt_wait' ? 'gpt_wait' : 'default';
  var t = typeof args.timeout === 'number' && isFinite(args.timeout) ? Math.floor(args.timeout) : 30;
  t = Math.min(120, Math.max(5, t));
  var windowMs = mode === 'gpt_wait' ? MAX_TOOL_WAIT_MS : t * 1000;
  // 生图(img 模式):**一个任务只有一张卡**——第一轮 poll 在自己的卡位开
  // "正在绘制"动画卡并记为该任务的常驻卡位(state:'working' 打开跨调用窗口);
  // 后续轮次不再开新卡,跨调用刷同一张(修多轮 gpt_wait 叠卡问题);终态由
  // buildFinalResult 画回这张卡。persist 模式(视频/音频等)同理刷提交调用的卡。
  var meta = JOB_META[jobId];
  var onProgress = null;
  if (meta) {
    if (meta.kind === 'img' && !meta.cardCallId) {
      meta.cardCallId = callId;
      meta.caption = str(meta.prompt);
      meta.lastCardAt = Date.now();
      meta.lastPct = undefined;
      sendDrawingCard(callId, meta.caption || null, 'working');
      PROGRESS_CARD_CALLS[callId] = meta.lastCardAt; // 本调用炸单时的异常接管登记
    }
    if (meta.cardCallId) onProgress = function (p) { touchJobCard(jobId, p); };
  }
  var norm;
  try {
    norm = await pollWindow(jobId, windowMs, callId, onProgress);
  } catch (err) {
    // 只收口本调用刚开的卡(登记过);别的调用开的卡保留,下轮 poll 自会续上。
    var openedHere = typeof PROGRESS_CARD_CALLS[callId] === 'number';
    await failProgressCard(callId, err);
    if (openedHere && meta && meta.cardCallId === callId) delete JOB_META[jobId];
    throw err;
  }
  return buildFinalResult(jobId, norm, callId);
}

/* ── 工具 3/4:segment_image / super_resolution_image(规格 §3)────────── */

async function submitImageTool(args, callId, action) {
  var fileId = await resolveSingleImage(args.image, args.attachments, callId);
  var payload = { images: [fileId] };
  if (action === 'super_resolution') payload.scale = 2; // 固定 2 倍(§3.3)
  var jobId = await createMessage({
    chatType: 'tool', // 注意不是 freeform(§3.3)
    messageType: 'image',
    modelType: 'ALICLOUD',
    action: action,
    payload: payload,
  }, callId);
  var name = action === 'segment' ? '图片分割' : '图片超分辨率';
  // 图类任务:poll 等待期画过程卡,终态接管画图卡(与生图同款 img 模式)。
  JOB_META[jobId] = { kind: 'img', prompt: name };
  return { ok: true, jobId: jobId, guidance: name + '任务已提交,jobId=' + jobId + '。请调用 poll_result({ jobId }) 查询。' };
}

function segmentImage(args, callId) { return submitImageTool(args, callId, 'segment'); }
function superResolutionImage(args, callId) { return submitImageTool(args, callId, 'super_resolution'); }

/* ── 工具 5:mivo_button_action(规格 §4)────────────────────────────── */

/** 必须附带 prompt 的按钮动作段白名单(与 mivo 网页端弹输入框是同一规则)。 */
var PROMPT_REQUIRED_ACTIONS = ['imgPrompt'];

/**
 * 提交按钮动作 + 单窗轮询(文本工具 mivo_button_action 与卡片点击 card-action
 * 共用)。返回 { newId, norm };提交失败 / 缺 object_id 抛结构化错误。
 */
async function submitButtonAction(messageId, customId, prompt, title, callId) {
  var chatSessionId = await ensureChatSession('freeform', callId);
  var body = {
    chatSessionId: chatSessionId,
    customId: customId,
    title: str(title) || '作图',
    payload: { messageId: messageId },
  };
  if (prompt) body.payload.prompt = prompt; // 仅有值才带,保持与老 MJ 形状一致(§4.3-3)
  var data = await apiJson('POST', '/message/submit', body, callId, 'SUBMIT_FAILED');
  var newId =
    (data && typeof data.object_id === 'string' && data.object_id) ||
    (data && typeof data.messageId === 'string' && data.messageId) || '';
  if (!newId) {
    var rawText = '';
    try { rawText = JSON.stringify(data); } catch (e) { rawText = String(data); }
    throw toolError('SUBMIT_FAILED', 'submit button action 失败:响应缺少 object_id/messageId (' + String(rawText).slice(0, 200) + ')');
  }
  // 按钮动作产出的新任务:登记元数据,常驻卡位 = 调用方刚画过程卡的卡位
  // (文字路径 = 工具 callId;卡片路径 = 衍生卡位)。单窗没跑完时后续
  // poll_result(newId) 跨调用继续刷同一张卡,不再开新卡。
  JOB_META[newId] = {
    kind: 'img', prompt: prompt || '', caption: prompt || '',
    cardCallId: callId, lastCardAt: Date.now(), lastPct: undefined,
  };
  // drain:105s 内循环 GET,终态/超时返回与 poll_result 完全同构(§4.3-5);
  // 期间进度/心跳直刷任务卡。
  var norm = await pollWindow(newId, MAX_TOOL_WAIT_MS, callId, function (p) { touchJobCard(newId, p); });
  return { newId: newId, norm: norm };
}

async function mivoButtonAction(args, callId) {
  var messageId = str(args.messageId);
  var customId = str(args.customId);
  if (!messageId) throw toolError('INVALID_ARGS', 'messageId 不能为空(父图任务的 jobId)');
  if (!customId) throw toolError('INVALID_ARGS', 'customId 不能为空(原样透传 buttons[i].customId)');
  var prompt = str(args.prompt);
  // 前置校验:imgPrompt 不带 prompt 直接拦下,不打 mivo 吃 400(§4.3-1)。
  if (PROMPT_REQUIRED_ACTIONS.indexOf(actionSegOf(customId)) >= 0 && !prompt) {
    throw toolError('PROMPT_REQUIRED', '该按钮需要附带提示词才能执行:请向用户询问想怎么改这张图,拿到提示词后带上 prompt 参数重新调用。');
  }
  // 文字路径的"继续生成"同样画"正在绘制"动画卡(working 开跨调用窗口;
  // drain 最长 105s,百分比随轮询刷新);终态由 buildFinalResult 画回本卡位,
  // 单窗没跑完则卡保持 working、后续 poll_result 跨调用续刷;提交异常由
  // failProgressCard 收口。
  sendDrawingCard(callId, prompt || null, 'working');
  PROGRESS_CARD_CALLS[callId] = Date.now();
  try {
    var res = await submitButtonAction(messageId, customId, prompt, str(args.title), callId);
    return await buildFinalResult(res.newId, res.norm, callId);
  } catch (err) {
    await failProgressCard(callId, err);
    throw err;
  }
}

/**
 * 卡片按钮点击(card-action)处理:actionId = "父jobId::customId"。用户在意识
 * 自绘卡上点了按钮 → 重跑动作,新结果画到主机铸的**衍生卡位 spawnCallId**——
 * 被点的卡(四宫格 + 按钮)原封不动,新卡长在它下方,MJ 抽卡式可反复点。
 * (老主机无 spawnCallId 时回退原地换卡。)fire-and-forget:不交卷(没有 LLM
 * 在等),全程只 card-update。imgPrompt 改写类按钮的提示词由宿主输入框收集
 * (data-ghost-prompt),随 msg.prompt 带来;缺词兜底忽略(宿主不会零输入派发)。
 */
async function handleCardAction(msg) {
  var cardCallId = str(msg && msg.callId);
  var parsed = parseCardActionId(msg && msg.actionId);
  if (!cardCallId || !parsed) return; // 形状非法(主机侧已校验,这里兜底)
  var prompt = str(msg && msg.prompt);
  if (PROMPT_REQUIRED_ACTIONS.indexOf(actionSegOf(parsed.customId)) >= 0 && !prompt) return;
  // 新结果的画布:衍生卡位优先(母卡保留),归因也记在新卡名下。
  // state 声明贯穿全程:过程卡 'working' 保持会话侧栏呼吸,一切终态卡 'done'
  // 熄灭呼吸(主机 card-action 派发时已点亮;不声明则靠主机 TTL 兜底)。
  var target = str(msg && msg.spawnCallId) || cardCallId;
  // 过程态 = "正在绘制"动画卡(与 poll 等待期同款;working 驱动衍生卡扫光 +
  // 会话呼吸 + 跨调用窗口,imgPrompt 改写带用户提示词作题注,百分比随 drain
  // 轮询直刷本卡位)。
  sendDrawingCard(target, prompt || null, 'working');
  var drawingSentAt = Date.now();
  try {
    var res = await submitButtonAction(parsed.jobId, parsed.customId, prompt, '作图', target);
    var norm = res.norm;
    var metaB = JOB_META[res.newId];
    // 限速余量:快速失败/秒回结果时终态卡不能贴上一版 <1s(会被主机静默丢)。
    await ensureCardInterval(metaB ? metaB.lastCardAt : drawingSentAt);
    if (norm.status === 'failed') {
      delete JOB_META[res.newId];
      sendErrorCard(target, norm.error || '任务失败', 'done');
      return;
    }
    if (norm.status !== 'completed') {
      // 长任务(Outpaint/Animate 等)单窗没跑完:卡保持 working(动画/跨调用
      // 窗口都在,任务确实还在后台跑),meta 保留——用户随后让 AI「查询刚才
      // 的作图」时 poll_result(newId) 会跨调用续刷这张卡直到终态;侧栏呼吸由
      // 主机 TTL 兜底熄灭。
      return;
    }
    delete JOB_META[res.newId]; // 终态在本处收口,poll 不再接手
    var content = norm.content || {};
    var imageUrls = await downloadImagesForCard(content, res.newId, target);
    if (imageUrls.length) {
      sendInteractiveCard(target, imageUrls, extractButtons(content.buttons), res.newId, 'done');
    } else {
      sendErrorCard(target, '新图已生成,但下载失败:' + (lastDownloadError || '未知原因'), 'done');
    }
  } catch (err) {
    var m = (err && err.ghost && err.ghost.message) || (err && err.message) || String(err);
    await ensureCardInterval(drawingSentAt); // 提交秒抛也不能贴上一版 <1s
    sendErrorCard(target, m, 'done');
  }
}

/* ── 工具 6:submit_gen_video(规格 §6)──────────────────────────────── */

var SEEDANCE_ALIASES = [
  'seedance', 'seedance2', 'seedance20fast', 'seedancefast',
  'ark', 'arkvideo', 'doubao', '豆包', '即梦视频',
  'seedance15pro', // legacy Seedance_1_5_Pro 一律落 2.0 Fast(§6.2)
];
// Seedance 2.0 标准模式:wire 枚举 Seedance_2_0,payload 形态与 Fast 一致,
// 只是生成更慢、质量更高。'seedance20' 即 wire 名归一,落标准而非 Fast。
var SEEDANCE_STD_ALIASES = [
  'seedance20', // normKey(Seedance_2_0) — wire 枚举本名
  'standard', 'seedancestandard', 'seedance20standard',
  '标准', '标准版', '标准模式', 'seedance标准', 'seedance20标准',
];
// Seedance 3.0 Pro 极速版:wire 枚举沿用后端旧名 Seedance_1_0_Pro;
// 双图请求按网页抓包格式映射为 firstFrame / lastFrame。
var SEEDANCE_PRO_ALIASES = [
  'seedance10pro', // normKey(Seedance_1_0_Pro) — wire 枚举本名
  'seedance3', 'seedance30', 'seedance3pro', 'seedance30pro',
  'pro', 'seedancepro', 'seedanceprofast', 'seedance30profast',
  '极速版', 'seedance极速版', 'seedancepro极速版', 'seedance30pro极速版',
];
var KLING_ALIASES = ['kling', 'klingv3', 'klingv30', 'klingv3omni', '可灵', '可灵v3'];
var VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
var SEEDANCE_FAST_MAX_IMAGES = 9;
var SEEDANCE_PRO_FRAME_IMAGES = 2;
var KLING_MAX_IMAGES = 7;

function validateVideoImageCount(engine, seedanceVersion, count) {
  // All engines support text-to-video without reference images.
  if (count === 0) return;
  if (engine === 'seedance' && seedanceVersion === 'Seedance_1_0_Pro') {
    if (count !== SEEDANCE_PRO_FRAME_IMAGES) {
      throw toolError('INVALID_ARGS', 'Seedance 3.0 Pro 图生视频必须提供 2 张图片:第 1 张首帧,第 2 张尾帧');
    }
    return;
  }
  if (engine === 'seedance' && count > SEEDANCE_FAST_MAX_IMAGES) {
    throw toolError('INVALID_ARGS', 'Seedance 2.0 最多接受 9 张参考图');
  }
  if (engine === 'kling' && count > KLING_MAX_IMAGES) {
    throw toolError('INVALID_ARGS', 'Kling v3 Omni 最多接受 7 张参考图');
  }
}

async function submitGenVideo(args, callId) {
  var prompt = str(args.prompt);
  if (!prompt) throw toolError('INVALID_ARGS', 'prompt 不能为空(使用用户原话)');
  var k = normKey(str(args.modelVersion) || 'Seedance_2_0_Fast');
  var engine;
  var seedanceVersion = 'Seedance_2_0_Fast'; // ARK 通道的 wire 枚举(Fast / 标准 / 3.0 Pro 极速版)
  if (SEEDANCE_PRO_ALIASES.indexOf(k) >= 0) { engine = 'seedance'; seedanceVersion = 'Seedance_1_0_Pro'; }
  else if (SEEDANCE_STD_ALIASES.indexOf(k) >= 0) { engine = 'seedance'; seedanceVersion = 'Seedance_2_0'; }
  else if (SEEDANCE_ALIASES.indexOf(k) >= 0) engine = 'seedance';
  else if (KLING_ALIASES.indexOf(k) >= 0) engine = 'kling';
  else throw toolError('INVALID_ARGS', '不支持的 modelVersion: ' + str(args.modelVersion) + '。支持: Seedance_2_0_Fast(默认), Seedance_2_0(标准模式), Seedance_1_0_Pro(Seedance 3.0 Pro 极速版), kling-v3-omni');

  // 跨引擎误传校验(§6.2):专属参数传错引擎直接 INVALID_ARGS。
  var wrong = [];
  if (engine === 'seedance') {
    ['mode', 'multi_shot', 'sound'].forEach(function (p) { if (args[p] !== undefined) wrong.push([p, 'Kling 引擎(modelVersion=kling-v3-omni)']); });
  } else {
    ['resolution', 'audio'].forEach(function (p) { if (args[p] !== undefined) wrong.push([p, 'Seedance 引擎(modelVersion=Seedance_2_0_Fast / Seedance_2_0 / Seedance_1_0_Pro)']); });
  }
  if (wrong.length) throw toolError('INVALID_ARGS', wrong[0][0] + ' 仅在 ' + wrong[0][1] + '下有效');

  var videoRatio = str(args.videoRatio) || '16:9';
  if (VIDEO_RATIOS.indexOf(videoRatio) < 0) throw toolError('INVALID_ARGS', '不支持的 videoRatio: ' + videoRatio + '。支持: ' + VIDEO_RATIOS.join(', '));
  var duration = args.duration === undefined ? 5 : Number(args.duration);
  if (duration !== 5 && duration !== 10) throw toolError('INVALID_ARGS', 'duration 只支持 5 或 10(秒)');

  var ids = await resolveImageRefs(args.images, args.attachments, callId, function (count) {
    validateVideoImageCount(engine, seedanceVersion, count);
  });

  // Generic reference-image payload. Seedance 3.0 replaces this below with the
  // website-compatible firstFrame/lastFrame payload.
  var payload = { images: ids, videoRatio: videoRatio, prompt: prompt, duration: duration, video_clips: [] };
  var jobId;
  var eta;
  if (engine === 'seedance') {
    var isSeedancePro = seedanceVersion === 'Seedance_1_0_Pro';
    var resolution = str(args.resolution) || (isSeedancePro ? '720P' : '480P');
    if (['480P', '720P'].indexOf(resolution) < 0) throw toolError('INVALID_ARGS', '不支持的 resolution: ' + str(args.resolution) + '。支持: 480P, 720P');
    if (isSeedancePro) {
      if (args.audio === true) throw toolError('INVALID_ARGS', 'Seedance 3.0 Pro 首尾帧模式不支持 audio 参数');
      payload = { images: [], videoRatio: videoRatio, prompt: prompt, duration: duration, resolution: resolution };
      if (ids.length === 2) {
        payload.firstFrame = ids[0];
        payload.lastFrame = ids[1];
      }
    } else {
      payload.audio_clips = [];
      payload.audio = args.audio === true;
      payload.resolution = resolution;
    }
    jobId = await createMessage({
      chatType: 'video', messageType: 'video', modelType: 'ARK',
      modelVersion: seedanceVersion, action: 'generate_video', payload: payload, title: '作视频',
    }, callId);
    if (seedanceVersion === 'Seedance_1_0_Pro') {
      eta = duration === 10 ? '约 2-4 分钟(Seedance 3.0 Pro 极速版)' : '约 1-3 分钟(Seedance 3.0 Pro 极速版)';
    } else if (seedanceVersion === 'Seedance_2_0') {
      eta = duration === 10 ? '约 3-6 分钟(Seedance 2.0 标准模式)' : '约 2-4 分钟(Seedance 2.0 标准模式)';
    } else {
      eta = duration === 10 ? '约 90-150 秒(Seedance Fast)' : '约 60-90 秒(Seedance Fast)';
    }
  } else {
    var klingMode = str(args.mode) || 'std';
    if (['std', 'pro'].indexOf(klingMode) < 0) throw toolError('INVALID_ARGS', '不支持的 mode: ' + str(args.mode) + '。支持: std, pro');
    var sound = str(args.sound) || 'on';
    if (['on', 'off'].indexOf(sound) < 0) throw toolError('INVALID_ARGS', '不支持的 sound: ' + str(args.sound) + '。支持: on, off');
    payload.mode = klingMode;
    payload.multi_shot = args.multi_shot === true;
    payload.sound = sound;
    jobId = await createMessage({
      chatType: 'video', messageType: 'video', modelType: 'KLING',
      modelVersion: 'kling-v3-omni', action: 'generate_video', payload: payload, title: '作视频',
    }, callId);
    eta = duration === 10 ? '约 3-5 分钟(Kling std)/ 5-8 分钟(pro)' : '约 2-3 分钟(Kling std)/ 3-5 分钟(pro)';
  }
  // 常驻过程卡:钉在本次提交调用的卡位,后续轮询跨卡位刷进度(§JOB_META)。
  registerPersistCard(jobId, callId, 'video', prompt);
  var engineName = engine === 'kling' ? 'Kling'
    : seedanceVersion === 'Seedance_1_0_Pro' ? 'Seedance 3.0 Pro 极速版'
    : seedanceVersion === 'Seedance_2_0' ? 'Seedance 2.0 标准模式'
    : 'Seedance';
  return {
    ok: true, jobId: jobId, engine: engine,
    guidance: engineName + ' 视频生成任务已提交,jobId=' + jobId +
      '。请调用 poll_result({ jobId, mode: "gpt_wait" }) 等待结果(' + eta +
      ',可能要多轮 gpt_wait 才能拿到 completed,中途收到 processing 立刻继续轮询,不要询问用户)。',
  };
}

/* ── 工具 7:submit_gen_music(Suno V5,规格 §7)─────────────────────── */

async function submitGenMusic(args, callId) {
  var custom = args.customMode === true;
  var instrumental = args.instrumental === true;
  var prompt = str(args.prompt);
  if (!prompt) throw toolError('INVALID_ARGS', 'prompt 不能为空(custom 模式占位 1 个字符即可)');

  if (!custom) {
    // simple 模式:custom 专属控制项一律拒(§7.2 superRefine)。
    var customOnly = ['vocalGender', 'styleWeight', 'weirdnessConstraint'];
    for (var i = 0; i < customOnly.length; i++) {
      if (args[customOnly[i]] !== undefined) throw toolError('INVALID_ARGS', customOnly[i] + ' 仅在 customMode=true 时有效');
    }
  } else {
    if (!str(args.title)) throw toolError('INVALID_ARGS', 'customMode=true 时 title 必填');
    if (!str(args.style)) throw toolError('INVALID_ARGS', 'customMode=true 时 style 必填');
    if (!instrumental && !str(args.lyrics)) throw toolError('INVALID_ARGS', 'customMode=true 且 instrumental=false 时 lyrics 必填');
  }
  if (args.vocalGender !== undefined && args.vocalGender !== 'm' && args.vocalGender !== 'f') {
    throw toolError('INVALID_ARGS', 'vocalGender 只支持 "m"(男声)/ "f"(女声)');
  }
  var floats = ['styleWeight', 'weirdnessConstraint'];
  for (var j = 0; j < floats.length; j++) {
    var fv = args[floats[j]];
    if (fv !== undefined && (typeof fv !== 'number' || !isFinite(fv) || fv < 0 || fv > 1)) {
      throw toolError('INVALID_ARGS', floats[j] + ' 必须是 0-1 之间的数字');
    }
  }

  // ⚠️ wire 语义:custom 模式下 payload.prompt 槽位装的是歌词(§7.3);
  //    instrumental=true 时发空串(字段必须在场)。payload.title 是歌名,
  //    顶层 title 固定「音频」,两者不同层。
  var payload;
  if (custom) {
    payload = {
      taskType: 'generate_music',
      customMode: true,
      instrumental: instrumental,
      prompt: str(args.lyrics) || '',
      style: str(args.style),
      title: str(args.title),
    };
    if (args.vocalGender !== undefined) payload.vocalGender = args.vocalGender;
    if (args.styleWeight !== undefined) payload.styleWeight = args.styleWeight;
    if (args.weirdnessConstraint !== undefined) payload.weirdnessConstraint = args.weirdnessConstraint;
  } else {
    payload = { taskType: 'generate_music', customMode: false, instrumental: instrumental, prompt: prompt };
  }
  var jobId = await createMessage({
    chatType: 'audio', messageType: 'audio', modelType: 'SUNO',
    modelVersion: 'V5', action: 'generate_music', payload: payload, title: '音频',
  }, callId);
  // 常驻过程卡(题注:custom 模式用歌名,simple 模式用描述原文)。
  registerPersistCard(jobId, callId, 'audio', custom ? str(args.title) : prompt);
  return {
    ok: true, jobId: jobId,
    guidance: 'Suno 音乐生成任务已提交,jobId=' + jobId +
      '。请调用 poll_result({ jobId, mode: "gpt_wait" }) 等待结果(Suno 通常 90-180 秒完成,可能要 2-3 轮 gpt_wait 才能拿到 completed,中途收到 processing 立刻继续轮询,不要询问用户)。',
  };
}

/* ── 工具 8:submit_gen_sound_effect(ElevenLabs,规格 §8)──────────── */

async function submitGenSoundEffect(args, callId) {
  var prompt = str(args.prompt);
  if (!prompt) throw toolError('INVALID_ARGS', 'prompt 不能为空(音效描述,原话透传)');
  var duration = args.duration === undefined ? 5 : Number(args.duration);
  if (!isFinite(duration) || duration < 0.5 || duration > 30) throw toolError('INVALID_ARGS', 'duration 必须是 0.5-30 之间的秒数');
  var promptInfluence = args.promptInfluence === undefined ? 0.3 : Number(args.promptInfluence);
  if (!isFinite(promptInfluence) || promptInfluence < 0 || promptInfluence > 1) throw toolError('INVALID_ARGS', 'promptInfluence 必须是 0-1 之间的数字');
  var n = args.n === undefined ? 2 : Number(args.n);
  if (!isFinite(n) || Math.floor(n) !== n || n < 1 || n > 4) throw toolError('INVALID_ARGS', 'n 必须是 1-4 的整数');
  var jobId = await createMessage({
    chatType: 'audio', messageType: 'audio', modelType: 'ELEVENLABS',
    modelVersion: 'eleven_text_to_sound_v2', action: 'generate_sound_effect',
    payload: {
      taskType: 'generate_sound_effect',
      prompt: prompt,
      duration: duration,
      promptInfluence: promptInfluence,
      loop: args.loop === true,
      n: n,
    },
    title: '音频',
  }, callId);
  registerPersistCard(jobId, callId, 'sfx', prompt); // 常驻过程卡
  return {
    ok: true, jobId: jobId,
    guidance: 'ElevenLabs 音效生成任务已提交,jobId=' + jobId +
      '。请调用 poll_result({ jobId, mode: "gpt_wait" }) 等待结果(音效通常 15-25 秒完成,gpt_wait 单轮即可拿到 completed,无需追问用户)。',
  };
}

/* ── 工具 9:submit_gen_3d_model(规格 §9)───────────────────────────── */

var SEED3D_ALIASES = ['即梦3d', 'seed3d', 'seed3d20'];

/** generateType 归一:PBR/WHITE(中文别名收编,WHITE 强制 pbr=false,§9.3)。 */
function normalizeGenerateType(v) {
  var raw = str(v) || 'PBR';
  var k = normKey(raw);
  if (['pbr', '纹理', '开启纹理'].indexOf(k) >= 0) return 'PBR';
  if (['white', '白模', '关闭纹理', '无纹理'].indexOf(k) >= 0) return 'WHITE';
  throw toolError('INVALID_ARGS', '不支持的 generateType: ' + raw + '。支持: PBR, WHITE');
}

/** quad 归一:bool 原样;字符串按四边/三角词表;缺省 false(§9.3)。 */
function normalizeQuad(v) {
  if (v === undefined || v === null || v === '') return false;
  if (typeof v === 'boolean') return v;
  var k = normKey(v);
  if (['quad', '四边面', '四边角', '四边形', '四角面'].indexOf(k) >= 0) return true;
  if (['tri', 'triangle', '三角面', '三角形'].indexOf(k) >= 0) return false;
  throw toolError('INVALID_ARGS', '不支持的 quad: ' + String(v) + '。支持: true/false、quad/triangle、四边面/三角面');
}

/** faceCount 语义解析:数字 / 纯数字串 / "N万|Nw" / low·medium·high(仅 ARK)。 */
function parseFaceCount(v, modelType) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number') {
    if (!isFinite(v) || v <= 0) throw toolError('INVALID_ARGS', 'faceCount 必须是正数,收到: ' + v);
    return Math.floor(v);
  }
  var s = str(v).toLowerCase();
  if (['low', 'medium', 'high'].indexOf(s) >= 0) {
    if (modelType !== 'ARK') throw toolError('INVALID_ARGS', 'faceCount 的 low/medium/high 仅对 ARK 有效,TRIPO3D 请传数字');
    return s;
  }
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  var m = s.match(/^(\d+)\s*(w|万)$/);
  if (m) return parseInt(m[1], 10) * 10000;
  throw toolError('INVALID_ARGS', '无法解析 faceCount: ' + String(v));
}

/** 从 prompt 文本嗅探目标格式(TRIPO 未显式给 modelFormat 时,§9.3)。 */
function sniffFormatFromText(text) {
  var lc = String(text || '').toLowerCase();
  if (lc.indexOf('fbx') >= 0) return 'FBX';
  if (lc.indexOf('obj') >= 0) return 'OBJ';
  if (lc.indexOf('usdz') >= 0) return 'USDZ';
  if (lc.indexOf('glb') >= 0) return 'GLB';
  return 'GLB';
}

/** 单个 mivo 引用或 64 位指纹 → fileId(多视角槽位用)。 */
async function resolveRefOrHash(s, callId) {
  var id = parseMivoRef(s);
  if (id) return id;
  if (HASH64_RE.test(str(s))) return (await uploadHashes([str(s)], callId))[0];
  throw toolError('NO_IMAGE', '未能解析参考图: ' + String(s) + '(支持 mivo:// / aigc URL / 24 位 fileId,或让用户把图片作为附件发来)');
}

async function submitGen3dModel(args, callId) {
  // ── 模型路由归一(§9.3)──
  var mtRaw = str(args.modelType);
  var mvRaw = str(args.modelVersion);
  var seedHit = SEED3D_ALIASES.indexOf(normKey(mtRaw)) >= 0 || SEED3D_ALIASES.indexOf(normKey(mvRaw)) >= 0;
  var modelType;
  var modelVersion;
  if (seedHit) {
    if (mtRaw.toUpperCase() === 'TRIPO3D') throw toolError('INVALID_ARGS', 'modelType=TRIPO3D 与 Seed3D 别名冲突');
    modelType = 'ARK';
    modelVersion = 'Seed3D_2_0';
  } else {
    modelType = (mtRaw || 'TRIPO3D').toUpperCase();
    if (modelType !== 'TRIPO3D' && modelType !== 'ARK') {
      throw toolError('INVALID_ARGS', '不支持的 modelType: ' + mtRaw + '。支持: TRIPO3D, ARK');
    }
    if (modelType === 'ARK') throw toolError('INVALID_ARGS', 'ARK 目前仅支持 Seed3D_2_0');
    var v = (mvRaw || 'P1').toLowerCase();
    if (v === 'p1') modelVersion = 'P1';
    else if (v === '3.1' || v === 'v3.1') modelVersion = 'V3.1';
    else throw toolError('INVALID_ARGS', '不支持的 modelVersion: ' + mvRaw + '。支持: P1, 3.1, v3.1, V3.1');
  }

  // ── 输入三选一(§9.2 superRefine;附件在三者全缺时兜底当单图)──
  var image = str(args.image);
  var refImgs = isObj(args.referenceImages) ? args.referenceImages : null;
  var refHasAny = !!(refImgs && (str(refImgs.front) || str(refImgs.back) || str(refImgs.left) || str(refImgs.right)));
  var prompt = str(args.prompt);
  var atts = attachmentHashes(args.attachments);
  var useAttachment = false;
  var count = (image ? 1 : 0) + (refHasAny ? 1 : 0) + (prompt ? 1 : 0);
  if (count === 0 && atts.length) { useAttachment = true; count = 1; }
  if (count === 0) throw toolError('INVALID_ARGS', 'image / referenceImages / prompt 至少设置一个');
  if (count > 1) throw toolError('INVALID_ARGS', 'image / referenceImages / prompt 不能同时设置多个输入');
  if (refHasAny) {
    if (!str(refImgs.front)) throw toolError('INVALID_ARGS', 'TRIPO3D 多图参考必须提供 front');
    if (!str(refImgs.back)) throw toolError('INVALID_ARGS', 'TRIPO3D 多图参考必须提供 back');
  }

  var generateType = normalizeGenerateType(args.generateType);
  var pbr = args.pbr === true;
  if (generateType === 'WHITE') pbr = false;
  var quad = normalizeQuad(args.quad);
  var faceCount = parseFaceCount(args.faceCount, modelType);

  var payload;
  var targetFormat;
  var jobId;

  if (modelType === 'ARK') {
    // ARK Seed3D:仅图生(§9.4)。
    if (prompt) throw toolError('INVALID_ARGS', 'ARK Seed3D_2_0 仅支持图生 3D');
    if (refHasAny) throw toolError('INVALID_ARGS', 'ARK Seed3D_2_0 必须提供 image(不支持多视角 referenceImages)');
    var arkId = useAttachment
      ? (await uploadHashes([atts[0]], callId))[0]
      : await resolveSingleImage(image, null, callId);
    var ff = str(args.fileformat).toLowerCase();
    if (ff && ff !== 'glb') {
      throw toolError('FORMAT_NOT_SUPPORTED', 'ARK Seed3D 仅支持 GLB,且其产物不支持格式转换;需要 ' + ff.toUpperCase() + ' 请改用 TRIPO3D(modelFormat 传 fbx/obj),或引导用户到 aigc.xindong.com 网页端导出');
    }
    targetFormat = 'GLB';
    payload = { images: [arkId] };
    if (faceCount !== undefined) payload.faceCount = faceCount;
    if (ff) payload.fileformat = ff;
    if (str(args.subdivisionlevel)) payload.subdivisionlevel = str(args.subdivisionlevel).toLowerCase();
    jobId = await createMessage({
      chatType: 'model3d', messageType: 'model3d', modelType: 'ARK',
      modelVersion: 'Seed3D_2_0', action: 'generate_3d_model', payload: payload,
    }, callId);
  } else {
    // TRIPO3D:目标格式探测(§9.3);非 GLB 目标提交时强制 GLB 中间产物,
    // 完成后经 convert_3d_model_format 服务端转换(GLB 入库 / 非 GLB 凭票落盘)。
    var mfArg = str(args.modelFormat).toLowerCase();
    if (mfArg && ['glb', 'fbx', 'obj'].indexOf(mfArg) < 0) {
      throw toolError('FORMAT_NOT_SUPPORTED', '不支持的 modelFormat: ' + mfArg.toUpperCase() + '。支持: glb, fbx, obj(fbx/obj 先生成 GLB 中间产物,完成后经 convert_3d_model_format 转换);USD 请引导用户到 aigc.xindong.com 网页端导出');
    }
    // 显式参数优先,否则从提示词嗅探(FBX/OBJ 记为待转换目标;USDZ 不支持只提醒)。
    var sniffed = sniffFormatFromText(prompt);
    if (mfArg && mfArg !== 'glb') targetFormat = mfArg.toUpperCase();
    else if (sniffed === 'FBX' || sniffed === 'OBJ') targetFormat = sniffed;
    else targetFormat = 'GLB';

    payload = { generateType: generateType, pbr: pbr, quad: quad, resolution: 'high' };
    if (faceCount !== undefined) {
      if (typeof faceCount !== 'number') throw toolError('INVALID_ARGS', 'TRIPO3D 的 faceCount 仅支持数字');
      payload.faceCount = faceCount;
    }
    if (prompt) {
      payload.prompt = prompt;
    } else if (refHasAny) {
      // ⚠️ wire 顺序 front,left,back,right;空槽保留空串(§9.4)。
      var slotRefs = [str(refImgs.front), str(refImgs.left), str(refImgs.back), str(refImgs.right)];
      var slotIds = [];
      for (var si = 0; si < slotRefs.length; si++) {
        slotIds.push(slotRefs[si] ? await resolveRefOrHash(slotRefs[si], callId) : '');
      }
      payload.images = slotIds;
    } else {
      var tripoId = useAttachment
        ? (await uploadHashes([atts[0]], callId))[0]
        : await resolveSingleImage(image, null, callId);
      payload.images = [tripoId];
    }
    payload.modelFormat = 'glb';
    jobId = await createMessage({
      chatType: 'model3d', messageType: 'model3d', modelType: 'TRIPO3D',
      modelVersion: modelVersion, action: 'generate_3d_model', payload: payload,
    }, callId);
  }

  last3dTaskId = jobId;
  registerPersistCard(jobId, callId, 'model', prompt || '图生 3D'); // 常驻过程卡
  var formatNote = '';
  if (targetFormat !== 'GLB') {
    // 非 GLB 目标:GLB 中间产物只用于预览,完成后必须走转换才算交付。
    pendingConversion[jobId] = targetFormat;
    formatNote = '\n用户要的目标格式是 ' + targetFormat + ':本次先生成 GLB 中间产物(可预览),' +
      'poll_3d_result 完成后调用 convert_3d_model_format({ originalModelTaskId: "' + jobId + '", format: "' + targetFormat + '" }) 转换;' +
      '非 GLB 产物落盘需要主 agent 在 ghost_call 顶层传 save_dir(当前会话工作目录内的已存在目录)。';
  } else if (typeof sniffed === 'string' && sniffed === 'USDZ') {
    formatNote = '\n注意:提示词里提到了 USDZ,当前不支持(可用 convert_3d_model_format 转 FBX/OBJ,或引导用户到 aigc.xindong.com 网页端导出)。';
  }
  var followup = '请调用 poll_3d_result({ jobId: "' + jobId + '" }) 查询。完成后模型会自动存入本机媒体库。' + formatNote;
  return {
    ok: true, jobId: jobId, targetFormat: targetFormat,
    guidance: '3D 任务已提交,jobId=' + jobId + ',目标格式=' + targetFormat + '\n\n' + followup,
  };
}

/* ── 工具 10:poll_3d_result(规格 §10)──────────────────────────────── */

async function poll3dResult(args, callId) {
  var jobId = str(args.jobId);
  if (!jobId) throw toolError('INVALID_ARGS', 'jobId 不能为空');
  var norm = await pollOnce(jobId, callId);
  var content = norm.content;
  var modelFiles = [];
  (Array.isArray(content.model_files) ? content.model_files : []).forEach(function (f) {
    if (typeof f === 'string' && f) modelFiles.push(f); // 裸 24 位 fileId(§5.5)
  });
  var status = norm.status;
  var result = { ok: true, jobId: jobId, status: status, modelFiles: modelFiles, message: norm.error || '' };

  if (status === 'failed') {
    await finishPersistCard(jobId, false, result.message || '3D 生成失败'); // 常驻卡失败收口
    result.guidance = '3D 生成失败: ' + (result.message || '未知错误');
    return result;
  }
  if (status !== 'completed') {
    touchJobCard(jobId, norm.progress); // 常驻卡刷进度/心跳
    result.guidance = '3D 生成中,请稍候。jobId=' + jobId + ',建议 5-10 秒后再次 poll_3d_result,不要询问用户';
    return result;
  }
  if (!modelFiles.length) {
    result.message = '任务已完成,但模型文件尚未返回。建议稍后重试 poll_3d_result';
    result.guidance = '3D 任务完成但文件未返回。请稍后再次 poll_3d_result({ jobId: "' + jobId + '" })';
    return result;
  }

  // 预览缩略图 best-effort 落库渲染(失败只跳过预览,不影响主流程)。
  var previewIds = extractImageFileIds(content.images);
  var previewUrls = [];
  for (var i = 0; i < previewIds.length; i++) {
    var m = await downloadMedia(previewIds[i], '3D 预览 ' + jobId, callId);
    if (m && IMAGE_EXTS.indexOf(m.ext) >= 0) previewUrls.push(m.url);
  }
  if (previewUrls.length) result.xdt_image_urls = previewUrls;
  var previewNote = previewUrls.length ? '预览图已渲染在消息流中。\n' : '';

  // 模型本体顺手落媒体总仓(内容寻址,与 download_file 重复下载天然去重):
  // 随预览图发 _xdt_model_files 按位配对,renderer 才能把预览图点击路由到
  // 3D 查看器(ModelLightbox)而不是普通图片 lightbox。配对是按位的,所以
  // 只有「预览图存在 且 模型全部落库成功」才发射并改话术——部分失败时数组
  // 塌缩会让预览 i 错配模型 j,预览缺失时用户没有任何可点入口,两种情况都
  // 必须整体降级回老话术(让 AI 走 download_file),不影响任务结果本身。
  var modelEntries = [];
  for (var j = 0; j < modelFiles.length; j++) {
    var mm = await downloadMedia(modelFiles[j], '3D 模型 ' + jobId, callId);
    if (mm && mm.ext === '.glb') modelEntries.push({ provider: 'cindy', url: mm.url, format: 'GLB' });
  }
  var modelsPaired = previewUrls.length > 0 && modelEntries.length === modelFiles.length;
  if (modelsPaired) result._xdt_model_files = modelEntries;

  if (modelsPaired) {
    // 预览 + 模型齐备:完成卡自带可点预览(data-ghost-model → 应用内 3D 查看
    // 器),结果不再下发 xdt_image_urls/_xdt_model_files——内容全在上方卡片,
    // 消息流不重复渲染一份。卡片链路失败(meta 丢失等)回退基座渲染。
    // finish3dCard 内部会 delete JOB_META,先取持卡调用号供回锚
    var persistMeta3d = persistMetaOf(jobId);
    var cardDone = await finish3dCard(jobId, previewUrls, modelEntries);
    if (cardDone) {
      // 预览图地址保留(数据通道,IM 出站要用),只加入卡令牌去重桌面基座;
      // _xdt_model_files 仍删(按位配对只服务基座点击路由,卡内已自带)。
      result.xdt_images_in_card = true;
      if (persistMeta3d && persistMeta3d.cardCallId && !result.xdt_anchor_card_id) {
        result.xdt_anchor_card_id = persistMeta3d.cardCallId;
      }
      delete result._xdt_model_files;
      result.guidance = '3D 模型生成完成!已生成 ' + modelFiles.length + ' 个文件并自动存入本机媒体库。' +
        '预览已画进上方卡片,用户点击预览图即可旋转查看 3D 模型。不要再调用 download_file 重复下载,' +
        '不要用 markdown 嵌图,也不要展示 cindy-media:// 技术地址。';
    } else {
      result.guidance = '3D 模型生成完成!已生成 ' + modelFiles.length + ' 个文件并自动存入本机媒体库。' + previewNote +
        '用户点击预览图即可旋转查看 3D 模型。不要再调用 download_file 重复下载,也不要展示 cindy-media:// 技术地址。';
    }
  } else {
    result.guidance = '3D 模型生成完成!已生成 ' + modelFiles.length + ' 个文件。' + previewNote +
      '用 download_file({ fileId }) 下载对应 fileId(见 modelFiles)。';
    await finishPersistCard(jobId, true); // 降级:✅ 卡收口,媒体走基座渲染
  }
  // 待转换任务(gen3d 记了非 GLB 目标):GLB 只是预览用中间产物——给每个产物
  // fileId 挂 download_file 守卫,并在 guidance 里接上转换指引。
  var pendingFmt = pendingConversion[jobId];
  if (pendingFmt) {
    modelFiles.forEach(function (fid) {
      conversionRequiredFiles[fid] = { taskId: jobId, format: pendingFmt };
    });
    result.guidance += '\n用户要求的目标格式是 ' + pendingFmt + ':上面的 GLB 仅是预览用中间产物,' +
      '请接着调用 convert_3d_model_format({ originalModelTaskId: "' + jobId + '", format: "' + pendingFmt + '" }) 完成转换' +
      '(非 GLB 产物落盘需主 agent 在 ghost_call 顶层传 save_dir),不要把 GLB 直接当最终交付。';
  }
  return result;
}

/* ── 工具 11:convert_3d_model_format(规格 §11,意识版:双路落地)────────
 * 转换本体是 mivo 服务端 REST(POST /file/export-model + GET tasks/{id}),
 * 产物按格式分流:GLB → as:'media' 入媒体总仓(可预览);FBX/OBJ_ZIP →
 * 总仓不收,走 as:'file' 凭主 agent 顶层 save_dir 过户的落盘票据
 * (args.save_deposit)直写用户目录——字节与绝对路径都不进沙箱。
 * 单窗轮询 105s 上限,没等到终态交回 exportTaskId 让 AI 带参续调。 */

var CONVERT_FORMATS = ['GLB', 'FBX', 'OBJ'];
var FBX_PRESETS = ['blender', '3dsmax', 'mixamo'];

async function convert3dModelFormat(args, callId) {
  var format = str(args.format).toUpperCase();
  if (CONVERT_FORMATS.indexOf(format) < 0) {
    throw toolError('INVALID_ARGS', '不支持的 format: ' + str(args.format) + '。支持: GLB, FBX, OBJ(OBJ 产物为 zip 压缩包);USD 请引导用户到 aigc.xindong.com 网页端导出');
  }
  var taskId = str(args.originalModelTaskId) || last3dTaskId || '';
  var exportTaskId = str(args.exportTaskId);
  if (!exportTaskId) {
    // 提交转换(带 exportTaskId 续调时跳过,已完成的转换不会重跑)。
    if (!taskId) throw toolError('MISSING_TASK_ID', '请提供 originalModelTaskId(submit_gen_3d_model 返回的 jobId);本会话没有可兜底的 3D 任务记录');
    var body = { originalModelTaskId: taskId, format: format };
    if (typeof args.texture_size === 'number' && isFinite(args.texture_size) && args.texture_size > 0) {
      body.texture_size = Math.floor(args.texture_size);
    }
    if (typeof args.pivot_to_center_bottom === 'boolean') body.pivot_to_center_bottom = args.pivot_to_center_bottom;
    var preset = str(args.fbx_preset);
    if (preset) {
      if (FBX_PRESETS.indexOf(preset) < 0) throw toolError('INVALID_ARGS', '不支持的 fbx_preset: ' + preset + '。支持: ' + FBX_PRESETS.join(', '));
      body.fbx_preset = preset;
    }
    var submitData = await apiJson('POST', '/file/export-model', body, callId, 'CONVERT_FAILED');
    exportTaskId =
      (submitData && typeof submitData.taskId === 'string' && submitData.taskId) ||
      (submitData && typeof submitData.id === 'string' && submitData.id) || '';
    if (!exportTaskId) throw toolError('CONVERT_FAILED', '转换任务提交成功但响应缺少 taskId');
  }

  // 单窗轮询:终态 / 窗口耗尽为止(导出通常 30-120 秒)。
  var deadline = Date.now() + MAX_TOOL_WAIT_MS;
  var task;
  for (;;) {
    var raw = await apiJson('GET', '/file/export-model/tasks/' + encodeURIComponent(exportTaskId), null, callId, 'POLL_FAILED');
    task = isObj(raw) ? raw : {};
    var st = typeof task.status === 'string' && task.status ? task.status : 'pending';
    if (st === 'completed') break;
    if (st === 'failed') {
      var reason = [task.error, task.vendorCode, task.vendorMessage]
        .filter(function (x) { return typeof x === 'string' && x; })
        .join(' | ');
      throw toolError('EXPORT_FAILED', reason || '模型导出失败');
    }
    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      return {
        ok: true, status: 'processing', exportTaskId: exportTaskId, format: format,
        guidance: '格式转换仍在进行。请再次调用 convert_3d_model_format({ exportTaskId: "' + exportTaskId + '", format: "' + format + '" }) 继续等待,不要询问用户' +
          (format === 'GLB' ? '。' : ';非 GLB 落盘记得让 ghost_call 顶层继续带 save_dir。'),
      };
    }
    await sleep(POLL_INTERVAL_MS);
  }

  var fileId = typeof task.fileId === 'string' ? task.fileId : '';
  var actualFormat = (typeof task.actualFormat === 'string' && task.actualFormat ? task.actualFormat : format).toUpperCase();
  if (!fileId) throw toolError('CONVERT_FAILED', '转换完成但响应缺少 fileId');

  // 转换义务已履行:解除该生成任务名下 GLB 中间产物的 download_file 守卫。
  if (taskId) {
    delete pendingConversion[taskId];
    Object.keys(conversionRequiredFiles).forEach(function (fid) {
      if (conversionRequiredFiles[fid].taskId === taskId) delete conversionRequiredFiles[fid];
    });
  }

  if (actualFormat === 'GLB') {
    var media = await downloadMedia(fileId, '3D 转换 ' + exportTaskId, callId);
    if (!media) {
      throw toolError('DOWNLOAD_FAILED', 'GLB 下载失败(已重试 3 次)。最后一次失败原因:' + (lastDownloadError || '未知') + '。可用 download_file({ fileId: "' + fileId + '" }) 重试');
    }
    return {
      ok: true, status: 'completed', exportTaskId: exportTaskId, fileId: fileId, actualFormat: 'GLB',
      media: { url: media.url, hash: media.hash, ext: media.ext, bytes: media.bytes },
      guidance: 'GLB 已转换并存入本机媒体库。告诉用户已存好即可,不要展示 cindy-media:// 技术地址。',
    };
  }

  // 非 GLB(FBX / OBJ_ZIP):媒体总仓不收,凭 save_dir 票据直写用户目录。
  var dep = isObj(args.save_deposit) ? args.save_deposit : null;
  var token = dep && typeof dep.token === 'string' ? dep.token : '';
  if (!token) {
    throw toolError(
      'SAVE_DIR_REQUIRED',
      '转换已完成(' + actualFormat + '),但缺少落盘目录:请在 ghost_call 顶层传 save_dir(当前会话工作目录内的已存在目录),' +
        '并带 exportTaskId="' + exportTaskId + '" 与原 format 重新调用本工具——已完成的转换不会重跑,直接进入落盘。',
      { exportTaskId: exportTaskId, fileId: fileId, actualFormat: actualFormat },
    );
  }
  var isZip = actualFormat.indexOf('ZIP') >= 0;
  var ext = isZip ? '.zip' : '.' + actualFormat.toLowerCase();
  var filename = str(args.filename) || ('mivo-3d-' + fileId + ext);
  var r = null;
  // 媒体全局闸「正忙」退避重试,与 downloadMedia/uploadHashes 同款兜底。
  for (var att = 0; att < 4; att++) {
    r = await cindy.fetch({
      url: API + '/file/download/' + fileId,
      as: 'file',
      saveTo: { token: token, filename: filename },
      callId: callId,
    });
    if (r && !r.ok && String(r.message || '').indexOf('正忙') >= 0 && att < 3) {
      await sleep(DOWNLOAD_RETRY_DELAYS[att]);
      continue;
    }
    break;
  }
  if (!r || !r.ok) throw hostFetchError(r, 'DOWNLOAD_FAILED');
  if (r.status < 200 || r.status >= 300) {
    throw toolError('DOWNLOAD_FAILED', '转换产物下载失败: HTTP ' + r.status);
  }
  var f = isObj(r.file) ? r.file : {};
  var dirName = dep && typeof dep.dir_name === 'string' ? dep.dir_name : '';
  return {
    ok: true, status: 'completed', exportTaskId: exportTaskId, fileId: fileId, actualFormat: actualFormat,
    file: { file_name: f.file_name || filename, bytes: typeof f.bytes === 'number' ? f.bytes : 0, dir: dirName },
    guidance: actualFormat + ' 产物已写入用户交付的目录' + (dirName ? '(' + dirName + '/' + (f.file_name || filename) + ')' : '') +
      (isZip ? '。注意:产物是 zip 压缩包(内含 obj/mtl/贴图),提醒用户解压后使用。' : '。') +
      '把文件名与所在目录告诉用户即可。',
  };
}

/* ── 工具 12:animate_3d_model(规格 §12)────────────────────────────── */

async function animate3dModel(args, callId) {
  var animation = str(args.animation);
  if (!/^preset:[a-z0-9_]+(?::[a-z0-9_]+)*$/i.test(animation)) {
    throw toolError('INVALID_ARGS', 'animation 必须是 preset: 开头的预设 id(如 preset:biped:walk),收到: ' + (animation || '(空)'));
  }
  var fileId = str(args.fileId);
  if (fileId) {
    if (!HEX24_RE.test(fileId)) throw toolError('INVALID_ARGS', 'fileId 必须是 24 位 ObjectId,收到: ' + fileId);
  } else {
    // 兜底:取会话态最近一次 3D 任务的首个产物(§12.2)。
    if (!last3dTaskId) {
      throw toolError('INVALID_ARGS', '未提供 fileId 且本会话没有可用的 3D 任务记录。请先生成模型或显式传 fileId');
    }
    var norm = await pollOnce(last3dTaskId, callId);
    var files = Array.isArray(norm.content.model_files) ? norm.content.model_files : [];
    var first = typeof files[0] === 'string' ? files[0] : '';
    if (!HEX24_RE.test(first)) {
      throw toolError('INVALID_ARGS', '最近一次 3D 任务(' + last3dTaskId + ')还没有可用的模型文件。请先 poll_3d_result 确认生成完成,或显式传 fileId');
    }
    fileId = first;
  }
  var modelVersion = str(args.modelVersion) || 'V3.0';
  var actionSeg = animation.split(':').pop();
  var jobId = await createMessage({
    chatType: 'model3d', messageType: 'model3d', modelType: 'TRIPO3D',
    modelVersion: modelVersion, action: 'animate_rig',
    payload: { model_files: [fileId], animation: animation },
    title: '作3D-动作绑定-' + actionSeg,
  }, callId);
  last3dTaskId = jobId;
  registerPersistCard(jobId, callId, 'model', '动作绑定 ' + actionSeg); // 常驻过程卡
  return {
    ok: true, jobId: jobId, fileId: fileId, animation: animation,
    guidance: '动作绑定任务已提交,jobId=' + jobId + ',动作=' + animation +
      '\n\n请调用 poll_3d_result({ jobId: "' + jobId + '" }) 查询。完成后绑定好动作的模型会自动存入本机媒体库。',
  };
}

/* ── 工具 13:download_file(规格 §13,意识版:下载进媒体库)──────────── */

async function downloadFile(args, callId) {
  var fileId = str(args.fileId);
  if (fileId.length !== 24) throw toolError('INVALID_ARGS', 'fileId 必须是 24 位的 MongoDB ObjectId');
  // 3D 转换守卫:用户要的是非 GLB 格式时,GLB 中间产物不许当最终交付下载。
  var conv = conversionRequiredFiles[fileId];
  if (conv) {
    throw toolError(
      'CONVERSION_REQUIRED',
      '该 fileId 是 GLB 中间产物,用户要求的目标格式是 ' + conv.format +
        ':请先调用 convert_3d_model_format({ originalModelTaskId: "' + conv.taskId + '", format: "' + conv.format + '" }) 拿转换产物' +
        '(非 GLB 落盘需主 agent 在 ghost_call 顶层传 save_dir)。',
    );
  }
  var label = str(args.filename) || ('mivo 文件 ' + fileId);
  var media = await downloadMedia(fileId, label, callId);
  if (!media) throw toolError('DOWNLOAD_FAILED', '下载失败(已重试 3 次)。最后一次失败原因:' + (lastDownloadError || '未知'));
  var result = { ok: true, fileId: fileId, media: { url: media.url, hash: media.hash, ext: media.ext, bytes: media.bytes } };
  if (str(args.filename)) result.filename = str(args.filename);
  if (IMAGE_EXTS.indexOf(media.ext) >= 0) {
    result.xdt_image_urls = [media.url];
    result.guidance = '文件已下载并渲染在消息流中,同时已存入本机媒体库。不要再用 markdown 嵌入同一张图。';
  } else if (VIDEO_EXTS.indexOf(media.ext) >= 0) {
    result.xdt_video_urls = [media.url];
    result.guidance = '视频已下载并渲染在消息流中,同时已存入本机媒体库。不要再用 markdown 嵌一遍。';
  } else {
    result.guidance = '文件已下载进本机媒体库(' + media.ext + ',' + media.bytes + ' 字节)。告诉用户文件已存入媒体库即可,不要展示 cindy-media:// 技术地址。';
  }
  return result;
}

/* ── 总分发(管子协议:tool-call 收活 → tool-result 交卷)─────────────── */

var HANDLERS = {
  submit_gen_image: submitGenImage,
  poll_result: pollResult,
  segment_image: segmentImage,
  super_resolution_image: superResolutionImage,
  mivo_button_action: mivoButtonAction,
  submit_gen_video: submitGenVideo,
  submit_gen_music: submitGenMusic,
  submit_gen_sound_effect: submitGenSoundEffect,
  submit_gen_3d_model: submitGen3dModel,
  poll_3d_result: poll3dResult,
  convert_3d_model_format: convert3dModelFormat,
  animate_3d_model: animate3dModel,
  download_file: downloadFile,
};

cindy.onHostMessage(async function (msg) {
  // 交互卡按钮点击(卡片交互 v2):不是工具调用,单独分支,fire-and-forget。
  if (msg && msg.type === 'event' && msg.name === 'card-action') {
    await handleCardAction(msg);
    return;
  }
  if (!msg || msg.type !== 'tool-call') return;
  var handler = HANDLERS[msg.tool];
  if (!handler) {
    cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: false,
      message: JSON.stringify({ ok: false, errorCode: 'UNKNOWN_TOOL', message: '未知工具:' + msg.tool }),
    });
    return;
  }
  try {
    var args = isObj(msg.args) ? msg.args : {};
    var r = await handler(args, msg.callId);
    cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: r });
  } catch (err) {
    // 结构化错误(toolError)整体 JSON 交卷:errorCode/hint 一并给 AI 走分支;
    // 意外异常收敛为 INTERNAL。
    var payload = err && err.ghost
      ? err.ghost
      : { ok: false, errorCode: 'INTERNAL', message: '执行失败:' + (err && err.message ? err.message : String(err)) };
    cindy.send({ type: 'tool-result', callId: msg.callId, ok: false, message: JSON.stringify(payload) });
  }
});
