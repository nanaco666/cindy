/**
 * WorktreeChipsRow — F1-E Hidden Advanced：默认只显 folder + 齿轮，点齿轮弹 popover 展示
 * branch / worktree 高级选项。
 *
 * 设计意图（对照 doc/design_docs/worktree.pen 的 F1-E 帧 3pLoX）：
 *   - 默认视觉极简，folder chip 是主操作；worktree 是真正的"高级选项"被埋深
 *   - 点齿轮 → popover 滑下，展示 Branch 下拉 + Use worktree 复选框
 *   - 关闭 popover 不丢状态；worktree ON 时齿轮带主色提示
 *
 * worktree 名称 **自动生成**（不暴露 UI），由 useSuggestName 拉取后透传给上层。
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { GitBranch, ChevronDown, Folder, MessageCircle, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tip, Tooltip } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  FolderPickerPopover,
  addRecentFolder,
  type FolderPickerOption,
  type FolderPickerSelectSource,
} from './FolderPickerPopover';
import { useBranches, useDetectCwd, useSuggestName } from '@/hooks/useWorktreeQueries';
import { getProjectPickerDisplayName } from '@/hooks/useProjectPickerOptions';

export type FolderPickerMode = 'folder' | 'project';

export interface WorktreeChipsRowProps {
  cwd: string | null;
  // 接受 null:当 picker 选了"对话(不在项目中)"时,上游需要清掉 workingDir
  // 让 send 流程按 workspaceKind='dialogue' 走。
  onSelectFolder?: (folderPath: string | null) => void;
  folderPickerOpen?: boolean;
  onFolderPickerOpenChange?: (open: boolean) => void;
  folderPickerMode?: FolderPickerMode;
  projectOptions?: readonly FolderPickerOption[];
  /** Phase D — 添加远程项目入口的回调; 上层在 hasAnyAutoConnectHost 为 true
   *  时才传, 透传给 FolderPickerPopover 决定是否渲染按钮。 */
  onAddRemoteProject?: () => void;
  emptyProjectLabel?: string;
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  sourceBranch: string;
  onSourceBranchChange: (v: string) => void;
  onBaseRepoChange?: (baseRepo: string | null) => void;
  onSuggestedNameChange?: (name: string) => void;
  worktreeDisabled?: boolean;
  disabled?: boolean;
  /**
   * device-link 被控端 deviceId。非空表示 cwd 是被控端路径,git 探测 / 分支列表 /
   * 建议名全部经隧道在被控端执行(本机 git 对远程路径必然误报"不是 git 仓库")。
   */
  deviceLinkDeviceId?: string | null;
  /**
   * 渲染变体(2026-07-19 恢复 worktree 入口):统一创建页对齐 Figma 后项目选择
   * 由页面自己的 mode pill 承担,'advancedOnly' 只渲染齿轮 AdvancedPopover
   * (git 探测/分支/建议名逻辑全保留);缺省 'full' = folder chip + 齿轮原样。
   */
  variant?: 'full' | 'advancedOnly';
  /** true → 齿轮走 30px 紧凑版 + create-agent 控件 token,与新建页 mode pill 同排对齐。 */
  compact?: boolean;
}

