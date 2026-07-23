/**
 * ExtraDirsButton —— composer 的「+」操作菜单(左置于权限选择器之前)。
 *
 * 合并了三类入口(参考 Codex 的 + 菜单):
 *   - 新建目标(`onNewGoal` 提供时显示;仅会话中,父组件按 sessionId 决定)→ 打开 NewGoalDialog。
 *   - 已安装 Plugin:选择后由 ChatInput 把 command 放到消息开头,保留正文并聚焦末尾。
 *   - 附加只读引用目录(Claude vendor;`onChange` 提供时显示)→ 列表 / 添加。
 *
 * 创建时和 session 中途共用同一组件:父组件传 onChange 决定目录持久化路径:
 *   - 创建时(NewMakerDraftRoute):写 newMakerDraft store
 *   - 中途(CCAgentSessionView):同步调 sessionService.update + window.electronAPI.maker.setExtraDirs
 *
 * 视觉:trigger 是一个「+」(rounded-full / 14px 图标),有引用目录时带 ×N 角标。
 * Popover 列出新建目标项 + 引用目录段(可单条删除)+ "添加目录"。
 *
 * 校验:选中路径与 workingDir 重叠时:子目录静默去重;父目录弹 confirm。
 * main 端 extraDirsValidator.ts 兜底 — 这里只做 UX 预判。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ClipboardList, FolderPlus, Plus, Target, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { MorphPopover } from '@/components/ui/morph-popover';
import { Tip } from '@/components/ui/tooltip';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { createLogger } from '@/lib/logger';
import { GhostPluginIcon } from '@/features/plugin/GhostPluginIcon';
import { stripTrailingPathSeparators } from '../../../shared/pathText';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir';
import type { InstalledGhost } from '../../../shared/ghost';

const log = createLogger('ExtraDirsButton');

/** 与 main 端 EXTRA_DIRS_MAX 保持一致;UI 满了 disable 添加按钮。 */
const MAX_EXTRA_DIRS = 10;

export interface ExtraDirsButtonProps {
  extraDirs: string[];
  workingDir?: string | null;
  /** 'cc' 才渲染按钮; 其它(包括 codex)直接返回 null。 */
  agentKind: 'cc' | 'codex';
  /** 父组件实现增删持久化(创建时写 draft store / 中途双 IPC 协调)。 */
  onChange: (next: string[]) => void | Promise<void>;
  /** 提供时在菜单顶部显示「新建目标」项(仅会话中;点击 → 父组件打开 NewGoalDialog)。 */
  onNewGoal?: () => void;
  /**
   * 计划模式 toggle(与「新建目标」同级的一级入口)。提供时显示菜单项;
   * 父组件负责能力门控(capabilities.planMode)与持久化,这里只做 UI。
   */
  planMode?: { enabled: boolean; onToggle: (next: boolean) => void };
  /** 已安装 Plugin 清单;无指令或未生效项仍展示,但不可选。 */
  plugins?: readonly InstalledGhost[];
  /** 当前会话范围内可直接使用的 Plugin id;未命中项保留展示但置灰。 */
  pluginAvailableIds?: ReadonlySet<string>;
  /** 选择后由 ChatInput 把 Plugin command 放到正文开头并把光标落到全文末尾。 */
  onPluginSelect?: (ghost: InstalledGhost) => void;
  disabled?: boolean;
  /** 窄容器下把 trigger 字号/图标各压一档,默认 false。 */
  dense?: boolean;
  /** CREATE AGENT 首页按 Figma 185:2724 使用独立私有 token。 */
  visualVariant?: 'default' | 'create-agent';
  /** 仅普通 composer 显式开启 chip → panel 容器形变；其它消费方维持 Radix。 */
  useMorphPopover?: boolean;
}

function normalizedPathForComparison(raw: string | null | undefined): string | null {
  const normalized = normalizeWorkingDirForStorage(raw);
  return normalized ? stripTrailingPathSeparators(normalized) : null;
}

