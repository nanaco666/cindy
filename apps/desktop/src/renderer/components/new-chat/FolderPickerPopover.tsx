import { Folder, FolderPlus, Globe, MessageCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

const RECENT_FOLDERS_KEY = 'cc-agent-recent-folders';
const MAX_RECENT = 5;

export interface RecentFolder {
  path: string;
  name: string;
}

export interface FolderPickerOption {
  path: string;
  name: string;
  description?: string;
}

export type FolderPickerSelectSource = 'project' | 'recent' | 'browse' | 'dialogue';

const WHEEL_LINE_HEIGHT = 16;

/**
 * Read recent folders from localStorage.
 */
export function getRecentFolders(): RecentFolder[] {
  try {
    const raw = localStorage.getItem(RECENT_FOLDERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentFolder[];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

/**
 * Add a folder to the recent list. If it already exists, move it to the front.
 */
export function addRecentFolder(folderPath: string): void {
  const name = folderPath.split(/[\\/]/).pop() ?? folderPath;
  const current = getRecentFolders();
  const filtered = current.filter((f) => f.path !== folderPath);
  const updated = [{ path: folderPath, name }, ...filtered].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(updated));
  } catch {
    // Storage full or unavailable — silently ignore
  }
}

function normalizeWheelDeltaY(e: React.WheelEvent): number {
  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) return e.deltaY * WHEEL_LINE_HEIGHT;
  if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) return e.deltaY * window.innerHeight;
  return e.deltaY;
}

function handleFolderPickerWheel(e: React.WheelEvent<HTMLElement>) {
  e.stopPropagation();

  const current = e.currentTarget;
  const target = e.target instanceof HTMLElement ? e.target : null;
  const scrollRoot = target?.closest<HTMLElement>('[data-folder-picker-scroll="true"]')
    ?? current.querySelector<HTMLElement>('[data-folder-picker-scroll="true"]');

  if (!scrollRoot || scrollRoot.scrollHeight <= scrollRoot.clientHeight) return;

  e.preventDefault();
  scrollRoot.scrollTop += normalizeWheelDeltaY(e);
}

interface FolderPickerPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (folderPath: string, source: FolderPickerSelectSource) => void;
  projectOptions?: readonly FolderPickerOption[];
  /**
   * 仅 isProjectPicker 模式下生效, 且只在传入时显示。回调激发 = 用户想从远端
   * 添加一个新的项目目录;调用方应关闭 popover 并打开 AddRemoteProjectDialog。
   * 上层的可见性 gate (至少一台 host 勾了 autoConnect) 由调用方决定是否传入,
   * 这里不做判断。
   */
  onAddRemoteProject?: () => void;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  collisionPadding?: number;
  children: React.ReactNode;
}

