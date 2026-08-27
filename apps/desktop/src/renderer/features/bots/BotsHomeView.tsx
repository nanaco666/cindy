import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  BookMarked,
  Blocks,
  Bot,
  Check,
  ChevronRight,
  Download,
  FolderGit2,
  MessageCircle,
  MessageCircleMore,
  Pencil,
  PlugZap,
  RefreshCcw,
  Users,
  UserRound,
} from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BotPronounProvider, useBotTranslation } from './botPronounContext';

import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import * as sessionService from '@/lib/sessionService';
import { ModelSelector } from '@/components/new-chat/ModelSelector';
import { VendorSegmentedSwitcher } from '@/components/new-chat/VendorSegmentedSwitcher';
import { useAvailableAgents } from '@/hooks/useAvailableAgents';
import { getDraft } from '@/state/newMakerDraft';
import type { MakerVendor } from '@/lib/ccAgent.types';
import type { ConversationSearchJump } from '../../../shared/conversationSearchJump';
import { cn } from '@/lib/utils';
import { useRegisterContentHeader } from '../feature-context';
import {
  applyBotImMigration,
  listBotChannelConnections,
  listBotImMigrations,
  planBotImMigration,
  rollbackBotImMigration,
  canonicalBotSessionId,
  setCanonicalBotSession,
  updateBotProfile,
  upsertBotChannel,
  useBotProfiles,
  defaultBotModel,
  exportBotBundle,
  importBotBundle,
  type BotCapabilities,
  type BotChannel,
  type BotChannelConnection,
  type BotImMigrationPlan,
  type BotImMigrationRecord,
  type BotProfile,
} from './botStore';
import { BotRosterView } from './BotRosterView';
import { BotAvatar } from './BotAvatar';
import { BotProfileDialog } from './BotProfileDialog';
import { BotCapabilitySettings } from './BotCapabilitySettings';
import { BotProjectSettings } from './BotProjectSettings';
import {
  createBotCanonicalSessionWithRetry,
  shouldDeferCanonicalBotSessionNavigation,
  withBotCanonicalSessionReadTimeout,
} from './botNavigation';
import { BotRouteSettings } from './BotRouteSettings';
import { BotLifecycleSettings } from './BotLifecycleSettings';
import { BotEventInboxSettings } from './BotEventInboxSettings';
import { BotAbilityWall } from './BotAbilityWall';
import { BotFolderCards } from './BotFolderCards';
import { BotGrowthLists } from './BotGrowthLists';
import { BotSettingsBlock } from './BotSettingsBlock';
import { botTemplateForName, botTemplateSeedEntries } from './botTemplates';
import { BotPersonaWizard, personaSummaryText } from './BotPersonaWizard';
import { extractPersonaFromIdentitySource, readBotBackground } from './botPersona';
import { rememberPendingBotPersonaAck } from './botPersonaAck';
import { resolveBotSettingsHighlight, type BotSettingsHighlightId } from './botSettingsNav';
import type { BotSettingsPayload } from './botSettingsAutosave';
import { useBotSettingsAutosave } from './useBotSettingsAutosave';

/** 成长尾注跳转后的高亮停留时长。 */
const BOT_SETTINGS_HIGHLIGHT_MS = 2400;

const BOT_DETAIL_TABS = [
  { id: 'connections', labelKey: 'bots.settingsTabs.connections', icon: Blocks },
  { id: 'growth', labelKey: 'bots.settingsTabs.growth', icon: BookMarked },
  { id: 'model', labelKey: 'bots.settingsTabs.model', icon: PlugZap },
  { id: 'project', labelKey: 'bots.settingsTabs.project', icon: FolderGit2 },
  { id: 'maintenance', labelKey: 'bots.settingsTabs.maintenance', icon: RefreshCcw },
] as const;

type BotDetailTabId = (typeof BOT_DETAIL_TABS)[number]['id'];

function parseBotDetailTab(value: string | null): BotDetailTabId {
  if (BOT_DETAIL_TABS.some((tab) => tab.id === value)) return value as BotDetailTabId;
  if (value === 'identity' || value === 'who' || value === 'capabilities') return 'connections';
  if (value === 'channels' || value === 'can') return 'connections';
  if (value === 'projects' || value === 'understand') return 'project';
  if (value === 'grew' || value === 'knowledge' || value === 'advanced') return 'growth';
  if (
    value === 'automation' ||
    value === 'notifications' ||
    value === 'schedule' ||
    value === 'runtime'
  ) {
    return 'maintenance';
  }
  return 'connections';
}

