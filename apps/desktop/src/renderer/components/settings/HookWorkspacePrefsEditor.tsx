/**
 * HookWorkspacePrefsEditor —— 工作目录卡片内嵌的会话偏好编辑行。
 *
 * 由 HookConnectionsSection 在每个目录卡片下渲染(用户反馈: 偏好属于目录
 * 条目本身, 不该是独立区块): agent / 模型 / 思考强度 / 权限模式四个下拉。
 *
 * 未显式设置的字段**解析出当前真正会生效的默认值**直接展示, 界面上不暴露
 * 「默认」概念(无后缀 / 无弱化色 / 无「恢复默认」菜单项 —— 用户反馈: 不要
 * 有 xxx(默认)这种); 选中任一项即写显式偏好。解析链与 main 侧 defaults.ts
 * 逐字段对齐(resolveEffectiveRow, 纯函数有单测), 数据源是
 * imDefaultSettingsGet(桌面新会话默认)+ 本机 capabilities; 权限默认恒
 * bypassPermissions(完全访问)。
 *
 * 模型显示名带分组区分: 骨折版(group='gpt-budget')与官方版 displayName
 * 故意同名, 下拉里给骨折版加「(骨折GPT)」后缀(复用桌面模型选择器的分组
 * 文案), 否则出现两个一模一样的 GPT-5.5(线上实撞)。
 *
 * 数据正本在 slack-hook-server 的 user_prefs 表 —— 与 Slack /model 卡是
 * **同一份数据**: useHookWorkspacePrefs 经 hookControl.getWorkspacePrefs /
 * setWorkspacePrefs 走 WS 往返读写, /model 卡的改动经 onPrefsChanged 推送
 * 实时同步。**可选模型清单与会话内模型选择器同一套规则**(visibleModelUnion:
 * live providers -> 已连接供应商 -> 用户可见性开关过滤), 与 Slack /model 卡
 * 的清单(main 侧同函数派生后经 query.response 上报)逐模型一致; effort /
 * 权限档等元数据仍取本机 capabilities; 联动校准逻辑在 hookWorkspacePrefsLogic.ts。
 *
 * 状态模型(禁用整体置灰而非增删行, 规则 7):
 *   - 连接未就绪 -> 禁用(提示行由宿主渲染一次, 不逐卡重复)
 *   - 已连接但未绑定 -> 禁用 + 「先完成绑定」
 *   - HOOK_PREFS_TIMEOUT -> 禁用 + 「服务器版本过旧」+ 重试
 * 偏好值不在本机能力清单时显示裸 id(派发侧 defaults 已兜底)。
 * 颜色一律走主题 token(规则 16)。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';

import { visibleModelUnion, type AgentKind, type CatalogModel } from '@cindy/model-providers';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { useAgentCapabilities, type AgentCapabilities } from '@/hooks/useAgentCapabilities';
import { useProviders } from '@/hooks/useProviders';
import { isModelEnabled, useModelVisibilityVersion } from '@/state/modelVisibilityPrefs';
import type {
  HookPrefsPatch,
  HookPrefsView,
  HookWorkspacePrefs,
  SlackHookView,
} from '../../../shared/hookControlIpc';
import type { ImDefaultSettingsState } from '../../../shared/imDefaultSettings';
import {
  patchForAgentChange,
  patchForModelChange,
  resolveEffectiveRow,
  type ImDefaultsLike,
  type PrefsAgentCaps,
} from './hookWorkspacePrefsLogic';

const AGENT_KINDS = ['claude-code', 'codex'] as const;
type KnownAgent = (typeof AGENT_KINDS)[number];

/** 全 null 的缺省偏好行(该目录从未设置过)。 */
function emptyPrefs(workspace: string): HookWorkspacePrefs {
  return { workspace, model: null, effort: null, agentKind: null, permissionMode: null };
}

function toPrefsCaps(caps: AgentCapabilities | null): PrefsAgentCaps | null {
  if (caps === null) return null;
  return {
    models: caps.availableModels.map((m) => ({
      id: m.id,
      efforts: m.efforts,
      defaultEffort: m.defaultEffort,
    })),
    permissionModes: caps.permissionModes.map((pm) => ({ id: pm.id })),
  };
}