export function WorktreeChipsRow({
  cwd,
  onSelectFolder,
  folderPickerOpen,
  onFolderPickerOpenChange,
  folderPickerMode = 'folder',
  projectOptions,
  onAddRemoteProject,
  emptyProjectLabel,
  enabled,
  onEnabledChange,
  sourceBranch,
  onSourceBranchChange,
  onBaseRepoChange,
  onSuggestedNameChange,
  worktreeDisabled,
  disabled,
  deviceLinkDeviceId,
  variant = 'full',
  compact = false,
}: WorktreeChipsRowProps) {
  const { t } = useTranslation();
  // 统一创建页的 project-picker 模式下, cwd 为空表示即将创建纯对话。
  // worktree/branch 依赖真实项目目录,这里隐藏 Advanced 并清掉残留状态。
  const advancedHidden = folderPickerMode === 'project' && !cwd;
  const detect = useDetectCwd(worktreeDisabled ? null : (cwd ?? null), deviceLinkDeviceId);
  const baseRepo = detect.data?.repoRoot ?? null;

  useEffect(() => {
    onBaseRepoChange?.(baseRepo);
  }, [baseRepo, onBaseRepoChange]);

  const cantUseReason = useMemo<string | null>(() => {
    if (detect.loading) return t('newChat.worktree.detecting');
    if (!detect.data) return null;
    const d = detect.data;
    if (!d.gitInstalled) return t('newChat.worktree.gitMissing');
    if (!d.isGitRepo) return t('newChat.worktree.notGitRepo');
    if (d.isInsideWorktree) return t('newChat.worktree.alreadyInWorktree');
    return null;
  }, [detect.data, detect.loading, t]);

  const switchDisabled = disabled || worktreeDisabled || !!cantUseReason || detect.loading || !cwd;

  useEffect(() => {
    if (detect.loading) return;
    if (cantUseReason && enabled) onEnabledChange(false);
  }, [cantUseReason, enabled, onEnabledChange, detect.loading]);

  useEffect(() => {
    if (advancedHidden && enabled) onEnabledChange(false);
  }, [advancedHidden, enabled, onEnabledChange]);

  useEffect(() => {
    if (worktreeDisabled && enabled) onEnabledChange(false);
  }, [worktreeDisabled, enabled, onEnabledChange]);

  const effectiveWorktreeEnabled = enabled && !advancedHidden && !worktreeDisabled;
  const branches = useBranches(effectiveWorktreeEnabled ? baseRepo : null, deviceLinkDeviceId);
  const suggested = useSuggestName(effectiveWorktreeEnabled ? baseRepo : null, deviceLinkDeviceId);

  useEffect(() => {
    if (!effectiveWorktreeEnabled || sourceBranch || !branches.current) return;
    onSourceBranchChange(branches.current);
  }, [effectiveWorktreeEnabled, sourceBranch, branches.current, onSourceBranchChange]);

  const lastNameRef = useRef('');
  useEffect(() => {
    if (!effectiveWorktreeEnabled) {
      lastNameRef.current = '';
      onSuggestedNameChange?.('');
      return;
    }
    if (suggested.name && suggested.name !== lastNameRef.current) {
      lastNameRef.current = suggested.name;
      onSuggestedNameChange?.(suggested.name);
    }
  }, [effectiveWorktreeEnabled, suggested.name, onSuggestedNameChange]);

  const folderBasename = useMemo(
    () => getProjectPickerDisplayName(cwd, projectOptions),
    [cwd, projectOptions],
  );

  // project 模式下 cwd 为空就是"对话"默认上下文,但 chip 仍可打开 picker
  // 切到项目;folder 模式保留原来的"选择文件夹"语义。
  const folderSelectLabel =
    folderPickerMode === 'project' && !cwd
      ? (emptyProjectLabel ?? t('newChat.folderPicker.dialogue'))
      : folderPickerMode === 'project'
        ? t('newChat.folderPicker.selectProject')
        : t('newChat.folderPicker.selectFolder');

  // advancedOnly:项目选择交给页面自己的 pill,这里只出齿轮(cwd 为空时随
  // advancedHidden 整体不渲染,与 full 变体同一套隐藏/清状态 effect)。
  if (variant === 'advancedOnly') {
    if (advancedHidden) return null;
    return (
      <AdvancedPopover
        enabled={enabled}
        onEnabledChange={onEnabledChange}
        switchDisabled={switchDisabled}
        cantUseReason={cantUseReason ?? undefined}
        sourceBranch={sourceBranch || branches.current || 'main'}
        branches={branches.branches}
        branchesLoading={branches.loading}
        onSourceBranchChange={onSourceBranchChange}
        disabled={disabled || worktreeDisabled}
        compact={compact}
      />
    );
  }

  return (
    <div className="inline-flex items-center gap-2">
      <FolderChipBig
        folderName={folderBasename}
        selectLabel={folderSelectLabel}
        folderPickerMode={folderPickerMode}
        projectOptions={projectOptions}
        onAddRemoteProject={onAddRemoteProject}
        cwd={cwd}
        onSelect={(path, source) => {
          // "对话(不在项目中)" 入口:把 cwd 清掉,上游按 workspaceKind='dialogue'
          // 走 send 流程;不写 recent(它不是个真目录)。
          if (source === 'dialogue') {
            onSelectFolder?.(null);
            return;
          }
          if (source !== 'project') addRecentFolder(path);
          onSelectFolder?.(path);
        }}
        open={folderPickerOpen}
        onOpenChange={onFolderPickerOpenChange}
        disabled={disabled}
      />
      {!advancedHidden && (
        <AdvancedPopover
          enabled={enabled}
          onEnabledChange={onEnabledChange}
          switchDisabled={switchDisabled}
          cantUseReason={cantUseReason ?? undefined}
          sourceBranch={sourceBranch || branches.current || 'main'}
          branches={branches.branches}
          branchesLoading={branches.loading}
          onSourceBranchChange={onSourceBranchChange}
          disabled={disabled || worktreeDisabled}
          compact={compact}
        />
      )}
    </div>
  );
}

