/**
 * Cindy Slack · 电子脑 —— 内置的 Slack 服务意识。
 *
 * 工作方式:
 * - 工具面直连 Slack 官方托管 MCP(https://mcp.slack.com/mcp,Streamable HTTP):
 *   本文件就是一个最小 MCP 客户端——initialize 拿会话、tools/list 拿清单、
 *   tools/call 干活;工具清单由 Slack 按授权 scope 动态决定(只读授权没有
 *   发消息类工具),本地不实现、不硬编码任何 Slack 工具;
 * - 域名白名单代发:cindy.fetch 只能到 ghost.json 声明的 slack 域名,请求由
 *   主机代发,沙箱零直连;
 * - 主机托管 OAuth(broker 模式 + 弹跳回调):Slack 后台只收 https redirect,
 *   授权页回调先落 XDMaker 授权 broker 的 /slack-mcp/bounce,由其 302 回本机
 *   127.0.0.1:53683;code 换 token 与 refresh(Slack token rotation,12h 短效)
 *   经服务端 broker 完成——本文件没有也不可能有任何令牌字节,主机出网时现取
 *   新鲜 access token 注入 Authorization,401 自动重刷重试(平台结构保证);
 * - 多账号:工具的 account 参数原样透传 cindy.fetch 的 authAccount;MCP 会话
 *   按账号隔离(不同账号的 mcp-session-id 各自维护)。
 */

/* global cindy */

var MCP_URL = 'https://mcp.slack.com/mcp';
var PROTOCOL_VERSION = '2025-06-18';
/**
 * 交卷体量护栏:超过即经 fs 槽落盘工作目录只交路径(deliver 内),写盘不可用
 * 时才回落截断——与 xd-atlassian 同一套泄洪语义。
 */
var RESULT_MAX_CHARS = 50 * 1000;

/* ── 基础工具 ───────────────────────────────────────────────────────── */

function fail(message) {
  return { ok: false, message: message };
}

/** HTTP 状态 → 人话(401 到这里说明主机自动重刷也没救回来)。 */
function classifyStatus(status, bodySnippet) {
  if (status === 401) return 'Slack 授权已失效,请用户到 设置 → 意识 → Cindy Slack 重新连接账号';
  if (status === 403) return '没有权限(HTTP 403):' + bodySnippet;
  if (status === 429) return 'Slack 接口限流(HTTP 429),请稍后重试';
  return 'Slack 官方 MCP 返回 HTTP ' + status + ':' + bodySnippet;
}

/**
 * 解析 Streamable HTTP 响应体:application/json 直接解析;text/event-stream
 * 逐行收集 data: 段,返回 id 匹配的那条 JSON-RPC 消息(服务端可能夹带
 * notification,按 id 过滤)。解析不出回 null。
 */
function parseRpcBody(body, contentType, wantId) {
  if (typeof body !== 'string' || body.length === 0) return null;
  var ct = String(contentType || '').toLowerCase();
  if (ct.indexOf('text/event-stream') >= 0) {
    var lines = body.split(/\r?\n/);
    var matched = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('data:') !== 0) continue;
      var payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        var parsed = JSON.parse(payload);
        if (parsed && parsed.id === wantId) matched = parsed;
      } catch (e) {
        /* 非 JSON 的 data 段忽略 */
      }
    }
    return matched;
  }
  try {
    var direct = JSON.parse(body);
    return direct && direct.id === wantId ? direct : direct;
  } catch (e) {
    return null;
  }
}

/* ── MCP 会话(按账号隔离)──────────────────────────────────────────── */

/** accountId → { sessionId, nextId }。沉睡即失,重醒后按需重建。 */
var sessions = {};
/** 初始化单飞锁:accountId → Promise,防止并发调用各自 initialize。 */
var initInflight = {};

function sessionFor(accountId) {
  if (!accountId) return null;
  if (!sessions[accountId]) sessions[accountId] = { sessionId: null, nextId: 1 };
  return sessions[accountId];
}

/**
 * 解析实际 accountId:显式传了直接用,未传则查 /oauth 端点取当前默认
 * 账号 id(本地 in-process 调用,不走网络)。按 accountId 做会话键可
 * 保证用户切换默认账号后,下一次调用自动建新会话,不复用旧身份的会话。
 */
