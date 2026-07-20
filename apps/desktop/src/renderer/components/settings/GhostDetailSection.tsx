/**
 * GhostDetailSection — Settings → 意识 → 单张意识的独立设置页(意识系统 C2c-2)。
 *
 * 设计稿:docs/design_docs/settings-view.pen「Dark - Settings 单意识页(Hello,主机默认)」帧。
 * 三段式:头部(身份 + 启用开关)/ 信息卡 / 自定义设置区 / 危险区(卸下)。
 * 「自定义设置区」是意识渲染自有设置界面的插槽:身份卡声明了 settingsHtml
 * 才渲染(沙箱 webview 真实渲染,GhostSettingsWebview),未声明则整块不出现。
 *
 * 卸下成功后本页对应的意识从清单消失,SettingsView 的守卫会自动退回总览页,
 * 本组件不做导航。
 */

import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ChevronRight,
  FolderOpen,
  Info,
  Package,
  ShieldCheck,
  Wrench,
} from 'lucide-react';

import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { GhostPermissionRows } from '@/cindy-brain/GhostPermissionList';
import { GhostSettingsWebview } from '@/cindy-brain/GhostSettingsWebview';
import { CindyCapabilityPrefs } from '@/cindy-brain/CindyCapabilityPrefs';
import { findSplitChildByPanelKind } from '../../../shared/layoutTree';
import {
  ghostContentKeys,
  ghostPanelKind,
  ghostPermissionItems,
  type InstalledGhost,
} from '../../../shared/ghost';
import { ghostInstallErrorKey } from '@/cindy-brain/installErrorKey';
import { pickAndUpdateGhost } from '@/cindy-brain/installFlow';
import { Switch } from '@/components/ui/switch';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';

/**
 * 信息卡的一行(键固定宽,值随内容;action 可选,贴在值后面)。
 * multiline:值完整换行展示(描述这类长文本用),键顶部对齐。
 */
function InfoRow({
  label,
  value,
  action,
  multiline,
}: {
  label: string;
  value: string;
  action?: ReactNode;
  multiline?: boolean;
}) {
  return (
    <div className={`flex gap-4 ${multiline ? 'items-start' : 'items-center'}`}>
      <span className="w-[76px] shrink-0 text-12 text-[var(--text-tertiary)]">{label}</span>
      <span
        className={`min-w-0 text-12 text-[var(--text-secondary)] ${multiline ? 'leading-[1.6]' : 'truncate'}`}
      >
        {value}
      </span>
      {action}
    </div>
  );
}

/**
 * 「权限」卡(事后可查,capability-permissions.md §1 的第三环):装入确认框
 * 展示过的逐项权限清单,在详情页随时可复查。与确认框共用同一推导
 * (ghostPermissionItems)与同一行渲染(GhostPermissionRows),不出两套口径。
 * 默认折叠——权限是"要查的时候必须在",不是每次进页都要读一遍的常驻内容。
 */
