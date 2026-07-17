/**
 * CCAgentFeature 的 Sidebar 上半内容。
 * ---------------------------------------------------------------------------
 * 产品版本：对齐 ccagent-projects-sidebar V1.7（F-PJ-1~7 P0）。
 *
 * Sidebar 上半三层结构：
 *   1. Top Actions     — "+ New" 按钮
 *   2. Sidebar Scroll  — Pinned 段 + Projects 段（含 Unclassified + Project 树）
 *   3. Section Title 由各段组件自带（"Pinned" / "Projects"）
 *
 * 折叠态：只显示 + 图标，列表整块隐藏。
 *
 * v12 (2026-04-20): Search 入口整块移除（暂无搜索功能，避免空 UI 占位）。
 *
 * F-SB-7: Session 状态指示器（运行态 + 完成通知）保持不变；
 * F-PJ-1~7：分组数据来自 useProjectGroups + useCollapsedProjects。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SchedulerEvent } from '@lizi/maker-scheduler';
import { createPortal } from 'react-dom';
import { Archive, CirclePlus, Clock, Package, Trash2, X } from 'lucide-react';
import { useNavigate, useMatch } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useCCSessions } from '@/hooks/useCCSessions';
import { useInterruptedSessionsAttention } from '@/hooks/useInterruptedSessionsAttention';
import { useSidebarCollapsedState } from '../feature-context';
import { stripTrailingPathSeparators } from '../../../shared/pathText';
import { useRefreshWorktrees } from '@/contexts/WorktreeContext';
import { SessionAttentionUrgencyProvider, useSessionAttentionUrgencySet } from './contexts/SessionAttentionUrgencyContext';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip } from '@/components/ui/tooltip';
import * as sessionService from '@/lib/sessionService';
import { makerChatStore } from '@/lib/makerChatStore';
import { clearDraft as clearComposerDraft } from '@/lib/composerDraftStore';
import { cleanupSessionLayoutPrefs } from '@/lib/sessionLayoutPrefs';
import {
  countDirtyWorktreesForRemoval,
  fetchDirtyWorktreeForRemoval,
} from '@/lib/worktreeRemovalWarning';
import { useSessionRunningStatus } from '@/hooks/useSessionRunningStatus';
import { useBackgroundActivitySessionIds } from '@/lib/sessionBackgroundActivityStore';
import { useAttachedSessionIds } from '@/hooks/useAttachedSessionIds';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useActiveMainView } from '@/hooks/useActiveMainView';
import { getNotificationsEnabled } from '@/hooks/useNotificationSettings';
import { getFeishuNotificationsEnabled } from '@/hooks/useFeishuNotificationSettings';
import { getAgentIslandEnabled, isAgentIslandSupported } from '@/hooks/useAgentIslandSettings';
import type { Session } from '@/lib/ccAgent.types';
import {
  clearSessionAttentionMany,
  clearSystemSessionAttention,
  useSessionAttentionKinds,
  useSessionAttentionSnapshot,
} from '@/lib/sessionAttentionStore';
import { patchDraft as patchNewMakerDraft } from '@/state/newMakerDraft';
import { consumePendingProjectFocus, usePendingProjectFocus } from '@/state/pendingProjectFocus';
import { requestConversationSearch } from '@/state/conversationSearchRequest';

import { emitRefresh, onPatch } from '@/lib/sessionsBus';

import { formatSidebarTime } from './lib/formatSidebarTime';
import { useProjectGroups } from './hooks/useProjectGroups';
import { useProjectAliases } from './hooks/useProjectAliases';
import { useCollapsedProjects } from './hooks/useCollapsedProjects';
import { useOrcaLeadWorkerMap } from './hooks/useOrcaLeadWorkerMap';
import { useOrcaWorkerAttentionWatcher } from './hooks/useOrcaWorkerAttentionWatcher';
import { useAutomationScheduleSessionIndex } from './hooks/useAutomationScheduleSessionIndex';
import {
  markAllScheduleRunsReadAndSync,
  markScheduleRunsReadAndSync,
} from '../scheduler/lib/scheduleRunReadSync';
import { useSessionLifecycleActions } from './hooks/useSessionLifecycleActions';
import { useSidebarFilter, type UseSidebarFilterReturn } from './hooks/useSidebarFilter';
import {
  normalizeProjectKey,
  normalizeWorkingDir,
  projectIdentityKey,
  projectIdentityKeyForSession,
  pinnedSessionIdsInDisplayOrder,
  type ProjectNode,
} from './lib/projectGrouping';
import {
  projectBulkArchiveActionForStatus,
  selectProjectBulkArchiveCandidates,
} from './lib/projectBulkArchiveAction';
import { sessionActivityMs } from './lib/dateSessionGrouping';
import { sortProjectsForSidebar, sortSessionsForSidebar } from './lib/sidebarProjectSorting';
import { isOrcaWorkerSession, resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import { PinnedSection } from './sidebar/sections/PinnedSection';
import { DialogueSection } from './sidebar/sections/DialogueSection';
import { ProjectsSection } from './sidebar/sections/ProjectsSection';
import { DateGroupedSessionsSection } from './sidebar/sections/DateGroupedSessionsSection';
import { isAutomationGeneratedSession } from './lib/scheduledSessionGrouping';
import {
  getVisibleSidebarSessionIds,
  pickSessionIdAfterRemoval,
} from './lib/sessionRemovalNavigation';
import type {
  AutomationScheduleAction,
  AutomationSessionGroup,
} from './lib/automationSidebarGrouping';
import { getSessionDeviceId } from '@/features/device-link/remoteProjectsStore';
import { useRemoteSessionActivity } from '@/features/device-link/remoteSessionActivityStore';
import { WorkdirBrowseSidebar } from './workdir-browse/WorkdirBrowseSidebar';
import { SortableList } from '@/components/sidebar/SortableList';
import {
  buildDocModeSwitchProjects,
  resolveDocModeFilesSession,
} from './workdir-browse/lib/docModeSwitchProjects';
import { ConversationSearchBox, SearchResultsBody } from './sidebar/ConversationSearchBox';
import { useConversationSearchContext } from './sidebar/conversationSearchContext';
import {
  SidebarIconButton,
  SIDEBAR_RAIL_ICON_BUTTON_CLASS,
} from '@/components/sidebar/SidebarIconButton';
import { AttentionDot } from '@/components/sidebar/AttentionDot';
import { hasSessionSelectionModifier, type SessionClickModifiers } from './sidebar/SessionItem';
import type { SessionMoveTarget } from './sidebar/sessionMoveTarget';
import {
  normalizeManualPinnedOrder,
  mergeVisibleReorder,
} from './hooks/helpers/sidebarFilterCore';
import { createLogger } from '@/lib/logger';
import { useProjectPickerOptions } from '@/hooks/useProjectPickerOptions';
import { recentWorkdirsStore } from '@/lib/recentWorkdirsStore';
import { useRemoteProjectSessions } from '@/features/device-link/remoteProjectsStore';
import {
  selectVisibleSessions,
  setSelectedMachineIdTransient,
  MACHINE_ALL,
} from '@/features/device-link/selectedMachineStore';
import {
  isDeviceLinkWriteBlocked,
  isRemoteSessionWriteBlocked,
} from './lib/remoteSessionWriteGuard';
import {
  useEffectiveSelectedMachineId,
  useSelectedMachineConnecting,
} from '@/features/device-link/useMachineSwitcher';
import {
  useDeleteScheduleWithSessions,
  type DeletedScheduleGeneratedSessionResult,
} from '@/features/scheduler/hooks/useDeleteScheduleWithSessions';

const log = createLogger('CCAgentSidebarUpper');

function makeNewMakerRouteState(workspacePrompt: 'generic' | 'dialogue') {
  return { workspacePrompt };
}

/** Last segment of a workdir path. Cross-platform safe (POSIX or Win backslash). */
function basenameOfPath(p: string): string {
  if (!p) return '';
  const norm = stripTrailingPathSeparators(p);
  const slash = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
  return slash < 0 ? norm : norm.slice(slash + 1);
}

const LAST_ACTIVITY_DAY_COUNTS: Record<
  Exclude<UseSidebarFilterReturn['lastActivity'], 'all'>,
  number
> = {
  '1d': 1,
  '3d': 3,
  '7d': 7,
  '30d': 30,
};

const DAY_MS = 24 * 60 * 60 * 1000;

type BulkSessionAction = 'archive' | 'delete';

function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function cutoffForLastActivity(
  lastActivity: UseSidebarFilterReturn['lastActivity'],
): number | null {
  if (lastActivity === 'all') return null;
  return Date.now() - LAST_ACTIVITY_DAY_COUNTS[lastActivity] * DAY_MS;
}

/* ============================== Root ============================== */