// ── 主操作：folder chip（42px 大 chip） ──────────────────────

function FolderChipBig({
  folderName,
  selectLabel,
  folderPickerMode,
  projectOptions,
  onAddRemoteProject,
  cwd,
  onSelect,
  open,
  onOpenChange,
  disabled,
}: {
  folderName: string | null;
  selectLabel: string;
  folderPickerMode: FolderPickerMode;
  projectOptions?: readonly FolderPickerOption[];
  onAddRemoteProject?: () => void;
  cwd: string | null;
  onSelect: (path: string, source: FolderPickerSelectSource) => void;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  disabled?: boolean;
}) {
  const [suppressTooltip, setSuppressTooltip] = useState(false);
  const suppressTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (suppressTimerRef.current !== null) window.clearTimeout(suppressTimerRef.current);
    };
  }, []);

  const handleSelect = useCallback(
    (path: string, source: FolderPickerSelectSource) => {
      onSelect(path, source);
      setSuppressTooltip(true);
      if (suppressTimerRef.current !== null) window.clearTimeout(suppressTimerRef.current);
      suppressTimerRef.current = window.setTimeout(() => {
        suppressTimerRef.current = null;
        setSuppressTooltip(false);
      }, 700);
    },
    [onSelect],
  );

  return (
    <FolderPickerPopover
      open={open ?? false}
      onOpenChange={onOpenChange ?? (() => {})}
      onSelect={handleSelect}
      projectOptions={folderPickerMode === 'project' ? (projectOptions ?? []) : undefined}
      onAddRemoteProject={folderPickerMode === 'project' ? onAddRemoteProject : undefined}
    >
      <Tip text={cwd ?? null} mono disabled={suppressTooltip}>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'inline-flex h-[42px] items-center gap-2.5 rounded-full',
            'border border-border bg-[var(--chat-input-bg)] px-[18px]',
            'text-[14px] font-medium text-foreground',
            'transition-colors hover:bg-sidebar-item-hover',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
          aria-label={selectLabel}
        >
          {folderPickerMode === 'project' && !cwd ? (
            <MessageCircle size={15} className="shrink-0" />
          ) : (
            <Folder size={15} className="shrink-0" />
          )}
          {/* project 模式占位 label "对话"(CJK)视觉重心比 icon 偏高,nudge 1px
              居中;选中项目后(cwd 有值)项目名多为英文/混排,保持默认基线。 */}
          <span
            className={cn(
              'truncate max-w-[240px]',
              folderPickerMode === 'project' && !cwd && 'relative top-px',
            )}
          >
            {folderName ?? selectLabel}
          </span>
          <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
        </button>
      </Tip>
    </FolderPickerPopover>
  );
}

// ── 辅助：齿轮按钮 + 高级 popover（branch + worktree） ──────

