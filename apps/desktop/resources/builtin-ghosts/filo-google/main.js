/**
 * Filo Google · 电子脑 —— 内置的 Google 服务意识(network 槽 + oauth 凭证)。
 *
 * 工作方式:
 * - 域名白名单代发:cindy.fetch 只能到 ghost.json 声明的 Google 域名,请求由
 *   主机代发,沙箱零直连;
 * - 主机托管 OAuth:授权流程 / refresh token / access token 全在主机——本文件
 *   没有也不可能有任何令牌字节,每次请求主机现取新鲜 access token 注入
 *   Authorization,401 自动重刷重试(平台结构保证,见 FORGE_GUIDE §4.7);
 * - 多账号:工具的 account 参数原样透传 cindy.fetch 的 authAccount,省略 =
 *   默认账号;账号清单经同源 /oauth 状态端点回查(零令牌字节)。
 *
 * 工具面 = 二级分派:5 个类目工具(accounts / gmail / calendar / drive / sheets),
 * 类目内 action 细分——与老 lizi_google MCP 的 list_tools/call_tool 同构,
 * 但全部逻辑住在本包里,改工具只更新意识、不发应用版本。
 */

/* global cindy */

var GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
var CAL_BASE = 'https://www.googleapis.com/calendar/v3';
var DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
var SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/* ── 基础工具 ───────────────────────────────────────────────────────── */

function fail(message) {
  return { ok: false, message: message };
}

function clampInt(n, def, max) {
  var v = typeof n === 'number' && isFinite(n) ? Math.floor(n) : def;
  return Math.min(max, Math.max(1, v));
}

/** 统一的 Google API 调用:凭证由主机注入,这里只管 URL/方法/体/账号。 */
async function api(opts) {
  var req = {
    url: opts.url,
    method: opts.method || 'GET',
    headers: { Accept: 'application/json' },
    callId: opts.callId,
  };
  if (opts.body !== undefined) {
    req.headers['Content-Type'] = 'application/json';
    req.body = JSON.stringify(opts.body);
  }
  if (opts.rawBody !== undefined) {
    req.headers['Content-Type'] = opts.contentType || 'text/plain';
    req.body = opts.rawBody;
  }
  if (opts.account) req.authAccount = opts.account;
  var r = await cindy.fetch(req);
  if (!r.ok) return { err: r.message };
  if (r.status === 204) return { data: null };
  var data = null;
  if (r.body) {
    try { data = JSON.parse(r.body); } catch (e) { return { err: 'Google 返回了无法解析的响应(HTTP ' + r.status + ')' }; }
  }
  if (r.status < 200 || r.status >= 300) {
    var apiMsg = data && data.error && data.error.message ? data.error.message : (r.body || '').slice(0, 200);
    return { err: 'Google API 返回 HTTP ' + r.status + ':' + apiMsg };
  }
  return { data: data };
}

