/**
 * 画廊面板:启动时向自己的专属通道拉一次画廊清单重建墙面(重启回放),
 * 之后继续听电子脑广播挂新作品。布局是 CSS 瀑布流(panel.css)。
 *
 * v1.7.0 起面板自绘右键菜单(查看大图 / 再画一张 / 改这张图 / 让它动起来):
 * 菜单动作经同源广播(panel-request)递给电子脑,由电子脑转 cindy-request
 * 请主机代办——面板零桥,自己发不了,这是唯一合法的路。
 * Shift+右键不接管,放行给宿主原生菜单(复制文件 / 打开所在目录是宿主 OS
 * 能力,沙箱做不了,别抢)。
 */

var wall = document.getElementById('wall'); // 滚动容器(滚动条显隐用)
var flow = document.getElementById('flow'); // 分列容器(卡片都插这里)
var empty = document.getElementById('empty');

/** 已上墙地址集合:回放与实时广播之间按 src 去重。 */
var hung = {};

/** 从地址里抠 64 位指纹(菜单动作把它递给电子脑当源图)。 */
function extractHash(s) {
  if (typeof s !== 'string') return null;
  var m = s.match(/[0-9a-f]{64}/);
  return m ? m[0] : null;
}

function hang(src, caption, append) {
  if (typeof src !== 'string' || src.indexOf('cindy-ghost://cindy-art/media/') !== 0) return;
  if (hung[src]) return;
  hung[src] = true;

  if (empty) {
    empty.remove();
    empty = null;
  }

  var capText = typeof caption === 'string' ? caption : '';
  var isVideo = /\.(mp4|webm)$/.test(src);

  var fig = document.createElement('figure');
  fig.className = 'artwork';
  // 右键菜单的数据源:地址(抠指纹)、描述(重绘用)、类别。
  fig.dataset.src = src;
  fig.dataset.caption = capText;
  fig.dataset.video = isVideo ? '1' : '';

  if (isVideo) {
    // 视频卡与图片同款交互:缩略(无 controls,CSS pointer-events:none 让点击
    // 落在链接上)包进 /preview/ 链接,hover 提示可点 + 中央播放角标,点击由
    // 主机弹视频播放器 lightbox(手册 §5)。
    var video = document.createElement('video');
    video.src = src;
    video.preload = 'metadata';
    video.muted = true;

    var vlink = document.createElement('a');
    vlink.className = 'artwork-link';
    vlink.style.position = 'relative';
    vlink.href = src.replace('/media/', '/preview/');
    vlink.appendChild(video);

    var badge = document.createElement('span');
    badge.className = 'artwork-video-badge';
    vlink.appendChild(badge);

    // 拖起来与图片同款好看:拖影用首帧位图(拖 <a> 的默认拖影是一条 URL
    // 文字,<video> 元素直接当拖影在合成层上常拍成黑块,都丑)。
    vlink.addEventListener('dragstart', function (e) {
      e.dataTransfer.setData('text/uri-list', src);
      e.dataTransfer.setData('text/plain', src);
      var rect = vlink.getBoundingClientRect();
      var ox = e.clientX - rect.left;
      var oy = e.clientY - rect.top;
      // 首帧已解码才画得出来;canvas 要挂在文档里才能当拖影,塞屏外用完即弃。
      if (video.readyState >= 2 && video.videoWidth > 0 && rect.width > 0) {
        var dpr = window.devicePixelRatio || 1;
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
        canvas.style.position = 'fixed';
        canvas.style.left = '-10000px';
        canvas.style.top = '0';
        try {
          var ctx = canvas.getContext('2d');
          ctx.scale(dpr, dpr);
          // 圆角与卡片(10px)对齐,拖影不带直角毛边。
          if (typeof ctx.roundRect === 'function') {
            ctx.beginPath();
            ctx.roundRect(0, 0, rect.width, rect.height, 10);
            ctx.clip();
          }
          ctx.drawImage(video, 0, 0, rect.width, rect.height);
          document.body.appendChild(canvas);
          e.dataTransfer.setDragImage(canvas, ox, oy);
          setTimeout(function () { canvas.remove(); }, 0);
          return;
        } catch (err) {
          canvas.remove();
        }
      }
      // 兜底:整卡快照当拖影(至少不是 URL 文字)。
      e.dataTransfer.setDragImage(vlink, ox, oy);
    });

    fig.appendChild(vlink);
  } else {
    var img = document.createElement('img');
    img.src = src;
    img.alt = capText;
    img.draggable = false;

    // 点图看大图:/media/ 换 /preview/ 的声明式链接,用户点击时主机拦下
    // 导航、查账验归属后在主窗口弹统一 lightbox(手册 §5;脚本自动跳转无效)。
    var link = document.createElement('a');
    link.className = 'artwork-link';
    link.href = src.replace('/media/', '/preview/');
    link.appendChild(img);

    // 拖进聊天(手册 §5 引渡):dragstart 显式塞 /media/ 地址,主机验归属后
    // 落为聊天输入框附件。塞的仍是指纹地址字符串,不是字节。
    link.addEventListener('dragstart', function (e) {
      e.dataTransfer.setData('text/uri-list', src);
      e.dataTransfer.setData('text/plain', src);
      var rect = img.getBoundingClientRect();
      e.dataTransfer.setDragImage(img, e.clientX - rect.left, e.clientY - rect.top);
    });
    fig.appendChild(link);
  }

  var cap = document.createElement('figcaption');
  cap.textContent = capText;
  // 提示词可能很长,默认两行截断(panel.css line-clamp):
  // - 悬停原生 tooltip 看全文;
  // - 真被裁掉时(布局后量一次 scrollHeight)标记 is-clamped,点击展开/收起。
  if (capText) {
    cap.title = capText;
    cap.addEventListener('click', function () {
      if (cap.classList.contains('is-expanded')) {
        cap.classList.remove('is-expanded');
      } else if (cap.classList.contains('is-clamped')) {
        cap.classList.add('is-expanded');
      }
    });
    requestAnimationFrame(function () {
      if (cap.scrollHeight > cap.clientHeight + 1) cap.classList.add('is-clamped');
    });
  }

  fig.appendChild(cap);
  // 实时新作挂最前(瀑布流自动回流);回放清单本身已是新在前,依序追加即可。
  if (append) flow.appendChild(fig);
  else flow.insertBefore(fig, flow.firstChild);
}