/**
 * 判断 candidate 是否是 base 自身或子目录(简单字符串前缀,跨平台够用 —— main 端
 * extraDirsValidator 用 path.relative 做权威判定)。
 */
function isSelfOrSubdir(candidate: string, base: string): boolean {
  const c = normalizedPathForComparison(candidate);
  const b = normalizedPathForComparison(base);
  if (!c || !b) return false;
  if (c === b) return true;
  return c.startsWith(b + '/');
}

function isSameStoragePath(a: string, b: string): boolean {
  const normalizedA = normalizedPathForComparison(a);
  const normalizedB = normalizedPathForComparison(b);
  return !!normalizedA && !!normalizedB && normalizedA === normalizedB;
}

function hasExtraDir(extraDirs: string[], candidate: string): boolean {
  return extraDirs.some((existing) => isSameStoragePath(existing, candidate));
}

/** candidate 是 base 父目录或祖先(反过来:base 是 candidate 的子目录)。 */
function isParentOrAncestor(candidate: string, base: string): boolean {
  const c = normalizedPathForComparison(candidate);
  const b = normalizedPathForComparison(base);
  if (!c || !b || c === b) return false;
  return isSelfOrSubdir(b, c);
}

export const __extraDirsPathOverlapForTesting = {
  hasExtraDir,
  isParentOrAncestor,
  isSelfOrSubdir,
};

/** 取目录名做 chip 显示;空回 '/' 。 */
function basename(p: string): string {
  const stripped = stripTrailingPathSeparators(p);
  const parts = stripped.split(/[\\/]/);
  return parts[parts.length - 1] || stripped || '/';
}

