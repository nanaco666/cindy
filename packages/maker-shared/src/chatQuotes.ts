/**
 * chatQuotes — 聊天/文件选中文字引用(chat-text-quote)的纯函数层。
 *
 * 数据契约:引用以 markdown blockquote 形态存在于消息 content 的**开头**——
 * 发送时 `formatQuotesForSend` 把引用列表拼成 `> ` 前缀块 + 空行 + 正文;
 * 渲染时 `parseLeadingBlockquotes` 做精确逆解析,把引用块还原成列表供
 * 两端消息气泡以 Codex 风格("N 处引用" 胶囊 + 预览)展示。
 *
 * 来源文件(file-quote):从文件浏览器选中的引用带 `sourcePath`(workdir
 * 相对路径),编码为条目内最后一行 `> — source: <path>`。模型对引注体例的
 * "— source:" 天然理解,且拿路径可 Read 完整上下文 / 精准编辑;引用文本
 * 本身就是最强的定位锚点(grep 即达),因此不带行号。
 *
 * 为什么选 blockquote 而不是结构化字段:引用是模型的母语格式(零 wire /
 * 持久化 schema 改动),手机端 / 远端 / 导出的纯文本视图天然可读;渲染美化
 * 只是本端的展示层解析。用户手打的开头 blockquote 也会被同样样式化——
 * 这本来就是 markdown 的引用语义,视觉化合理。
 *
 * apps/desktop 的 `renderer/lib/chatQuotes.ts` re-export 本模块,避免 wire format
 * 双实现漂移。
 */

/** 一条选中文字引用。sourcePath 仅文件浏览器来源有(workdir 相对路径)。 */
export interface ChatQuote {
  text: string;
  sourcePath?: string;
  startLine?: number;
  endLine?: number;
}

/** 来源行前缀(条目内最后一行)。 */
const SOURCE_LINE_PREFIX = '— source: ';

function isValidLine(line: number | undefined): line is number {
  return typeof line === 'number' && Number.isInteger(line) && line > 0;
}

function formatSourceLine(q: ChatQuote): string | null {
  if (!q.sourcePath) return null;
  if (!isValidLine(q.startLine)) return q.sourcePath;
  const endLine = isValidLine(q.endLine) && q.endLine >= q.startLine ? q.endLine : q.startLine;
  return endLine === q.startLine
    ? `${q.sourcePath}#L${q.startLine}`
    : `${q.sourcePath}#L${q.startLine}-L${endLine}`;
}