// 滚动条自动显隐:与主机 lib/scrollbarAutoHide 同节奏——滚动即显形,
// 2 秒无活动隐去(thumb 颜色规则在 panel.css,用主机同款 token)。
var scrollIdleTimer = null;
wall.addEventListener(
  'scroll',
  function () {
    wall.classList.add('is-scrolling');
    if (scrollIdleTimer !== null) clearTimeout(scrollIdleTimer);
    scrollIdleTimer = setTimeout(function () {
      scrollIdleTimer = null;
      wall.classList.remove('is-scrolling');
    }, 2000);
  },
  { passive: true },
);

/* ══════════════════ 右键菜单(自绘)══════════════════ */

var menuEl = null;
function closeMenu() {
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
  }
}

/** 在 (x, y) 弹菜单;items = [{label, run}],位置贴边自动收进视口。 */
function showMenu(x, y, items) {
  closeMenu();
  menuEl = document.createElement('div');
  menuEl.className = 'ctxmenu';
  for (var i = 0; i < items.length; i++) {
    (function (item) {
      var btn = document.createElement('button');
      btn.className = 'ctxmenu-item';
      btn.type = 'button';
      btn.textContent = item.label;
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        closeMenu();
        item.run();
      });
      menuEl.appendChild(btn);
    })(items[i]);
  }
  document.body.appendChild(menuEl);
  var rect = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)) + 'px';
  menuEl.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) + 'px';
}

document.addEventListener('click', closeMenu);
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    closeMenu();
    closeDialog();
  }
});
wall.addEventListener('scroll', closeMenu, { passive: true });
window.addEventListener('blur', closeMenu);

