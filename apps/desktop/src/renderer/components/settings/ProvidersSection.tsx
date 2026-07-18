/**
 * ProvidersSection —— 设置 → 模型供应商页(按 .pen Q0RH66 1:1 还原,颜色走主题 token)。
 *
 * 一张 Providers Card,内含若干行(1px divider 分隔),每行由 listProviders() 的
 * ProviderView 驱动(按 provider.id 匹配 anthropic / openai / xd 三个已知来源 +
 * 一行 disabled 占位)。本页**不发明新的连接 IPC**,复用既有鉴权流:
 *   - Anthropic: maker.claudeOAuth*(授权 / 登出 / 状态)。
 *   - OpenAI:    useCodexAuth()(授权 / 登出,内部走 maker.auth.* codex 通道)。
 *   - XD 网关:  凭据由 model-access 自动下发(useModelAccessStatus 驱动状态;断开 = clearKey 清本机存量;无手填入口)。
 *
 * 连接态通常以 useProviders() 的 provider.connected 为准；OpenAI 行由 useCodexAuth
 * 保留更具体的 reconnect-required 状态，provider 快照只在初始加载时兜底。
 *
 * 模型显示控制(展开态):每个「有模型」的来源行尾带 chevron,展开后是该来源支持的模型清单,
 * 每个模型一个开关 —— 控制它是否出现在对话的模型选择器里(见 modelVisibilityPrefs +
 * ModelSelector 的右栏过滤)。多 agent 来源(XD)展开后顶部有 agent 切换器,每个 agent 的
 * 模型清单 / 开关 / 计数各自独立(同名模型如 gpt-5.5 在 cc=1M / codex=272k 也分开记)。
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronRight, ChevronUp, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useProviders } from '@/hooks/useProviders';
import { isChatGptConnectionConnected, useCodexAuth } from '@/hooks/useCodexAuth';
import { useApiKey } from '@/hooks/useApiKey';
import { useModelAccessStatus } from '@/hooks/useModelAccessStatus';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import { deleteCustomProvider } from '@/lib/customProviders';
import { providerMonogram } from '@/lib/providerModels';
import { customProviderSubtitleForDisplay, providerSubtitleForDisplay } from '@/lib/providerSubtitle';
import { CustomProviderDialog } from './CustomProviderDialog';
import { Switch } from '@/components/ui/switch';
import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';
import { XDIncMark } from '@/components/icons/XDIncMark';
import { groupModelsForDisplay, CATEGORY_LABEL_KEY } from '@/components/new-chat/sourceSwitch';
import {
  isModelEnabled,
  setManyVisibility,
  setModelVisibility,
  useModelVisibilityVersion,
} from '@/state/modelVisibilityPrefs';


import type { AgentKind, CatalogModel, CustomProviderConfig, ProviderView } from '@lizi/model-providers';

// ---------------------------------------------------------------------------
// 工具:上下文窗口 tokens → 紧凑展示("1M" / "272K" / "8192")。与 ModelSelector 同口径。
// ---------------------------------------------------------------------------

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : Number(m.toFixed(1))}M`;
  }
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return `${Number.isInteger(k) ? k : Number(k.toFixed(0))}K`;
  }
  return String(tokens);
}

/** 该来源跨「所有它服务的 agent」的模型开启数 / 总数(供名字旁的合计 chip)。 */
function combinedCount(provider: ProviderView): { on: number; total: number } {
  let on = 0;
  let total = 0;
  for (const agent of provider.agents) {
    for (const m of provider.models[agent] ?? []) {
      total += 1;
      if (isModelEnabled(agent, provider.id, m)) on += 1;
    }
  }
  return { on, total };
}

function providerHasModels(provider: ProviderView): boolean {
  return provider.agents.some((a) => (provider.models[a]?.length ?? 0) > 0);
}

// ---------------------------------------------------------------------------
// Connected pill —— `✓ 已连接`,中性灰底(豁免色场景之外的普通 chip,走 token)。
// ---------------------------------------------------------------------------

function ConnectedPill() {
  const { t } = useTranslation();
  return (
    <span
      className="flex h-[22px] shrink-0 items-center gap-1 rounded-full px-2.5 text-11 font-medium"
      style={{
        backgroundColor: 'var(--settings-btn-secondary-bg)',
        color: 'var(--settings-section-desc)',
      }}
    >
      <Check size={12} strokeWidth={2.5} />
      {t('settings.providers.pill.connected')}
    </span>
  );
}

