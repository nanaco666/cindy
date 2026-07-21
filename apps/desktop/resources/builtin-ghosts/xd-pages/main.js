/**
 * XD Pages · 电子脑 —— XD 内部 Pages 站点管理意识(network 槽,C4)。
 *
 * 工作方式:
 * - 域名白名单代发:cindy.fetch 只能到 ghost.json 声明的 api.workers.xd.team,
 *   请求由主机代发,沙箱本身零直连;
 * - 身份凭证是 source:'login-email' 的派生凭证:主机现读登录邮箱、按
 *   "pages_{value}" 模板拼进 X-Pages-Token 头——本文件永远摸不到邮箱与 token
 *   字节(平台结构保证),未登录时主机会返回带重登指引的结构化错误。
 *
 * 行为对齐原 lizi_xd_service MCP(已随二期迁移整包退役):
 * - HTTP 状态码 → 结构化 errorCode 的映射同原 api.ts mapErrorResponse;
 * - RATE_LIMITED / 网络失败自动重试 1 次(5s)——仅查询类工具;deploy 的
 *   过户票据单次消费,失败不在沙箱内重试,引导主 agent 重新过户后再试;
 * - 站点名正则、删除的 confirm:true 保险闸、ip-guard 静态模板全部照搬。
 * 部署(pages_deploy)走目录过户 + uploadDir 通道:主 agent 在 ghost_call
 * 顶层传 dir → 主机过户注入 args.dir_deposit(票据 + 相对路径清单)→
 * 本脑按清单判 preset,凭票据发 uploadDir 请求——主机代读盘代组 multipart,
 * 本文件全程摸不到绝对路径与文件字节。
 */

/* global cindy */

var API_BASE = 'https://api.workers.xd.team';

/** 站点名规则(与服务端 openapi SiteName 一致)。 */
var SITE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;
var SITE_NAME_RULE_HINT =
  '站点名规则: 2-50 字符, 仅小写字母 / 数字 / 连字符, 首尾必须是字母数字 (正则 /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/)';

var TRANSIENT_RETRY_DELAY_MS = 5000;

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * HTTP 状态码 → 结构化 errorCode(对齐 lizi-mcps xd-service/api.ts):
 * 400=INVALID_SITE_NAME / 403=按 hint 分 IP_BLOCKED 与 PERMISSION_DENIED /
 * 404=NOT_FOUND / 409=SITE_NAME_TAKEN / 429=RATE_LIMITED / 其余=PAGES_API_ERROR。
 */
function mapError(status, parsed) {
  var obj = parsed && typeof parsed === 'object' ? parsed : {};
  var hint = typeof obj.hint === 'string' ? obj.hint : undefined;
  var message =
    (typeof obj.message === 'string' && obj.message) ||
    (typeof obj.error === 'string' && obj.error) ||
    'HTTP ' + status;
  var errorCode;
  if (status === 400) errorCode = 'INVALID_SITE_NAME';
  else if (status === 403) errorCode = /ip|whitelist|公司|内网/i.test(message + (hint || '')) ? 'IP_BLOCKED' : 'PERMISSION_DENIED';
  else if (status === 404) errorCode = 'NOT_FOUND';
  else if (status === 409) errorCode = 'SITE_NAME_TAKEN';
  else if (status === 429) errorCode = 'RATE_LIMITED';
  else errorCode = 'PAGES_API_ERROR';
  var out = { ok: false, errorCode: errorCode, message: message, httpStatus: status };
  if (hint) out.hint = hint;
  return out;
}

/** 发一次请求并收敛成 { ok, data } | { ok:false, errorCode, ... }。 */
async function requestOnce(method, path) {
  var r = await cindy.fetch({
    url: API_BASE + path,
    method: method,
    headers: { Accept: 'application/json' },
  });
  if (!r.ok) {
    // 主机侧结构化失败(白名单/凭证/网络):message 已带人话指引(如未登录
    // 的重登步骤),原样透传给 AI 转述用户。取舍:沙箱侧无法区分主机失败
    // 原因,统一记 NETWORK_ERROR 并吃一次 5s 重试——未登录场景多等 5 秒,
    // 换取真网络抖动的自愈;主机失败形态出结构化 code 后再分档。
    return { ok: false, errorCode: 'NETWORK_ERROR', message: r.message };
  }
  var parsed = null;
  if (r.body) {
    try { parsed = JSON.parse(r.body); } catch (e) { parsed = r.body; }
  }
  if (r.status >= 200 && r.status < 300) {
    return { ok: true, data: parsed || {} };
  }
  return mapError(r.status, parsed);
}

