/**
 * XD Mivo 设置页脚本(CSP 禁内联,外挂加载)。
 * 数据面:主机 /secrets 只写通道(绝对路径,协议保留路径)——
 *   GET /secrets              → [{ key, saved, tail? }](只有状态 + 尾 4 位指纹,永远没有值)
 *   PUT /secrets/mivo_api_key → { value } 单向入库(主机 OS 级加密保管)
 *   DELETE /secrets/mivo_api_key → 清除
 * 本页收单不存值:保存成功后清空输入框、点亮「已保存」;明文读不回来,
 * 想换 key 直接粘贴新值覆盖。
 */
(function () {
  'use strict';

  var SECRET_KEY = 'mivo_api_key';

  function $(id) { return document.getElementById(id); }

  var statusTimer = null;
  function showStatus(text) {
    $('status').textContent = text;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { $('status').textContent = ''; }, 2500);
  }

  /**
   * saved = 是否已入库;tail = 主机截存的尾 4 位指纹(帮回忆填的是哪个 key)。
   * 指纹直接进输入框占位文案——已存时空框显示「mivo_…xxxx;粘贴新值可覆盖」,
   * 一眼对上"框里那条就是我存的 key";值太短不产指纹时退回纯「已保存」文案。
   */
  function setSaved(saved, tail) {
    $('savedBadge').className = saved ? 'badge on' : 'badge';
    $('keyInput').placeholder = saved
      ? (tail ? 'mivo_…' + tail + ';粘贴新值可覆盖' : '已保存;粘贴新值可覆盖')
      : '粘贴 mivo_ 开头的 key';
  }

  async function load() {
    try {
      var r = await fetch('/secrets');
      var list = await r.json();
      var entry = Array.isArray(list)
        ? list.filter(function (s) { return s && s.key === SECRET_KEY; })[0]
        : null;
      setSaved(Boolean(entry && entry.saved), entry && typeof entry.tail === 'string' ? entry.tail : null);
    } catch (e) {
      setSaved(false, null);
    }
  }

  /**
   * 眼睛按钮只服务「正在输入的新值」的核对——已存的值永远读不回,空框时
   * 点它必然没反应,干脆藏掉免得被误会成"看已存 key"的坏按钮;隐藏同时
   * 复位密文态,下次粘贴默认遮蔽。
   */
  function syncEye() {
    var input = $('keyInput');
    var eye = $('eye');
    var empty = input.value.length === 0;
    eye.classList.toggle('hidden', empty);
    if (empty) {
      input.type = 'password';
      eye.classList.remove('revealed');
    }
  }

  async function save() {
    var value = $('keyInput').value.trim();
    if (!value) {
      showStatus('先粘贴 key 再保存');
      return;
    }
    try {
      var r = await fetch('/secrets/' + SECRET_KEY, {
        method: 'PUT',
        body: JSON.stringify({ value: value }),
      });
      if (r.status === 204) {
        // 收单即焚:值已单向入库,页面不留明文;尾指纹从 /secrets 回查
        // (不用手上的明文现算,与"页面不留值"的口径一致)。
        $('keyInput').value = '';
        syncEye();
        setSaved(true, null);
        void load();
        showStatus('凭证已保存');
      } else {
        showStatus('保存失败(' + r.status + '),请重试');
      }
    } catch (e) {
      showStatus('保存失败,请重试');
    }
  }

  async function clearSecret() {
    try {
      var r = await fetch('/secrets/' + SECRET_KEY, { method: 'DELETE' });
      if (r.status === 204) {
        $('keyInput').value = '';
        syncEye();
        setSaved(false, null);
        showStatus('凭证已清除');
      } else {
        showStatus('清除失败(' + r.status + '),请重试');
      }
    } catch (e) {
      showStatus('清除失败,请重试');
    }
  }

  $('eye').addEventListener('click', function () {
    var input = $('keyInput');
    var reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    $('eye').classList.toggle('revealed', reveal);
  });
  $('keyInput').addEventListener('input', syncEye);
  $('save').addEventListener('click', function () { void save(); });
  $('clear').addEventListener('click', function () { void clearSecret(); });
  syncEye();
  void load();
})();
