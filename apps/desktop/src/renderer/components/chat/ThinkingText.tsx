/**
 * ThinkingText
 * ---------------------------------------------------------------------------
 * Lightweight inline presentation for model reasoning. Codex commonly wraps
 * short reasoning updates in Markdown strong markers; rendering those markers
 * literally is noisy, while the full chat Markdown pipeline is too heavy and
 * allows block layouts that do not belong inside compact activity rows.
 *
 * Supported syntax is intentionally narrow and deterministic:
 *   - paired `**text**` → medium-weight text (500, per DESIGN.md);
 *   - paired backtick runs → inline monospace text;
 *   - malformed / unmatched delimiters remain literal text.
 *
 * Lists, headings, links, images, and HTML are never interpreted here.
 */

import { Fragment, memo, useMemo } from 'react';

/** A parsed inline segment rendered by ThinkingText. */
export type ThinkingTextToken =
  | { kind: 'text'; value: string }
  | { kind: 'strong'; value: string }
  | { kind: 'code'; value: string };

/** True when the delimiter at index is escaped by an odd backslash run. */
function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

/** Find a non-overlapping strong close marker with non-whitespace content. */
function findStrongClose(value: string, contentStart: number): number {
  let cursor = contentStart;
  while (cursor < value.length - 1) {
    const close = value.indexOf('**', cursor);
    if (close < 0) return -1;
    const previous = value[close - 1];
    const after = value[close + 2];
    if (
      close > contentStart &&
      !isEscaped(value, close) &&
      previous !== '*' &&
      !/\s/.test(previous) &&
      after !== '*'
    ) {
      return close;
    }
    cursor = close + 2;
  }
  return -1;
}

/** Find a closing backtick run of exactly the same length as the opener. */
function findCodeClose(value: string, contentStart: number, runLength: number): number {
  const delimiter = '`'.repeat(runLength);
  let cursor = contentStart;
  while (cursor < value.length) {
    const close = value.indexOf(delimiter, cursor);
    if (close < 0) return -1;
    if (!isEscaped(value, close) && value[close - 1] !== '`' && value[close + runLength] !== '`') {
      return close;
    }
    cursor = close + runLength;
  }
  return -1;
}

/** Match CommonMark's useful code-span whitespace behavior without a full parser. */
function normalizeCodeSpan(value: string): string {
  const singleLine = value.replace(/[\r\n]+/g, ' ');
  if (
    singleLine.length >= 2 &&
    singleLine.startsWith(' ') &&
    singleLine.endsWith(' ') &&
    /\S/.test(singleLine)
  ) {
    return singleLine.slice(1, -1);
  }
  return singleLine;
}

/** Parse only the inline markers that are useful in compact reasoning text. */
export function tokenizeThinkingText(value: string): ThinkingTextToken[] {
  const tokens: ThinkingTextToken[] = [];
  let plainStart = 0;
  let cursor = 0;

  const flushPlain = (end: number) => {
    if (end > plainStart) tokens.push({ kind: 'text', value: value.slice(plainStart, end) });
  };

  while (cursor < value.length) {
    if (value[cursor] === '`' && !isEscaped(value, cursor)) {
      let runLength = 1;
      while (value[cursor + runLength] === '`') runLength++;
      const contentStart = cursor + runLength;
      const close = findCodeClose(value, contentStart, runLength);
      if (close >= 0) {
        flushPlain(cursor);
        tokens.push({
          kind: 'code',
          value: normalizeCodeSpan(value.slice(contentStart, close)),
        });
        cursor = close + runLength;
        plainStart = cursor;
        continue;
      }
      cursor += runLength;
      continue;
    }

    if (
      value.startsWith('**', cursor) &&
      !isEscaped(value, cursor) &&
      value[cursor - 1] !== '*' &&
      value[cursor + 2] !== '*' &&
      value[cursor + 2] !== undefined &&
      !/\s/.test(value[cursor + 2])
    ) {
      const contentStart = cursor + 2;
      const close = findStrongClose(value, contentStart);
      if (close >= 0) {
        flushPlain(cursor);
        tokens.push({ kind: 'strong', value: value.slice(contentStart, close) });
        cursor = close + 2;
        plainStart = cursor;
        continue;
      }
      cursor += 2;
      continue;
    }

    cursor++;
  }

  flushPlain(value.length);
  return tokens;
}

/** Shared compact renderer for live, expanded, and standalone thinking views. */
export const ThinkingText = memo(function ThinkingText({ content }: { content: string }) {
  const tokens = useMemo(() => tokenizeThinkingText(content), [content]);
  return (
    <>
      {tokens.map((token, index) => {
        if (token.kind === 'strong') {
          return (
            <span key={`strong-${index}`} data-thinking-markup="strong" className="font-medium">
              {token.value}
            </span>
          );
        }
        if (token.kind === 'code') {
          return (
            <code
              key={`code-${index}`}
              data-thinking-markup="code"
              className="font-mono not-italic"
            >
              {token.value}
            </code>
          );
        }
        return <Fragment key={`text-${index}`}>{token.value}</Fragment>;
      })}
    </>
  );
});
