import { useState, useMemo, useEffect, useRef, type CSSProperties } from 'react';
import {
  Check,
  ChevronDown,
  PlugZap,
  Plus,
  Search,
  SlidersHorizontal,
  Unplug,
  Zap,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { flashScrollbar } from '@/lib/scrollbarAutoHide';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';
import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';
import { XDIncMark } from '@/components/icons/XDIncMark';
import { FastModeToggle } from './FastModeToggle';
import { useAgentCapabilities, type AgentKind } from '@/hooks/useAgentCapabilities';
import { useApiKey } from '@/hooks/useApiKey';
import { useConnectedSource } from '@/hooks/useConnectedSource';
import { useModelPricing } from '@/hooks/useModelPricing';
import { useProviders } from '@/hooks/useProviders';
import { useDeviceProviders } from '@/hooks/useDeviceProviders';
import { providerMonogram, selectVisibleModels } from '@/lib/providerModels';
import type { Effort } from '@/lib/userPreferences.types';
import { isModelEnabled, useModelVisibilityVersion } from '@/state/modelVisibilityPrefs';
import { useSessionModelMemoryVersion } from '@/state/sessionModelMemory';
import { useProviderModelMemoryVersion } from '@/state/providerModelMemory';
import { useDeviceLinkModelMirrorVersion } from '@/state/deviceLinkModelMirror';
import {
  connectedProvidersForAgent,
  getModel,
  modelSupportsFastMode,
  nativeDefaultSourceId,
  providerOffersModel,
  type ProviderView,
} from '@lizi/model-providers';
import { buildProviderSections } from './sourceSwitch';

// 厂商分类 / 分组标题 key 表的纯逻辑在 ./sourceSwitch。这里 re-export 给 ChatInput
// (它从 './ModelSelector' import categorize / CATEGORY_LABEL_KEY / ModelCategory 做跨厂商确认弹窗)。
export { categorize, CATEGORY_LABEL_KEY, type ModelCategory } from './sourceSwitch';

/**
 * 【非当前选中】模型行的 effort/fast 记忆读写器,由调用方按上下文注入(ModelSelector 本身
 * 不再耦合任何具体存储)。
 *   - 草稿(NewMakerDraftRoute → ChatInput 无 sessionId)→ providerModelMemory(跨会话持久,草稿专属)
 *   - 已创建会话(ChatInput 有 sessionId、非 device-link)→ sessionModelMemory(运行期,按 sessionId 隔离)
 *   - device-link 远程会话 → 纯显示镜像 override(写穿被控端),控制端本地不落记忆
 *   - 不传(flat 选择器:CreateWorkerPopover / scheduler)→ 非选中行不读不写任何记忆,只显示模型默认
 * 这条隔离正是「草稿默认值被会话内修改污染」bug 的修复边界:
 *     会话写入只会落到会话自己的记忆 / 远程镜像,绝不触达控制端草稿记忆。
 * 选中行的 effort/fast 不走这里(草稿走 lastByVendor / props,会话走 DB 的 initialEffort/fastMode)。
 */
export interface ModelMemoryAccessors {
  getEffort: (agent: AgentKind, providerId: string, modelId: string) => Effort | undefined;
  setEffort: (agent: AgentKind, providerId: string, modelId: string, effort: Effort) => void;
  getFast: (agent: AgentKind, providerId: string, modelId: string) => boolean | undefined;
  setFast: (agent: AgentKind, providerId: string, modelId: string, enabled: boolean) => void;
}

// 供应商完整展示名:三个内置 id 复用设置页 i18n 标题(settings.providers.<id>.title),
// 自定义供应商回退目录里的 provider.name。用于行 hover tooltip 前缀。
const PROVIDER_TITLE_KEY: Record<string, string> = {
  anthropic: 'settings.providers.anthropic.title',
  openai: 'settings.providers.openai.title',
  xd: 'settings.providers.xd.title',
};
function providerDisplayName(p: ProviderView, t: (key: string) => string): string {
  const key = PROVIDER_TITLE_KEY[p.id];
  return key ? t(key) : p.name;
}

// 来源供应商 → 单色官方 mark(fill=currentColor)。trigger 默认右间距 + trigger 文字色;
// 列表行前缀通过 colorClass / withMargin 改用 secondary 色 + 由 flex gap 控间距。
export function ProviderMark({
  providerId,
  name,
  colorClass = 'text-[var(--model-trigger-text)]',
  withMargin = true,
  dense = false,
}: {
  providerId: string;
  name?: string;
  colorClass?: string;
  withMargin?: boolean;
  /** 列表行前缀用 dense:比 trigger 小一档(约 -10%)。两套静态尺寸,JIT 友好。 */
  dense?: boolean;
}) {
  const common = cn(withMargin && 'mr-1.5', 'shrink-0', colorClass);
  const markSize = dense ? 12.3 : 13;
  switch (providerId) {
    case 'anthropic':
      return <ClaudeMark size={markSize} className={common} />;
    case 'openai':
      return <CodexMark size={markSize} className={common} />;
    case 'xd':
      return (
        <XDIncMark
          size={markSize}
          className={cn(dense ? 'h-[8.4px] w-[14.2px]' : 'h-[9px] w-[15px]', common)}
        />
      );
    default:
      if (!name) return null;
      // 自定义供应商:首字母描边方盒(border 跟随 currentColor = colorClass 设定的文字色)。
      return (
        <span
          className={cn(
            withMargin && 'mr-1.5',
            'flex shrink-0 items-center justify-center rounded-[4px] border border-current font-semibold leading-none',
            dense ? 'h-[14.2px] w-[14.2px] text-[8.4px]' : 'h-[15px] w-[15px] text-[9px]',
            colorClass,
          )}
          aria-hidden
        >
          {providerMonogram(name)}
        </span>
      );
  }
}

function ModelBrandMark({
  modelId,
  agentKind,
  fallbackProviderId,
  fallbackProviderName,
  colorClass = 'text-[var(--model-trigger-text)]',
  withMargin = true,
  dense = false,
}: {
  modelId: string;
  agentKind: AgentKind | null;
  fallbackProviderId?: string | null;
  fallbackProviderName?: string;
  colorClass?: string;
  withMargin?: boolean;
  dense?: boolean;
}) {
  const common = cn(withMargin && 'mr-1.5', 'shrink-0', colorClass);
  const markSize = dense ? 12.3 : 13;
  const normalized = modelId.toLowerCase();
  if (
    agentKind === 'claude-code' ||
    normalized.startsWith('claude-') ||
    normalized.startsWith('opus') ||
    normalized.startsWith('sonnet') ||
    normalized.startsWith('haiku') ||
    normalized.startsWith('fable')
  ) {
    return <ClaudeMark size={markSize} className={common} />;
  }
  if (
    agentKind === 'codex' ||
    normalized.startsWith('codex/') ||
    normalized.startsWith('gpt-') ||
    normalized.startsWith('chatgpt/') ||
    normalized.startsWith('openai/')
  ) {
    return <CodexMark size={markSize} className={common} />;
  }
  if (!fallbackProviderId) return null;
  return (
    <ProviderMark
      providerId={fallbackProviderId}
      name={fallbackProviderName}
      colorClass={colorClass}
      withMargin={withMargin}
      dense={dense}
    />
  );
}

// 上下文窗口 tokens → 紧凑展示("1M" / "272K" / "8192")。
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

// 单栏列表里每行 / Edit 配置列消费的最小模型形状(SectionModel 与 renderer ModelDescriptor 都满足)。
interface RowModel {
  id: string;
  displayName: string;
  efforts: readonly Effort[];
  defaultEffort: Effort | null;
  effortDisplayNames?: Partial<Record<string, string>>;
  supportsFastMode?: boolean;
}

type Translate = (key: string, options?: { defaultValue?: string }) => string;

export function modelEffortLabel(
  t: Translate,
  m: Pick<RowModel, 'effortDisplayNames'> | null | undefined,
  e: Effort,
  agentDisplayName?: string,
): string {
  return t(`effortLevels.${e}`, {
    defaultValue: m?.effortDisplayNames?.[e] ?? agentDisplayName ?? e,
  });
}

interface ModelSelectorProps {
  modelId: string;
  effort: Effort;
  onModelChange: (modelId: string) => void;
  onEffortChange: (effort: Effort) => void;
  /**
   * per-session 来源选择(B · Provider-first)。
   *   - currentProviderId:本会话当前显式选定的供应商 id(null = 跟随默认路由)。
   *   - onProviderChange:选某行(供应商, 模型)时调用,第 2 参为该行模型 id(原子切 provider+model+effort)。
   *   - onNavigateToProviders:0 个可连来源时空态 CTA / 列表底部「连接来源」跳设置→供应商页。
   * 三者都不传 → 单栏纯列表(无供应商分段),选行只 onModelChange(老入口 / CreateWorkerPopover)。
   */
  currentProviderId?: string | null;
  onProviderChange?: (
    providerId: string | null,
    reconciledModelId?: string,
    reconciledEffort?: Effort,
  ) => void;
  onNavigateToProviders?: () => void;
  /**
   * 会话显式选中的来源已断开(由 ChatInput 按 sessionId / deviceLink scoping 计算,见
   * isSelectedSourceDisconnected)。true → trigger 显示**真实选中来源** + 「已断开」错误态,
   * 不回落默认来源图标(否则界面显示的来源与发送实际使用的来源分叉,用户无法自查)。
   * 其他消费方(ScheduleChips / ImDefaultSettingsSection / CreateWorkerPopover 等)不传 = 行为不变。
   */
  sourceDisconnected?: boolean;
  /** Fast Mode 状态 + 回调(从工具栏搬进 Edit 配置列)。不传 → 配置列不显示 Fast 开关。 */
  fastMode?: boolean;
  onFastModeChange?: (enabled: boolean) => void | Promise<void>;
  /** 非选中模型行的 effort/fast 记忆读写器(草稿 / 会话各注入各的,见 ModelMemoryAccessors)。 */
  modelMemory?: ModelMemoryAccessors;
  /** When provided, only models with this vendorKey are shown in the dropdown. */
  vendorKey?: 'cc' | 'codex';
  /** device-link 远程会话所属被控端 id;非空 = 列被控端的模型 + 退化为纯列表(不分供应商段)。 */
  deviceId?: string;
  /**
   * SSH 远程会话(remoteHostId)传 true:隐藏订阅直连模型(chatgpt/ / xai/)——bridge 只挂在
   * 本地 compat-proxy,远程模式不经它,选了必失败(见 selectVisibleModels 同名参数)。
   */
  excludeSubscriptionDirect?: boolean;
  /**
   * device-link 远程切换 in-flight:trigger 置灰 + 禁用点击,直到被控端 echo 回流。
   * 配合 ChatInput 的乐观显示(chip 已显示目标值)给一个「正在生效」的视觉提示,避免回落默认态的跳变。
   * 仅远程会话会为 true;本地会话恒 false。
   */
  switching?: boolean;
  /** 禁用 trigger。用于断线远程会话等只读 composer 状态。 */
  disabled?: boolean;
  /** 窄容器下把 trigger 字号/高度各压一档,默认 false。 */
  dense?: boolean;
  /** Trigger presentation: toolbar keeps the compact chat pill; field renders a settings input-like control. */
  triggerVariant?: 'toolbar' | 'field';
  /** CREATE AGENT 首页按 Figma 185:2724 使用独立私有 token。 */
  visualVariant?: 'default' | 'create-agent';
  /** Popover 弹出方向,默认 "top"（底部工具栏向上弹），dialog 内嵌场景传 "bottom"。 */
  popoverSide?: 'top' | 'bottom';
}

interface ModelSelectorContentProps {
  modelId: string;
  effort: Effort;
  onModelChange: (modelId: string) => void;
  onEffortChange: (effort: Effort) => void;
  fastMode?: boolean;
  onFastModeChange?: (enabled: boolean) => void | Promise<void>;
  modelMemory?: ModelMemoryAccessors;
  vendorKey?: 'cc' | 'codex';
  /** device-link 远程会话所属被控端 id(列被控端模型)。 */
  deviceId?: string;
  /** SSH 远程会话隐藏订阅直连模型(语义同 ModelSelectorProps 同名字段)。 */
  excludeSubscriptionDirect?: boolean;
  /** 选中后是否自动关闭。Popover 场景传入,内嵌场景不传。 */
  onDismiss?: () => void;
  currentProviderId?: string | null;
  onProviderChange?: (
    providerId: string | null,
    reconciledModelId?: string,
    reconciledEffort?: Effort,
  ) => void;
  onNavigateToProviders?: () => void;
  /**
   * 可选「跟随会话」行(opt-in)。仅 scheduler 的 heartbeat(绑定会话)任务传入:
   * 在模型列表顶部加一行,选中 = model 留空(跟随绑定会话的模型 / 来源)。
   */
  followSession?: { active: boolean; label: string; onFollow: () => void };
}

function vendorKeyToAgentKind(v?: 'cc' | 'codex'): AgentKind | null {
  if (v === 'cc') return 'claude-code';
  if (v === 'codex') return 'codex';
  return null;
}

export function ModelSelectorContent({
  modelId,
  effort,
  onModelChange,
  onEffortChange,
  fastMode = false,
  onFastModeChange,
  modelMemory,
  vendorKey,
  deviceId,
  excludeSubscriptionDirect,
  onDismiss,
  currentProviderId,
  onProviderChange,
  onNavigateToProviders,
  followSession,
}: ModelSelectorContentProps) {
  const { t } = useTranslation();
  const agentKind = vendorKeyToAgentKind(vendorKey);
  // 同时拉两个 agent —— vendorKey 不传时把两边模型一起展示。hooks 必须按固定顺序调用。
  const cc = useAgentCapabilities('claude-code', deviceId);
  const codex = useAgentCapabilities('codex', deviceId);
  const pricing = useModelPricing();
  // 骨折GPT (codex/) 永远显示(恒走 gateway api key);没配 key → 置灰 + 提示去配置。
  const { hasSavedKey } = useApiKey();
  // 供应商来源:本机会话用本机 useProviders;device-link 远程会话用**被控端**供应商目录
  // (useDeviceProviders,隧道 maker:provider:list)。两 hook 都无条件调用(hooks 规则),按 deviceId 取。
  const localProviders = useProviders();
  const remoteProviders = useDeviceProviders(deviceId);
  const providers = deviceId ? remoteProviders.providers : localProviders.providers;
  const providersLoading = deviceId ? remoteProviders.loading : localProviders.loading;

  const visibilityVersion = useModelVisibilityVersion();
  const [query, setQuery] = useState('');
  // 当前展开 Edit 配置列的目标(供应商id + 模型id)。null = 配置列收起(单栏)。
  const [editing, setEditing] = useState<{ providerId: string | null; modelId: string } | null>(
    null,
  );
  // 非选中模型的 effort/fast 改动写进记忆(localStorage),不反映在 props —— 用 tick 触发重渲染读新值。
  const [editTick, setEditTick] = useState(0);
  const bump = () => setEditTick((n) => n + 1);
  // 跨进程 / 远程改动:device-link push 会直接改底层记忆 store(providerModelMemory / sessionModelMemory /
  // deviceLinkModelMirror),不经本组件的 editTick。订阅三个 store 的版本号,任一变化即重渲染、重算行
  // effort/fast 显示(本地草稿用 providerModelMemory,本地会话用 sessionModelMemory,远程用镜像)。
  const storeVersion =
    editTick +
    useProviderModelMemoryVersion() +
    useSessionModelMemoryVersion() +
    useDeviceLinkModelMirrorVersion();
  void storeVersion;

  const listRef = useRef<HTMLDivElement>(null);

  // 模型清单来源:本机会话从 live providers 派生(builtin + 自定义合集);device-link 远程会话
  // 必须列**被控端**模型(cc/codex.capabilities.availableModels,deviceId 作用域),不读控制端本地
  // catalog —— 见 selectVisibleModels 的「以被控端为准」契约。merged 入口(无 vendorKey)cc+codex 去重。
  const visibleModels = useMemo(
    () =>
      selectVisibleModels({
        agentKind,
        deviceId,
        providers,
        deviceCcModels: cc.capabilities?.availableModels ?? [],
        deviceCodexModels: codex.capabilities?.availableModels ?? [],
        excludeSubscriptionDirect,
      }),
    [
      agentKind,
      deviceId,
      providers,
      cc.capabilities,
      codex.capabilities,
      excludeSubscriptionDirect,
    ],
  );

  const currentModel = visibleModels.find((m) => m.id === modelId);

  // currentModel 归属的 agent —— effortLevels 标签按它取(不合并两边,避免 Claude/Codex 同 id 标签互覆盖)。
  const currentAgentKind: AgentKind | null = useMemo(() => {
    if (agentKind) return agentKind;
    if (!currentModel) return null;
    if (providers.some((p) => providerOffersModel(p, currentModel.id, 'claude-code'))) {
      return 'claude-code';
    }
    if (providers.some((p) => providerOffersModel(p, currentModel.id, 'codex'))) {
      return 'codex';
    }
    return null;
  }, [currentModel, providers, agentKind]);

  const effortMeta = useMemo(() => {
    const levels =
      currentAgentKind === 'claude-code'
        ? (cc.capabilities?.effortLevels ?? [])
        : currentAgentKind === 'codex'
          ? (codex.capabilities?.effortLevels ?? [])
          : [];
    return new Map(levels.map((e) => [e.id, e.displayName]));
  }, [currentAgentKind, cc.capabilities, codex.capabilities]);
  // 档名多语言:i18n 词表(effortLevels.*) → 模型级 effortDisplayNames →
  // capabilities displayName(未知档兜底) → 原 id。
  const effortLabelFor = (m: RowModel, e: Effort) => modelEffortLabel(t, m, e, effortMeta.get(e));

  // 当前 agent 是否支持 Fast Mode(agent 级能力,叠加 per-model supportsFastMode 才显示开关)。
  const hasFastModeCap = useMemo(() => {
    if (currentAgentKind === 'claude-code') return !!cc.capabilities?.hasFastMode;
    if (currentAgentKind === 'codex') return !!codex.capabilities?.hasFastMode;
    return false;
  }, [currentAgentKind, cc.capabilities, codex.capabilities]);
  // ── 来源(供应商)栏 ──────────────────────────────────────────────────────
  // 本机 + device-link 远程会话都支持来源分段:providers 已按 deviceId 切到被控端目录,
  // 远程切来源经隧道 set-model(providerId)生效(见 ChatInput.handleProviderChange 的远程分支)。
  const sourcesEnabled = !!onProviderChange;
  const connected = useMemo(
    () =>
      sourcesEnabled && currentAgentKind
        ? connectedProvidersForAgent(providers, currentAgentKind)
        : [],
    [sourcesEnabled, providers, currentAgentKind],
  );
  const nativeDefaultId = useMemo(
    () => nativeDefaultSourceId(connected, currentAgentKind),
    [connected, currentAgentKind],
  );
  // 显式选中(且仍在已连接列表)→ 它;否则原生默认来源(= 未显式选时路由实际命中那家)。
  const activeSourceId =
    currentProviderId && connected.some((p) => p.id === currentProviderId)
      ? currentProviderId
      : nativeDefaultId;

  // 行级 Fast 可编辑性 = agent 能力 × 该(供应商, 模型)条目的 supportsFastMode。
  // Fast 能力是 per-(provider, agent) 的(见 CatalogModel)：按该行供应商现查它自己的模型条目,
  // 同一 model id 在不同供应商下可不同(如某网关剥掉 fast 字段 ⇒ 那家配 false)。providerId 为 null
  // (flat / device-link 退化)回退 activeSourceId;取不到供应商 / 该来源不提供此模型 ⇒ false。
  // cc / codex 同一套门控,仅各供应商的配置数据不同。
  const fastEditable = (providerId: string | null, m: RowModel): boolean => {
    if (!onFastModeChange || !hasFastModeCap || !currentAgentKind) return false;
    const provider = connected.find((p) => p.id === (providerId ?? activeSourceId));
    return modelSupportsFastMode(provider, m.id, currentAgentKind);
  };

  // ── 模型单价 / hover tooltip ─────────────────────────────────────────────
  const modelById = useMemo(() => {
    const map = new Map<string, (typeof visibleModels)[number]>();
    for (const m of visibleModels) map.set(m.id, m);
    return map;
  }, [visibleModels]);

  const priceTipOf = (id: string): string | null => {
    const p = pricing?.[id];
    if (!p) return null;
    const fmt = (v: number) => `$${Number(v.toFixed(2))}`;
    return t('newChat.modelSelector.priceTip', {
      input: fmt(p.inputUsdPerMtok),
      output: fmt(p.outputUsdPerMtok),
    });
  };
  const tooltipFor = (id: string): string | null => {
    const meta = modelById.get(id);
    const parts: string[] = [];
    if (meta && meta.contextWindow > 0) {
      parts.push(
        t('newChat.modelSelector.meta.context', { value: formatContextWindow(meta.contextWindow) }),
      );
    }
    const price = priceTipOf(id);
    if (price) parts.push(price);
    if (meta?.supportsFastMode) parts.push(t('newChat.modelSelector.meta.fastBadge'));
    return parts.length > 0 ? parts.join(' · ') : null;
  };
  const budgetDisabledOf = (id: string): boolean => id.startsWith('codex/') && !hasSavedKey;

  // ── 供应商分段 / flat 列表 ────────────────────────────────────────────────
  // sections 非空 = 按供应商分段(每行 = (供应商, 模型));null = flat(无供应商概念)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: visibilityVersion 是外部可见性偏好的刷新信号,需要强制重算分段列表。
  const sections = useMemo(() => {
    if (!sourcesEnabled || !currentAgentKind) return null;
    // 0 个可连来源 → 返回 null 退化到 flat 列表(而非空 sections 触发「无结果」)。覆盖:
    //  · device-link 老被控端不认 maker:provider:list(invoke reject)→ device providers 为空 → flat 兜底;
    //  · providers 拉取中的瞬态窗口;· 本机 0 来源已由上方 emptyState 引导卡先行接管。
    if (connected.length === 0) return null;
    return buildProviderSections({
      providers: connected,
      agent: currentAgentKind,
      selectedModelId: modelId,
      selectedProviderId: activeSourceId,
      // device-link 远程会话:被控端目录「是啥就是啥」,绝不套控制端本机的可见性 override
      // —— modelVisibilityPrefs 是控制端本机 UI 偏好(设置→供应商的隐藏开关),与被控端无关,
      // 套上去会让远程列表变成「被控端目录 ∩ 控制端隐藏开关」,跟被控端实际清单对不上。
      // 本机会话仍按用户本机开关过滤(行为不变)。
      isVisible: deviceId
        ? () => true
        : (pid, mid) => {
            const p = connected.find((x) => x.id === pid);
            const cat = p ? getModel(p, mid, currentAgentKind) : undefined;
            return isModelEnabled(currentAgentKind, pid, {
              id: mid,
              defaultEnabled: cat?.defaultEnabled,
            });
          },
      query,
    });
    // visibilityVersion 仅作刷新触发器(设置页改显示开关后强制重算);deviceId 切换需重算分段。
  }, [
    sourcesEnabled,
    connected,
    currentAgentKind,
    modelId,
    activeSourceId,
    query,
    visibilityVersion,
    deviceId,
  ]);

  const flatModels = useMemo(() => {
    if (sections) return null;
    const q = query.trim().toLowerCase();
    if (!q) return visibleModels;
    return visibleModels.filter(
      (m) => m.displayName.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
    );
  }, [sections, visibleModels, query]);

  // 选中判定:flat 模式只比模型 id;分段模式还要比供应商(同模型多供应商下只高亮当前来源那行)。
  const isSelectedRow = (providerId: string | null, id: string): boolean =>
    id === modelId && (providerId === null || providerId === activeSourceId);

  // 行内 Fast 闪电:**严格 per-(供应商, 模型)**。选中行 → live fastMode;其余行 → 该 (供应商,模型)
  // 的注入记忆(草稿=providerModelMemory / 会话=sessionModelMemory),缺省 false。不读 provider-agnostic
  // 的 per-model 记忆 —— 否则同一 model id 跨供应商会串(写了 openai 那份,xd 行 fallback 到共享
  // per-model 也亮 = 之前两个 5.5 一起变的根因)。
  const fastOnOf = (providerId: string | null, m: RowModel): boolean => {
    if (!fastEditable(providerId, m)) return false;
    if (isSelectedRow(providerId, m.id)) return fastMode;
    if (!currentAgentKind || !providerId) return false;
    return modelMemory?.getFast(currentAgentKind, providerId, m.id) ?? false;
  };

  // 某 (供应商, 模型) 行当前要展示的 effort(选中 → live;否则注入记忆 → 模型默认)。无 effort 档返回 null。
  // 严格只读 per-(供应商, 模型) 记忆,不再回退到 provider-agnostic 的 newMakerDraft.effortByModel
  // (那份会让会话/草稿、跨供应商互相串,与 fast 的严格口径对齐)。
  const rowEffortOf = (providerId: string | null, m: RowModel): Effort | null => {
    if (!m.efforts || m.efforts.length === 0) return null;
    if (isSelectedRow(providerId, m.id)) {
      return m.efforts.includes(effort) ? effort : (m.defaultEffort ?? m.efforts[0]);
    }
    const pe =
      currentAgentKind && providerId
        ? modelMemory?.getEffort(currentAgentKind, providerId, m.id)
        : undefined;
    const cand = pe ?? m.defaultEffort ?? undefined;
    return cand && m.efforts.includes(cand) ? cand : (m.defaultEffort ?? m.efforts[0] ?? null);
  };

  // 滚动到选中行(打开 / 列表变化时)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: sections / flatModels 作为列表内容变化信号,用于重新对齐选中行。
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      const sel = el.querySelector<HTMLElement>('[data-model-selected="true"]');
      if (sel) {
        const delta = sel.getBoundingClientRect().top - el.getBoundingClientRect().top;
        if (Math.abs(delta) > 1) el.scrollTop = Math.max(0, el.scrollTop + delta);
      }
      flashScrollbar(el);
    });
    return () => cancelAnimationFrame(raf);
  }, [sections, flatModels]);

  // ── 行选择 / Edit 开合 ───────────────────────────────────────────────────
  const handleRowSelect = (providerId: string | null, id: string) => {
    if (isSelectedRow(providerId, id)) {
      onDismiss?.();
      return;
    }
    if (sections && providerId) {
      // 原子切 provider+model+effort(effort 由 handleProviderChange 内 resolveSwitchEffort 从记忆解析)。
      onProviderChange?.(providerId, id);
    } else {
      onModelChange(id);
    }
    onDismiss?.();
  };
  const toggleEdit = (providerId: string | null, id: string) => {
    setEditing((prev) =>
      prev && prev.modelId === id && prev.providerId === providerId
        ? null
        : { providerId, modelId: id },
    );
  };

  // ── Edit 配置列目标 ──────────────────────────────────────────────────────
  const editingModel: RowModel | null = useMemo(() => {
    if (!editing) return null;
    if (sections) {
      const sec = sections.find((s) => s.provider.id === editing.providerId);
      return sec?.models.find((m) => m.id === editing.modelId) ?? null;
    }
    return flatModels?.find((m) => m.id === editing.modelId) ?? null;
  }, [editing, sections, flatModels]);

  const editingIsActive =
    !!editing &&
    editing.modelId === modelId &&
    (editing.providerId === null || editing.providerId === activeSourceId);
  const editShowFast = !!editingModel && fastEditable(editing?.providerId ?? null, editingModel);
  const editHasEfforts = (editingModel?.efforts.length ?? 0) > 0;
  const showConfig = !!editingModel && (editHasEfforts || editShowFast);

  // 配置列当前 effort 值(选中 → live;否则记忆/默认)。
  const editingProviderId = editing?.providerId ?? null;
  const editEffortValue: Effort | null = editingModel
    ? rowEffortOf(editingProviderId, editingModel)
    : null;
  const editFastValue: boolean = editingModel
    ? editingIsActive
      ? fastMode
      : ((currentAgentKind && editingProviderId
          ? modelMemory?.getFast(currentAgentKind, editingProviderId, editingModel.id)
          : undefined) ?? false)
    : false;

  const handleEditEffort = (e: Effort) => {
    if (!editing || !editingModel) return;
    if (editingIsActive) {
      onEffortChange(e);
    } else {
      // 非选中行:只写注入记忆(草稿 / 会话各自那份);不传 modelMemory(flat 选择器)则纯 no-op。
      if (currentAgentKind && editing.providerId) {
        modelMemory?.setEffort(currentAgentKind, editing.providerId, editingModel.id, e);
      }
      bump();
    }
  };
  const handleEditFast = (enabled: boolean) => {
    if (!editing || !editingModel) return;
    if (editingIsActive) {
      // 当前选中模型的 Fast 是会话实时状态,必须等 onFastModeChange 持久化成功后再由
      // ChatInput 同步草稿默认;这里不能预写 modelMemory,否则 device-link 远程失败会污染被控端草稿。
      void onFastModeChange?.(enabled);
    } else {
      // 非选中行:只写 per-(供应商, 模型) 注入记忆(不写 provider-agnostic 的 per-model,避免跨供应商串)。
      if (currentAgentKind && editing.providerId) {
        modelMemory?.setFast(currentAgentKind, editing.providerId, editingModel.id, enabled);
      }
    }
    bump();
  };

  // ── 单个模型行 ───────────────────────────────────────────────────────────
  // provider 非空(分段模式)→ 名字前缀该来源的 mark;null(flat / device-link)→ 无前缀。
  const renderModelItem = (provider: ProviderView | null, model: RowModel) => {
    const providerId = provider?.id ?? null;
    const isSelected = isSelectedRow(providerId, model.id);
    const isBudgetModel = model.id.startsWith('codex/');
    const isSubscriptionModel = provider?.access?.kind === 'subscription';
    const disabled = budgetDisabledOf(model.id);
    const rowEffort = rowEffortOf(providerId, model);
    const rowFastOn = fastOnOf(providerId, model);
    const hasEdit = !disabled && (model.efforts.length > 0 || fastEditable(providerId, model));
    const isEditingThis =
      !!editing && editing.modelId === model.id && editing.providerId === providerId;
    // hover tooltip:最前面拼供应商完整名(分段模式有 provider),再接上下文 / 价格 / 快速。
    const supplierName = provider ? providerDisplayName(provider, t) : null;
    const tipText = disabled
      ? t('newChat.modelSelector.budgetNeedsApiKey')
      : [supplierName, tooltipFor(model.id)].filter(Boolean).join(' · ') || null;
    return (
      <Tip key={`${providerId ?? ''}::${model.id}`} text={tipText} side="left">
        <div
          role="option"
          aria-selected={isSelected}
          aria-disabled={disabled}
          data-model-selected={isSelected ? 'true' : undefined}
          tabIndex={disabled ? -1 : 0}
          onClick={() => {
            if (disabled) return;
            handleRowSelect(providerId, model.id);
          }}
          onKeyDown={(ev) => {
            if (ev.target !== ev.currentTarget || disabled) return;
            if (ev.key !== 'Enter' && ev.key !== ' ') return;
            ev.preventDefault();
            handleRowSelect(providerId, model.id);
          }}
          className={cn(
            'group flex w-full cursor-pointer items-center justify-between rounded-[8px] px-3 py-2',
            'transition-colors hover:bg-[var(--model-item-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            isSelected && 'bg-[var(--model-item-hover)]',
            disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
          )}
        >
          {/* 外层 gap-2.5 = icon→名字间距(略宽,与行左内边距更协调);内层 gap-1.5 = 名字→徽标/effort。 */}
          <span className="flex min-w-0 items-center gap-2.5">
            {provider && (
              <ProviderMark
                providerId={provider.id}
                name={provider.name}
                colorClass="text-[var(--text-secondary)]"
                withMargin={false}
                dense
              />
            )}
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-14 font-medium text-[var(--model-item-text)]">
                {model.displayName}
              </span>
              {isSubscriptionModel && (
                <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--surface-chip)] px-2 py-[1px] text-[11px] font-medium text-[var(--text-secondary)]">
                  {t('settings.providers.models.subscription')}
                </span>
              )}
              {isBudgetModel && (
                <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--model-budget-badge-bg)] px-2 py-[1px] text-[11px] font-medium text-[var(--model-budget-badge-text)]">
                  85% off
                </span>
              )}
              {rowEffort && (
                <span className="shrink-0 text-13 font-normal text-[var(--text-tertiary)]">
                  {effortLabelFor(model, rowEffort)}
                </span>
              )}
              {rowFastOn && (
                <Zap size={13} className="shrink-0 text-[var(--text-tertiary)]" aria-label="Fast" />
              )}
            </span>
          </span>
          {hasEdit && (
            <button
              type="button"
              onClick={(ev) => {
                ev.stopPropagation();
                toggleEdit(providerId, model.id);
              }}
              className={cn(
                'ml-2 shrink-0 rounded-[6px] px-1.5 py-0.5 text-13 font-medium text-[var(--text-secondary)]',
                'transition-opacity hover:bg-[var(--model-item-hover)] focus-visible:opacity-100',
                isEditingThis ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
              )}
            >
              {t('newChat.modelSelector.edit')}
            </button>
          )}
        </div>
      </Tip>
    );
  };

  // 0 个可连来源:整张引导卡取代列表(仅 providers 加载完成后判,避免拉取期闪空态)。
  // device-link 远程会话不显示该引导(控制端无法替被控端连来源)→ 退化为扁平兜底列表。
  const emptyState =
    sourcesEnabled &&
    !deviceId &&
    currentAgentKind &&
    !providersLoading &&
    connected.length === 0 ? (
      <div className="flex flex-col gap-[14px] p-2">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-[var(--model-item-hover)]">
            <Unplug size={16} className="text-[var(--text-secondary)]" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <span className="truncate text-sm font-medium text-[var(--model-item-text)]">
              {t('newChat.modelSelector.source.emptyTitle')}
            </span>
            <span className="text-12 font-normal text-[var(--text-secondary)]">
              {t('newChat.modelSelector.source.emptyDesc')}
            </span>
          </div>
        </div>
        {onNavigateToProviders && (
          <button
            type="button"
            onClick={onNavigateToProviders}
            className={cn(
              'flex h-[34px] w-full items-center justify-center rounded-[8px]',
              'bg-[var(--accent-cta-bg)] transition-opacity hover:opacity-90',
            )}
          >
            <span className="text-13 font-medium text-[var(--accent-pure-cta-fg)]">
              {t('newChat.modelSelector.source.connectCta')}
            </span>
          </button>
        )}
      </div>
    ) : null;

  if (emptyState) return emptyState;

  const hasAnyModel = sections ? sections.length > 0 : (flatModels?.length ?? 0) > 0;

  // ── Edit 配置列(Cursor 左侧面板:Effort 竖排 + Fast Mode)──────────────────
  const configColumn =
    showConfig && editingModel ? (
      <div className="flex w-[196px] shrink-0 flex-col gap-0.5 self-stretch bg-[var(--model-dropdown-bg)] p-2">
        <div className="flex items-center gap-1.5 px-2 py-1.5">
          <SlidersHorizontal size={14} className="shrink-0 text-[var(--text-secondary)]" />
          <span className="min-w-0 truncate text-[13.5px] font-medium text-[var(--model-item-text)]">
            {editingModel.displayName}
          </span>
        </div>
        {editShowFast && (
          <>
            <div className="px-2 py-1.5">
              <span className="text-11 font-medium text-[var(--text-tertiary)]">
                {t('newChat.modelSelector.options')}
              </span>
            </div>
            <div className="px-0.5">
              {/* 遵循设计稿:单色反色(轨/文字 --text-primary,钮 --surface-on-card),不用品牌橙。 */}
              <FastModeToggle
                enabled={editFastValue}
                onToggle={() => handleEditFast(!editFastValue)}
                hideIcon
                accentVar="var(--text-primary)"
                thumbVar="var(--surface-on-card)"
              />
            </div>
          </>
        )}
        {editShowFast && editHasEfforts && (
          <div className="mx-1 my-1 h-px bg-[var(--model-dropdown-border)]" />
        )}
        {editHasEfforts && (
          <>
            <div className="px-2 py-1.5">
              <span className="text-11 font-medium text-[var(--text-tertiary)]">
                {t('newChat.modelSelector.effortLabel')}
              </span>
            </div>
            {editingModel.efforts.map((e) => {
              const selected = editEffortValue === e;
              return (
                <button
                  type="button"
                  key={e}
                  onClick={() => handleEditEffort(e)}
                  role="option"
                  aria-selected={selected}
                  className={cn(
                    'flex w-full items-center justify-between rounded-[8px] px-2 py-2 text-left transition-colors',
                    'hover:bg-[var(--model-item-hover)]',
                    selected && 'bg-[var(--surface-chip)]',
                  )}
                >
                  <span
                    className={cn(
                      'truncate text-[13.5px] text-[var(--model-item-text)]',
                      selected ? 'font-medium' : 'font-normal',
                    )}
                  >
                    {effortLabelFor(editingModel, e)}
                  </span>
                  {selected && (
                    <Check size={15} className="ml-2 shrink-0 text-[var(--model-item-check)]" />
                  )}
                </button>
              );
            })}
          </>
        )}
      </div>
    ) : null;

  // ── 右栏 Pane:固定 320 宽(Edit 配置列开合时列表宽度不抖动)───────────────
  const pane = (
    <div className="flex w-[320px] shrink-0 flex-col gap-1.5 p-2">
      {/* 「跟随会话」行(opt-in,仅 scheduler heartbeat) */}
      {followSession && (
        <>
          <button
            type="button"
            onClick={() => {
              followSession.onFollow();
              onDismiss?.();
            }}
            role="option"
            aria-selected={followSession.active}
            className={cn(
              'flex w-full items-center justify-between rounded-[8px] px-3 py-2 transition-colors',
              'hover:bg-[var(--model-item-hover)]',
              followSession.active && 'bg-[var(--model-item-hover)]',
            )}
          >
            <span className="text-14 font-medium text-[var(--model-item-text)]">
              {followSession.label}
            </span>
            {followSession.active && (
              <Check size={16} className="ml-2 shrink-0 text-[var(--model-item-check)]" />
            )}
          </button>
          <div className="mx-1 h-px bg-[var(--model-dropdown-border)]" />
        </>
      )}
      {/* 搜索框 —— 药丸样式。 */}
      <div className="flex items-center gap-2 rounded-full border border-[var(--model-dropdown-border)] bg-[var(--surface)] px-3 py-[7px]">
        <Search size={16} className="shrink-0 text-[var(--text-tertiary)]" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('newChat.modelSelector.search.placeholderAll')}
          className="min-w-0 flex-1 bg-transparent text-14 text-[var(--model-item-text)] outline-none placeholder:text-[var(--text-tertiary)]"
          aria-label={t('newChat.modelSelector.search.placeholderAll')}
        />
      </div>

      {/* 模型列表 —— 单栏;分段(供应商)或 flat。 */}
      <div
        ref={listRef}
        className="flex max-h-[300px] flex-col gap-0.5 overflow-y-auto"
        role="listbox"
        aria-label="Model list"
      >
        {!hasAnyModel ? (
          <div className="px-3 py-6 text-center text-13 text-[var(--text-tertiary)]">
            {t('newChat.modelSelector.search.noResults')}
          </div>
        ) : sections ? (
          // 平铺:每行带来源 mark 前缀,无分组标题(同供应商行仍因 buildProviderSections 顺序而相邻)。
          sections.flatMap((sec) => sec.models.map((m) => renderModelItem(sec.provider, m)))
        ) : (
          (flatModels ?? []).map((m) => renderModelItem(null, m))
        )}
      </div>

      {/* 「连接来源」footer(供应商入口)—— device-link 远程会话隐藏(无法替被控端连来源)。 */}
      {onNavigateToProviders && !deviceId && (
        <>
          <div className="mx-1 h-px bg-[var(--model-dropdown-border)]" />
          <button
            type="button"
            onClick={onNavigateToProviders}
            className={cn(
              'flex w-full items-center gap-1.5 rounded-[8px] px-3 py-2',
              'transition-colors hover:bg-[var(--model-item-hover)]',
            )}
          >
            <Plus size={14} className="shrink-0 text-[var(--text-tertiary)]" />
            <span className="truncate text-13 font-normal text-[var(--text-tertiary)]">
              {t('newChat.modelSelector.source.connect')}
            </span>
          </button>
        </>
      )}
    </div>
  );

  // 根容器 fit-content:宽度 = 子项之和(pane 320 [+ config 196 + 分隔线 1])。不写死宽度,
  // 避免与真实内容宽度不符触发 floating-ui ResizeObserver 反复重定位(列表抖动)。
  return (
    <div className="flex items-stretch">
      {configColumn}
      {configColumn && <div className="w-px self-stretch bg-[var(--model-dropdown-border)]" />}
      {pane}
    </div>
  );
}

