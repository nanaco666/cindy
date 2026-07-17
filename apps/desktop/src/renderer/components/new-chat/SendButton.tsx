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
  /** CREATE AGENT 首页按 Figma 185:2724 使用独立私有 token。 */
  visualVariant?: 'default' | 'create-agent';
}

function CreateAgentSendIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="currentColor"
    >
      <path d="M2.6 3.35a1 1 0 0 1 1.08-.13l17.2 8a.88.88 0 0 1 0 1.56l-17.2 8A1 1 0 0 1 2.3 19.6l2.04-6.44L13 12 4.34 10.84 2.3 4.4a1 1 0 0 1 .3-1.05Z" />
    </svg>
  );
}

/**
 * Send / Stop button — 对标 cc-agent-view.pen
 *
 * Send (idle): 28×28 圆形（9999）, bg #262626/#fff, arrow-up icon 白/黑
 * Stop (streaming): 28×28 圆角方形（8）, bg #e5e5e5/#3c3c3a, 10×10 圆角 1.5 反色方块
 */
export const SendButton = forwardRef<HTMLButtonElement, SendButtonProps>(function SendButton(
  { disabled, onClick, isStreaming = false, highlighted = false, ariaLabel, visualVariant = 'default' },
  ref,
) {
  const { t } = useTranslation();
  const isCreateAgentVariant = visualVariant === 'create-agent';
  return (
    <button
      ref={ref}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex shrink-0 items-center justify-center transition-colors',
        isCreateAgentVariant ? 'h-[30px] w-[30px]' : 'h-7 w-7',
        isStreaming
          ? 'rounded-[8px] bg-[var(--stop-btn-bg)] hover:opacity-85'
          : isCreateAgentVariant
            ? [
                'rounded-full bg-[var(--create-agent-send-bg)] text-[var(--create-agent-send-icon)]',
                'hover:bg-[var(--create-agent-send-bg-hover)] active:bg-[var(--create-agent-send-bg-pressed)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--create-agent-focus-ring)]',
              ]
            : 'rounded-full bg-[var(--send-btn-bg)] text-[var(--send-btn-icon)] hover:opacity-85',
        highlighted && !disabled && !isStreaming && 'opacity-85',
        disabled &&
          !isStreaming &&
          (isCreateAgentVariant
            ? 'cursor-not-allowed bg-[var(--create-agent-send-disabled-bg)] text-[var(--create-agent-send-disabled-icon)]'
            : 'cursor-not-allowed bg-[var(--send-btn-disabled-bg)] text-[var(--send-btn-disabled-icon)] opacity-40'),
      )}
      aria-label={ariaLabel ?? (isStreaming ? t('newChat.sendButton.stop') : t('newChat.sendButton.send'))}
    >
      {isStreaming ? (
        <span
          className="block h-[10px] w-[10px] rounded-[1.5px] bg-[var(--stop-btn-icon)]"
          aria-hidden
        />
      ) : isCreateAgentVariant ? (
        <CreateAgentSendIcon />
      ) : (
        <ArrowUp size={16} />
      )}
    </button>
  );
});