export interface HookWorkspacePrefsState {
  /** 按别名查该目录偏好(无行返回全 null 缺省; multi-team 下按选中 team 过滤)。 */
  prefsFor: (alias: string) => HookWorkspacePrefs;
  /** 是否可编辑(已连接 + 已绑定 + 快照可用)。 */
  editable: boolean;
  /** 写入在途的目录别名(该卡片下拉禁用)。 */
  pendingWs: string | null;
  /** 不可编辑的原因提示(null = 无需提示); 宿主渲染一次。 */
  hint: string | null;
  /** hint 为「服务器过旧」时提供的重试入口(其余为 null)。 */
  retry: (() => void) | null;
  /** 桌面新会话默认设置(解析「当前生效默认值」的数据源; 未就绪为 null)。 */
  imDefaults: ImDefaultsLike | null;
  applyPatch: (workspace: string, patch: HookPrefsPatch) => void;
  /** (multi-team)可用绑定清单(未 displaced); 单绑定/老 server 时 ≤1 条。 */
  teams: Array<{ teamId: string; teamName: string | null }>;
  /** 当前偏好归属 team(teams 非空时必有值; 选中项失效自动回落首个)。 */
  selectedTeamId: string | null;
  selectTeam: (teamId: string) => void;
  /** 是否显示 team 切换 chip(server multi-team 且 ≥2 个可用绑定)。 */
  showTeamChip: boolean;
}

/**
 * 目录偏好共享状态(单订阅): 拉取/写入/推送同步 + 禁用态归纳。
 * hook 传 null 时(数据未就绪)一切禁用无提示。
 */
export function useHookWorkspacePrefs(hook: SlackHookView | null): HookWorkspacePrefsState {
  const { t } = useTranslation();
  const [prefsView, setPrefsView] = useState<HookPrefsView | null>(null);
  /** 'unavailable' = 快照读不到(server 太旧 / 通道缺失 / 内部错), 提示 + 重试。 */
  const [loadError, setLoadError] = useState<'unavailable' | null>(null);
  const [pendingWs, setPendingWs] = useState<string | null>(null);
  const [imDefaults, setImDefaults] = useState<ImDefaultsLike | null>(null);
  const lastStatusRef = useRef<SlackHookView['status'] | null>(null);

  const fetchPrefs = useCallback(async () => {
    try {
      const res = await window.electronAPI.hookControl.getWorkspacePrefs();
      setPrefsView(res.prefs);
      setLoadError(null);
    } catch (err) {
      const code = extractIpcError(err)?.code;
      // HOOK_NOT_CONNECTED 静默(连接态提示由 requireConnected 分支呈现);
      // 其余一律进 unavailable —— 绝不让下拉无解释地死着(超时 = server 太旧,
      // 通道不存在 = 桌面端 main 未重启到新版, 都给同一句提示 + 重试)
      if (code !== 'HOOK_NOT_CONNECTED') setLoadError('unavailable');
    }
  }, []);

  useEffect(() => {
    const offPrefs = window.electronAPI.hookControl.onPrefsChanged((view) => {
      // /model 卡改动 / 其它窗口写入的实时同步(全量快照 latest-wins)
      setPrefsView(view);
      setLoadError(null);
    });
    void fetchPrefs();
    // 桌面新会话默认设置: 未显式设置字段的生效值解析源, 面板打开时取一次即可
    void window.electronAPI.maker
      .imDefaultSettingsGet()
      .then((state: ImDefaultSettingsState) =>
        setImDefaults({ agentKind: state.agentKind, agents: state.agents }),
      )
      .catch(() => {});
    return offPrefs;
  }, [fetchPrefs]);

  // 断线 -> 重连成功: 自动重拉快照(掉线期间 Slack 侧可能改过)
  const status = hook?.status ?? null;
  useEffect(() => {
    if (status === 'connected' && lastStatusRef.current !== 'connected') void fetchPrefs();
    lastStatusRef.current = status;
  }, [status, fetchPrefs]);

  // (multi-team)偏好归属 team: 可选清单 = 未 displaced 的绑定; 选中项失效
  // (解绑/被顶)时自动回落首个, 不留悬空选择
  const multiTeam = hook?.serverMultiTeam === true;
  const teams = useMemo(
    () =>
      (hook?.bindings ?? [])
        .filter((b) => !b.displaced)
        .map((b) => ({ teamId: b.teamId, teamName: b.teamName })),
    [hook],
  );
  const [selectedTeamRaw, setSelectedTeamRaw] = useState<string | null>(null);
  const selectedTeamId = teams.some((tm) => tm.teamId === selectedTeamRaw)
    ? selectedTeamRaw
    : (teams[0]?.teamId ?? null);

  const prefsFor = useCallback(
    (alias: string): HookWorkspacePrefs => {
      const entries = prefsView?.prefs ?? [];
      if (multiTeam && selectedTeamId !== null) {
        // 精确 team 匹配优先; 老 server 存量行(无 teamId)宽松兜底
        return (
          entries.find((e) => e.workspace === alias && (e.teamId ?? null) === selectedTeamId) ??
          entries.find((e) => e.workspace === alias && (e.teamId ?? null) === null) ??
          emptyPrefs(alias)
        );
      }
      return entries.find((e) => e.workspace === alias) ?? emptyPrefs(alias);
    },
    [prefsView, multiTeam, selectedTeamId],
  );

  const applyPatch = useCallback(
    (workspace: string, patch: HookPrefsPatch) => {
      setPendingWs(workspace);
      void window.electronAPI.hookControl
        // multi-team 下写偏好必须带归属 team(server 拒绝猜测); 单绑定/老
        // server 缺省, 帧面与既有行为一致
        .setWorkspacePrefs(workspace, patch, multiTeam ? selectedTeamId : undefined)
        .then((res) => {
          setPrefsView(res.prefs);
          setLoadError(null);
        })
        .catch((err: unknown) => {
          const ipcErr = extractIpcError(err);
          if (ipcErr?.code === 'HOOK_PREFS_TIMEOUT') setLoadError('unavailable');
          toast.error(ipcErr?.message ?? t('settings.tina.prefs.toast.saveFailed'));
          void fetchPrefs();
        })
        .finally(() => setPendingWs(null));
    },
    [fetchPrefs, t, multiTeam, selectedTeamId],
  );

  const connected = hook?.enabled === true && hook.status === 'connected';
  const bound = prefsView?.bound === true;
  const hint = !connected
    ? t('settings.tina.prefs.requireConnected')
    : loadError === 'unavailable'
      ? t('settings.tina.prefs.serverUnsupported')
      : prefsView !== null && !bound
        ? t('settings.tina.prefs.requireBinding')
        : null;

  return {
    prefsFor,
    editable: connected && bound && loadError === null,
    pendingWs,
    hint,
    retry: loadError === 'unavailable' ? () => void fetchPrefs() : null,
    imDefaults,
    applyPatch,
    teams,
    selectedTeamId,
    selectTeam: setSelectedTeamRaw,
    showTeamChip: multiTeam && teams.length > 1,
  };
}