/** OpenAI OAuth 仍可恢复但需要用户重新连接；使用中性 chip，避免表现成全局故障。 */
function ReconnectRequiredPill() {
  const { t } = useTranslation();
  return (
    <span
      className="flex h-[22px] shrink-0 select-none items-center gap-1 rounded-full px-2.5 text-11 font-medium"
      style={{
        backgroundColor: 'var(--settings-btn-secondary-bg)',
        color: 'var(--settings-section-desc)',
      }}
    >
      <RefreshCw size={11} />
      {t('settings.providers.openai.reconnectRequired')}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Count chip —— 名字旁的「已开启/总数」合计(跨 agent)。视觉同 ConnectedPill 但更小。
// ---------------------------------------------------------------------------

function CountChip({ on, total }: { on: number; total: number }) {
  return (
    <span
      className="flex h-[18px] shrink-0 items-center rounded-full px-2 text-11 font-medium tabular-nums"
      style={{
        backgroundColor: 'var(--settings-btn-secondary-bg)',
        color: 'var(--settings-section-desc)',
      }}
    >
      {on}/{total}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Secondary pill button(授权 / 登出 / 连接 / 断开)—— rounded-full,1px border。
// ---------------------------------------------------------------------------

function PillButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex h-8 shrink-0 items-center justify-center rounded-full px-[14px] text-13 font-medium transition-colors',
        'border',
        disabled && 'cursor-not-allowed opacity-60',
      )}
      style={{
        backgroundColor: 'var(--settings-btn-secondary-bg)',
        borderColor: 'var(--settings-btn-secondary-border)',
        color: 'var(--settings-btn-secondary-text)',
      }}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Agent 切换器(仅多 agent 来源)—— pill 分段控件,视觉对齐 VendorSegmentedSwitcher。
// ---------------------------------------------------------------------------

const AGENT_META: Record<AgentKind, { label: string; Mark: ComponentType<{ size?: number; className?: string }> }> = {
  'claude-code': { label: 'Claude', Mark: ClaudeMark },
  codex: { label: 'Codex', Mark: CodexMark },
};

function AgentSwitcher({
  agents,
  active,
  onChange,
}: {
  agents: readonly AgentKind[];
  active: AgentKind;
  onChange: (agent: AgentKind) => void;
}) {
  return (
    <div
      className="flex h-8 w-[220px] items-center gap-0.5 rounded-full p-[3px]"
      style={{ backgroundColor: 'var(--surface-chip)' }}
      role="tablist"
      aria-label="Agent switcher"
    >
      {agents.map((a) => {
        const meta = AGENT_META[a];
        if (!meta) return null;
        const isActive = a === active;
        const Mark = meta.Mark;
        return (
          <button
            key={a}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => {
              if (!isActive) onChange(a);
            }}
            className={cn(
              // flex-1 让两个 tab 等分容器宽度 —— 与标签长短无关,始终一样大(对齐 VendorSegmentedSwitcher)。
              'flex h-[26px] flex-1 items-center justify-center gap-1.5 rounded-full px-2 text-13 leading-none transition-colors',
              isActive ? 'font-medium' : 'font-normal',
            )}
            style={
              isActive
                ? {
                    backgroundColor: 'var(--surface-elevated)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--settings-section-title)',
                  }
                : { color: 'var(--text-secondary)' }
            }
          >
            <Mark size={14} className="shrink-0" />
            <span className="whitespace-nowrap">{meta.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model list panel —— 展开后的模型清单(搜索 + 计数 + 全部开关 + 分组 + 逐模型开关)。
// 多 agent 来源顶部带 agent 切换器,每个 agent 各自独立。
// ---------------------------------------------------------------------------

function ModelListPanel({ provider }: { provider: ProviderView }) {
  const { t } = useTranslation();
  const agents = provider.agents;
  const multiAgent = agents.length > 1;
  const [activeAgent, setActiveAgent] = useState<AgentKind>(
    () => agents.find((a) => (provider.models[a]?.length ?? 0) > 0) ?? agents[0],
  );
  const [query, setQuery] = useState('');

  const models = provider.models[activeAgent] ?? [];
  // 该来源任一 agent 下模型数较多 → 显示搜索框(切 agent 不抖动:阈值取所有 agent 的最大值)。
  const maxLen = Math.max(...agents.map((a) => provider.models[a]?.length ?? 0));
  const showSearch = maxLen > 8;
  // 跨多个厂商分组才显示分组小标题(单一分组如 Anthropic 直接平铺)。基于完整列表判定,稳定不随搜索变化。
  const showGroupHeaders = useMemo(() => groupModelsForDisplay(models).length > 1, [models]);

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const filtered = q
      ? models.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
      : models;
    return groupModelsForDisplay(filtered);
  }, [models, q]);

  const total = models.length;
  const enabledCount = models.filter((m) => isModelEnabled(activeAgent, provider.id, m)).length;
  const allOn = total > 0 && enabledCount === total;

  const handleBulk = useCallback(() => {
    setManyVisibility(activeAgent, provider.id, models.map((m) => m.id), !allOn);
  }, [activeAgent, provider.id, models, allOn]);

  return (
    <div
      className="flex flex-col border-t"
      style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--settings-theme-card-border)' }}
    >
      {multiAgent && (
        <div className="px-5 pt-3.5">
          <AgentSwitcher
            agents={agents}
            active={activeAgent}
            onChange={(a) => {
              setActiveAgent(a);
              setQuery('');
            }}
          />
        </div>
      )}

      {/* 头部:搜索框(多模型)或「可用模型」标签 + 当前 agent 计数(多 agent)+ 全部开关 */}
      <div className="flex items-center gap-3 px-5 py-2.5">
        {showSearch ? (
          <div
            className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full px-3"
            style={{ backgroundColor: 'var(--surface-elevated)', border: '1px solid var(--border-default)' }}
          >
            <Search size={14} className="shrink-0" style={{ color: 'var(--text-tertiary)' }} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('settings.providers.models.search')}
              aria-label={t('settings.providers.models.search')}
              className="min-w-0 flex-1 bg-transparent text-13 outline-none placeholder:text-[var(--text-tertiary)]"
              style={{ color: 'var(--settings-section-title)' }}
            />
          </div>
        ) : (
          <span className="flex-1 text-13 font-medium" style={{ color: 'var(--text-secondary)' }}>
            {t('settings.providers.models.available')}
          </span>
        )}
        {multiAgent && (
          <span className="shrink-0 text-12 font-medium tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.providers.models.enabledCount', { on: enabledCount, total })}
          </span>
        )}
        <button
          type="button"
          onClick={handleBulk}
          className="shrink-0 text-12 font-medium transition-opacity hover:opacity-80"
          style={{ color: 'var(--text-secondary)' }}
        >
          {t(allOn ? 'settings.providers.models.disableAll' : 'settings.providers.models.enableAll')}
        </button>
      </div>

      {/* 分组 + 逐模型开关 */}
      <div className="flex flex-col gap-4 px-5 pb-4 pt-0.5">
        {groups.length === 0 ? (
          <div className="py-4 text-center text-13" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.providers.models.noResults')}
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.category} className="flex flex-col">
              {showGroupHeaders && (
                <span
                  className="pb-0.5 text-11 font-semibold uppercase"
                  style={{ color: 'var(--text-tertiary)', letterSpacing: '0.4px' }}
                >
                  {t(CATEGORY_LABEL_KEY[g.category])}
                </span>
              )}
              {g.models.map((m: CatalogModel) => {
                const enabled = isModelEnabled(activeAgent, provider.id, m);
                return (
                  <div key={m.id} className="flex items-center gap-3 py-[7px]">
                    <span
                      className="min-w-0 flex-1 truncate text-14 font-medium"
                      style={{ color: enabled ? 'var(--settings-section-title)' : 'var(--text-tertiary)' }}
                    >
                      {m.name}
                    </span>
                    <span className="shrink-0 text-12 tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
                      {formatContextWindow(m.contextWindow)}
                    </span>
                    <Switch
                      checked={enabled}
                      onCheckedChange={(v) => setModelVisibility(activeAgent, provider.id, m.id, v)}
                      aria-label={m.name}
                    />
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider cell —— avatar + 标题(+计数 chip)/副标题 + 右侧 trailing + chevron;
// 可选 detail(XD 的 masked-key 行);展开后接 ModelListPanel。
// ---------------------------------------------------------------------------

function ProviderCell({
  icon,
  title,
  subtitle,
  trailing,
  provider,
  detail,
  badge,
  onUnavailableExpand,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  trailing: ReactNode;
  provider?: ProviderView;
  detail?: ReactNode;
  /** 标题旁的额外徽标（自定义供应商的「自定义」tag）。 */
  badge?: ReactNode;
  /** 来源行需要保留展开入口、但实时模型清单不可用时的点击反馈。 */
  onUnavailableExpand?: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasModels = !!provider && providerHasModels(provider);
  const expandable = hasModels || !!onUnavailableExpand;
  const effectiveExpanded = hasModels && expanded;
  const counts = hasModels && provider ? combinedCount(provider) : null;
  const subscriptionProduct =
    provider?.access?.kind === 'subscription' ? provider.access.product : null;

  return (
    <div className="flex flex-col">
      <div className={cn('flex flex-col px-5 py-4', detail && 'gap-3')}>
        <div className="flex items-center gap-3">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
            style={{
              backgroundColor: 'var(--settings-integration-avatar-bg)',
              border: '1px solid var(--settings-integration-avatar-border)',
              color: 'var(--settings-integration-avatar-icon)',
            }}
          >
            {icon}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span
                className="min-w-0 truncate text-14 font-medium leading-tight"
                style={{ color: 'var(--settings-section-title)' }}
              >
                {title}
              </span>
              {counts && <CountChip on={counts.on} total={counts.total} />}
              {subscriptionProduct && (
                <CustomTag
                  label={t('settings.providers.models.subscriptionProduct', {
                    product: subscriptionProduct,
                  })}
                />
              )}
              {badge}
            </div>
            <span
              className="truncate text-13 leading-tight"
              style={{ color: 'var(--settings-integration-subtitle)' }}
            >
              {subtitle}
            </span>
          </div>

          {trailing}

          {expandable && (
            <button
              type="button"
              onClick={() => {
                if (!hasModels) {
                  onUnavailableExpand?.();
                  return;
                }
                setExpanded((v) => !v);
              }}
              aria-expanded={effectiveExpanded}
              aria-label={t(
                effectiveExpanded
                  ? 'settings.providers.models.collapseAria'
                  : 'settings.providers.models.expandAria',
              )}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-hover)]"
            >
              {effectiveExpanded ? (
                <ChevronUp size={18} style={{ color: 'var(--text-tertiary)' }} />
              ) : (
                <ChevronDown size={18} style={{ color: 'var(--text-tertiary)' }} />
              )}
            </button>
          )}
        </div>

        {detail}
      </div>

      {effectiveExpanded && provider && <ModelListPanel provider={provider} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Anthropic row —— OAuth(Claude.ai 订阅),复用 maker.claudeOAuth*。
// ---------------------------------------------------------------------------

function AnthropicRow({ provider, onChanged }: { provider?: ProviderView; onChanged: () => void }) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [busy, setBusy] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const connected = provider?.connected ?? false;

  const handleLogin = useCallback(async () => {
    setLoggingIn(true);
    try {
      const r = await window.electronAPI.maker.claudeOAuthLogin();
      if (r.ok) {
        toast.success(t('settings.connections.claude.toast.loggedIn'));
        onChanged();
      } else if (r.reason === 'login_cancelled') {
        /* 用户取消,不弹错 */
      } else if (r.reason === 'not_a_subscription') {
        toast.error(t('settings.connections.claude.toast.notSubscription'));
      } else {
        toast.error(t('settings.connections.claude.toast.loginFailed'));
      }
    } catch {
      toast.error(t('settings.connections.claude.toast.loginFailed'));
    } finally {
      setLoggingIn(false);
    }
  }, [onChanged, t]);

  const handleLogout = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.connections.claude.logoutConfirm.title'),
      description: t('settings.connections.claude.logoutConfirm.description'),
      confirmText: t('settings.connections.claude.logoutConfirm.confirm'),
      cancelText: t('settings.connections.claude.logoutConfirm.cancel'),
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await window.electronAPI.maker.claudeOAuthLogout();
      toast.success(t('settings.connections.claude.toast.loggedOut'));
      onChanged();
    } catch {
      toast.error(t('settings.connections.claude.toast.logoutFailed'));
    } finally {
      setBusy(false);
    }
  }, [confirm, onChanged, t]);

  const trailing = connected ? (
    <div className="flex shrink-0 items-center gap-2.5">
      <ConnectedPill />
      <PillButton
        label={t('settings.providers.button.disconnect')}
        onClick={() => void handleLogout()}
        disabled={busy}
      />
    </div>
  ) : (
    <PillButton
      label={loggingIn ? t('settings.providers.button.cancel') : t('settings.providers.button.authorize')}
      onClick={() => {
        if (loggingIn) {
          void window.electronAPI.maker.claudeOAuthCancel();
          setLoggingIn(false);
        } else {
          void handleLogin();
        }
      }}
    />
  );

  return (
    <ProviderCell
      icon={<ClaudeMark size={18} />}
      title={t('settings.providers.anthropic.title')}
      subtitle={providerSubtitleForDisplay(provider, t('settings.providers.anthropic.modelLabel'), {
        fallback: t('settings.providers.anthropic.subtitle'),
      })}
      trailing={trailing}
      provider={provider}
    />
  );
}

// ---------------------------------------------------------------------------
// OpenAI row —— OAuth(ChatGPT 订阅 / Codex),复用 useCodexAuth()。
// ---------------------------------------------------------------------------

function OpenAiRow({ provider, onChanged }: { provider?: ProviderView; onChanged: () => void }) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const { state, triggerLogin, cancelLogin, logout } = useCodexAuth();
  const reconnectRequired = state.kind === 'reconnect-required';
  const loggingIn = state.kind === 'login-pending';
  // useCodexAuth 是这条连接的权威状态；provider 目录只在 hook 尚未完成首次读取时兜底。
  // 这样失效或重连中都不会因为目录刷新较慢而短暂显示“已连接”。
  const connected = isChatGptConnectionConnected(state, provider?.connected ?? false);

  const handleLogout = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.connections.codex.logoutConfirm.title'),
      description: t('settings.connections.codex.logoutConfirm.description'),
      confirmText: t('settings.connections.codex.logoutConfirm.confirm'),
      cancelText: t('settings.connections.codex.logoutConfirm.cancel'),
    });
    if (!confirmed) return;
    try {
      await logout();
      toast.success(t('settings.connections.codex.toast.loggedOut'));
    } catch {
      toast.error(t('settings.connections.codex.toast.logoutFailed'));
    } finally {
      onChanged();
    }
  }, [confirm, logout, onChanged, t]);

  const handleLogin = useCallback(async () => {
    const outcome = await triggerLogin();
    if (outcome === 'authenticated') {
      onChanged();
    } else if (outcome === 'failed') {
      toast.error(t('settings.connections.codex.toast.loginFailed'));
    }
  }, [triggerLogin, onChanged, t]);

  const trailing = connected ? (
    <div className="flex shrink-0 items-center gap-2.5">
      <ConnectedPill />
      <PillButton label={t('settings.providers.button.disconnect')} onClick={() => void handleLogout()} />
    </div>
  ) : reconnectRequired ? (
    <div className="flex shrink-0 items-center gap-2.5">
      <ReconnectRequiredPill />
      <PillButton label={t('settings.providers.openai.reconnect')} onClick={() => void handleLogin()} />
    </div>
  ) : (
    <PillButton
      label={loggingIn ? t('settings.providers.openai.cancelConnect') : t('settings.providers.openai.connect')}
      onClick={() => {
        if (loggingIn) void cancelLogin();
        else void handleLogin();
      }}
    />
  );

  return (
    <ProviderCell
      icon={<CodexMark size={18} />}
      title={t('settings.providers.openai.title')}
      subtitle={t('settings.providers.openai.subtitle')}
      trailing={trailing}
      provider={provider}
    />
  );
}

// ---------------------------------------------------------------------------
// xAI row —— OAuth(SuperGrok 订阅),复用 maker.xaiOAuth*。形态对齐 Anthropic row。
// ---------------------------------------------------------------------------

function XaiRow({ provider, onChanged }: { provider?: ProviderView; onChanged: () => void }) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [busy, setBusy] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const connected = provider?.connected ?? false;

  const handleLogin = useCallback(async () => {
    setLoggingIn(true);
    try {
      const r = await window.electronAPI.maker.xaiOAuthLogin();
      if (r.ok) {
        toast.success(t('settings.connections.xai.toast.loggedIn'));
        onChanged();
      } else if (r.reason === 'login_cancelled') {
        /* 用户取消,不弹错 */
      } else {
        toast.error(t('settings.connections.xai.toast.loginFailed'));
      }
    } catch {
      toast.error(t('settings.connections.xai.toast.loginFailed'));
    } finally {
      setLoggingIn(false);
    }
  }, [onChanged, t]);

  const handleLogout = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.connections.xai.logoutConfirm.title'),
      description: t('settings.connections.xai.logoutConfirm.description'),
      confirmText: t('settings.connections.xai.logoutConfirm.confirm'),
      cancelText: t('settings.connections.xai.logoutConfirm.cancel'),
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await window.electronAPI.maker.xaiOAuthLogout();
      toast.success(t('settings.connections.xai.toast.loggedOut'));
      onChanged();
    } catch {
      toast.error(t('settings.connections.xai.toast.logoutFailed'));
    } finally {
      setBusy(false);
    }
  }, [confirm, onChanged, t]);

  const trailing = connected ? (
    <div className="flex shrink-0 items-center gap-2.5">
      <ConnectedPill />
      <PillButton
        label={t('settings.providers.button.disconnect')}
        onClick={() => void handleLogout()}
        disabled={busy}
      />
    </div>
  ) : (
    <PillButton
      label={loggingIn ? t('settings.providers.button.cancel') : t('settings.providers.button.authorize')}
      onClick={() => {
        if (loggingIn) {
          void window.electronAPI.maker.xaiOAuthCancel();
          setLoggingIn(false);
        } else {
          void handleLogin();
        }
      }}
    />
  );

  return (
    <ProviderCell
      icon={<span className="text-15 font-semibold leading-none">{providerMonogram(provider?.name ?? 'xAI')}</span>}
      title={t('settings.providers.xai.title')}
      subtitle={providerSubtitleForDisplay(provider, t('settings.providers.xai.modelLabel'), {
        fallback: t('settings.providers.xai.subtitle'),
      })}
      trailing={trailing}
      provider={provider}
    />
  );
}

