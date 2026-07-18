/**
 * GhostsSection — Settings → 意识(意识系统 C2c)。
 *
 * 意识总览页:装入(.cindy 系统文件选择框)、已装列表、启用/停用、卸下。
 * 设计稿:docs/design_docs/settings-view.pen「Dark - Settings 意识总览」帧。
 * 2026-07-15 改版:列表行 → 双列卡片栅格(侧边栏同步取消插件二级折叠,
 * 「插件」单 cell 直达本页),单屏可见插件数量翻倍。
 *
 * 列表分三组(2026-07-15 起,内置/企业由 provisioning.json 的 tier 声明):
 * - 内置意识:随包播种的第一方意识,永远占行 —— 已装行带「内置」标,被抽离
 *   的显示灰态占位行 + 「恢复」按钮(清墓碑 + 立即对账装回);
 * - 企业意识:同为随包播种,但 tier: 'enterprise'(面向组织发放)—— 行为与
 *   内置完全一致(卸载记墓碑、可恢复),仅分组与标签不同;
 * - 外部安装:用户注入的 .cindy,抽离即从列表消失(现状不变)。
 *
 * 数据流:首帧 listSync + builtinStatusSync 同步拉(规则 7,无 loading 态),
 * ghosts:changed 订阅热更新(内置状态同轮重拉);所有写操作走 main
 * (GhostManager / builtinGhostProvisioner),本组件零业务逻辑。
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Folder, FolderOpen, Globe, Package, Plus, RotateCcw } from 'lucide-react';

import { toast } from '@/lib/toast';
import { basename, cn } from '@/lib/utils';
import { extractIpcError } from '@/utils/ipcError';
import type { InstalledGhost } from '../../../shared/ghost';
import { ghostInstallErrorKey } from '@/cindy-brain/installErrorKey';
import { confirmAndInstallGhost } from '@/cindy-brain/installFlow';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { Switch } from '@/components/ui/switch';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { recentWorkdirsStore, type RecentWorkdirEntry } from '@/lib/recentWorkdirsStore';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface GhostsSectionProps {
  /** 点击列表行 → 进入该意识的独立设置页(C2c-2;SettingsView 负责路由)。 */
  onOpenGhost: (id: string) => void;
  /** 当前 active session 的工作目录(SettingsView 的 lastWorkingDir)——
   *  范围切换器把它并进候选清单并置顶(用户"我刚才在的项目")。 */
  workingDir?: string;
}

type BuiltinStatus = ReturnType<typeof window.electronAPI.ghosts.builtinStatusSync>;

function useRecentWorkdirs(): RecentWorkdirEntry[] {
  // 同 BuiltinToolsSection:snapshot 经 useSyncExternalStore 订阅,ensure()
  // 首读懒加载;失败静默(空下拉是可接受的退化)。
  const snapshot = useSyncExternalStore(recentWorkdirsStore.subscribe, recentWorkdirsStore.get);
  useEffect(() => {
    void recentWorkdirsStore.ensure().catch(() => {});
  }, []);
  return snapshot ?? [];
}

