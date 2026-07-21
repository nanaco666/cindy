/**
 * Read-only block atom used for selected-text quotes inside ChatInput.
 *
 * The quote itself is immutable source context; prose before/after remains
 * ordinary editable paragraphs. Users can select the atom with the keyboard,
 * delete it with Backspace/Delete, or use the visible remove button.
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

  return (
    <NodeViewWrapper
      as="div"
      data-composer-quote=""
      contentEditable={false}
      className="group/composer-quote relative my-1 rounded-lg border px-3 py-2 pr-9 select-none"
      style={{
        backgroundColor: 'var(--surface-hover-soft)',
        borderColor: selected ? 'var(--focus-ring)' : 'var(--border-default)',
        color: 'var(--text-secondary)',
      }}
    >
      <div className="flex min-w-0 items-start gap-2">
        <MessageSquareQuote className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-4 whitespace-pre-wrap text-[13px] leading-[1.5] [overflow-wrap:anywhere]">
            {quote.text}
          </div>
          {sourceLabel ? (
            <div
              className="mt-1 inline-flex max-w-full items-center gap-1 text-[11px]"
              style={{ color: 'var(--text-tertiary)' }}
            >
              <FileText className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">{sourceLabel}</span>
            </div>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        aria-label={t('chat.quote.remove')}
        onMouseDown={(event) => event.preventDefault()}
        onClick={deleteNode}
        className="absolute right-2 top-2 inline-flex h-5 w-5 items-center justify-center rounded-full opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
        style={{ color: 'var(--text-secondary)' }}
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </NodeViewWrapper>
  );
}

export const ComposerQuoteNode = Node.create<Record<string, never>, Record<string, never>>({
  name: COMPOSER_QUOTE_NODE_TYPE,
  group: 'block',
  atom: true,
  selectable: true,
  isolating: true,

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
        renderHTML: (attrs) => ({ 'data-source-path': attrs.sourcePath ?? '' }),
      },
      startLine: {
        default: null,
        parseHTML: (element) => parsePositiveLineAttribute(element, 'data-start-line'),
        renderHTML: (attrs) => ({ 'data-start-line': attrs.startLine ?? '' }),
      },
      endLine: {
        default: null,
        parseHTML: (element) => parsePositiveLineAttribute(element, 'data-end-line'),
        renderHTML: (attrs) => ({ 'data-end-line': attrs.endLine ?? '' }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-composer-quote]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const quote = composerQuoteAttrsToChatQuote(node.attrs as ComposerQuoteAttrs);
    return [
      'div',
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