function AdvancedPopover({
  enabled,
  onEnabledChange,
  switchDisabled,
  cantUseReason,
  sourceBranch,
  branches,
  branchesLoading,
  onSourceBranchChange,
  disabled,
  compact,
}: {
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  switchDisabled?: boolean;
  cantUseReason?: string;
  sourceBranch: string;
  branches: string[];
  branchesLoading: boolean;
  onSourceBranchChange: (v: string) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);

  // worktree ON 时齿轮显示主色提示，让用户在 popover 关闭时也能感知到 worktree 已启用
  const gearActive = enabled;

  const trigger = (
    <button
      type="button"
      disabled={disabled}
      data-testid="create-agent-worktree-advanced"
      className={cn(
        'inline-flex items-center justify-center rounded-full border transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        // compact:30px 紧凑版,取 create-agent 控件 token 与新建页 mode pill 同排同调
        compact ? 'h-[30px] w-[30px]' : 'h-[42px] w-[42px] bg-[var(--chat-input-bg)]',
        gearActive
          ? 'border-primary/50 text-primary hover:bg-primary/10'
          : compact
            ? 'border-[var(--create-agent-control-border)] bg-[var(--create-agent-control-bg)] text-[var(--create-agent-control-icon)] hover:bg-[var(--create-agent-control-bg-hover)]'
            : 'border-border text-muted-foreground hover:bg-sidebar-item-hover hover:text-foreground',
      )}
      aria-label="Advanced settings (worktree)"
      aria-pressed={gearActive}
    >
      <SlidersHorizontal size={compact ? 13 : 15} className="shrink-0" />
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[240px] rounded-xl border border-border bg-popover p-2 shadow-lg"
      >
        <div className="px-2 pt-1.5 pb-1 text-[13px] font-medium text-muted-foreground">
          Advanced
        </div>

        {/* Row 1: Branch picker —— 仅 worktree ON 时可点 */}
        <BranchPopRow
          value={sourceBranch}
          branches={branches}
          loading={branchesLoading}
          onChange={onSourceBranchChange}
          disabled={!enabled || branchesLoading || branches.length === 0}
        />

        {/* Row 2: Worktree toggle */}
        <WorktreePopRow
          checked={enabled}
          onChange={onEnabledChange}
          disabled={switchDisabled}
          disabledReason={cantUseReason}
        />
      </PopoverContent>
    </Popover>
  );
}

function BranchPopRow({
  value,
  branches,
  loading,
  onChange,
  disabled,
}: {
  value: string;
  branches: string[];
  loading: boolean;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-md px-2',
            'text-[13px] text-foreground',
            'transition-colors hover:bg-sidebar-item-hover',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          <GitBranch size={14} className="shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">Branch</span>
          <span className="flex-1" />
          <span className="truncate max-w-[120px] font-medium">{loading ? 'Loading…' : value}</span>
          <ChevronDown size={11} className="shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="max-h-[260px] min-w-[180px] overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg"
      >
        {branches.map((b) => (
          <DropdownMenuItem
            key={b}
            onSelect={() => onChange(b)}
            className={cn(
              'cursor-pointer rounded-md px-3 py-1.5 text-[13px] text-foreground',
              'focus:bg-accent focus:text-accent-foreground',
              b === value && 'bg-accent/60',
            )}
          >
            {b}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorktreePopRow({
  checked,
  onChange,
  disabled,
  disabledReason,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const btn = (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-md px-2',
        'text-[13px] transition-colors hover:bg-sidebar-item-hover',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'text-primary' : 'text-muted-foreground',
      )}
      aria-pressed={checked}
      aria-label="Use worktree isolation"
    >
      <span
        className={cn(
          'inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded',
          'border-[1.5px] transition-colors',
          checked
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-muted-foreground bg-transparent',
        )}
      >
        {checked && (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            className="h-[10px] w-[10px]"
          >
            <path d="M3 8l3.5 3.5L13 5" />
          </svg>
        )}
      </span>
      <span>worktree</span>
    </button>
  );

  if (disabled && disabledReason) {
    return (
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span className="inline-flex w-full" tabIndex={0}>
            {btn}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Content side="top">{disabledReason}</Tooltip.Content>
      </Tooltip.Root>
    );
  }

  return btn;
}