async function resolveAccountId(account) {
  if (account) return account;
  try {
    var r = await fetch('/oauth');
    if (!r.ok) return null;
    var list = await r.json();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].key === 'slack_account') {
        var accounts = list[i].accounts;
        for (var j = 0; j < accounts.length; j++) {
          if (accounts[j].isDefault) return accounts[j].id;
        }
        if (accounts.length > 0) return accounts[0].id;
      }
    }
  } catch (e) { /* fallback below */ }
  return null;
}

/** 发一条 JSON-RPC(request 或 notification)。凭证由主机注入。 */
async function rpcPost(session, message, account, callId) {
  var headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (session.sessionId) headers['mcp-session-id'] = session.sessionId;
  var req = {
    url: MCP_URL,
    method: 'POST',
    headers: headers,
    body: JSON.stringify(message),
    callId: callId,
  };
  if (account) req.authAccount = account;
  return cindy.fetch(req);
}

/** initialize + notifications/initialized,拿到 mcp-session-id。 */
async function initSession(session, account, callId) {
  session.sessionId = null;
  var initId = session.nextId++;
  var r = await rpcPost(session, {
    jsonrpc: '2.0',
    id: initId,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'cindy-slack', version: '1.0.0' },
    },
  }, account, callId);
  if (!r.ok) return { err: r.message };
  if (r.status < 200 || r.status >= 300) {
    var snippet = typeof r.body === 'string' ? r.body.slice(0, 300) : '';
    return { err: classifyStatus(r.status, snippet) };
  }
  var parsed = parseRpcBody(r.body, r.headers && r.headers['content-type'], initId);
  if (!parsed || parsed.error) {
    return { err: 'Slack 官方 MCP initialize 失败:' + (parsed && parsed.error ? parsed.error.message : '响应无法解析') };
  }
  var sid = r.headers && r.headers['mcp-session-id'];
  if (typeof sid === 'string' && sid.length > 0) session.sessionId = sid;
  // initialized 通知(有无会话头都发;服务端 202/204 空体是正常收条)。
  await rpcPost(session, { jsonrpc: '2.0', method: 'notifications/initialized' }, account, callId);
  return { ok: true };
}

/**
 * 确保会话已初始化(单飞:同一 accountId 并发只跑一单 init,其余等)。
 * 成功回 { ok: true },失败回 { err }。
 */
async function ensureSessionInit(session, accountId, callId) {
  if (session.sessionId) return { ok: true };
  if (initInflight[accountId]) return initInflight[accountId];
  var p = initSession(session, accountId, callId);
  initInflight[accountId] = p;
  var result;
  try { result = await p; } finally { delete initInflight[accountId]; }
  return result;
}

/**
 * 发一条 MCP request,会话失效(404 = Streamable HTTP 会话过期口径)自动
 * 重建会话重试一次。成功回 { result },失败回 { err }。
 */
async function mcpRequest(account, callId, method, params) {
  var accountId = await resolveAccountId(account);
  if (!accountId) return { err: '没有可用的 Slack 账号——请到 设置 → 意识 → Cindy Slack 连接账号' };
  var session = sessionFor(accountId);
  for (var attempt = 0; attempt < 2; attempt++) {
    if (!session.sessionId) {
      var inited = await ensureSessionInit(session, accountId, callId);
      if (inited.err) return { err: inited.err };
    }
    var id = session.nextId++;
    var msg = { jsonrpc: '2.0', id: id, method: method };
    if (params !== undefined) msg.params = params;
    var r = await rpcPost(session, msg, account, callId);
    if (!r.ok) return { err: r.message };
    if (r.status === 404) {
      session.sessionId = null;
      continue;
    }
    if (r.status < 200 || r.status >= 300) {
      var snippet = typeof r.body === 'string' ? r.body.slice(0, 300) : '';
      return { err: classifyStatus(r.status, snippet) };
    }
    var parsed = parseRpcBody(r.body, r.headers && r.headers['content-type'], id);
    if (!parsed) return { err: 'Slack 官方 MCP 响应无法解析(' + method + ')' };
    if (parsed.error) {
      return { err: 'Slack 官方 MCP 返回错误(' + method + '):' + (parsed.error.message || JSON.stringify(parsed.error)) };
    }
    return { result: parsed.result };
  }
  return { err: 'Slack 官方 MCP 会话重建后仍不可用,请稍后重试' };
}

/* ── 交卷(与 xd-atlassian 同一套泄洪)─────────────────────────────── */

