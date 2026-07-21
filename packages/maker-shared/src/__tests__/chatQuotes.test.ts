import { describe, expect, it } from 'vitest';
import {
  formatQuoteForSend,
  formatQuotesForSend,
  parseChatQuoteSegments,
  parseLeadingBlockquotes,
  quoteSourceBasename,
  quoteSourceDisplayLabel,
  stripChatQuoteMarkerLines,
} from '../chatQuotes';

describe('formatQuotesForSend', () => {
  it('encodes one standalone quote for inline composer serialization', () => {
    expect(formatQuoteForSend({ text: 'a\n\nb', sourcePath: 'docs/x.md' })).toBe(
      '> <!-- cindy-composer-quote -->\n> a\n>\n> b\n> — source: docs/x.md',
    );
  });

  it('prefixes each quote line and separates quotes with a blank line (markdown semantics)', () => {
    expect(formatQuotesForSend([{ text: 'a\nb' }, { text: 'c' }], 'hello')).toBe(
      '> <!-- cindy-composer-quote -->\n> a\n> b\n\n> <!-- cindy-composer-quote -->\n> c\n\nhello',
    );
  });

  it('encodes intra-quote empty lines as a bare ">" (no trailing space to trim)', () => {
    expect(formatQuotesForSend([{ text: 'a\n\nb' }], 'hi')).toBe(
      '> <!-- cindy-composer-quote -->\n> a\n>\n> b\n\nhi',
    );
  });

  it('normalizes leading/trailing blank lines so the block never starts with a bare ">"', () => {
    // 开头裸 ">" 会被 parseLeadingBlockquotes 的早退守卫拒收(用户手打保护),
    // 采集侧选区吃进段落边界空行时必须在编码前剔除。
    expect(formatQuotesForSend([{ text: '\n\nselected\n' }], 'hi')).toBe(
      '> <!-- cindy-composer-quote -->\n> selected\n\nhi',
    );
    const sent = formatQuotesForSend([{ text: '\nfirst\n\nsecond\n\n', sourcePath: 'a.md' }], 'body');
    expect(sent).toBe(
      '> <!-- cindy-composer-quote -->\n> first\n>\n> second\n> — source: a.md\n\nbody',
    );
    expect(parseLeadingBlockquotes(sent)).toEqual({
      quotes: [{ text: 'first\n\nsecond', sourcePath: 'a.md' }],
      body: 'body',
    });
  });

  it('appends a source line for file quotes', () => {
    expect(formatQuotesForSend([{ text: 'a', sourcePath: 'docs/x.md' }], 'hi')).toBe(
      '> <!-- cindy-composer-quote -->\n> a\n> — source: docs/x.md\n\nhi',
    );
  });

  it('appends source line numbers for file quotes', () => {
    expect(
      formatQuotesForSend([{ text: 'a', sourcePath: 'docs/x.md', startLine: 12, endLine: 18 }], 'hi'),
    ).toBe('> <!-- cindy-composer-quote -->\n> a\n> — source: docs/x.md#L12-L18\n\nhi');
    expect(
      formatQuotesForSend([{ text: 'a', sourcePath: 'docs/x.md', startLine: 12, endLine: 12 }], 'hi'),
    ).toBe('> <!-- cindy-composer-quote -->\n> a\n> — source: docs/x.md#L12\n\nhi');
  });

  it('returns body untouched when there are no quotes', () => {
    expect(formatQuotesForSend([], 'hello')).toBe('hello');
  });

  it('trims the trailing gap for quote-only sends', () => {
    expect(formatQuotesForSend([{ text: 'a' }], '')).toBe(
      '> <!-- cindy-composer-quote -->\n> a',
    );
  });
});

