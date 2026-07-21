/**
 * Pure Tiptap JSON helpers for inline chat quotes.
 *
 * Quotes are block atoms in the composer document so their order relative to
 * prose is explicit and survives session switches, fork, rewind, and send.
 * Keeping these transforms free of React/Tiptap runtime objects makes the
 * draft store deterministic and directly testable.
 */
import type { JSONContent } from '@tiptap/core';
import type { ChatQuote, ChatQuoteSegment } from '@/lib/chatQuotes';

export const COMPOSER_QUOTE_NODE_TYPE = 'composerQuote';

export interface ComposerQuoteAttrs {
  text: string;
  sourcePath: string | null;
  startLine: number | null;
  endLine: number | null;
}

export function composerQuoteAttrsToChatQuote(attrs: ComposerQuoteAttrs): ChatQuote {
  return {
    text: attrs.text,
    ...(attrs.sourcePath ? { sourcePath: attrs.sourcePath } : {}),
    ...(typeof attrs.startLine === 'number' ? { startLine: attrs.startLine } : {}),
    ...(typeof attrs.endLine === 'number' ? { endLine: attrs.endLine } : {}),
  };
}

function quoteNode(quote: ChatQuote): JSONContent {
  return {
    type: COMPOSER_QUOTE_NODE_TYPE,
    attrs: {
      text: quote.text,
      sourcePath: quote.sourcePath ?? null,
      startLine: quote.startLine ?? null,
      endLine: quote.endLine ?? null,
    },
  };
}

function emptyParagraph(): JSONContent {
  return { type: 'paragraph' };
}

function isEmptyParagraph(node: JSONContent | undefined): boolean {
  return node?.type === 'paragraph' && (!node.content || node.content.length === 0);
}

function textSegmentNodes(text: string): JSONContent[] {
  return text
    .split('\n')
    .map((line) =>
      line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : emptyParagraph(),
    );
}

/** Append a quote at the end of the authored body and leave a caret paragraph after it. */
export function appendQuoteToComposerDocument(
  document: JSONContent | null | undefined,
  quote: ChatQuote,
): JSONContent {
  const content =
    document?.type === 'doc' && Array.isArray(document.content) ? [...document.content] : [];
  if (isEmptyParagraph(content.at(-1))) content.pop();
  content.push(quoteNode(quote), emptyParagraph());
  return { type: 'doc', content };
}

/**
 * One-way compatibility lift for drafts created by the former separate quote
 * array. Historical quotes preceded the whole body, so preserve that order.
 */
export function prependLegacyQuotesToComposerDocument(
  document: JSONContent | null | undefined,
  quotes: readonly ChatQuote[],
): JSONContent | null {
  if (quotes.length === 0) return document ?? null;
  const body =
    document?.type === 'doc' && Array.isArray(document.content) ? [...document.content] : [];
  if (body.length === 1 && isEmptyParagraph(body[0])) body.length = 0;
  const content = [...quotes.map(quoteNode), ...body];
  if (content.length === 0 || content.at(-1)?.type === COMPOSER_QUOTE_NODE_TYPE) {
    content.push(emptyParagraph());
  }
  return { type: 'doc', content };
}

/** Restore an encoded sent message into the same inline composer order. */
export function quoteSegmentsToComposerDocument(
  segments: readonly ChatQuoteSegment[],
): JSONContent | null {
  const content: JSONContent[] = [];
  for (const segment of segments) {
    if (segment.kind === 'quote') content.push(quoteNode(segment.quote));
    else if (segment.text) content.push(...textSegmentNodes(segment.text));
  }
  if (content.length === 0) return null;
  if (content.at(-1)?.type === COMPOSER_QUOTE_NODE_TYPE) content.push(emptyParagraph());
  return { type: 'doc', content };
}
