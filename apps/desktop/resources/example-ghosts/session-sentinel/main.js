/**
 * 会话哨兵 · 电子脑 —— 订阅槽①(旁听 + 双向钩子)的验证意识,五种能力一站验完:
 *
 * - 旁听 turn(did-turn-start/end):累计轮次 + token 用量,面板画流水;
 * - 旁听会话生命周期(did-session-created/archived):流水记一笔;
 * - 旁听会话切换(did-session-switched):面板顶部实时显示"台前会话";
 * - 入口钩子(will-user-message):敏感词 block / 「润色」开头 rewrite / 其余 allow;
 * - 出口钩子(will-assistant-message):AI 回复含 [[卡片]] → render 自绘卡片
 *   (保留"查看原文");含 [[润色]] → rewrite 改写回复;含 [[慢处理]] → 8 秒后
 *   放行(演示"意识处理中"指示);其余 allow。
 *
 * launch:resident —— 钩子要求常驻在场(否则每条消息等冷启动)。全程只经手
 * 事件元数据与正文字符串,摸不到文件/网络/其它意识(平台结构保证)。
 */

/* global cindy */

// 与面板同源广播频道(面板被动收流水;频道名按 origin 隔离)。
var wall = new BroadcastChannel('session-sentinel');

// 敏感词表(验证用,写死即可):正文命中任一即拦。
var BLOCK_WORDS = ['机密', '密钥', '内部代号'];

// 旁听累计(仅内存,面板重开时电子脑补发快照)。currentSession = 台前会话
// id 前 8 位(did-session-switched 维护,面板顶部展示)。
var stat = { turns: 0, inputTokens: 0, outputTokens: 0, lastReason: '', currentSession: '' };
var feed = []; // 最近事件流水(最多 30 条)

