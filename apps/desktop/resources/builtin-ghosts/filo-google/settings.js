/**
 * Filo Google 设置页脚本(CSP 禁内联,外挂加载)。
 * 数据面:主机 /oauth 通道(协议保留路径)——
 *   GET  /oauth                                → [{ key, accounts }](零令牌字节)
 *   POST /oauth/google_account/connect         → 主机拉浏览器跑授权(可能等数分钟)
 *   DELETE /oauth/google_account/accounts/<id> → 断开账号
 *   POST /oauth/google_account/default         → { accountId } 设默认
 * 应用身份固定用意识包内置的 Filo OAuth 客户端,本页不收任何凭证;
 * 账号列表只有邮箱/状态元数据。
 */
(function () {
  'use strict';

  var KEY = 'google_account';

  function $(id) { return document.getElementById(id); }

  var statusTimer = null;
  function showStatus(text, sticky) {
    $('status').textContent = text;
    if (statusTimer) clearTimeout(statusTimer);
    if (!sticky) statusTimer = setTimeout(function () { $('status').textContent = ''; }, 4000);
  }

  var CONNECT_ERROR_TEXT = {
    NO_CLIENT_CONFIG: '内置应用身份缺失,请升级 Cindy 后重试',
    TIMEOUT: '授权超时,请重试',
    CANCELLED: '授权已取消',
    CALLBACK_INVALID: '授权回调校验失败,请重试',
    EXCHANGE_FAILED: '令牌交换失败,请稍后重试',
    NETWORK: '网络失败,请稍后重试',
    ACCOUNT_LIMIT: '账号数量已达上限(8 个)',
    VAULT_WRITE_FAILED: '本机加密存储不可用,保存失败',
    LISTEN_FAILED: '本机回调端口监听失败,请重试',
    INVALID_CONFIG: '授权配置不合法,请插件作者检查声明',
  };

  function renderAccounts(entry) {
    var box = $('accounts');
    box.textContent = '';
    var accounts = (entry && entry.accounts) || [];
    accounts.forEach(function (a) {
      var row = document.createElement('div');
      row.className = 'account';
      var email = document.createElement('span');
      email.className = 'email';
      email.textContent = a.label || '账号 ' + a.id.slice(0, 8);
      row.appendChild(email);
      var tag = document.createElement('span');
      if (a.status === 'expired') {
        tag.className = 'tag expired';
        tag.textContent = '需重新连接';
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

  async function connect() {
    var btn = $('connect');
    // 按钮文案不动(改字会变宽,整块布局跳一帧);等待态只用 disabled + 状态行。
    btn.disabled = true;
    showStatus('已打开浏览器,请完成授权…', true);
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
        showStatus(CONNECT_ERROR_TEXT[result.error] || '连接失败(' + result.error + '),请重试');
      }
    } catch (e) {
      showStatus('连接失败,请重试');
    } finally {
      btn.disabled = false;
      void load();
    }
  }

  $('connect').addEventListener('click', function () { void connect(); });
  void load();
})();
