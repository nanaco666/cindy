/**
 * XD Atlassian · 电子脑 —— 内置的 Atlassian(Jira + Confluence)服务意识。
 *
 * 工作方式:
 * - 域名白名单代发:cindy.fetch 只能到 ghost.json 声明的 Atlassian 域名,请求
 *   由主机代发,沙箱零直连;
 * - 主机托管 OAuth(broker 模式):授权回调钉死 127.0.0.1:53682,code 换 token
 *   与 refresh 经 XDMaker 服务端 broker 完成(client secret 在服务端)——本文件
 *   没有也不可能有任何令牌字节,主机出网时现取新鲜 access token 注入
 *   Authorization,401 自动重刷重试(平台结构保证,见 FORGE_GUIDE §4.7);
 * - 多账号:工具的 account 参数原样透传 cindy.fetch 的 authAccount;
 * - 站点(cloudId):Atlassian 一份授权可访问多个站点,API 走
 *   /ex/jira|confluence/<cloudId>/... 形态。默认站点 = accessible-resources 里
 *   第一个 Jira 站点,按账号缓存在 /kv,工具可用 cloud_id 参数覆盖。
 *
 * 工具面 = 二级分派:10 个类目工具覆盖老 lizi_jira(12 op)+ lizi_confluence
 * (17 op)的全部操作——与 filo-google 同构,读取方向把 Atlassian 原生 JSON
 * (含 ADF / storage-XHTML 正文)原样交给模型,写入方向提供 text→ADF /
 * text→storage 的最简转换。改工具只更新意识、不发应用版本。
 */

/* global cindy */

var API_BASE = 'https://api.atlassian.com';
/**
 * 交卷体量护栏:超过即经 fs 槽落盘工作目录只交路径(deliver 内),写盘不可用
 * 时才回落截断——沿袭老 MCP out_file 的泄洪语义(2026-07-14 fs 槽上线后回归)。
 * 2026-07-17 Lizi 要求放宽到 50M:上游 cindy.fetch 有 1MB 响应截断在前,
 * 该阈值实际不再触发自动落盘(结果一律内联交卷),点名 out_file 落盘仍可用。
 */
var RESULT_MAX_CHARS = 50 * 1000 * 1000;
var IMAGE_MIME = { 'image/png': 1, 'image/jpeg': 1, 'image/jpg': 1, 'image/gif': 1, 'image/webp': 1 };

/* ── 基础工具 ───────────────────────────────────────────────────────── */

function fail(message) {
  return { ok: false, message: message };
}

function clampInt(n, def, max) {
  var v = typeof n === 'number' && isFinite(n) ? Math.floor(n) : def;
  return Math.min(max, Math.max(1, v));
}

/** text → Jira ADF 文档(镜像老 adf.ts:每行一段)。 */
function adfFromText(text) {
  var lines = String(text).split(/\r?\n/);
  return {
    type: 'doc',
    version: 1,
    content: lines.map(function (line) {
      return { type: 'paragraph', content: line.length > 0 ? [{ type: 'text', text: line }] : [] };
    }),
  };
}

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** text → Confluence storage(镜像老 storage.ts:每行一个 <p>)。 */
function storageFromText(text) {
  return String(text)
    .split(/\r?\n/)
    .map(function (line) {
      return line.length === 0 ? '<p></p>' : '<p>' + escapeXml(line) + '</p>';
    })
    .join('');
}

/** HTTP 状态 → 人话(镜像老 classify;401 到这里说明主机自动重刷也没救回来)。 */
function classifyStatus(status, bodySnippet) {
  if (status === 401) return 'Atlassian 授权已失效,请用户到主界面侧边栏「插件」→「XD Atlassian」详情页重新连接账号';
  if (status === 403) return '没有权限(HTTP 403):' + bodySnippet;
  if (status === 404) return '对象不存在或无访问权(HTTP 404)';
  if (status === 429) return 'Atlassian 接口限流(HTTP 429),请稍后重试';
  return 'Atlassian API 返回 HTTP ' + status + ':' + bodySnippet;
}

