/**
 * MessageActionBar
 * ---------------------------------------------------------------------------
 * Hover-revealed action bar for chat messages (V1.2 spec).
 *
 * Layout:
 *   - Bar gap 4px, align-items: center
 *   - Order is `align`-driven:
 *       align="left"  → [CopyBtn][ForkBtn][TimeText]            (assistant)
 *       align="right" → [TimeText][CopyBtn][RewindBtn][ForkBtn] (user)
 *   - Button container 24×24, rounded-4, hover bg cmd-palette-item-hover
 *   - Icon lucide 14×14, color #737373 (Light) / #a3a3a3 (Dark)
 *     hover color #262626 (Light) / #ffffff (Dark)
 *   - Time text 12px Inter normal, color INVERTED from icon (#a3a3a3 / #737373)
 *
 * Visibility (controlled by parent hover container):
 *   - visible=true  → opacity 1 (mounted, no fade-in per spec)
 *   - visible=false → opacity 0 + pointer-events-none, parent owns 200ms
 *     debounce + 150ms fade-out lifecycle
 *
 * Copy click:
 *   - Writes copyText to clipboard, swaps icon to Check.
 *   - Bar does NOT auto-fade — appearance/disappearance is driven entirely by
 *     hover. Check icon resets to Copy when hover leaves (next hover-in shows
 *     the default Copy icon again).
 *
 * Future: rewind/fork buttons mount in this same bar (V1.x); intentionally
 * omitted in V1 to ship Copy + smart-time first.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Check, Pencil, Split, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip } from '@/components/ui/tooltip';
import { formatAbsolute, useRelativeTime } from '@/hooks/useRelativeTime';
import { formatTurnCostUsd } from '@/lib/usageFormat';
import { buildTurnUsageTooltipLines } from '@/lib/turnUsageTooltip';
import type { TurnUsageDetails } from '../../../shared/turnUsageDetails';

interface MessageActionBarProps {
  createdAt?: string;
  /** Plaintext that will hit the clipboard on copy click. */
  copyText: string;
  /** When provided, the time text becomes clickable and copies this deep
   *  link (`cindy://session/<id>?message=<clientId>`) — the tooltip
   *  gains a hint line, and the time text briefly swaps to a "link copied"
   *  confirmation after a successful copy. No extra button is rendered. */
  copyLinkText?: string;
  /** Bar alignment + button order: 'left' = assistant, 'right' = user. */
  align: 'left' | 'right';
  /** Whether the parent message is currently hovered. Drives the entire
   *  fade lifecycle internally so quick re-enters don't replay from 0. */
  hovered: boolean;
  /** When provided, render a Fork button (user messages fork *before* the
   *  question; assistant messages fork *through* the reply's turn — the
   *  parent decides whether to wire it). Returning a promise keeps the
   *  loading state alive until resolve/reject. The bar dims to opacity 0.6 +
   *  pointer-events:none for the duration; the Fork icon is replaced with a
   *  spinning Loader2. */
  onFork?: () => Promise<void>;
  /** When provided, render an Edit (Pencil) button (last user message only).
   *  Click is fire-and-forget — the parent owns the inline edit lifecycle. */
  onEdit?: () => void;
  /** When provided, render a Rewind (Undo2) button (user messages only).
   *  Click is fire-and-forget — the parent owns the dialog lifecycle and
   *  signals the loading state via `rewindInFlight`. */
  onRewind?: () => void;
  /** External "rewind in flight" signal — controls icon swap (Undo2 → Loader2)
   *  and bar dim. Owned by the parent because the in-flight period spans the
   *  Preview Dialog's open lifetime + commit, which the bar doesn't manage. */
  rewindInFlight?: boolean;
  /** Per-turn 费用 (USD) — 仅该轮最后一条 assistant 有值, 时间旁显示。 */
  turnCostUsd?: number;
  turnCostIsEstimate?: boolean;
  /** Per-turn token/cache 明细。旧消息没有时 tooltip 保持旧文案。 */
  turnUsageDetails?: TurnUsageDetails;
}

