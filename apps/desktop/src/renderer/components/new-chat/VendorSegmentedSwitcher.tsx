/**
 * VendorSegmentedSwitcher —— NewMaker 主区域内的 vendor 切换控件。
 * ---------------------------------------------------------------------------
 * 设计稿对照(doc/design_docs/cc-agent-view.pen 节点 HPzt0/wBlHH):
 *   - 容器:pill (9999px),宽 220,padding 3,gap 2
 *           Light fill #e5e5e5 / Dark fill #1f1f1e + 1px Board #3c3c3a
 *   - segment:pill,padding [6,14],fill_container,justifyContent center,gap 6
 *     · Active : Light Card #ffffff + 1px Board #d7d7d4 / Dark #3c3c3a
 *     · Inactive: 透明,文字 Stone #737373
 *   - icon: 14×14 vendor mark (Claude / OpenAI)
 *   - 文字: Inter 14, active weight 500,inactive weight 400
 *
 * F-COLLAB (2026-05): 原本第 3 个 "协同模式" tab 已被 ChatInput 底部的
 * CollaborationModeToggle 取代 — 用户先选 Claude 走单 session,需要时再 toggle
 * 召集 Worker。删 tab 后整体回到 2-tab 220 宽,与历史版本视觉对齐。
 */

import type { ComponentType } from 'react';
import { cn } from '@/lib/utils';
import type { MakerVendor } from '@/lib/ccAgent.types';
import { CodexMark } from '@/components/icons/CodexMark';
import { ClaudeMark } from '@/components/icons/ClaudeMark';

interface VendorSegmentedSwitcherProps {
  value: MakerVendor;
  onChange: (next: MakerVendor) => void;
  /** disabled 状态(发送中等);整体降透明且不响应点击。 */
  disabled?: boolean;
  className?: string;
}

interface SegmentOption {
  vendor: MakerVendor;
  label: string;
  Mark: ComponentType<{ size?: number; className?: string }>;
  iconClassName?: string;
}

const OPTIONS: readonly SegmentOption[] = [
  { vendor: 'cc', label: 'Claude', Mark: ClaudeMark },
  { vendor: 'codex', label: 'Codex', Mark: CodexMark },
] as const;

export function VendorSegmentedSwitcher({
  value,
  onChange,
  disabled,
  className,
}: VendorSegmentedSwitcherProps) {
  return (
    <div
      className={cn(
        'flex h-9 items-center gap-0.5 rounded-full p-[3px]',
        'bg-[var(--chat-input-bg)] dark:border dark:border-[var(--cmd-palette-border)]',
        disabled && 'opacity-60 pointer-events-none',
        className,
      )}
      style={{ width: 220 }}
      role="tablist"
      aria-label="Vendor switcher"
    >
      {OPTIONS.map((opt) => {
        const isActive = value === opt.vendor;
        return (
          <button
            key={opt.vendor}
            type="button"
            role="tab"
            aria-selected={isActive}
            // 阻止 mousedown 抢焦点 —— 否则点 tab 时下方 ChatInput 的 :focus-within
            // 边框会瞬间掉到非聚焦色。键盘 Tab 仍可正常 focus 本按钮（preventDefault
            // 只阻断鼠标路径），无障碍不受影响。
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (isActive) return;
              onChange(opt.vendor);
            }}
            className={cn(
              'flex h-full flex-1 items-center justify-center gap-1.5 rounded-full',
              'text-[14px] leading-none transition-colors',
              isActive
                ? cn(
                    'font-medium',
                    // Active: Card 色凸起 + 1px Board 描边
                    'bg-[var(--chat-input-chip-bg)] text-[var(--chat-input-chip-text)] border border-[var(--cmd-palette-border)]',
                    'dark:border-transparent',
                  )
                : cn(
                    'font-normal text-[var(--cmd-palette-item-meta)]',
                    'hover:text-[var(--msg-assistant-text)]',
                  ),
            )}
          >
            <opt.Mark size={14} className={cn('shrink-0', opt.iconClassName)} />
            {/* 文字下沉 0.5px —— Inter 在 leading-none 下视觉重心偏上,与 vendor mark
                光学居中对齐微调,见 NewChat 视觉走查 2026-05-03。 */}
            <span className="translate-y-[0.5px] whitespace-nowrap">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
