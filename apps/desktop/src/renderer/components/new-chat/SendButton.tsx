import { forwardRef } from 'react';
import { ArrowUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

interface SendButtonProps {
  disabled: boolean;
  onClick: () => void;
  /** When true, renders as Stop button per cc-agent-view.pen Streaming variant */
  isStreaming?: boolean;
  /** Highlighted while voice long-press is hovering over this button as a release target. */
  highlighted?: boolean;
  /** Override for the accessible action name when Send visually means Queue. */
  ariaLabel?: string;
}

/**
 * Send / Stop button — 对标 cc-agent-view.pen
 *
 * Send (idle): 28×28 圆形（9999）, bg #262626/#fff, arrow-up icon 白/黑
 * Stop (streaming): 28×28 圆角方形（8）, bg #e5e5e5/#3c3c3a, 10×10 圆角 1.5 反色方块
 */
export const SendButton = forwardRef<HTMLButtonElement, SendButtonProps>(function SendButton(
  { disabled, onClick, isStreaming = false, highlighted = false, ariaLabel },
  ref,
) {
  const { t } = useTranslation();
  return (
    <button
      ref={ref}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center transition-colors',
        isStreaming
          ? 'rounded-[8px] bg-[var(--stop-btn-bg)] hover:opacity-85'
          : 'rounded-full bg-[var(--send-btn-bg)] text-[var(--send-btn-icon)] hover:opacity-85',
        highlighted && !disabled && !isStreaming && 'opacity-85',
        disabled &&
          !isStreaming &&
          'cursor-not-allowed bg-[var(--send-btn-disabled-bg)] text-[var(--send-btn-disabled-icon)] opacity-40',
      )}
      aria-label={ariaLabel ?? (isStreaming ? t('newChat.sendButton.stop') : t('newChat.sendButton.send'))}
    >
      {isStreaming ? (
        <span
          className="block h-[10px] w-[10px] rounded-[1.5px] bg-[var(--stop-btn-icon)]"
          aria-hidden
        />
      ) : (
        <ArrowUp size={16} />
      )}
    </button>
  );
});
