import { useState } from 'react';
import {
  Hand,
  CodeXml,
  ClipboardList,
  Sparkles,
  TriangleAlert,
  ChevronDown,
  Check,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { MorphPopover } from '@/components/ui/morph-popover';
import { Tip } from '@/components/ui/tooltip';
import {
  useAgentCapabilities,
  type AgentKind,
  type PermissionModeDescriptor,
} from '@/hooks/useAgentCapabilities';
import type { PermissionMode } from '@/lib/userPreferences.types';

interface PermissionSelectorProps {
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  vendorKey?: 'cc' | 'codex';
  /** device-link 远程会话所属被控端 id;非空 = 权限档从被控端读(本地会话 undefined,行为不变)。 */
  deviceId?: string;
  /** 禁用 trigger。用于断线远程会话等只读 composer 状态。 */
  disabled?: boolean;
  /** 窄容器(如 doc rail)下把 trigger 字号/图标各压一档,默认 false。 */
  dense?: boolean;
  /** CREATE AGENT 首页按 Figma 185:2724 使用独立私有 token。 */
  visualVariant?: 'default' | 'create-agent';
  /** 仅普通 composer 显式开启 chip → panel 容器形变；其它消费方维持 Radix Popover。 */
  useMorphPopover?: boolean;
}

/**
 * value → icon 映射: 纯 UI 元数据, 不属于 maker capabilities。
 * 未知 id (maker 加新 mode 还没在 renderer 配图标) 走 Hand 兜底, 不影响显示。
 */
const PERMISSION_ICONS: Record<string, typeof Hand> = {
  ask: Hand,
  default: Hand,
  acceptEdits: CodeXml,
  plan: ClipboardList,
  auto: Sparkles,
  bypassPermissions: TriangleAlert,
};

function vendorKeyToAgentKind(v: 'cc' | 'codex'): AgentKind {
  return v === 'codex' ? 'codex' : 'claude-code';
}

/** Codex 不支持 acceptEdits/plan, 落到 ask 兜底 */
function normalizeMode(mode: PermissionMode, options: PermissionModeDescriptor[]): PermissionMode {
  if (options.some((o) => o.id === mode)) return mode;
  return options[0]?.id ?? mode;
}

function getModeTone(mode: PermissionMode): 'auto' | 'bypassPermissions' | null {
  if (mode === 'auto') return 'auto';
  if (mode === 'bypassPermissions') return 'bypassPermissions';
  return null;
}

/**
 * 权限模式选择器 —— 容器形变(MorphPopover)试点组件。
 * 弹层不再是 Radix Popover 浮层,而是从 trigger chip 原位生长(docs/design-rules/cindy-design-system.md §14.4
 * 容器形变类目);trigger 视觉与旧版逐像素一致,变化只在开合方式。
 */
export function PermissionSelector({
  permissionMode,
  onPermissionModeChange,
  vendorKey = 'cc',
  deviceId,
  disabled = false,
  dense = false,
  visualVariant = 'default',
  useMorphPopover = false,
}: PermissionSelectorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const agentKind = vendorKeyToAgentKind(vendorKey);
  // device-link:deviceId 非空 → 权限档从被控端读(本地会话 undefined,行为不变)。
  const { capabilities } = useAgentCapabilities(agentKind, deviceId);

  const options: PermissionModeDescriptor[] = capabilities?.permissionModes ?? [];
  const effectiveMode =
    options.length > 0 ? normalizeMode(permissionMode, options) : permissionMode;
  const current = options.find((o) => o.id === effectiveMode);
  const TriggerIcon = PERMISSION_ICONS[effectiveMode] ?? Hand;
  const triggerTone = getModeTone(effectiveMode);
  const labelOf = (option: PermissionModeDescriptor | undefined, fallbackId: string) => {
    const id = option?.id ?? fallbackId;
    return t(`newChat.permissionSelector.modes.${agentKind}.${id}.label`, {
      defaultValue: option?.displayName ?? fallbackId,
    });
  };
  const descriptionOf = (option: PermissionModeDescriptor | undefined, fallbackId: string) => {
    const id = option?.id ?? fallbackId;
    return t(`newChat.permissionSelector.modes.${agentKind}.${id}.description`, {
      defaultValue: option?.description ?? '',
    });
  };
  const triggerLabel = labelOf(current, effectiveMode);
  const triggerDescription = descriptionOf(current, effectiveMode);
  const isCreateAgentVariant = visualVariant === 'create-agent';
  const morphEnabled = useMorphPopover && !isCreateAgentVariant;

  /** trigger tone 文字色(chip 与 ghost 共用,sanctioned 蓝/橙仅文字层) */
  const toneClassName = cn(
    triggerTone === 'auto' && 'text-[var(--perm-auto-selected-text)]',
    triggerTone === 'bypassPermissions' && 'text-[var(--perm-bypass-selected-text)]',
  );

  /** chip 内容行(icon + label + chevron):trigger 按钮与形变 ghost 共用同一渲染 */
  const triggerContent = (
    <>
      <TriggerIcon
        size={isCreateAgentVariant ? 11 : dense ? 13 : 14}
        className="shrink-0 text-current"
      />
      <span
        className={cn(
          // min-w-0 让 span 能在 flex 容器里跌破内容宽度,truncate 才能在窄宽下出现 "完..."
          'min-w-0 font-normal text-current',
          'truncate',
          isCreateAgentVariant ? 'text-[12px]' : dense ? 'text-[12.5px]' : 'text-[13px]',
        )}
      >
        {triggerLabel}
      </span>
      <div className="pt-[2px]">
        <ChevronDown
          size={isCreateAgentVariant ? 8 : dense ? 13 : 14}
          className={cn(
            'shrink-0',
            'text-current',
          )}
        />
      </div>
    </>
  );

  const trigger = (
    <Tip
      text={triggerDescription}
      side="top"
      contentClassName="max-w-[280px] whitespace-normal break-words text-left"
    >
      <button
        type="button"
        disabled={disabled}
        onClick={morphEnabled ? () => setOpen((prev) => (disabled ? false : !prev)) : undefined}
        aria-expanded={open && !disabled}
        aria-haspopup="listbox"
        className={cn(
          'flex min-w-0 items-center gap-1 overflow-hidden rounded-full transition-colors',
          isCreateAgentVariant
            ? [
                'h-[30px] min-w-[52px] max-w-full shrink border border-[var(--create-agent-control-border)]',
                'bg-[var(--create-agent-control-bg)] py-0 pl-2.5 pr-2 text-[var(--create-agent-control-text)]',
                'hover:bg-[var(--create-agent-control-bg-hover)] active:bg-[var(--create-agent-control-bg-pressed)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--create-agent-focus-ring)]',
              ]
            : morphEnabled
              ? [
                  'h-[30px] min-w-[72px] max-w-full shrink px-2.5',
                  'border border-transparent bg-transparent text-[var(--text-primary)]',
                  'hover:border-[var(--border-default)] hover:bg-[var(--composer-pill-bg,#FCFCFC)] dark:hover:bg-[var(--composer-pill-bg,#393838)]',
                ]
              : [
                  'h-[30px] min-w-[72px] max-w-full shrink px-2.5',
                  'bg-[var(--composer-pill-bg,#FCFCFC)] dark:bg-[var(--composer-pill-bg,#393838)] border border-[var(--border-default)] text-[var(--text-primary)]',
                  'hover:bg-[var(--model-trigger-hover)]',
                ],
          triggerTone === 'auto' && 'text-[var(--perm-auto-selected-text)]',
          triggerTone === 'bypassPermissions' && 'text-[var(--perm-bypass-selected-text)]',
          disabled && 'pointer-events-none opacity-50',
        )}
        aria-label={t('newChat.permissionSelector.triggerAria', { label: triggerLabel })}
      >
        {triggerContent}
      </button>
    </Tip>
  );

  const optionList = (
    <div role="listbox" aria-label={t('newChat.permissionSelector.listAria')}>
        {options.map((option) => {
          const Icon = PERMISSION_ICONS[option.id] ?? Hand;
          const isSelected = effectiveMode === option.id;
          const selectedTone = isSelected ? getModeTone(option.id) : null;
          const label = labelOf(option, option.id);
          const description = descriptionOf(option, option.id);
          return (
            <Tip
              key={option.id}
              text={description}
              side="right"
              contentClassName="max-w-[280px] whitespace-normal break-words text-left"
            >
              <button
                onClick={() => {
                  onPermissionModeChange(option.id);
                  setOpen(false);
                }}
                role="option"
                aria-selected={isSelected}
                className={cn(
                  'flex w-full items-center gap-3 rounded-[8px] px-[14px] py-2',
                  'transition-colors',
                  'hover:bg-[var(--model-item-hover)]',
                  isSelected && 'bg-[var(--perm-item-selected-bg)]',
                  selectedTone === 'auto' && 'text-[var(--perm-auto-selected-text)]',
                  selectedTone === 'bypassPermissions' &&
                    'text-[var(--perm-bypass-selected-text)]',
                )}
              >
                <Icon
                  size={17}
                  className={cn(
                    'shrink-0',
                    selectedTone ? 'text-current' : 'text-[var(--model-item-text)]',
                  )}
                />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-left text-[14px] font-medium',
                    selectedTone ? 'text-current' : 'text-[var(--model-item-text)]',
                  )}
                >
                  {label}
                </span>
                {isSelected && (
                  <Check
                    size={13}
                    className={cn(
                      'shrink-0',
                      selectedTone ? 'text-current' : 'text-[var(--model-item-check)]',
                    )}
                  />
                )}
              </button>
            </Tip>
          );
        })}
    </div>
  );

  if (morphEnabled) {
    return (
      <MorphPopover
        open={open && !disabled}
        onOpenChange={(next) => setOpen(disabled ? false : next)}
        panelWidth={300}
        panelClassName="p-2"
        panelAriaLabel={t('newChat.permissionSelector.listAria')}
        wrapperClassName="min-w-0 shrink"
        trigger={trigger}
        ghost={
          <span className={cn('flex items-center gap-1 px-2.5 text-[var(--text-primary)]', toneClassName)}>
            {triggerContent}
          </span>
        }
      >
        {optionList}
      </MorphPopover>
    );
  }

  return (
    <Popover open={open && !disabled} onOpenChange={(next) => setOpen(disabled ? false : next)}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className={cn(
          'w-[300px] rounded-[12px] p-2',
          'bg-[var(--model-dropdown-bg)]',
          'border border-[var(--model-dropdown-border)]',
        )}
      >
        {optionList}
      </PopoverContent>
    </Popover>
  );
}