flow.addEventListener('contextmenu', function (e) {
  var fig = e.target && e.target.closest ? e.target.closest('.artwork') : null;
  if (!fig) return; // 空白处不接管
  if (e.shiftKey) return; // Shift+右键放行:宿主原生菜单(复制文件/打开目录)
  e.preventDefault();
  closeDialog();

  var src = fig.dataset.src || '';
  var caption = fig.dataset.caption || '';
  var isVideo = fig.dataset.video === '1';
  var hash = extractHash(src);
  var link = fig.querySelector('a.artwork-link');

  var items = [];
  // 查看大图/播放:复用卡片自带的 /preview/ 链接(用户手势语境内,主机放行)。
  items.push({
    label: isVideo ? '播放' : '查看大图',
    run: function () {
      if (link) link.click();
    },
  });
  if (caption) {
    items.push({
      label: isVideo ? '再来一段(同描述重生成)' : '再画一张(同描述重绘)',
      run: function () {
        sendPanelRequest(isVideo ? 'gen_video' : 'gen_image', caption, null);
      },
    });
  }
  if (!isVideo && hash) {
    items.push({
      label: '改这张图…',
      run: function () {
        openDialog('怎么改这张图?', function (p) {
          sendPanelRequest('edit_image', p, hash);
        });
      },
    });
    items.push({
      label: '让它动起来…',
      run: function () {
        openDialog('想让画面怎么动?', function (p) {
          sendPanelRequest('edit_video', p, hash);
        });
      },
    });
  }
  showMenu(e.clientX, e.clientY, items);
});

/* ══════════════════ 提示词输入框(菜单二级)══════════════════ */

var dlgEl = null;
function closeDialog() {
  if (dlgEl) {
    dlgEl.remove();
    dlgEl = null;
  }
}

function openDialog(title, onSubmit) {
  closeDialog();
  dlgEl = document.createElement('div');
  dlgEl.className = 'dlg-overlay';
  dlgEl.addEventListener('click', function (e) {
    if (e.target === dlgEl) closeDialog();
  });

  var box = document.createElement('div');
  box.className = 'dlg';

  var head = document.createElement('div');
  head.className = 'dlg-title';
  head.textContent = title;
  box.appendChild(head);

  var input = document.createElement('textarea');
  input.className = 'dlg-input';
  input.rows = 3;
  input.placeholder = '描述得越具体效果越好;Enter 提交,Shift+Enter 换行';
  box.appendChild(input);

  var row = document.createElement('div');
  row.className = 'dlg-row';
  var cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'dlg-btn';
  cancel.textContent = '取消';
  cancel.addEventListener('click', closeDialog);
  var okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.className = 'dlg-btn dlg-btn-primary';
  okBtn.textContent = '开工';
  var submit = function () {
    var val = input.value.trim();
    if (!val) {
      input.focus();
      return;
    }
    closeDialog();
    onSubmit(val);
  };
  okBtn.addEventListener('click', submit);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  row.appendChild(cancel);
  row.appendChild(okBtn);
  box.appendChild(row);

  dlgEl.appendChild(box);
  document.body.appendChild(dlgEl);
  input.focus();
}

/* ══════════════════ toast 与请求跟踪 ══════════════════ */

var toastStack = document.createElement('div');
toastStack.className = 'toast-stack';
document.body.appendChild(toastStack);

function toast(text, opts) {
  var el = document.createElement('div');
  el.className = 'toast' + (opts && opts.error ? ' is-error' : '');
  el.textContent = text;
  toastStack.appendChild(el);
  if (!opts || !opts.sticky) {
    setTimeout(function () {
      el.remove();
    }, 4000);
  }
  return el;
}

/** 在途请求:reqId → { toast, kind, ackTimer }。 */
var pending = {};
var KIND_LABEL = {
  gen_image: '重绘',
  edit_image: '改图',
  gen_video: '生成视频',
  edit_video: '图生视频',
};

/** 收到回执/结果后停掉一条请求的重发与超时计时器。 */
function stopEntryTimers(entry) {
  if (entry.ackTimer !== null) clearTimeout(entry.ackTimer);
  if (entry.repostTimer !== null) clearInterval(entry.repostTimer);
  entry.ackTimer = null;
  entry.repostTimer = null;
}

