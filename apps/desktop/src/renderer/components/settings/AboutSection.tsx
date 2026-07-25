/**
 * AboutSection — Settings → About tab content.
 *
 * 版本号:
 *   - 应用版本号:仅国内版显示,值由 window.electronAPI.appDisplayVersion 同步注入
 *   - Claude Code 版本号: spawn 当前应用使用的 binary `--version`
 *   - Codex 版本号: 同上
 *
 * 视觉对标 doc/design_docs/settings-view.pen 的 "Light/Dark Mode - Settings (About tab)"。
 * 卡片样式与 NotificationSection / FeishuBotSection 同级 (rounded-xl / Board border)。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Switch } from '@/components/ui/switch';
import { useExperimentalFlag } from '@/hooks/useExperimentalFeatures';
import { useAutoUpdateSettings } from '@/hooks/useAutoUpdateSettings';
import { DefaultOverrideControls } from './DefaultOverrideControls';
import { StorageManagementCard } from './StorageManagementCard';
import { CURRENT_CINDY_REGION } from '../../../shared/brandRegion';

interface AgentVersionState {
  loading: boolean;
  version: string | null;
  error?: string;
}

const INITIAL: AgentVersionState = { loading: true, version: null };

function useAgentBinaryVersion(kind: 'claude-code' | 'codex'): AgentVersionState {
  const [state, setState] = useState<AgentVersionState>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.maker.agent
      .getBinaryVersion(kind)
      .then((res) => {
        if (cancelled) return;
        setState({ loading: false, version: res.version, error: res.error });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ loading: false, version: null, error: message });
      });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  return state;
}

const SEMVER_RE = /\d+\.\d+\.\d+(?:[-+.\w]*)?/;

function extractSemver(raw: string): string {
  return SEMVER_RE.exec(raw)?.[0] ?? raw;
}

function renderVersion(
  state: AgentVersionState,
  t: (key: string) => string,
): string {
  if (state.loading) return t('settings.about.version.loading');
  if (state.version) return extractSemver(state.version);
  if (state.error === 'binary_not_ready') return t('settings.about.version.notReady');
  return t('settings.about.version.unknown');
}

export function AboutSection() {
  const { t } = useTranslation();
  const claudeCode = useAgentBinaryVersion('claude-code');
  const codex = useAgentBinaryVersion('codex');

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
        {t('settings.about.title')}
      </h2>

      <p className="text-13 leading-[1.6] text-[var(--settings-section-desc)]">
        {t('settings.about.description')}
      </p>

      {/* Info Card */}
      <div
        className={cn(
          'flex flex-col rounded-xl',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        {CURRENT_CINDY_REGION === 'cn' && (
          <>
            <InfoRow
              label={t('settings.about.appVersionLabel')}
              value={window.electronAPI.appDisplayVersion}
              title={window.electronAPI.appDisplayVersionDetail}
            />
            <Divider />
          </>
        )}
        <AutoUpdateToggleRow />
        <Divider />
        <InfoRow
          label={t('settings.about.claudeCodeVersionLabel')}
          value={renderVersion(claudeCode, t)}
          dim={!claudeCode.version}
        />
        <Divider />
        <InfoRow
          label={t('settings.about.codexVersionLabel')}
          value={renderVersion(codex, t)}
          dim={!codex.version}
        />
        <Divider />
        <DebugLogToggleRow />
        <Divider />
        <OpenLogsRow />
      </div>

      {/* 存储空间(媒体总仓占用 / 清理 / 体检,迁移第 5 步) */}
      <h3 className="mt-2 text-13 font-medium text-[var(--settings-section-title)]">
        {t('settings.about.storage.title')}
      </h3>
      <StorageManagementCard />
    </div>
  );
}