export function ExtraDirsButton({
  extraDirs,
  workingDir,
  agentKind,
  onChange,
  onNewGoal,
  planMode,
  plugins = [],
  pluginAvailableIds,
  onPluginSelect,
  disabled,
  dense = false,
  visualVariant = 'default',
  useMorphPopover = false,
}: ExtraDirsButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { confirm } = useConfirmDialog();

  const isCc = agentKind === 'cc';
  const count = extraDirs.length;
  const isCreateAgentVariant = visualVariant === 'create-agent';
  const morphEnabled = useMorphPopover && !isCreateAgentVariant;

  // ── hover 宽度形变(docs/design-rules/cindy-design-system.md §14.4 窄变体,≤240ms)──
  // 仅 default 变体的纯图标态:hover 横向展出「添加」标签;菜单打开期间不展开,
  // 关闭后若鼠标已移开则回纯「+」。带 ×N 计数的形态与 create-agent 保持原样。
  // 注意:这些 hooks 必须在下方能力早退 return 之前声明(Rules of Hooks)。
  const [hovered, setHovered] = useState(false);
  const triggerBtnRef = useRef<HTMLButtonElement>(null);
  const expandLabelRef = useRef<HTMLSpanElement>(null);
  const [pillWidth, setPillWidth] = useState<number | null>(null);
  const expandable = morphEnabled && !(count > 0 && isCc);
  // 菜单打开期间(含收合动画的 340ms 余辉)冻结展开态:chip 虽被 MorphPopover
  // 隐藏,但它的布局宽度决定工具条排布与面板锚点 —— 中途回缩会推挤相邻 chips、
  // 让收合动画对不上位置(关闭时抖一下,2026-07-22 用户反馈)。面板收完、chip
  // 复形之后,再按真实悬停态决定是否收回纯「+」(此时收缩是可见的平滑动画)。
  const [lingerOpen, setLingerOpen] = useState(false);
  const expanded = expandable && !disabled && (open || lingerOpen || hovered);
  useEffect(() => {
    if (!morphEnabled) return;
    if (open) {
      setLingerOpen(true);
      return;
    }
    const id = window.setTimeout(() => {
      setLingerOpen(false);
      setHovered(triggerBtnRef.current?.matches(':hover') ?? false);
    }, 340); // MorphPopover 收合 300ms + chip 复形 20ms 之后
    return () => window.clearTimeout(id);
  }, [morphEnabled, open]);
  useLayoutEffect(() => {
    if (!expanded) {
      setPillWidth(null);
      return;
    }
    // 28px 图标位 + 标签实测宽(含右 padding)+ 2px 余量
    setPillWidth(28 + (expandLabelRef.current?.scrollWidth ?? 0) + 2);
  }, [expanded]);
  const reduceMotion =
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const pillTransition = reduceMotion
    ? undefined
    : 'width 240ms cubic-bezier(0.3, 0.9, 0.25, 1), background-color 150ms ease, color 150ms ease';

  // 能力感知:新建目标(onNewGoal)/ 计划模式(planMode)两端通用;引用目录仅 cc
  // (Codex 忽略 extraDirs)。三样都没有才不渲染。
  if (!onNewGoal && !planMode && !isCc && plugins.length === 0) return null;

  const atLimit = count >= MAX_EXTRA_DIRS;

  const handleAdd = async () => {
    if (atLimit) return;
    let picked: string | null = null;
    try {
      const r = await window.electronAPI.dialog.showOpenDirectory({});
      picked = r?.success ? r.path : null;
    } catch (e) {
      log.warn('showOpenDirectory failed', { error: String(e) });
      return;
    }
    const normalizedPicked = normalizeWorkingDirForStorage(picked);
    if (!normalizedPicked) return;

    // UX 预判: 完全重复 / 是 workingDir 子目录 → 静默忽略(main validator 也会兜)。
    if (hasExtraDir(extraDirs, normalizedPicked)) return;
    if (workingDir && isSelfOrSubdir(normalizedPicked, workingDir)) {
      log.debug('add: silently skipped (subdir of workingDir)', {
        picked: normalizedPicked,
        workingDir,
      });
      return;
    }

    // 父目录 / 祖先警告 — 通过则继续。
    if (workingDir && isParentOrAncestor(normalizedPicked, workingDir)) {
      const ok = await confirm({
        title: '添加父目录?',
        description: `选中的目录是当前工作目录的父级或祖先。这会扩大 agent 的可见范围 —— 它能看到工作目录之外的内容。\n\n要添加吗?\n\n${normalizedPicked}`,
        confirmText: '仍然添加',
        cancelText: '取消',
      });
      if (!ok) return;
    }

    await onChange([...extraDirs, normalizedPicked]);
  };

  const handleRemove = async (path: string) => {
    await onChange(extraDirs.filter((p) => p !== path));
  };

  const trigger = (
    <Tip
          text={count === 0 ? t('extraDirs.tooltipEmpty') : t('extraDirs.tooltipCount', { count })}
          side="top"
        >
          <button
            ref={triggerBtnRef}
            type="button"
            disabled={disabled}
            onClick={morphEnabled ? () => setOpen((prev) => !prev) : undefined}
            onMouseEnter={morphEnabled ? () => setHovered(true) : undefined}
            onMouseLeave={morphEnabled ? () => setHovered(false) : undefined}
            aria-expanded={open}
            aria-haspopup="menu"
            className={cn(
              'flex shrink-0 items-center rounded-full transition-colors',
              isCreateAgentVariant
                ? [
                    'h-[30px] w-[30px] justify-center border border-[var(--create-agent-control-border)]',
                    'bg-[var(--create-agent-control-bg)] p-0 text-[var(--create-agent-control-icon)]',
                    'hover:bg-[var(--create-agent-control-bg-hover)] active:bg-[var(--create-agent-control-bg-pressed)]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--create-agent-focus-ring)]',
                  ]
                : morphEnabled
                  ? [
                      'h-[30px]',
                      count > 0 && isCc
                        ? 'min-w-max justify-center gap-1 px-2.5'
                        : 'justify-start overflow-hidden p-0',
                      'border border-transparent bg-transparent text-[var(--composer-pill-icon,#3C3F43)] dark:text-[var(--composer-pill-icon,#D9D9D9)]',
                      'hover:border-[var(--border-default)] hover:bg-[var(--composer-pill-bg,#FCFCFC)] dark:hover:bg-[var(--composer-pill-bg,#393838)]',
                    ]
                  : [
                      'h-[30px]',
                      count > 0 && isCc
                        ? 'min-w-max justify-center gap-1 px-2.5'
                        : 'w-[30px] justify-center p-0',
                      'bg-[var(--composer-pill-bg,#FCFCFC)] dark:bg-[var(--composer-pill-bg,#393838)] border border-[var(--border-default)] text-[var(--composer-pill-icon,#3C3F43)] dark:text-[var(--composer-pill-icon,#D9D9D9)]',
                      'hover:bg-[var(--model-trigger-hover)]',
                    ],
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
            style={expandable ? { width: pillWidth ?? 30, transition: pillTransition } : undefined}
            aria-label={t('extraDirs.menuAria')}
          >
            {expandable ? (
              <>
                <span className="flex h-[28px] w-[28px] shrink-0 items-center justify-center">
                  <Plus size={14} className="shrink-0" />
                </span>
                <span
                  ref={expandLabelRef}
                  className={cn(
                    'whitespace-nowrap pr-3',
                    dense ? 'text-[12.5px]' : 'text-[13px]',
                    '-translate-x-1 opacity-0 transition-[opacity,transform] duration-[180ms] ease-out',
                    expanded && 'translate-x-0 opacity-100',
                    'motion-reduce:transition-none',
                  )}
                >
                  {t('extraDirs.expandLabel')}
                </span>
              </>
            ) : (
              <>
                <Plus
                  size={isCreateAgentVariant ? 11 : dense ? 14 : 14}
                  className="shrink-0"
                />
                {count > 0 && isCc && !isCreateAgentVariant && (
                  <span
                    className={cn(
                      'font-normal tabular-nums',
                      dense ? 'text-[12.5px]' : 'text-[13px]',
                    )}
                  >
                    ×{count}
                  </span>
                )}
              </>
            )}
          </button>
    </Tip>
  );

  const menuContent = (
    <>
        {/* 新建目标(仅会话中;点击关菜单并由父组件打开 NewGoalDialog) */}
        {onNewGoal && (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onNewGoal();
            }}
            className={cn(
              'flex w-full items-center gap-2 rounded-[8px] px-[10px] py-2',
              'transition-colors hover:bg-[var(--model-item-hover)]',
            )}
          >
            <Target size={14} className="shrink-0 text-[var(--model-item-text)]" />
            <span className="text-[13px] text-[var(--model-item-text)]">
              {t('goal.newGoalMenuItem')}
            </span>
          </button>
        )}

        {/* 计划模式 toggle(与「新建目标」同级):勾选态右侧打勾;点击切换并关菜单。 */}
        {planMode && (
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={planMode.enabled}
            onClick={() => {
              setOpen(false);
              planMode.onToggle(!planMode.enabled);
            }}
            className={cn(
              'flex w-full items-center gap-2 rounded-[8px] px-[10px] py-2',
              'transition-colors hover:bg-[var(--model-item-hover)]',
            )}
          >
            <ClipboardList size={14} className="shrink-0 text-[var(--model-item-text)]" />
            <span className="min-w-0 flex-1 truncate text-left text-[13px] text-[var(--model-item-text)]">
              {t('planMode.menuItem')}
            </span>
            {planMode.enabled && (
              <Check size={13} className="shrink-0 text-[var(--model-item-check)]" />
            )}
          </button>
        )}

        {plugins.length > 0 && (
          <>
            {(onNewGoal || planMode) && (
              <div className="my-1 h-px bg-[var(--model-dropdown-border)]" />
            )}
            <div className="px-2 pb-1 pt-1 text-[12px] text-[var(--model-trigger-text)] opacity-70">
              {t('extraDirs.pluginsTitle')}
            </div>
            <div
              role="list"
              aria-label={t('extraDirs.pluginsTitle')}
              className="plugin-motion-root max-h-[200px] overflow-y-auto"
            >
              {plugins.map((ghost) => {
                const availableInScope = pluginAvailableIds
                  ? pluginAvailableIds.has(ghost.manifest.id)
                  : ghost.enabled;
                const selectable = Boolean(
                  availableInScope && ghost.manifest.command && onPluginSelect,
                );
                return (
                  <button
                    key={ghost.manifest.id}
                    type="button"
                    disabled={!selectable}
                    onClick={() => {
                      setOpen(false);
                      onPluginSelect?.(ghost);
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-[8px] px-[10px] py-2 text-left',
                      'transition-colors hover:bg-[var(--model-item-hover)]',
                      'disabled:cursor-not-allowed disabled:opacity-45',
                    )}
                  >
                    <GhostPluginIcon
                      iconDataUrl={ghost.iconDataUrl}
                      iconId={ghost.manifest.id}
                      iconName={ghost.manifest.name}
                      size="menu"
                    />
                    <span className="min-w-0 flex-1 truncate text-left text-[13px] text-[var(--model-item-text)]">
                      {ghost.manifest.name}
                    </span>
                    {!selectable ? (
                      <span className="shrink-0 text-[12px] text-[var(--model-trigger-text)] opacity-70">
                        {t(
                          ghost.manifest.command
                            ? 'extraDirs.pluginDisabled'
                            : 'extraDirs.pluginNoCommand',
                        )}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* 引用目录段:仅 Claude(cc)显示;Codex 忽略 extraDirs,只保留上面的入口项。 */}
        {isCc && (
          <>
            {(onNewGoal || planMode || plugins.length > 0) && (
              <div className="my-1 h-px bg-[var(--model-dropdown-border)]" />
            )}

            <div className="px-2 pb-1 pt-1 text-[12px] text-[var(--model-trigger-text)] opacity-70">
              {t('extraDirs.sectionTitle')}
            </div>

            {count > 0 ? (
              <div role="list" aria-label="Extra reference directories" className="mb-1">
                {extraDirs.map((p) => (
                  <div
                    key={p}
                    className={cn(
                      'group flex items-center gap-2 rounded-[8px] px-[10px] py-2',
                      'hover:bg-[var(--model-item-hover)]',
                    )}
                  >
                    <FolderPlus
                      size={14}
                      className="shrink-0 text-[var(--model-item-text)] opacity-60"
                    />
                    <Tip text={p} mono side="top">
                      <span className="min-w-0 flex-1 truncate text-left text-[13px] text-[var(--model-item-text)]">
                        {basename(p)}
                      </span>
                    </Tip>
                    <button
                      type="button"
                      onClick={() => void handleRemove(p)}
                      className={cn(
                        'rounded-full p-1 opacity-0 transition-opacity',
                        'hover:bg-[var(--model-item-hover)]',
                        'group-hover:opacity-70 hover:!opacity-100',
                      )}
                      aria-label={t('extraDirs.remove', { name: basename(p) })}
                    >
                      <X size={12} className="text-[var(--model-item-text)]" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-[10px] py-2 text-[12px] text-[var(--model-item-text)] opacity-50">
                {t('extraDirs.empty')}
              </div>
            )}

            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={atLimit}
              className={cn(
                'flex w-full items-center gap-2 rounded-[8px] px-[10px] py-2',
                'transition-colors',
                'hover:bg-[var(--model-item-hover)]',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <FolderPlus size={14} className="shrink-0 text-[var(--model-item-text)]" />
              <span className="text-[13px] text-[var(--model-item-text)]">
                {atLimit ? t('extraDirs.atLimit', { max: MAX_EXTRA_DIRS }) : t('extraDirs.add')}
              </span>
            </button>
          </>
        )}
    </>
  );

  if (morphEnabled) {
    return (
      <MorphPopover
        open={open}
        onOpenChange={setOpen}
        panelWidth={360}
        panelClassName="p-2"
        panelAriaLabel={t('extraDirs.menuAria')}
        wrapperClassName="shrink-0"
        trigger={trigger}
      >
        {menuContent}
      </MorphPopover>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className={cn(
          'w-[360px] rounded-[12px] p-2',
          'bg-[var(--model-dropdown-bg)]',
          'border border-[var(--model-dropdown-border)]',
        )}
      >
        {menuContent}
      </PopoverContent>
    </Popover>
  );
}