/** UTF-8 → base64url(Gmail send 的 raw 载荷)。 */
function b64urlUtf8(text) {
  var bytes = new TextEncoder().encode(text);
  var bin = '';
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url → UTF-8 文本(Gmail 正文解码)。 */
function utf8FromB64url(b64url) {
  var b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/** RFC 2047 编码非 ASCII 主题(直接塞会乱码)。 */
function encodeHeaderWord(text) {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return '=?UTF-8?B?' + b64urlUtf8(text).replace(/-/g, '+').replace(/_/g, '/') + '?=';
}

/* ── accounts ──────────────────────────────────────────────────────── */

async function toolAccounts() {
  var r = await fetch('/oauth');
  if (!r.ok) return fail('账号状态查询失败(' + r.status + ')');
  var list = await r.json();
  var entry = null;
  for (var i = 0; i < list.length; i++) if (list[i].key === 'google_account') entry = list[i];
  if (!entry) return fail('OAuth 凭证槽缺失,请插件作者检查声明');
  if (!entry.clientConfigured) {
    return fail('内置应用身份缺失——请用户升级 Cindy 后到主界面侧边栏「插件」→「Filo Google」详情页重新连接账号');
  }
  if (!entry.accounts.length) {
    return fail('还没连接任何 Google 账号——请用户到主界面侧边栏「插件」→「Filo Google」详情页点「连接账号」完成授权');
  }
  return {
    ok: true,
    result: {
      accounts: entry.accounts.map(function (a) {
        return { id: a.id, email: a.label, status: a.status, is_default: a.isDefault };
      }),
    },
  };
}

/* ── gmail ─────────────────────────────────────────────────────────── */

/** 从 message 元数据 headers 里取一条(不区分大小写)。 */
function header(msg, name) {
  var hs = (msg.payload && msg.payload.headers) || [];
  for (var i = 0; i < hs.length; i++) {
    if (hs[i].name.toLowerCase() === name.toLowerCase()) return hs[i].value;
  }
  return '';
}

/** 深度优先找第一段 text/plain(没有再退 text/html)正文。 */
function extractBody(payload) {
  if (!payload) return '';
  var queue = [payload];
  var htmlFallback = '';
  while (queue.length) {
    var part = queue.shift();
    if (part.mimeType === 'text/plain' && part.body && part.body.data) {
      return utf8FromB64url(part.body.data);
    }
    if (part.mimeType === 'text/html' && part.body && part.body.data && !htmlFallback) {
      htmlFallback = utf8FromB64url(part.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    if (part.parts) for (var i = 0; i < part.parts.length; i++) queue.push(part.parts[i]);
  }
  return htmlFallback;
}

async function toolGmail(args, callId) {
  var account = args.account;
  if (args.action === 'search') {
    if (!args.query) return fail('search 需要 query(Gmail 搜索语法)');
    var n = clampInt(args.max_results, 5, 10);
    var listed = await api({
      url: GMAIL_BASE + '/messages?q=' + encodeURIComponent(args.query) + '&maxResults=' + n,
      account: account, callId: callId,
    });
    if (listed.err) return fail(listed.err);
    var ids = (listed.data && listed.data.messages) || [];
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var m = await api({
        url: GMAIL_BASE + '/messages/' + ids[i].id + '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date',
        account: account, callId: callId,
      });
      if (m.err) return fail(m.err);
      out.push({
        id: ids[i].id,
        from: header(m.data, 'From'),
        subject: header(m.data, 'Subject'),
        date: header(m.data, 'Date'),
        snippet: m.data.snippet || '',
      });
    }
    return { ok: true, result: { total_estimate: listed.data.resultSizeEstimate || out.length, messages: out } };
  }
  if (args.action === 'read') {
    if (!args.message_id) return fail('read 需要 message_id');
    var full = await api({ url: GMAIL_BASE + '/messages/' + encodeURIComponent(args.message_id) + '?format=full', account: account, callId: callId });
    if (full.err) return fail(full.err);
    var text = extractBody(full.data.payload);
    return {
      ok: true,
      result: {
        id: full.data.id,
        from: header(full.data, 'From'),
        to: header(full.data, 'To'),
        subject: header(full.data, 'Subject'),
        date: header(full.data, 'Date'),
        // 正文钳制:超长邮件截断(交卷体量护栏),提醒模型别再要更多。
        body: text.length > 20000 ? text.slice(0, 20000) + '\n…(正文过长已截断)' : text,
      },
    };
  }
  if (args.action === 'list_labels') {
    var labels = await api({ url: GMAIL_BASE + '/labels', account: account, callId: callId });
    if (labels.err) return fail(labels.err);
    return {
      ok: true,
      result: {
        labels: ((labels.data && labels.data.labels) || []).map(function (l) {
          return { id: l.id, name: l.name, type: l.type };
        }),
      },
    };
  }
  if (args.action === 'modify_labels') {
    if (!args.message_id) return fail('modify_labels 需要 message_id');
    var add = Array.isArray(args.add_label_ids) ? args.add_label_ids : [];
    var remove = Array.isArray(args.remove_label_ids) ? args.remove_label_ids : [];
    if (add.length === 0 && remove.length === 0) return fail('modify_labels 需要 add_label_ids / remove_label_ids 至少一个');
    var modified = await api({
      url: GMAIL_BASE + '/messages/' + encodeURIComponent(args.message_id) + '/modify',
      method: 'POST',
      body: { addLabelIds: add, removeLabelIds: remove },
      account: account, callId: callId,
    });
    if (modified.err) return fail(modified.err);
    return { ok: true, result: { modified: true, label_ids: modified.data.labelIds || [] } };
  }
  if (args.action === 'send' || args.action === 'draft') {
    if (!args.to || !args.subject || args.body_text === undefined) {
      return fail(args.action + ' 需要 to / subject / body_text');
    }
    var mime =
      'To: ' + args.to + '\r\n' +
      'Subject: ' + encodeHeaderWord(args.subject) + '\r\n' +
      'Content-Type: text/plain; charset=UTF-8\r\n' +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      b64urlUtf8(args.body_text).replace(/-/g, '+').replace(/_/g, '/');
    var raw = b64urlUtf8(mime);
    if (args.action === 'send') {
      var sent = await api({ url: GMAIL_BASE + '/messages/send', method: 'POST', body: { raw: raw }, account: account, callId: callId });
      if (sent.err) return fail(sent.err);
      return { ok: true, result: { sent: true, id: sent.data.id, note: '邮件已发送' } };
    }
    var draft = await api({ url: GMAIL_BASE + '/drafts', method: 'POST', body: { message: { raw: raw } }, account: account, callId: callId });
    if (draft.err) return fail(draft.err);
    return { ok: true, result: { draft: true, id: draft.data.id, note: '草稿已保存(未发送)' } };
  }
  return fail('未知 action:' + args.action);
}

/* ── calendar ──────────────────────────────────────────────────────── */

/** ISO 日期串 → Calendar API 的 start/end 形态(纯日期 = 全天事件)。 */
function calTime(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? { date: s } : { dateTime: s };
}

function calEventView(ev) {
  return {
    id: ev.id,
    summary: ev.summary || '',
    start: (ev.start && (ev.start.dateTime || ev.start.date)) || '',
    end: (ev.end && (ev.end.dateTime || ev.end.date)) || '',
    status: ev.status,
    link: ev.htmlLink || '',
    attendees: (ev.attendees || []).map(function (a) { return a.email; }),
  };
}

async function toolCalendar(args, callId) {
  var account = args.account;
  var calId = encodeURIComponent(args.calendar_id || 'primary');
  if (args.action === 'list_calendars') {
    var cals = await api({ url: CAL_BASE + '/users/me/calendarList', account: account, callId: callId });
    if (cals.err) return fail(cals.err);
    return {
      ok: true,
      result: {
        calendars: (cals.data.items || []).map(function (c) {
          return { id: c.id, summary: c.summary, primary: Boolean(c.primary) };
        }),
      },
    };
  }
  if (args.action === 'list_events') {
    var qs = '?singleEvents=true&orderBy=startTime&maxResults=' + clampInt(args.max_results, 10, 25);
    if (args.time_min) qs += '&timeMin=' + encodeURIComponent(args.time_min);
    if (args.time_max) qs += '&timeMax=' + encodeURIComponent(args.time_max);
    var evs = await api({ url: CAL_BASE + '/calendars/' + calId + '/events' + qs, account: account, callId: callId });
    if (evs.err) return fail(evs.err);
    return { ok: true, result: { events: (evs.data.items || []).map(calEventView) } };
  }
  if (args.action === 'get_event') {
    if (!args.event_id) return fail('get_event 需要 event_id');
    var got = await api({
      url: CAL_BASE + '/calendars/' + calId + '/events/' + encodeURIComponent(args.event_id),
      account: account, callId: callId,
    });
    if (got.err) return fail(got.err);
    return { ok: true, result: { event: calEventView(got.data) } };
  }
  if (args.action === 'create_event') {
    if (!args.summary || !args.start || !args.end) return fail('create_event 需要 summary / start / end');
    var body = { summary: args.summary, start: calTime(args.start), end: calTime(args.end) };
    if (args.description) body.description = args.description;
    if (args.attendees) body.attendees = args.attendees.map(function (e) { return { email: e }; });
    var created = await api({ url: CAL_BASE + '/calendars/' + calId + '/events', method: 'POST', body: body, account: account, callId: callId });
    if (created.err) return fail(created.err);
    return { ok: true, result: { created: true, event: calEventView(created.data) } };
  }
  if (args.action === 'update_event') {
    if (!args.event_id) return fail('update_event 需要 event_id');
    var patch = {};
    if (args.summary !== undefined) patch.summary = args.summary;
    if (args.description !== undefined) patch.description = args.description;
    if (args.start !== undefined) patch.start = calTime(args.start);
    if (args.end !== undefined) patch.end = calTime(args.end);
    if (args.attendees !== undefined) patch.attendees = args.attendees.map(function (e) { return { email: e }; });
    var updated = await api({
      url: CAL_BASE + '/calendars/' + calId + '/events/' + encodeURIComponent(args.event_id),
      method: 'PATCH', body: patch, account: account, callId: callId,
    });
    if (updated.err) return fail(updated.err);
    return { ok: true, result: { updated: true, event: calEventView(updated.data) } };
  }
  if (args.action === 'delete_event') {
    if (!args.event_id) return fail('delete_event 需要 event_id');
    var del = await api({
      url: CAL_BASE + '/calendars/' + calId + '/events/' + encodeURIComponent(args.event_id),
      method: 'DELETE', account: account, callId: callId,
    });
    if (del.err) return fail(del.err);
    return { ok: true, result: { deleted: true } };
  }
  return fail('未知 action:' + args.action);
}

/* ── drive ─────────────────────────────────────────────────────────── */

var DRIVE_FIELDS = 'id,name,mimeType,modifiedTime,size,webViewLink,owners(emailAddress)';

function driveFileView(f) {
  return {
    id: f.id, name: f.name, mime_type: f.mimeType, modified: f.modifiedTime,
    size: f.size || null, link: f.webViewLink || '',
    owner: f.owners && f.owners[0] ? f.owners[0].emailAddress : null,
  };
}

/** Google 原生文件的缺省导出 MIME(镜像老 driveClient 的 DEFAULT_EXPORT_MIME)。 */
var DRIVE_EXPORT_MIME = {
  'application/vnd.google-apps.document': 'text/markdown',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

async function driveMeta(fileId, account, callId) {
  return api({
    url: DRIVE_BASE + '/files/' + encodeURIComponent(fileId) + '?fields=' + encodeURIComponent(DRIVE_FIELDS + ',parents'),
    account: account, callId: callId,
  });
}

async function toolDrive(args, callId) {
  if (args.action === 'list_folder') {
    var folder = (args.folder_id || 'root').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    var inFolder = await api({
      url: DRIVE_BASE + '/files?q=' + encodeURIComponent("'" + folder + "' in parents and trashed=false") +
        '&pageSize=' + clampInt(args.max_results, 25, 50) +
        '&fields=' + encodeURIComponent('files(' + DRIVE_FIELDS + ')'),
      account: args.account, callId: callId,
    });
    if (inFolder.err) return fail(inFolder.err);
    return { ok: true, result: { files: (inFolder.data.files || []).map(driveFileView) } };
  }
  if (args.action === 'read') {
    if (!args.file_id) return fail('read 需要 file_id');
    var meta = await driveMeta(args.file_id, args.account, callId);
    if (meta.err) return fail(meta.err);
    var mime = meta.data.mimeType || '';
    var isNative = mime.indexOf('application/vnd.google-apps') === 0;
    var contentUrl;
    if (isNative) {
      var exportMime = args.export_mime || DRIVE_EXPORT_MIME[mime];
      if (!exportMime) {
        return { ok: true, result: { file: driveFileView(meta.data), note: '该 Google 原生类型不支持文本导出,把链接给用户打开即可' } };
      }
      contentUrl = DRIVE_BASE + '/files/' + encodeURIComponent(args.file_id) + '/export?mimeType=' + encodeURIComponent(exportMime);
    } else {
      contentUrl = DRIVE_BASE + '/files/' + encodeURIComponent(args.file_id) + '?alt=media';
    }
    // 文本直读(主机侧 ≤50MB 截断护栏,2026-07-21 放宽);二进制响应主机会拒文本形态,提示改走 download。
    var r = await cindy.fetch({ url: contentUrl, headers: { Accept: '*/*' }, callId: callId, authAccount: args.account || undefined });
    if (!r.ok) {
      return { ok: true, result: { file: driveFileView(meta.data), note: '内容不是文本(' + r.message + ');要拿文件本体请用 action=download' } };
    }
    if (r.status < 200 || r.status >= 300) return fail('Google API 返回 HTTP ' + r.status + ':' + (r.body || '').slice(0, 200));
    return { ok: true, result: { file: driveFileView(meta.data), content: r.body, truncated: Boolean(r.truncated) } };
  }
  if (args.action === 'download') {
    if (!args.file_id) return fail('download 需要 file_id');
    if (!args.save_deposit || !args.save_deposit.token) {
      return fail('download 需要落盘目录——请主 agent 调 ghost_call 时把目标目录绝对路径放在顶层 save_dir 参数');
    }
    var dMeta = await driveMeta(args.file_id, args.account, callId);
    if (dMeta.err) return fail(dMeta.err);
    var dMime = dMeta.data.mimeType || '';
    var dUrl = dMime.indexOf('application/vnd.google-apps') === 0
      ? DRIVE_BASE + '/files/' + encodeURIComponent(args.file_id) + '/export?mimeType=' + encodeURIComponent(args.export_mime || DRIVE_EXPORT_MIME[dMime] || 'application/pdf')
      : DRIVE_BASE + '/files/' + encodeURIComponent(args.file_id) + '?alt=media';
    var saved = await cindy.fetch({
      url: dUrl,
      as: 'file',
      saveTo: { token: args.save_deposit.token, filename: args.filename || dMeta.data.name || undefined },
      callId: callId,
      authAccount: args.account || undefined,
    });
    if (!saved.ok) return fail(saved.message);
    if (!saved.file) return fail('下载失败(HTTP ' + saved.status + '):' + ((saved.body || '').slice(0, 200) || '未知原因'));
    return {
      ok: true,
      result: {
        downloaded: true,
        dir_name: args.save_deposit.dir_name,
        file_name: saved.file.file_name,
        bytes: saved.file.bytes,
        note: '已存到 ' + args.save_deposit.dir_name + '/' + saved.file.file_name,
      },
    };
  }
  if (args.action === 'upload') {
    if (!args.name || args.content === undefined) return fail('upload 需要 name / content');
    if (String(args.content).length > 200 * 1024) return fail('upload 内容超过 200KB 上限,大文件请用户手动上传');
    var boundary = 'xdt-ghost-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    var metaPart = { name: args.name, mimeType: args.mime_type || 'text/plain' };
    if (args.parent_folder_id) metaPart.parents = [args.parent_folder_id];
    var relBody =
      '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metaPart) + '\r\n' +
      '--' + boundary + '\r\nContent-Type: ' + (args.mime_type || 'text/plain') + '; charset=UTF-8\r\n\r\n' +
      args.content + '\r\n--' + boundary + '--';
    var uploaded = await api({
      url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=' + encodeURIComponent(DRIVE_FIELDS),
      method: 'POST',
      rawBody: relBody,
      contentType: 'multipart/related; boundary=' + boundary,
      account: args.account, callId: callId,
    });
    if (uploaded.err) return fail(uploaded.err);
    return { ok: true, result: { uploaded: true, file: driveFileView(uploaded.data) } };
  }
  if (args.action === 'move') {
    if (!args.file_id) return fail('move 需要 file_id');
    if (!args.new_parent_id && !args.new_name) return fail('move 需要 new_parent_id / new_name 至少一个');
    var qs = '';
    if (args.new_parent_id) {
      var cur = await driveMeta(args.file_id, args.account, callId);
      if (cur.err) return fail(cur.err);
      qs = '?addParents=' + encodeURIComponent(args.new_parent_id) +
        '&removeParents=' + encodeURIComponent((cur.data.parents || []).join(','));
    }
    var moved = await api({
      url: DRIVE_BASE + '/files/' + encodeURIComponent(args.file_id) + qs,
      method: 'PATCH',
      body: args.new_name ? { name: args.new_name } : {},
      account: args.account, callId: callId,
    });
    if (moved.err) return fail(moved.err);
    return { ok: true, result: { moved: true } };
  }
  if (args.action === 'delete') {
    if (!args.file_id) return fail('delete 需要 file_id');
    if (args.permanent === true) {
      var gone = await api({
        url: DRIVE_BASE + '/files/' + encodeURIComponent(args.file_id),
        method: 'DELETE', account: args.account, callId: callId,
      });
      if (gone.err) return fail(gone.err);
      return { ok: true, result: { deleted: true, permanent: true } };
    }
    var trashed = await api({
      url: DRIVE_BASE + '/files/' + encodeURIComponent(args.file_id),
      method: 'PATCH', body: { trashed: true }, account: args.account, callId: callId,
    });
    if (trashed.err) return fail(trashed.err);
    return { ok: true, result: { deleted: true, permanent: false, note: '已移入回收站,可在 Drive 网页端恢复' } };
  }
  if (args.action === 'search') {
    if (!args.query) return fail('search 需要 query');
    // 普通关键词自动包成 name contains;带 Drive 查询语法(= / contains)的原样用。
    var q = /contains|=/.test(args.query)
      ? args.query
      : "name contains '" + args.query.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    var listed = await api({
      url: DRIVE_BASE + '/files?q=' + encodeURIComponent(q + ' and trashed=false') +
        '&pageSize=' + clampInt(args.max_results, 10, 25) +
        '&fields=' + encodeURIComponent('files(' + DRIVE_FIELDS + ')'),
      account: args.account, callId: callId,
    });
    if (listed.err) return fail(listed.err);
    return { ok: true, result: { files: (listed.data.files || []).map(driveFileView) } };
  }
  if (args.action === 'get_meta') {
    if (!args.file_id) return fail('get_meta 需要 file_id');
    var meta = await api({
      url: DRIVE_BASE + '/files/' + encodeURIComponent(args.file_id) + '?fields=' + encodeURIComponent(DRIVE_FIELDS),
      account: args.account, callId: callId,
    });
    if (meta.err) return fail(meta.err);
    return { ok: true, result: { file: driveFileView(meta.data) } };
  }
  return fail('未知 action:' + args.action);
}

/* ── sheets ────────────────────────────────────────────────────────── */

/** 支持直接粘表格链接:/spreadsheets/d/<id>/ 里抽 id。 */
function sheetId(input) {
  var m = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(input || '');
  return m ? m[1] : (input || '').trim();
}

async function toolSheets(args, callId) {
  var id = sheetId(args.spreadsheet_id);
  if (!id) return fail('需要 spreadsheet_id(表格 id 或完整链接)');
  if (args.action === 'list_sheets') {
    var meta = await api({
      url: SHEETS_BASE + '/' + encodeURIComponent(id) + '?fields=' + encodeURIComponent('properties.title,sheets.properties(sheetId,title,gridProperties)'),
      account: args.account, callId: callId,
    });
    if (meta.err) return fail(meta.err);
    return {
      ok: true,
      result: {
        title: meta.data.properties ? meta.data.properties.title : '',
        sheets: (meta.data.sheets || []).map(function (s) {
          var p = s.properties || {};
          return {
            title: p.title,
            rows: p.gridProperties ? p.gridProperties.rowCount : null,
            cols: p.gridProperties ? p.gridProperties.columnCount : null,
          };
        }),
      },
    };
  }
  if (args.action === 'read_range') {
    if (!args.range) return fail('read_range 需要 range(A1 记法)');
    var read = await api({
      url: SHEETS_BASE + '/' + encodeURIComponent(id) + '/values/' + encodeURIComponent(args.range),
      account: args.account, callId: callId,
    });
    if (read.err) return fail(read.err);
    return { ok: true, result: { range: read.data.range, values: read.data.values || [] } };
  }
  if (args.action === 'write_range') {
    if (!args.range) return fail('write_range 需要 range(A1 记法)');
    if (!Array.isArray(args.values)) return fail('write_range 需要 values(二维数组)');
    var written = await api({
      url: SHEETS_BASE + '/' + encodeURIComponent(id) + '/values/' + encodeURIComponent(args.range) + '?valueInputOption=USER_ENTERED',
      method: 'PUT',
      body: { range: args.range, majorDimension: 'ROWS', values: args.values },
      account: args.account, callId: callId,
    });
    if (written.err) return fail(written.err);
    return {
      ok: true,
      result: {
        updated_range: written.data.updatedRange,
        updated_cells: written.data.updatedCells,
        note: '已写入 ' + (written.data.updatedCells || 0) + ' 个单元格',
      },
    };
  }
  return fail('未知 action:' + args.action);
}

/* ── 派单 ──────────────────────────────────────────────────────────── */

var TOOLS = {
  google_accounts: function () { return toolAccounts(); },
  gmail: toolGmail,
  google_calendar: toolCalendar,
  google_drive: toolDrive,
  google_sheets: toolSheets,
};

cindy.onHostMessage(async function (msg) {
  if (!msg || msg.type !== 'tool-call') return;
  var handler = TOOLS[msg.tool];
  if (!handler) {
    cindy.send({ type: 'tool-result', callId: msg.callId, ok: false, message: '未知工具:' + msg.tool });
    return;
  }
  try {
    var r = await handler(msg.args || {}, msg.callId);
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
      message: 'Google 工具执行失败:' + (err && err.message ? err.message : String(err)),
    });
  }
});
