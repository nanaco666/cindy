/**
 * 飞书意识设置页脚本(CSP 禁内联,外挂加载)。
 * 数据面:主机 /oauth 通道(协议保留路径)——
 *   GET  /oauth                                 → [{ key, clientConfigured, accounts }](零令牌字节;
 *     account = { id, label(姓名), status, isDefault, avatarDataUrl(头像 data URL 或 null) })
 *   POST /oauth/feishu_account/connect          → 主机拉浏览器跑授权(可能等数分钟);
 *     同身份重复授权 = 重连(只换令牌不堆行),所以「重新授权」按钮也走它
 *   DELETE /oauth/feishu_account/accounts/<id>  → 断开账号
 *   POST /oauth/feishu_account/default          → { accountId } 设默认
 * broker 模式没有自填 client 通道(/client 是 405),本页不画凭证输入。
 * 「测试连接」经 BroadcastChannel('xd-feishu') 递活给电子脑:
 *   发 { type:'test-connection', reqId },按 reqId 每 400ms 重发直到收到
 *   { type:'test-connection-result', reqId, ok, name, message },15s 超时。
 */
(function () {
  'use strict';

  var KEY = 'feishu_account';

  var bc = new BroadcastChannel('xd-feishu');

  function $(id) { return document.getElementById(id); }

  var statusTimer = null;
  function showStatus(text, sticky) {
    $('status').textContent = text;
    if (statusTimer) clearTimeout(statusTimer);
    if (!sticky) statusTimer = setTimeout(function () { $('status').textContent = ''; }, 4000);
  }

  var CONNECT_ERROR_TEXT = {
    NO_CLIENT_CONFIG: '授权配置缺失,请更新插件后重试',
    TIMEOUT: '授权超时,请重试',
    CANCELLED: '授权已取消',
    CALLBACK_INVALID: '授权回调校验失败,请重试',
    EXCHANGE_FAILED: '令牌交换失败(需已登录 Cindy;详情见下方提示)',
    NETWORK: '网络失败,请稍后重试',
    ACCOUNT_LIMIT: '账号数量已达上限(8 个)',
    VAULT_WRITE_FAILED: '本机加密存储不可用,保存失败',
    LISTEN_FAILED: '本机 53684 端口被占用且无法自动释放,请手动关闭占用它的程序后重试',
    INVALID_CONFIG: '授权配置不合法(需已配置授权服务地址),请更新应用后重试',
    BROKER_FORBIDDEN: '该授权通道仅限官方内置插件使用',
  };

  /** 头像:有 data URL 用 <img>,没有回落姓名首字圆片(同尺寸,布局不跳)。 */
  function renderAvatar(account) {
    if (account.avatarDataUrl && typeof account.avatarDataUrl === 'string') {
      var img = document.createElement('img');
      img.className = 'avatar';
      img.alt = '';
      img.src = account.avatarDataUrl;
      return img;
    }
    var fallback = document.createElement('span');
    fallback.className = 'avatar-fallback';
    fallback.textContent = account.label ? String(account.label).slice(0, 1) : '飞';
    return fallback;
  }

  function renderAccounts(entry) {
    var box = $('accounts');
    box.textContent = '';
    var accounts = (entry && entry.accounts) || [];
    accounts.forEach(function (a) {
      var row = document.createElement('div');
      row.className = 'account';
      row.appendChild(renderAvatar(a));
      var who = document.createElement('span');
      who.className = 'who';
      who.textContent = a.label || '账号 ' + a.id.slice(0, 8);
      row.appendChild(who);
      var tag = document.createElement('span');
      if (a.status === 'expired') {
        tag.className = 'tag expired';
        tag.textContent = '需重新授权';
      } else {
        tag.className = 'tag';
        tag.textContent = a.isDefault ? '默认' : '';
      }
      row.appendChild(tag);
      if (!a.isDefault && a.status !== 'expired') {
        var mkDefault = document.createElement('button');
        mkDefault.className = 'mini';
        mkDefault.type = 'button';
        mkDefault.textContent = '设为默认';
        mkDefault.addEventListener('click', function () {
          void fetch('/oauth/' + KEY + '/default', {
            method: 'POST',
            body: JSON.stringify({ accountId: a.id }),
          }).then(function () { void load(); });
        });
        row.appendChild(mkDefault);
      }
      // 重新授权 = 再跑一次 connect:同身份(union_id)合并语义,主机只换
      // 令牌、复活状态、顺带刷新姓名与头像,不会堆出新账号行。
      var reauth = document.createElement('button');
      reauth.className = 'mini';
      reauth.type = 'button';
      reauth.textContent = '重新授权';
      reauth.addEventListener('click', function () { void connect(); });
      row.appendChild(reauth);
      var disconnect = document.createElement('button');
      disconnect.className = 'mini';
      disconnect.type = 'button';
      disconnect.textContent = '断开';
      disconnect.addEventListener('click', function () {
        void fetch('/oauth/' + KEY + '/accounts/' + encodeURIComponent(a.id), { method: 'DELETE' }).then(function () {
          showStatus('已断开 ' + (a.label || '账号'));
          void load();
        });
      });
      row.appendChild(disconnect);
      box.appendChild(row);
    });
  }

  async function load() {
    try {
      var r = await fetch('/oauth');
      var list = await r.json();
      var entry = null;
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].key === KEY) entry = list[i];
      renderAccounts(entry);
    } catch (e) {
      showStatus('状态加载失败,请稍后重试');
    }
  }

  var connecting = false;
  async function connect() {
    if (connecting) return;
    connecting = true;
    var btn = $('connect');
    btn.disabled = true;
    showStatus('已打开浏览器,请完成飞书授权…', true);
    try {
      var r = await fetch('/oauth/' + KEY + '/connect', { method: 'POST' });
      if (r.status !== 200) {
        showStatus('连接失败(' + r.status + '),请重试');
        return;
      }
      var result = await r.json();
      if (result.ok) {
        showStatus('已连接 ' + (result.account && result.account.label ? result.account.label : '账号'));
      } else {
        var text = CONNECT_ERROR_TEXT[result.error] || '连接失败(' + result.error + '),请重试';
        if (result.detail) text += ':' + result.detail;
        showStatus(text, true);
      }
    } catch (e) {
      showStatus('连接失败,请重试');
    } finally {
      connecting = false;
      btn.disabled = false;
      void load();
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

  $('connect').addEventListener('click', function () { void connect(); });
  $('test').addEventListener('click', function () { void test(); });
  void load();
})();
