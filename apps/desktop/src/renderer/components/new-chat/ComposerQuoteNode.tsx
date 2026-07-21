/**
 * Read-only inline atom used for selected-text quotes inside ChatInput.
 *
 * The quote stays compact and immutable while prose remains editable directly
 * before/after it. The chip truncates long text and exposes the full quote on
 * hover; users can delete it with Backspace/Delete or its remove button.
 */
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { FileText, MessageSquareQuote, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  COMPOSER_QUOTE_NODE_TYPE,
  composerQuoteAttrsToChatQuote,
  type ComposerQuoteAttrs,
} from '@/lib/composerQuoteDocument';
import { quoteSourceDisplayLabel } from '@/lib/chatQuotes';
import { Tooltip } from '@/components/ui/tooltip';

function parsePositiveLineAttribute(element: HTMLElement, name: string): number | null {
  const raw = element.getAttribute(name);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function ComposerQuoteNodeView({ node, deleteNode, selected }: NodeViewProps) {
  const { t } = useTranslation();
  const quote = composerQuoteAttrsToChatQuote(node.attrs as ComposerQuoteAttrs);
  const sourceLabel = quoteSourceDisplayLabel(quote);
  const compactText = quote.text.replace(/\s+/g, ' ').trim();

  return (
    <NodeViewWrapper
      as="span"
      data-composer-quote=""
      contentEditable={false}
      className="inline-block max-w-[min(240px,55vw)] select-none px-2 align-middle"
    >
      <Tooltip.Provider delayDuration={300}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <span
              aria-label={quote.text}
              onMouseDown={(event) => event.preventDefault()}
              className="relative inline-flex w-full select-none items-center gap-1.5 rounded-full border py-0.5 pl-2 pr-6 text-[12px] leading-5"
              style={{
                backgroundColor: 'var(--surface-chip)',
                borderColor: selected ? 'var(--focus-ring)' : 'var(--border-default)',
                color: 'var(--text-secondary)',
              }}
            >
              <MessageSquareQuote className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate">{compactText}</span>
              <button
                type="button"
                aria-label={t('chat.quote.remove')}
                onMouseDown={(event) => event.preventDefault()}
                onClick={deleteNode}
                className="absolute right-0.5 top-1/2 inline-flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full opacity-50 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
                style={{ color: 'var(--text-secondary)' }}
              >
                <X className="h-2.5 w-2.5" aria-hidden />
              </button>
            </span>
          </Tooltip.Trigger>
          <Tooltip.Content
            side="top"
            className="max-h-64 w-80 max-w-[70vw] overflow-y-auto whitespace-normal"
          >
            <span className="flex flex-col gap-1">
              <span className="whitespace-pre-wrap text-[12px] leading-[1.5] [overflow-wrap:anywhere]">
                “{quote.text}”
              </span>
              {sourceLabel ? (
                <span
                  className="inline-flex min-w-0 items-center gap-1 text-[11px]"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  <FileText className="h-3 w-3 shrink-0" aria-hidden />
                  <span className="truncate">{sourceLabel}</span>
                </span>
              ) : null}
            </span>
          </Tooltip.Content>
        </Tooltip.Root>
      </Tooltip.Provider>
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