function parseSourceLine(raw: string): Omit<ChatQuote, 'text'> {
  const match = raw.match(/^(.*)#L(\d+)(?:-L(\d+))?$/);
  if (!match) return { sourcePath: raw };
  const sourcePath = match[1];
  const startLine = Number(match[2]);
  const endLine = match[3] ? Number(match[3]) : startLine;
  if (!sourcePath || !isValidLine(startLine) || !isValidLine(endLine)) return { sourcePath: raw };
  return { sourcePath, startLine, endLine: Math.max(startLine, endLine) };
}

/**
 * 引用列表 → 发送文本。编码严格贴合 markdown 标准语义:
 * - 条目内容行 → `> <line>`;条目**内部空行** → 裸 `>`(无尾随空格,免疫
 *   传输层 trailing-space trim);
 * - 条目**首尾空行**在编码前归一化剔除:采集侧选区常吃进段落边界的空行,
 *   它们不携带信息,却会让编码块以裸 `>` 开头——而 parseLeadingBlockquotes
 *   的早退守卫只认 `"> "` 开头(保护用户手打的裸 `>`),开头裸 `>` 的消息
 *   会整段退化为原文渲染,破坏 roundtrip 契约;
 * - 条目之间以**真空行**分隔(markdown 中即两个独立 blockquote);
 * - 带来源的条目末尾追加 `> — source: <path>` 行;正文与引用块空行相接。
 * 注:首尾空行归一化是对 #793 桌面版原实现的修复(桌面同样受益于后续迁移
 * 到本共享模块)。
 */
/** 剥掉字符串首尾的连续换行(线性扫描,不用正则——`/\n+$/` 会被 CodeQL
 *  以多项式回溯告警;引用文本来自用户选区,属不可控输入)。 */
function stripOuterNewlines(text: string): string {
  let start = 0;
  while (start < text.length && text[start] === '\n') start += 1;
  let end = text.length;
  while (end > start && text[end - 1] === '\n') end -= 1;
  return text.slice(start, end);
}

export function formatQuotesForSend(quotes: readonly ChatQuote[], body: string): string {
  if (quotes.length === 0) return body;
  const block = quotes
    .map((q) => {
      const lines = stripOuterNewlines(q.text).split('\n');
      const sourceLine = formatSourceLine(q);
      if (sourceLine) lines.push(`${SOURCE_LINE_PREFIX}${sourceLine}`);
      return lines.map((line) => (line ? `> ${line}` : '>')).join('\n');
    })
    .join('\n\n');
  return `${block}\n\n${body}`.trimEnd();
}

/**
 * 逆解析(与 formatQuotesForSend 对偶):content 以 "> " 开头时,取出开头的
 * blockquote 区还原成引用列表,其余为正文。规则:
 * - `> x` 行是条目内容,裸 `>` 行是条目内部空行;
 * - 空行后紧跟 `> ` 行 → 条目分隔,继续;空行后不是 → 引用区结束,余下为正文;
 * - 条目最后一行是 `— source: <path>` 时抽为来源(选中文本自身以该前缀结尾的
 *   极端情况会被误判,可接受);
 * - 早退守卫只认 `"> "` 开头:首行是裸 `>` 的用户手打内容原样返回,不吞字符。
 * 正文首行恰以 `> ` 开头会被并入引用块——这是 markdown 引用语义的固有歧义,
 * 视觉化后仍以引用样式呈现,可接受。
 */
export function parseLeadingBlockquotes(content: string): {
  quotes: ChatQuote[];
  body: string;
} {
  if (!content.startsWith('> ')) {
    return { quotes: [], body: content };
  }
  const lines = content.split('\n');
  const quotes: ChatQuote[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const last = current[current.length - 1];
    if (last.startsWith(SOURCE_LINE_PREFIX) && current.length > 1) {
      quotes.push({
        text: current.slice(0, -1).join('\n'),
        ...parseSourceLine(last.slice(SOURCE_LINE_PREFIX.length)),
      });
    } else {
      quotes.push({ text: current.join('\n') });
    }
    current = [];
  };

  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('> ')) {
      current.push(line.slice(2));
      continue;
    }
    if (line === '>') {
      // 条目内部空行(markdown:同一 blockquote 里的空行)。
      current.push('');
      continue;
    }
    if (line === '' && current.length > 0 && lines[i + 1]?.startsWith('> ')) {
      // 空行 + 下一行仍是引用 → 条目分隔,继续吃下一条。
      flush();
      continue;
    }
    break; // 引用区结束(空行后接正文,或直接非引用行)。
  }
  flush();
  const body = lines.slice(i).join('\n').replace(/^\n+/, '');
  return { quotes, body };
}

/** 来源路径 → UI 展示用文件名(basename)。 */
export function quoteSourceBasename(sourcePath: string): string {
  return sourcePath.split(/[\\/]/).filter(Boolean).pop() ?? sourcePath;
}

export function quoteSourceLineRangeLabel(quote: ChatQuote): string | null {
  if (!isValidLine(quote.startLine)) return null;
  const endLine =
    isValidLine(quote.endLine) && quote.endLine >= quote.startLine
      ? quote.endLine
      : quote.startLine;
  return endLine === quote.startLine ? `L${quote.startLine}` : `L${quote.startLine}-L${endLine}`;
}

/** UI 展示用来源标签：basename + 可选 source 行号。 */
export function quoteSourceDisplayLabel(quote: ChatQuote): string | null {
  if (!quote.sourcePath) return null;
  const lineLabel = quoteSourceLineRangeLabel(quote);
  return `${quoteSourceBasename(quote.sourcePath)}${lineLabel ? `:${lineLabel}` : ''}`;
}