// ---------------------------------------------------------------------------
// 通用 OAuth row —— 目录 auth.oauth 描述符驱动的供应商(非 bespoke 四家)。
// 登录/登出走 PROVIDER_OAUTH_* IPC(generic-oauth Runner),目录推数据即插即用。
// ---------------------------------------------------------------------------

function GenericOAuthRow({ provider, onChanged }: { provider: ProviderView; onChanged: () => void }) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [busy, setBusy] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const connected = provider.connected;

  const handleLogin = useCallback(async () => {
    setLoggingIn(true);
    try {
      const r = await window.electronAPI.maker.providerOAuthLogin(provider.id);
      if (r.ok) {
        toast.success(t('settings.providers.genericOAuth.toast.loggedIn', { name: provider.name }));
        onChanged();
      } else if (r.reason === 'login_cancelled') {
        /* 用户取消,不弹错 */
      } else {
        toast.error(t('settings.providers.genericOAuth.toast.loginFailed', { name: provider.name }));
      }
    } catch {
      toast.error(t('settings.providers.genericOAuth.toast.loginFailed', { name: provider.name }));
    } finally {
      setLoggingIn(false);
    }
  }, [onChanged, provider.id, provider.name, t]);

  const handleLogout = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.providers.genericOAuth.logoutConfirm.title', { name: provider.name }),
      description: t('settings.providers.genericOAuth.logoutConfirm.description', { name: provider.name }),
      confirmText: t('settings.providers.genericOAuth.logoutConfirm.confirm'),
      cancelText: t('settings.providers.genericOAuth.logoutConfirm.cancel'),
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await window.electronAPI.maker.providerOAuthLogout(provider.id);
      toast.success(t('settings.providers.genericOAuth.toast.loggedOut', { name: provider.name }));
      onChanged();
    } catch {
      toast.error(t('settings.providers.genericOAuth.toast.logoutFailed', { name: provider.name }));
    } finally {
      setBusy(false);
    }
  }, [confirm, onChanged, provider.id, provider.name, t]);

  const trailing = connected ? (
    <div className="flex shrink-0 items-center gap-2.5">
      <ConnectedPill />
      <PillButton
        label={t('settings.providers.button.disconnect')}
        onClick={() => void handleLogout()}
        disabled={busy}
      />
    </div>
  ) : (
    <PillButton
      label={loggingIn ? t('settings.providers.button.cancel') : t('settings.providers.button.authorize')}
      onClick={() => {
        if (loggingIn) {
          void window.electronAPI.maker.providerOAuthCancel(provider.id);
          setLoggingIn(false);
        } else {
          void handleLogin();
        }
      }}
    />
  );

  return (
    <ProviderCell
      icon={<span className="text-15 font-semibold leading-none">{providerMonogram(provider.name)}</span>}
      title={provider.name}
      subtitle={t('settings.providers.genericOAuth.subtitle')}
      trailing={trailing}
      provider={provider}
    />
  );
}