/**
 * 统一的 Atlassian API 调用(文本 JSON 形态)。凭证由主机注入,这里只管
 * URL / 方法 / 体 / 账号。成功 { data },失败 { err }。
 */
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
  if (opts.account) req.authAccount = opts.account;
  var r = await cindy.fetch(req);
  if (!r.ok) return { err: r.message };
  if (r.status === 204) return { data: null };
  var data = null;
  if (r.body) {
    try {
      data = JSON.parse(r.body);
    } catch (e) {
      data = r.body;
    }
  }
  if (r.status < 200 || r.status >= 300) {
    var snippet = typeof r.body === 'string' ? r.body.slice(0, 300) : '';
    return { err: classifyStatus(r.status, snippet) };
  }
  return { data: data, truncated: Boolean(r.truncated) };
}

/**
 * 交卷:Atlassian 原生 JSON 原样透传;超长(或调用方点名 out_file)时经 fs 槽
 * 把完整 JSON 写进会话工作目录,只交回文件路径——老 MCP out_file 泄洪的等价
 * 回归(agent 拿相对路径自己读/交给脚本)。写盘跟随会话权限模式(免批模式
 * 静默、逐条模式主机会弹确认卡),被拒/失败/远程工作区时回落截断 + 分页提示。
 */
async function deliver(data, args, callId) {
  var text = JSON.stringify(data === undefined ? null : data);
  var outFile = args && typeof args.out_file === 'string' && args.out_file ? args.out_file : null;
  if (!outFile && text.length <= RESULT_MAX_CHARS) return { ok: true, result: { data: data } };
  var spillNote = null;
  if (callId) {
    var fileName = outFile || 'atlassian-result-' + String(callId).slice(0, 8) + '.json';
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
    // 点名 out_file 但写盘被拒/失败,体量本身不超:内联交卷并如实附注。
    return { ok: true, result: { data: data, note: spillNote } };
  }
  return {
    ok: true,
    result: {
      truncated: true,
      hint:
        (spillNote ? spillNote + ';' : '') +
        '响应过大已截断——缩小查询范围(fields / max_results / limit / body_format)或分页读取',
      preview: text.slice(0, RESULT_MAX_CHARS),
    },
  };
}

/* ── 站点(cloudId)解析 ─────────────────────────────────────────────── */

/** accessible-resources 内存缓存(按账号;沉睡即失,/kv 兜底跨生命周期)。 */
var siteCache = {};

async function fetchAccessibleResources(account, callId) {
  var r = await api({ url: API_BASE + '/oauth/token/accessible-resources', account: account, callId: callId });
  if (r.err) return { err: r.err };
  var list = Array.isArray(r.data) ? r.data : [];
  return {
    sites: list.map(function (s) {
      return { cloud_id: s.id, name: s.name, url: s.url, scopes: s.scopes || [], avatar: s.avatarUrl || null };
    }),
  };
}

function isJiraSite(site) {
  return (site.scopes || []).some(function (sc) {
    return sc.indexOf(':jira') >= 0 || sc.indexOf('jira-work') >= 0;
  });
}