function GhostPermissionsCard({ ghost }: { ghost: InstalledGhost }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const items = ghostPermissionItems(ghost.manifest);
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-5 py-4">
      <button
        type="button"
        onClick={() => setOpen((cur) => !cur)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left"
      >
        <ShieldCheck size={14} className="text-[var(--text-tertiary)]" />
        <p className="text-13 font-medium text-[var(--text-primary)]">
          {t('settings.ghosts.detail.permissionsTitle')}
        </p>
        <span className="rounded-md bg-[var(--surface-chip)] px-1.5 py-0.5 text-11 text-[var(--text-tertiary)]">
          {items.length}
        </span>
        <ChevronRight
          size={14}
          className={`ml-auto shrink-0 text-[var(--text-tertiary)] transition-transform ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <div className="mt-3">
          <GhostPermissionRows items={items} />
        </div>
      )}
    </div>
  );
}

/**
 * 「注册工具」卡:身份卡 tools 如实展示(它对 AI 承诺了什么活;只读)。
 * 与权限卡同款折叠交互,默认折叠——工具清单可能很长(如 mivo 12 个),
 * 是"要查的时候必须在",不是每次进页都要读一遍的常驻内容。
 */
function GhostToolsCard({ ghost }: { ghost: InstalledGhost }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const tools = ghost.manifest.tools ?? [];
  if (tools.length === 0) return null;
  return (
    <div className="flex flex-col rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-5 py-4">
      <button
        type="button"
        onClick={() => setOpen((cur) => !cur)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left"
      >
        <Wrench size={14} className="text-[var(--text-tertiary)]" />
        <p className="text-13 font-medium text-[var(--text-primary)]">
          {t('settings.ghosts.detail.toolsTitle')}
        </p>
        <span className="rounded-md bg-[var(--surface-chip)] px-1.5 py-0.5 text-11 text-[var(--text-tertiary)]">
          {tools.length}
        </span>
        <ChevronRight
          size={14}
          className={`ml-auto shrink-0 text-[var(--text-tertiary)] transition-transform ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <div className="mt-3 flex flex-col gap-3">
          {tools.map((tool) => (
            <div key={tool.name} className="flex flex-col gap-0.5">
              <code className="w-fit rounded bg-[var(--surface-chip)] px-1.5 py-0.5 font-mono text-11 text-[var(--text-secondary)]">
                {tool.name}
              </code>
              <p className="text-12 leading-[1.5] text-[var(--text-tertiary)]">{tool.description}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function GhostDetailSection({
  ghost,
  onBack,
}: {
  ghost: InstalledGhost;
  /** 返回插件总览页(侧边栏无二级项后,本页内是唯一显式返回入口)。 */
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { confirm, confirmWithCheckbox } = useConfirmDialog();
  const { manifest } = ghost;
  const kind = ghostPanelKind(manifest.id);
  // 信息卡默认折叠(2026-07-14 Lizi 定案:详情字段多,全铺开信息压力太大;
  // 与权限/注册工具卡同款折叠交互,标题旁留版本徽标保底可见)。
  const [infoOpen, setInfoOpen] = useState(false);
  // 内置意识的抽离文案不同(不会自动装回、可在列表恢复);种子集一次会话内
  // 不变,首渲染同步拉一次即可。
  const [isBuiltin] = useState(() =>
    window.electronAPI.ghosts.builtinStatusSync().builtinIds.includes(manifest.id),
  );

  const handleToggle = useCallback(
    async (enabled: boolean) => {
      try {
        await window.electronAPI.ghosts.setEnabled(manifest.id, enabled);
      } catch {
        toast.error(t('settings.ghosts.errors.generic'));
      }
    },
    [manifest.id, t],
  );

  // 注入位置在系统文件管理器里打开(shell:open-path 对目录同样生效)。
  const handleOpenDir = useCallback(async () => {
    const res = await window.electronAPI.openPath(ghost.dir);
    if (!res.success) toast.error(t('settings.ghosts.errors.generic'));
  }, [ghost.dir, t]);

  // 更新版本:选文件 → 验身(必须同 id)→ 确认(vX → vY)→ 原位换版。
  // 唤醒状态与面板位置延续,编排在 installFlow(与装入同一契约层)。
  const handleUpdate = useCallback(async () => {
    await pickAndUpdateGhost(manifest.id, { t, confirm, confirmWithCheckbox });
  }, [confirm, confirmWithCheckbox, manifest.id, t]);

  const handleUninstall = useCallback(async () => {
    const ok = await confirm({
      title: t('settings.ghosts.uninstallConfirm.title', { name: manifest.name }),
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
      await window.electronAPI.ghosts.uninstall(manifest.id);
      toast.success(t('settings.ghosts.toast.uninstalled', { name: manifest.name }));
    } catch (err) {
      toast.error(t(ghostInstallErrorKey(extractIpcError(err)?.code)));
    }
  }, [confirm, isBuiltin, manifest.id, manifest.name, t]);

  // 面板停靠状态:同步读布局树(极小,规则 7 无 loading);仅展示用。
  const panelStatus = (() => {
    if (!manifest.panel) return t('settings.ghosts.detail.panelNone');
    const docked = (() => {
      try {
        return findSplitChildByPanelKind(window.electronAPI.layout.getStateSync().layout, kind) !== null;
      } catch {
        return false;
      }
    })();
    return docked
      ? t('settings.ghosts.detail.panelDocked', { min: manifest.panel.minWidth ?? 280 })
      : t('settings.ghosts.detail.panelNotDocked');
  })();

  return (
    <div className="flex flex-col gap-[14px]">
      {/* 返回插件列表:与设置页左上「← 设置」同款轻量文本按钮 */}
      <button
        type="button"
        onClick={onBack}
        className="flex w-fit items-center gap-1.5 text-13 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
      >
        <ArrowLeft size={15} />
        {t('settings.ghosts.detail.backToList')}
      </button>

      {/* 头部:身份 + 启用开关 */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3.5">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]">
            {ghost.iconDataUrl ? (
              <img src={ghost.iconDataUrl} alt="" draggable={false} className="h-full w-full object-cover" />
            ) : (
              <Package size={22} className="text-[var(--text-secondary)]" />
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            {/* 版本号不放头部徽标(2026-07-12 Lizi 定案):进信息卡「版本」行,行尾带更新按钮。 */}
            <h2 className="truncate text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
              {manifest.name}
            </h2>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="text-13 text-[var(--text-secondary)]">
            {t('settings.ghosts.detail.enable')}
          </span>
          <Switch
            checked={ghost.enabled}
            onCheckedChange={(next) => void handleToggle(next)}
            aria-label={t('settings.ghosts.enableAria', { name: manifest.name })}
          />
        </div>
      </div>

      {/* 信息卡(2026-07-09 定案:不显示档位/形态词,如实列"包含什么";
          2026-07-14 定案:默认折叠,与权限/注册工具卡同款交互——详情字段
          是"要查的时候必须在",不是每次进页都要读一遍的常驻内容) */}
      <div className="flex flex-col rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-5 py-4">
        <button
          type="button"
          onClick={() => setInfoOpen((cur) => !cur)}
          aria-expanded={infoOpen}
          className="flex w-full items-center gap-2 text-left"
        >
          <Info size={14} className="text-[var(--text-tertiary)]" />
          <p className="text-13 font-medium text-[var(--text-primary)]">
            {t('settings.ghosts.detail.infoTitle')}
          </p>
          {/* 版本徽标常驻折叠头:折叠态也能一眼看到当前版本 */}
          <span className="rounded-md bg-[var(--surface-chip)] px-1.5 py-0.5 text-11 text-[var(--text-tertiary)]">
            v{manifest.version}
          </span>
          <ChevronRight
            size={14}
            className={`ml-auto shrink-0 text-[var(--text-tertiary)] transition-transform ${infoOpen ? 'rotate-90' : ''}`}
          />
        </button>
        {infoOpen && (
          <div className="mt-3 flex flex-col gap-2.5">
            <InfoRow label={t('settings.ghosts.detail.infoId')} value={kind} />
            {manifest.author ? (
              <InfoRow label={t('settings.ghosts.detail.infoAuthor')} value={manifest.author} />
            ) : null}
            {/* 版本行:行尾「更新版本」按钮(选新 .cindy 原位换版,同 id 校验;
                唤醒状态与面板位置延续)—— 原底部独立更新 cell 已并入此行。 */}
            <InfoRow
              label={t('settings.ghosts.detail.infoVersion')}
              value={`v${manifest.version}`}
              action={
                <button
                  type="button"
                  onClick={() => void handleUpdate()}
                  title={t('settings.ghosts.detail.updateDesc')}
                  className="shrink-0 rounded-full border border-[var(--border-default)] px-3 py-1 text-12 text-[var(--text-secondary)] transition-colors hover:bg-sidebar-item-hover"
                >
                  {t('settings.ghosts.detail.updateTitle')}
                </button>
              }
            />
            <InfoRow
              label={t('settings.ghosts.detail.infoContents')}
              value={ghostContentKeys(manifest)
                .map((key) => t(`settings.ghosts.contents.${key}`))
                .join(' · ')}
            />
            <InfoRow label={t('settings.ghosts.detail.infoPanel')} value={panelStatus} />
            <InfoRow
              label={t('settings.ghosts.detail.infoLocation')}
              value={ghost.dir}
              action={
                <button
                  type="button"
                  onClick={() => void handleOpenDir()}
                  title={t('settings.ghosts.detail.openLocation')}
                  aria-label={t('settings.ghosts.detail.openLocation')}
                  className="shrink-0 rounded-md p-1 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-chip)] hover:text-[var(--text-secondary)]"
                >
                  <FolderOpen size={14} />
                </button>
              }
            />
            {/* 描述放卡片最底行:完整换行展示(头部只有一行空间放不下)。 */}
            {manifest.description ? (
              <InfoRow label={t('settings.ghosts.detail.infoDescription')} value={manifest.description} multiline />
            ) : null}
          </div>
        )}
      </div>

      {/* 权限总览(折叠;装入确认框同款清单,事后随时可复查) */}
      <GhostPermissionsCard ghost={ghost} />

      {/* 注册工具(折叠;身份卡 tools 如实展示:它对 AI 承诺了什么活;只读) */}
      <GhostToolsCard ghost={ghost} />

      {/* Cindy 能力(cindy 槽详单声明的每项能力可钉后端;缺省跟随自带 proxy 基座) */}
      {((manifest.cindy?.image?.length ?? 0) > 0 || (manifest.cindy?.video?.length ?? 0) > 0) && (
        <CindyCapabilityPrefs
          key={manifest.id}
          ghostId={manifest.id}
          capabilities={[
            ...(manifest.cindy?.image ?? []).map((a) => `image.${a}`),
            ...(manifest.cindy?.video ?? []).map((a) => `video.${a}`),
          ]}
        />
      )}

      {/* 意识自定义设置区:身份卡声明 settingsHtml 才渲染(沙箱 webview 真实
          渲染,持久化走 /kv,凭证收单经 /secrets 只写通道)。宿主凭证渲染已
          整体退役(2026-07-13 Lizi 定案:基座不为意识特设凭证 UI)——user
          凭证一律在这块自绘区里收单;login-email 派生凭证没有输入动作,
          装入确认框已如实告知,详情页不再单列。 */}
      {manifest.settingsHtml && <GhostSettingsWebview ghost={ghost} />}

      {/* 危险区:卸下 */}
      <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-5 py-4">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-13 font-medium text-[var(--text-primary)]">
            {t('settings.ghosts.detail.dangerTitle')}
          </p>
          <p className="text-12 text-[var(--text-tertiary)]">
            {t(
              isBuiltin
                ? 'settings.ghosts.uninstallConfirm.descriptionBuiltin'
                : 'settings.ghosts.uninstallConfirm.description',
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleUninstall()}
          className="shrink-0 rounded-full border border-[var(--error-border)] px-4 py-1.5 text-12 font-medium text-[var(--error-fg)] transition-colors hover:bg-[var(--error-bg)]"
        >
          {t('settings.ghosts.uninstall')}
        </button>
      </div>
    </div>
  );
}