/**
 * 单个下拉。triggerLabel 恒显示当前生效值 —— 未显式设置时就是解析出的
 * 桌面默认值, 界面上不区分「默认/自选」(用户要求不暴露默认概念);
 * 选中任一项即写显式偏好。
 */
function PrefsSelect({
  label,
  triggerLabel,
  options,
  disabled,
  onPick,
}: {
  label: string;
  triggerLabel: string;
  options: Array<{ id: string; label: string }>;
  disabled: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-11 text-[var(--text-tertiary)]">{label}</span>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          className="flex items-center justify-between gap-1 rounded-lg border border-[var(--border-default)] bg-transparent px-2 py-1.5 text-12 text-[var(--settings-input-text)] outline-none disabled:opacity-50"
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-[var(--text-tertiary)]" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {options.map((opt) => (
            <DropdownMenuItem key={opt.id} onClick={() => onPick(opt.id)}>
              {opt.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </label>
  );
}

/** 目录卡片内的偏好编辑行(四下拉)。alias 为该行当前生效别名。 */
export function WorkspacePrefsEditor({
  alias,
  state,
}: {
  alias: string;
  state: HookWorkspacePrefsState;
}) {
  const { t } = useTranslation();
  const claudeCaps = useAgentCapabilities('claude-code');
  const codexCaps = useAgentCapabilities('codex');
  const capsByAgent = useMemo(
    () =>
      ({
        'claude-code': claudeCaps.capabilities,
        codex: codexCaps.capabilities,
      }) as Record<KnownAgent, AgentCapabilities | null>,
    [claudeCaps.capabilities, codexCaps.capabilities],
  );
  const capsOf = useCallback(
    (agentKind: string): AgentCapabilities | null =>
      AGENT_KINDS.includes(agentKind as KnownAgent) ? capsByAgent[agentKind as KnownAgent] : null,
    [capsByAgent],
  );

  const prefs = state.prefsFor(alias);
  const eff = resolveEffectiveRow(prefs, state.imDefaults, (k) => toPrefsCaps(capsOf(k)));
  const effAgentCaps = capsOf(eff.agentKind.id ?? '');
  const disabled = !state.editable || state.pendingWs === alias;

  // 可选模型清单: 与会话内模型选择器**同一套规则**(live providers -> 已连接
  // 供应商 -> 用户可见性开关过滤, 拍平 first-wins 去重)。visVersion 让用户在
  // 「设置 -> 模型供应商」开关模型后本下拉实时重算。
  const { providers } = useProviders();
  const visVersion = useModelVisibilityVersion();
  const visibleModels = useMemo((): CatalogModel[] => {
    void visVersion; // 仅作重算依赖
    const agent = eff.agentKind.id;
    if (agent === null || !AGENT_KINDS.includes(agent as KnownAgent)) return [];
    return visibleModelUnion(providers, agent as AgentKind, (providerId, m) =>
      isModelEnabled(agent as AgentKind, providerId, m),
    );
  }, [providers, eff.agentKind.id, visVersion]);

  // effort 选项的元数据: 优先 capabilities(生效模型可能被用户隐藏, 不在
  // visibleModels 里), 自定义供应商独有模型再回落 union 条目。
  const entry =
    eff.model.id !== null
      ? (effAgentCaps?.availableModels.find((m) => m.id === eff.model.id) ??
        visibleModels.find((m) => m.id === eff.model.id) ??
        null)
      : null;

  /** 模型显示名(骨折版加分组后缀区分同名官方版); 不在清单显示裸 id。 */
  const modelLabel = useCallback(
    (id: string | null): string => {
      if (id === null) return t('settings.tina.prefs.none');
      const u = visibleModels.find((x) => x.id === id);
      const c =
        u === undefined ? effAgentCaps?.availableModels.find((x) => x.id === id) : undefined;
      const name = u?.name ?? c?.displayName;
      if (name === undefined) return id;
      const group = u?.group ?? c?.group;
      return group === 'gpt-budget'
        ? `${name}(${t('newChat.modelSelector.category.budget')})`
        : name;
    },
    [visibleModels, effAgentCaps, t],
  );
  const permLabel = useCallback(
    (id: string | null): string => {
      if (id === null) return t('settings.tina.prefs.none');
      return effAgentCaps?.permissionModes.find((pm) => pm.id === id)?.displayName ?? id;
    },
    [effAgentCaps, t],
  );
  return (
    <div className="flex flex-wrap gap-2">
      <PrefsSelect
        label={t('settings.tina.prefs.agentLabel')}
        triggerLabel={eff.agentKind.id ?? ''}
        options={AGENT_KINDS.map((k) => ({ id: k, label: k }))}
        disabled={disabled}
        onPick={(next) => {
          if (next === prefs.agentKind) return;
          state.applyPatch(alias, patchForAgentChange(next, prefs, toPrefsCaps(capsOf(next))));
        }}
      />
      <PrefsSelect
        label={t('settings.tina.prefs.modelLabel')}
        triggerLabel={modelLabel(eff.model.id)}
        options={visibleModels.map((m) => ({ id: m.id, label: modelLabel(m.id) }))}
        // 能力清单未就绪才禁用; agent 未显式设置时也可直接选模型(随手把
        // agent 显式配对写入, 与 Slack 卡「选中模型即落 (agent, model)」同规则)
        disabled={disabled || effAgentCaps === null || eff.agentKind.id === null}
        onPick={(next) => {
          if (next === prefs.model || eff.agentKind.id === null) return;
          state.applyPatch(
            alias,
            patchForModelChange(eff.agentKind.id, next, prefs, toPrefsCaps(effAgentCaps)),
          );
        }}
      />
      <PrefsSelect
        label={t('settings.tina.prefs.effortLabel')}
        triggerLabel={eff.effort.id ?? t('settings.tina.prefs.none')}
        options={(entry?.efforts ?? []).map((e) => ({ id: e, label: e }))}
        disabled={disabled || entry === null || entry.efforts.length === 0}
        onPick={(next) => {
          if (next !== prefs.effort) state.applyPatch(alias, { effort: next });
        }}
      />
      <PrefsSelect
        label={t('settings.tina.prefs.permissionLabel')}
        triggerLabel={permLabel(eff.permissionMode.id)}
        options={(effAgentCaps?.permissionModes ?? []).map((pm) => ({
          id: pm.id,
          label: pm.displayName,
        }))}
        disabled={disabled || effAgentCaps === null}
        onPick={(next) => {
          if (next !== prefs.permissionMode) state.applyPatch(alias, { permissionMode: next });
        }}
      />
    </div>
  );
}