/** 解析本次调用用哪个 cloudId:显式参数 > 内存缓存 > /kv > 现查(并回写缓存)。 */
async function resolveCloudId(args, callId) {
  if (args.cloud_id && String(args.cloud_id).trim()) return { cloudId: String(args.cloud_id).trim() };
  var key = args.account || 'default';
  if (siteCache[key]) return { cloudId: siteCache[key] };
  try {
    var kv = await (await fetch('/kv')).json();
    var stored = kv && kv.defaultSites && kv.defaultSites[key];
    if (typeof stored === 'string' && stored) {
      siteCache[key] = stored;
      return { cloudId: stored };
    }
  } catch (e) {
    /* kv 读失败不阻断,现查兜底 */
  }
  var found = await fetchAccessibleResources(args.account, callId);
  if (found.err) return { err: found.err };
  if (!found.sites.length) return { err: '该账号没有可访问的 Atlassian 站点,请确认授权账号是否正确' };
  var jira = null;
  for (var i = 0; i < found.sites.length; i++) {
    if (isJiraSite(found.sites[i])) { jira = found.sites[i]; break; }
  }
  var picked = (jira || found.sites[0]).cloud_id;
  siteCache[key] = picked;
  try {
    var kv2 = await (await fetch('/kv')).json();
    kv2 = kv2 && typeof kv2 === 'object' ? kv2 : {};
    kv2.defaultSites = kv2.defaultSites || {};
    kv2.defaultSites[key] = picked;
    await fetch('/kv', { method: 'PUT', body: JSON.stringify(kv2) });
  } catch (e) {
    /* 缓存写失败无所谓,下次现查 */
  }
  return { cloudId: picked };
}

function jiraBase(cloudId) {
  return API_BASE + '/ex/jira/' + encodeURIComponent(cloudId);
}
function confBase(cloudId, api2) {
  var root = API_BASE + '/ex/confluence/' + encodeURIComponent(cloudId);
  if (api2 === 'v1') return root + '/wiki/rest/api';
  if (api2 === 'wiki-raw') return root + '/wiki';
  return root + '/wiki/api/v2';
}

function qs(params) {
  var parts = [];
  for (var k in params) {
    if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
    var v = params[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (var i = 0; i < v.length; i++) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v[i])));
    } else {
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    }
  }
  return parts.length ? '?' + parts.join('&') : '';
}

/* ── accounts / sites ──────────────────────────────────────────────── */