export function ModelSelector({
  modelId,
  effort,
  onModelChange,
  onEffortChange,
  fastMode,
  onFastModeChange,
  modelMemory,
  vendorKey,
  deviceId,
  excludeSubscriptionDirect,
  switching = false,
  disabled = false,
  dense = false,
  triggerVariant = 'toolbar',
  visualVariant = 'default',
  popoverSide = 'top',
  currentProviderId,
  sourceDisconnected = false,
  onProviderChange,
  onNavigateToProviders,
}: ModelSelectorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const agentKind = vendorKeyToAgentKind(vendorKey);
  const cc = useAgentCapabilities('claude-code', deviceId);
  const codex = useAgentCapabilities('codex', deviceId);
  // trigger 的来源 icon / 当前模型也按来源取:device-link 用被控端供应商目录(否则控制端本地
  // 查不到被控端独有模型 → currentModel undefined → label 退成 "Select model")。
  const localProviders = useProviders();
  const remoteProviders = useDeviceProviders(deviceId);
  const providers = deviceId ? remoteProviders.providers : localProviders.providers;
  const visibleModels = useMemo(
    () =>
      selectVisibleModels({
        agentKind,
        deviceId,
        providers,
        deviceCcModels: cc.capabilities?.availableModels ?? [],
        deviceCodexModels: codex.capabilities?.availableModels ?? [],
        excludeSubscriptionDirect,
      }),
    [
      agentKind,
      deviceId,
      providers,
      cc.capabilities,
      codex.capabilities,
      excludeSubscriptionDirect,
    ],
  );

  const currentModel = visibleModels.find((m) => m.id === modelId);
  const displayLabel = currentModel?.displayName ?? 'Select model';
  const efforts = currentModel?.efforts ?? [];

  const currentAgentKind: AgentKind | null = useMemo(() => {
    if (agentKind) return agentKind;
    if (!currentModel) return null;
    if (providers.some((p) => providerOffersModel(p, currentModel.id, 'claude-code'))) {
      return 'claude-code';
    }
    if (providers.some((p) => providerOffersModel(p, currentModel.id, 'codex'))) {
      return 'codex';
    }
    return null;
  }, [currentModel, providers, agentKind]);

  const effortMeta = useMemo(() => {
    const levels =
      currentAgentKind === 'claude-code'
        ? (cc.capabilities?.effortLevels ?? [])
        : currentAgentKind === 'codex'
          ? (codex.capabilities?.effortLevels ?? [])
          : [];
    return new Map(levels.map((e) => [e.id, e.displayName]));
  }, [currentAgentKind, cc.capabilities, codex.capabilities]);
  // 档名多语言(与列表侧 effortLabelFor 同序):i18n 词表 → 模型级覆盖 → capabilities 英文名 → id。
  const labelOf = (e: Effort) => modelEffortLabel(t, currentModel, e, effortMeta.get(e));

  // 「有没有可选来源」走统一判定 hook(与 ChatInput Send 门禁同一条规则)。
  const { hasConnectedSource, loading: providersLoading } = useConnectedSource(currentAgentKind);
  // trigger 左侧的来源 icon —— 取当前生效来源(显式选中且仍可连 → 用它;否则原生默认)。
  const activeSourceId = useMemo<string | null>(() => {
    if (!currentAgentKind) return null;
    const rail = connectedProvidersForAgent(providers, currentAgentKind);
    if (currentProviderId && rail.some((p) => p.id === currentProviderId)) return currentProviderId;
    return nativeDefaultSourceId(rail, currentAgentKind);
  }, [providers, currentAgentKind, currentProviderId]);
  // 空態:当前 agent 一个已连接来源都没有 → trigger 改「连接来源」CTA。
  // device-link 远程会话不走此 CTA(控制端无法替被控端连来源;hasConnectedSource 是本机口径)。
  const noSource =
    !!onProviderChange &&
    !!onNavigateToProviders &&
    !deviceId &&
    !!currentAgentKind &&
    !providersLoading &&
    !hasConnectedSource;
  // trigger 上仍展示当前模型的 effort(模型支持时)。
  const showEffort = efforts.length > 0 && efforts.includes(effort);
  const effortLabel = showEffort ? labelOf(effort) : null;
  // Fast 工具栏按钮已移除 → trigger 上用闪电标出当前是否 Fast(模型支持 + 已开启时)。
  // 支持性按「当前生效来源」现查 per-provider 条目;无法解析来源(flat / device-link 退化)时
  // 回退拍平值,避免误隐藏闪电。
  const triggerActiveProvider = activeSourceId
    ? providers.find((p) => p.id === activeSourceId)
    : undefined;
  const triggerFastSupported =
    triggerActiveProvider && currentAgentKind
      ? modelSupportsFastMode(triggerActiveProvider, modelId, currentAgentKind)
      : !!currentModel?.supportsFastMode;
  const triggerFastOn = fastMode === true && triggerFastSupported;
  // 断开态仅在「非 noSource」时生效:全部来源都断开时 noSource CTA 优先(下拉已无可选行,
  // 跳设置才是正确恢复路径);还有别的已连接来源时,下拉换源就是恢复路径,trigger 保持可点。
  const showSourceDisconnected = !noSource && sourceDisconnected && !!currentProviderId;
  const ariaLabel = noSource
    ? t('newChat.modelSelector.source.connect')
    : showSourceDisconnected
      ? `${t('newChat.modelSelector.source.disconnected')}: ${displayLabel}`
      : effortLabel
        ? `Select model. Current: ${displayLabel}, ${effortLabel} effort`
        : `Select model. Current: ${displayLabel}`;
  const isBudget = modelId.startsWith('codex/');
  const isFieldTrigger = triggerVariant === 'field';
  const isCreateAgentVariant = visualVariant === 'create-agent';
  const budgetGradientStyle: CSSProperties | undefined = isBudget
    ? {
        background: 'var(--model-budget-gradient)',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent',
      }
    : undefined;

  return (
    <Popover open={open && !disabled} onOpenChange={(next) => setOpen(disabled ? false : next)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={switching || disabled}
          className={cn(
            'flex min-w-0 max-w-full items-center gap-1 transition-colors',
            isFieldTrigger
              ? cn(
                  'w-full rounded-lg border border-[var(--border-default)] bg-[var(--settings-input-bg)] px-3',
                  dense ? 'h-9' : 'h-10',
                  'hover:bg-[var(--surface-hover-soft)]',
                )
              : cn(
                  'rounded-full',
                  isCreateAgentVariant
                    ? [
                        'h-[30px] min-w-[128px] max-w-full shrink border border-[var(--create-agent-control-border)]',
                        'bg-[var(--create-agent-control-bg)] px-2 text-[var(--create-agent-control-text)]',
                        'hover:bg-[var(--create-agent-control-bg-hover)] active:bg-[var(--create-agent-control-bg-pressed)]',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--create-agent-focus-ring)]',
                      ]
                    : [
                        'h-[30px] min-w-max shrink-0',
                        noSource
                          ? 'bg-[var(--surface-chip)] px-2.5 hover:bg-[var(--surface-hover)]'
                          : 'bg-[var(--composer-pill-bg,#FCFCFC)] dark:bg-[var(--composer-pill-bg,#393838)] px-2.5 border border-[var(--border-default)] hover:bg-[var(--model-trigger-hover)]' /* spec 2026-07-17, token by 一哥 */,
                      ],
                ),
            // device-link 远程切换 in-flight:置灰 + 禁用点击(复用本文件 disabled 行的 opacity-50 习惯)。
            (switching || disabled) && 'pointer-events-none opacity-50',
          )}
          aria-label={ariaLabel}
        >
          {noSource ? (
            <>
              <PlugZap
                size={isCreateAgentVariant ? 11 : 13}
                className={cn(
                  'mr-0.5 shrink-0',
                  isCreateAgentVariant
                    ? 'text-[var(--create-agent-control-icon)]'
                    : 'text-[var(--text-primary)]',
                )}
              />
              <span
                className={cn(
                  'min-w-0 font-medium',
                  isCreateAgentVariant
                    ? 'text-[var(--create-agent-control-text)]'
                    : 'text-[var(--text-primary)]',
                  isCreateAgentVariant
                    ? 'max-w-[180px] truncate'
                    : cn('truncate', isFieldTrigger ? 'max-w-[260px]' : 'max-w-[160px]'),
                  isCreateAgentVariant ? 'text-[12px]' : dense ? 'text-[12.5px]' : 'text-[13px]',
                )}
              >
                {t('newChat.modelSelector.source.connect')}
              </span>
            </>
          ) : showSourceDisconnected && currentProviderId ? (
            // 选中来源已断开:显示**真实来源**(currentProviderId)而非 activeSourceId 的默认回落
            // ——回落图标会让用户以为在用默认来源,而发送实际按 DB 里的断开来源走(no_oauth 事故)。
            // 错误态用语义豁免 error token(规则 16);trigger 保持可点击,下拉换源即恢复。
            <>
              <ModelBrandMark
                modelId={modelId}
                agentKind={currentAgentKind}
                fallbackProviderId={currentProviderId}
                fallbackProviderName={providers.find((p) => p.id === currentProviderId)?.name}
                colorClass="text-[var(--error-fg)]"
              />
              <span
                className={cn(
                  'min-w-0 font-normal text-[var(--text-primary)]',
                  isCreateAgentVariant ? 'max-w-[180px] truncate' : isFieldTrigger ? 'max-w-[260px] truncate' : 'whitespace-nowrap',
                  isCreateAgentVariant ? 'text-[12px]' : dense ? 'text-[12.5px]' : 'text-[13px]',
                )}
              >
                {/* 断开来源可能是该模型的唯一提供方 → visibleModels 查不到,回落显示原始 id,
                    比 "Select model" 占位更能说明「哪个模型的来源断了」。 */}
                {currentModel?.displayName ?? modelId}
              </span>
              <Unplug
                size={dense ? 11 : 12}
                className="ml-0.5 shrink-0 text-[var(--error-fg)]"
                aria-hidden
              />
              <span
                className={cn(
                  'shrink-0 font-medium text-[var(--error-fg)]',
                  dense ? 'text-[11.5px]' : 'text-[12px]',
                )}
              >
                {t('newChat.modelSelector.source.disconnected')}
              </span>
            </>
          ) : (
            <>
              {activeSourceId && (
                <ModelBrandMark
                  modelId={modelId}
                  agentKind={currentAgentKind}
                  fallbackProviderId={activeSourceId}
                  fallbackProviderName={providers.find((p) => p.id === activeSourceId)?.name}
                  colorClass={
                    isCreateAgentVariant ? 'text-[var(--create-agent-control-icon)]' : undefined
                  }
                />
              )}
              <span
                className={cn(
                  'min-w-0 font-normal',
                  isCreateAgentVariant
                    ? 'max-w-[180px] truncate'
                    : isFieldTrigger ? 'max-w-[260px] truncate' : 'whitespace-nowrap',
                  !isBudget &&
                    (isCreateAgentVariant
                      ? 'text-[var(--create-agent-control-text)]'
                      : 'text-[var(--model-trigger-text)]'),
                  isCreateAgentVariant ? 'text-[12px]' : dense ? 'text-[12.5px]' : 'text-[13px]',
                )}
                style={budgetGradientStyle}
              >
                {displayLabel}
              </span>
              {effortLabel && (
                <>
                  <span
                    className={cn(
                      'font-normal',
                      isCreateAgentVariant
                        ? 'text-[var(--create-agent-control-text)]'
                        : 'text-[var(--model-trigger-meta)]',
                      isCreateAgentVariant
                        ? 'text-[12px]'
                        : dense
                          ? 'text-[12.5px]'
                          : 'text-[13px]',
                    )}
                    aria-hidden="true"
                  >
                    ·
                  </span>
                  <span
                    className={cn(
                      'min-w-0 font-normal',
                      isCreateAgentVariant
                        ? 'text-[var(--create-agent-control-text)]'
                        : 'text-[var(--model-trigger-text)]',
                      isCreateAgentVariant
                        ? 'max-w-[48px] truncate'
                        : isFieldTrigger ? 'max-w-[120px] truncate' : 'whitespace-nowrap',
                      isCreateAgentVariant
                        ? 'text-[12px]'
                        : dense
                          ? 'text-[12.5px]'
                          : 'text-[13px]',
                    )}
                  >
                    {effortLabel}
                  </span>
                </>
              )}
              {triggerFastOn && (
                <Zap
                  size={isCreateAgentVariant ? 11 : dense ? 12 : 13}
                  className={cn(
                    'ml-0.5 shrink-0',
                    isCreateAgentVariant
                      ? 'text-[var(--create-agent-control-icon)]'
                      : 'text-[var(--model-trigger-text)]',
                  )}
                  aria-label="Fast"
                />
              )}
            </>
          )}
          <ChevronDown
            size={isCreateAgentVariant ? 8 : dense ? 13 : 14}
            className={cn(
              'shrink-0',
              isCreateAgentVariant
                ? 'text-[var(--create-agent-control-icon)]'
                : 'text-[var(--model-trigger-arrow)]',
              isFieldTrigger && 'ml-auto',
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={popoverSide}
        align="end"
        sideOffset={4}
        collisionPadding={8}
        className={cn(
          // 宽度由内容决定(单栏 320;Edit 展开 ~516,向左加宽)。
          'w-auto overflow-hidden rounded-[12px] p-0',
          'bg-[var(--model-dropdown-bg)]',
          'border border-[var(--model-dropdown-border)]',
        )}
      >
        <ModelSelectorContent
          modelId={modelId}
          effort={effort}
          onModelChange={onModelChange}
          onEffortChange={onEffortChange}
          fastMode={fastMode}
          onFastModeChange={onFastModeChange}
          modelMemory={modelMemory}
          vendorKey={vendorKey}
          deviceId={deviceId}
          excludeSubscriptionDirect={excludeSubscriptionDirect}
          onDismiss={() => setOpen(false)}
          currentProviderId={currentProviderId}
          onProviderChange={onProviderChange}
          onNavigateToProviders={onNavigateToProviders}
        />
      </PopoverContent>
    </Popover>
  );
}
