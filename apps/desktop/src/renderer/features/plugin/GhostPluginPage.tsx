/**
 * Plugin catalog and detail coordinator backed by the latest Ghost host APIs.
 *
 * Inputs: installed/restorable Ghost snapshots and user actions.
 * Outputs: the Plugin list/detail UI plus install, restore, toggle, and command-launch flows.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown, Plus, Sparkles, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Tip } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import {
  getDraft as getComposerDraft,
  plainTextToTiptapDoc,
  saveDraft as saveComposerDraft,
} from '@/lib/composerDraftStore';
import { patchDraft } from '@/state/newMakerDraft';
import { ghostInstallErrorKey } from '@/cindy-brain/installErrorKey';
import { confirmAndInstallGhost, pickAndUpdateGhost } from '@/cindy-brain/installFlow';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { getLastWorkingDir, subscribeToLastWorkingDir } from '@/state/lastWorkingDir';
import { findSplitChildByPanelKind } from '../../../shared/layoutTree';
import { ghostPanelKind, type GhostSetupStatus } from '../../../shared/ghost';
import {
  toGhostPluginDetail,
  toGhostPluginListItem,
  toRestorableGhostPluginDetail,
  toRestorableGhostPluginListItem,
  countGhostPluginOrigins,
  filterGhostPluginItems,
  sortGhostPluginItemsByRecentUse,
  type GhostPluginListItem,
  type GhostPluginOrigin,
} from './lib/ghostPluginViewModel';
import { formatSetupGateDescription } from './lib/ghostSetupGateModel';
import { PluginManagementLayout, PluginManagementPage } from './PluginManagementLayout';
import { GhostPluginDetailView } from './GhostPluginDetailView';
import { GhostPluginIcon } from './GhostPluginIcon';
import { PluginScopePicker, usePluginRecentWorkdirs } from './PluginScopePicker';
import './plugin-motion.css';

function originFor(
  id: string,
  builtinIds: ReadonlySet<string>,
  enterpriseIds: ReadonlySet<string>,
): GhostPluginOrigin {
  if (enterpriseIds.has(id)) return 'enterprise';
  return builtinIds.has(id) ? 'builtin' : 'external';
}

type GhostOriginFilter = 'all' | GhostPluginOrigin;
export type GhostPluginCardItem = GhostPluginListItem & { installed: boolean };

const ORIGIN_FILTERS: readonly GhostOriginFilter[] = ['all', 'builtin', 'enterprise', 'external'];
const MAX_VISIBLE_INSTALLED_GHOSTS = 5;

/**
 * Ghost-backed Plugin page.
 *
 * This is the first bridge from the existing Plugin product surface to the
 * real Ghost runtime. The page deliberately keeps the previous list/detail
 * interaction shape, while every displayed field comes from InstalledGhost.
 */