/** RATE_LIMITED / NETWORK_ERROR 自动重试 1 次(5s);其余错误码是稳定状态直接返回。 */
async function request(method, path) {
  var first = await requestOnce(method, path);
  if (first.ok) return first;
  if (first.errorCode !== 'RATE_LIMITED' && first.errorCode !== 'NETWORK_ERROR') return first;
  await sleep(TRANSIENT_RETRY_DELAY_MS);
  return requestOnce(method, path);
}

/* ── ip-guard 模板(与 workers.xd.team openapi.json x-libs 契约同步)──────── */
var IP_GUARD_SOURCE = 'function getAllowed(env) {\n' +
  '  return String(env.IP_ALLOWLIST || "")\n' +
  '    .split(",")\n' +
  '    .map((entry) => entry.trim())\n' +
  '    .filter(Boolean);\n' +
  '}\n' +
  '\n' +
  'function ipToInt(ip) {\n' +
  '  return ip.split(".").reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;\n' +
  '}\n' +
  '\n' +
  'function toRules(allowed) {\n' +
  '  return allowed.map((entry) => {\n' +
  '    if (entry.includes(":")) return { type: "exact6", value: entry };\n' +
  '    if (entry.includes("/")) {\n' +
  '      const [base, bits] = entry.split("/");\n' +
  '      const mask = ~((1 << (32 - Number(bits))) - 1) >>> 0;\n' +
  '      return { type: "cidr", network: ipToInt(base) & mask, mask };\n' +
  '    }\n' +
  '    return { type: "exact4", value: ipToInt(entry) };\n' +
  '  });\n' +
  '}\n' +
  '\n' +
  'function checkIP(request, env) {\n' +
  '  const rules = toRules(getAllowed(env));\n' +
  '  const ip = request.headers.get("CF-Connecting-IP");\n' +
  '  if (!ip) return null;\n' +
  '  if (ip.includes(":")) {\n' +
  '    return rules.some((r) => r.type === "exact6" && r.value === ip)\n' +
  '      ? null\n' +
  '      : new Response("IP not allowed", { status: 403 });\n' +
  '  }\n' +
  '  const n = ipToInt(ip);\n' +
  '  const ok = rules.some((r) => {\n' +
  '    if (r.type === "exact4") return r.value === n;\n' +
  '    if (r.type === "cidr") return (n & r.mask) === r.network;\n' +
  '    return false;\n' +
  '  });\n' +
  '  return ok ? null : new Response("IP not allowed", { status: 403 });\n' +
  '}';

var TEMPLATES = {
  'ip-guard': {
    type: 'ip-guard',
    description:
      'IP 内网限制代码。在 Worker fetch handler 开头调用 checkIP(request, env), 返回非 null 则直接 return (403)。' +
      '直接粘贴到 _worker.js 顶部即可, 再在 fetch handler 第一行调 checkIP(request, env)。',
    usage: 'const blocked = checkIP(request, env); if (blocked) return blocked;',
    source: IP_GUARD_SOURCE,
    sourced_at: '2026-07-21',
  },
};

/* ── 部署(preset 判定 + 目录上传)──────────────────────────────────── */

/**
 * 按过户回执的相对路径清单判 preset(对齐原 preset.ts 的规则,但沙箱读不到
 * 文件内容——package.json 依赖信号缺失,判不出时如实返回 needsUserConfirm
 * 让 AI 跟用户确认或自行读目录后显式传 preset)。
 */
function detectPresetFromRelPaths(relPaths) {
  if (relPaths.indexOf('_worker.js') >= 0 || relPaths.indexOf('_worker/index.js') >= 0) {
    return { preset: 'worker', reason: '检测到 _worker.js / _worker/index.js' };
  }
  // SPA 构建产物信号:assets/_next/static 下有 js,或根部 main.*.js + index.html
  var hasSpaAssets = relPaths.some(function (p) {
    return /^(assets|_next|static)\/.+\.(js|mjs)$/.test(p) || /^_next\//.test(p);
  });
  var hasAngularMain =
    relPaths.indexOf('index.html') >= 0 &&
    relPaths.some(function (p) { return /^main\..+\.js$/.test(p); });
  if (hasSpaAssets || hasAngularMain) {
    return { preset: 'spa', reason: '检测到 SPA 构建产物 (assets/_next/main.*.js 等)' };
  }
  return {
    preset: 'static',
    reason: '无明确 worker / SPA 信号, 兜底按 static 处理。若该目录其实是 SPA(有路由切换但不刷新页面), 请显式传 preset:"spa" 重新部署',
    needsUserConfirm: true,
  };
}