/**
 * 菜单动作统一出口:广播 panel-request 给电子脑,由它转 cindy-request。
 * 电子脑是按需拉起的,面板刚打开时多半没在跑、广播没人听——所以:
 * ① 先 fetch 自己协议的 /wake 请主机拉起电子脑(幂等,已在跑立即返回);
 * ② 广播请求,并每 700ms 重发一次(电子脑按 reqId 去重),给冷启动留时间;
 * ③ 6 秒仍无回执(panel-ack)才判失败,如实提示绕行路径。
 */
function sendPanelRequest(kind, prompt, hash) {
  var reqId = 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  var label = KIND_LABEL[kind] || kind;
  var t = toast(label + ':联系电子脑…', { sticky: true });
  var msg = { type: 'panel-request', reqId: reqId, kind: kind, prompt: prompt };
  if (hash) msg.hash = hash;

  // 叫醒电子脑(手册 §5 /wake):失败不阻断——老版本主机没有这个分支时
  // 退化为原行为(靠聊天里用一次拉起),由下面的超时提示兜底。
  fetch('cindy-ghost://cindy-art/wake').catch(function () {});

  var entry = {
    toast: t,
    kind: kind,
    repostTimer: setInterval(function () {
      channel.postMessage(msg);
    }, 700),
    ackTimer: setTimeout(function () {
      stopEntryTimers(entry);
      delete pending[reqId];
      t.classList.add('is-error');
      t.textContent = '叫不醒电子脑:先在聊天里让 Cindy 用一次本意识(比如「$cindy-art 画一只猫」),再来点菜单。';
      setTimeout(function () {
        t.remove();
      }, 6000);
    }, 6000),
  };
  pending[reqId] = entry;
  channel.postMessage(msg);
}

/* ══════════════════ 广播与回放 ══════════════════ */

// 先订阅实时广播,再拉回放清单——顺序保证两者交叠窗口里不丢新作(去重兜底)。
var channel = new BroadcastChannel('cindy-art');
channel.onmessage = function (event) {
  var msg = event.data;
  if (!msg) return;
  if (msg.type === 'artwork') {
    hang(msg.src, msg.caption, false);
    return;
  }
  // 以下都是 panel-request 的回执链,按 reqId 对号。
  var entry = typeof msg.reqId === 'string' ? pending[msg.reqId] : null;
  if (!entry) return;
  if (msg.type === 'panel-ack') {
    stopEntryTimers(entry);
    var isVideoKind = entry.kind === 'gen_video' || entry.kind === 'edit_video';
    entry.toast.textContent =
      (KIND_LABEL[entry.kind] || entry.kind) + ':生成中…' + (isVideoKind ? '(视频要几分钟,别关面板)' : '');
  } else if (msg.type === 'panel-done') {
    stopEntryTimers(entry);
    delete pending[msg.reqId];
    entry.toast.textContent =
      (KIND_LABEL[entry.kind] || entry.kind) + ':完成' + (msg.modelLabel ? '(' + msg.modelLabel + ')' : '');
    (function (el) {
      setTimeout(function () {
        el.remove();
      }, 3000);
    })(entry.toast);
  } else if (msg.type === 'panel-fail') {
    stopEntryTimers(entry);
    delete pending[msg.reqId];
    entry.toast.classList.add('is-error');
    entry.toast.textContent =
      (KIND_LABEL[entry.kind] || entry.kind) + ':失败——' + (typeof msg.message === 'string' ? msg.message : '未知原因');
    (function (el) {
      setTimeout(function () {
        el.remove();
      }, 6000);
    })(entry.toast);
  }
};

// 重启回放:主机按账本(ghost-gallery 引用)返回本意识的墙面清单。
fetch('cindy-ghost://cindy-art/gallery')
  .then(function (res) { return res.ok ? res.json() : []; })
  .then(function (items) {
    if (!Array.isArray(items)) return;
    for (var i = 0; i < items.length; i++) {
      hang(items[i] && items[i].src, items[i] && items[i].caption, true);
    }
  })
  .catch(function () {
    // 清单拉不到(账本未就绪等)不影响空态与后续实时广播。
  });