export function FolderPickerPopover({
  open,
  onOpenChange,
  onSelect,
  projectOptions,
  onAddRemoteProject,
  side,
  align = 'end',
  sideOffset = 4,
  collisionPadding,
  children,
}: FolderPickerPopoverProps) {
  const { t } = useTranslation();
  const isProjectPicker = projectOptions !== undefined;
  const effectiveProjectOptions = projectOptions ?? [];
  const recentFolders = open && !isProjectPicker ? getRecentFolders() : [];

  const handleSelectPath = (folderPath: string, source: FolderPickerSelectSource) => {
    onSelect(folderPath, source);
    onOpenChange(false);
  };

  const handleChooseDifferent = async () => {
    const result = await window.electronAPI.showOpenDirectoryDialog();
    if (!result.canceled && result.path) {
      onSelect(result.path, 'browse');
      onOpenChange(false);
    }
    // If canceled, popover stays open per spec
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          'z-[10010] w-[320px] rounded-[12px] p-2',
          'bg-[var(--folder-picker-bg)]',
          'border border-[var(--folder-picker-border)]',
        )}
        onWheel={handleFolderPickerWheel}
      >
        {isProjectPicker && (
          <>
            <div className="px-3 py-2">
              <span className="text-xs font-normal text-[var(--folder-label)]">
                {t('newChat.folderPicker.dialogueOrSelectProject')}
              </span>
            </div>
            <button
              type="button"
              onClick={() => handleSelectPath('', 'dialogue')}
              className={cn(
                'flex w-full items-center gap-3 rounded-[8px] px-3 py-[10px] text-left',
                'transition-colors outline-none',
                'hover:bg-[var(--folder-item-hover)]',
              )}
            >
              <MessageCircle size={20} className="shrink-0 text-[var(--folder-item-icon)]" />
              <span className="relative top-px text-sm font-medium text-[var(--folder-item-name)]">
                {t('newChat.folderPicker.dialogue')}
              </span>
            </button>
            <div className="px-3 pb-1 pt-3">
              <span className="text-xs font-normal text-[var(--folder-label)]">
                {t('newChat.folderPicker.projects')}
              </span>
            </div>
            <div
              data-folder-picker-scroll="true"
              className="pending-queue-scroll -mr-2 max-h-[224px] overflow-x-hidden overflow-y-auto overscroll-contain pr-2"
            >
              {effectiveProjectOptions.length > 0 ? (
                effectiveProjectOptions.map((project) => (
                  <button
                    key={project.path}
                    type="button"
                    onClick={() => handleSelectPath(project.path, 'project')}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-[8px] px-3 py-[10px] text-left',
                      'transition-colors outline-none',
                      'hover:bg-[var(--folder-item-hover)]',
                    )}
                  >
                    <Folder size={20} className="shrink-0 text-[var(--folder-item-icon)]" />
                    <div className="flex min-w-0 flex-1 flex-col items-start">
                      {/* w-full 缺失 → truncate 不生效;长 UUID / 长路径会撑爆容器
                          触发横向滚动条。description 那行已有 w-full 是对的,这里
                          补上。 */}
                      <span className="w-full truncate text-sm font-medium text-[var(--folder-item-name)]">
                        {project.name}
                      </span>
                      {project.description && (
                        <span className="w-full truncate text-xs text-[var(--folder-item-path)]">
                          {project.description}
                        </span>
                      )}
                    </div>
                  </button>
                ))
              ) : (
                <div className="px-3 py-[10px] text-sm text-[var(--folder-item-path)]">
                  {t('newChat.folderPicker.noProjects')}
                </div>
              )}
            </div>
            <div className="mx-2 my-1 h-px bg-[var(--folder-picker-border)]" />
          </>
        )}

        {/* Recent folders — list scrolls when more than 4 items, label and
            "Choose a different folder" button stay outside the scroll area. */}
        {!isProjectPicker && recentFolders.length > 0 && (
          <>
            <div className="px-3 py-2">
              <span className="text-xs font-normal text-[var(--folder-label)]">
                {t('newChat.folderPicker.recent')}
              </span>
            </div>
            <div
              data-folder-picker-scroll="true"
              className="pending-queue-scroll -mr-2 max-h-[224px] overflow-x-hidden overflow-y-auto overscroll-contain pr-2"
            >
              {recentFolders.map((folder) => (
                <button
                  key={folder.path}
                  type="button"
                  onClick={() => handleSelectPath(folder.path, 'recent')}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-[8px] px-3 py-[10px] text-left',
                    'transition-colors outline-none',
                    'hover:bg-[var(--folder-item-hover)]',
                  )}
                >
                  <Folder size={20} className="shrink-0 text-[var(--folder-item-icon)]" />
                  <div className="flex min-w-0 flex-1 flex-col items-start">
                    <span className="w-full truncate text-sm font-medium text-[var(--folder-item-name)]">
                      {folder.name}
                    </span>
                    <span className="w-full truncate text-xs text-[var(--folder-item-path)]">
                      {folder.path}
                    </span>
                  </div>
                </button>
              ))}
            </div>
            <div className="mx-2 my-1 h-px bg-[var(--folder-picker-border)]" />
          </>
        )}

        {/* Choose a different folder */}
        <button
          type="button"
          onClick={handleChooseDifferent}
          className={cn(
            'flex w-full items-center gap-3 rounded-[8px] px-3 py-[10px] text-left',
            'transition-colors outline-none',
            'hover:bg-[var(--folder-item-hover)]',
          )}
        >
          <FolderPlus size={20} className="shrink-0 text-[var(--folder-item-icon)]" />
          {/* CJK label 视觉重心比 icon 偏高,nudge 1px 居中。与 chip 上 "对话" 同样处理。 */}
          <span className="relative top-px text-sm font-medium text-[var(--folder-item-name)]">
            {isProjectPicker
              ? t('newChat.folderPicker.browseProjectFolder')
              : t('newChat.folderPicker.browseFolder')}
          </span>
        </button>

        {/* Phase D: 添加远程项目入口。仅 isProjectPicker 且上层传了
            onAddRemoteProject (即至少一台 host 勾了 autoConnect) 时显示,
            位置紧贴「选择其他项目文件夹」下方 — 跟用户要求一致。 */}
        {isProjectPicker && onAddRemoteProject && (
          <button
            type="button"
            onClick={() => {
              onAddRemoteProject();
              onOpenChange(false);
            }}
            className={cn(
              'flex w-full items-center gap-3 rounded-[8px] px-3 py-[10px] text-left',
              'transition-colors outline-none',
              'hover:bg-[var(--folder-item-hover)]',
            )}
          >
            <Globe size={20} className="shrink-0 text-[var(--folder-item-icon)]" />
            <span className="relative top-px text-sm font-medium text-[var(--folder-item-name)]">
              {t('newChat.projectPicker.addRemoteProject')}
            </span>
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