async function pagesDeploy(args) {
  var name = args && typeof args.name === 'string' ? args.name : '';
  if (!SITE_NAME_RE.test(name)) {
    return { ok: false, errorCode: 'INVALID_SITE_NAME', message: '站点名不合法: ' + name, hint: SITE_NAME_RULE_HINT };
  }
  var deposit = args && args.dir_deposit;
  if (!deposit || typeof deposit.token !== 'string') {
    return {
      ok: false,
      errorCode: 'DEPOSIT_MISSING',
      message: '没有收到目录过户票据——部署目录必须放在 ghost_call 的顶层 dir 参数(绝对路径),不是 args',
    };
  }
  var relPaths = Array.isArray(deposit.rel_paths) ? deposit.rel_paths : [];

  // preset:显式传的直接用(非法值显式拒,不静默落自动识别——规则 9);
  // 没传才按文件清单自动识别。
  var preset = args.preset;
  var presetReason = 'user-specified';
  var presetNeedsConfirm = false;
  if (preset !== undefined && preset !== 'static' && preset !== 'spa' && preset !== 'worker') {
    return {
      ok: false,
      errorCode: 'INVALID_ARGS',
      message: 'preset 仅支持 static / spa / worker(或不传 = 自动识别),得到: ' + String(preset),
    };
  }
  if (preset === undefined) {
    var detected = detectPresetFromRelPaths(relPaths);
    preset = detected.preset;
    presetReason = detected.reason;
    presetNeedsConfirm = detected.needsUserConfirm === true;
  }
  // 当前 Pages API 固定开启 IP 限制; public=true 会被服务端拒绝。
  // Worker 是否真的执行限制取决于用户是否在 _worker.js 中调用 ip-guard。
  if (args && args.public === true) {
    return {
      ok: false,
      errorCode: 'INVALID_ARGS',
      message: '当前 Pages API 固定开启 IP 限制, 不支持 public=true。worker 站点如需公网访问, 请不要在 _worker.js 中调用 ip-guard。',
      hint: 'static/spa 会由服务端自动注入 IP 检查; worker 需要在 _worker.js 中自行决定是否调用 ip-guard。',
    };
  }
  var ipRestrict = true;

  // 凭票上传:主机代读盘代组 multipart(file-N filename=相对路径,服务端按
  // filename 还原目录结构)。票据单次消费,失败重试要主 agent 重新过户。
  var r = await cindy.fetch({
    url: API_BASE + '/deploy',
    method: 'POST',
    headers: { Accept: 'application/json' },
    uploadDir: {
      token: deposit.token,
      fields: { name: name, preset: preset, ip_restrict: String(ipRestrict) },
    },
    timeoutMs: 300000,
  });
  if (!r.ok) {
    return { ok: false, errorCode: 'NETWORK_ERROR', message: r.message };
  }
  var parsed = null;
  if (r.body) {
    try { parsed = JSON.parse(r.body); } catch (e) { parsed = r.body; }
  }
  if (!(r.status >= 200 && r.status < 300)) {
    return mapError(r.status, parsed);
  }

  var responseIpRestrict = parsed && typeof parsed.ipRestrict === 'boolean' ? parsed.ipRestrict : ipRestrict;
  var siteUrl = parsed && typeof parsed.url === 'string' ? parsed.url : 'https://' + name + '.workers.xd.team';
  var accessScope;
  if (preset === 'worker') {
    accessScope = responseIpRestrict
      ? 'Worker 代码自行决定(请确认 _worker.js 已调用 ip-guard)'
      : '已开启公网访问';
  } else {
    accessScope = responseIpRestrict ? '仅公司内网可访问' : '已开启公网访问';
  }
  var serverWarning = parsed && typeof parsed.warning === 'string' && parsed.warning ? parsed.warning : undefined;
  var warningNote = serverWarning || (preset === 'worker' && responseIpRestrict
    ? 'worker preset 不会自动注入 IP 检查, 请在 _worker.js 内自行集成 ip-guard(调 pages_get_worker_template({ type: "ip-guard" }) 拿模板), 否则站点实际可能为公网可访问。'
    : undefined);
  var lines = [
    '部署成功 ✅',
    '',
    '- 站点地址: ' + siteUrl,
    '- 访问范围: ' + accessScope,
    '- preset: ' + preset + '(' + presetReason + ')',
    '- 文件数: ' + (parsed && typeof parsed.fileCount === 'number'
      ? parsed.fileCount
      : (typeof deposit.file_count === 'number' ? deposit.file_count : relPaths.length)),
    '',
    '提示: 新站点 DNS 首次部署后可能需要 1-3 分钟生效, 立刻打不开是正常现象;更新部署后页面没刷新通常是 CDN 缓存, 可在 URL 后加 ?v=<时间戳> 验证。',
  ];
  if (warningNote) lines.push('', '⚠️ ' + warningNote);

  var out = {
    ok: true,
    data: parsed || {},
    meta: {
      preset_decision: { used: preset, reason: presetReason },
      file_count: typeof deposit.file_count === 'number' ? deposit.file_count : relPaths.length,
      total_bytes: typeof deposit.total_bytes === 'number' ? deposit.total_bytes : undefined,
    },
    user_facing_markdown: lines.join('\n'),
  };
  if (presetNeedsConfirm) {
    out.meta.preset_decision.needs_user_confirm = true;
    out.meta.preset_decision.confirm_hint =
      '自动检测不确定, 建议跟用户复述一句: "这个网站是固定内容还是有页面跳转的单页应用?" 前者保持 static, 后者重新部署时传 preset:"spa"(需重新过户目录)';
  }
  if (serverWarning) out.meta.warning = serverWarning;
  if (preset === 'worker' && warningNote) out.meta.worker_note = warningNote;
  return out;
}