// Total time the bar lingers after hover-leave before opacity drops to 0.
// Acts as a debounce — quick re-enters within this window cancel the fade
// without resetting opacity, so the bar stays steady at full visibility.
const LEAVE_DEBOUNCE_MS = 250;

export function MessageActionBar({
  createdAt,
  copyText,
  copyLinkText,
  align,
  hovered,
  onFork,
  onEdit,
  onRewind,
  rewindInFlight = false,
  turnCostUsd,
  turnCostIsEstimate = false,
  turnUsageDetails,
}: MessageActionBarProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [forking, setForking] = useState(false);
  // Unified in-flight: fork (internal) OR rewind (external) — bar dims & blocks
  // pointer events for either. Same visual treatment for consistency.
  const inFlight = forking || rewindInFlight;
  // `visible` is the actual opacity driver. It tracks `hovered` with a
  // trailing debounce so the bar fades out smoothly (CSS handles the
  // opacity interpolation from current value, not from 1).
  const [visible, setVisible] = useState(hovered);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (hovered) {
      // Hover enter — kill any pending fade-out and snap to visible.
      // CSS transition naturally interpolates from whatever opacity the
      // element currently sits at (mid-fade values are fine).
      if (leaveTimerRef.current) {
        clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
      setVisible(true);
      return;
    }
    // Hover leave — schedule fade after debounce, but don't change opacity yet.
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = setTimeout(() => {
      setVisible(false);
      leaveTimerRef.current = null;
    }, LEAVE_DEBOUNCE_MS);
    return () => {
      if (leaveTimerRef.current) {
        clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
    };
  }, [hovered]);

  // Reset the copy icon on the *next* hover-enter, not on hover-leave.
  // Resetting at leave-time would visually swap ✓ → Copy mid-fade-out
  // (looks like the icon "snapped back"). By tying the reset to the rising
  // edge of `hovered`, the bar fades out still showing ✓, then the next
  // hover starts cleanly with the default Copy icon.
  const prevHoveredRef = useRef(hovered);
  useEffect(() => {
    if (hovered && !prevHoveredRef.current && copied) {
      setCopied(false);
    }
    prevHoveredRef.current = hovered;
  }, [hovered, copied]);

  // 时间点击复制链接的反馈:时间文本短暂换成「链接已复制」,1.5s 后还原。
  useEffect(() => {
    if (!linkCopied) return;
    const timer = setTimeout(() => setLinkCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [linkCopied]);

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(copyText);
        setCopied(true);
      } catch {
        // Clipboard may be unavailable; fail silently — UX falls back to
        // the user noticing nothing happened.
      }
    },
    [copyText],
  );

  const handleFork = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!onFork || forking) return;
      setForking(true);
      try {
        await onFork();
      } finally {
        // Reset regardless of outcome — caller toasts on failure, and on
        // success we usually navigate away anyway so unmount handles it.
        setForking(false);
      }
    },
    [onFork, forking],
  );

  const handleCopyLink = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!copyLinkText) return;
      try {
        await navigator.clipboard.writeText(copyLinkText);
        setLinkCopied(true);
      } catch {
        // Clipboard may be unavailable; fail silently (same as handleCopy).
      }
    },
    [copyLinkText],
  );

  const relText = useRelativeTime(createdAt, { hovered });
  const absText = formatAbsolute(createdAt);
  const Icon = copied ? Check : Copy;

  const copyBtn = (
    <button
      key="copy"
      type="button"
      onClick={handleCopy}
      className={cn(
        'group flex h-[24px] w-[24px] items-center justify-center',
        'rounded-[4px] border-none bg-transparent outline-none cursor-pointer',
        'hover:bg-[var(--cmd-palette-item-hover)] transition-colors',
      )}
      aria-label={t('chat.messageActionBar.copy')}
    >
      <Icon
        size={14}
        strokeWidth={2}
        className={cn(
          'text-[var(--cmd-palette-item-meta)]',
          !copied && 'group-hover:text-[var(--msg-assistant-text)]',
          'transition-colors duration-150',
        )}
      />
    </button>
  );

  // 时间文本兼任「复制消息链接」入口:有 copyLinkText 时可点击复制,tooltip
  // 在绝对时间下加一行提示;复制成功后时间文本短暂换成「链接已复制」。
  const timeTooltip = copyLinkText
    ? [absText, t('chat.messageActionBar.timeCopyHint')].filter(Boolean).join('\n')
    : absText;
  const timeText = relText && (
    <Tooltip.Root key="time">
      <Tooltip.Trigger asChild>
        <time
          dateTime={createdAt}
          onClick={copyLinkText ? handleCopyLink : undefined}
          className={cn(
            'inline-flex h-[24px] items-center text-[12px] font-normal whitespace-nowrap',
            // Optical adjustment: nudge time text down 0.5px so its visual
            // mid-line aligns with the lucide Copy icon glyph center.
            'relative top-[0.5px]',
            // 视觉分组:user 侧(right)时间在最左、后面跟 4 个操作图标
            // ([copy][edit][undo][fork],彼此 gap-0.5=2px 是一组)。时间与图标组
            // 之间额外 +6px(共 8px),让"元信息 | 操作组"两段读起来是独立分组
            // —— 与 assistant 侧 costText 的 ml-1.5 同一间距语言。
            align === 'right' && 'mr-1.5',
            'text-[var(--settings-section-desc)]',
            copyLinkText
              ? 'cursor-pointer hover:text-[var(--msg-assistant-text)] transition-colors duration-150'
              : 'cursor-default',
          )}
        >
          {linkCopied ? t('chat.messageActionBar.linkCopied') : relText}
        </time>
      </Tooltip.Trigger>
      {timeTooltip && (
        <Tooltip.Content>
          <span className="whitespace-pre-line">{timeTooltip}</span>
        </Tooltip.Content>
      )}
    </Tooltip.Root>
  );

  // Per-turn 费用 — 样式与 timeText 完全一致(12px + 同色 + 0.5px 光学修正)。
  // 仅 assistant(align='left')会拿到值;估算值(Codex 折算)表达为 token 价值。
  const turnCostTooltipNode =
    turnCostUsd != null && turnCostUsd > 0 && turnUsageDetails ? (
      <span className="whitespace-pre-line">
        {buildTurnUsageTooltipLines({
          details: turnUsageDetails,
          t,
          costUsd: turnCostUsd,
          isEstimate: turnCostIsEstimate,
        }).join('\n')}
      </span>
    ) : (
      t(
        turnCostIsEstimate
          ? 'chat.messageActionBar.turnCostEstimated'
          : 'chat.messageActionBar.turnCost',
      )
    );

  const costText = turnCostUsd != null && turnCostUsd > 0 && (
    <Tooltip.Root key="cost">
      <Tooltip.Trigger asChild>
        <span
          className={cn(
            'inline-flex h-[24px] items-center text-[12px] font-normal whitespace-nowrap',
            'relative top-[0.5px]',
            // 与时间戳同为 12px 文本,bar 的 gap-0.5(2px)对两段相邻文本太挤 —
            // 额外 6px 左距(共 8px)让时间 / 费用读起来是两个独立信息组。
            'ml-1.5',
            'text-[var(--settings-section-desc)] cursor-default',
          )}
        >
          {turnCostIsEstimate
            ? t('chat.messageActionBar.turnCostEstimatedValue', {
                cost: formatTurnCostUsd(turnCostUsd),
              })
            : formatTurnCostUsd(turnCostUsd)}
        </span>
      </Tooltip.Trigger>
      <Tooltip.Content>
        {turnCostTooltipNode}
      </Tooltip.Content>
    </Tooltip.Root>
  );

  // Edit (Pencil) button — last user message only. Enters the inline edit
  // state owned by UserMessage; no in-flight state here (entering edit is
  // instant and side-effect free — commit happens on the edit box's Send).
  const editBtn = onEdit && align === 'right' && (
    <Tooltip.Root key="edit">
      <Tooltip.Trigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          className={cn(
            'group flex h-[24px] w-[24px] items-center justify-center',
            'rounded-[4px] border-none bg-transparent outline-none cursor-pointer',
            'hover:bg-[var(--cmd-palette-item-hover)] transition-colors',
          )}
          aria-label={t('chat.messageActionBar.edit')}
        >
          <Pencil
            size={14}
            strokeWidth={2}
            className={cn(
              'text-[var(--cmd-palette-item-meta)]',
              'group-hover:text-[var(--msg-assistant-text)]',
              'transition-colors duration-150',
            )}
          />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Content>{t('chat.messageActionBar.edit')}</Tooltip.Content>
    </Tooltip.Root>
  );

  // Rewind (Undo2) button — user messages only. Loading state is driven by
  // `rewindInFlight` (external) since the dialog + commit span outlives this
  // component's local state.
  const rewindBtn = onRewind && align === 'right' && (
    <Tooltip.Root key="rewind">
      <Tooltip.Trigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (rewindInFlight) return;
            onRewind();
          }}
          disabled={rewindInFlight}
          className={cn(
            'group flex h-[24px] w-[24px] items-center justify-center',
            'rounded-[4px] border-none bg-transparent outline-none cursor-pointer',
            'hover:bg-[var(--cmd-palette-item-hover)] transition-colors',
            'disabled:cursor-default',
          )}
          aria-label={t('chat.messageActionBar.rewind')}
        >
          {rewindInFlight ? (
            <Spinner size={14} strokeWidth={2} className="text-[var(--cmd-palette-item-meta)]" />
          ) : (
            <Undo2
              size={14}
              strokeWidth={2}
              className={cn(
                'text-[var(--cmd-palette-item-meta)]',
                'group-hover:text-[var(--msg-assistant-text)]',
                'transition-colors duration-150',
              )}
            />
          )}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Content>{t('chat.messageActionBar.rewind')}</Tooltip.Content>
    </Tooltip.Root>
  );

  // Fork button — user & assistant messages both; the parent decides whether
  // to pass `onFork`. Spinning Loader2 during in-flight.
  const forkBtn = onFork && (
    <Tooltip.Root key="fork">
      <Tooltip.Trigger asChild>
        <button
          type="button"
          onClick={handleFork}
          disabled={forking}
          className={cn(
            'group flex h-[24px] w-[24px] items-center justify-center',
            'rounded-[4px] border-none bg-transparent outline-none cursor-pointer',
            'hover:bg-[var(--cmd-palette-item-hover)] transition-colors',
            'disabled:cursor-default',
          )}
          aria-label={t('chat.messageActionBar.fork')}
        >
          {forking ? (
            <Spinner size={14} strokeWidth={2} className="text-[var(--cmd-palette-item-meta)]" />
          ) : (
            // Split (路径分岔箭头) 比 GitBranch 更贴"分叉对话"的语义 —
            // 不依赖 git 心智模型, 14px 下笔画也更干脆。
            <Split
              size={14}
              strokeWidth={2}
              className={cn(
                'text-[var(--cmd-palette-item-meta)]',
                'group-hover:text-[var(--msg-assistant-text)]',
                'transition-colors duration-150',
              )}
            />
          )}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Content>{t('chat.messageActionBar.fork')}</Tooltip.Content>
    </Tooltip.Root>
  );

  // align='left'  → [copy][fork][time][cost]        (assistant — codex 同款顺序)
  // align='right' → [time][copy][edit][undo][fork]  (edit before rewind — 最常用的放前面)
  const items =
    align === 'left'
      ? [copyBtn, forkBtn, timeText, costText]
      : [timeText, copyBtn, editBtn, rewindBtn, forkBtn];

  return (
    <div
      className={cn(
        'flex items-center gap-0.5',
        align === 'right' ? 'justify-end' : 'justify-start',
        // 250ms is long enough to perceive the fade without dragging.
        // Hover re-enters mid-fade interpolate from the current opacity
        // (browser CSS transition behavior — no replay from 0).
        'transition-opacity duration-[250ms] ease-out',
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none',
        // Fork in-flight: dim entire bar + block clicks (per design notes
        // in message-actions.pen — bar opacity 0.6 + pointer-events:none
        // until the operation resolves).
        // Fork in-flight OR rewind in-flight: dim entire bar + block clicks
        // (per design notes in message-actions.pen — bar opacity 0.6 +
        // pointer-events:none until the operation resolves).
        inFlight && 'opacity-60 pointer-events-none',
      )}
    >
      {items}
    </div>
  );
}
