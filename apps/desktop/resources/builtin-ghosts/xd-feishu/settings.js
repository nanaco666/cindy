/**
 * 飞书意识设置页脚本(CSP 禁内联,外挂加载)。
 * 本意识零配置(凭证 = 主机飞书登录态派生,/secrets 无收单键),页面只有:
 *   GET /kv    → { connectedName? } 上次测试成功的姓名(只读展示)
 *   GET /wake  → 叫醒电子脑(幂等)
 * 测试连接经 BroadcastChannel('xd-feishu') 递活给电子脑:
 *   发 { type:'test-connection', reqId },按 reqId 每 400ms 重发直到收到
 *   { type:'test-connection-result', reqId, ok, name, message },15s 超时。
 */
(function () {
  'use strict';

  var bc = new BroadcastChannel('xd-feishu');

  function $(id) { return document.getElementById(id); }

  var statusTimer = null;
  function showStatus(text, sticky) {
    $('status').textContent = text;
    if (statusTimer) clearTimeout(statusTimer);
    if (!sticky) statusTimer = setTimeout(function () { $('status').textContent = ''; }, 4000);
  }

  /** 渲染身份卡片(上次测试成功的姓名;没有就不占位)。 */
  function renderAccount(name) {
    var box = $('account');
    box.textContent = '';
    if (!name) return;
    var row = document.createElement('div');
    row.className = 'account';
    var who = document.createElement('span');
    who.className = 'who';
    who.textContent = name;
    row.appendChild(who);
    var tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = '飞书登录身份';
    row.appendChild(tag);
    box.appendChild(row);
  }

  async function load() {
    try {
      var kv = await (await fetch('/kv')).json();
      renderAccount(kv && typeof kv.connectedName === 'string' ? kv.connectedName : '');
    } catch (e) {
      /* kv 读失败只影响姓名展示,不打扰 */
    }
  }

  var testSeq = 0;
  async function test() {
    var reqId = 'test-' + Date.now() + '-' + (++testSeq);
    var btn = $('test');
    btn.disabled = true;
    showStatus('正在连接飞书验证…', true);
    try {
      await fetch('/wake');
    } catch (e) { /* 叫不醒也让重发兜底 */ }
    var settled = false;
    var timer = null;
    var deadline = setTimeout(function () {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      btn.disabled = false;
      showStatus('测试超时——电子脑未响应,请稍后重试', true);
      void load();
    }, 15000);
    bc.addEventListener('message', function onMsg(ev) {
      var m = ev && ev.data;
      if (!m || m.type !== 'test-connection-result' || m.reqId !== reqId) return;
      if (settled) return;
      settled = true;
      bc.removeEventListener('message', onMsg);
      clearTimeout(deadline);
      if (timer) clearInterval(timer);
      btn.disabled = false;
      if (m.ok) {
        // 成功由系统提示(notify)宣告,页内不重复挂灰字,只清掉「正在连接…」。
        showStatus('');
      } else {
        // 失败保留页内:toast 几秒就消失,失败原因要留在页上照着修。
        showStatus(m.message || '连接失败', true);
      }
      void load();
    });
    var send = function () { bc.postMessage({ type: 'test-connection', reqId: reqId }); };
    send();
    timer = setInterval(function () {
      if (settled) { clearInterval(timer); return; }
      send();
    }, 400);
  }

  $('test').addEventListener('click', function () { void test(); });
  void load();
})();
