/**
 * XD Pages 设置页脚本(CSP 禁内联,外挂加载)。
 * 只读身份展示:GET /secrets 找 pages_token 条目,identity 字段 = 当前登录
 * 邮箱(主机现读登录态回的;派生凭证不可配置,本页没有任何输入动作)。
 * 未登录 / 登录态没有邮箱时 saved:false 无 identity,提示重新登录。
 */
(function () {
  'use strict';

  var SECRET_KEY = 'pages_token';

  async function load() {
    var el = document.getElementById('identity-email');
    try {
      var r = await fetch('/secrets');
      var list = await r.json();
      var entry = Array.isArray(list)
        ? list.filter(function (s) { return s && s.key === SECRET_KEY; })[0]
        : null;
      if (entry && entry.saved && typeof entry.identity === 'string' && entry.identity) {
        el.textContent = entry.identity;
      } else {
        el.textContent = '未登录或登录态没有邮箱,请重新登录后再来';
      }
    } catch (e) {
      el.textContent = '身份读取失败,请稍后重试';
    }
  }

  void load();
})();