// ---------------------------------------------------------------------------
// XD 网关 row —— managed gateway key(useApiKey)。连接时多出一行 masked key chip。
// ---------------------------------------------------------------------------

function maskKey(key: string): string {
  // sk-•••••• + 末 4 位(参考 .pen keychip 形态)。拿不到真值时给通用遮罩。
  if (key && key.length >= 4) return `sk-••••••${key.slice(-4)}`;
  return 'sk-••••••••';
}

function XdGatewayRow({ provider, onChanged }: { provider?: ProviderView; onChanged: () => void }) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const { key, hasSavedKey, clearKey } = useApiKey();
  const syncStatus = useModelAccessStatus();
  const connected = provider?.connected ?? false;
  const [rotating, setRotating] = useState(false);

  // 凭据一律由服务端自动下发(个人 / 已接入企业),**无手填入口**(2026-07-17 定案):
  // 连接态由登录同步驱动;失败只提供重试;「断开」仅用于清理本机存量 key。
  const serverManaged = syncStatus.state === 'ok' && syncStatus.source === 'server';

  // 同步状态翻 ok(main 侧已写入新 key)→ 刷新供应商列表,让 provider.connected
  // 立即反映自动下发结果(useProviders 不订阅 key 变化,需要显式 refetch)。
  const prevSyncStateRef = useRef(syncStatus.state);
  useEffect(() => {
    if (prevSyncStateRef.current === syncStatus.state) return;
    prevSyncStateRef.current = syncStatus.state;
    if (syncStatus.state === 'ok') onChanged();
  }, [syncStatus.state, onChanged]);

  const handleDisconnect = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.providers.xd.disconnectConfirm.title'),
      description: t('settings.providers.xd.disconnectConfirm.description'),
      confirmText: t('settings.providers.button.disconnect'),
      cancelText: t('settings.connections.codex.logoutConfirm.cancel'),
    });
    if (!confirmed) return;
    const ok = await clearKey();
    if (ok) onChanged();
  }, [clearKey, confirm, onChanged, t]);

  const handleRetry = useCallback(() => {
    void window.electronAPI.modelAccess
      .retry()
      .then(() => onChanged())
      .catch(() => undefined);
  }, [onChanged]);

  const handleUnavailableExpand = useCallback(() => {
    toast.error(t('settings.providers.xd.sync.modelsFetchFailed'));
  }, [t]);

  // 轮换密钥(泄露自救):旧 key 立即失效,进行中的会话 / 远端会话 / 手机语音
  // 会用旧 key 收到 401,新会话自动用新 key —— 确认文案明示这一影响。
  const handleRotate = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.providers.xd.rotateConfirm.title'),
      description: t('settings.providers.xd.rotateConfirm.description'),
      confirmText: t('settings.providers.xd.rotateConfirm.confirm'),
      cancelText: t('settings.connections.codex.logoutConfirm.cancel'),
    });
    if (!confirmed) return;
    setRotating(true);
    try {
      await window.electronAPI.modelAccess.rotate();
      toast.success(t('settings.providers.xd.rotateSuccess'));
      onChanged();
    } catch {
      toast.error(t('settings.providers.xd.rotateFailed'));
    } finally {
      setRotating(false);
    }
  }, [confirm, onChanged, t]);

  const trailing = (() => {
    switch (syncStatus.state) {
      case 'unsupported':
        // 企业未开通:不提供任何入口(含手填),置灰说明。
        return (
          <span className="shrink-0 text-12" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.providers.xd.sync.unsupported')}
          </span>
        );
      case 'syncing':
        return (
          <PillButton label={t('settings.providers.xd.sync.syncing')} onClick={() => undefined} disabled />
        );
      case 'ok':
        if (serverManaged) {
          return (
            <div className="flex shrink-0 items-center gap-2.5">
              <ConnectedPill />
              <PillButton
                label={rotating ? t('settings.providers.xd.sync.rotating') : t('settings.providers.xd.sync.rotate')}
                onClick={() => void handleRotate()}
                disabled={rotating}
              />
            </div>
          );
        }
        break;
      case 'failed':
        // 自动获取失败:只提供重试;本地既有 key 不受影响(仍显示已连接)。
        return (
          <div className="flex shrink-0 items-center gap-2.5">
            {connected && <ConnectedPill />}
            <PillButton label={t('settings.providers.xd.sync.retry')} onClick={handleRetry} />
          </div>
        );
      default:
        break;
    }
    // idle(未登录/未同步)/ disabled(服务端灰度未启用):
    // 有存量 key → 已连接 + 断开(清本机);无 key → 置灰说明,等登录自动下发。
    return connected ? (
      <div className="flex shrink-0 items-center gap-2.5">
        <ConnectedPill />
        <PillButton label={t('settings.providers.button.disconnect')} onClick={() => void handleDisconnect()} />
      </div>
    ) : (
      <span className="shrink-0 text-12" style={{ color: 'var(--text-tertiary)' }}>
        {syncStatus.state === 'disabled'
          ? t('settings.providers.xd.sync.disabled')
          : t('settings.providers.xd.sync.autoProvision')}
      </span>
    );
  })();

  // 已连接时:masked key chip 已存本地才有真实末 4 位,否则通用遮罩。
  const maskedKey = useMemo(() => maskKey(hasSavedKey ? key : ''), [hasSavedKey, key]);

  // 连接后的缩进行(masked key + 次操作)——对齐到文字块(avatar 36 + gap 12 = 48px)。
  // server 托管态的次操作是「重新获取凭据」;存量本机 key 无次操作(只读展示)。
  const detail =
    connected && syncStatus.state !== 'unsupported' ? (
      <div className="flex items-center gap-2.5 pl-12">
        <span
          className="flex shrink-0 items-center rounded-md px-2 py-1 text-12"
          style={{
            backgroundColor: 'var(--surface-chip)',
            border: '1px solid var(--settings-integration-avatar-border)',
            color: 'var(--settings-section-desc)',
          }}
        >
          {maskedKey}
        </span>
        <div className="flex-1" />
        {serverManaged && (
          <button
            type="button"
            onClick={handleRetry}
            className="shrink-0 text-12 transition-colors"
            style={{ color: 'var(--settings-integration-subtitle)' }}
          >
            {t('settings.providers.xd.sync.refresh')}
          </button>
        )}
      </div>
    ) : undefined;

  return (
    <ProviderCell
      icon={<XDIncMark size={18} />}
      title={t('settings.providers.xd.title')}
      subtitle={providerSubtitleForDisplay(provider, t('settings.providers.xd.modelLabel'), {
        suffix: t('settings.providers.xd.billingLabel'),
        fallback: t('settings.providers.xd.subtitle'),
      })}
      trailing={trailing}
      provider={provider}
      detail={detail}
      onUnavailableExpand={handleUnavailableExpand}
    />
  );
}