async function toolAccounts(args, callId) {
  if (args.action === 'list') {
    var r = await fetch('/oauth');
    if (!r.ok) return fail('账号状态查询失败(' + r.status + ')');
    var list = await r.json();
    var entry = null;
    for (var i = 0; i < list.length; i++) if (list[i].key === 'atlassian_account') entry = list[i];
    if (!entry) return fail('OAuth 凭证槽缺失,请插件作者检查声明');
    if (!entry.accounts.length) {
      return fail('还没连接任何 Atlassian 账号——请用户到主界面侧边栏「插件」→「XD Atlassian」详情页点「连接账号」完成授权');
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
  if (args.action === 'sites') {
    var found = await fetchAccessibleResources(args.account, callId);
    if (found.err) return fail(found.err);
    return { ok: true, result: { sites: found.sites } };
  }
  return fail('未知 action:' + args.action);
}

/* ── jira_issues ───────────────────────────────────────────────────── */

async function toolJiraIssues(args, callId) {
  var site = await resolveCloudId(args, callId);
  if (site.err) return fail(site.err);
  var base = jiraBase(site.cloudId);
  var account = args.account;

  if (args.action === 'search_jql') {
    if (!args.jql) return fail('search_jql 需要 jql');
    var searched = await api({
      url: base + '/rest/api/3/search/jql',
      method: 'POST',
      body: {
        jql: args.jql,
        fields: Array.isArray(args.fields) ? args.fields : undefined,
        maxResults: clampInt(args.max_results, 25, 100),
        nextPageToken: args.next_page_token || undefined,
      },
      account: account, callId: callId,
    });
    if (searched.err) return fail(searched.err);
    return deliver(searched.data, args, callId);
  }
  if (args.action === 'get') {
    if (!args.issue_key) return fail('get 需要 issue_key');
    var got = await api({
      url: base + '/rest/api/3/issue/' + encodeURIComponent(args.issue_key) + qs({
        fields: Array.isArray(args.fields) && args.fields.length ? args.fields.join(',') : undefined,
        expand: Array.isArray(args.expand) && args.expand.length ? args.expand.join(',') : undefined,
      }),
      account: account, callId: callId,
    });
    if (got.err) return fail(got.err);
    return deliver(got.data, args, callId);
  }
  if (args.action === 'create') {
    if (!args.issue_fields || typeof args.issue_fields !== 'object') {
      return fail('create 需要 issue_fields(Jira 原生 fields 对象,含 project / issuetype / summary)');
    }
    var created = await api({
      url: base + '/rest/api/3/issue',
      method: 'POST',
      body: { fields: args.issue_fields },
      account: account, callId: callId,
    });
    if (created.err) return fail(created.err);
    return deliver(created.data, args, callId);
  }
  if (args.action === 'update') {
    if (!args.issue_key) return fail('update 需要 issue_key');
    if (!args.issue_fields && !args.update) return fail('update 需要 issue_fields / update 至少一个');
    var body = {};
    if (args.issue_fields) body.fields = args.issue_fields;
    if (args.update) body.update = args.update;
    var updated = await api({
      url: base + '/rest/api/3/issue/' + encodeURIComponent(args.issue_key) + qs({
        notifyUsers: typeof args.notify_users === 'boolean' ? args.notify_users : undefined,
      }),
      method: 'PUT',
      body: body,
      account: account, callId: callId,
    });
    if (updated.err) return fail(updated.err);
    return { ok: true, result: { updated: true } };
  }
  if (args.action === 'add_comment') {
    if (!args.issue_key) return fail('add_comment 需要 issue_key');
    if (!args.body_text && !args.body_adf) return fail('add_comment 需要 body_text / body_adf 至少一个');
    var commented = await api({
      url: base + '/rest/api/3/issue/' + encodeURIComponent(args.issue_key) + '/comment',
      method: 'POST',
      body: { body: args.body_adf || adfFromText(args.body_text || '') },
      account: account, callId: callId,
    });
    if (commented.err) return fail(commented.err);
    return deliver(commented.data, args, callId);
  }
  if (args.action === 'list_transitions') {
    if (!args.issue_key) return fail('list_transitions 需要 issue_key');
    var transitions = await api({
      url: base + '/rest/api/3/issue/' + encodeURIComponent(args.issue_key) + '/transitions',
      account: account, callId: callId,
    });
    if (transitions.err) return fail(transitions.err);
    return deliver(transitions.data, args, callId);
  }
  if (args.action === 'transition') {
    if (!args.issue_key) return fail('transition 需要 issue_key');
    if (!args.transition_id) return fail('transition 需要 transition_id(list_transitions 可查)');
    var tBody = { transition: { id: args.transition_id } };
    if (args.issue_fields) tBody.fields = args.issue_fields;
    if (args.update) tBody.update = args.update;
    var moved = await api({
      url: base + '/rest/api/3/issue/' + encodeURIComponent(args.issue_key) + '/transitions',
      method: 'POST',
      body: tBody,
      account: account, callId: callId,
    });
    if (moved.err) return fail(moved.err);
    return { ok: true, result: { transitioned: true } };
  }
  return fail('未知 action:' + args.action);
}

/* ── jira_projects / jira_users ────────────────────────────────────── */

async function toolJiraProjects(args, callId) {
  var site = await resolveCloudId(args, callId);
  if (site.err) return fail(site.err);
  var r = await api({
    url: jiraBase(site.cloudId) + '/rest/api/3/project/search' + qs({
      query: args.query || undefined,
      maxResults: clampInt(args.max_results, 50, 100),
    }),
    account: args.account, callId: callId,
  });
  if (r.err) return fail(r.err);
  return deliver(r.data, args, callId);
}

async function toolJiraUsers(args, callId) {
  if (!args.query) return fail('需要 query(名字或邮箱关键词)');
  var site = await resolveCloudId(args, callId);
  if (site.err) return fail(site.err);
  var r = await api({
    url: jiraBase(site.cloudId) + '/rest/api/3/user/search' + qs({
      query: args.query,
      maxResults: clampInt(args.max_results, 20, 100),
    }),
    account: args.account, callId: callId,
  });
  if (r.err) return fail(r.err);
  return deliver(r.data, args, callId);
}

/* ── 附件下载共用 ──────────────────────────────────────────────────── */

/**
 * 下载一个附件 URL:图片走媒体总仓(聊天可渲染),非图片走 save 票据落盘。
 * meta = { filename, mediaType };非图片且无票据时给出 save_dir 指引。
 */
async function downloadFromUrl(url, meta, args, callId) {
  var isImage = Boolean(IMAGE_MIME[String(meta.mediaType || '').toLowerCase()]);
  if (isImage) {
    var m = await cindy.fetch({
      url: url,
      as: 'media',
      label: meta.filename || '',
      callId: callId,
      authAccount: args.account || undefined,
    });
    if (!m.ok) return { err: m.message };
    if (!m.media) {
      // 媒体模式回落文本 = 上游给的不是媒体字节(错误 JSON 等)。
      var snippet = typeof m.body === 'string' ? m.body.slice(0, 300) : '';
      return { err: classifyStatus(m.status, snippet) };
    }
    return {
      result: {
        downloaded: true,
        kind: 'image',
        file_name: meta.filename,
        media_type: meta.mediaType,
        bytes: m.media.bytes,
        xdt_image_urls: [m.media.url],
        note: '图片附件已入库,聊天中可直接渲染',
      },
    };
  }
  if (!args.save_deposit || !args.save_deposit.token) {
    return { err: '非图片附件需要落盘目录——请主 agent 调 ghost_call 时把目标目录绝对路径放在顶层 save_dir 参数' };
  }
  var saved = await cindy.fetch({
    url: url,
    as: 'file',
    saveTo: { token: args.save_deposit.token, filename: args.filename || meta.filename || undefined },
    callId: callId,
    authAccount: args.account || undefined,
  });
  if (!saved.ok) return { err: saved.message };
  if (!saved.file) {
    var snippet2 = typeof saved.body === 'string' ? saved.body.slice(0, 300) : '';
    return { err: classifyStatus(saved.status, snippet2) };
  }
  return {
    result: {
      downloaded: true,
      kind: 'file',
      dir_name: args.save_deposit.dir_name,
      file_name: saved.file.file_name,
      media_type: saved.file.mime_type,
      bytes: saved.file.bytes,
      note: '已存到 ' + args.save_deposit.dir_name + '/' + saved.file.file_name,
    },
  };
}

/* ── jira_attachments ──────────────────────────────────────────────── */

async function toolJiraAttachments(args, callId) {
  if (!args.attachment_id) return fail('需要 attachment_id');
  var site = await resolveCloudId(args, callId);
  if (site.err) return fail(site.err);
  var base = jiraBase(site.cloudId);
  var meta = await api({
    url: base + '/rest/api/3/attachment/' + encodeURIComponent(args.attachment_id),
    account: args.account, callId: callId,
  });
  if (meta.err) return fail(meta.err);
  if (args.action === 'get') return deliver(meta.data, args, callId);
  if (args.action === 'download') {
    // content 端点 302 → Atlassian media CDN(白名单已放行 *.media.atlassian.com,
    // 主机逐跳校验;presigned URL 自带签名,Authorization 只注 api.atlassian.com)。
    var done = await downloadFromUrl(
      base + '/rest/api/3/attachment/content/' + encodeURIComponent(args.attachment_id),
      { filename: (meta.data && meta.data.filename) || 'attachment-' + args.attachment_id, mediaType: (meta.data && meta.data.mimeType) || '' },
      args,
      callId,
    );
    if (done.err) return fail(done.err);
    return { ok: true, result: done.result };
  }
  return fail('未知 action:' + args.action);
}

/* ── confluence_spaces ─────────────────────────────────────────────── */

async function toolConfSpaces(args, callId) {
  var site = await resolveCloudId(args, callId);
  if (site.err) return fail(site.err);
  var base = confBase(site.cloudId);
  if (args.action === 'list') {
    var listed = await api({
      url: base + '/spaces' + qs({
        limit: clampInt(args.limit, 25, 250),
        cursor: args.cursor || undefined,
        keys: Array.isArray(args.keys) && args.keys.length ? args.keys.join(',') : undefined,
      }),
      account: args.account, callId: callId,
    });
    if (listed.err) return fail(listed.err);
    return deliver(listed.data, args, callId);
  }
  if (args.action === 'get') {
    if (!args.space_id) return fail('get 需要 space_id(纯数字 id,list 可查)');
    var got = await api({
      url: base + '/spaces/' + encodeURIComponent(args.space_id),
      account: args.account, callId: callId,
    });
    if (got.err) return fail(got.err);
    return deliver(got.data, args, callId);
  }
  return fail('未知 action:' + args.action);
}

/* ── confluence_pages ──────────────────────────────────────────────── */

async function toolConfPages(args, callId) {
  var site = await resolveCloudId(args, callId);
  if (site.err) return fail(site.err);
  var v2 = confBase(site.cloudId);
  var account = args.account;

  if (args.action === 'search_cql') {
    if (!args.cql) return fail('search_cql 需要 cql');
    var searched = await api({
      url: confBase(site.cloudId, 'v1') + '/search' + qs({
        cql: args.cql,
        limit: clampInt(args.limit, 25, 100),
        cursor: args.cursor || undefined,
      }),
      account: account, callId: callId,
    });
    if (searched.err) return fail(searched.err);
    return deliver(searched.data, args, callId);
  }
  if (args.action === 'get') {
    if (!args.page_id) return fail('get 需要 page_id');
    var got = await api({
      url: v2 + '/pages/' + encodeURIComponent(args.page_id) + qs({ 'body-format': args.body_format || 'storage' }),
      account: account, callId: callId,
    });
    if (got.err) return fail(got.err);
    return deliver(got.data, args, callId);
  }
  if (args.action === 'list_children') {
    if (!args.page_id) return fail('list_children 需要 page_id');
    var children = await api({
      url: v2 + '/pages/' + encodeURIComponent(args.page_id) + '/children' + qs({
        limit: clampInt(args.limit, 25, 250),
        cursor: args.cursor || undefined,
      }),
      account: account, callId: callId,
    });
    if (children.err) return fail(children.err);
    return deliver(children.data, args, callId);
  }
  if (args.action === 'create') {
    if (!args.space_id || !args.title) return fail('create 需要 space_id / title');
    var createBody = {
      spaceId: args.space_id,
      status: args.status || 'current',
      title: args.title,
    };
    if (args.parent_id) createBody.parentId = args.parent_id;
    var createStorage = pickStorage(args);
    if (createStorage !== null) createBody.body = { representation: 'storage', value: createStorage };
    var created = await api({ url: v2 + '/pages', method: 'POST', body: createBody, account: account, callId: callId });
    if (created.err) return fail(created.err);
    return deliver(created.data, args, callId);
  }
  if (args.action === 'update') {
    if (!args.page_id || !args.title) return fail('update 需要 page_id / title(沿用旧标题也要传)');
    if (typeof args.version_number !== 'number') return fail('update 需要 version_number(= 当前版本号 + 1,先 get 拿 version.number)');
    var updateBody = {
      id: args.page_id,
      status: args.status || 'current',
      title: args.title,
      version: { number: args.version_number },
    };
    var updateStorage = pickStorage(args);
    if (updateStorage !== null) updateBody.body = { representation: 'storage', value: updateStorage };
    var updated = await api({
      url: v2 + '/pages/' + encodeURIComponent(args.page_id),
      method: 'PUT',
      body: updateBody,
      account: account, callId: callId,
    });
    if (updated.err) return fail(updated.err);
    return deliver(updated.data, args, callId);
  }
  if (args.action === 'blogpost_get') {
    if (!args.blogpost_id) return fail('blogpost_get 需要 blogpost_id');
    var blog = await api({
      url: v2 + '/blogposts/' + encodeURIComponent(args.blogpost_id) + qs({ 'body-format': args.body_format || 'storage' }),
      account: account, callId: callId,
    });
    if (blog.err) return fail(blog.err);
    return deliver(blog.data, args, callId);
  }
  return fail('未知 action:' + args.action);
}

/** body_storage 优先,body_text 转 storage,都没有回 null(不带 body 字段)。 */
function pickStorage(args) {
  if (typeof args.body_storage === 'string' && args.body_storage.length > 0) return args.body_storage;
  if (typeof args.body_text === 'string') return storageFromText(args.body_text);
  return null;
}

/* ── confluence_comments ───────────────────────────────────────────── */

async function toolConfComments(args, callId) {
  var site = await resolveCloudId(args, callId);
  if (site.err) return fail(site.err);
  var base = confBase(site.cloudId);
  var container = args.container_type === 'blogpost' ? 'blogposts' : 'pages';
  var account = args.account;

  if (args.action === 'list' || args.action === 'inline_list') {
    if (!args.container_id) return fail(args.action + ' 需要 container_id');
    var kind = args.action === 'list' ? 'footer-comments' : 'inline-comments';
    var listed = await api({
      url: base + '/' + container + '/' + encodeURIComponent(args.container_id) + '/' + kind + qs({
        limit: clampInt(args.limit, 25, 250),
        cursor: args.cursor || undefined,
        'body-format': args.body_format || 'storage',
      }),
      account: account, callId: callId,
    });
    if (listed.err) return fail(listed.err);
    return deliver(listed.data, args, callId);
  }
  if (args.action === 'add') {
    if (!args.container_id) return fail('add 需要 container_id');
    var storage = pickStorage(args);
    if (storage === null) return fail('add 需要 body_text / body_storage 至少一个');
    var body = { body: { representation: 'storage', value: storage } };
    body[args.container_type === 'blogpost' ? 'blogPostId' : 'pageId'] = args.container_id;
    var added = await api({ url: base + '/footer-comments', method: 'POST', body: body, account: account, callId: callId });
    if (added.err) return fail(added.err);
    return deliver(added.data, args, callId);
  }
  if (args.action === 'list_children') {
    if (!args.comment_id) return fail('list_children 需要 comment_id');
    var parent = args.comment_type === 'inline' ? 'inline-comments' : 'footer-comments';
    var children = await api({
      url: base + '/' + parent + '/' + encodeURIComponent(args.comment_id) + '/children' + qs({
        limit: clampInt(args.limit, 25, 250),
        cursor: args.cursor || undefined,
        'body-format': args.body_format || 'storage',
      }),
      account: account, callId: callId,
    });
    if (children.err) return fail(children.err);
    return deliver(children.data, args, callId);
  }
  return fail('未知 action:' + args.action);
}

/* ── confluence_attachments ────────────────────────────────────────── */

async function toolConfAttachments(args, callId) {
  var site = await resolveCloudId(args, callId);
  if (site.err) return fail(site.err);
  var base = confBase(site.cloudId);
  var account = args.account;

  if (args.action === 'list') {
    if (!args.container_id) return fail('list 需要 container_id');
    var container = args.container_type === 'blogpost' ? 'blogposts' : 'pages';
    var listed = await api({
      url: base + '/' + container + '/' + encodeURIComponent(args.container_id) + '/attachments' + qs({
        limit: clampInt(args.limit, 25, 250),
        cursor: args.cursor || undefined,
      }),
      account: account, callId: callId,
    });
    if (listed.err) return fail(listed.err);
    return deliver(listed.data, args, callId);
  }
  if (!args.attachment_id) return fail(args.action + ' 需要 attachment_id');
  var meta = await api({
    url: base + '/attachments/' + encodeURIComponent(args.attachment_id),
    account: account, callId: callId,
  });
  if (meta.err) return fail(meta.err);
  if (args.action === 'get') return deliver(meta.data, args, callId);
  if (args.action === 'download') {
    // 双候选(镜像老 client):v1 download 子路径(classic scope 覆盖)优先,
    // downloadLink(wiki 原始路径)兜底;全失败多半是 Atlassian OAuth scope
    // 限制(官方 Rovo MCP 也因此搁置该能力),把最后一条失败原因如实交卷。
    var m = meta.data || {};
    var containerId = m.pageId !== undefined && m.pageId !== null
      ? String(m.pageId)
      : m.blogPostId !== undefined && m.blogPostId !== null
        ? String(m.blogPostId)
        : null;
    var candidates = [];
    if (containerId) {
      candidates.push(
        confBase(site.cloudId, 'v1') + '/content/' + encodeURIComponent(containerId) +
        '/child/attachment/' + encodeURIComponent(args.attachment_id) + '/download',
      );
    }
    var downloadPath = m.downloadLink || (m._links && m._links.download);
    if (downloadPath) {
      var normalized = downloadPath.indexOf('/wiki') === 0 ? downloadPath.slice('/wiki'.length) : downloadPath;
      candidates.push(confBase(site.cloudId, 'wiki-raw') + (normalized.indexOf('/') === 0 ? normalized : '/' + normalized));
    }
    if (!candidates.length) return fail('附件元数据缺少容器 id 与 downloadLink,无法定位下载地址');
    var lastErr = '';
    for (var i = 0; i < candidates.length; i++) {
      var done = await downloadFromUrl(
        candidates[i],
        { filename: m.title || 'attachment-' + args.attachment_id, mediaType: m.mediaType || '' },
        args,
        callId,
      );
      if (!done.err) return { ok: true, result: done.result };
      lastErr = done.err;
      // save_dir 缺失是调用方问题,换候选也救不了,直接反馈。
      if (lastErr.indexOf('save_dir') >= 0) return fail(lastErr);
    }
    return fail('附件下载在所有候选地址上都失败(多半是 Atlassian OAuth scope 限制):' + lastErr);
  }
  return fail('未知 action:' + args.action);
}

/* ── confluence_users ──────────────────────────────────────────────── */

async function toolConfUsers(args, callId) {
  if (!Array.isArray(args.account_ids) || args.account_ids.length === 0) {
    return fail('需要 account_ids(accountId 列表)');
  }
  var site = await resolveCloudId(args, callId);
  if (site.err) return fail(site.err);
  // accountId 全家桶通用,复用同 token 打 Jira 的 user/bulk(镜像老 client;上限 90)。
  var ids = args.account_ids.slice(0, 90);
  var r = await api({
    url: jiraBase(site.cloudId) + '/rest/api/3/user/bulk' + qs({ accountId: ids, maxResults: ids.length }),
    account: args.account, callId: callId,
  });
  if (r.err) return fail(r.err);
  return deliver(r.data, args, callId);
}

/* ── 派单 ──────────────────────────────────────────────────────────── */

var TOOLS = {
  atlassian_accounts: toolAccounts,
  jira_issues: toolJiraIssues,
  jira_projects: toolJiraProjects,
  jira_users: toolJiraUsers,
  jira_attachments: toolJiraAttachments,
  confluence_spaces: toolConfSpaces,
  confluence_pages: toolConfPages,
  confluence_comments: toolConfComments,
  confluence_attachments: toolConfAttachments,
  confluence_users: toolConfUsers,
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
      message: 'Atlassian 工具执行失败:' + (err && err.message ? err.message : String(err)),
    });
  }
});
