/* 会话哨兵面板逻辑 —— 只收电子脑广播,零输入控件(被动画布)。 */
(function () {
  var wall = new BroadcastChannel('session-sentinel');
  var linesEl = document.getElementById('lines');
  var emptyEl = document.getElementById('empty');
  var turnsEl = document.getElementById('turns');
  var inEl = document.getElementById('in');
  var outEl = document.getElementById('out');
  var curEl = document.getElementById('cur');

  function renderStat(stat) {
    if (!stat) return;
    turnsEl.textContent = String(stat.turns || 0);
    inEl.textContent = String(stat.inputTokens || 0);
    outEl.textContent = String(stat.outputTokens || 0);
    if (curEl) curEl.textContent = stat.currentSession ? stat.currentSession + '…' : '—';
  }

  function addLine(text) {
    if (emptyEl) emptyEl.style.display = 'none';
    var li = document.createElement('li');
    li.textContent = text;
    if (text.indexOf('✋') === 0) li.className = 'block';
    linesEl.insertBefore(li, linesEl.firstChild); // 新的在上
    while (linesEl.childNodes.length > 30) linesEl.removeChild(linesEl.lastChild);
  }

  wall.onmessage = function (event) {
    var msg = event.data;
    if (!msg) return;
    if (msg.type === 'feed') {
      addLine(msg.line);
      renderStat(msg.stat);
    } else if (msg.type === 'snapshot') {
      // 面板(重)打开:电子脑常驻,补发累计快照。
      renderStat(msg.stat);
      if (Array.isArray(msg.feed)) {
        for (var i = 0; i < msg.feed.length; i++) addLine(msg.feed[i]);
      }
    }
  };

  // 面板刚开就跟常驻电子脑要一次快照(它可能早就在收事件了)。
  wall.postMessage({ type: 'snapshot-request' });
})();
