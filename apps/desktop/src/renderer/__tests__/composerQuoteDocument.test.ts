// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { afterEach, describe, expect, it } from 'vitest';
import { ComposerQuoteNode } from '@/components/new-chat/ComposerQuoteNode';
import {
  appendQuoteToComposerDocument,
  prependLegacyQuotesToComposerDocument,
  quoteSegmentsToComposerDocument,
} from '@/lib/composerQuoteDocument';

const editors: Editor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function makeEditor(): Editor {
  const editor = new Editor({
    extensions: [Document, Paragraph, Text, ComposerQuoteNode],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  });
  editors.push(editor);
  return editor;
}

describe('composerQuoteDocument', () => {
  it('appends quotes after authored prose and leaves a paragraph for the reply', () => {
    const first = appendQuoteToComposerDocument(null, { text: 'quote one' });
    first.content![1] = {
      type: 'paragraph',
      content: [{ type: 'text', text: 'response one' }],
    };
    const second = appendQuoteToComposerDocument(first, {
      text: 'quote two',
      sourcePath: 'docs/spec.md',
      startLine: 4,
      endLine: 5,
    });

    expect(second).toEqual({
      type: 'doc',
      content: [
        {
          type: 'composerQuote',
          attrs: { text: 'quote one', sourcePath: null, startLine: null, endLine: null },
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'response one' }] },
        {
          type: 'composerQuote',
          attrs: {
            text: 'quote two',
            sourcePath: 'docs/spec.md',
            startLine: 4,
            endLine: 5,
          },
        },
        { type: 'paragraph' },
      ],
    });
  });

  it('lifts legacy leading quote arrays into the document once', () => {
    expect(
      prependLegacyQuotesToComposerDocument(
        {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }],
        },
        [{ text: 'legacy' }],
      ),
    ).toEqual({
      type: 'doc',
      content: [
        {
          type: 'composerQuote',
          attrs: { text: 'legacy', sourcePath: null, startLine: null, endLine: null },
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
      ],
    });
  });

  it('restores alternating sent-message segments in the same order', () => {
    expect(
      quoteSegmentsToComposerDocument([
        { kind: 'quote', quote: { text: 'q1' } },
        { kind: 'text', text: 'a1' },
        { kind: 'quote', quote: { text: 'q2' } },
        { kind: 'text', text: 'a2' },
      ]),
    ).toEqual({
      type: 'doc',
      content: [
        {
          type: 'composerQuote',
          attrs: { text: 'q1', sourcePath: null, startLine: null, endLine: null },
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'a1' }] },
        {
          type: 'composerQuote',
          attrs: { text: 'q2', sourcePath: null, startLine: null, endLine: null },
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'a2' }] },
      ],
    });
  });

  it('round-trips quote text and source metadata through HTML clipboard serialization', () => {
    const editor = makeEditor();
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'composerQuote',
          attrs: {
            text: 'quoted <value>\nsecond line',
            sourcePath: 'src/example.ts',
            startLine: 7,
            endLine: 9,
          },
        },
        { type: 'paragraph' },
      ],
    });

    const restored = makeEditor();
    restored.commands.setContent(editor.getHTML());
    expect(restored.getJSON().content?.[0]).toEqual({
      type: 'composerQuote',
      attrs: {
        text: 'quoted <value>\nsecond line',
        sourcePath: 'src/example.ts',
        startLine: 7,
        endLine: 9,
      },
    });
  });
});
