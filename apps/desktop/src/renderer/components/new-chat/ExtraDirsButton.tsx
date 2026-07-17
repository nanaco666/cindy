/**
 * ExtraDirsButton —— composer 的「+」操作菜单(左置于权限选择器之前)。
 *
 * 合并了两类入口(参考 Codex 的 + 菜单):
 *   - 新建目标(`onNewGoal` 提供时显示;仅会话中,父组件按 sessionId 决定)→ 打开 NewGoalDialog。
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

import { useState } from 'react';
import { Check, ClipboardList, FolderPlus, Plus, Target, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { createLogger } from '@/lib/logger';
import { stripTrailingPathSeparators } from '../../../shared/pathText';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir';

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
  disabled?: boolean;
  /** 窄容器下把 trigger 字号/图标各压一档,默认 false。 */
  dense?: boolean;
  /** CREATE AGENT 首页按 Figma 185:2724 使用独立私有 token。 */
  visualVariant?: 'default' | 'create-agent';
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
  disabled,
  dense = false,
  visualVariant = 'default',
}: ExtraDirsButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { confirm } = useConfirmDialog();

  // 能力感知:新建目标(onNewGoal)/ 计划模式(planMode)两端通用;引用目录仅 cc
  // (Codex 忽略 extraDirs)。三样都没有才不渲染。
  const isCc = agentKind === 'cc';
  if (!onNewGoal && !planMode && !isCc) return null;

  const count = extraDirs.length;
  const atLimit = count >= MAX_EXTRA_DIRS;
  const isCreateAgentVariant = visualVariant === 'create-agent';

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
      log.debug('add: silently skipped (subdir of workingDir)', { picked: normalizedPicked, workingDir });
      return;
    }

    // 父目录 / 祖先警告 — 通过则继续。
    if (workingDir && isParentOrAncestor(normalizedPicked, workingDir)) {
      const ok = await confirm({
        title: '添加父目录?',
        description:
          `选中的目录是当前工作目录的父级或祖先。这会扩大 agent 的可见范围 —— 它能看到工作目录之外的内容。\n\n要添加吗?\n\n${normalizedPicked}`,
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Tip
          text={count === 0 ? t('extraDirs.tooltipEmpty') : t('extraDirs.tooltipCount', { count })}
          side="top"
        >
          <button
            type="button"
            disabled={disabled}
            className={cn(
              'flex items-center rounded-full transition-colors',
              isCreateAgentVariant
                ? [
                    'h-[30px] w-[30px] justify-center border border-[var(--create-agent-control-border)]',
                    'bg-[var(--create-agent-control-bg)] p-0 text-[var(--create-agent-control-icon)]',
                    'hover:bg-[var(--create-agent-control-bg-hover)] active:bg-[var(--create-agent-control-bg-pressed)]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--create-agent-focus-ring)]',
                  ]
                : [
                    'gap-1 px-1.5 py-1',
                    'bg-[var(--composer-pill-bg,#FCFCFC)] dark:bg-[var(--composer-pill-bg,#393838)] border border-[var(--border-default)] text-[var(--composer-pill-icon,#3C3F43)] dark:text-[var(--composer-pill-icon,#D9D9D9)]' /* spec 2026-07-17, token by 一哥 */,
                    'hover:bg-[var(--model-trigger-hover)]',
                  ],
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
            aria-label={t('extraDirs.menuAria')}
          >
            <Plus
              size={isCreateAgentVariant ? 11 : dense ? 15 : 16}
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
          </button>
        </Tip>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className={cn(
          'w-[360px] rounded-[12px] p-2',
          'bg-[var(--model-dropdown-bg)]',
          'border border-[var(--model-dropdown-border)]',
        )}
      >
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

        {/* 引用目录段:仅 Claude(cc)显示;Codex 忽略 extraDirs,只保留上面的入口项。 */}
        {isCc && (
          <>
            {(onNewGoal || planMode) && (
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
      </PopoverContent>
    </Popover>
  );
}
