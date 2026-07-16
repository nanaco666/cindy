/**
 * Cindy Web Search · 电子脑 —— Cindy 内置的网页搜索意识(network 槽,C4)。
 *
 * 工作方式:
 * - 域名白名单代发:cindy.fetch 只能到 ghost.json 声明的 brave / tavily 两域名,
 *   请求由主机代发,沙箱本身零直连;
 * - 凭证保险库:两条 key 由用户在意识设置页填入、主机保管注入——本文件里
 *   没有也不可能有任何 key 字节,连"读一下"都做不到(平台结构保证)。
 *
 * 搜索源选择:调用指定 provider 就用指定的;没指定先试 Brave(便宜快),
 * key 未配置的结构化错误再降级试 Tavily;都没配就把主机的指引原样交卷。
 */

/* global cindy */

var BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';
var TAVILY_URL = 'https://api.tavily.com/search';

/** 主机"凭证未配置"错误的识别(message 带填写指引,原样转给用户最有用)。 */
function isKeyMissing(r) {
  return !r.ok && typeof r.message === 'string' && r.message.indexOf('尚未配置') >= 0;
}

function clampLimit(n) {
  var v = typeof n === 'number' && isFinite(n) ? Math.floor(n) : 5;
  return Math.min(10, Math.max(1, v));
}

/** Brave:GET + query 参数,key 由主机注入 X-Subscription-Token。 */
async function searchBrave(query, limit) {
  var url = BRAVE_URL + '?q=' + encodeURIComponent(query) + '&count=' + limit;
  var r = await cindy.fetch({ url: url, headers: { Accept: 'application/json' } });
  if (!r.ok) return r;
  if (r.status !== 200) return { ok: false, message: 'Brave 返回 HTTP ' + r.status + ':' + r.body.slice(0, 200) };
  var data = JSON.parse(r.body);
  var items = (data.web && data.web.results) || [];
  return {
    ok: true,
    provider: 'brave',
    results: items.slice(0, limit).map(function (it) {
      return { title: it.title, url: it.url, snippet: it.description || '' };
    }),
  };
}

/** Tavily:POST JSON,key 由主机注入 Authorization: Bearer。 */
async function searchTavily(query, limit) {
  var r = await cindy.fetch({
    url: TAVILY_URL,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: query, max_results: limit }),
  });
  if (!r.ok) return r;
  if (r.status !== 200) return { ok: false, message: 'Tavily 返回 HTTP ' + r.status + ':' + r.body.slice(0, 200) };
  var data = JSON.parse(r.body);
  var items = data.results || [];
  return {
    ok: true,
    provider: 'tavily',
    results: items.slice(0, limit).map(function (it) {
      return { title: it.title, url: it.url, snippet: it.content || '' };
    }),
  };
}

async function searchWeb(args) {
  var query = args && typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { ok: false, message: 'query 不能为空' };
  var limit = clampLimit(args.limit);

  if (args.provider === 'brave') return searchBrave(query, limit);
  if (args.provider === 'tavily') return searchTavily(query, limit);

  // 未指定:先 Brave,key 没配再降级 Tavily;都没配把两条指引合并交卷。
  var brave = await searchBrave(query, limit);
  if (!isKeyMissing(brave)) return brave;
  var tavily = await searchTavily(query, limit);
  if (!isKeyMissing(tavily)) return tavily;
  return {
    ok: false,
    message: '两个搜索源的 key 都还没配置。' + brave.message,
  };
}

cindy.onHostMessage(async function (msg) {
  if (!msg || msg.type !== 'tool-call') return;
  if (msg.tool !== 'search_web') {
    cindy.send({ type: 'tool-result', callId: msg.callId, ok: false, message: '未知工具:' + msg.tool });
    return;
  }
  try {
    var r = await searchWeb(msg.args || {});
    if (r.ok) {
      cindy.send({
        type: 'tool-result',
        callId: msg.callId,
        ok: true,
        result: {
          provider: r.provider,
          results: r.results,
          note: '经 ' + r.provider + ' 搜索到 ' + r.results.length + ' 条结果',
        },
      });
    } else {
      cindy.send({ type: 'tool-result', callId: msg.callId, ok: false, message: r.message });
    }
  } catch (err) {
    cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: false,
      message: '搜索失败:' + (err && err.message ? err.message : String(err)),
    });
  }
});