describe('parseChatQuoteSegments', () => {
  it('preserves alternating quote and prose order', () => {
    const content = [
      formatQuoteForSend({ text: 'first quote' }),
      '',
      'first response',
      '',
      formatQuoteForSend({
        text: 'second quote',
        sourcePath: 'docs/spec.md',
        startLine: 8,
        endLine: 9,
      }),
      '',
      'second response',
    ].join('\n');

    expect(parseChatQuoteSegments(content)).toEqual([
      { kind: 'quote', quote: { text: 'first quote' } },
      { kind: 'text', text: 'first response' },
      {
        kind: 'quote',
        quote: {
          text: 'second quote',
          sourcePath: 'docs/spec.md',
          startLine: 8,
          endLine: 9,
        },
      },
      { kind: 'text', text: 'second response' },
    ]);
  });

  it('keeps internal quote and prose blank lines', () => {
    const content = `before\n\n${formatQuoteForSend({ text: 'a\n\nb' })}\n\nafter\n\nstill after`;
    expect(parseChatQuoteSegments(content)).toEqual([
      { kind: 'text', text: 'before' },
      { kind: 'quote', quote: { text: 'a\n\nb' } },
      { kind: 'text', text: 'after\n\nstill after' },
    ]);
  });

  it('keeps user-authored Markdown blockquotes in the body editable', () => {
    const content = `${formatQuoteForSend({ text: 'selected' })}\n\nHere is the original:\n> foo`;
    expect(parseChatQuoteSegments(content)).toEqual([
      { kind: 'quote', quote: { text: 'selected' } },
      { kind: 'text', text: 'Here is the original:\n> foo' },
    ]);
  });

  it('preserves lone and backslash-prefixed greater-than body lines', () => {
    const content = `${formatQuoteForSend({ text: 'selected' })}\n\n>\n\\> foo`;
    expect(parseChatQuoteSegments(content)).toEqual([
      { kind: 'quote', quote: { text: 'selected' } },
      { kind: 'text', text: '>\n\\> foo' },
    ]);
  });

  it('keeps compatibility with unmarked legacy leading quotes only', () => {
    expect(parseChatQuoteSegments('> old one\n\n> old two\n\nbody\n\n> manual')).toEqual([
      { kind: 'quote', quote: { text: 'old one' } },
      { kind: 'quote', quote: { text: 'old two' } },
      { kind: 'text', text: 'body\n\n> manual' },
    ]);
  });

  it('restores markerless interleaved quotes when persisted metadata enables preview compatibility', () => {
    const content = [
      '> 把 Claude Code 和 Codex，从终端带到整台电脑。',
      '> 让最强的 Agent 操作你的浏览器、文件、软件、手机和服务器。',
      '',
      '第一段回复。',
      '',
      '',
      '> 一个开放、本地、可编排的 Agent 工作台。',
      '',
      '第二段回复。',
      '',
      '',
      '> 开箱即强，向下完全开放。',
      '>',
      '> 不用折腾才能开始，但绝不限制你折腾。',
      '',
      '第三段回复。',
    ].join('\n');

    expect(parseChatQuoteSegments(content, { allowLegacyInterleavedQuotes: true })).toEqual([
      {
        kind: 'quote',
        quote: {
          text: '把 Claude Code 和 Codex，从终端带到整台电脑。\n让最强的 Agent 操作你的浏览器、文件、软件、手机和服务器。',
        },
      },
      { kind: 'text', text: '第一段回复。\n' },
      { kind: 'quote', quote: { text: '一个开放、本地、可编排的 Agent 工作台。' } },
      { kind: 'text', text: '第二段回复。\n' },
      {
        kind: 'quote',
        quote: { text: '开箱即强，向下完全开放。\n\n不用折腾才能开始，但绝不限制你折腾。' },
      },
      { kind: 'text', text: '第三段回复。' },
    ]);
  });

  it('never treats unmarked body blockquotes as product quotes when any explicit marker exists', () => {
    const content = `${formatQuoteForSend({ text: 'selected' })}\n\n正文：\n> manual`;
    expect(parseChatQuoteSegments(content, { allowLegacyInterleavedQuotes: true })).toEqual([
      { kind: 'quote', quote: { text: 'selected' } },
      { kind: 'text', text: '正文：\n> manual' },
    ]);
  });

  it('returns ordinary text unchanged', () => {
    expect(parseChatQuoteSegments('plain\ntext')).toEqual([
      { kind: 'text', text: 'plain\ntext' },
    ]);
  });
});

describe('stripChatQuoteMarkerLines', () => {
  it('removes only exact private marker lines from copied quote Markdown', () => {
    const content = [
      '> <!-- cindy-composer-quote -->',
      '> selected text',
      '> — source: docs/spec.md#L4-L6',
      '',
      'reply',
      '> <!-- cindy-composer-quote --> suffix',
    ].join('\n');

    expect(stripChatQuoteMarkerLines(content)).toBe([
      '> selected text',
      '> — source: docs/spec.md#L4-L6',
      '',
      'reply',
      '> <!-- cindy-composer-quote --> suffix',
    ].join('\n'));
  });

  it('leaves ordinary Markdown untouched', () => {
    const content = '> handwritten quote\n\nbody';
    expect(stripChatQuoteMarkerLines(content)).toBe(content);
  });
});