export function CCAgentSidebarUpper() {
  const { t } = useTranslation();
  const isCollapsed = useSidebarCollapsedState();
  // interrupted-turn-resume:启动时拉取「尾部停在中断标记行」的会话,补 'error' 红点。
  useInterruptedSessionsAttention();
  // F-PJ-10：filter.status 决定后端 fetch 时是否带 ?status=archived|all
  const filter = useSidebarFilter();
  const includeArchived = filter.status;
  const sessionsHook = useCCSessions({ includeArchived });
  const { sessions: allSessionsForAttention } = useCCSessions({ includeArchived: 'all' });
  const searchProjectSessions = useMemo(
    () => allSessionsForAttention.filter((s) => !isOrcaWorkerSession(s)),
    [allSessionsForAttention],
  );
  const projectAliases = useProjectAliases();
  const searchProjectGroups = useProjectGroups(searchProjectSessions, projectAliases.aliases);
  const attentionNotifications = useSessionAttentionSnapshot();
  const scheduleSessionIndex = useAutomationScheduleSessionIndex();
  // 侧栏右侧 urgent 红点的"额外"来源:定时任务未读且失败(status != 'success')。
  // sessionAttentionStore 只跟踪 chat 内 attention;schedule 未读通过 sidebarNotifications
  // 合并进 hasAttentionNotification,但 attentionKind 缺失导致默认走绿(见 SessionItem
  // 三档优先级)。这里独立算一份"失败 schedule session ids",通过 context 让 SessionItem
  // 把它们提到 urgent 红档,避免"失败的 automation 被涂成 Completed"的误导。
  const unreadFailedScheduleSessionIds = useMemo(() => {
    const next = new Set<string>();
    for (const [sessionId, info] of scheduleSessionIndex) {
      if (info.hasUnreadFailedRun) next.add(sessionId);
    }
    return next;
  }, [scheduleSessionIndex]);
  const navigate = useNavigate();
  const automationAttentionSessionIds = useMemo(
    () =>
      allSessionsForAttention
        .filter(
          (s) =>
            isAutomationGeneratedSession(s) &&
            (attentionNotifications.has(s.id) ||
              scheduleSessionIndex.get(s.id)?.hasUnreadRun === true),
        )
        .map((s) => s.id),
    [allSessionsForAttention, attentionNotifications, scheduleSessionIndex],
  );
  // automationAttentionSessionIds 仅供下方「全部标为已读」右键菜单使用;导航栏 /
  // rail 的自动化入口不再显示未读 dot(未读 / 运行状态改由各 schedule 组头承载)。

  // Automations 按钮右键菜单：复用 TaskListCell 的 "controlled DropdownMenu + 不可见 trigger 跟坐标"模式，
  // state 提到 root —— 折叠/展开两个视图都用同一个 button 概念,菜单只渲染一次,避免两份重复 state。
  const [automationsMenuPos, setAutomationsMenuPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const handleAutomationsContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setAutomationsMenuPos({ x: e.clientX, y: e.clientY });
  }, []);
  const handleMarkAllAutomationsRead = useCallback(async () => {
    setAutomationsMenuPos(null);
    // 用户显式「全部标为已读」:explicit,允许连未读 error 一起清。
    clearSessionAttentionMany(automationAttentionSessionIds, { intent: 'explicit' });
    try {
      const updated = await markAllScheduleRunsReadAndSync();
      if (updated > 0) {
        toast.success(t('ccAgent.layout.markedAsRead', { count: updated }));
      }
    } catch (e) {
      toast.error(
        t('ccAgent.layout.markAllReadFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }, [automationAttentionSessionIds, t]);

  // Sidebar is rendered outside the :sessionId route, so useParams won't work.
  // Use useMatch to extract the active session id from the URL.
  const match = useMatch('/cc-agent/:sessionId');
  const orcaMatch = useMatch('/cc-agent/orca/:sessionId');
  const activeSessionId = orcaMatch?.params.sessionId ?? match?.params.sessionId;

  // Workdir-browse mode (skillhub Market sidebar pattern). When the user
  // clicked the file-text button on a Project, we swap sidebar contents to
  // the lazy file tree of that session's workdir.
  const filesMatch = useMatch('/cc-agent/files/:sessionId');
  const filesSessionId = filesMatch?.params.sessionId;
  const filesSession = useMemo(
    () => resolveDocModeFilesSession(allSessionsForAttention, filesSessionId),
    [allSessionsForAttention, filesSessionId],
  );
  const docModeSwitchProjects = useMemo(() => {
    const switchableSessions = allSessionsForAttention.filter((s) => !isOrcaWorkerSession(s));
    return buildDocModeSwitchProjects(switchableSessions);
  }, [allSessionsForAttention]);
  const filesProjectKey = filesSession ? projectIdentityKeyForSession(filesSession) : null;

  // Refresh sessions only when a NEW session appears (e.g. after index redirect
  // creates a new session via its own hook instance). Clicking an existing
  // session in the list must NOT trigger a list refresh (avoids updatedAt re-sort).
  const { refreshSessions } = sessionsHook;
  const prevSessionRef = useRef(activeSessionId);
  useEffect(() => {
    if (activeSessionId && activeSessionId !== prevSessionRef.current) {
      prevSessionRef.current = activeSessionId;
      // Only refresh if the new session isn't already in the list (= just created)
      const isInList = sessionsHook.sessions.some((s) => s.id === activeSessionId);
      if (!isInList) {
        refreshSessions();
      }
    }
  }, [activeSessionId, refreshSessions, sessionsHook.sessions]);

  // rail / reorder 与展开态(ExpandedView)同口径:都把 device-link 远程会话并进来——
  // 否则置顶的远程会话一拖进 rail 模式就消失、也无法从 rail 打开(codex review)。
  // 机器切换栏选中某机器后按 selectedMachineId 整体过滤(本机 → 只本地;远程 → 只该机器),
  // rail 与展开态共用同一选择态,保证 rail 折叠后仍尊重选中机器。
  const remoteProjectSessions = useRemoteProjectSessions();
  const selectedMachineId = useEffectiveSelectedMachineId();
  const sessionsWithRemote = useMemo(
    () => selectVisibleSessions(sessionsHook.sessions, remoteProjectSessions, selectedMachineId),
    [sessionsHook.sessions, remoteProjectSessions, selectedMachineId],
  );

  // rail 未读集与展开态(ExpandedView.sidebarNotifications)同口径:把"定时任务有未读运行"的
  // 会话并入 attention 未读集。否则 rail 模式下,靠 scheduleSessionIndex 恢复的定时任务
  // 完成未读(如重启后 attention store 还没填充)会丢绿点(codex review)。
  const railNotifications = useMemo(() => {
    const unread = new Set<string>();
    for (const [sessionId, info] of scheduleSessionIndex) {
      if (info.hasUnreadRun) unread.add(sessionId);
    }
    if (unread.size === 0) return attentionNotifications;
    return new Set([...attentionNotifications, ...unread]);
  }, [attentionNotifications, scheduleSessionIndex]);

  // rail(折叠态)置顶瓷砖拖拽落定 —— 与展开态共用同一份 manualPinnedOrder
  // (ExpandedView.handlePinnedReorder 同口径)。fullActivePinnedIds 取**未过滤**的全量活跃置顶
  // (本地 + 全部远程,不受机器切换栏选择影响),再把可见子集的新顺序原位 merge 回完整顺序 ——
  // 否则按选中机器过滤时拖拽,会把其它机器的置顶项从持久化顺序里丢掉(切回「所有」即乱序)。
  const handleRailPinnedReorder = useCallback(
    (visibleNewOrder: string[]) => {
      // baseline 必须与置顶段同序(pinnedSessionIdsInDisplayOrder 内部按 status→pinnedAt desc 排,
      // 含归档置顶),否则首次过滤态拖拽、manualPinnedOrder 还空时,隐藏置顶项会因 baseline 顺序不符而跳位。
      const fullActivePinnedIds = pinnedSessionIdsInDisplayOrder([
        ...sessionsHook.sessions,
        ...remoteProjectSessions,
      ]);
      const merged = mergeVisibleReorder(
        normalizeManualPinnedOrder(filter.manualPinnedOrder, fullActivePinnedIds),
        visibleNewOrder,
      );
      filter.setManualPinnedOrder(merged, fullActivePinnedIds);
    },
    [sessionsHook.sessions, remoteProjectSessions, filter],
  );

  useOrcaWorkerAttentionWatcher(sessionsHook.sessions, activeSessionId);

  return (
    // F-PJ-7 Tooltip.Provider 顶层包一次：所有 SessionItem / ProjectNode / Toggle 共享 500ms delay。
    // skipDelayDuration 放宽到 1500ms(默认 200):tip 弹出过之后在列表行间移动
    // 保持"热态"即时切换——PR tips 行间穿插着无 tip 的普通行,默认窗口太短,
    // 路过几行热态就丢了,体感退回"每行都要重新等 500ms"(session-git-pr-context)。
    <Tooltip.Provider skipDelayDuration={1500}>
      <SessionAttentionUrgencyProvider urgentSessionIds={unreadFailedScheduleSessionIds}>
      <div className="relative flex flex-1 flex-col overflow-hidden">
        {/* Expanded — fade out when collapsed.
          min-w-0 让内层跟着外层 aside 的实际宽度走，配合 SessionItem 里的
          `min-w-0 flex-1 truncate` 才能正确截断。原来写死 min-w-[260px] 是
          为了避免 collapse 动画期间 text reflow，但当用户把侧边栏拖到
          260 以下时，这个固定宽会让内容超出可视区被 overflow-hidden 砍掉，
          表现为 SessionItem 文字被右侧裁切。 */}
        <div
          className={cn(
            'absolute inset-0 min-w-0 flex flex-col overflow-hidden',
            'transition-opacity duration-200 ease-in-out',
            isCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100',
          )}
        >
          {/* SSH remote 会话不再被排除:WorkdirBrowseSidebar 已支持 remoteHostId
              (P1 解禁),旧门控留着会让 doc 模式对 SSH 会话退回项目列表、无
              远端文件树入口。 */}
          {filesSession && filesSession.workingDir ? (
            <WorkdirBrowseSidebar
              sessionId={filesSession.id}
              workdir={filesSession.workingDir}
              remoteHostId={filesSession.remoteHostId ?? null}
              deviceId={getSessionDeviceId(filesSession.id) ?? null}
              displayName={basenameOfPath(filesSession.workingDir)}
              projectKey={filesProjectKey}
              switchProjects={docModeSwitchProjects}
            />
          ) : (
            <ExpandedView
              sessionsHook={sessionsHook}
              navigate={navigate}
              activeSessionId={activeSessionId}
              filter={filter}
              projectAliases={projectAliases}
              scheduleSessionIndex={scheduleSessionIndex}
            />
          )}
        </div>

        {/* Collapsed — fade in when collapsed */}
        <div
          className={cn(
            'absolute inset-0 flex flex-col overflow-hidden',
            'transition-opacity duration-200 ease-in-out',
            isCollapsed ? 'opacity-100' : 'opacity-0 pointer-events-none',
          )}
        >
          <CollapsedView
            navigate={navigate}
            onAutomationsContextMenu={handleAutomationsContextMenu}
            allSearchProjects={searchProjectGroups.projects}
            sessions={sessionsWithRemote}
            activeSessionId={activeSessionId}
            notifications={railNotifications}
            manualPinnedOrder={filter.manualPinnedOrder}
            onReorder={handleRailPinnedReorder}
          />
        </div>

        {/* Automations 按钮右键菜单 —— 折叠/展开两份按钮共用此渲染。trigger 跟着 click 坐标定位。 */}
        <DropdownMenu
          open={automationsMenuPos !== null}
          onOpenChange={(open) => {
            if (!open) setAutomationsMenuPos(null);
          }}
        >
          <DropdownMenuTrigger asChild>
            <span
              aria-hidden
              style={{
                position: 'fixed',
                left: automationsMenuPos?.x ?? 0,
                top: automationsMenuPos?.y ?? 0,
                width: 0,
                height: 0,
                pointerEvents: 'none',
              }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            sideOffset={2}
            className={cn(
              'min-w-[180px] rounded-xl p-1 overflow-hidden',
              'bg-[var(--cmd-palette-bg)]',
              'border border-[var(--cmd-palette-border)]',
              'shadow-[var(--shadow-menu)]',
            )}
          >
            <DropdownMenuItem
              onSelect={() => void handleMarkAllAutomationsRead()}
              className="cursor-pointer text-sm text-[var(--msg-assistant-text)] hover:bg-[var(--cmd-palette-item-hover)]"
            >
              {t('ccAgent.layout.markAllAsRead')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      </SessionAttentionUrgencyProvider>
    </Tooltip.Provider>
  );
}

/* ============================== Types ============================== */

type SessionsHook = ReturnType<typeof useCCSessions>;

/* ============================== Expanded ============================== */

interface ExpandedProps {
  sessionsHook: SessionsHook;
  navigate: ReturnType<typeof useNavigate>;
  activeSessionId: string | undefined;
  filter: UseSidebarFilterReturn;
  projectAliases: ReturnType<typeof useProjectAliases>;
  scheduleSessionIndex: ReturnType<typeof useAutomationScheduleSessionIndex>;
}

/** State for the delete/archive confirm dialog. */
interface ConfirmState {
  open: boolean;
  sessionId: string;
  action: 'delete' | 'archive';
  /** P1: 会话 worktree 有未提交更改 → 确认文案追加警告(打开前预检)。 */
  dirtyWorktree: boolean;
}

const CONFIRM_INITIAL: ConfirmState = {
  open: false,
  sessionId: '',
  action: 'delete',
  dirtyWorktree: false,
};

function ExpandedView({
  sessionsHook,
  navigate,
  activeSessionId,
  filter,
  projectAliases,
  scheduleSessionIndex,
}: ExpandedProps) {
  const { t } = useTranslation();
  const { sessions, refreshSessions, patchLocal, effectiveIncludeArchived } = sessionsHook;
  const refreshWorktrees = useRefreshWorktrees();
  const projectPickerOptions = useProjectPickerOptions();

  // 自动化任务本身仍在顶部 Automations 入口管理；自动化任务 fire 后创建出的
  // session 是普通会话,按 project/dialogue 与普通排序/红点逻辑进入 sidebar。
  const onScheduleMatch = useMatch('/cc-agent/scheduled');
  // SidebarTopNav 的“+ New”导航到 /cc-agent/new,而本组件跨 draft 路由常驻挂载,
  // 它不像项目内/对话内新建那样先清选择;据此在落到新建页时清掉残留的批量选择,
  // 避免批量操作条停留在 new-maker 屏上(PR #246 review)。对齐下方 onScheduleMatch 清理。
  const onNewMakerMatch = useMatch('/cc-agent/new');
  // "在此项目内搜索":搜索框已上移到 shell 的 SidebarTopNav,经全局 store 通信
  // (内部自增 requestId,SidebarTopNav 的搜索框据此打开并锁定该 project)。
  const handleOpenConversationSearch = useCallback((project: ProjectNode) => {
    requestConversationSearch({
      projectKey: project.projectKey,
      projectName: project.displayName,
      sessionIds: project.sessions.map((session) => session.id),
    });
  }, []);
  // Archived All（右键菜单）走全局 ConfirmDialogProvider —— 与单条 archive 的 inline
  // ConfirmDialog 解耦，避免共用 confirm state 时语义混乱。
  const { confirm: confirmDialog } = useConfirmDialog();
  const handleScheduleDeleted = useCallback(
    async ({ disposition, affectedSessionIds }: DeletedScheduleGeneratedSessionResult) => {
      await refreshSessions();
      void refreshWorktrees();
      if (
        disposition !== 'keep' &&
        activeSessionId &&
        affectedSessionIds.includes(activeSessionId)
      ) {
        navigate('/cc-agent');
      }
    },
    [activeSessionId, navigate, refreshSessions, refreshWorktrees],
  );
  const { requestDeleteSchedule, deleteScheduleDialog } = useDeleteScheduleWithSessions({
    onDeleted: handleScheduleDeleted,
  });

  const pendingRunCleanupsRef = useRef<Map<string, () => void>>(new Map());
  // busy guard：fired 事件到达前阻止同 schedule 重复调用 runNow，避免双发 run/session。
  const pendingRunNowIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    return () => {
      pendingRunCleanupsRef.current.forEach((c) => c());
      pendingRunCleanupsRef.current.clear();
      pendingRunNowIdsRef.current.clear();
    };
  }, []);

  const handleScheduleAction = useCallback(
    async (group: AutomationSessionGroup, action: AutomationScheduleAction) => {
      if (!group.scheduleId) return;
      const scheduleId = group.scheduleId;
      const scheduleName = group.title;

      if (action === 'edit') {
        navigate(`/cc-agent/scheduled?focus=${encodeURIComponent(scheduleId)}&edit=${Date.now()}`);
        return;
      }

      if (action === 'run') {
        // [必改] per-schedule busy guard：fired 事件到达前阻止同 schedule 重复调用
        // runNow，避免双发 run/session，对齐 SchedulerPage 的 per-schedule busy 语义。
        if (pendingRunNowIdsRef.current.has(scheduleId)) return;
        pendingRunNowIdsRef.current.add(scheduleId);
        // 取消同一 schedule 的旧订阅，避免双击竞态
        pendingRunCleanupsRef.current.get(scheduleId)?.();
        // [必改] 关键时序：fired 事件在 runner.fire 中（session 创建前）触发，携带
        // runId；session-bound 随后到达，携带相同 runId + sessionId。先订阅事件：
        // (1) 收到 fired → 捕获 runId，释放 busy guard（允许用户再次点击）
        // (2) 收到 session-bound（runId 匹配）→ 导航到新 session
        // capturedRunId 为 null 时不导航，避免接受旧 run 的 session-bound 事件。
        // 15s 兜底超时，失败/静默/不 bind 场景不挂订阅。
        let capturedRunId: string | null = null;
        let done = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const cleanup = () => {
          if (done) return;
          done = true;
          pendingRunCleanupsRef.current.delete(scheduleId);
          pendingRunNowIdsRef.current.delete(scheduleId);
          off();
          if (timer) clearTimeout(timer);
        };
        const off = window.electronAPI.maker.schedule.onEvent((raw) => {
          const event = raw as SchedulerEvent;
          if (done) return;
          // 'all-read' 和 'ready' 是全局事件，不含 scheduleId，提前过滤。
          if (event.type === 'all-read' || event.type === 'ready') return;
          if (event.scheduleId !== scheduleId) return;
          if (event.type === 'fired') {
            // 捕获本次 run 的 runId，并释放 busy guard（run 已 fire，允许用户再次点击）
            capturedRunId = event.runId;
            pendingRunNowIdsRef.current.delete(scheduleId);
            return;
          }
          if (event.type !== 'session-bound') return;
          if (!event.sessionId) return;
          // fired 未到达前 capturedRunId 为 null，不导航（避免接受旧 run 的事件）
          if (capturedRunId === null) return;
          if (event.runId !== capturedRunId) return;
          const sessionId = event.sessionId;
          cleanup();
          void (async () => {
            const target = sessionsRef.current.find((s) => s.id === sessionId);
            navigate(await resolveSessionRoute(sessionId, target));
          })();
        });
        timer = setTimeout(cleanup, 15_000);
        pendingRunCleanupsRef.current.set(scheduleId, cleanup);
        try {
          await window.electronAPI.maker.schedule.runNow(scheduleId);
          // runNow 已成功返回但 session-bound 未在此期间到达（run 被 defer/skip）:
          // 立即清理，避免 15s 窗口内同 schedule 的其他 session-bound 触发误导航。
          // cleanup() 内部有 done guard —— 若 session-bound 已被处理，此调用为 no-op。
          cleanup();
        } catch (e) {
          cleanup();
          toast.error(
            t('scheduler.toast.runFailed', { error: e instanceof Error ? e.message : String(e) }),
          );
        }
        return;
      }

      if (action === 'toggle-pause') {
        try {
          if (group.scheduleStatus === 'paused') {
            await window.electronAPI.maker.schedule.resume(scheduleId);
            return;
          }
          if (group.scheduleStatus === 'expired') return;
          const inflight = await window.electronAPI.maker.schedule
            .getInflightCount(scheduleId)
            .catch(() => 0);
          if (inflight > 0) {
            const ok = await confirmDialog({
              title: t('scheduler.confirm.pause.title', { name: scheduleName }),
              description: t('scheduler.confirm.pause.withInflight', { count: inflight }),
              confirmText: t('scheduler.confirm.pause.confirm'),
              cancelText: t('scheduler.confirm.pause.cancel'),
            });
            if (!ok) return;
          }
          await window.electronAPI.maker.schedule.pause(scheduleId);
        } catch (e) {
          toast.error(
            t('scheduler.toast.actionFailed', {
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        }
        return;
      }

      requestDeleteSchedule({
        id: scheduleId,
        name: scheduleName,
        source: group.scheduleSource,
        workingDir: group.workingDir,
        projectConfigId: group.projectConfigId,
        knownSessionIds: group.sessions.map((session) => session.id),
      });
    },
    [confirmDialog, navigate, requestDeleteSchedule, t],
  );

  const [confirm, setConfirm] = useState<ConfirmState>(CONFIRM_INITIAL);

  // 系统级通知触发：sessions 数组每次渲染都新引用，但 hook 用 ref 转储 callback，
  // 不会因此重跑 transition effect。
  // 静音 + 失焦 gate 在这里，主进程不持有 enabled 状态。
  // Dock/taskbar 角标不是外发通知通道：App 在后台时即使桌面/飞书通知关闭,
  // 也要标记当前 session 需要关注；真正的 toast / 飞书仍然服从各自开关。
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const fireSessionNotification = useCallback((sessionId: string, kind: 'done' | 'error' | 'needs-reply') => {
    // 灵动岛启用时,完成提示由灵动岛承载,不再走系统 toast,避免同一事件双重打扰;
    // 灵动岛未启用(或平台不支持)时,继续用系统通知。飞书是独立外发通道,不受影响。
    const islandActive = isAgentIslandSupported() && getAgentIslandEnabled();
    const desktopEnabled = getNotificationsEnabled() && !islandActive;
    const feishuEnabled = getFeishuNotificationsEnabled();
    // 失焦才推 —— 见上注释。
    if (typeof document !== 'undefined' && document.hasFocus()) return;
    const session = sessionsRef.current.find((s) => s.id === sessionId);
    // Orca worker 自身状态翻转不发独立通知 —— 等 lead 接到 worker_report 处理完
    // 再以 lead 名义统一推一条，避免同一事件双重打扰。语义上用户应回到 lead 主对话
    // 查看，而非跳到 worker 实现细节；与 effectiveRunningSessionIds 的角色聚合口径一致。
    if (session && isOrcaWorkerSession(session)) return;
    void window.electronAPI.notificationMarkSessionAttention(sessionId);
    if (!desktopEnabled && !feishuEnabled) return;
    const title = session?.title ?? '';
    void window.electronAPI.notificationShowSessionEvent({
      sessionId,
      title,
      kind,
      channels: { desktop: desktopEnabled, feishu: feishuEnabled },
    });
  }, []);
  const handleSessionDone = useCallback(
    (sessionId: string) => fireSessionNotification(sessionId, 'done'),
    [fireSessionNotification],
  );
  const handleSessionError = useCallback(
    (sessionId: string) => fireSessionNotification(sessionId, 'error'),
    [fireSessionNotification],
  );
  const handleSessionNeedsReply = useCallback(
    (sessionId: string) => fireSessionNotification(sessionId, 'needs-reply'),
    [fireSessionNotification],
  );

  // /ctr 接管中的 sessionIds 集合 — SessionItem 用这个把左侧 vendor icon
  // 切成 RadioTower (radio-tower) 表"被远程接管"。detach 后自动切回 vendor。
  const attachedSessionIds = useAttachedSessionIds();

  // F-SB-7: Session status indicators — running state + attention notifications
  const { runningSessionIds, notifications, clearNotification } = useSessionRunningStatus(
    activeSessionId,
    {
      onSessionDone: handleSessionDone,
      onSessionError: handleSessionError,
      onSessionNeedsReply: handleSessionNeedsReply,
    },
  );
  const unreadScheduleSessionIds = useMemo(() => {
    const next = new Set<string>();
    for (const [sessionId, info] of scheduleSessionIndex) {
      if (info.hasUnreadRun) next.add(sessionId);
    }
    return next;
  }, [scheduleSessionIndex]);
  const sidebarNotifications = useMemo(() => {
    if (unreadScheduleSessionIds.size === 0) return notifications;
    return new Set([...notifications, ...unreadScheduleSessionIds]);
  }, [notifications, unreadScheduleSessionIds]);

  const markAutomationSessionRunsRead = useCallback(
    (sessionId: string) => {
      const info = scheduleSessionIndex.get(sessionId);
      if (!info?.unreadRunIds.length) return;
      // …AndSync:settle 后无条件触发 renderer 本地刷新。跨实例场景下这些 runId
      // 可能在 DB 里早已被另一实例标为已读(main no-op 且不广播),没有本地刷新
      // 通道的话,这里的过期未读快照永远等不到事件、红点无法自愈。
      void markScheduleRunsReadAndSync(info.unreadRunIds);
    },
    [scheduleSessionIndex],
  );
  const orcaLeadWorkerMap = useOrcaLeadWorkerMap(sessions);
  const effectiveRunningSessionIds = useMemo(() => {
    const next = new Set(runningSessionIds);
    for (const [leadSessionId, workerSessionIds] of orcaLeadWorkerMap) {
      for (const workerSessionId of workerSessionIds) {
        if (runningSessionIds.has(workerSessionId)) {
          next.add(leadSessionId);
          break;
        }
      }
    }
    return next;
  }, [orcaLeadWorkerMap, runningSessionIds]);
  // 后台子任务活跃会话(turn 已结束但 CC 子进程仍在调模型)也点亮同一个呼吸指示。
  // 单独一个**纯视觉**集合:effectiveRunningSessionIds 除了喂列表显示还是
  // handleMoveSession 的运行中拦截闸门,后台活动不得静默扩大行为闸门的口径
  // (move / 归档 / 通知语义都保持只认真 running)。
  const backgroundActivitySessionIds = useBackgroundActivitySessionIds();
  const displayRunningSessionIds = useMemo(() => {
    if (backgroundActivitySessionIds.size === 0) return effectiveRunningSessionIds;
    const next = new Set(effectiveRunningSessionIds);
    for (const id of backgroundActivitySessionIds) next.add(id);
    for (const [leadSessionId, workerSessionIds] of orcaLeadWorkerMap) {
      if (next.has(leadSessionId)) continue;
      for (const workerSessionId of workerSessionIds) {
        if (backgroundActivitySessionIds.has(workerSessionId)) {
          next.add(leadSessionId);
          break;
        }
      }
    }
    return next;
  }, [effectiveRunningSessionIds, backgroundActivitySessionIds, orcaLeadWorkerMap]);

  // 关键：用 effectiveIncludeArchived（snapshot 实际所属桶）而非 filter.status
  // 决定是否做客户端过滤——
  //   · effectiveIncludeArchived === 'all'  → 桶含所有 status,
  //                                            按 user 选中的 filter.status 收窄
  //   · 其它(active/archived 单 status 桶) → 桶内本应全是同一 status,
  //                                            按桶 status 收窄即可
  // 这样 user 点 status chip 后, sidebar 列表跟着 snapshot 一起切，
  // 不会出现「user filter 立刻变 → 旧桶按新 filter 过滤后全空 → 新桶到才回填」
  // 的空白帧。filter.status 仍只用于 chip 高亮和 IPC 桶决策。
  //
  // 单 status 桶为何要按桶 status 显式过滤(而不是直接信任桶内全是同 status):
  // patchLocal 是跨桶 in-place mutation —— doc 模式归档(WorkdirBrowseRoute)
  // 用自己的 'all' 桶 refresh, sidebar 持有的 'active' 桶不会被刷,
  // patchLocal 留下的 status='archived' 污染就一直挂在 active 桶里,
  // 没有这道过滤就会带着 Archive 图标漏到 project 列表里。
  // device-link 跨设备远程控制:被控设备的会话(内存层,已打 deviceLinkDeviceId 标记)
  // 与本地会话一视同仁并入同一份列表 → groupSessions 自动归到独立 device: 远程项目。
  // 远端会话不在本地 DB,故走独立 store,不污染 sessionsStore / 本地链路。
  const remoteProjectSessions = useRemoteProjectSessions();
  // 机器切换栏选中机器后整体过滤:本机 → 只本地会话;远程 → 只该机器会话。
  // 过滤在源头做,下游 grouping / pinned / projects / dialogues / date-grouped / search 自动继承。
  const selectedMachineId = useEffectiveSelectedMachineId();
  // 选中的远程机器尚在连接中(会话未同步)→ 用「连接中」占位替换空列表的「暂无对话」。
  const selectedMachineConnecting = useSelectedMachineConnecting();
  // orca worker + status 过滤(**不含**机器过滤)—— 抽出给「机器过滤后渲染」与「全量项目宇宙」共用。
  const passesOrcaAndStatus = useCallback(
    (s: Session) => {
      if (isOrcaWorkerSession(s)) return false;
      if (effectiveIncludeArchived === 'all') {
        if (filter.status !== 'all' && s.status !== filter.status) return false;
      } else if (s.status !== effectiveIncludeArchived) {
        return false;
      }
      return true;
    },
    [filter.status, effectiveIncludeArchived],
  );
  const sidebarSessions = useMemo(
    () =>
      selectVisibleSessions(sessions, remoteProjectSessions, selectedMachineId).filter(
        passesOrcaAndStatus,
      ),
    [sessions, remoteProjectSessions, selectedMachineId, passesOrcaAndStatus],
  );

  const activityFilteredSessions = useMemo(() => {
    const cutoff = cutoffForLastActivity(filter.lastActivity);
    if (cutoff === null) return sidebarSessions;
    return sidebarSessions.filter((s) => sessionActivityMs(s) >= cutoff);
  }, [sidebarSessions, filter.lastActivity]);

  /* ---- Grouping & collapse ---- */
  const allGroups = useProjectGroups(sidebarSessions, projectAliases.aliases);
  const groups = useProjectGroups(activityFilteredSessions, projectAliases.aliases);
  const activeWorkingDirs = useMemo(
    () => allGroups.projects.map((p) => p.projectKey),
    [allGroups.projects],
  );
  const collapse = useCollapsedProjects(activeWorkingDirs);

  // 项目过滤 GC 的「宇宙」用**全量**(不按机器过滤)项目键 —— 否则在某机器作用域下 remount,
  // gcProjectsAgainstActive 会把其它机器的项目从已保存的项目过滤里误删(它们只是被切换栏隐藏、
  // 并非不存在;codex)。collapse 仍用机器过滤后的 activeWorkingDirs(collapseAll / isAllCollapsed
  // 针对当前可见项目),渲染也仍走机器过滤后的 allGroups / groups。
  const unfilteredProjectSessions = useMemo(
    () => [...sessions, ...remoteProjectSessions].filter(passesOrcaAndStatus),
    [sessions, remoteProjectSessions, passesOrcaAndStatus],
  );
  const projectUniverse = useProjectGroups(unfilteredProjectSessions, projectAliases.aliases);

  // 内联会话搜索:输入行在 SidebarTopNav 的第 4 行,状态经 ConversationSearchProvider 共享;
  // 这里只取 search 来渲染下方的结果 overlay(query 非空时盖住置顶 + 项目 + 对话)。
  const { search } = useConversationSearchContext();
  const gcProjectKeys = useMemo(
    () => projectUniverse.projects.map((p) => p.projectKey),
    [projectUniverse.projects],
  );

  /* ---- cindy://project/<workingDir>(历史 xdt-maker:// 同)深度链接消费 ----
   * MainLayout 在收到 deep-link payload 后调 requestProjectFocus(workingDir),
   * 这里订阅 pending 信号, 等 sessions 加载到位再决定 expand / scroll / toast。
   *
   * 等待时序: sessions 还在 fetch (isLoading=true) 时不动作, effect 在
   * groups.projects 变化时会再跑一次。loaded 之后:
   *   - workingDir 命中 → collapse.expand + scrollIntoView + consume
   *   - 不命中但被机器切换栏过滤掉了 → 先回落「所有」再判定(不消费,等 effect 重跑)
   *   - 仍不命中 → toast 提示 + consume(避免 effect 循环)
   */
  const pendingFocus = usePendingProjectFocus();
  const isLoadingSessions = sessionsHook.isLoading;
  useEffect(() => {
    if (!pendingFocus) return;
    if (isLoadingSessions) return; // 等首次加载完
    const targetDir = pendingFocus.workingDir;
    const targetKey = normalizeProjectKey(targetDir) ?? `local:${targetDir}`;
    const exists = groups.projects.some((p) => p.projectKey === targetKey);
    if (exists) {
      collapse.expand(targetKey);
      // RAF 等 expand 触发的 re-render 完成 (project header DOM 在折叠态下已渲染,
      // 这里 RAF 主要给"刚 mount"的场景一帧时间让 querySelector 拿到节点)。
      requestAnimationFrame(() => {
        const node = document.querySelector(`[data-project-workingdir="${CSS.escape(targetKey)}"]`);
        if (node) node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    } else if (selectedMachineId !== MACHINE_ALL) {
      // 目标项目可能在别的机器 / 本机,被机器切换栏过滤掉了 —— 深链是「跳到这个项目」的明确意图,
      // 应越过当前过滤:回落「所有」让它重新可见,**不消费**;selectedMachineId 变 → groups.projects
      // 重算 → 本 effect 重跑,这次命中就 expand+scroll,真不存在才走下面的 toast 分支。
      // 走 Transient(只改内存不落盘):这是系统性回落、不是用户对勾选集的表态,
      // 不能把用户持久化的机器多选集永久冲掉(重启后仍恢复原勾选)。
      setSelectedMachineIdTransient(MACHINE_ALL);
      return;
    } else {
      toast.warning(t('ccAgent.sidebar.deepLink.projectNotFound'));
    }
    consumePendingProjectFocus();
  }, [pendingFocus, groups.projects, collapse, isLoadingSessions, selectedMachineId, t]);

  /* ---- 自动展开：首条消息把 session 从未分类挪进 Project 时，
   *      若目标 Project 当前折叠，幂等展开它，避免新会话视觉上"消失"。
   *      触发条件：cc-session-patch 携带 workingDir（chatStore 只在 wasFirst
   *      时才把 workingDir 塞进 patch，正好对应"首次入组"时刻）。
   */
  useEffect(
    () =>
      onPatch((id, patch) => {
        if (!patch.workingDir) return;
        const dir = normalizeWorkingDir(patch.workingDir);
        // remoteHostId 优先用 patch 自带(chatStore 在 wasFirst 时透传);缺失时从最新
        // sessions 兜底查 —— 走 sessionsRef 读最新值,避免把 sessions 放进 deps 导致每条
        // 消息/状态 tick 都重订阅(busy 会话下开销可观)。
        const sessionRemoteHostId =
          patch.remoteHostId ?? sessionsRef.current.find((s) => s.id === id)?.remoteHostId ?? null;
        if (dir != null) {
          collapse.expand(
            projectIdentityKey(sessionRemoteHostId ? 'remote' : 'local', dir, sessionRemoteHostId),
          );
        }
      }),
    [collapse],
  );

  /* ---- F-PJ-10: filter GC ----
   * 等"至少 1 个 project 出现"再触发一次 filter.gc(activeWorkingDirs) 即可 ——
   * 这一条件天然蕴含"sessions 已加载"。ref guard 保证只跑一次
   * （ADR-6：避免循环依赖，GC 由编排层显式触发）。
   */
  const gcDoneRef = useRef(false);
  useEffect(() => {
    if (gcDoneRef.current) return;
    if (projectUniverse.projects.length === 0) return;
    // 用**全量**项目键 GC,不用机器过滤后的 activeWorkingDirs —— 否则某机器作用域下会把其它机器的
    // 项目从已保存的项目过滤里误删(它们只是被隐藏、并非不存在)。
    filter.gc(gcProjectKeys);
    gcDoneRef.current = true;
  }, [projectUniverse.projects.length, gcProjectKeys, filter]);

  /* ---- F-PJ-10: 在 render 阶段把 filter.projects 应用到 ProjectNode 列表 ---- */
  const visibleProjects = useMemo(() => {
    if (filter.projectsAsSet === null) return groups.projects;
    const allowed = filter.projectsAsSet;
    return groups.projects.filter((p) => allowed.has(p.projectKey));
  }, [groups.projects, filter.projectsAsSet]);

  // PinnedSection 的 projectsFilter 入参（'all' | ReadonlySet<string>）
  const pinnedFilter = filter.projectsAsSet ?? 'all';

  /* ---- M41: Vendor 过滤 — 应用到 pinned / unclassified / project sessions ---- */
  const vendorPredicate = useMemo(() => {
    if (filter.vendor === 'all') return null;
    const v = filter.vendor;
    return (s: { agentKind?: string | null }) => (s.agentKind ?? 'cc') === v;
  }, [filter.vendor]);

  const visiblePinned = useMemo(() => {
    // 置顶段用 allGroups.pinned(未经"最近活跃 N 天"筛选)——置顶内容不受活跃时间过滤影响,
    // 久未活跃的置顶会话也始终显示。vendor / project 过滤仍照常生效。
    const base = vendorPredicate ? allGroups.pinned.filter(vendorPredicate) : allGroups.pinned;
    // 应用 manualPinnedOrder：出现在 order 中的按其下标稳定排前面（保持用户拖出的次序 +
    // pin 时由 promotePin 主动塞到首位的新置顶）；不在 order 中的（升级前残留 pinned 没被
    // 新版 pin 路径触达）落到末尾，维持 base 自带的 status→pinnedAt desc。
    // manualPinnedOrder 为空（用户从未拖过 + 没在新版 pin 过）→ 直接退回原 base 顺序，零开销。
    const order = filter.manualPinnedOrder;
    if (order.length === 0) return base;
    const rank = new Map<string, number>();
    order.forEach((id, idx) => rank.set(id, idx));
    return base.slice().sort((a, b) => {
      const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return ra - rb;
    });
  }, [allGroups.pinned, vendorPredicate, filter.manualPinnedOrder]);

  const visibleUnclassified = useMemo(() => {
    const sessions = vendorPredicate
      ? groups.unclassified.filter(vendorPredicate)
      : groups.unclassified;
    return sortSessionsForSidebar(sessions, filter.sortBy);
  }, [groups.unclassified, vendorPredicate, filter.sortBy]);

  const visibleDialogues = useMemo(() => {
    return vendorPredicate ? groups.dialogues.filter(vendorPredicate) : groups.dialogues;
  }, [groups.dialogues, vendorPredicate]);

  const visibleProjectsWithVendor = useMemo(() => {
    const projects = vendorPredicate
      ? visibleProjects
          .map((p) => ({ ...p, sessions: p.sessions.filter(vendorPredicate) }))
          .filter((p) => p.sessions.length > 0)
      : visibleProjects;
    return sortProjectsForSidebar(projects, filter.sortBy, filter.manualProjectOrder);
  }, [visibleProjects, vendorPredicate, filter.sortBy, filter.manualProjectOrder]);

  /**
   * Pinned 拖拽落定回调。SortableList 给的是当前 visible（含 vendor / projectsFilter
   * 过滤 + manualPinnedOrder 应用后）段内的新顺序 id 列表。
   *
   * fullActivePinnedIds 取**未过滤**的全量活跃置顶（本地 sessions + 全部远程，不受机器切换栏 /
   * vendor 过滤影响），让 normalizeManualPinnedOrder 顺手 GC 掉已取消置顶 / 已删除的旧 id；再用
   * mergeVisibleReorder 把可见子集的新顺序**原位** merge 回完整顺序 —— 不可见的置顶项（其它机器 /
   * vendor）保持原位:既不丢失（修 #331 机器过滤引入的持久化顺序丢失），也不被挪到末尾。
   */
  const handlePinnedReorder = useCallback(
    (visibleNewOrder: string[]) => {
      // baseline 与置顶段同序(pinnedSessionIdsInDisplayOrder 内部按 status→pinnedAt desc 排,含归档
      // 置顶),保证首次过滤态拖拽、manualPinnedOrder 还空时,隐藏置顶项不因 baseline 顺序不符而跳位。
      const fullActivePinnedIds = pinnedSessionIdsInDisplayOrder([...sessions, ...remoteProjectSessions]);
      const merged = mergeVisibleReorder(
        normalizeManualPinnedOrder(filter.manualPinnedOrder, fullActivePinnedIds),
        visibleNewOrder,
      );
      filter.setManualPinnedOrder(merged, fullActivePinnedIds);
    },
    [sessions, remoteProjectSessions, filter],
  );

  const visibleDateSessions = useMemo(() => {
    const allowedProjects = filter.projectsAsSet;
    return activityFilteredSessions.filter((s) => {
      if (s.pinnedAt != null) return false;
      if (vendorPredicate && !vendorPredicate(s)) return false;
      if (allowedProjects === null) return true;
      if (s.workspaceKind === 'dialogue') return false;
      const wd = normalizeWorkingDir(s.workingDir);
      if (wd == null) return false;
      const key = projectIdentityKeyForSession(s);
      return key != null && allowedProjects.has(key);
    });
  }, [activityFilteredSessions, vendorPredicate, filter.projectsAsSet]);

  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => new Set());
  const [selectionAnchorSessionId, setSelectionAnchorSessionId] = useState<string | null>(null);
  const [bulkActionPending, setBulkActionPending] = useState<BulkSessionAction | null>(null);
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  // 含远程会话:device-link 远程行也渲染在可选行里,bulk 选择/归档/删除必须能解析到它们
  // (否则选中远程行 → 计数加了但 archive/delete 查 sessionsById 落空、静默忽略)。
  const sessionsById = useMemo(
    () => new Map([...sessions, ...remoteProjectSessions].map((session) => [session.id, session])),
    [sessions, remoteProjectSessions],
  );
  const selectedSessions = useMemo(
    () =>
      [...selectedSessionIds]
        .map((id) => sessionsById.get(id))
        .filter((session): session is (typeof sessions)[number] => session != null),
    [selectedSessionIds, sessionsById],
  );
  const selectedActiveSessionCount = useMemo(
    () => selectedSessions.filter((session) => session.status === 'active').length,
    [selectedSessions],
  );

  const resolveSessionRemovalRedirect = useCallback(
    async (
      removedSessionIds: ReadonlySet<string>,
      anchorSessionId: string,
      orderedSessionIds = getVisibleSidebarSessionIds(sidebarScrollRef.current),
    ): Promise<string | null> => {
      const nextSessionId = pickSessionIdAfterRemoval(
        orderedSessionIds,
        removedSessionIds,
        anchorSessionId,
      );
      if (nextSessionId) {
        return resolveSessionRoute(nextSessionId, sessionsById.get(nextSessionId));
      }
      return orderedSessionIds.includes(anchorSessionId) ? '/cc-agent/new' : null;
    },
    [sessionsById],
  );

  const pruneSelectionToRenderedRows = useCallback(() => {
    const renderedSessionIds = new Set(getVisibleSidebarSessionIds(sidebarScrollRef.current));
    setSelectedSessionIds((prev) => {
      const next = new Set([...prev].filter((id) => renderedSessionIds.has(id)));
      return sameStringSet(prev, next) ? prev : next;
    });
    setSelectionAnchorSessionId((prev) => (prev && renderedSessionIds.has(prev) ? prev : null));
  }, []);

  useEffect(() => {
    pruneSelectionToRenderedRows();
  });

  useEffect(() => {
    const root = sidebarScrollRef.current;
    if (!root) return undefined;
    const observer = new MutationObserver(pruneSelectionToRenderedRows);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [pruneSelectionToRenderedRows]);

  const handleClearSelection = useCallback(() => {
    setSelectedSessionIds((prev) => (prev.size === 0 ? prev : new Set()));
    setSelectionAnchorSessionId((prev) => (prev === null ? prev : null));
  }, []);

  useEffect(() => {
    if (onScheduleMatch || onNewMakerMatch) handleClearSelection();
  }, [onScheduleMatch, onNewMakerMatch, handleClearSelection]);

  const [linkingCodexProject, setLinkingCodexProject] = useState<string | null>(null);

  // 远程会话的已读回执有两类首发即失的场景,都靠本 memo 的 key 变化驱动重跑补发:
  //  1. 恢复 / 深链直开:effect 先于 remoteProjectsStore 完成 sessionId→deviceId 起源
  //     解析,首次清点只走了本机 IPC(key: undefined → `${deviceId}:...`)。
  //  2. 目标设备断线中打开:回执 invoke 失败被吞,重连后仅连接状态变化——把
  //     deviceLinkConnectionStatus 并入 key(`...:disconnected` → `...:connected`),
  //     重连即重跑补发。本机 IPC / run 标已读重发均幂等。
  const activeSessionRemoteReceiptKey = useMemo(() => {
    if (!activeSessionId) return undefined;
    const deviceId = getSessionDeviceId(activeSessionId);
    if (!deviceId) return undefined;
    const remote = remoteProjectSessions.find((s) => s.id === activeSessionId);
    return `${deviceId}:${remote?.deviceLinkConnectionStatus ?? 'unknown'}`;
  }, [activeSessionId, remoteProjectSessions]);
  // 注视中完成的远程 turn:被控端推来 attention=true 的活动包,但上面的 key 只含
  // 设备与连接态,不会重跑回执 effect。触发条件用**活动签名变化且 attention=true**
  // (与手机端 / 咽喉重定基同语义):仅凭 false→true 布尔沿会漏掉「attention 一直为
  // true 但内容更新」的场景(前一次收尾包丢失 / 延迟时,新 completed/error/
  // needs-interaction 到来布尔值不变)。attention 回落不计——那通常是本回执生效后
  // relay 推回的收尾包,重发只是无谓 invoke。
  const activeRemoteActivity = useRemoteSessionActivity(activeSessionId ?? '');
  const activeRemoteAttention = activeRemoteActivity?.attention === true;
  const activeRemoteActivitySig = activeRemoteActivity
    ? `${activeRemoteActivity.phase}|${activeRemoteActivity.attention === true ? 1 : 0}|${activeRemoteActivity.interactionKind ?? ''}|${activeRemoteActivity.compactDetail}`
    : 'none';
  const [activeRemoteAttentionRev, setActiveRemoteAttentionRev] = useState(0);
  const prevActiveRemoteActivitySigRef = useRef<string | null>(null);
  useEffect(() => {
    const prevSig = prevActiveRemoteActivitySigRef.current ?? activeRemoteActivitySig;
    if (activeRemoteAttention && activeRemoteActivitySig !== prevSig) {
      setActiveRemoteAttentionRev((rev) => rev + 1);
    }
    prevActiveRemoteActivitySigRef.current = activeRemoteActivitySig;
  }, [activeRemoteActivitySig, activeRemoteAttention]);
  useEffect(() => {
    if (!activeSessionId) return;
    markAutomationSessionRunsRead(activeSessionId);
    clearSystemSessionAttention(activeSessionId);
  }, [activeSessionId, activeSessionRemoteReceiptKey, activeRemoteAttentionRev, markAutomationSessionRunsRead]);

  // 用户从 Dock badge / taskbar flash 点回 app 时,如果 activeSessionId 没变,
  // route-driven effect 不会重跑,系统角标会残留。监听 window focus 兜底清当前
  // active session 的角标,正好覆盖 "MR !102 的回流场景"。
  useEffect(() => {
    if (!activeSessionId) return;
    const handler = () => {
      clearSystemSessionAttention(activeSessionId);
    };
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }, [activeSessionId]);

  const handleSessionClick = useCallback(
    async (id: string, modifiers?: SessionClickModifiers) => {
      if (hasSessionSelectionModifier(modifiers)) {
        if (modifiers?.shiftKey) {
          const visibleIds = getVisibleSidebarSessionIds(sidebarScrollRef.current);
          const visibleIdSet = new Set(visibleIds);
          const anchor =
            selectionAnchorSessionId && visibleIds.includes(selectionAnchorSessionId)
              ? selectionAnchorSessionId
              : id;
          const anchorIndex = visibleIds.indexOf(anchor);
          const targetIndex = visibleIds.indexOf(id);
          const rangeIds =
            anchorIndex >= 0 && targetIndex >= 0
              ? visibleIds.slice(
                  Math.min(anchorIndex, targetIndex),
                  Math.max(anchorIndex, targetIndex) + 1,
                )
              : [id];
          setSelectedSessionIds((prev) => {
            const next = modifiers.metaKey || modifiers.ctrlKey ? new Set(prev) : new Set<string>();
            for (const rangeId of rangeIds) {
              if (visibleIdSet.has(rangeId)) next.add(rangeId);
            }
            return next;
          });
          setSelectionAnchorSessionId((prev) => prev ?? id);
          return;
        }

        setSelectedSessionIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        });
        setSelectionAnchorSessionId(id);
        return;
      }

      if (selectedSessionIds.size > 0) {
        setSelectedSessionIds(new Set());
      }
      setSelectionAnchorSessionId(id);
      // F-SB-7: Clear done notification on click
      clearNotification(id);
      markAutomationSessionRunsRead(id);
      clearSystemSessionAttention(id);
      if (id === activeSessionId) return; // No duplicate navigate.
      const target = sessions.find((s) => s.id === id);
      navigate(await resolveSessionRoute(id, target));
    },
    [
      activeSessionId,
      navigate,
      clearNotification,
      markAutomationSessionRunsRead,
      sessions,
      selectedSessionIds.size,
      selectionAnchorSessionId,
    ],
  );

  /* ---- Project 行内的 + 按钮：对标顶部 "+ New"——预填该 project 的 workingDir 后进 draft 路由 ----
   * patchNewMakerDraft({ workingDir }) 把目录写进 transient draft store,
   * 然后 navigate('/cc-agent/new');NewMakerDraftRoute 渲染时 vendor 用 draft.vendor(用户上次选择)。
   */
  const handleCreateInProject = useCallback(
    (project: ProjectNode) => {
      if (isDeviceLinkWriteBlocked(project)) {
        toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
        return;
      }
      handleClearSelection();
      // device-link 远程项目:与本地一致先跳草稿页(主页)。草稿带上 deviceLink 目标
      // (workingDir + deviceId),草稿页显示"为远程设备新建"横幅,首条消息发出时再经
      // 隧道在被控端建会话(NewMakerDraftRoute 的 handleSend 远程分支)。
      patchNewMakerDraft({
        workingDir: project.workingDir,
        remoteHostId: project.deviceLinkDeviceId ? null : project.remoteHostId,
        deviceLinkDeviceId: project.deviceLinkDeviceId ?? null,
        deviceLinkDeviceName: project.deviceLinkDeviceName ?? null,
      });
      navigate('/cc-agent/new', { state: makeNewMakerRouteState('dialogue') });
    },
    [handleClearSelection, navigate, t],
  );

  const handleCreateProject = useCallback(async () => {
    try {
      const result = await window.electronAPI.showOpenDirectoryDialog();
      if (result.canceled || !result.path) return;
      handleClearSelection();
      patchNewMakerDraft({ workingDir: result.path, remoteHostId: null });
      navigate('/cc-agent/new', { state: makeNewMakerRouteState('dialogue') });
    } catch (err) {
      log.warn('create project directory picker failed', err);
      toast.error(t('ccAgent.sidebar.createProjectFailed'));
    }
  }, [handleClearSelection, navigate, t]);

  const handleCreateDialogue = useCallback(() => {
    handleClearSelection();
    patchNewMakerDraft({ workingDir: null, remoteHostId: null, extraDirs: [] });
    navigate('/cc-agent/new', { state: makeNewMakerRouteState('dialogue') });
  }, [handleClearSelection, navigate]);

  const handleLinkCodexProject = useCallback(
    async (project: ProjectNode) => {
      if (linkingCodexProject) return;
      setLinkingCodexProject(project.projectKey);
      try {
        const result = await window.electronAPI.localDb.sessionImport.linkCodexProject(
          project.workingDir,
        );
        if (result.inserted > 0 || result.updated > 0) {
          toast.success(
            t('ccAgent.sidebar.projectAction.syncCodexDone', {
              inserted: result.inserted,
              updated: result.updated,
            }),
          );
          emitRefresh();
        } else if (result.matched > 0) {
          toast.warning(t('ccAgent.sidebar.projectAction.syncCodexAlreadyLinked'));
        } else {
          toast.warning(t('ccAgent.sidebar.projectAction.syncCodexNone'));
        }
      } catch (err) {
        log.error('[link codex project]', err);
        toast.error(
          t('ccAgent.sidebar.projectAction.syncCodexFailed', {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      } finally {
        setLinkingCodexProject(null);
      }
    },
    [linkingCodexProject, t],
  );

  /* ---- Project 行内的 Open Explorer 按钮：在系统文件管理器中打开 workingDir ----
   * 复用现有 shell:open-path IPC（preload 暴露为 electronAPI.openPath），
   * 失败仅 toast 提示，不抛错——"打开文件夹失败" 一般是路径不存在/权限问题。
   */
  const handleOpenInExplorer = useCallback(
    async (workingDir: string) => {
      try {
        const result = await window.electronAPI.openPath(workingDir);
        if (!result.success) {
          toast.error(result.error || t('ccAgent.common.openFolderFailed'));
        }
      } catch (err) {
        log.error('[open in explorer]', err);
        toast.error(t('ccAgent.common.openFolderFailed'));
      }
    },
    [t],
  );

  /* ---- Project 行内的 Browse Files 按钮：进入 workdir 文件浏览模式 ----
   * 策略:
   *   1. 当前 active session 在该 project → 直接 navigate('/cc-agent/files/<active>')
   *      (chat rail 自然继承当前会话上下文,符合设计稿"继承当前打开的 session"行为)。
   *   2. 否则挑该 project 下最近活跃的非 archived session → navigate(...)
   *   3. 完全没有 session → toast 提示先建一个会话。
   * 二次确认对话框(设计稿里的 "switch session?" 弹窗)留待后续迭代,先以静默切换 + toast
   * 提示落地最小可用版。
   */
  const handleBrowseFiles = useCallback(
    (project: ProjectNode) => {
      const targetProjectKey = project.projectKey;
      const inProject = (s: (typeof sessions)[number]): boolean =>
        projectIdentityKeyForSession(s) === targetProjectKey && s.status !== 'deleted';
      const navigateToProjectSession = (id: string) => {
        if (project.scope === 'remote') {
          navigate(`/cc-agent/${id}`);
          return;
        }
        navigate(`/cc-agent/files/${id}`);
      };

      // 优先用 active session(若属于这个 project)。
      if (activeSessionId) {
        const active = sessions.find((s) => s.id === activeSessionId);
        if (active && inProject(active)) {
          navigateToProjectSession(activeSessionId);
          return;
        }
      }
      // 否则取该 project 下 updatedAt 最大的 session(sessions 已按 updatedAt desc 排好)。
      const fallback = sessions.find(inProject);
      if (fallback) {
        navigateToProjectSession(fallback.id);
        return;
      }
      toast.warning(t('ccAgent.sidebar.browseEmpty'));
    },
    [activeSessionId, sessions, navigate, t],
  );

  /* ---- Rename handler ---- */
  const handleRename = useCallback(
    async (sessionId: string, newTitle: string) => {
      const session = sessionsById.get(sessionId);
      if (isRemoteSessionWriteBlocked(session)) {
        toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
        return;
      }
      // 取旧值用于失败回滚，乐观先 patch（不刷整列表，列表顺序保持稳定）
      const oldTitle = sessions.find((s) => s.id === sessionId)?.title;
      patchLocal(sessionId, { title: newTitle });
      try {
        // 远程会话:patch-meta 经隧道写被控端 → 广播 sessions:patched → applyPatch 更新远程分片(纯镜像)。
        await sessionService.patchMeta(sessionId, { title: newTitle });
      } catch (err) {
        log.error('[session rename]', err);
        toast.error(t('ccAgent.sidebar.renameFailed'));
        if (oldTitle !== undefined) patchLocal(sessionId, { title: oldTitle });
      }
    },
    [sessions, sessionsById, patchLocal, t],
  );

  const handleProjectAliasChange = useCallback(
    async (project: ProjectNode, alias: string) => {
      try {
        await projectAliases.updateAlias(project.projectKey, alias);
      } catch (err) {
        log.error('[project alias rename]', err);
        toast.error(t('ccAgent.sidebar.projectAlias.renameFailed'));
        throw err;
      }
    },
    [projectAliases, t],
  );

  /* ---- Pin / Unpin handler ---- */
  const handleTogglePin = useCallback(
    async (sessionId: string, currentlyPinned: boolean) => {
      const session = sessionsById.get(sessionId);
      if (isRemoteSessionWriteBlocked(session)) {
        toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
        return;
      }
      const oldPinnedAt = sessions.find((s) => s.id === sessionId)?.pinnedAt ?? null;
      const newPinnedAt = currentlyPinned ? null : new Date().toISOString();
      patchLocal(sessionId, { pinnedAt: newPinnedAt });
      // pin / re-pin 时把它顶到 manualPinnedOrder 首位，否则带着老 rank 会卡回原位。
      // unpin 不主动从 order 里删（无害,下次 drag 触发的 normalize 会顺手 GC）。
      if (!currentlyPinned) filter.promotePin(sessionId);
      try {
        // 远程会话:patch-meta → 广播 sessions:patched → applyPatch 更新远程分片(纯镜像)。
        await sessionService.patchMeta(sessionId, { pinnedAt: newPinnedAt });
      } catch (err) {
        log.error('[session pin]', err);
        toast.error(t('ccAgent.sidebar.pinFailed'));
        patchLocal(sessionId, { pinnedAt: oldPinnedAt });
      }
    },
    [filter, patchLocal, sessions, sessionsById, t],
  );

  const handleMoveSession = useCallback(
    async (sessionId: string, target: SessionMoveTarget) => {
      const session = sessionsById.get(sessionId);
      if (!session) return;
      if (session.remoteHostId || session.deviceLinkDeviceId) {
        toast.warning(t('ccAgent.sidebar.sessionMenu.moveToProjectRemoteUnsupported'));
        return;
      }
      if (effectiveRunningSessionIds.has(sessionId)) {
        toast.warning(t('ccAgent.sidebar.sessionMenu.moveToProjectRunningBlocked'));
        return;
      }
      try {
        const binding = await window.electronAPI.binding.resolveSession(sessionId);
        if (binding.attached) {
          toast.warning(t('ccAgent.sidebar.sessionMenu.moveToProjectAttachedBlocked'));
          return;
        }
      } catch {
        // resolveSession 失败时不阻断移动；它只是 IM 接管保护的额外检查。
      }

      let targetWorkingDir = target.kind === 'project' ? target.workingDir : undefined;
      if (target.kind === 'browseProject') {
        try {
          const result = await window.electronAPI.showOpenDirectoryDialog();
          if (result.canceled || !result.path) return;
          targetWorkingDir = result.path;
        } catch (err) {
          log.warn('[session move to project] directory picker failed', err);
          toast.error(t('ccAgent.sidebar.sessionMenu.moveToProjectFailed'));
          return;
        }
      }

      const oldPatch = {
        workingDir: session.workingDir,
        workspaceKind: session.workspaceKind,
      };
      if (target.kind !== 'dialogue' && !targetWorkingDir) return;
      const nextPatch =
        target.kind === 'dialogue'
          ? { workspaceKind: 'dialogue' as const }
          : { workingDir: targetWorkingDir, workspaceKind: 'project' as const };
      patchLocal(sessionId, nextPatch);
      let expandedProjectKey: string | null = null;
      let wasExpandedProjectCollapsed = false;
      if (targetWorkingDir) {
        const normalized = normalizeWorkingDir(targetWorkingDir);
        if (normalized) {
          expandedProjectKey = projectIdentityKey('local', normalized, null);
          wasExpandedProjectCollapsed = collapse.collapsed.has(expandedProjectKey);
          collapse.expand(expandedProjectKey);
        }
      }
      try {
        await sessionService.update(sessionId, nextPatch);
        if (target.kind !== 'dialogue') {
          void recentWorkdirsStore.forceRefresh().catch(() => undefined);
        }
        toast.success(
          t(
            target.kind === 'dialogue'
              ? 'ccAgent.sidebar.sessionMenu.moveToDialogueDone'
              : 'ccAgent.sidebar.sessionMenu.moveToProjectDone',
          ),
        );
      } catch (err) {
        log.error('[session move]', err);
        patchLocal(sessionId, oldPatch);
        if (expandedProjectKey && wasExpandedProjectCollapsed) {
          collapse.setCollapsed(expandedProjectKey, true);
        }
        toast.error(
          t(
            target.kind === 'dialogue'
              ? 'ccAgent.sidebar.sessionMenu.moveToDialogueFailed'
              : 'ccAgent.sidebar.sessionMenu.moveToProjectFailed',
          ),
        );
      }
    },
    [collapse, effectiveRunningSessionIds, patchLocal, sessionsById, t],
  );

  /* ---- Delete / Archive / Unarchive action handlers ----
   * delete & archive（菜单触发）走 ConfirmDialog（不可逆 / 移出当前列表）；
   * archive-now（行内 Confirm 触发）走 runSessionAction，跳过弹窗 —— 等价于
   *   用户在快捷按钮上完成了两步行内确认，不再二次弹窗；
   * unarchive 是 archive 的反向操作，无副作用，直接 patch 即可，不弹确认。
   *
   * 执行序列（关子进程 / 写库 / 乐观补丁 / 释放内存 / refresh / 跳转）抽在
   * useSessionLifecycleActions，与 SessionContentHeader 共用；本组件只保留
   * 前置检查（running / IM 接管拦截）与确认弹窗编排。
   */
  // includeArchived 跟随当前列表桶（filter.status）—— archived / all 桶里
  // 删除后要刷对应桶，否则已删行残留（见 hook 文件头注释）。
  const { runSessionAction, unarchiveSession } = useSessionLifecycleActions({
    includeArchived: filter.status,
  });

  const handleActionClick = useCallback(
    async (sessionId: string, action: 'delete' | 'archive' | 'archive-now' | 'unarchive') => {
      const session = sessionsById.get(sessionId);
      if (isRemoteSessionWriteBlocked(session)) {
        toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
        return;
      }
      const isArchiveLike = action === 'archive' || action === 'archive-now';
      // 执行中的 session 不允许归档 —— 让用户先停下当前任务
      if (isArchiveLike && runningSessionIds.has(sessionId)) {
        toast.warning(t('ccAgent.sidebar.archiveBlocked.running'));
        return;
      }
      // 被 IM 接管中的 session 不允许归档 —— 接管方还在操控，先收回再归档
      if (isArchiveLike) {
        try {
          const binding = await window.electronAPI.binding.resolveSession(sessionId);
          if (binding.attached) {
            toast.warning(t('ccAgent.sidebar.archiveBlocked.attached'));
            return;
          }
        } catch {
          // resolveSession 失败时不阻断归档，直接继续
        }
      }
      // 行内 Confirm 触发：干净 worktree 保持两步快捷确认；若有未提交改动，
      // 升级到现有确认弹窗展示 dirty warning，避免绕过归档预检。
      if (action === 'archive-now') {
        const dirtyWorktree = await fetchDirtyWorktreeForRemoval(
          sessionId,
          session?.deviceLinkDeviceId,
        );
        if (dirtyWorktree) {
          setConfirm({ open: true, sessionId, action: 'archive', dirtyWorktree: true });
          return;
        }
        await runSessionAction(sessionId, 'archive', { activeSessionId });
        return;
      }
      if (action !== 'unarchive') {
        // P1 预检:worktree 有未提交更改时确认文案追加警告(查询失败降级为不提示)
        const dirtyWorktree = await fetchDirtyWorktreeForRemoval(
          sessionId,
          session?.deviceLinkDeviceId,
        );
        setConfirm({ open: true, sessionId, action, dirtyWorktree });
        return;
      }
      await unarchiveSession(sessionId);
    },
    [
      activeSessionId,
      runningSessionIds,
      runSessionAction,
      sessionsById,
      unarchiveSession,
      t,
    ],
  );

  const handleConfirm = useCallback(async () => {
    const { sessionId, action } = confirm;
    const session = sessionsById.get(sessionId);
    if (isRemoteSessionWriteBlocked(session)) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      setConfirm(CONFIRM_INITIAL);
      return;
    }
    const deleteRedirectRoute =
      action === 'delete' && sessionId === activeSessionId
        ? await resolveSessionRemovalRedirect(new Set([sessionId]), sessionId)
        : null;
    await runSessionAction(sessionId, action, { activeSessionId, deleteRedirectRoute });
    setConfirm(CONFIRM_INITIAL);
  }, [
    activeSessionId,
    confirm,
    resolveSessionRemovalRedirect,
    runSessionAction,
    sessionsById,
    t,
  ]);

  const handleCancelConfirm = useCallback(() => {
    setConfirm(CONFIRM_INITIAL);
  }, []);

  const handleBulkDelete = useCallback(async () => {
    if (bulkActionPending !== null) return;
    if (selectedSessions.some(isRemoteSessionWriteBlocked)) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      return;
    }
    const candidates = selectedSessions.filter((session) => session.status !== 'deleted');
    if (candidates.length === 0) {
      handleClearSelection();
      return;
    }

    // P1 预检:统计有未提交更改 worktree 的会话数,确认文案追加警告
    const dirtyCount = await countDirtyWorktreesForRemoval(candidates);

    const ok = await confirmDialog({
      title: t('ccAgent.sidebar.bulkSelection.confirmDelete.title'),
      description:
        t('ccAgent.sidebar.bulkSelection.confirmDelete.description', {
          count: candidates.length,
        }) +
        (dirtyCount > 0
          ? ' ' +
            t('ccAgent.sidebar.bulkSelection.confirmDelete.dirtyWorktreeWarning', {
              count: dirtyCount,
            })
          : ''),
      confirmText: t('ccAgent.sidebar.bulkSelection.confirmDelete.confirm'),
      cancelText: t('ccAgent.sidebar.bulkSelection.confirmDelete.cancel'),
    });
    if (!ok) return;

    const orderedSessionIdsBeforeDelete = getVisibleSidebarSessionIds(sidebarScrollRef.current);
    setBulkActionPending('delete');
    const failed: string[] = [];
    try {
      for (const session of candidates) {
        makerChatStore.closeSessionQuery(session.id);
        try {
          // patchMeta 按来源路由:远程会话经隧道写被控端 patch-meta(allowlist 内),本地仍走 update。
          await sessionService.patchMeta(session.id, { status: 'deleted' });
          makerChatStore.purgeSession(session.id);
          clearComposerDraft(session.id);
          // RSB 布局偏好(fraction / treeWidth / collapsed)走 localStorage 是
          // 本机概念,本地 + 远程 session 都要清(被控端的 localStorage 由被控端自己处理)。
          cleanupSessionLayoutPrefs(session.id);
          // 图片缓存清理是本机概念;远程会话的图在被控端,由被控端自己的删除流程处理。
          if (!session.deviceLinkDeviceId) {
            void window.electronAPI.cleanupSessionImages(session.id).catch((err: unknown) => {
              log.warn('[bulk session delete] cleanup images failed', err);
            });
          }
        } catch (err) {
          log.error('[bulk session delete]', err);
          failed.push(session.id);
        }
      }

      const failedIds = new Set(failed);
      const succeededIds = new Set(
        candidates.filter((session) => !failedIds.has(session.id)).map((session) => session.id),
      );
      await refreshSessions();
      void refreshWorktrees();

      if (activeSessionId && succeededIds.has(activeSessionId)) {
        const redirectRoute = await resolveSessionRemovalRedirect(
          succeededIds,
          activeSessionId,
          orderedSessionIdsBeforeDelete,
        );
        navigate(redirectRoute ?? '/cc-agent');
      }

      setSelectedSessionIds((prev) => {
        const next = new Set(prev);
        for (const id of succeededIds) next.delete(id);
        return next;
      });
      setSelectionAnchorSessionId((prev) => (prev && succeededIds.has(prev) ? null : prev));

      if (failed.length === 0) {
        toast.success(t('ccAgent.sidebar.bulkSelection.deleted', { count: succeededIds.size }));
      } else {
        toast.error(
          t('ccAgent.sidebar.bulkSelection.partialDeleteFailure', {
            ok: succeededIds.size,
            fail: failed.length,
          }),
        );
      }
    } finally {
      setBulkActionPending(null);
    }
  }, [
    activeSessionId,
    bulkActionPending,
    confirmDialog,
    handleClearSelection,
    navigate,
    refreshSessions,
    refreshWorktrees,
    resolveSessionRemovalRedirect,
    selectedSessions,
    t,
  ]);

  const handleBulkArchive = useCallback(async () => {
    if (bulkActionPending !== null) return;
    if (selectedSessions.some(isRemoteSessionWriteBlocked)) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      return;
    }
    const skippedNotActive = selectedSessions.filter(
      (session) => session.status !== 'active',
    ).length;
    const skippedRunning = selectedSessions.filter(
      (session) => session.status === 'active' && runningSessionIds.has(session.id),
    ).length;
    const preflightCandidates = selectedSessions.filter(
      (session) => session.status === 'active' && !runningSessionIds.has(session.id),
    );
    const attachedIds = new Set(
      (
        await Promise.all(
          preflightCandidates.map(async (session) => {
            try {
              const binding = await window.electronAPI.binding.resolveSession(session.id);
              return binding.attached ? session.id : null;
            } catch {
              // resolveSession 失败时与单条归档一致:不阻断归档。
              return null;
            }
          }),
        )
      ).filter((id): id is string => id != null),
    );
    const candidates = preflightCandidates.filter((session) => !attachedIds.has(session.id));

    if (candidates.length === 0) {
      toast.warning(t('ccAgent.sidebar.bulkSelection.archiveNone'));
      return;
    }

    const dirtyCount = await countDirtyWorktreesForRemoval(candidates);

    const skipNotes: string[] = [];
    if (skippedRunning > 0)
      skipNotes.push(t('ccAgent.sidebar.bulkSelection.skipRunning', { count: skippedRunning }));
    if (attachedIds.size > 0)
      skipNotes.push(t('ccAgent.sidebar.bulkSelection.skipAttached', { count: attachedIds.size }));
    if (skippedNotActive > 0)
      skipNotes.push(t('ccAgent.sidebar.bulkSelection.skipNotActive', { count: skippedNotActive }));
    const baseDescription =
      skipNotes.length > 0
        ? t('ccAgent.sidebar.bulkSelection.confirmArchive.descriptionWithSkip', {
            count: candidates.length,
            skip: skipNotes.join(t('ccAgent.sidebar.bulkSelection.skipSeparator')),
          })
        : t('ccAgent.sidebar.bulkSelection.confirmArchive.description', {
            count: candidates.length,
          });
    const description =
      baseDescription +
      (dirtyCount > 0
        ? ' ' +
          t('ccAgent.sidebar.bulkSelection.confirmArchive.dirtyWorktreeWarning', {
            count: dirtyCount,
          })
        : '');

    const ok = await confirmDialog({
      title: t('ccAgent.sidebar.bulkSelection.confirmArchive.title'),
      description,
      confirmText: t('ccAgent.sidebar.bulkSelection.confirmArchive.confirm'),
      cancelText: t('ccAgent.sidebar.bulkSelection.confirmArchive.cancel'),
    });
    if (!ok) return;

    setBulkActionPending('archive');
    const failed: string[] = [];
    try {
      for (const session of candidates) {
        makerChatStore.closeSessionQuery(session.id);
        try {
          // patchMeta 按来源路由:远程会话经隧道写被控端;本地仍走 update。
          await sessionService.patchMeta(session.id, { status: 'archived', pinnedAt: null });
          // 乐观本地 patch 只对本机会话;远程会话由隧道广播 sessions:patched → applyPatch 更新远程分片。
          if (!session.deviceLinkDeviceId) {
            patchLocal(session.id, { status: 'archived', pinnedAt: null });
          }
          makerChatStore.purgeSession(session.id);
          clearComposerDraft(session.id);
        } catch (err) {
          log.error('[bulk session archive]', err);
          failed.push(session.id);
        }
      }

      const failedIds = new Set(failed);
      const succeededIds = new Set(
        candidates.filter((session) => !failedIds.has(session.id)).map((session) => session.id),
      );
      await refreshSessions();
      void refreshWorktrees();

      if (activeSessionId && succeededIds.has(activeSessionId)) {
        navigate('/cc-agent');
      }

      setSelectedSessionIds((prev) => {
        const next = new Set(prev);
        for (const id of succeededIds) next.delete(id);
        return next;
      });
      setSelectionAnchorSessionId((prev) => (prev && succeededIds.has(prev) ? null : prev));

      if (failed.length === 0) {
        toast.success(t('ccAgent.sidebar.bulkSelection.archived', { count: succeededIds.size }));
      } else {
        toast.error(
          t('ccAgent.sidebar.bulkSelection.partialArchiveFailure', {
            ok: succeededIds.size,
            fail: failed.length,
          }),
        );
      }
    } finally {
      setBulkActionPending(null);
    }
  }, [
    activeSessionId,
    bulkActionPending,
    confirmDialog,
    navigate,
    patchLocal,
    refreshSessions,
    refreshWorktrees,
    runningSessionIds,
    selectedSessions,
    t,
  ]);

  /* ---- Project 批量归档动作 ----
   * active / all 筛选：归档该 project 下所有可归档的 active session；
   * archived 筛选：恢复该 project 下所有 archived session。
   * 两个方向都逐条写入，单条失败不会阻断其余会话，最后统一 refresh。
   */
  const handleArchiveAllInProject = useCallback(
    async (project: ProjectNode) => {
      if (isDeviceLinkWriteBlocked(project)) {
        toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
        return;
      }
      const targetProjectKey = project.projectKey;
      const action = projectBulkArchiveActionForStatus(filter.status);
      const belongsToProject = (session: Session): boolean =>
        projectIdentityKeyForSession(session) === targetProjectKey;

      // 只对**本地** sessions 归档:device-link 远程会话的运行态不在本渲染进程(runningSessionIds 是
      // 本地 makerChatStore 的),无法像本地那样把「正在运行」的排除掉 —— 批量归档时可能把被控端正在
      // 跑的会话也归档掉。安全起见远程项目的「归档全部」维持 #331 前的本地口径(对纯远程项目即空操作);
      // 要安全支持远程批量归档需被控端侧的「运行态感知批量归档」命令,留作 follow-up。
      // pinned 是用户主动表达 "留住这个会话"，archive all 必须排除（跟 running 是两个独立维度）。
      // 既 pinned 又 running 的：归到 pinned 那类（用户意图明确，running 只是临时状态）。
      const { candidates, skippedPinned, skippedRunning } = selectProjectBulkArchiveCandidates(
        sessions,
        action,
        runningSessionIds,
        belongsToProject,
      );

      if (action === 'unarchive') {
        if (candidates.length === 0) {
          toast.warning(t('ccAgent.sidebar.unarchiveAll.empty'));
          return;
        }

        const ok = await confirmDialog({
          title: t('ccAgent.sidebar.unarchiveAll.title'),
          description: t('ccAgent.sidebar.unarchiveAll.description', { count: candidates.length }),
          confirmText: t('ccAgent.sidebar.unarchiveAll.confirm'),
          cancelText: t('ccAgent.sidebar.unarchiveAll.cancel'),
        });
        if (!ok) return;

        const failed: string[] = [];
        for (const session of candidates) {
          try {
            await sessionService.setStatus(session.id, 'active');
            patchLocal(session.id, { status: 'active' });
          } catch (err) {
            log.error('[unarchive all]', err);
            failed.push(session.id);
          }
        }

        const succeededCount = candidates.length - failed.length;
        await refreshSessions();
        // 批量恢复跨 archived → active 桶，强制刷新其余缓存桶，确保 active / all
        // 视图切换后立即看到恢复结果。
        emitRefresh();

        if (failed.length === 0) {
          toast.success(t('ccAgent.sidebar.unarchiveAll.unarchived', { count: succeededCount }));
        } else {
          toast.error(
            t('ccAgent.sidebar.unarchiveAll.partialFailure', {
              ok: succeededCount,
              fail: failed.length,
            }),
          );
        }
        return;
      }

      if (candidates.length === 0) {
        if (skippedPinned > 0 && skippedRunning > 0) {
          toast.warning(t('ccAgent.sidebar.archiveAll.allPinnedOrRunning'));
        } else if (skippedPinned > 0) {
          toast.warning(t('ccAgent.sidebar.archiveAll.allPinned'));
        } else if (skippedRunning > 0) {
          toast.warning(t('ccAgent.sidebar.archiveAll.allRunning'));
        } else {
          toast.warning(t('ccAgent.sidebar.archiveAll.empty'));
        }
        return;
      }

      const dirtyCount = await countDirtyWorktreesForRemoval(candidates);

      const skipNotes: string[] = [];
      if (skippedRunning > 0)
        skipNotes.push(t('ccAgent.sidebar.archiveAll.skipRunning', { count: skippedRunning }));
      if (skippedPinned > 0)
        skipNotes.push(t('ccAgent.sidebar.archiveAll.skipPinned', { count: skippedPinned }));
      const skipSep = t('ccAgent.sidebar.archiveAll.skipSeparator');
      const baseDescription =
        skipNotes.length > 0
          ? t('ccAgent.sidebar.archiveAll.descriptionWithSkip', {
              count: candidates.length,
              skip: skipNotes.join(skipSep),
            })
          : t('ccAgent.sidebar.archiveAll.description', { count: candidates.length });
      const description =
        baseDescription +
        (dirtyCount > 0
          ? ' ' +
            t('ccAgent.sidebar.bulkSelection.confirmArchive.dirtyWorktreeWarning', {
              count: dirtyCount,
            })
          : '');

      const ok = await confirmDialog({
        title: t('ccAgent.sidebar.archiveAll.title'),
        description,
        confirmText: t('ccAgent.sidebar.archiveAll.confirm'),
        cancelText: t('ccAgent.sidebar.archiveAll.cancel'),
      });
      if (!ok) return;

      // 失败的 id 收集起来，最后统一 toast；其余继续走完，不让一条失败拖累整批。
      const failed: string[] = [];
      for (const s of candidates) {
        // 关掉 SDK subprocess + 清 in-memory state，与单条 archive 行为一致
        makerChatStore.closeSessionQuery(s.id);
        try {
          await sessionService.setStatus(s.id, 'archived');
          // 跨 bucket 同步:见 handleConfirm 同位置注释。
          patchLocal(s.id, { status: 'archived', pinnedAt: null });
          makerChatStore.purgeSession(s.id);
          clearComposerDraft(s.id);
        } catch (err) {
          log.error('[archive all]', err);
          failed.push(s.id);
        }
      }

      const failedIds = new Set(failed);
      const succeededIds = new Set(candidates.filter((s) => !failedIds.has(s.id)).map((s) => s.id));

      await refreshSessions();
      void refreshWorktrees();

      // 当前 active session 被归档了 → 走 /cc-agent 让 CCAgentIndexRedirect
      // 做 Orca-aware 的「选下一条 / 空则跳 new」决策(见 runSessionAction 同位置注释)。
      if (activeSessionId && succeededIds.has(activeSessionId)) {
        navigate('/cc-agent');
      }

      if (failed.length === 0) {
        toast.success(t('ccAgent.sidebar.archiveAll.archived', { count: succeededIds.size }));
      } else {
        toast.error(
          t('ccAgent.sidebar.archiveAll.partialFailure', {
            ok: succeededIds.size,
            fail: failed.length,
          }),
        );
      }
    },
    [
      sessions,
      runningSessionIds,
      confirmDialog,
      refreshSessions,
      refreshWorktrees,
      activeSessionId,
      navigate,
      patchLocal,
      filter.status,
      t,
    ],
  );

  return (
    <>
      {/* 顶部动作(新建 / 搜索 / 自动任务)已上移到 shell 的 SidebarTopNav 常驻列表;
          这里直接从多选操作条 / 列表内容开始。 */}
      {selectedSessionIds.size > 0 && (
        <div className="px-3 pb-2">
          <div
            className={cn(
              'flex h-8 items-center gap-1 rounded-full px-2 pl-3',
              'bg-[var(--chat-input-chip-bg)] text-[var(--msg-assistant-text)]',
              'border border-[var(--cmd-palette-border)]',
            )}
          >
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
              {t('ccAgent.sidebar.bulkSelection.selected', { count: selectedSessionIds.size })}
            </span>
            <button
              type="button"
              onClick={() => void handleBulkArchive()}
              disabled={bulkActionPending !== null || selectedActiveSessionCount === 0}
              aria-label={t('ccAgent.sidebar.bulkSelection.archive')}
              title={t('ccAgent.sidebar.bulkSelection.archive')}
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full',
                'text-[var(--cmd-palette-item-meta)] hover:bg-[var(--cmd-palette-item-hover)] hover:text-[var(--msg-assistant-text)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
                'disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--cmd-palette-item-meta)]',
              )}
            >
              <Archive size={13} strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={() => void handleBulkDelete()}
              disabled={bulkActionPending !== null}
              aria-label={t('ccAgent.sidebar.bulkSelection.delete')}
              title={t('ccAgent.sidebar.bulkSelection.delete')}
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full',
                'text-[var(--cmd-palette-item-meta)] hover:bg-[var(--cmd-palette-item-hover)] hover:text-[var(--msg-assistant-text)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
                'disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--cmd-palette-item-meta)]',
              )}
            >
              <Trash2 size={13} strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={handleClearSelection}
              disabled={bulkActionPending !== null}
              aria-label={t('ccAgent.sidebar.bulkSelection.clear')}
              title={t('ccAgent.sidebar.bulkSelection.clear')}
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full',
                'text-[var(--cmd-palette-item-meta)] hover:bg-[var(--cmd-palette-item-hover)] hover:text-[var(--msg-assistant-text)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
                'disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--cmd-palette-item-meta)]',
              )}
            >
              <X size={13} strokeWidth={2} />
            </button>
          </div>
        </div>
      )}

      {/* 侧栏内容区:单一滚动容器(置顶 + 项目 + 对话一起滚动)。外层 relative 承载搜索结果
         overlay。远程机器切换入口是 shell SidebarTopNav 的末行(与新建 / 搜索同列表),
         固定在本区上方、不随列表滚动。 */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={sidebarScrollRef}
          className="flex flex-col gap-2 pt-2 pb-4 overflow-y-auto flex-1"
          style={{ scrollbarGutter: 'stable' }}
        >
          {selectedMachineConnecting ? (
            // 选中机器连接中:会话还没同步,显示「连接中」而非「暂无对话」。
            // 机器切换入口在上方固定行常驻,始终能切回「所有」、不会被困在占位页。
            <div className="flex flex-col items-center justify-center px-3 py-12 text-center">
              <span className="animate-pulse text-xs text-[var(--text-tertiary)]">
                {t('ccAgent.sidebar.machineSwitcher.connecting')}
              </span>
            </div>
          ) : (
            <>
              <PinnedSection
                sessions={visiblePinned}
                allKnownProjects={projectUniverse.projects}
                projectsFilter={pinnedFilter}
                activeSessionId={activeSessionId}
                runningSessionIds={displayRunningSessionIds}
                attachedSessionIds={attachedSessionIds}
                notifications={sidebarNotifications}
                selectedSessionIds={selectedSessionIds}
                onSessionClick={handleSessionClick}
                onAction={handleActionClick}
                onRename={handleRename}
                onTogglePin={handleTogglePin}
                onMoveSession={handleMoveSession}
                projectOptions={projectPickerOptions}
                onReorder={handlePinnedReorder}
              />
        {filter.groupBy === 'date' ? (
          <DateGroupedSessionsSection
            sessions={visibleDateSessions}
            allKnownProjects={projectUniverse.projects}
            filter={filter}
            activeSessionId={activeSessionId}
            runningSessionIds={displayRunningSessionIds}
            attachedSessionIds={attachedSessionIds}
            notifications={sidebarNotifications}
            scheduleSessionIndex={scheduleSessionIndex}
            selectedSessionIds={selectedSessionIds}
            onSessionClick={handleSessionClick}
            onAction={handleActionClick}
            onRename={handleRename}
            onTogglePin={handleTogglePin}
            onMoveSession={handleMoveSession}
            projectOptions={projectPickerOptions}
            onScheduleAction={handleScheduleAction}
          />
        ) : (
          <>
            <ProjectsSection
              unclassified={visibleUnclassified}
              projects={visibleProjectsWithVendor}
              allKnownProjects={projectUniverse.projects}
              filter={filter}
              collapsed={collapse.collapsed}
              isAllCollapsed={collapse.isAllCollapsed}
              activeSessionId={activeSessionId}
              runningSessionIds={displayRunningSessionIds}
              attachedSessionIds={attachedSessionIds}
              notifications={sidebarNotifications}
              scheduleSessionIndex={scheduleSessionIndex}
              selectedSessionIds={selectedSessionIds}
              onSessionClick={handleSessionClick}
              onAction={handleActionClick}
              onRename={handleRename}
              onTogglePin={handleTogglePin}
              onMoveSession={handleMoveSession}
              projectOptions={projectPickerOptions}
              onScheduleAction={handleScheduleAction}
              onToggleProject={collapse.toggle}
              onRenameProject={handleProjectAliasChange}
              onCollapseAll={collapse.collapseAll}
              onExpandAll={collapse.expandAll}
              onCreateProject={handleCreateProject}
              onCreateInProject={handleCreateInProject}
              onOpenConversationSearch={handleOpenConversationSearch}
              onOpenInExplorer={handleOpenInExplorer}
              onLinkCodexProject={handleLinkCodexProject}
              linkingCodexProject={linkingCodexProject}
              onBrowseFiles={handleBrowseFiles}
              onArchiveAll={handleArchiveAllInProject}
            />
            <DialogueSection
              sessions={visibleDialogues}
              activeSessionId={activeSessionId}
              runningSessionIds={displayRunningSessionIds}
              attachedSessionIds={attachedSessionIds}
              notifications={sidebarNotifications}
              scheduleSessionIndex={scheduleSessionIndex}
              selectedSessionIds={selectedSessionIds}
              onSessionClick={handleSessionClick}
              onAction={handleActionClick}
              onRename={handleRename}
              onTogglePin={handleTogglePin}
              onMoveSession={handleMoveSession}
              projectOptions={projectPickerOptions}
              onScheduleAction={handleScheduleAction}
              onCreateDialogue={handleCreateDialogue}
            />
          </>
        )}
            </>
          )}
        </div>
        {/* 搜索结果 overlay:query 非空时盖住搜索框下方的全部空间(置顶 + 项目 + 对话)。
            data-conversation-search-surface:标记为「搜索界面内部」——Provider 的 outside-pointerdown
            监听据此判定,overlay 内点击 / 滚动都不收起,只有点到本标记以外才收起(见 conversationSearchContext)。 */}
        {search.trimmed && (
          <div
            data-conversation-search-surface
            className="absolute inset-0 z-20 overflow-y-auto bg-[var(--cmd-palette-bg)]"
          >
            <SearchResultsBody
              trimmed={search.trimmed}
              status={search.status}
              results={search.results}
              onSelect={search.handleSelect}
            />
          </div>
        )}
      </div>

      {/* Delete / Archive confirm dialog */}
      <ConfirmDialog
        open={confirm.open}
        onOpenChange={(open) => {
          if (!open) handleCancelConfirm();
        }}
        title={
          confirm.action === 'delete'
            ? t('ccAgent.sidebar.confirmDelete.title')
            : t('ccAgent.sidebar.confirmArchive.title')
        }
        description={
          (confirm.action === 'delete'
            ? t('ccAgent.sidebar.confirmDelete.description')
            : t('ccAgent.sidebar.confirmArchive.description')) +
          (confirm.dirtyWorktree
            ? ' ' +
              (confirm.action === 'delete'
                ? t('ccAgent.sidebar.confirmDelete.dirtyWorktreeWarning')
                : t('ccAgent.sidebar.confirmArchive.dirtyWorktreeWarning'))
            : '')
        }
        confirmText={
          confirm.action === 'delete'
            ? t('ccAgent.sidebar.confirmDelete.confirm')
            : t('ccAgent.sidebar.confirmArchive.confirm')
        }
        cancelText={
          confirm.action === 'delete'
            ? t('ccAgent.sidebar.confirmDelete.cancel')
            : t('ccAgent.sidebar.confirmArchive.cancel')
        }
        onConfirm={handleConfirm}
        onCancel={handleCancelConfirm}
      />
      {deleteScheduleDialog}
    </>
  );
}

/* ============================== Collapsed ============================== */

interface CollapsedProps {
  navigate: ReturnType<typeof useNavigate>;
  onAutomationsContextMenu: (e: React.MouseEvent) => void;
  /** 全量项目(供 rail 搜索图标钮的 ConversationSearchBox 用)。 */
  allSearchProjects: ProjectNode[];
  /** rail 瓷砖数据源——全量 sessions，内部筛置顶。 */
  sessions: Session[];
  activeSessionId: string | undefined;
  /** 需关注 sessionIds（attention snapshot）——瓷砖右上角红点。 */
  notifications: ReadonlySet<string>;
  /** 与展开态共用的 1 维置顶顺序——rail 瓷砖按它排序,保证两视图次序一致。 */
  manualPinnedOrder: readonly string[];
  /** 瓷砖拖拽落定回调（新顺序 id 列表）——写回同一份 manualPinnedOrder。 */
  onReorder: (newOrderIds: string[]) => void;
}

/**
 * 瓷砖短标签（redesign 稿 rail tiles 的 KEY 语义）——稿内是人工缩写映射
 * （"网站 HTTPS 部署"→"部署"），程序侧用启发式逼近：
 *   - 标题以拉丁词开头 → 取第一个词（≤6 字符），如 "Maker Prompt优化" → "Maker"
 *   - 否则（CJK）→ 取前 2 字，与稿内 fallback `slice(0,2)` 一致
 * 完整标题/预览由 hover flyout 承担。
 */
function railTileLabel(title: string): string {
  const trimmed = title.trim();
  const latinWord = /^[A-Za-z0-9][A-Za-z0-9.-]*/.exec(trimmed)?.[0];
  if (latinWord && latinWord.length >= 2) return latinWord.slice(0, 6);
  return trimmed.slice(0, 2);
}

interface RailFlyoutState {
  session: Session;
  /** 瓷砖右缘视口坐标——flyout 渲染在其右侧 10px。 */
  anchorRight: number;
  anchorTop: number;
  isRunning: boolean;
  hasUnread: boolean;
}

/**
 * RailFlyout — rail 瓷砖 hover 弹出的 208px 预览卡（redesign 稿 .xdtsb-fly）。
 * 标题 + 最近消息预览 + 时间元信息；running 时整卡 muted。纯展示
 * （pointer-events:none），定位用 fixed + portal 到 body，避免被 aside
 * 的 overflow-hidden 裁切；首帧量高后再钳制 top 防出屏。
 */
function RailFlyout({ flyout }: { flyout: RailFlyoutState }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const desired = flyout.anchorTop - 4;
    const clamped = Math.max(8, Math.min(desired, window.innerHeight - el.offsetHeight - 8));
    setTop(clamped);
  }, [flyout]);

  const { session, isRunning, hasUnread } = flyout;
  // 任务现状摘要优先,与 SessionCard 同口径
  const flyoutPreview = session.summary ?? session.preview ?? null;
  const meta = [
    formatSidebarTime(session.updatedAt, t),
    hasUnread ? t('ccAgent.sidebar.railUnreadHint') : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className={cn(
        'pointer-events-none fixed z-[9999] w-[208px] rounded-xl',
        'bg-[var(--surface-elevated)] border border-sidebar-border',
        'px-3 pb-[11px] pt-[10px]',
      )}
      style={{
        left: flyout.anchorRight + 10,
        top: top ?? flyout.anchorTop - 4,
        visibility: top === null ? 'hidden' : undefined,
      }}
    >
      <div
        className={cn(
          'text-13 font-bold leading-[1.3]',
          isRunning ? 'text-[var(--cmd-palette-item-meta)]' : 'text-foreground',
        )}
      >
        {session.title}
      </div>
      {flyoutPreview && (
        <div
          className={cn(
            'mt-1 text-11 leading-[1.45]',
            '[display:-webkit-box] [-webkit-line-clamp:4] [-webkit-box-orient:vertical] overflow-hidden',
            isRunning ? 'text-[var(--text-disabled)]' : 'text-[var(--text-secondary)]',
          )}
        >
          {flyoutPreview}
        </div>
      )}
      <div className="mt-[7px] text-10 leading-none text-[var(--text-tertiary)]">{meta}</div>
    </div>,
    document.body,
  );
}