function AutoUpdateToggleRow() {
  const { t } = useTranslation();
  const { state, setAutoRelaunchOnIdle, reset } = useAutoUpdateSettings();
  const [saving, setSaving] = useState(false);

  const handleToggle = async (next: boolean) => {
    setSaving(true);
    try {
      await setAutoRelaunchOnIdle(next);
      toast.success(
        next
          ? t('settings.about.autoUpdateEnabledToast')
          : t('settings.about.autoUpdateDisabledToast'),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.about.autoUpdateSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      await reset();
      toast.success(t('settings.defaults.restored'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.defaults.restoreFailed'));
    } finally {
      setSaving(false);
    }
  };

  const disabled = state.loading || saving;

  return (
    <div className="flex flex-col gap-1.5 px-[18px] py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-13 text-[var(--settings-section-sublabel)]">
            {t('settings.about.autoUpdateLabel')}
          </span>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {t('settings.about.autoUpdateDescription')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <DefaultOverrideControls
            isCustomized={state.isCustomized}
            disabled={disabled}
            onReset={handleReset}
          />
          <Switch
            checked={state.autoRelaunchOnIdle}
            disabled={disabled}
            onCheckedChange={handleToggle}
            aria-label={t('settings.about.autoUpdateLabel')}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Debug 日志开关。
 *
 * 之前挂在 admin-only 的 ExperimentalSection 下，普通用户看不见也用不上;
 * 排查问题时只能让对方手改 localStorage。搬到 About (所有人可见) 后:
 *   - localStorage key 仍是 'experimental.debug-network',已开启的用户无感迁移
 *   - dev 模式下 main 侧硬开 (bootstrap-electron.ts), UI 同步锁死 on+disabled,
 *     避免开发者点了 toggle 看似关掉但日志还在写的诡异体验
 *   - main-side 副作用 (process.env.XDT_CC_DEBUG_NET) 通过 ccSetDebugNet IPC
 *     在 mount 时同步一次,toggle 变化时立即同步
 */
function DebugLogToggleRow() {
  const { t } = useTranslation();
  const { enabled, setEnabled } = useExperimentalFlag('debug-network');
  const lockedOn = import.meta.env.DEV;
  const effectiveEnabled = lockedOn ? true : enabled;

  useEffect(() => {
    void window.electronAPI?.ccSetDebugNet?.(effectiveEnabled);
  }, [effectiveEnabled]);

  return (
    <div className="flex flex-col gap-1.5 px-[18px] py-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-13 text-[var(--settings-section-sublabel)]">
          {t('settings.about.debugLogLabel')}
        </span>
        <Switch
          checked={effectiveEnabled}
          disabled={lockedOn}
          onCheckedChange={setEnabled}
          aria-label={t('settings.about.debugLogLabel')}
        />
      </div>
      <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70 pr-12">
        {t('settings.about.debugLogDescription')}
      </p>
    </div>
  );
}

function OpenLogsRow() {
  const { t } = useTranslation();
  const handleOpen = async () => {
    try {
      const res = await window.electronAPI.openLogsDir();
      if (!res.success) toast.error(res.error || t('settings.about.openLogsDirError'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.about.openLogsDirError'));
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 px-[18px] py-4">
      <span className="text-13 text-[var(--settings-section-sublabel)]">
        {t('settings.about.logsDirLabel')}
      </span>
      <button
        type="button"
        onClick={handleOpen}
        className={cn(
          'flex items-center gap-1.5 rounded-md px-2.5 py-1 -mr-1',
          'text-12 font-medium text-[var(--settings-section-title)]',
          'border border-[var(--settings-theme-card-border)]',
          'hover:bg-[var(--settings-theme-card-border)]/40',
          'transition-colors',
        )}
        title={t('settings.about.openLogsDirTooltip')}
      >
        <FolderOpen size={13} />
        {t('settings.about.openLogsDir')}
      </button>
    </div>
  );
}

function InfoRow({ label, value, title = value, dim = false }: { label: string; value: string; title?: string; dim?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-[18px] py-4" title={title}>
      <span className="text-13 text-[var(--settings-section-sublabel)]">{label}</span>
      <span
        className={cn(
          'truncate text-13 font-medium',
          dim
            ? 'text-[var(--settings-section-sublabel)] opacity-70'
            : 'text-[var(--settings-section-title)]',
        )}
      >
        {value}
      </span>
    </div>
  );
}

function Divider() {
  return (
    <div
      aria-hidden
      className="h-px w-full"
      style={{ background: 'var(--settings-theme-card-border)' }}
    />
  );
}