function channelLabel(channel: BotChannel): string {
  return channel === 'local' ? 'Local Bot' : channel[0].toUpperCase() + channel.slice(1);
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * 「今天加入 / 3 天前加入」。
 *
 * 口语相对时长，不是「加入 N 天」——这一行是给「TA 跟了我多久」一个人类回答，不是
 * 一个计数。档位与 `bots.artifacts.time.*` 同一口径（刚刚 / N 天前 / …），只是这里
 * 最细到天：一个伙伴是几分钟前加入的没有意义。拿不到 createdAt 就不显示，不编。
 */
export function botJoinedRelativeKey(
  createdAt: number,
  now: number,
): { key: string; n: number } | null {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return null;
  const days = Math.floor((now - createdAt) / DAY_MS);
  if (days <= 0) return { key: 'bots.joined.today', n: 0 };
  if (days === 1) return { key: 'bots.joined.yesterday', n: 1 };
  if (days < 30) return { key: 'bots.joined.days', n: days };
  const months = Math.floor(days / 30);
  if (months < 12) return { key: 'bots.joined.months', n: months };
  return { key: 'bots.joined.years', n: Math.floor(days / 365) };
}

/** Exported for unit tests covering the settings nav / deep-link / tab-grouping behavior. */
export function BotSettings({
  bot,
  onBack,
  onRenew,
  onOpenSession,
}: {
  bot: BotProfile;
  onBack: () => void;
  onRenew: () => Promise<boolean>;
  onOpenSession: (sessionId: string, searchJump?: ConversationSearchJump) => void;
}) {
  const { t } = useBotTranslation();
  const navigate = useNavigate();
  const [settingsSearchParams] = useSearchParams();
  // 成长尾注深链会短暂指出发生变化的列表。
  const requestedHighlight = useMemo(
    () => resolveBotSettingsHighlight(settingsSearchParams.get('highlight')),
    [settingsSearchParams],
  );
  const [highlight, setHighlight] = useState<BotSettingsHighlightId | null>(requestedHighlight);
  useEffect(() => {
    setHighlight(requestedHighlight);
    if (!requestedHighlight) return;
    const timer = window.setTimeout(() => setHighlight(null), BOT_SETTINGS_HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [requestedHighlight]);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [personaOpen, setPersonaOpen] = useState(false);
  /**
   * 「刚存完性格，等着回对话」的标记。值用时间戳而不是 boolean：连着调两次性格
   * 也各自能触发一次导航（boolean 会因为值没变而不重跑 effect）。
   */
  const [personaSavedAt, setPersonaSavedAt] = useState<number | null>(null);
  const [name, setName] = useState(bot.name);
  const [description, setDescription] = useState(bot.description);
  const [identitySource, setIdentitySource] = useState(bot.identitySource ?? '');
  const [userContextSource, setUserContextSource] = useState(bot.userContextSource ?? '');
  const [avatar, setAvatar] = useState(bot.avatar);
  const [avatarColor, setAvatarColor] = useState(bot.avatarColor);
  const [selectedSkills, setSelectedSkills] = useState<string[]>(bot.skills);
  const [capabilities, setCapabilities] = useState<BotCapabilities>(bot.capabilities);
  const [channelBusy, setChannelBusy] = useState<string | null>(null);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [channelConnections, setChannelConnections] = useState<BotChannelConnection[]>([]);
  const [migrationPlan, setMigrationPlan] = useState<BotImMigrationPlan | null>(null);
  const [migrationRecords, setMigrationRecords] = useState<BotImMigrationRecord[]>([]);
  const [rollbackRecord, setRollbackRecord] = useState<BotImMigrationRecord | null>(null);
  const [portabilityBusy, setPortabilityBusy] = useState(false);
  const [portabilityNotice, setPortabilityNotice] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<BotDetailTabId>(() =>
    parseBotDetailTab(settingsSearchParams.get('tab') ?? settingsSearchParams.get('anchor')),
  );
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const { availableVendors, loaded: availableAgentsLoaded } = useAvailableAgents();
  const selectedProject = bot.projectBindings?.find((binding) => binding.isDefault);
  const sshRemote = Boolean(selectedProject?.remoteHostId);
  const vendor: MakerVendor = capabilities.harness === 'claude' ? 'cc' : capabilities.harness;
  const hiddenVendors = useMemo<MakerVendor[]>(() => {
    if (!availableAgentsLoaded) return [];
    return (['cc', 'codex', 'pi'] as const).filter((item) => !availableVendors.has(item));
  }, [availableAgentsLoaded, availableVendors]);
  const canonicalProjection = bot.sessions.find((item) => item.kind === 'chat');
  // 只在切到另一个 Bot 时重灌表单。自动保存下 `bot` 每次落库(以及失败回滚)都会
  // 换一个新对象,若仍按对象身份重灌,用户在提交在途期间敲的字会被服务端快照盖掉,
  // 失败回滚时更会把刚改的内容整批还原 —— 那是比「忘记点保存」更严重的丢字。
  // 页面挂载期间本地 state 才是编辑权威;`bot.channels` / `bot.sessions` 等非表单
  // 字段仍直接读 prop,保持实时。
  const botIdentityRef = useRef(bot.id);
  useEffect(() => {
    if (botIdentityRef.current === bot.id) return;
    botIdentityRef.current = bot.id;
    setName(bot.name);
    setDescription(bot.description);
    setIdentitySource(bot.identitySource ?? '');
    setUserContextSource(bot.userContextSource ?? '');
    setAvatar(bot.avatar);
    setAvatarColor(bot.avatarColor);
    setSelectedSkills(bot.skills);
    setCapabilities(bot.capabilities);
  }, [bot]);

  useEffect(() => {
    setActiveTab(
      parseBotDetailTab(settingsSearchParams.get('tab') ?? settingsSearchParams.get('anchor')),
    );
    contentRef.current?.scrollTo({ top: 0 });
  }, [settingsSearchParams]);

  // identitySource 是权威；这里仅投影掉向导 marker 后的背景正文。
  const background = readBotBackground(identitySource);

  /*
    这个伙伴**本该**自带的开场笔记。只用于「加入那次没写进去」时的补写入口 ——
    Profile 不存模板 id,所以按显示名反查(与阵容页判断「已加入」同一口径);查不到
    就是空,记忆区不显示补写入口。AI 生成出来的伙伴不在此列:它那几条笔记是一次性
    的草稿产物,创建之后已经无从复原,不能凭空造几条顶上。
  */
  const templateSeedEntries = useMemo(() => {
    const template = botTemplateForName(bot.name, t);
    return template ? botTemplateSeedEntries(template, t) : [];
  }, [bot.name, t]);

  useEffect(() => {
    let cancelled = false;
    void listBotChannelConnections()
      .then((rows) => {
        if (!cancelled) setChannelConnections(rows.filter((row) => row.accountKey));
      })
      .catch(() => {
        if (!cancelled) setChannelError(t('bots.migration.errors.load'));
      });
    return () => {
      cancelled = true;
    };
  }, [bot.id, t]);

  useEffect(() => {
    let cancelled = false;
    void listBotImMigrations(bot.id)
      .then((rows) => {
        if (!cancelled) setMigrationRecords(rows);
      })
      .catch(() => {
        if (!cancelled) setChannelError(t('bots.migration.errors.load'));
      });
    return () => {
      cancelled = true;
    };
  }, [bot.id, t]);

  const commitProfile = useCallback(
    async (payload: BotSettingsPayload) => {
      await updateBotProfile(bot.id, payload);
    },
    [bot.id],
  );

  const autosave = useBotSettingsAutosave({
    draft: {
      name,
      description,
      identitySource,
      userContextSource,
      avatar,
      avatarColor,
      capabilities,
      skills: selectedSkills,
    },
    fallbackName: bot.name,
    // 归档 bot 的设置页是只读的(不渲染任何表单字段),自动保存不得为它引入写入。
    enabled: bot.status !== 'archived',
    commit: commitProfile,
  });

  const updateCapability = <K extends keyof BotCapabilities>(key: K, value: BotCapabilities[K]) => {
    setCapabilities((current) => ({
      ...current,
      [key]: value,
      ...(key === 'fastMode' && current.modelOverride
        ? { modelOverride: { ...current.modelOverride, fastMode: value === true } }
        : {}),
    }));
    autosave.onEdit('instant');
  };
  // 子编辑器(能力面板)的回写入口。它一次交互可能同时改 capabilities 与 skills,
  // 两次 onEdit 走同一条合并通道,最终只发一次 IPC。
  const applyCapabilities = (next: BotCapabilities) => {
    setCapabilities(next);
    autosave.onEdit('instant');
  };
  const applySelectedSkills = (next: string[]) => {
    setSelectedSkills(next);
    autosave.onEdit('instant');
  };

  const handleBack = () => {
    void autosave.flush().then(() => {
      if (autosave.isDirty()) return; // 保存失败:留在页面,状态条给出重试入口
      onBack();
    });
  };

  const openProfileEditor = () => {
    setEditProfileOpen(true);
  };

  const handleExport = async () => {
    setPortabilityBusy(true);
    setPortabilityNotice(null);
    try {
      const result = await exportBotBundle(bot.id);
      if (!result.canceled) {
        setPortabilityNotice(
          result.redactionCount
            ? t('bots.portability.exportedRedacted', { count: result.redactionCount })
            : t('bots.portability.exported'),
        );
      }
    } catch (error) {
      setPortabilityNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setPortabilityBusy(false);
    }
  };

  /*
    存完性格回对话。放在 effect 里跑，是为了让这一步发生在「新 identitySource 已经
    进了 autosave 载荷 ref」之后 —— 在 onSave 里同步 flush 会保存到旧值。
    handleBack 而不是直接 onBack：保存失败要留在页面。
  */
  useEffect(() => {
    if (personaSavedAt === null) return;
    setPersonaSavedAt(null);
    handleBack();
  }, [handleBack, personaSavedAt]);

  const visibleChannelConnections = useMemo(() => {
    const byKey = new Map<string, BotChannelConnection>();
    for (const connection of channelConnections) {
      if (!connection.accountKey) continue;
      byKey.set(
        `${connection.kind}\u0000${connection.ownership}\u0000${connection.accountKey}`,
        connection,
      );
    }
    for (const channel of bot.channels ?? []) {
      if (channel.kind === 'local') continue;
      const accountKey =
        typeof channel.config?.accountKey === 'string' ? channel.config.accountKey.trim() : '';
      if (!accountKey) continue;
      const ownership =
        channel.config?.ownership === 'server-relay' ? 'server-relay' : 'local-adapter';
      const key = `${channel.kind}\u0000${ownership}\u0000${accountKey}`;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        id:
          typeof channel.config?.connectionId === 'string'
            ? channel.config.connectionId
            : `saved:${channel.id}`,
        kind: channel.kind,
        ownership,
        status: 'unavailable',
        connected: false,
        accountKey,
        accountName:
          typeof channel.config?.accountName === 'string' ? channel.config.accountName : null,
        scopeKey: typeof channel.config?.scopeKey === 'string' ? channel.config.scopeKey : null,
        routable: true,
        features: Array.isArray(channel.config?.features)
          ? channel.config.features.filter(
              (item): item is BotChannelConnection['features'][number] => typeof item === 'string',
            )
          : [],
      });
    }
    return [...byKey.values()].sort(
      (a, b) =>
        channelLabel(a.kind).localeCompare(channelLabel(b.kind)) ||
        Number(b.connected) - Number(a.connected) ||
        (a.accountName ?? a.accountKey ?? '').localeCompare(b.accountName ?? b.accountKey ?? ''),
    );
  }, [bot.channels, channelConnections]);

  const mountedChannelFor = (connection: BotChannelConnection) =>
    (bot.channels ?? []).find((channel) => {
      if (!channel.enabled || channel.kind !== connection.kind) return false;
      const accountKey =
        typeof channel.config?.accountKey === 'string' ? channel.config.accountKey.trim() : '';
      const ownership =
        channel.config?.ownership === 'server-relay' ? 'server-relay' : 'local-adapter';
      return accountKey === connection.accountKey && ownership === connection.ownership;
    });

  const toggleChannel = async (connection: BotChannelConnection) => {
    if (!connection.accountKey || !connection.routable) return;
    setChannelBusy(connection.id);
    setChannelError(null);
    try {
      const mounted = mountedChannelFor(connection);
      if (mounted) {
        const migration = migrationRecords.find(
          (row) => row.channelId === mounted.id && row.status === 'applied',
        );
        if (migration) {
          setRollbackRecord(migration);
        } else {
          await upsertBotChannel(bot.id, connection.kind, false, mounted.config, mounted.id);
        }
        return;
      }
      setMigrationPlan(await planBotImMigration(bot.id, connection.id));
    } catch {
      setChannelError(t('bots.migration.errors.preflight'));
    } finally {
      setChannelBusy(null);
    }
  };

  const confirmMigration = async () => {
    if (!migrationPlan) return;
    setChannelBusy(migrationPlan.connection.id);
    setChannelError(null);
    try {
      await applyBotImMigration(
        bot.id,
        migrationPlan.connection.id,
        migrationPlan.planHash,
        globalThis.crypto.randomUUID(),
      );
      setMigrationRecords(await listBotImMigrations(bot.id));
      setMigrationPlan(null);
    } catch {
      setChannelError(t('bots.migration.errors.apply'));
    } finally {
      setChannelBusy(null);
    }
  };

  const confirmRollback = async () => {
    if (!rollbackRecord) return;
    setChannelBusy(rollbackRecord.connectionId);
    setChannelError(null);
    try {
      const result = await rollbackBotImMigration(bot.id, rollbackRecord.id);
      setMigrationRecords(await listBotImMigrations(bot.id));
      setRollbackRecord(null);
      const bindingWarning = result.warnings?.find(
        (warning) => warning.code === 'binding-restore-conflict',
      );
      if (bindingWarning) {
        setChannelError(
          t('bots.migration.warnings.binding-restore-conflict', {
            count: bindingWarning.count,
          }),
        );
      }
    } catch {
      setChannelError(t('bots.migration.errors.rollback'));
    } finally {
      setChannelBusy(null);
    }
  };
  /*
    区块标题旁那句提示只在「这一块还空着」时出现(约定见 BotSettingsBlock)。
    这两个判断就是各自那块的「空不空」,提到这里一处算,免得在 JSX 里内联出两份
    不一致的判据。
  */
  const persona = extractPersonaFromIdentitySource(identitySource);
  const joined = botJoinedRelativeKey(bot.createdAt, Date.now());

  // 页面里的普通 Back 行已并入顶栏面包屑。保留键盘可达的同语义出口，是为了
  // 不依赖指针也能离开；保存失败时它仍然只冲刷，不强行丢状态。
  const backToChatControl = (
    <button
      type="button"
      onClick={handleBack}
      aria-label={t('bots.backToChat')}
      className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:inline-flex focus:items-center focus:gap-2 focus:rounded-lg focus:bg-[var(--surface)] focus:px-2 focus:py-1.5 focus:text-12 focus:text-[var(--text-secondary)] focus:hover:bg-[var(--surface-hover)] focus:hover:text-[var(--text-primary)]"
    >
      {t('bots.backToChat')}
    </button>
  );

  if (bot.status === 'archived') {
    return (
      <main className="h-full overflow-y-auto bg-[var(--surface)] px-8 py-8" role="main">
        <div className="mx-auto flex max-w-4xl flex-col gap-5">
          {backToChatControl}
          <header className="flex items-center gap-3">
            <BotAvatar bot={bot} size="lg" />
            <div>
              <p className="text-12 font-medium uppercase tracking-[0.16em] text-[var(--text-tertiary)]">
                {t('bots.lifecycle.stoppedTitle')}
              </p>
              <h1 className="mt-1 text-24 font-medium text-[var(--text-primary)]">{bot.name}</h1>
              {bot.description ? (
                <p className="mt-1 text-12 text-[var(--text-secondary)]">{bot.description}</p>
              ) : null}
            </div>
          </header>
          <BotLifecycleSettings bot={bot} onOpenSession={onOpenSession} onRenew={onRenew} />
          <BotEventInboxSettings bot={bot} />
        </div>
      </main>
    );
  }
  return (
    <main
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--surface)]"
      role="main"
    >
      {backToChatControl}
      <div className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden px-4 sm:px-6 lg:flex-row lg:px-8">
        <aside className="mx-auto w-full shrink-0 border-b border-[var(--border-default)] pb-5 lg:mx-0 lg:h-full lg:w-80 lg:border-b-0 lg:pb-0 lg:pr-6">
          <div className="flex min-w-0 flex-col gap-6 pt-4">
            <header className="flex min-w-0 flex-row items-start gap-5 lg:flex-col lg:items-start lg:text-left">
              <div className="group relative shrink-0">
                <BotAvatar bot={{ ...bot, avatar, avatarColor }} size="lg" />
                <button
                  type="button"
                  onClick={openProfileEditor}
                  aria-label={t('bots.editProfile')}
                  className="absolute inset-0 flex items-center justify-center rounded-full bg-[var(--overlay-modal)] text-[var(--text-primary)] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <Pencil size={18} />
                </button>
              </div>

              <div className="flex min-w-0 flex-1 flex-col items-start gap-3">
                <div className="flex w-full min-w-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={openProfileEditor}
                    className="min-w-0 truncate rounded-lg px-2 py-1 text-20 font-medium leading-tight text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                  >
                    {name}
                  </button>
                  {description.trim() ? (
                    <span
                      className="max-w-[45%] shrink truncate rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 text-[var(--text-secondary)]"
                      title={description.trim()}
                    >
                      {description.trim()}
                    </span>
                  ) : null}
                </div>
                {joined ? (
                  <span className="px-2 text-11 text-[var(--text-tertiary)]">
                    {t(joined.key, { n: joined.n })}
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={openProfileEditor}
                  aria-label={t('bots.background.edit')}
                  className="w-full rounded-lg px-2 py-1 text-left hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  <span className="block text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
                    {t('bots.background.title')}
                  </span>
                  <span
                    className="mt-2 block line-clamp-5 text-12 leading-5 text-[var(--text-primary)]"
                    title={background || t('bots.background.empty')}
                  >
                    {background || t('bots.background.empty')}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={openProfileEditor}
                  aria-label={persona ? t('bots.persona.title') : t('bots.persona.addButton')}
                  className="w-full rounded-lg px-2 py-1 text-left hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  <span className="block text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
                    {t('bots.persona.title')}
                  </span>
                  {persona ? (
                    <span
                      className="mt-2 block line-clamp-5 text-12 leading-5 text-[var(--text-primary)]"
                      title={personaSummaryText(t, persona)}
                    >
                      {personaSummaryText(t, persona)}
                    </span>
                  ) : (
                    <span className="mt-2 block text-12 text-[var(--text-tertiary)]">
                      {t('bots.persona.addButton')}
                    </span>
                  )}
                </button>
              </div>
            </header>

            <div className="flex w-full flex-col gap-2">
              <button
                type="button"
                disabled={!canonicalProjection}
                onClick={() => canonicalProjection && onOpenSession(canonicalProjection.id)}
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[var(--accent-cta-bg)] px-4 text-13 font-medium text-[var(--accent-pure-cta-fg)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <MessageCircle size={15} />
                {t('bots.actions.message')}
              </button>
              <button
                type="button"
                onClick={() => navigate('/bots/groups')}
                className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-[var(--border-default)] px-4 text-12 text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
              >
                <Users size={14} />
                {t('bots.actions.addToGroup')}
              </button>
              <button
                type="button"
                onClick={() => setPersonaOpen(true)}
                className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-[var(--border-default)] px-4 text-12 text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
              >
                {t('bots.persona.adjustButton')}
              </button>
            </div>

            <div className="flex min-h-4 flex-wrap items-center gap-2">
              {autosave.status === 'saving' ? (
                <span
                  role="status"
                  className="inline-flex items-center gap-1 text-11 text-[var(--text-tertiary)]"
                >
                  <Spinner size={12} />
                  {t('bots.autosave.saving')}
                </span>
              ) : null}
              {autosave.status === 'saved' ? (
                <span
                  role="status"
                  className="inline-flex animate-fade-in items-center gap-1 text-11 text-[var(--text-tertiary)]"
                >
                  <Check size={12} />
                  {t('bots.autosave.saved')}
                </span>
              ) : null}
              {autosave.status === 'error' ? (
                <p
                  className="flex flex-wrap items-center gap-2 text-11 text-[var(--text-danger)]"
                  role="alert"
                >
                  {t('bots.profileApply.saveFailed')}
                  <button
                    type="button"
                    onClick={() => void autosave.retry()}
                    className="rounded-lg px-1.5 py-0.5 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                  >
                    {t('bots.autosave.retry')}
                  </button>
                </p>
              ) : null}
            </div>
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col pt-4 lg:border-l lg:border-[var(--border-default)] lg:pl-6">
          <div
            className="flex max-w-full shrink-0 items-end gap-6 overflow-x-auto border-b border-[var(--border-default)] pb-0"
            role="tablist"
            aria-label={t('bots.settingsNav.title')}
          >
            {BOT_DETAIL_TABS.map((tab) => {
              const Icon = tab.icon;
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => {
                    setActiveTab(tab.id);
                    navigate(`/bots/${bot.id}?settings=1&tab=${tab.id}`, { replace: true });
                  }}
                  className={cn(
                    '-mb-px inline-flex h-9 shrink-0 items-center gap-2 border-b-2 px-0.5 text-12 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                    selected
                      ? 'border-[var(--text-primary)] text-[var(--text-primary)]'
                      : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                  )}
                >
                  <Icon size={14} />
                  {t(tab.labelKey)}
                </button>
              );
            })}
          </div>

          <div
            ref={contentRef}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8 pt-4"
          >
            <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-10">
              {activeTab === 'connections' ? (
                <>
                  <BotCapabilitySettings
                    bot={bot}
                    capabilities={capabilities}
                    selectedSkills={selectedSkills}
                    runtimeSnapshot={canonicalProjection?.runtimeSnapshot}
                    remoteHostId={selectedProject?.remoteHostId}
                    onCapabilitiesChange={applyCapabilities}
                    onSelectedSkillsChange={applySelectedSkills}
                  />
                  <BotSettingsBlock
                    icon={MessageCircleMore}
                    title={t('bots.imConnectionsTitle')}
                    hint={t('bots.imConnectionsDescription')}
                  >
                    <BotAbilityWall
                      connections={visibleChannelConnections}
                      isChannelMounted={(connection) => Boolean(mountedChannelFor(connection))}
                      channelBusyId={channelBusy}
                      onToggleChannel={(connection) => void toggleChannel(connection)}
                    />
                    {channelError ? (
                      <p className="mt-3 text-11 text-[var(--text-danger)]">{channelError}</p>
                    ) : null}
                  </BotSettingsBlock>
                  <BotRouteSettings bot={bot} onOpenTask={onOpenSession} />
                  <BotEventInboxSettings bot={bot} />
                </>
              ) : null}

              {activeTab === 'growth' ? (
                <>
                  <BotSettingsBlock
                    icon={BookMarked}
                    title={t('bots.memoryLabel')}
                    hint={t(
                      capabilities.memory
                        ? 'bots.memoryDescription'
                        : 'bots.memoryRecovery.description',
                    )}
                    action={
                      <Switch
                        checked={capabilities.memory}
                        onCheckedChange={(checked) => updateCapability('memory', checked)}
                        aria-label={t('bots.memoryLabel')}
                      />
                    }
                  />
                  <BotSettingsBlock
                    icon={UserRound}
                    title={t('bots.advancedIdentity.title')}
                    hint={t('bots.userContextSourceDescription')}
                  >
                    <label className="flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
                      {t('bots.userContextSourceLabel')}
                      <textarea
                        value={userContextSource}
                        onChange={(event) => {
                          setUserContextSource(event.target.value);
                          autosave.onEdit('text');
                        }}
                        onBlur={() => void autosave.flush()}
                        placeholder={t('bots.userContextSourcePlaceholder')}
                        rows={5}
                        className="resize-y rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-13 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
                      />
                    </label>
                  </BotSettingsBlock>
                  <BotGrowthLists
                    botId={bot.id}
                    highlight={highlight}
                    seedEntries={templateSeedEntries}
                  />
                </>
              ) : null}

              {activeTab === 'model' ? (
                <BotSettingsBlock
                  icon={PlugZap}
                  title={t('bots.settingsTabs.model')}
                  hint={t('bots.model.description')}
                  action={
                    <button
                      type="button"
                      onClick={() => {
                        const model = defaultBotModel(vendor);
                        const prefs = getDraft().lastByVendor[vendor];
                        setCapabilities((current) => ({
                          ...current,
                          model,
                          modelOverride: null,
                          providerId: model === prefs.model ? (prefs.providerId ?? null) : null,
                          effort: prefs.effort,
                          fastMode: getDraft().fastModeByModel[model] === true,
                        }));
                        autosave.onEdit('instant');
                      }}
                      className="h-8 rounded-lg border border-[var(--border-default)] px-3 text-11 text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                    >
                      {t('bots.model.restoreDefault')}
                    </button>
                  }
                >
                  <div
                    data-testid="bot-model-controls"
                    className="flex w-full min-w-0 max-w-xl flex-col gap-5"
                  >
                    <div className="flex min-w-0 flex-col gap-2">
                      <span className="text-12 font-medium leading-5 text-[var(--text-secondary)]">
                        {t('bots.harnessLabel')}
                      </span>
                      <VendorSegmentedSwitcher
                        value={vendor}
                        hiddenVendors={hiddenVendors}
                        visualVariant="settings"
                        width={576}
                        className="max-w-full"
                        ariaLabel={t('bots.harnessLabel')}
                        onChange={(next) => {
                          if (next === 'orca') return;
                          const prefs = getDraft().lastByVendor[next];
                          const model = defaultBotModel(next);
                          setCapabilities((current) => ({
                            ...current,
                            harness: next === 'cc' ? 'claude' : next,
                            model,
                            modelOverride: null,
                            providerId: model === prefs.model ? (prefs.providerId ?? null) : null,
                            effort: prefs.effort,
                            fastMode: getDraft().fastModeByModel[model] === true,
                            skillMode: 'inherit',
                          }));
                          autosave.onEdit('instant');
                        }}
                      />
                    </div>
                    <div className="flex min-w-0 flex-col gap-2">
                      <span className="text-12 font-medium leading-5 text-[var(--text-secondary)]">
                        {t('bots.modelLabel')}
                      </span>
                      <ModelSelector
                        modelId={capabilities.model}
                        effort={capabilities.effort}
                        vendorKey={vendor}
                        currentProviderId={capabilities.providerId ?? null}
                        triggerVariant="field"
                        popoverSide="bottom"
                        ariaContext={t('bots.modelLabel')}
                        excludeSubscriptionDirect={sshRemote}
                        excludeChatBridgedCodex={sshRemote}
                        fastMode={vendor === 'cc' ? undefined : capabilities.fastMode}
                        onFastModeChange={
                          vendor === 'cc'
                            ? undefined
                            : (enabled) => updateCapability('fastMode', enabled)
                        }
                        onModelChange={(model) => {
                          setCapabilities((current) => ({
                            ...current,
                            model,
                            modelOverride: {
                              model,
                              providerId: current.providerId ?? null,
                              effort: current.effort,
                              fastMode: current.fastMode,
                            },
                          }));
                          autosave.onEdit('instant');
                        }}
                        onEffortChange={(effort) => {
                          setCapabilities((current) => ({
                            ...current,
                            effort,
                            modelOverride: {
                              model: current.model,
                              providerId: current.providerId ?? null,
                              effort,
                              fastMode: current.fastMode,
                            },
                          }));
                          autosave.onEdit('instant');
                        }}
                        onProviderChange={(providerId, model, effort) => {
                          setCapabilities((current) => ({
                            ...current,
                            providerId,
                            model: model ?? current.model,
                            effort: effort || current.effort,
                            modelOverride: {
                              model: model ?? current.model,
                              providerId,
                              effort: effort || current.effort,
                              fastMode: current.fastMode,
                            },
                          }));
                          autosave.onEdit('instant');
                        }}
                        onNavigateToProviders={() => navigate('/settings?tab=providers')}
                        unknownModelLabel={(model) => t('bots.modelUnavailable', { model })}
                      />
                    </div>
                  </div>
                </BotSettingsBlock>
              ) : null}

              {activeTab === 'project' ? (
                <>
                  <BotSettingsBlock
                    icon={FolderGit2}
                    title={t('bots.homeFolder.title')}
                    hint={t('bots.homeFolder.description')}
                    action={
                      bot.homeDir ? (
                        <button
                          type="button"
                          onClick={() => void window.electronAPI.openPath(bot.homeDir as string)}
                          className="h-8 shrink-0 rounded-lg border border-[var(--border-default)] px-3 text-11 text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                        >
                          {t('bots.homeFolder.open')}
                        </button>
                      ) : null
                    }
                  >
                    <BotFolderCards botId={bot.id} bindings={bot.projectBindings ?? []} />
                  </BotSettingsBlock>
                  <BotProjectSettings bot={bot} />
                </>
              ) : null}

              {activeTab === 'maintenance' ? (
                <>
                  <BotLifecycleSettings bot={bot} onOpenSession={onOpenSession} onRenew={onRenew} />
                  <BotSettingsBlock
                    icon={Download}
                    title={t('bots.dataManagement.title')}
                    hint={t('bots.dataManagement.exportHint')}
                    action={
                      <button
                        type="button"
                        disabled={portabilityBusy}
                        onClick={() => void handleExport()}
                        className="inline-flex h-8 items-center gap-2 rounded-lg border border-[var(--border-default)] px-3 text-11 text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                      >
                        <Download size={13} />
                        {portabilityBusy
                          ? t('bots.portability.exporting')
                          : t('bots.actions.export')}
                      </button>
                    }
                  >
                    {portabilityNotice ? (
                      <p className="text-11 text-[var(--text-tertiary)]" role="status">
                        {portabilityNotice}
                      </p>
                    ) : null}
                  </BotSettingsBlock>
                </>
              ) : null}
            </div>
          </div>
        </section>
      </div>

      <BotPersonaWizard
        open={personaOpen}
        identitySource={identitySource}
        onOpenChange={setPersonaOpen}
        onSave={(next) => {
          /*
            调完性格要能立刻**听见**新口气，所以这里做两件事：
            1) 人格真的变了才寄存一条确认消息(botPersonaAck，幂等靠 clientId)；
            2) 回到 TA 的对话 —— 「调整性格」是从对话里点进来的，改完停在设置页
               等于让用户自己再点一次返回才看得到效果。

            导航**不能**在这里同步做：autosave 的载荷是每次渲染写进 ref 的，
            此刻 setIdentitySource 还没提交，同步 flush 会把**旧的** identitySource
            当成要保存的内容发出去 —— 性格白调了。改成置一个标记，等新草稿落进
            ref 之后的那次渲染再走 handleBack。
          */
          const previous = extractPersonaFromIdentitySource(identitySource);
          const parsed = extractPersonaFromIdentitySource(next);
          setIdentitySource(next);
          autosave.onEdit('instant');
          if (parsed) rememberPendingBotPersonaAck(bot.id, previous, parsed);
          setPersonaSavedAt(Date.now());
        }}
      />

      <BotProfileDialog
        open={editProfileOpen}
        onOpenChange={setEditProfileOpen}
        value={{ name, description, identitySource, avatar, avatarColor }}
        mode="edit"
        onSave={(next) => {
          setName(next.name);
          setDescription(next.description);
          setIdentitySource(next.identitySource);
          setAvatar(next.avatar);
          setAvatarColor(next.avatarColor);
          autosave.onEdit('text');
        }}
      />
      {/* 迁移与回滚确认挂在页面根部，避免随任一 Tab 卸载。 */}
      <Dialog.Root
        open={migrationPlan !== null}
        onOpenChange={(open) => {
          if (!open && channelBusy === null) setMigrationPlan(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-32px)] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 outline-none">
            <Dialog.Title className="text-16 font-medium text-[var(--text-primary)]">
              {t('bots.migration.title')}
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
              {t('bots.migration.description')}
            </Dialog.Description>
            {migrationPlan ? (
              <div className="mt-4 space-y-3">
                <div className="rounded-xl bg-[var(--surface-chip)] p-3 text-12 text-[var(--text-secondary)]">
                  <p className="font-medium text-[var(--text-primary)]">
                    {channelLabel(migrationPlan.connection.kind)} ·{' '}
                    {migrationPlan.connection.accountName || migrationPlan.connection.accountKey}
                  </p>
                  <p className="mt-1">
                    {t('bots.migration.legacyTaskCount', {
                      count: migrationPlan.candidates.length,
                    })}
                  </p>
                </div>
                {migrationPlan.conflicts.length > 0 ? (
                  <div className="rounded-xl border border-[var(--text-danger)]/30 bg-[var(--surface-chip)] p-3">
                    <p className="text-12 font-medium text-[var(--text-danger)]">
                      {t('bots.migration.blocked')}
                    </p>
                    <ul className="mt-2 list-disc space-y-1 pl-4 text-11 text-[var(--text-secondary)]">
                      {migrationPlan.conflicts.map((conflict, index) => (
                        <li key={`${conflict.code}:${conflict.sessionId ?? index}`}>
                          {t(`bots.migration.conflicts.${conflict.code}`)}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {migrationPlan.warnings.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-4 text-11 text-[var(--text-secondary)]">
                    {migrationPlan.warnings.map((warning) => (
                      <li key={warning.code}>{t(`bots.migration.warnings.${warning.code}`)}</li>
                    ))}
                  </ul>
                ) : null}
                <p className="text-11 leading-5 text-[var(--text-tertiary)]">
                  {t('bots.migration.preserveData')}
                </p>
              </div>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={channelBusy !== null}
                onClick={() => setMigrationPlan(null)}
                className="h-8 rounded-lg px-3 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
              >
                {t('bots.cancel')}
              </button>
              <button
                type="button"
                disabled={!migrationPlan?.canApply || channelBusy !== null}
                onClick={() => void confirmMigration()}
                className="h-8 rounded-lg bg-[var(--accent-cta-bg)] px-3 text-11 font-medium text-[var(--accent-pure-cta-fg)] disabled:opacity-50"
              >
                {channelBusy ? t('bots.migration.applying') : t('bots.migration.apply')}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={rollbackRecord !== null}
        onOpenChange={(open) => {
          if (!open && channelBusy === null) setRollbackRecord(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 outline-none">
            <Dialog.Title className="text-16 font-medium text-[var(--text-primary)]">
              {t('bots.migration.rollbackTitle')}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-12 leading-5 text-[var(--text-secondary)]">
              {t('bots.migration.rollbackDescription')}
            </Dialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={channelBusy !== null}
                onClick={() => setRollbackRecord(null)}
                className="h-8 rounded-lg px-3 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
              >
                {t('bots.cancel')}
              </button>
              <button
                type="button"
                disabled={channelBusy !== null}
                onClick={() => void confirmRollback()}
                className="h-8 rounded-lg border border-[var(--border-default)] px-3 text-11 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
              >
                {channelBusy ? t('bots.migration.rollingBack') : t('bots.migration.rollback')}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}

export function BotsHomeView() {
  const { t } = useBotTranslation();
  const navigate = useNavigate();
  const { botId, sessionId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const bots = useBotProfiles();
  const creatingBotRef = useRef<{ botId: string; token: symbol } | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [createSessionError, setCreateSessionError] = useState<unknown>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const importingRef = useRef(false);
  const selectedBot = useMemo(() => bots.find((bot) => bot.id === botId) ?? null, [botId, bots]);
  // `?add=1` 是阵容还在弹模态那阵子的入口。阵容页面化之后它只剩兼容职责:
  // 老书签、老深链一律送到 /bots/roster,不再在这里开一层浮层。
  const addRequested = searchParams.get('add') === '1';
  const settingsOpen = searchParams.get('settings') === '1';

  const createCanonicalSession = useCallback(
    async (
      bot: BotProfile,
      expectedCanonicalSessionId: string | null = canonicalBotSessionId(bot) ?? null,
      recoverMissingOnly = false,
    ): Promise<import('@/lib/ccAgent.types').Session> => {
      try {
        setCreateSessionError(null);
        const result = await createBotCanonicalSessionWithRetry(() =>
          window.electronAPI.localDb.bots.createCanonicalSession({
            botId: bot.id,
            expectedCanonicalSessionId,
            expectedProfileVersion: bot.currentVersion ?? 1,
            recoverMissingOnly,
          }),
        );
        const updated = result.session;
        setCanonicalBotSession(bot.id, {
          id: updated.id,
          title: updated.title,
          updatedAt: Date.now(),
        });
        return updated;
      } catch (error) {
        setCreateSessionError(error);
        throw error;
      }
    },
    [],
  );

  const renewBotSession = useCallback(
    async (bot: BotProfile): Promise<boolean> => {
      setIsCreatingSession(true);
      try {
        const canonicalSessionId = canonicalBotSessionId(bot);
        if (!canonicalSessionId) return false;
        const result = await window.electronAPI.localDb.bots.compactCanonicalSession({
          botId: bot.id,
          expectedCanonicalSessionId: canonicalSessionId,
          instructions:
            'Keep the Bot identity, durable memory, and active commitments while compacting this Chat.',
        });
        if (!result.compacted) return false;
        navigate(`/bots/${bot.id}/session/${canonicalSessionId}`, { replace: true });
        return true;
      } catch {
        // The settings view remains mounted and can surface a localized error.
        return false;
      } finally {
        setIsCreatingSession(false);
      }
    },
    [createCanonicalSession, navigate],
  );

  const retryCanonicalSessionCreation = useCallback(
    async (bot: BotProfile): Promise<void> => {
      creatingBotRef.current = null;
      setCreateSessionError(null);
      setIsCreatingSession(true);
      try {
        const session = await createCanonicalSession(bot);
        navigate(`/bots/${bot.id}/session/${session.id}`, { replace: true });
      } catch {
        // createCanonicalSession stores the actual IPC error for the error state.
      } finally {
        creatingBotRef.current = null;
        setIsCreatingSession(false);
      }
    },
    [createCanonicalSession, navigate],
  );

  useEffect(() => {
    if (!addRequested) return;
    navigate('/bots/roster', { replace: true });
  }, [addRequested, navigate]);

  useEffect(() => {
    if (addRequested) return;
    // 已经有伙伴，但 URL 指着一个不存在的（刚被删掉 / 手改过的链接）：回伙伴总览，
    // 由下面那条重定向落到第一个伙伴。以前这里会停在一页空态，现在会停在 spinner
    // ——两个都不是答案，直接把人送回有东西的地方。
    if (botId && bots.length > 0 && !selectedBot) {
      navigate('/bots', { replace: true });
      return;
    }
    if (!botId && bots[0]) {
      const target = bots.find((bot) => bot.status !== 'archived') ?? bots[0];
      const query = searchParams.toString();
      const nextQuery =
        target.status !== 'active'
          ? new URLSearchParams({ ...Object.fromEntries(searchParams), settings: '1' }).toString()
          : query;
      navigate(`/bots/${target.id}${nextQuery ? `?${nextQuery}` : ''}`, { replace: true });
    }
  }, [addRequested, botId, bots, navigate, searchParams, selectedBot]);

  // 顶栏注入区:伙伴页保留「头像 + 名字」入口;设置页升级成
  // 「头像 + 名字 > 设置」面包屑,让当前页归属一眼可见。
  const headerContent = useMemo(
    () =>
      selectedBot ? (
        settingsOpen ? (
          <div className="flex min-w-0 items-center gap-1 text-13" aria-label={t('bots.settings')}>
            <button
              type="button"
              onClick={() => navigate(`/bots/${selectedBot.id}`)}
              title={t('bots.backToChat')}
              className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <BotAvatar bot={selectedBot} size="xs" />
              <span className="min-w-0 truncate">{selectedBot.name}</span>
            </button>
            <ChevronRight
              size={14}
              aria-hidden="true"
              className="shrink-0 text-[var(--text-tertiary)]"
            />
            <span className="shrink-0 px-1 font-medium text-[var(--text-primary)]">
              {t('bots.settings')}
            </span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => navigate(`/bots/${selectedBot.id}?settings=1`)}
            title={t('bots.settings')}
            className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-13 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <BotAvatar bot={selectedBot} size="xs" />
            <span className="min-w-0 truncate">{selectedBot.name}</span>
          </button>
        )
      ) : (
        <div className="flex items-center gap-2 text-13 font-medium text-[var(--text-primary)]">
          <Bot size={15} />
          {t('bots.title')}
        </div>
      ),
    [navigate, selectedBot, settingsOpen, t],
  );
  useRegisterContentHeader(headerContent);

  useEffect(() => {
    if (searchParams.get('import') !== '1' || importingRef.current) return;
    importingRef.current = true;
    setSearchParams(
      (current) => {
        current.delete('import');
        return current;
      },
      { replace: true },
    );
    void importBotBundle()
      .then((result) => {
        if (result.canceled) return;
        setImportNotice(
          t('bots.portability.imported', {
            channels: result.disabledChannels?.length ?? 0,
            automations: result.pausedAutomations ?? 0,
          }),
        );
        if (result.botId) navigate(`/bots/${result.botId}?settings=1`, { replace: true });
      })
      .catch((error: unknown) => {
        setImportNotice(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        importingRef.current = false;
      });
  }, [navigate, searchParams, setSearchParams, t]);

  useEffect(() => {
    if (!selectedBot || shouldDeferCanonicalBotSessionNavigation({ settingsOpen, addRequested }))
      return;
    if (selectedBot.status !== 'active') {
      navigate(`/bots/${selectedBot.id}?settings=1`, { replace: true });
      return;
    }

    const canonicalSessionId = canonicalBotSessionId(selectedBot);
    let cancelled = false;
    if (canonicalSessionId) {
      setIsCreatingSession(false);
      void withBotCanonicalSessionReadTimeout(() => sessionService.get(canonicalSessionId))
        .then(async (session) => {
          if (cancelled) return;
          if (session.status !== 'active') {
            setIsCreatingSession(true);
            const next = await createCanonicalSession(selectedBot);
            if (!cancelled) {
              setIsCreatingSession(false);
              if (next) navigate(`/bots/${selectedBot.id}/session/${next.id}`, { replace: true });
            }
            return;
          }
          if (session.source !== 'bot') {
            // A renderer-held canonicalSessionId is not authority to reclassify an
            // arbitrary existing Session. Preserve the existing task and create a
            // fresh Bot-owned Session instead.
            setIsCreatingSession(true);
            const next = await createCanonicalSession(selectedBot);
            if (!cancelled) {
              setIsCreatingSession(false);
              if (next) navigate(`/bots/${selectedBot.id}/session/${next.id}`, { replace: true });
            }
            return;
          }
          setCanonicalBotSession(selectedBot.id, {
            id: canonicalSessionId,
            title: session.title || selectedBot.name,
            updatedAt: Date.parse(session.updatedAt) || Date.now(),
          });
          if (!cancelled && sessionId !== canonicalSessionId) {
            navigate(`/bots/${selectedBot.id}/session/${canonicalSessionId}`, { replace: true });
          }
        })
        .catch(async () => {
          if (cancelled) return;
          setIsCreatingSession(true);
          // The profile pointer is still the CAS authority even when its Session
          // row disappeared. Passing null can never repair that state because
          // main correctly sees a non-null canonical pointer. Preserve the
          // observed id so a concurrent Renew still loses the CAS safely.
          const next = await createCanonicalSession(selectedBot, canonicalSessionId, true).catch(
            () => null,
          );
          if (!cancelled) {
            setIsCreatingSession(false);
            if (next) navigate(`/bots/${selectedBot.id}/session/${next.id}`, { replace: true });
          }
        });
      return () => {
        cancelled = true;
      };
    }

    if (sessionId || creatingBotRef.current?.botId === selectedBot.id) return;

    const attemptToken = Symbol('bot-canonical-create');
    creatingBotRef.current = { botId: selectedBot.id, token: attemptToken };
    setIsCreatingSession(true);
    void createCanonicalSession(selectedBot)
      .then((session) => {
        if (cancelled) return;
        navigate(`/bots/${selectedBot.id}/session/${session.id}`, { replace: true });
      })
      .catch(() => {
        if (cancelled) return;
      })
      .finally(() => {
        if (creatingBotRef.current?.token === attemptToken) {
          creatingBotRef.current = null;
        }
        if (!cancelled) setIsCreatingSession(false);
      });

    return () => {
      cancelled = true;
      if (creatingBotRef.current?.token === attemptToken) {
        creatingBotRef.current = null;
      }
    };
  }, [addRequested, createCanonicalSession, selectedBot, sessionId, settingsOpen, navigate]);

  if (!selectedBot) {
    // 一个伙伴都没有 → 主区直接就是阵容页,没有中间那一层。
    //
    // 这里曾经是另一套「还没有伙伴」推销页:Bot 图标 + 四张功能卖点卡（长期身份 /
    // 自动接收任务事件 / 自动化与协同 / 按需挂载消息通道）+ 一个「添加伙伴」按钮,
    // 点了才弹出阵容模态。它用产品内部术语介绍一个本来靠「挑一个合拍的」就能懂的
    // 东西,还把定稿最重要的第一印象藏在两层之后。整页删除,不做兼容。
    if (bots.length === 0) return <BotRosterView notice={importNotice} />;
    // 有伙伴但 URL 还没落到具体一个(上面的重定向正在路上):安静地等,不要闪一页
    // 阵容再跳走。
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)]" role="main">
        <Spinner
          size={20}
          className="text-[var(--text-tertiary)]"
          role="status"
          aria-label={t('ccAgent.common.loading')}
        />
      </main>
    );
  }

  if (settingsOpen) {
    return (
      // 设置页整棵子树共用同一个第三人称:文案里的 {{pronoun}} 按这个伙伴的性别
      // 取「她 / 他」,自建伙伴取它的名字(裁决:不用「TA」)。
      <BotPronounProvider bot={selectedBot}>
        <BotSettings
          // 切到另一个 Bot 必须重挂:自动保存的基线、防抖计时与「未落即冲刷」都绑在
          // 实例上,复用实例会让上一个 Bot 的待保存改动记在新 Bot 头上。
          key={selectedBot.id}
          bot={selectedBot}
          onRenew={() => renewBotSession(selectedBot)}
          onOpenSession={(targetSessionId, searchJump) => {
            const projection = selectedBot.sessions.find((item) => item.id === targetSessionId);
            const route =
              projection?.kind === 'history'
                ? `/bots/${selectedBot.id}/history/${targetSessionId}`
                : `/bots/${selectedBot.id}/session/${targetSessionId}`;
            navigate(route, { state: searchJump ? { searchJump } : undefined });
          }}
          onBack={() => {
            if (selectedBot.status === 'archived') {
              navigate('/bots', { replace: true });
              return;
            }
            setSearchParams(
              (current) => {
                current.delete('settings');
                return current;
              },
              { replace: true },
            );
          }}
        />
      </BotPronounProvider>
    );
  }

  return (
    <main className="flex h-full items-center justify-center bg-[var(--surface)]" role="main">
      {importNotice || (createSessionError && !isCreatingSession) ? (
        <div className="flex max-w-lg flex-col items-center gap-3 px-6 text-center">
          <p className="text-13 text-[var(--text-secondary)]">
            {importNotice ?? t('ccAgent.draft.createSessionFailed')}
          </p>
          {/* 文案写着「请重试」,却没有任何能按的东西 —— 只能切走再切回来才会重建
              (2026-08-21 实测撞上一次瞬时失败)。这里补上真正的重试入口。 */}
          {!importNotice && selectedBot ? (
            <button
              type="button"
              onClick={() => void retryCanonicalSessionCreation(selectedBot)}
              className="h-8 rounded-full border border-[var(--border-default)] px-4 text-12 text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
            >
              {t('commonUi.retry')}
            </button>
          ) : null}
        </div>
      ) : (
        // Opening a Bot is a hand-off to its canonical chat, not a page of its
        // own: show a quiet spinner instead of full-screen "loading" text.
        <Spinner
          size={20}
          className="text-[var(--text-tertiary)]"
          role="status"
          aria-label={t('ccAgent.common.loading')}
        />
      )}
    </main>
  );
}