/**
 * CollapsedView — 折叠态 64px 竖排 rail（sidebar-card-mode redesign）。
 * 不再"完全消失"：新建/自动化按钮之下渲染置顶会话的竖排短标签瓷砖
 * （writing-mode: vertical-rl，2 字缩写），running 时标题呼吸 + 底部 mini
 * 进度条，hover 弹出 RailFlyout 预览卡（标题+最近消息+时间）。
 * 点击瓷砖直接导航——不必先展开侧栏。
 */
function CollapsedView({
  navigate,
  onAutomationsContextMenu,
  allSearchProjects,
  sessions,
  activeSessionId,
  notifications,
  manualPinnedOrder,
  onReorder,
}: CollapsedProps) {
  const reducedMotion = useReducedMotion();
  const { t } = useTranslation();
  // 只读 running 快照——**不传 options**：通知副作用（onSessionDone 等）由
  // ExpandedView 的实例独家持有，两个视图常驻挂载，双回调会重复发桌面通知。
  const { runningSessionIds } = useSessionRunningStatus(activeSessionId);
  // 后台子任务活跃会话同样点亮呼吸(与 ExpandedView 同口径,纯视觉合并)。
  const backgroundActivitySessionIds = useBackgroundActivitySessionIds();
  // 瓷砖未读点颜色按 attention kind(done 绿 / awaiting TapTap 蓝 / error 红);组件层
  // 取一次,renderItem 里查表(renderItem 非组件,不能 per-item 用 hook)。
  const attentionKinds = useSessionAttentionKinds();
  // 失败 automation urgency 集合 —— rail 瓷砖也要按此把 failed schedule 涂红,不能
  // 让"失败的定时任务"落到默认绿色 done tone(否则和 SessionItem 不一致,
  // 折叠视图会把失败误传成"完成了")。
  const urgentSet = useSessionAttentionUrgencySet();
  // delayed-create:与 ExpandedView 同——单按钮 navigate transient draft 单例。
  // 与展开态 SidebarTopNav 的通用「新建」同口径:只 navigate,不清空 newMakerDraft,
  // 保留用户上次在草稿页选好的「对话或选择项目」(切走再回来不重置);清空语义只属于
  // 「新建对话」等显式入口(handleCreateDialogue)。
  const handleNewCCS = useCallback(() => {
    navigate('/cc-agent/new', { state: makeNewMakerRouteState('generic') });
  }, [navigate]);
  const handleNavScheduled = useCallback(() => {
    navigate('/cc-agent/scheduled');
  }, [navigate]);
  const onScheduleMatch = useMatch('/cc-agent/scheduled');
  // 主视图切换(Skill 中心)——与展开态 SidebarTopNav 的 Skill 行同源:
  // 命中 skillhub 视图时高亮。折叠 rail 之前漏了这颗按钮(与展开态不一致),补上。
  const { activeKey, navigateToView } = useActiveMainView();

  // rail 只放置顶——与 redesign 稿一致（pinned cards → rail tiles）。
  // archived 的置顶不进 rail;Orca worker 会话(可从会话头置顶)也排除——展开态本就用
  // isOrcaWorkerSession 隐藏它们(实现细节会话),rail 不该把它们暴露出来(codex review)。
  // 顺序按 manualPinnedOrder 排（与展开态 visiblePinned
  // 同口径的稳定 rank 排序）：在 order 里的按下标排前面,不在的落末尾保持 base 序——
  // 这样 rail 拖出的次序与展开态一致,两视图共用同一份 1 维顺序。
  const pinnedSessions = useMemo(() => {
    const base = sessions.filter((s) => s.pinnedAt != null && s.status !== 'archived' && !isOrcaWorkerSession(s));
    if (manualPinnedOrder.length === 0) return base;
    const rank = new Map<string, number>();
    manualPinnedOrder.forEach((id, idx) => rank.set(id, idx));
    return base
      .slice()
      .sort(
        (a, b) =>
          (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
      );
  }, [sessions, manualPinnedOrder]);

  const handleTileClick = useCallback(
    async (id: string) => {
      if (id === activeSessionId) return;
      const target = sessions.find((s) => s.id === id);
      navigate(await resolveSessionRoute(id, target));
    },
    [activeSessionId, navigate, sessions],
  );

  // hover flyout（redesign 稿 .xdtsb-fly）——同一时刻最多一张
  const [flyout, setFlyout] = useState<RailFlyoutState | null>(null);

  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col items-center gap-[3px] overflow-y-auto px-2 pt-3 pb-2',
        // rail 太窄，原生 scrollbar 会吃掉瓷砖宽度——隐藏，滚动靠 wheel/trackpad
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
      )}
    >
      {/* rail 图标(新建/搜索/自动化)统一用 rail 配色,与展开态/Tabbar 同套 idle/hover/active。
          rail 保留圆钮形状(SIDEBAR_RAIL_ICON_BUTTON_CLASS),不引入自动隐藏托盘。 */}
      <SidebarIconButton
        icon={CirclePlus}
        label={t('ccAgent.layout.new')}
        variant="rail"
        onClick={handleNewCCS}
      />
      <ConversationSearchBox
        navigate={navigate}
        allKnownProjects={allSearchProjects}
        triggerClassName={SIDEBAR_RAIL_ICON_BUTTON_CLASS}
      />
      {/* 自动化 rail 入口 —— 仅导航,不再显示未读 dot(与展开态 SidebarTopNav 一致,
          未读 / 运行状态由展开后的各 schedule 组头承载)。 */}
      <SidebarIconButton
        icon={Clock}
        label={t('ccAgent.layout.automations')}
        aria-label={t('ccAgent.layout.automations')}
        aria-current={onScheduleMatch ? 'page' : undefined}
        variant="rail"
        active={Boolean(onScheduleMatch)}
        onClick={handleNavScheduled}
        onContextMenu={onAutomationsContextMenu}
      />
      <SidebarIconButton
        icon={Package}
        label={t('sidebar.tabs.skillhub')}
        variant="rail"
        active={activeKey === 'skillhub'}
        aria-current={activeKey === 'skillhub' ? 'page' : undefined}
        onClick={() => navigateToView('skillhub')}
      />

      {pinnedSessions.length > 0 && (
        <div className="my-[7px] h-px w-[22px] shrink-0 bg-sidebar-border" aria-hidden />
      )}

      {/* rail 瓷砖可拖排序(sidebar-card-mode v2):整块瓷砖整列竖向拖,落定写回
          同一份 manualPinnedOrder(onReorder)。瓷砖是 <button>,默认 filter 会挡
          按钮拖拽 → 传 filter='[data-no-drag]'(不含 button)放行整块拖;
          fallbackTolerance:4 保证"点击=导航、按住拖=排序"两不误。
          New/自动化按钮 + 分隔线在 SortableList 外,不参与排序。 */}
      <SortableList
        items={pinnedSessions}
        getId={(s) => s.id}
        onReorder={onReorder}
        reducedMotion={reducedMotion}
        filter="[data-no-drag]"
        className="flex w-full flex-col items-center gap-[3px]"
        renderItem={(session) => {
          const isActive = session.id === activeSessionId;
          const isRunning =
            runningSessionIds.has(session.id) || backgroundActivitySessionIds.has(session.id);
          const hasUnread = notifications.has(session.id);
          // 角标 tone:error(context 里的失败 schedule / attention 'error')红 >
          // awaiting TapTap 蓝 > 完成未读绿(普通/定时统一,与卡片、列表行同一张色表)。
          // urgentSet 覆盖"schedule 未读且失败"这类 attentionKind 缺失的场景 —— 避免
          // 失败 automation 在折叠 rail 上和成功一样落到绿色。
          const tileKind = attentionKinds.get(session.id);
          const isScheduleFailure = urgentSet.has(session.id);
          const tileTone =
            tileKind === 'error' || isScheduleFailure
              ? 'error'
              : tileKind === 'awaiting'
                ? 'awaiting'
                : 'done';
          return (
            <button
              onClick={() => void handleTileClick(session.id)}
              onMouseEnter={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setFlyout({ session, anchorRight: rect.right, anchorTop: rect.top, isRunning, hasUnread });
              }}
              onMouseLeave={() => setFlyout(null)}
              aria-label={session.title}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'relative flex shrink-0 flex-col items-center gap-1.5 rounded-[9px] px-2 py-[9px]',
                'transition-colors hover:bg-sidebar-item-hover',
                // redesign 稿 is-active 用 hover 同色（rail 上不需要更重的 active 灰）
                isActive && 'bg-sidebar-item-hover',
              )}
            >
              <span
                className={cn(
                  'whitespace-nowrap [writing-mode:vertical-rl] [text-orientation:mixed]',
                  'text-11 font-semibold leading-none tracking-[2px]',
                  isRunning
                    ? 'text-[var(--cmd-palette-item-meta)] session-status-breathing'
                    : 'text-foreground',
                )}
              >
                {railTileLabel(session.title)}
              </span>
              {isRunning && (
                <span
                  className="session-card-bar relative h-[2px] w-3.5 overflow-hidden rounded-full bg-sidebar-item-active"
                  aria-hidden
                />
              )}
              {hasUnread && (
                <AttentionDot
                  breathing
                  size={5}
                  tone={tileTone}
                  className="absolute right-[5px] top-[5px]"
                />
              )}
            </button>
          );
        }}
      />

      {flyout && <RailFlyout flyout={flyout} />}
    </div>
  );
}