// ---------------------------------------------------------------------------
// Custom (user) provider row —— 复用 ProviderCell（自动获得展开 + 模型开关），
// trailing 用「编辑 / 删除」图标按钮替代「断开」，标题旁带「自定义」描边 tag。
// ---------------------------------------------------------------------------

/** ProviderView（标准 Provider + connected）→ 编辑表单用的 CustomProviderConfig（per-runtime，不含密钥）。 */
function providerViewToConfig(p: ProviderView): CustomProviderConfig {
  const runtimes: CustomProviderConfig['runtimes'] = {};
  for (const agent of p.agents) {
    const routing = p.routing[agent];
    const models = p.models[agent] ?? [];
    runtimes[agent] = {
      baseUrl: routing?.upstream ?? '',
      models: models.map((m) => ({ id: m.id, name: m.name })),
      ...(routing?.headerOverride && Object.keys(routing.headerOverride).length > 0
        ? { headers: { ...routing.headerOverride } }
        : {}),
      // 列模型端点随 routing 回带（buildUserProvider 写入），编辑保存不丢持久化字段。
      ...(routing?.modelsUrl ? { modelsUrl: routing.modelsUrl } : {}),
    };
  }
  return {
    id: p.id,
    name: p.name,
    // OAuth 形态回填（编辑态需要描述符原值；ProviderView 继承 Provider，auth 就在其中）。
    ...(p.auth.method === 'oauth' && p.auth.oauth ? { auth: { method: 'oauth' as const, oauth: p.auth.oauth } } : {}),
    runtimes,
  };
}

function RowIconButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-hover)]"
      style={{ color: 'var(--text-tertiary)' }}
    >
      {icon}
    </button>
  );
}

function CustomTag({ label }: { label: string }) {
  return (
    <span
      className="flex h-[18px] shrink-0 items-center rounded-full px-2 text-11 font-medium"
      style={{ border: '1px solid var(--settings-integration-avatar-border)', color: 'var(--text-tertiary)' }}
    >
      {label}
    </span>
  );
}

function CustomProviderRow({
  provider,
  onEdit,
  onDelete,
}: {
  provider: ProviderView;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [loggingIn, setLoggingIn] = useState(false);
  // OAuth 形态自定义供应商：编辑/删除之外还有「授权登录 / 退出」（走通用 OAuth IPC）。
  const isOAuth = provider.auth.method === 'oauth' && !!provider.auth.oauth;
  const handleOAuthClick = useCallback(async () => {
    if (provider.connected) {
      try {
        await window.electronAPI.maker.providerOAuthLogout(provider.id);
        toast.success(t('settings.providers.genericOAuth.toast.loggedOut', { name: provider.name }));
      } catch {
        toast.error(t('settings.providers.genericOAuth.toast.logoutFailed', { name: provider.name }));
      }
      return;
    }
    if (loggingIn) {
      void window.electronAPI.maker.providerOAuthCancel(provider.id);
      setLoggingIn(false);
      return;
    }
    setLoggingIn(true);
    try {
      const r = await window.electronAPI.maker.providerOAuthLogin(provider.id);
      if (r.ok) toast.success(t('settings.providers.genericOAuth.toast.loggedIn', { name: provider.name }));
      else if (r.reason !== 'login_cancelled') {
        toast.error(t('settings.providers.genericOAuth.toast.loginFailed', { name: provider.name }));
      }
    } catch {
      toast.error(t('settings.providers.genericOAuth.toast.loginFailed', { name: provider.name }));
    } finally {
      setLoggingIn(false);
    }
  }, [loggingIn, provider.connected, provider.id, provider.name, t]);
  const trailing = (
    <div className="flex shrink-0 items-center gap-1">
      {isOAuth && (
        <PillButton
          label={
            provider.connected
              ? t('settings.providers.button.disconnect')
              : loggingIn
                ? t('settings.providers.button.cancel')
                : t('settings.providers.button.authorize')
          }
          onClick={() => void handleOAuthClick()}
        />
      )}
      <RowIconButton
        icon={<Pencil size={16} />}
        label={t('settings.providers.custom.editAria')}
        onClick={onEdit}
      />
      <RowIconButton
        icon={<Trash2 size={16} />}
        label={t('settings.providers.custom.deleteAria')}
        onClick={onDelete}
      />
    </div>
  );
  return (
    <ProviderCell
      icon={<span className="text-15 font-semibold leading-none">{providerMonogram(provider.name)}</span>}
      title={provider.name}
      subtitle={customProviderSubtitleForDisplay(provider)}
      trailing={trailing}
      provider={provider}
      badge={<CustomTag label={t('settings.providers.custom.tag')} />}
    />
  );
}

// ---------------------------------------------------------------------------
// Add custom provider entry —— 可点入口行（打开新建表单），列表最底部。
// ---------------------------------------------------------------------------

function AddCustomRow({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-[var(--surface-hover)]"
    >
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
        style={{
          backgroundColor: 'var(--surface)',
          border: '1px solid var(--settings-btn-secondary-border)',
          color: 'var(--settings-section-desc)',
        }}
      >
        <Plus size={18} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className="text-14 font-medium leading-tight"
          style={{ color: 'var(--settings-section-title)' }}
        >
          {t('settings.providers.addCustom.title')}
        </span>
        <span
          className="truncate text-13 leading-tight"
          style={{ color: 'var(--settings-integration-subtitle)' }}
        >
          {t('settings.providers.addCustom.subtitle')}
        </span>
      </div>
      <ChevronRight size={18} style={{ color: 'var(--text-tertiary)' }} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Divider
// ---------------------------------------------------------------------------

function Divider() {
  return <div className="border-t" style={{ borderColor: 'var(--settings-theme-card-border)' }} />;
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function ProvidersSection() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const { providers, loading, refetch } = useProviders();
  // 订阅模型显示开关 version:任一开关变更后整页重算(名字旁计数 chip + 展开面板)。
  useModelVisibilityVersion();

  // 自定义供应商表单弹窗:null = 关闭;{} = 新建;{config} = 编辑。
  const [dialog, setDialog] = useState<
    null | { mode: 'create' } | { mode: 'edit'; config: CustomProviderConfig }
  >(null);

  // 订阅 maker.auth 变更由 useProviders 内部处理;api-key 类断开后手动 refetch。
  const byId = useMemo(() => {
    const map = new Map<string, ProviderView>();
    providers.forEach((p) => map.set(p.id, p));
    return map;
  }, [providers]);

  // 自定义(user)供应商行,按 listProviders 顺序(sortOrder)。
  const customProviders = useMemo(
    () => providers.filter((p) => p.source === 'user'),
    [providers],
  );

  const handleDelete = useCallback(
    async (p: ProviderView) => {
      const ok = await confirm({
        title: t('settings.providers.custom.deleteConfirm.title'),
        description: t('settings.providers.custom.deleteConfirm.description', { name: p.name }),
        confirmText: t('settings.providers.custom.deleteConfirm.confirm'),
        cancelText: t('settings.providers.custom.deleteConfirm.cancel'),
      });
      if (!ok) return;
      try {
        // 删配置 + 清密钥;main 广播 PROVIDER_CHANGED → useProviders 自动 refetch。
        await deleteCustomProvider(p.id);
        toast.success(t('settings.providers.custom.toast.deleted'));
      } catch {
        toast.error(t('settings.providers.custom.toast.deleteFailed'));
      }
    },
    [confirm, t],
  );

  // 只保留有模型的供应商行——没有可选模型的供应商不应占据列表空间。
  const providerRows: Array<{ key: string; node: ReactNode }> = [];
  const pushBuiltin = (id: string, render: (p: ProviderView) => ReactNode) => {
    const p = byId.get(id);
    if (p && providerHasModels(p)) providerRows.push({ key: id, node: render(p) });
  };
  // Cindy AI 行固定置顶,即使实时模型清单为空也保留:用户仍需要看到凭据状态 / 重试入口,
  // 点击展开则由 XdGatewayRow 给出明确的「模型列表拉取失败」提示。
  const xdProvider = byId.get('xd');
  if (xdProvider) {
    providerRows.push({
      key: 'xd',
      node: <XdGatewayRow provider={xdProvider} onChanged={refetch} />,
    });
  }
  pushBuiltin('anthropic', (p) => <AnthropicRow provider={p} onChanged={refetch} />);
  pushBuiltin('openai', (p) => <OpenAiRow provider={p} onChanged={refetch} />);
  pushBuiltin('xai', (p) => <XaiRow provider={p} onChanged={refetch} />);
  // 通用 OAuth 供应商(目录 auth.oauth 描述符驱动、非上面 bespoke 四家):目录推数据即出现。
  // OAuth 形态**不要求已有模型**:模型在授权成功后动态发现,零模型时行必须保留,
  // 否则用户没有「授权」按钮可点,发现永远无法发生(鸡生蛋死锁)。自定义 OAuth 行同理。
  for (const p of providers) {
    if (p.source !== 'builtin' || ['anthropic', 'openai', 'xai', 'xd'].includes(p.id)) continue;
    if (!(p.auth.method === 'oauth' && p.auth.oauth)) continue;
    providerRows.push({ key: p.id, node: <GenericOAuthRow provider={p} onChanged={refetch} /> });
  }
  for (const p of customProviders) {
    if (providerHasModels(p) || (p.auth.method === 'oauth' && p.auth.oauth)) {
      providerRows.push({
        key: p.id,
        node: (
          <CustomProviderRow
            provider={p}
            onEdit={() => setDialog({ mode: 'edit', config: providerViewToConfig(p) })}
            onDelete={() => void handleDelete(p)}
          />
        ),
      });
    }
  }

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1.5">
        <h2
          className="text-18 font-semibold leading-[1.2]"
          style={{ color: 'var(--settings-section-title)' }}
        >
          {t('settings.providers.title')}
        </h2>
        <p className="text-13 leading-snug" style={{ color: 'var(--settings-section-desc)' }}>
          {t('settings.providers.subtitle')}
        </p>
      </div>

      {/* 先取数据再渲染卡片:仅首次冷启(无模块快照)时 loading 为 true,此时不画行——
          否则会按"未连接"画出矮的 XD 行,IPC 返回后 connected 翻 true 又撑高一行
          masked-key chip,造成跳变一帧(规则 7)。重开时 useProviders 有快照,loading
          立即为 false,第一帧即终态高度。卡片只在顶部,门控期间无下方内容被推挤。 */}
      {!loading && (
        <div
          className={cn('flex flex-col rounded-xl', 'border')}
          style={{
            backgroundColor: 'var(--settings-theme-card-bg)',
            borderColor: 'var(--settings-theme-card-border)',
          }}
        >
          {providerRows.map((row, i) => (
            <Fragment key={row.key}>
              {i > 0 && <Divider />}
              {row.node}
            </Fragment>
          ))}
          {providerRows.length > 0 && <Divider />}
          <AddCustomRow onClick={() => setDialog({ mode: 'create' })} />
        </div>
      )}

      {dialog && (
        <CustomProviderDialog
          initial={dialog.mode === 'edit' ? dialog.config : undefined}
          existingIds={providers.map((p) => p.id)}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            // 兜底刷新(广播也会触发,双保险无害)。
            refetch();
          }}
        />
      )}
    </div>
  );
}
