/**
 * slack/mrkdwn.ts — GitHub-flavored markdown → Slack mrkdwn 的实用转换。
 * ---------------------------------------------------------------------------
 * Slack 消息不渲染标准 markdown, 用自家 mrkdwn 方言:
 *   *bold*  _italic_  ~strike~  `code`  ```fence```  <url|label>  • list
 *
 * 转换是"尽力而为"的降级(表格 / 嵌套列表等高级结构 Slack 没有等价物,
 * 保持原文输出);代码块/行内代码内部不做任何替换。行为用单测钉死。
 */

interface Segment {
  kind: 'code' | 'text';
  content: string;
}

/** 把文本按 ``` 代码栅栏切段 — code 段原样保留, 只转换 text 段。 */
function splitByCodeFence(text: string): Segment[] {
  const segments: Segment[] = [];
  const re = /```[\s\S]*?(?:```|$)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) segments.push({ kind: 'text', content: text.slice(last, idx) });
    segments.push({ kind: 'code', content: m[0] });
    last = idx + m[0].length;
  }
  if (last < text.length) segments.push({ kind: 'text', content: text.slice(last) });
  return segments;
}

/** 单个 text 段的逐行转换(不含代码栅栏)。 */
function convertTextSegment(seg: string): string {
  // 行内 code 也要保护 — 先抽出来占位, 转换后回填
  const inlineCodes: string[] = [];
  let out = seg.replace(/`[^`\n]+`/g, (m) => {
    inlineCodes.push(m);
    return `\u0000IC${inlineCodes.length - 1}\u0000`;
  });

  // 链接 [label](url) → <url|label>(图片 ![..](..) 不动 — xdt-image 等由
  // streamingText 层单独处理, 其它图片链接 Slack 也不内联)
  out = out.replace(/(?<!!)\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<$2|$1>');

  // 粗体 **x** / __x__ → *x*
  out = out.replace(/\*\*([^*]+)\*\*/g, '*$1*');
  out = out.replace(/__([^_]+)__/g, '*$1*');

  // 删除线 ~~x~~ → ~x~
  out = out.replace(/~~([^~]+)~~/g, '~$1~');

  // 行首语法: 标题 → 粗体行; 无序列表 -/* → •; 引用 > 保留(mrkdwn 支持)
  out = out
    .split('\n')
    .map((line) => {
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) return `*${heading[2].trim()}*`;
      const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
      if (bullet) return `${bullet[1]}• ${bullet[2]}`;
      return line;
    })
    .join('\n');

  // 回填行内 code
  out = out.replace(/\u0000IC(\d+)\u0000/g, (_m, i) => inlineCodes[Number(i)] ?? '');
  return out;
}

/** markdown → mrkdwn。 */
export function markdownToMrkdwn(markdown: string): string {
  return splitByCodeFence(markdown)
    .map((seg) => (seg.kind === 'code' ? seg.content : convertTextSegment(seg.content)))
    .join('');
}
