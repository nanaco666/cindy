import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mobile cross-device quote wiring', () => {
  it('parses interleaved desktop quote segments instead of exposing marker text', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const bubbleStart = source.indexOf('function MessageBubble');
    const bubbleEnd = source.indexOf('function copyActionLabel', bubbleStart);
    const bubbleSource = source.slice(bubbleStart, bubbleEnd);

    expect(bubbleSource).toContain('parseChatQuoteSegments(item.message.body');
    expect(bubbleSource).toContain(
      'allowLegacyInterleavedQuotes: item.message.quotesEncoded === true',
    );
    expect(bubbleSource).toContain("segment.kind === 'quote' ? [segment.quote] : []");
    expect(bubbleSource).toContain("segment.kind === 'text' ? [segment.text] : []");
    expect(bubbleSource).toContain('actions.onPreviewRewind?.(clientId, {');
    expect(bubbleSource).toContain('? { text: bubbleBody, quotes: messageQuotes }');
  });

  it('propagates quote metadata through direct and attachment-outbox sends', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

    expect(source).toContain('quotesEncoded: quotesAtSend.length > 0');
    expect(source).toContain('quotesEncoded: item.quotesEncoded');
    expect(source).toContain('quotesEncoded: queuedMessageHasEncodedQuotes(original)');
  });

  it('restores structured quote drafts for mobile fork and rewind actions', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

    expect(source).toContain('saveComposerDraft(forked.id, draft?.text);');
    expect(source).toContain('setQuotes(forked.id, draft?.quotes ?? []);');
    expect(source).toContain('setQuotes(sessionId, state.draftQuotes);');
  });
});
