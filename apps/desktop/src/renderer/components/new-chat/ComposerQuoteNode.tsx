/**
 * Read-only inline atom used for selected-text quotes inside ChatInput.
 *
 * The quote stays compact and immutable while prose remains editable directly
 * before/after it. The chip truncates long text and exposes the full quote on
 * hover; users can delete it with Backspace/Delete or its remove button.
 */
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { useTranslation } from 'react-i18next';
import {
  COMPOSER_QUOTE_NODE_TYPE,
  composerQuoteAttrsToChatQuote,
  type ComposerQuoteAttrs,
} from '@/lib/composerQuoteDocument';
import { QuoteChip } from '@/components/chat/QuoteChip';

function parsePositiveLineAttribute(element: HTMLElement, name: string): number | null {
  const raw = element.getAttribute(name);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function ComposerQuoteNodeView({ node, deleteNode, selected }: NodeViewProps) {
  const { t } = useTranslation();
  const quote = composerQuoteAttrsToChatQuote(node.attrs as ComposerQuoteAttrs);

  return (
    <NodeViewWrapper
      as="span"
      data-composer-quote=""
      contentEditable={false}
      className="inline-block max-w-[min(240px,55vw)] select-none px-2 align-middle"
    >
      <QuoteChip
        quote={quote}
        selected={selected}
        onRemove={deleteNode}
        removeLabel={t('chat.quote.remove')}
      />
    </NodeViewWrapper>
  );
}

export const ComposerQuoteNode = Node.create<Record<string, never>, Record<string, never>>({
  name: COMPOSER_QUOTE_NODE_TYPE,
  inline: true,
  group: 'inline',
  atom: true,
  selectable: false,
  draggable: false,

  addAttributes() {
    return {
      text: {
        default: '',
        parseHTML: (element) =>
          element.getAttribute('data-quote-text') ?? element.textContent ?? '',
        renderHTML: (attrs) => ({ 'data-quote-text': attrs.text }),
      },
      sourcePath: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-source-path') || null,
        renderHTML: (attrs) =>
          attrs.sourcePath == null ? {} : { 'data-source-path': attrs.sourcePath },
      },
      startLine: {
        default: null,
        parseHTML: (element) => parsePositiveLineAttribute(element, 'data-start-line'),
        renderHTML: (attrs) =>
          attrs.startLine == null ? {} : { 'data-start-line': attrs.startLine },
      },
      endLine: {
        default: null,
        parseHTML: (element) => parsePositiveLineAttribute(element, 'data-end-line'),
        renderHTML: (attrs) =>
          attrs.endLine == null ? {} : { 'data-end-line': attrs.endLine },
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'span[data-composer-quote]' },
      // Compatibility with drafts / clipboard HTML from the first block-card preview.
      { tag: 'div[data-composer-quote]' },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    const quote = composerQuoteAttrsToChatQuote(node.attrs as ComposerQuoteAttrs);
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-composer-quote': '',
        contenteditable: 'false',
      }),
      quote.text,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ComposerQuoteNodeView);
  },
});