/* ── 工具实现 ─────────────────────────────────────────────────────────── */

async function pagesList() {
  return request('GET', '/list');
}

async function pagesInfo(args) {
  var name = args && typeof args.name === 'string' ? args.name : '';
  if (!SITE_NAME_RE.test(name)) {
    return { ok: false, errorCode: 'INVALID_SITE_NAME', message: '站点名不合法: ' + name, hint: SITE_NAME_RULE_HINT };
  }
  return request('GET', '/site/' + encodeURIComponent(name));
}

async function pagesDelete(args) {
  var name = args && typeof args.name === 'string' ? args.name : '';
  if (!SITE_NAME_RE.test(name)) {
    return { ok: false, errorCode: 'INVALID_SITE_NAME', message: '站点名不合法: ' + name, hint: SITE_NAME_RULE_HINT };
  }
  // 不可逆操作的保险闸在代码里(规则 9),不依赖 AI 自觉。
  if (!args || args.confirm !== true) {
    return {
      ok: false,
      errorCode: 'CONFIRM_REQUIRED',
      message: '删除是不可逆操作, 请显式传 confirm:true 再调一次',
      hint: '建议先向用户复述要删的站点名 (' + name + ') 取得同意后再重试',
    };
  }
  return request('DELETE', '/site/' + encodeURIComponent(name));
}

function pagesGetWorkerTemplate(args) {
  var type = args && typeof args.type === 'string' ? args.type : '';
  var tpl = TEMPLATES[type];
  if (!tpl) {
    return {
      ok: false,
      errorCode: 'UNKNOWN_TEMPLATE',
      message: '未知模板类型: ' + type,
      hint: '可用类型: ' + Object.keys(TEMPLATES).join(', '),
    };
  }
  return { ok: true, data: tpl };
}

var HANDLERS = {
  pages_deploy: pagesDeploy,
  pages_list: pagesList,
  pages_info: pagesInfo,
  pages_delete: pagesDelete,
  pages_get_worker_template: pagesGetWorkerTemplate,
};

cindy.onHostMessage(async function (msg) {
  if (!msg || msg.type !== 'tool-call') return;
  var handler = HANDLERS[msg.tool];
  if (!handler) {
    cindy.send({ type: 'tool-result', callId: msg.callId, ok: false, message: '未知工具:' + msg.tool });
    return;
  }
  try {
    var r = await handler(msg.args || {});
    if (r && r.ok) {
      cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: r });
    } else {
      // 结构化错误整体作为失败消息交卷:errorCode/hint 一并给 AI 走分支。
      cindy.send({
        type: 'tool-result',
        callId: msg.callId,
        ok: false,
        message: JSON.stringify(r),
      });
    }
  } catch (err) {
    cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: false,
      message: '执行失败:' + (err && err.message ? err.message : String(err)),
    });
  }
});
