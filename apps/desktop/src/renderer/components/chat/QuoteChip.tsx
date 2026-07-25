/**
 * QuoteChip — 输入框与已发送用户消息共用的紧凑引用胶囊。
 *
 * 默认只展示单行摘要，完整引用与文件来源放在 hover tooltip 中；输入框
 * 可额外传入删除动作，消息气泡只读复用同一套尺寸、颜色与截断规则。
 */
import { FileText, MessageSquareQuote, X } from 'lucide-react';
import type { ChatQuote } from '@/lib/chatQuotes';
import { quoteSourceDisplayLabel } from '@/lib/chatQuotes';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';

interface QuoteChipProps {
  quote: ChatQuote;
  selected?: boolean;
  onRemove?: () => void;
  removeLabel?: string;
}

/** 渲染紧凑、不可选中的引用摘要；完整内容仅在 tooltip 中展开。 */
export function QuoteChip({
  quote,
  selected = false,
  onRemove,
  removeLabel,
}: QuoteChipProps) {
  const sourceLabel = quoteSourceDisplayLabel(quote);
  const compactText = quote.text.replace(/\s+/g, ' ').trim();

  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span
            aria-label={quote.text}
            onMouseDown={(event) => event.preventDefault()}
            className={cn(
              'relative inline-flex w-full select-none items-center gap-1.5 rounded-full border py-0.5 pl-2 text-[12px] leading-5',
              onRemove ? 'pr-6' : 'pr-2',
            )}
            style={{
              backgroundColor: 'var(--surface-chip)',
              borderColor: selected ? 'var(--focus-ring)' : 'var(--border-default)',
              color: 'var(--text-secondary)',
            }}
          >
            <MessageSquareQuote className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">{compactText}</span>
            {onRemove ? (
              <button
                type="button"
                aria-label={removeLabel}
                onMouseDown={(event) => event.preventDefault()}
                onClick={onRemove}
                className="absolute right-0.5 top-1/2 inline-flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full opacity-50 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
                style={{ color: 'var(--text-secondary)' }}
              >
                <X className="h-2.5 w-2.5" aria-hidden />
              </button>
            ) : null}
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
  );
}