// HTML 转义(自绘卡片里嵌 AI 回复摘录用;卡片是静态 HTML,嵌入文本必须转义)。
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 出口钩子 render 演示卡:摘录回复 + 统计,配色用主机注入的主题变量(带回退值,
// 跟随 light/dark/扩展主题)。只用净化器白名单标签(div/p/small),零脚本零外链。
function buildReplyCard(reply) {
  var body = reply.split('[[卡片]]').join('').trim();
  var excerpt = body.length > 160 ? body.slice(0, 160) + '…' : body;
  return (
    '<div style="padding:14px 16px;background:var(--surface, #f7f7f5);color:var(--text-primary, #1a1a1a)">' +
    '<div style="font-size:10px;letter-spacing:1.2px;color:var(--text-tertiary, #999)">SENTINEL · 出口钩子自绘卡片</div>' +
    '<p style="margin:8px 0 10px;font-size:14px;line-height:1.6">' + esc(excerpt) + '</p>' +
    '<div style="padding:8px 10px;border-radius:8px;background:var(--surface-chip, #ececea);font-size:11px;line-height:1.6;color:var(--text-secondary, #666)">' +
    '本轮回复共 ' + body.length + ' 字 · 此卡由「会话哨兵」出口钩子渲染,替换了默认气泡;点下方「查看原文」可切回 AI 原始回复。卡片配色跟随主机主题。' +
    '</div></div>'
  );
}

function pushFeed(line) {
  feed.push(line);
  if (feed.length > 30) feed.shift();
  wall.postMessage({ type: 'feed', line: line, stat: stat });
}

cindy.onHostMessage(function (msg) {
  if (!msg || msg.type !== 'event') return;

  // ── did- 旁听:收到就收到,不回话 ──
  if (msg.name === 'did-turn-start') {
    pushFeed('▶ turn 开始 · ' + (msg.data && msg.data.agent ? msg.data.agent : '?'));
    return;
  }
  if (msg.name === 'did-turn-end') {
    stat.turns += 1;
    var u = (msg.data && msg.data.usage) || {};
    if (typeof u.inputTokens === 'number') stat.inputTokens += u.inputTokens;
    if (typeof u.outputTokens === 'number') stat.outputTokens += u.outputTokens;
    stat.lastReason = (msg.data && msg.data.endReason) || '';
    var dur = msg.data && typeof msg.data.durationMs === 'number' ? Math.round(msg.data.durationMs / 100) / 10 : '?';
    pushFeed('■ turn 结束 · ' + stat.lastReason + ' · ' + dur + 's');
    return;
  }
  if (msg.name === 'did-session-created') {
    pushFeed('＋ 会话创建');
    return;
  }
  if (msg.name === 'did-session-archived') {
    pushFeed('－ 会话归档');
    return;
  }
  if (msg.name === 'did-session-switched') {
    // 用户把某会话切到台前(连续停留同一会话主机不重发)。id 只取前 8 位展示。
    var sid = (msg.data && msg.data.sessionId) || '';
    stat.currentSession = sid ? sid.slice(0, 8) : '';
    pushFeed('👁 切到会话 ' + (stat.currentSession || '?'));
    return;
  }

  // ── will-user-message 钩子:3 秒内必须回裁决,否则主机按放行处理 ──
  // 演示 hook 的三种收尾——block(打回)/ rewrite(优化后继续)/ allow(原样继续):
  if (msg.name === 'will-user-message') {
    var text = (msg.data && typeof msg.data.text === 'string') ? msg.data.text : '';

    // ① block:命中敏感词直接打回(带理由,主机在被拦气泡上署名展示)。
    var hit = null;
    for (var i = 0; i < BLOCK_WORDS.length; i++) {
      if (text.indexOf(BLOCK_WORDS[i]) !== -1) { hit = BLOCK_WORDS[i]; break; }
    }
    if (hit) {
      pushFeed('✋ 拦下含「' + hit + '」的消息');
      // reason 会被主机原样显示在消息下方的红条里(不加框、不署名),所以写成
      // 一句完整的话——包含敏感词就发不出去,改掉再发。
      cindy.send({
        type: 'event-verdict', hookId: msg.hookId,
        action: 'block',
        reason: '会话哨兵拦下了这条消息:含敏感词「' + hit + '」,发不出去。改掉后可用编辑铅笔重发。',
      });
      return;
    }

    // ② rewrite:以「润色」开头 = 提示词优化演示。剥掉前缀,把口语问题包装成
    //    结构化 prompt 再放行——用户气泡显示优化版 + 留痕,AI 收到的也是优化版。
    //    真实场景这里可以先经 network 槽过一遍改写/合规接口再定 text。
    if (text.indexOf('润色') === 0) {
      var body = text.slice('润色'.length).replace(/^[:：\s]+/, '').trim();
      if (body.length > 0) {
        var polished =
          '请用专业、结构化的方式回答以下问题,先给一句话结论,再分点展开:\n\n' + body;
        pushFeed('✎ 优化了提示词');
        cindy.send({ type: 'event-verdict', hookId: msg.hookId, action: 'rewrite', text: polished });
        return;
      }
    }

    // ③ allow:其余原样放行(纯执行副作用的钩子也走这条:记完账放行)。
    cindy.send({ type: 'event-verdict', hookId: msg.hookId, action: 'allow' });
    return;
  }

  // ── will-assistant-message 出口钩子:AI 回复完成后交到这里,处理完原地更新 ──
  // 触发方式全靠回复正文里的暗号(让 AI 原样输出即可,见面板提示):
  //   [[卡片]]   → render:自绘卡片替换 AI 气泡(原文保留,可"查看原文");
  //   [[润色]]   → rewrite:改写回复正文(静默替换,所见即最终);
  //   [[慢处理]] → 演示"意识处理中"指示:8 秒后放行原文(超时上限 5 分钟);
  //   其余       → allow 原样定案。
  if (msg.name === 'will-assistant-message') {
    var reply = (msg.data && typeof msg.data.text === 'string') ? msg.data.text : '';

    if (reply.indexOf('[[卡片]]') !== -1) {
      pushFeed('🎴 自绘了 AI 回复卡片');
      cindy.send({
        type: 'event-verdict', hookId: msg.hookId,
        action: 'render', html: buildReplyCard(reply), height: 220,
      });
      return;
    }

    if (reply.indexOf('[[润色]]') !== -1) {
      var polishedReply = reply.split('[[润色]]').join('').trim() +
        '\n\n---\n*本回复已由「会话哨兵」出口钩子改写(rewrite 演示:你看到的这段脚注就是改写产物)。*';
      pushFeed('✨ 润色了 AI 回复');
      cindy.send({ type: 'event-verdict', hookId: msg.hookId, action: 'rewrite', text: polishedReply });
      return;
    }

    if (reply.indexOf('[[慢处理]]') !== -1) {
      // 故意拖 8 秒再放行:气泡下方应出现"意识处理中…"并在放行后消失。
      pushFeed('⏳ 慢处理演示:8 秒后放行');
      setTimeout(function () {
        cindy.send({ type: 'event-verdict', hookId: msg.hookId, action: 'allow' });
        pushFeed('⏳ 慢处理结束,已放行原文');
      }, 8000);
      return;
    }

    cindy.send({ type: 'event-verdict', hookId: msg.hookId, action: 'allow' });
    return;
  }
});

// 面板打开时来要一次快照(电子脑常驻,面板可能后开)。
wall.onmessage = function (event) {
  if (event.data && event.data.type === 'snapshot-request') {
    wall.postMessage({ type: 'snapshot', feed: feed, stat: stat });
  }
};

// 开机自检(失败不影响后续)。
cindy.ping().catch(function () {});