async function deliver(data, args, callId) {
  var text = JSON.stringify(data === undefined ? null : data);
  var outFile = args && typeof args.out_file === 'string' && args.out_file ? args.out_file : null;
  if (!outFile && text.length <= RESULT_MAX_CHARS) return { ok: true, result: { data: data } };
  var spillNote = null;
  if (callId) {
    var fileName = outFile || 'slack-result-' + String(callId).slice(0, 8) + '.json';
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
    return { ok: true, result: { data: data, note: spillNote } };
  }
  return {
    ok: true,
    result: {
      truncated: true,
      hint:
        (spillNote ? spillNote + ';' : '') +
        '响应过大已截断——缩小查询范围(如减小 limit / 收窄查询条件)或分页读取',
      preview: text.slice(0, RESULT_MAX_CHARS),
    },
  };
}

/* ── 工具实现 ──────────────────────────────────────────────────────── */

async function toolAccounts() {
  var r = await fetch('/oauth');
  if (!r.ok) return fail('账号状态查询失败(' + r.status + ')');
  var list = await r.json();
  var entry = null;
  for (var i = 0; i < list.length; i++) if (list[i] && list[i].key === 'slack_account') entry = list[i];
  if (!entry) return fail('OAuth 凭证槽缺失,请意识作者检查声明');
  if (!entry.accounts.length) {
    return fail('还没连接任何 Slack 账号——请用户到 设置 → 意识 → Cindy Slack 点「连接账号」完成授权');
  }
  return {
    ok: true,
    result: {
      accounts: entry.accounts.map(function (a) {
        return { id: a.id, user: a.label, status: a.status, is_default: a.isDefault };
      }),
    },
  };
}

async function toolListTools(args, callId) {
  var r = await mcpRequest(args.account, callId, 'tools/list', {});
  if (r.err) return fail(r.err);
  var tools = (r.result && Array.isArray(r.result.tools)) ? r.result.tools : [];
  if (!tools.length) {
    return fail('Slack 官方 MCP 没有返回任何工具——多半是授权 scope 不足,请用户到 设置 → 意识 → Cindy Slack 重新连接账号');
  }
  return deliver({
    tools: tools.map(function (t) {
      return { name: t.name, description: t.description || '', inputSchema: t.inputSchema || null };
    }),
  }, args, callId);
}

/**
 * 空 cursor 清洗:部分模型组合会把可选的 cursor 参数补成空串,而 Slack 官方
 * MCP 会把空串当真实分页 token,搜索第一页返回异常。删掉空 cursor 语义等同
 * "不传 = 第一页"。(原宿主 claude hook 的同名清洗随老集成退役,逻辑归此。)
 */
function scrubEmptyCursor(toolArgs) {
  if (!toolArgs || typeof toolArgs.cursor !== 'string' || toolArgs.cursor.trim().length > 0) return toolArgs;
  var next = {};
  for (var k in toolArgs) {
    if (Object.prototype.hasOwnProperty.call(toolArgs, k) && k !== 'cursor') next[k] = toolArgs[k];
  }
  return next;
}

async function toolCallTool(args, callId) {
  if (!args.name || typeof args.name !== 'string') return fail('需要 name(slack_list_tools 可查)');
  var toolArgs = args.arguments;
  if (toolArgs !== undefined && (typeof toolArgs !== 'object' || toolArgs === null || Array.isArray(toolArgs))) {
    return fail('arguments 必须是 JSON 对象(按该工具的 inputSchema)');
  }
  var r = await mcpRequest(args.account, callId, 'tools/call', {
    name: args.name,
    arguments: scrubEmptyCursor(toolArgs) || {},
  });
  if (r.err) return fail(r.err);
  var result = r.result || {};
  if (result.isError) {
    var pieces = [];
    var content = Array.isArray(result.content) ? result.content : [];
    for (var i = 0; i < content.length; i++) {
      if (content[i] && typeof content[i].text === 'string') pieces.push(content[i].text);
    }
    return fail('Slack 工具 ' + args.name + ' 执行失败:' + (pieces.join('\n').slice(0, 500) || JSON.stringify(result).slice(0, 500)));
  }
  return deliver(result, args, callId);
}

/* ── 派单 ──────────────────────────────────────────────────────────── */

var TOOLS = {
  slack_accounts: toolAccounts,
  slack_list_tools: toolListTools,
  slack_call_tool: toolCallTool,
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
      message: 'Slack 工具执行失败:' + (err && err.message ? err.message : String(err)),
    });
  }
});
