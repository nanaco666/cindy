/**
 * Cindy Mermaid · 电子脑 —— Mermaid 源码的确定性规范化与常见语法修复。
 *
 * 沙箱里没有 DOM / Mermaid parser，因此这里只做纯字符串变换；完整语法与
 * 渲染校验仍由聊天端的 Mermaid 渲染器负责。修复规则与 maker-shared 的
 * mermaidAutofix 保持一致，配套测试会阻止两份实现静默漂移。
 */

/* global cindy */

var MAX_SOURCE_LENGTH = 100000;
var MAX_LINE_LENGTH = 2000;
var UNICODE_ARROW_RE = /[→⟶➔➜⇒⟹]/g;
var NODE_LABEL_DANGER_RE = /[:;=&#<>(){}[\]\\/→⟶➔➜⇒⟹]/;
var SHAPE_MODIFIER_HEAD = { '(': true, '{': true, '[': true, '/': true, '\\': true };

/** 只改双引号外的片段，避免破坏已经受保护的标签内容。 */
function mapOutsideQuotes(line, fn) {
  return line
    .split('"')
    .map(function (part, index) {
      return index % 2 === 0 ? fn(part) : part;
    })
    .join('"');
}

/** 跳过 frontmatter 与注释，按第一个有效行判断是否为 flowchart / graph。 */
function isFlowchartSource(lines) {
  var start = 0;
  if (lines[0] && lines[0].trim() === '---') {
    for (var i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === '---') {
        start = i + 1;
        break;
      }
    }
  }
  for (var j = start; j < lines.length; j += 1) {
    var text = lines[j].trim();
    if (!text || text.indexOf('%%') === 0) continue;
    return /^(flowchart|graph)\b/.test(text);
  }
  return false;
}

function quoteEdgeLabels(segment) {
  return segment.replace(/\|([^|\"]+)\|/g, function (full, label) {
    var trimmed = label.trim();
    return trimmed ? '|"' + trimmed + '"|' : full;
  });
}

function makeNodeLabelQuoter(re, open, close) {
  return function (segment) {
    return segment.replace(re, function (full, id, label) {
      if (SHAPE_MODIFIER_HEAD[label.charAt(0)]) return full;
      if (!NODE_LABEL_DANGER_RE.test(label)) return full;
      return id + open + '"' + label + '"' + close;
    });
  };
}

var quoteSquareLabels = makeNodeLabelQuoter(/([A-Za-z0-9_-]+)\[([^\[\]"|]+)\]/g, '[', ']');
var quoteRoundLabels = makeNodeLabelQuoter(/([A-Za-z0-9_-]+)\(([^()"|]+)\)/g, '(', ')');
var quoteCurlyLabels = makeNodeLabelQuoter(/([A-Za-z0-9_-]+)\{([^{}"|]+)\}/g, '{', '}');

/** 与 maker-shared/mermaidAutofix 相同的纯字符串修复。 */
function repairMermaidSource(source) {
  var lines = source.split('\n');
  var flowchart = isFlowchartSource(lines);
  return lines
    .map(function (line) {
      if (/^\s*\/\//.test(line)) return line.replace(/^(\s*)\/\//, '$1%%');
      if (!flowchart) return line;
      var trimmed = line.trim();
      if (!trimmed || trimmed.indexOf('%%') === 0) return line;
      var fixed = line.replace(/^(\s*subgraph\s+[A-Za-z0-9_-]+)\[/, '$1 [');
      fixed = mapOutsideQuotes(fixed, quoteEdgeLabels);
      fixed = mapOutsideQuotes(fixed, quoteSquareLabels);
      fixed = mapOutsideQuotes(fixed, quoteRoundLabels);
      fixed = mapOutsideQuotes(fixed, quoteCurlyLabels);
      fixed = mapOutsideQuotes(fixed, function (segment) {
        return segment.replace(UNICODE_ARROW_RE, '-->');
      });
      return fixed;
    })
    .join('\n');
}

/** 统一文本外壳；只解包覆盖整份输入的一层 Mermaid fence。 */
function normalizeSource(source) {
  // 去 BOM 用 charCode 显式判断(0xFEFF),避免正则里出现肉眼不可见的字面量。
  var normalized = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  normalized = normalized.replace(/\r\n?/g, '\n');
  var lines = normalized.split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

  if (lines.length >= 2) {
    var opening = lines[0].trim().match(/^(`{3,})(?:mermaid|mmd)\s*$/i);
    var closing = lines[lines.length - 1].trim().match(/^(`{3,})$/);
    if (opening && closing && closing[1].length >= opening[1].length) {
      lines.shift();
      lines.pop();
      while (lines.length && !lines[0].trim()) lines.shift();
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    }
  }
  return lines.join('\n');
}

/** 选择不会被源码中反引号提前闭合的 Markdown fence。 */
function fenceFor(source) {
  var longest = 0;
  var runs = source.match(/`+/g) || [];
  runs.forEach(function (run) {
    if (run.length > longest) longest = run.length;
  });
  return new Array(Math.max(3, longest + 1) + 1).join('`');
}

function fail(callId, message) {
  cindy.send({ type: 'tool-result', callId: callId, ok: false, message: message });
}

cindy.onHostMessage(function (msg) {
  if (!msg || msg.type !== 'tool-call') return;
  if (msg.tool !== 'prepare_mermaid') {
    fail(msg.callId, 'UNKNOWN_TOOL: 未知工具 ' + msg.tool);
    return;
  }

  try {
    if (!msg.args || typeof msg.args.source !== 'string') {
      fail(msg.callId, 'INVALID_SOURCE: source 必须是 Mermaid 源码字符串');
      return;
    }
    var normalized = normalizeSource(msg.args.source);
    if (!normalized.trim()) {
      fail(msg.callId, 'INVALID_SOURCE: source 不能为空');
      return;
    }
    if (normalized.length > MAX_SOURCE_LENGTH) {
      fail(msg.callId, 'SOURCE_TOO_LARGE: source 最多 100000 个字符');
      return;
    }
    var lines = normalized.split('\n');
    if (lines.some(function (line) { return line.length > MAX_LINE_LENGTH; })) {
      fail(msg.callId, 'LINE_TOO_LONG: Mermaid 单行最多 2000 个字符');
      return;
    }

    var repaired = repairMermaidSource(normalized);
    var fence = fenceFor(repaired);
    cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: true,
      result: {
        markdown: fence + 'mermaid\n' + repaired + '\n' + fence,
        source: repaired,
        changed: repaired !== normalized,
        validation: 'not-performed',
        note: '已做确定性规范化与常见语法修复；未调用 Mermaid 引擎执行 parse 或 render 校验。',
      },
    });
  } catch (err) {
    fail(msg.callId, 'INTERNAL_ERROR: Mermaid 源码整理失败：' + (err && err.message ? err.message : String(err)));
  }
});