export function GhostPluginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { confirm, confirmWithCheckbox } = useConfirmDialog();
  const ghosts = useInstalledGhosts();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [originFilter, setOriginFilter] = useState<GhostOriginFilter>('all');
  const [builtinStatus, setBuiltinStatus] = useState(() =>
    window.electronAPI.ghosts.builtinStatusSync(),
  );
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [installedExpanded, setInstalledExpanded] = useState(false);
  const activeSessionWorkingDir = useSyncExternalStore(
    subscribeToLastWorkingDir,
    getLastWorkingDir,
    getLastWorkingDir,
  );
  const recentWorkdirs = usePluginRecentWorkdirs();
  const [scopeDir, setScopeDir] = useState<string | null>(null);
  const scopeDirRef = useRef<string | null>(scopeDir);
  scopeDirRef.current = scopeDir;
  const [projectDisabled, setProjectDisabled] = useState<Set<string>>(() => new Set());
  const handlePickScope = useCallback((dir: string | null) => {
    setScopeDir(dir);
    if (!dir) {
      setProjectDisabled(new Set());
      return;
    }
    try {
      setProjectDisabled(new Set(window.electronAPI.ghosts.workdirPrefsSync(dir).disabled));
    } catch {
      setProjectDisabled(new Set());
    }
  }, []);
  const effectiveEnabled = useCallback(
    (id: string, globallyEnabled: boolean) =>
      scopeDir === null ? globallyEnabled : globallyEnabled && !projectDisabled.has(id),
    [projectDisabled, scopeDir],
  );
  const [recentGhostIds, setRecentGhostIds] = useState(
    () => window.electronAPI.ghosts.recentUsageSync().ids,
  );
  useEffect(
    () =>
      window.electronAPI.ghosts.onChanged(() => {
        setBuiltinStatus(window.electronAPI.ghosts.builtinStatusSync());
        const dir = scopeDirRef.current;
        if (dir) {
          try {
            setProjectDisabled(new Set(window.electronAPI.ghosts.workdirPrefsSync(dir).disabled));
          } catch {
            // Keep the current project snapshot if another window races the read.
          }
        }
      }),
    [],
  );
  useEffect(
    () =>
      window.electronAPI.ghosts.onRecentUsageChanged(({ ids }) => {
        setRecentGhostIds(ids);
      }),
    [],
  );
  // /plugins?ghost=<id> 深链:直接打开该插件详情(配置就绪弹窗等入口复用;
  // 读后即清参数,避免从详情返回列表后又被同一参数拉回详情)。
  useEffect(() => {
    const target = searchParams.get('ghost');
    if (!target) return;
    setSelectedId(target);
    const next = new URLSearchParams(searchParams);
    next.delete('ghost');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const builtinIds = useMemo(() => new Set(builtinStatus.builtinIds), [builtinStatus.builtinIds]);
  const enterpriseIds = useMemo(
    () => new Set(builtinStatus.enterpriseIds),
    [builtinStatus.enterpriseIds],
  );

  const installedItems = useMemo(
    () =>
      ghosts
        // cindy-mivo was renamed to xd-mivo. Older user data can briefly
        // contain both ids while the main-process reconciliation catches up;
        // keep the canonical entry from rendering twice.
        .filter(
          (ghost) =>
            ghost.manifest.id !== 'cindy-mivo' ||
            !ghosts.some((candidate) => candidate.manifest.id === 'xd-mivo'),
        )
        .map((ghost) => {
          const item = toGhostPluginListItem(
            ghost,
            originFor(ghost.manifest.id, builtinIds, enterpriseIds),
          );
          return { ...item, installed: true } satisfies GhostPluginCardItem;
        }),
    [builtinIds, enterpriseIds, ghosts],
  );
  const installedShortcutItems = useMemo(
    () => sortGhostPluginItemsByRecentUse(installedItems, recentGhostIds),
    [installedItems, recentGhostIds],
  );
  const installedIds = useMemo(
    () => new Set(installedItems.map((item) => item.id)),
    [installedItems],
  );
  const restorableItems = useMemo(
    () =>
      builtinStatus.restorable
        .filter((item) => !installedIds.has(item.id))
        .map(
          (item) =>
            ({
              ...toRestorableGhostPluginListItem(item),
              installed: false,
            }) satisfies GhostPluginCardItem,
        ),
    [builtinStatus.restorable, installedIds],
  );
  const allItems = useMemo(
    () => [...installedItems, ...restorableItems],
    [installedItems, restorableItems],
  );
  const searchedItems = useMemo(() => filterGhostPluginItems(allItems, query), [allItems, query]);
  const items = useMemo(
    () => filterGhostPluginItems(searchedItems, '', originFilter),
    [originFilter, searchedItems],
  );
  const originCounts = useMemo(() => countGhostPluginOrigins(searchedItems), [searchedItems]);
  const selectedGhost = selectedId
    ? (ghosts.find((ghost) => ghost.manifest.id === selectedId) ?? null)
    : null;
  const selectedRestorable = selectedId
    ? (builtinStatus.restorable.find((ghost) => ghost.id === selectedId) ?? null)
    : null;
  const selectedDetail = selectedGhost
    ? toGhostPluginDetail(
        selectedGhost,
        originFor(selectedGhost.manifest.id, builtinIds, enterpriseIds),
      )
    : selectedRestorable
      ? toRestorableGhostPluginDetail(selectedRestorable)
      : null;

  const panelStatus = useMemo(() => {
    if (!selectedDetail || selectedDetail.panelMinWidth === null) return null;
    try {
      const kind = ghostPanelKind(selectedDetail.id);
      const docked =
        findSplitChildByPanelKind(window.electronAPI.layout.getStateSync().layout, kind) !== null;
      return docked
        ? t('settings.ghosts.detail.panelDocked', {
            min: selectedDetail.panelMinWidth,
          })
        : t('settings.ghosts.detail.panelNotDocked');
    } catch {
      return t('settings.ghosts.detail.panelNotDocked');
    }
  }, [selectedDetail, t]);

  const handleToggle = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        const dir = scopeDirRef.current;
        if (dir) {
          const result = await window.electronAPI.ghosts.setWorkdirDisabled(dir, id, !enabled);
          setProjectDisabled(new Set(result.disabled));
          toast.success(
            t(
              enabled
                ? 'settings.ghosts.toast.projectEnabled'
                : 'settings.ghosts.toast.projectDisabled',
              {
                name: ghosts.find((ghost) => ghost.manifest.id === id)?.manifest.name ?? id,
              },
            ),
          );
        } else {
          await window.electronAPI.ghosts.setEnabled(id, enabled);
        }
      } catch (error) {
        toast.error(t(ghostInstallErrorKey(extractIpcError(error)?.code)));
      }
    },
    [ghosts, t],
  );

  const handleUpdate = useCallback(async () => {
    if (!selectedDetail) return;
    await pickAndUpdateGhost(selectedDetail.id, { t, confirm, confirmWithCheckbox });
  }, [confirm, confirmWithCheckbox, selectedDetail, t]);

  const handleInstall = useCallback(async () => {
    const picked = await window.electronAPI.ghosts.pickFile().catch(() => null);
    if (!picked || 'canceled' in picked) return;
    await confirmAndInstallGhost(picked.filePath, { t, confirm, confirmWithCheckbox });
  }, [confirm, confirmWithCheckbox, t]);

  const handleCreateWithCindy = useCallback(() => {
    saveComposerDraft(NEW_MAKER_DRAFT_KEY, {
      text: plainTextToTiptapDoc(t('settings.ghosts.page.createPrompt')),
      attachments: [],
      focusAtEnd: true,
    });
    patchDraft({
      workingDir: null,
      remoteHostId: null,
      deviceLinkDeviceId: null,
      deviceLinkDeviceName: null,
    });
    navigate('/cc-agent/new');
  }, [navigate, t]);

  // 打开插件详情并滚到「配置」区(就绪弹窗的「去配置」动作)。详情视图
  // 可能尚未挂载,滚动排到渲染之后的下一帧;减弱动效时改即时定位。
  const openGhostConfiguration = useCallback((id: string) => {
    setSelectedId(id);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document
          .getElementById('ghost-configuration-title')
          ?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      });
    });
  }, []);

  const handleUseGhost = useCallback(
    async (id: string) => {
      const ghost = ghosts.find((candidate) => candidate.manifest.id === id);
      if (!ghost?.manifest.command) return;
      // 使用前置门:点击时现查配置就绪度(main 侧确定性判定),未就绪先
      // 弹窗引导去配置。查询失败不拦——运行期 networkSlot 仍会兜底报错,
      // 这里拦不住只是少了一次前置提醒,不能因此把能用的插件挡在门外。
      let setupStatus: GhostSetupStatus | null = null;
      try {
        setupStatus = await window.electronAPI.ghosts.setupStatus(id);
      } catch {
        setupStatus = null;
      }
      if (setupStatus && !setupStatus.ready) {
        const goConfigure = await confirm({
          title: t('settings.ghosts.setupGate.title', { name: ghost.manifest.name }),
          description: formatSetupGateDescription(setupStatus, t),
          confirmText: t('settings.ghosts.setupGate.configure'),
          cancelText: t('settings.ghosts.setupGate.cancel'),
          // 主操作「去配置」非破坏性,默认焦点落主按钮(弹窗契约的适用场景)。
          autoFocusConfirm: true,
        });
        if (goConfigure) openGhostConfiguration(id);
        return;
      }
      const existing = getComposerDraft(NEW_MAKER_DRAFT_KEY);
      saveComposerDraft(NEW_MAKER_DRAFT_KEY, {
        text: existing?.text ?? null,
        attachments: existing?.attachments ?? [],
        quotes: existing?.quotes ?? [],
        browserComments: existing?.browserComments ?? [],
        pendingGhostId: ghost.manifest.id,
      });
      patchDraft({
        workingDir: null,
        remoteHostId: null,
        deviceLinkDeviceId: null,
        deviceLinkDeviceName: null,
      });
      navigate('/cc-agent/new');
    },
    [confirm, ghosts, navigate, openGhostConfiguration, t],
  );

  const handleUse = useCallback(() => {
    if (selectedGhost) void handleUseGhost(selectedGhost.manifest.id);
  }, [handleUseGhost, selectedGhost]);

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

  const handleUninstall = useCallback(async () => {
    if (!selectedDetail) return;
    const ok = await confirm({
      title: t('settings.ghosts.uninstallConfirm.title', { name: selectedDetail.name }),
      description: t(
        selectedDetail.origin === 'external'
          ? 'settings.ghosts.uninstallConfirm.description'
          : 'settings.ghosts.uninstallConfirm.descriptionBuiltin',
      ),
      confirmText: t('settings.ghosts.uninstall'),
      cancelText: t('settings.ghosts.uninstallConfirm.cancel'),
    });
    if (!ok) return;
    try {
      await window.electronAPI.ghosts.uninstall(selectedDetail.id);
      toast.success(t('settings.ghosts.toast.uninstalled', { name: selectedDetail.name }));
    } catch (error) {
      toast.error(t(ghostInstallErrorKey(extractIpcError(error)?.code)));
    }
  }, [confirm, selectedDetail, t]);

  if (selectedDetail) {
    return (
      <GhostPluginDetailView
        ghost={selectedGhost}
        detail={selectedDetail}
        panelStatus={panelStatus}
        enabledOverride={
          selectedGhost
            ? effectiveEnabled(selectedGhost.manifest.id, selectedGhost.enabled)
            : undefined
        }
        onBack={() => setSelectedId(null)}
        onToggle={(enabled) => void handleToggle(selectedDetail.id, enabled)}
        onUse={handleUse}
        onUpdate={() => void handleUpdate()}
        onUninstall={() => void handleUninstall()}
        onInstall={() => void handleRestore(selectedDetail.id, selectedDetail.name)}
        installing={restoringId === selectedDetail.id}
        toggleDisabled={scopeDir !== null && selectedGhost !== null && !selectedGhost.enabled}
      />
    );
  }

  return (
    <PluginManagementLayout
      activeTab="plugins"
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder={t('settings.ghosts.page.search')}
      clearSearchLabel={t('settings.ghosts.page.clearSearch')}
      headerActions={
        <GhostPluginActions
          onInstall={() => void handleInstall()}
          onCreateWithCindy={handleCreateWithCindy}
        />
      }
    >
      <main className="min-h-0 w-full flex-1 overflow-y-auto bg-[var(--surface)] [scrollbar-gutter:stable_both-edges]">
        <PluginManagementPage>
          <header className="plugin-motion-page-header pb-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-28 font-medium leading-tight text-[var(--text-primary)]">
                  {t('settings.ghosts.title')}
                </h1>
                <PluginScopePicker
                  scopeDir={scopeDir}
                  activeSessionWorkingDir={activeSessionWorkingDir ?? undefined}
                  recentWorkdirs={recentWorkdirs}
                  onPick={handlePickScope}
                />
              </div>
              <p className="mt-2 max-w-2xl text-14 leading-6 text-[var(--text-secondary)]">
                {t('settings.ghosts.description')}
              </p>
            </div>
          </header>

          {scopeDir ? (
            <div className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-chip)] px-4 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="truncate text-13 font-medium text-[var(--text-primary)]">
                  {scopeDir}
                </span>
                <span className="truncate text-12 text-[var(--text-tertiary)]">
                  {t('settings.ghosts.projectBanner.desc')}
                </span>
              </div>
              <button
                type="button"
                onClick={() => handlePickScope(null)}
                className="shrink-0 rounded-full border border-[var(--border-default)] px-3 py-1 text-12 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover-soft)]"
              >
                {t('settings.ghosts.projectBanner.backToGlobal')}
              </button>
            </div>
          ) : null}

          {installedShortcutItems.length > 0 ? (
            <section className="plugin-motion-page-section mt-5 border-b-[0.5px] border-[var(--border-default)] pb-5">
              <div className="mb-1 flex items-baseline gap-2">
                <h2 className="text-13 font-medium text-[var(--text-secondary)]">
                  {t('settings.ghosts.page.installedTitle')}
                </h2>
                <span className="text-12 tabular-nums text-[var(--text-tertiary)]">
                  {installedShortcutItems.length}
                </span>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-1">
                {installedShortcutItems
                  .slice(0, MAX_VISIBLE_INSTALLED_GHOSTS)
                  .map((item) => renderInstalledGhost(item, setSelectedId))}
                {installedShortcutItems.length > MAX_VISIBLE_INSTALLED_GHOSTS ? (
                  <button
                    type="button"
                    onClick={() => setInstalledExpanded((expanded) => !expanded)}
                    className={cn(
                      'group flex w-16 shrink-0 justify-center rounded-[12px] px-2 py-2',
                      'transition-transform duration-150 ease-out hover:-translate-y-px active:translate-y-0 active:scale-[0.98]',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                      'motion-reduce:transform-none motion-reduce:transition-none',
                    )}
                    aria-expanded={installedExpanded}
                    aria-label={t(
                      installedExpanded
                        ? 'settings.ghosts.page.installedCollapse'
                        : 'settings.ghosts.page.installedExpand',
                      { count: installedShortcutItems.length - MAX_VISIBLE_INSTALLED_GHOSTS },
                    )}
                  >
                    <span className="grid size-12 grid-cols-2 grid-rows-2 place-content-center gap-1 rounded-[22%] border-[0.5px] border-[color-mix(in_srgb,var(--border-default)_62%,transparent)] bg-[color-mix(in_srgb,var(--surface-chip)_58%,transparent)] p-2 shadow-[var(--plugin-icon-shadow)] transition-colors duration-150 group-hover:bg-[color-mix(in_srgb,var(--surface-chip)_78%,transparent)]">
                      {installedShortcutItems
                        .slice(MAX_VISIBLE_INSTALLED_GHOSTS, MAX_VISIBLE_INSTALLED_GHOSTS + 3)
                        .map((item) => (
                          <span
                            key={item.id}
                            className="flex size-3.5 items-center justify-center overflow-hidden rounded-[5px] bg-[var(--surface-elevated)]"
                          >
                            <GhostPluginIcon
                              iconDataUrl={item.iconDataUrl}
                              iconId={item.id}
                              iconName={item.name}
                              size="mini"
                            />
                          </span>
                        ))}
                      <span className="col-start-2 row-start-2 flex size-3.5 items-center justify-center rounded-[5px] bg-[var(--surface-elevated)] text-[9px] font-medium tabular-nums text-[var(--text-secondary)]">
                        +{installedShortcutItems.length - MAX_VISIBLE_INSTALLED_GHOSTS}
                      </span>
                    </span>
                  </button>
                ) : null}
              </div>
              {installedExpanded && installedShortcutItems.length > MAX_VISIBLE_INSTALLED_GHOSTS ? (
                <div className="plugin-motion-stagger mt-2 flex flex-wrap items-center gap-1">
                  {installedShortcutItems
                    .slice(MAX_VISIBLE_INSTALLED_GHOSTS)
                    .map((item) => renderInstalledGhost(item, setSelectedId))}
                </div>
              ) : null}
            </section>
          ) : null}

          <section className="plugin-motion-page-section mt-6 min-w-0">
            <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div className="flex items-baseline gap-2">
                <h2 className="text-20 font-medium text-[var(--text-primary)]">
                  {t('settings.ghosts.page.allTitle')}
                </h2>
                <span className="text-13 tabular-nums text-[var(--text-tertiary)]">
                  {items.length}
                </span>
              </div>

              <div
                className="flex max-w-full items-center gap-1 overflow-x-auto"
                role="tablist"
                aria-label={t('settings.ghosts.page.filtersAria')}
                style={WINDOW_NO_DRAG_STYLE}
              >
                {ORIGIN_FILTERS.map((filter) => {
                  const selected = originFilter === filter;
                  const count = filter === 'all' ? searchedItems.length : originCounts[filter];
                  return (
                    <button
                      key={filter}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      onClick={() => setOriginFilter(filter)}
                      className={cn(
                        'shrink-0 select-none rounded-full px-3.5 py-2 text-12 transition-colors duration-150',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                        selected
                          ? 'bg-[var(--surface-chip)] text-[var(--text-primary)]'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)]',
                      )}
                    >
                      {filter === 'all'
                        ? t('settings.ghosts.page.filterAll')
                        : t(`settings.ghosts.page.origin.${filter}`)}
                      <span className="ml-1.5 tabular-nums text-[var(--text-tertiary)]">
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {items.length > 0 ? (
              <div className="plugin-motion-stagger grid grid-cols-1 gap-3 sm:grid-cols-2">
                {items.map((item) => (
                  <GhostPluginCard
                    key={item.id}
                    item={item}
                    onSelect={() => setSelectedId(item.id)}
                    onAction={() => {
                      if (item.installed) void handleUseGhost(item.id);
                      else void handleRestore(item.id, item.name);
                    }}
                    effectiveEnabled={
                      item.installed ? effectiveEnabled(item.id, item.enabled) : undefined
                    }
                    toggleDisabled={scopeDir !== null && !item.enabled}
                    onToggle={
                      item.installed ? (enabled) => void handleToggle(item.id, enabled) : undefined
                    }
                    restoring={restoringId === item.id}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-xl border-[0.5px] border-[var(--border-default)] px-5 py-10 text-center">
                <p className="text-13 text-[var(--text-secondary)]">
                  {allItems.length === 0
                    ? t('settings.ghosts.empty')
                    : t('settings.ghosts.page.emptyFiltered')}
                </p>
                {allItems.length === 0 ? (
                  <p className="mt-1.5 text-12 text-[var(--text-tertiary)]">
                    {t('settings.ghosts.emptyHint')}
                  </p>
                ) : null}
              </div>
            )}
          </section>
        </PluginManagementPage>
      </main>
    </PluginManagementLayout>
  );
}

/** Plugin-specific creation and import actions rendered after the shared search. */
function GhostPluginActions({
  onInstall,
  onCreateWithCindy,
}: {
  onInstall: () => void;
  onCreateWithCindy: () => void;
}) {
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'group inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-[var(--border-default)]',
            'bg-[var(--surface-elevated)] px-3.5 text-12 font-medium text-[var(--text-primary)] shadow-[var(--plugin-card-shadow)]',
            'transition-[background-color,border-color,transform] duration-150 ease-out',
            'hover:border-[var(--text-tertiary)] hover:bg-[var(--surface-hover-soft)] active:scale-[0.98]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            'data-[state=open]:border-[var(--text-tertiary)] data-[state=open]:bg-[var(--surface-chip)]',
          )}
          aria-label={t('settings.ghosts.page.addPluginAria')}
        >
          <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
          {t('settings.ghosts.page.addPlugin')}
          <ChevronDown
            size={13}
            strokeWidth={1.75}
            className="transition-transform duration-150 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="w-52 rounded-[12px] border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] p-1.5 text-[var(--text-primary)] shadow-[var(--shadow-menu)]"
      >
        <DropdownMenuItem
          onSelect={onCreateWithCindy}
          className="h-10 gap-3 rounded-lg px-3 text-13 focus:bg-[var(--surface-hover-soft)] focus:text-[var(--text-primary)]"
        >
          <Sparkles
            size={16}
            strokeWidth={1.7}
            className="text-[var(--text-secondary)]"
            aria-hidden="true"
          />
          {t('settings.ghosts.page.createWithCindy')}
        </DropdownMenuItem>
        <DropdownMenuSeparator className="mx-2 my-1 h-px bg-[var(--border-default)]" />
        <DropdownMenuItem
          onSelect={onInstall}
          className="h-10 gap-3 rounded-lg px-3 text-13 focus:bg-[var(--surface-hover-soft)] focus:text-[var(--text-primary)]"
        >
          <Upload
            size={16}
            strokeWidth={1.7}
            className="text-[var(--text-secondary)]"
            aria-hidden="true"
          />
          {t('settings.ghosts.install')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Compact Plugin card shared by installed and restorable builtin entries. */
export function GhostPluginCard({
  item,
  onSelect,
  onAction,
  onToggle,
  effectiveEnabled,
  toggleDisabled = false,
  restoring,
}: {
  item: GhostPluginCardItem;
  onSelect: () => void;
  onAction: () => void;
  onToggle?: (enabled: boolean) => void;
  effectiveEnabled?: boolean;
  toggleDisabled?: boolean;
  restoring: boolean;
}) {
  const { t } = useTranslation();
  const actionKey = item.installed
    ? 'settings.ghosts.page.useAction'
    : item.origin === 'external'
      ? 'settings.ghosts.page.installAction'
      : 'settings.ghosts.restore';
  const actionAriaKey = item.installed
    ? 'settings.ghosts.page.useAria'
    : item.origin === 'external'
      ? 'settings.ghosts.page.installAria'
      : 'settings.ghosts.page.restoreAria';
  return (
    <article
      className={cn(
        'group flex min-h-[108px] w-full select-none items-start gap-4 rounded-xl border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-left',
        'transition-[background-color,border-color,transform] duration-150 ease-out',
        'hover:-translate-y-px hover:border-[var(--text-tertiary)] hover:bg-[var(--surface-hover-soft)]',
        'active:translate-y-0 active:scale-[0.992]',
        'motion-reduce:transform-none motion-reduce:transition-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        restoring && 'cursor-wait opacity-60',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={restoring}
        className="flex min-w-0 flex-1 items-start gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-default"
        aria-label={item.name}
      >
        <GhostPluginIcon iconDataUrl={item.iconDataUrl} iconId={item.id} iconName={item.name} />
        <span className="flex min-w-0 flex-1 flex-col self-stretch pt-0.5">
          <span className="truncate text-15 font-medium text-[var(--text-primary)]">
            {item.name}
          </span>
          <span className="mt-1.5 line-clamp-2 text-13 leading-5 text-[var(--text-secondary)]">
            {item.description || item.id}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-2 self-center">
        {item.installed && onToggle ? (
          <Switch
            checked={effectiveEnabled ?? item.enabled}
            disabled={restoring || toggleDisabled}
            onCheckedChange={onToggle}
            aria-label={t('settings.ghosts.enableAria', { name: item.name })}
          />
        ) : null}
        <button
          type="button"
          onClick={onAction}
          disabled={
            restoring || (item.installed && (!(effectiveEnabled ?? item.enabled) || !item.canUse))
          }
          className={cn(
            'inline-flex h-8 shrink-0 items-center justify-center self-center rounded-lg border border-[var(--border-default)] bg-transparent px-3 text-12 font-medium text-[var(--text-primary)]',
            'transition-[background-color,border-color,transform,opacity] duration-150',
            'hover:border-[var(--text-tertiary)] hover:bg-[var(--surface-hover-soft)] active:scale-[0.98]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            'disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100',
          )}
          aria-label={t(actionAriaKey, { name: item.name })}
        >
          {t(actionKey)}
        </button>
      </div>
    </article>
  );
}

export function InstalledGhostShortcut({
  item,
  onSelect,
}: {
  item: GhostPluginCardItem;
  onSelect: (id: string) => void;
}) {
  return (
    <Tip text={item.name} side="bottom" delay={250}>
      <button
        type="button"
        onClick={() => onSelect(item.id)}
        className={cn(
          'group flex w-16 shrink-0 justify-center rounded-[12px] px-2 py-2',
          'transition-transform duration-150 ease-out hover:-translate-y-px active:translate-y-0 active:scale-[0.98]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          'motion-reduce:transform-none motion-reduce:transition-none',
        )}
        aria-label={item.name}
      >
        <GhostPluginIcon iconDataUrl={item.iconDataUrl} iconId={item.id} iconName={item.name} />
      </button>
    </Tip>
  );
}

function renderInstalledGhost(item: GhostPluginCardItem, onSelect: (id: string) => void) {
  return <InstalledGhostShortcut key={item.id} item={item} onSelect={onSelect} />;
}
