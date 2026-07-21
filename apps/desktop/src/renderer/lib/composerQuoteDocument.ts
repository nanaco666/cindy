/**
 * Pure Tiptap JSON helpers for inline chat quotes.
 *
 * Quotes are inline atoms inside ordinary paragraphs so users can type a reply
 * directly beside each compact quote chip. Their document order still remains
 * explicit and survives session switches, fork, rewind, and send.
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

function paragraph(content: JSONContent[] = []): JSONContent {
  return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
}

function normalizeTopLevelQuoteNodes(document: JSONContent | null | undefined): JSONContent[] {
  const source =
    document?.type === 'doc' && Array.isArray(document.content) ? document.content : [];
  const normalized: JSONContent[] = [];
  let pendingQuotes: JSONContent[] = [];

  const flushPendingQuotes = () => {
    if (pendingQuotes.length === 0) return;
    normalized.push(paragraph(pendingQuotes));
    pendingQuotes = [];
  };

  for (const node of source) {
    if (node.type === COMPOSER_QUOTE_NODE_TYPE) {
      // Compatibility with documents produced by the first block-card preview.
      pendingQuotes.push(node);
      continue;
    }
    if (node.type === 'paragraph' && pendingQuotes.length > 0) {
      normalized.push(paragraph([...pendingQuotes, ...(node.content ?? [])]));
      pendingQuotes = [];
      continue;
    }
    flushPendingQuotes();
    normalized.push(node);
  }
  flushPendingQuotes();
  return normalized;
}

/** Append a quote to the final paragraph so the caret can continue beside it. */
export function appendQuoteToComposerDocument(
  document: JSONContent | null | undefined,
  quote: ChatQuote,
): JSONContent {
  const content = normalizeTopLevelQuoteNodes(document);
  const last = content.at(-1);
  if (last?.type === 'paragraph') {
    content[content.length - 1] = paragraph([...(last.content ?? []), quoteNode(quote)]);
  } else {
    content.push(paragraph([quoteNode(quote)]));
  }
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
  const body = normalizeTopLevelQuoteNodes(document);
  if (quotes.length === 0) {
    if (!document) return null;
    return { type: 'doc', content: body.length > 0 ? body : [paragraph()] };
  }
  const leadingQuotes = quotes.map(quoteNode);
  if (body[0]?.type === 'paragraph') {
    body[0] = paragraph([...leadingQuotes, ...(body[0].content ?? [])]);
  } else {
    body.unshift(paragraph(leadingQuotes));
  }
  return { type: 'doc', content: body };
}

/** Restore an encoded sent message into the same inline composer order. */
export function quoteSegmentsToComposerDocument(
  segments: readonly ChatQuoteSegment[],
): JSONContent | null {
  const content: JSONContent[] = [];
  let inlineContent: JSONContent[] = [];
  let hasContent = false;

  const finishParagraph = () => {
    content.push(paragraph(inlineContent));
    inlineContent = [];
  };

  for (const segment of segments) {
    if (segment.kind === 'quote') {
      inlineContent.push(quoteNode(segment.quote));
      hasContent = true;
      continue;
    }
    if (!segment.text) continue;
    hasContent = true;
    const lines = segment.text.split('\n');
    lines.forEach((line, index) => {
      if (line) inlineContent.push({ type: 'text', text: line });
      if (index < lines.length - 1) finishParagraph();
    });
  }
  if (!hasContent) return null;
  finishParagraph();
  return { type: 'doc', content };
}