describe('parseLeadingBlockquotes', () => {
  it('round-trips quotes containing internal empty lines', () => {
    const quotes = [{ text: '第一段\n\n空行后继续' }, { text: 'b', sourcePath: 'x.md' }];
    const sent = formatQuotesForSend(quotes, 'body');
    expect(parseLeadingBlockquotes(sent)).toEqual({ quotes, body: 'body' });
  });

  it('round-trips quote text that happens to equal the internal marker', () => {
    const quotes = [{ text: '<!-- cindy-composer-quote -->' }];
    expect(parseLeadingBlockquotes(formatQuotesForSend(quotes, 'body'))).toEqual({
      quotes,
      body: 'body',
    });
  });

  it('does not swallow a lone leading ">" line typed by the user', () => {
    expect(parseLeadingBlockquotes('>\nbody')).toEqual({ quotes: [], body: '>\nbody' });
  });

  it('round-trips chat and file quotes produced by formatQuotesForSend', () => {
    const quotes = [
      { text: '第一段\n跨两行' },
      { text: '文件里选的', sourcePath: 'src/app/main.ts' },
    ];
    const sent = formatQuotesForSend(quotes, '正文内容');
    expect(parseLeadingBlockquotes(sent)).toEqual({ quotes, body: '正文内容' });
  });

  it('round-trips leading indentation (whitespace-sensitive code quotes)', () => {
    const quotes = [{ text: '    if (x) {\n      return;\n    }', sourcePath: 'src/a.py' }];
    const sent = formatQuotesForSend(quotes, 'fix this');
    expect(parseLeadingBlockquotes(sent)).toEqual({ quotes, body: 'fix this' });
  });

  it('round-trips quote-only content', () => {
    const sent = formatQuotesForSend([{ text: 'only quote', sourcePath: 'a.md' }], '');
    expect(parseLeadingBlockquotes(sent)).toEqual({
      quotes: [{ text: 'only quote', sourcePath: 'a.md' }],
      body: '',
    });
  });

  it('round-trips file quote line numbers', () => {
    const quotes = [{ text: 'selected', sourcePath: 'docs/spec.md', startLine: 4, endLine: 6 }];
    const sent = formatQuotesForSend(quotes, 'fix it');
    expect(parseLeadingBlockquotes(sent)).toEqual({ quotes, body: 'fix it' });
  });

  it('does not treat a lone source-looking line as a source (needs preceding text)', () => {
    expect(parseLeadingBlockquotes('> — source: a.md\n\nbody')).toEqual({
      quotes: [{ text: '— source: a.md' }],
      body: 'body',
    });
  });

  it('returns plain content untouched', () => {
    expect(parseLeadingBlockquotes('just text\n> not leading')).toEqual({
      quotes: [],
      body: 'just text\n> not leading',
    });
  });

  it('stops the quote block at the first non-quote line', () => {
    expect(parseLeadingBlockquotes('> q\nbody\n> tail')).toEqual({
      quotes: [{ text: 'q' }],
      body: 'body\n> tail',
    });
  });
});

describe('quoteSourceBasename', () => {
  it('extracts the basename across separators', () => {
    expect(quoteSourceBasename('docs/design/spec.md')).toBe('spec.md');
    expect(quoteSourceBasename('win\\path\\a.ts')).toBe('a.ts');
    expect(quoteSourceBasename('single.md')).toBe('single.md');
  });
});

describe('quoteSourceDisplayLabel', () => {
  it('keeps file line labels visible for UI consumers', () => {
    expect(quoteSourceDisplayLabel({ text: 'a', sourcePath: 'docs/design/spec.md' })).toBe(
      'spec.md',
    );
    expect(
      quoteSourceDisplayLabel({
        text: 'a',
        sourcePath: 'docs/design/spec.md',
        startLine: 12,
        endLine: 18,
      }),
    ).toBe('spec.md:L12-L18');
    expect(
      quoteSourceDisplayLabel({
        text: 'a',
        sourcePath: 'docs/design/spec.md',
        startLine: 12,
        endLine: 8,
      }),
    ).toBe('spec.md:L12');
  });

  it('returns null for chat-only quotes without source path', () => {
    expect(quoteSourceDisplayLabel({ text: 'a' })).toBeNull();
  });
});