export function GhostsSection({ onOpenGhost, workingDir }: GhostsSectionProps) {
  const { t } = useTranslation();
  const { confirm, confirmWithCheckbox } = useConfirmDialog();
  const ghosts = useInstalledGhosts();
  // 内置状态与已装清单同帧同步拉;ghosts:changed(装/卸/播种后 main 必广播)
  // 时重拉,保证「抽离 → 灰态行」「恢复 → 实体行」原子切换不闪空(规则 7)。
  const [builtinStatus, setBuiltinStatus] = useState<BuiltinStatus>(() =>
    window.electronAPI.ghosts.builtinStatusSync(),
  );
  const [restoringId, setRestoringId] = useState<string | null>(null);

  // ── 生效范围(目录级禁用,ghostWorkdirPrefs)────────────────────────
  // null = 全局视图(现状不变,开关管全局生效态);选中项目后开关变为
  // "该项目下是否生效"——关闭写目录级例外,打开清除例外回到跟随全局。
  // 禁用清单走 sendSync 与卡片同帧渲染(规则 7 无跳变),体量极小。
  const [scopeDir, setScopeDir] = useState<string | null>(null);
  const scopeDirRef = useRef<string | null>(scopeDir);
  scopeDirRef.current = scopeDir;
  const recentWorkdirs = useRecentWorkdirs();
  const readProjectDisabled = (dir: string | null): Set<string> => {
    if (!dir) return new Set();
    try {
      return new Set(window.electronAPI.ghosts.workdirPrefsSync(dir).disabled);
    } catch {
      return new Set();
    }
  };
  const [projectDisabled, setProjectDisabled] = useState<Set<string>>(() => readProjectDisabled(null));
  const handlePickScope = useCallback((dir: string | null) => {
    setScopeDir(dir);
    // 同一次 render 周期内同步取清单,切换范围不闪基态帧(规则 7)。
    setProjectDisabled(dir ? new Set(window.electronAPI.ghosts.workdirPrefsSync(dir).disabled) : new Set());
  }, []);

  useEffect(() => {
    return window.electronAPI.ghosts.onChanged(() => {
      setBuiltinStatus(window.electronAPI.ghosts.builtinStatusSync());
      // 目录级例外变更(本窗或其它窗口写入)同轮重拉,多窗口同步。
      const dir = scopeDirRef.current;
      if (dir) {
        try {
          setProjectDisabled(new Set(window.electronAPI.ghosts.workdirPrefsSync(dir).disabled));
        } catch {
          /* 保持现值 */
        }
      }
    });
  }, []);

  const builtinIdSet = new Set(builtinStatus.builtinIds);
  const enterpriseIdSet = new Set(builtinStatus.enterpriseIds);
  const builtinGhosts = ghosts.filter((g) => builtinIdSet.has(g.manifest.id) && !enterpriseIdSet.has(g.manifest.id));
  const enterpriseGhosts = ghosts.filter((g) => enterpriseIdSet.has(g.manifest.id));
  const externalGhosts = ghosts.filter((g) => !builtinIdSet.has(g.manifest.id));
  // 防御:已装的 id 不重复出现在恢复行(墓碑与已装互斥,理论不重叠)。
  const installedIds = new Set(ghosts.map((g) => g.manifest.id));
  const restorable = builtinStatus.restorable.filter((r) => !installedIds.has(r.id));
  const restorableBuiltin = restorable.filter((r) => r.tier !== 'enterprise');
  const restorableEnterprise = restorable.filter((r) => r.tier === 'enterprise');

  const handleInstall = useCallback(async () => {
    // 选文件 → inspect 验明正身 → 确认弹窗 → 装入(与拖入/双击同契约;
    // 选到已装 id 的新版包自动转更新)。
    const picked = await window.electronAPI.ghosts.pickFile().catch(() => null);
    if (!picked || 'canceled' in picked) return;
    await confirmAndInstallGhost(picked.filePath, { t, confirm, confirmWithCheckbox });
  }, [confirm, confirmWithCheckbox, t]);

  const handleToggle = useCallback(
    async (ghost: InstalledGhost, enabled: boolean) => {
      // 项目视图:开关写目录级例外(关 = 停用,开 = 清例外回到跟随全局),
      // 不碰全局生效态;全局视图维持原语义。
      const dir = scopeDirRef.current;
      if (dir) {
        try {
          const res = await window.electronAPI.ghosts.setWorkdirDisabled(dir, ghost.manifest.id, !enabled);
          setProjectDisabled(new Set(res.disabled));
          toast.success(
            enabled
              ? t('settings.ghosts.toast.projectEnabled', { name: ghost.manifest.name })
              : t('settings.ghosts.toast.projectDisabled', { name: ghost.manifest.name }),
          );
        } catch {
          toast.error(t('settings.ghosts.errors.generic'));
        }
        return;
      }
      try {
        await window.electronAPI.ghosts.setEnabled(ghost.manifest.id, enabled);
      } catch {
        toast.error(t('settings.ghosts.errors.generic'));
      }
    },
    [t],
  );

  const handleUninstall = useCallback(
    async (ghost: InstalledGhost, isBuiltin: boolean) => {
      const ok = await confirm({
        title: t('settings.ghosts.uninstallConfirm.title', { name: ghost.manifest.name }),
        // 内置意识:说明不会自动装回、可在列表中恢复(预期对齐)。
        description: t(
          isBuiltin
            ? 'settings.ghosts.uninstallConfirm.descriptionBuiltin'
            : 'settings.ghosts.uninstallConfirm.description',
        ),
        confirmText: t('settings.ghosts.uninstall'),
        cancelText: t('settings.ghosts.uninstallConfirm.cancel'),
      });
      if (!ok) return;
      try {
        await window.electronAPI.ghosts.uninstall(ghost.manifest.id);
        toast.success(t('settings.ghosts.toast.uninstalled', { name: ghost.manifest.name }));
      } catch (err) {
        toast.error(t(ghostInstallErrorKey(extractIpcError(err)?.code)));
      }
    },
    [confirm, t],
  );

  const handleRestore = useCallback(
    async (id: string, name: string) => {
      setRestoringId(id);
      try {
        await window.electronAPI.ghosts.restoreBuiltin(id);
        toast.success(t('settings.ghosts.toast.restored', { name }));
      } catch {
        toast.error(t('settings.ghosts.errors.generic'));
      } finally {
        setRestoringId(null);
      }
    },
    [t],
  );

  // 卡片栅格(2026-07-15 改版):行式列表 → 双列卡片,单屏可见数量翻倍。
  // 整卡可点进独立设置页;卡内开关/卸下自行 stopPropagation。
  // origin 决定角标(内置/企业/无);卸载文案上内置与企业同款(都是播种
  // 意识:记墓碑、可恢复)。
  const renderGhostCard = (ghost: InstalledGhost, origin: 'builtin' | 'enterprise' | 'external') => {
    const { manifest } = ghost;
    const isSeeded = origin !== 'external';
    // 项目视图的开关语义:该项目下的生效结果(全局生效 且 无目录级例外)。
    // 全局未生效的插件在项目视图只读——项目层不提供"强开",先去全局开。
    const isProjectScope = scopeDir !== null;
    const projectOff = isProjectScope && projectDisabled.has(manifest.id);
    const effectiveEnabled = isProjectScope ? ghost.enabled && !projectOff : ghost.enabled;
    const switchLocked = isProjectScope && !ghost.enabled;
    return (
      <div
        key={manifest.id}
        role="button"
        tabIndex={0}
        onClick={() => onOpenGhost(manifest.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpenGhost(manifest.id);
          }
        }}
        className="flex cursor-pointer flex-col gap-2.5 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-3.5 transition-colors hover:bg-sidebar-item-hover"
      >
        {/* 首行:图标 + 名称/标签,开关右上角 */}
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-[var(--border-default)] bg-[var(--surface-chip)]">
            {ghost.iconDataUrl ? (
              <img
                src={ghost.iconDataUrl}
                alt=""
                draggable={false}
                className={`h-full w-full object-cover ${effectiveEnabled ? '' : 'opacity-50'}`}
              />
            ) : (
              <Package
                size={18}
                className={effectiveEnabled ? 'text-[var(--text-secondary)]' : 'text-[var(--text-tertiary)]'}
              />
            )}
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <p
              className={`truncate text-14 font-medium ${effectiveEnabled ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}
            >
              {manifest.name}
            </p>
            {isSeeded ? (
              <span className="shrink-0 rounded-md border border-[var(--border-default)] px-1.5 py-0.5 text-11 text-[var(--text-tertiary)]">
                {t(origin === 'enterprise' ? 'settings.ghosts.enterpriseTag' : 'settings.ghosts.builtinTag')}
              </span>
            ) : null}
            {/* 停用标签仅停用时渲染:卡片高度由 grid 行拉齐,无跳变问题。
                项目视图里全局未生效沿用「未生效」,目录级例外标「本项目未生效」。 */}
            {!ghost.enabled ? (
              <span className="shrink-0 rounded-md border border-[var(--border-default)] px-1.5 py-0.5 text-11 text-[var(--text-tertiary)]">
                {t('settings.ghosts.disabledTag')}
              </span>
            ) : projectOff ? (
              <span className="shrink-0 rounded-md border border-[var(--border-default)] px-1.5 py-0.5 text-11 text-[var(--text-tertiary)]">
                {t('settings.ghosts.projectDisabledTag')}
              </span>
            ) : null}
          </div>
          <div
            className="shrink-0"
            onClick={(e) => e.stopPropagation()}
            title={switchLocked ? t('settings.ghosts.projectSwitchLockedTip') : undefined}
          >
            <Switch
              checked={effectiveEnabled}
              disabled={switchLocked}
              onCheckedChange={(next) => void handleToggle(ghost, next)}
              aria-label={t('settings.ghosts.enableAria', { name: manifest.name })}
            />
          </div>
        </div>
        {/* 自我介绍(身份卡 description):两行截断,先看懂"它是干嘛的"。
            恒占两行高度,让同行卡片的底部操作行对齐。 */}
        <p className="line-clamp-2 min-h-[2.25rem] text-12 leading-[1.5] text-[var(--text-secondary)]">
          {manifest.description ?? ''}
        </p>
        {/* 底行:元数据 + 卸下,mt-auto 兜底对齐卡底 */}
        <div className="mt-auto flex items-center justify-between gap-2">
          <p className="truncate text-12 text-[var(--text-tertiary)]">
            {[manifest.author, manifest.id, `v${manifest.version}`].filter(Boolean).join(' · ')}
          </p>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void handleUninstall(ghost, isSeeded);
            }}
            className="shrink-0 rounded-full border border-[var(--border-default)] px-3 py-1 text-12 text-[var(--text-secondary)] transition-colors hover:bg-sidebar-item-hover"
          >
            {t('settings.ghosts.uninstall')}
          </button>
        </div>
      </div>
    );
  };

  /** 已抽离内置意识的灰态占位卡:不可点进详情,仅提供「恢复」。 */
  const renderRestorableCard = (item: BuiltinStatus['restorable'][number]) => (
    <div
      key={item.id}
      className="flex flex-col gap-2.5 rounded-xl border border-dashed border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-3.5"
    >
      <div className="flex items-center gap-2.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-[var(--border-default)] bg-[var(--surface-chip)]">
          {item.iconDataUrl ? (
            <img src={item.iconDataUrl} alt="" draggable={false} className="h-full w-full object-cover opacity-40" />
          ) : (
            <Package size={18} className="text-[var(--text-tertiary)]" />
          )}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <p className="truncate text-14 font-medium text-[var(--text-tertiary)]">{item.name}</p>
          <span className="shrink-0 rounded-md border border-[var(--border-default)] px-1.5 py-0.5 text-11 text-[var(--text-tertiary)]">
            {t(item.tier === 'enterprise' ? 'settings.ghosts.enterpriseTag' : 'settings.ghosts.builtinTag')}
          </span>
          <span className="shrink-0 rounded-md border border-[var(--border-default)] px-1.5 py-0.5 text-11 text-[var(--text-tertiary)]">
            {t('settings.ghosts.removedTag')}
          </span>
        </div>
      </div>
      <p className="line-clamp-2 min-h-[2.25rem] text-12 leading-[1.5] text-[var(--text-tertiary)]">
        {item.description ?? ''}
      </p>
      <div className="mt-auto flex items-center justify-end">
        <button
          type="button"
          disabled={restoringId === item.id}
          onClick={() => void handleRestore(item.id, item.name)}
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border-default)] px-3 py-1 text-12 text-[var(--text-secondary)] transition-colors hover:bg-sidebar-item-hover disabled:opacity-50"
        >
          <RotateCcw size={13} />
          {t('settings.ghosts.restore')}
        </button>
      </div>
    </div>
  );

  const hasBuiltinRows = builtinGhosts.length > 0 || restorableBuiltin.length > 0;
  const hasEnterpriseRows = enterpriseGhosts.length > 0 || restorableEnterprise.length > 0;
  const isEmpty = ghosts.length === 0 && restorable.length === 0;

  return (
    <div className="flex flex-col gap-[14px]">
      {/* 标题行:左标题+描述,右「范围切换器 + 装入意识…」 */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
            {t('settings.ghosts.title')}
          </h2>
          <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
            {t('settings.ghosts.description')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ScopePicker
            scopeDir={scopeDir}
            activeSessionWorkingDir={workingDir}
            recentWorkdirs={recentWorkdirs}
            onPick={handlePickScope}
          />
          <button
            type="button"
            onClick={handleInstall}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-[var(--accent-cta-bg)] px-4 text-13 font-medium text-[var(--accent-pure-cta-fg)] transition-opacity hover:opacity-90"
          >
            <Plus size={15} />
            {t('settings.ghosts.install')}
          </button>
        </div>
      </div>

      {/* 项目模式横幅:范围切到项目后必须"一眼可见"当前不在全局——
          灰字提示没人注意(实测),独立横幅 + 返回按钮把模式状态钉在列表上方。 */}
      {scopeDir ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-chip)] px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <Folder size={16} className="shrink-0 text-[var(--text-secondary)]" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="truncate text-13 font-medium text-[var(--text-primary)]">
                {t('settings.ghosts.projectBanner.title', { name: basename(scopeDir) })}
              </p>
              <p className="truncate text-12 text-[var(--text-tertiary)]">
                {scopeDir} · {t('settings.ghosts.projectBanner.desc')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => handlePickScope(null)}
            className="shrink-0 rounded-full border border-[var(--border-default)] px-3 py-1 text-12 text-[var(--text-secondary)] transition-colors hover:bg-sidebar-item-hover"
          >
            {t('settings.ghosts.projectBanner.backToGlobal')}
          </button>
        </div>
      ) : null}

      {isEmpty ? (
        // 空状态:不留白页(规则 7),给一句引导。
        <div className="flex flex-col items-center gap-2 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-6 py-10">
          <Package size={22} className="text-[var(--text-tertiary)]" />
          <p className="text-13 font-medium text-[var(--text-secondary)]">{t('settings.ghosts.empty')}</p>
          <p className="text-12 text-[var(--text-tertiary)]">{t('settings.ghosts.emptyHint')}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-[14px]">
          {hasBuiltinRows ? (
            <>
              <p className="text-12 text-[var(--settings-section-sublabel)]">
                {t('settings.ghosts.builtinGroup')}
              </p>
              {/* 双列卡片栅格;窄窗(<lg)退回单列,同行卡片高度由 grid 拉齐 */}
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {builtinGhosts.map((ghost) => renderGhostCard(ghost, 'builtin'))}
                {restorableBuiltin.map(renderRestorableCard)}
              </div>
            </>
          ) : null}
          {hasEnterpriseRows ? (
            <>
              <p className="text-12 text-[var(--settings-section-sublabel)]">
                {t('settings.ghosts.enterpriseGroup')}
              </p>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {enterpriseGhosts.map((ghost) => renderGhostCard(ghost, 'enterprise'))}
                {restorableEnterprise.map(renderRestorableCard)}
              </div>
            </>
          ) : null}
          {externalGhosts.length > 0 ? (
            <>
              <p className="text-12 text-[var(--settings-section-sublabel)]">
                {t('settings.ghosts.externalGroup', { count: externalGhosts.length })}
              </p>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {externalGhosts.map((ghost) => renderGhostCard(ghost, 'external'))}
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * 生效范围切换器 —— 「全局(默认)」 + 最近项目清单(交互同
 * BuiltinToolsSection 的 ProjectPicker,首项多一条全局入口)。
 * 选中项目后,下方卡片的开关变为"该项目下是否生效"(目录级例外)。
 */
function ScopePicker({
  scopeDir,
  activeSessionWorkingDir,
  recentWorkdirs,
  onPick,
}: {
  scopeDir: string | null;
  /** 当前 active session 的目录——并入候选并置顶(不依赖 recent 缓存时序)。 */
  activeSessionWorkingDir: string | undefined;
  recentWorkdirs: RecentWorkdirEntry[];
  onPick: (dir: string | null) => void;
}) {
  const { t } = useTranslation();

  const candidates = useMemo<string[]>(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (p: string | undefined | null) => {
      if (!p || seen.has(p)) return;
      seen.add(p);
      out.push(p);
    };
    push(scopeDir);
    push(activeSessionWorkingDir);
    for (const r of recentWorkdirs) push(r.path);
    return out;
  }, [scopeDir, activeSessionWorkingDir, recentWorkdirs]);

  const triggerLabel = scopeDir ? basename(scopeDir) : t('settings.ghosts.scopePicker.global');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* 尺寸与右侧「安装插件…」主按钮完全同款(h-8 / px-4 / text-13),
            只是配色用输入底色区分主次。 */}
        <button
          type="button"
          aria-label={t('settings.ghosts.scopePicker.ariaLabel')}
          title={scopeDir ?? undefined}
          className={cn(
            'flex h-8 max-w-[220px] shrink-0 items-center gap-1.5 rounded-full px-4',
            'bg-[var(--settings-input-bg)] text-13 font-medium text-[var(--settings-section-title)]',
            'hover:bg-[var(--surface-chip)]',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            'transition-colors',
          )}
        >
          {scopeDir ? <Folder size={14} className="shrink-0" /> : <Globe size={14} className="shrink-0" />}
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown size={13} className="shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      {/* 结构:「全局」钉顶 + 最近项目滚动区(封顶高度)+「选择其它目录…」
          钉底——清单再长,首尾两个入口永远可见、可一步点到。 */}
      <DropdownMenuContent align="end" className="w-max min-w-0 max-w-[calc(100vw-32px)]">
        <DropdownMenuItem
          onClick={() => onPick(null)}
          className="grid w-full cursor-pointer grid-cols-[14px_max-content] items-center gap-x-2.5 pr-4"
        >
          <Check size={14} className={cn('shrink-0', scopeDir === null ? 'opacity-100' : 'opacity-0')} />
          <div className="flex items-center gap-1.5">
            <Globe size={13} className="shrink-0 text-[var(--settings-section-desc)]" />
            <span className="whitespace-nowrap text-13 font-medium">
              {t('settings.ghosts.scopePicker.global')}
            </span>
          </div>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="max-h-[min(320px,45vh)] overflow-y-auto">
          {candidates.map((dir) => {
            const isCurrent = dir === scopeDir;
            return (
              <DropdownMenuItem
                key={dir}
                onClick={() => onPick(dir)}
                className="grid w-full cursor-pointer grid-cols-[14px_max-content] items-center gap-x-2.5 pr-4"
              >
                <Check size={14} className={cn('shrink-0', isCurrent ? 'opacity-100' : 'opacity-0')} />
                <div className="flex flex-col gap-0.5">
                  <span className="whitespace-nowrap text-13 font-medium">{basename(dir)}</span>
                  <span className="whitespace-nowrap text-11 text-[var(--settings-section-desc)]">{dir}</span>
                </div>
              </DropdownMenuItem>
            );
          })}
        </div>
        <DropdownMenuSeparator />
        {/* 浏览任意目录:还没开过会话的目录也能提前配置(系统目录选择框)。 */}
        <DropdownMenuItem
          onClick={() => {
            void window.electronAPI.showOpenDirectoryDialog().then((r) => {
              if (!r.canceled && r.path) onPick(r.path);
            });
          }}
          className="grid w-full cursor-pointer grid-cols-[14px_max-content] items-center gap-x-2.5 pr-4"
        >
          <span aria-hidden className="w-[14px]" />
          <div className="flex items-center gap-1.5">
            <FolderOpen size={13} className="shrink-0 text-[var(--settings-section-desc)]" />
            <span className="whitespace-nowrap text-13 font-medium">
              {t('settings.ghosts.scopePicker.browse')}
            </span>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
