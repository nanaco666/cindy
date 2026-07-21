/**
 * RailNav — 折叠 rail 的「置顶(平铺)/ 项目 / 对话」入口瓷砖(rail redesign v10)。
 * ---------------------------------------------------------------------------
 * 结构(用户定稿):
 *   - 置顶:全部置顶会话平铺在第一层(功能钮同款圆钮 + 下方 2~4 字简介),
 *     点击直达;hover 单张预览卡(标题 + 任务摘要 + 时间,纯展示);
 *   - 项目 / 对话:各一枚圆钮,hover 打开二级面板 —— **面板内容不在本组件**:
 *     瓷砖只通过 railPanelStore 发布「开哪段 + 锚点」,面板由 ExpandedView 的
 *     RailPanels 渲染(复用展开态全套会话行为,见 railPanelStore 头注)。
 *
 * 美术与顶部功能钮同套:SIDEBAR_RAIL_ICON_BUTTON_CLASS(h-9 圆钮三态);
 * 灯语全端统一:running → 图标呼吸橙(动画挂 wrapper 不挂 SVG);未读 →
 * AttentionDot(红 error > 蓝 awaiting > 绿 done,组入口取聚合最高,
 * 6px right-1.5 top-1.5 与 SidebarIconButton showDot 同位)。
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Folder, MessageCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { useNavigate } from 'react-router-dom';

import { cn } from '@/lib/utils';
import type { Session } from '@/lib/ccAgent.types';
import type { AttentionKind } from '@/lib/sessionAttentionStore';
import { AttentionDot } from '@/components/sidebar/AttentionDot';
import { isOrcaWorkerSession, resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import { SessionStatusIcon } from './SessionStatusIcon';
import { formatSidebarTime } from '../lib/formatSidebarTime';
import { sessionActivityMs } from '../lib/dateSessionGrouping';
import { railPanelStore, type RailPanelSection } from './railPanelStore';

/** 预览卡宽度(px)——旧 RailFlyout 同宽。 */
const PREVIEW_WIDTH = 208;
/** 对话段聚合灯的取样窗口(与 RailPanels 对话面板一致的最近序)。 */
const DIALOGUE_LAMP_LIMIT = 20;

export interface RailNavProps {
  navigate: ReturnType<typeof useNavigate>;
  /** 全量可见 sessions(本地 + 远程镜像合并)——置顶/对话段数据源。 */
  sessions: Session[];
  activeSessionId: string | undefined;
  /** 与展开态共用的置顶顺序(平铺瓷砖同序)。 */
  manualPinnedOrder: readonly string[];
  /** 运行中集合(含后台意识活动)。 */
  runningSessionIds: ReadonlySet<string>;
  /** 未读集 = attention 快照 ∪ 定时任务未读运行。 */
  notifications: ReadonlySet<string>;
  attentionKinds: ReadonlyMap<string, AttentionKind>;
  /** 失败 schedule urgency 集合(kind 缺失时兜底判红)。 */
  urgentSessionIds: ReadonlySet<string>;
  /** /ctr 接管中的会话集合。 */
  attachedSessionIds: ReadonlySet<string>;
}

const TONE_RANK: Record<AttentionKind, number> = { error: 3, awaiting: 2, done: 1 };

/** 置顶瓷砖短标签:拉丁首词 ≤7 字符,否则 CJK 取前 4 字(CSS ellipsis 兜底)。 */
function pinnedTileLabel(title: string): string {
  const trimmed = title.trim();
  const latinWord = /^[A-Za-z0-9][A-Za-z0-9.-]*/.exec(trimmed)?.[0];
  if (latinWord && latinWord.length >= 2) return latinWord.slice(0, 7);
  return trimmed.slice(0, 4);
}

function dotToneOf(
  id: string,
  notifications: ReadonlySet<string>,
  attentionKinds: ReadonlyMap<string, AttentionKind>,
  urgentSessionIds: ReadonlySet<string>,
): AttentionKind | null {
  if (!notifications.has(id)) return null;
  const kind = attentionKinds.get(id);
  if (kind === 'error' || urgentSessionIds.has(id)) return 'error';
  if (kind === 'awaiting') return 'awaiting';
  return 'done';
}

interface PreviewState {
  session: Session;
  anchorRight: number;
  anchorTop: number;
  isRunning: boolean;
  hasUnread: boolean;
}

/**
 * 置顶瓷砖 hover 的单张预览卡(旧 RailFlyout 语义):标题 + 任务现状摘要 +
 * 时间;running 时整卡 muted。纯展示(pointer-events:none),portal + fixed,
 * 首帧量高后钳制 top 防出屏。
 */
function SessionPreviewCard({ preview }: { preview: PreviewState }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const desired = preview.anchorTop - 4;
    setTop(Math.max(8, Math.min(desired, window.innerHeight - el.offsetHeight - 8)));
  }, [preview]);

  const { session, isRunning, hasUnread } = preview;
  const body = session.summary ?? session.preview ?? null;
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
        'pointer-events-none fixed z-[9999] rounded-xl',
        'bg-[var(--surface-elevated)] border border-sidebar-border',
        'px-3 pb-[11px] pt-[10px]',
      )}
      style={{
        left: preview.anchorRight + 10,
        top: top ?? preview.anchorTop - 4,
        width: PREVIEW_WIDTH,
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
      {body && (
        <div
          className={cn(
            'mt-1 text-11 leading-[1.45]',
            '[display:-webkit-box] [-webkit-line-clamp:4] [-webkit-box-orient:vertical] overflow-hidden',
            isRunning ? 'text-[var(--text-disabled)]' : 'text-[var(--text-secondary)]',
          )}
        >
          {body}
        </div>
      )}
      <div className="mt-[7px] text-10 leading-none text-[var(--text-tertiary)]">{meta}</div>
    </div>,
    document.body,
  );
}

export function RailNav({
  navigate,
  sessions,
  activeSessionId,
  manualPinnedOrder,
  runningSessionIds,
  notifications,
  attentionKinds,
  urgentSessionIds,
  attachedSessionIds,
}: RailNavProps) {
  const { t } = useTranslation();
  const panelState = useSyncExternalStore(railPanelStore.subscribe, railPanelStore.getSnapshot);

  // ── 数据切片(与展开态同口径) ──
  const pinnedSessions = useMemo(() => {
    const base = sessions.filter(
      (s) => s.pinnedAt != null && s.status !== 'archived' && !isOrcaWorkerSession(s),
    );
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

  const dialogueLampSessions = useMemo(
    () =>
      sessions
        .filter(
          (s) =>
            s.workspaceKind === 'dialogue' && s.status !== 'archived' && !isOrcaWorkerSession(s),
        )
        .sort((a, b) => sessionActivityMs(b) - sessionActivityMs(a))
        .slice(0, DIALOGUE_LAMP_LIMIT),
    [sessions],
  );

  const aggregate = useCallback(
    (list: readonly Session[]) => {
      let running = false;
      let best: AttentionKind | null = null;
      for (const s of list) {
        if (runningSessionIds.has(s.id)) running = true;
        const tone = dotToneOf(s.id, notifications, attentionKinds, urgentSessionIds);
        if (tone && (!best || TONE_RANK[tone] > TONE_RANK[best])) best = tone;
      }
      return { running, dotTone: best };
    },
    [runningSessionIds, notifications, attentionKinds, urgentSessionIds],
  );

  // 项目段聚合灯从 sessions(sessionsWithRemote,已按机器切换过滤)派生 ——
  // 与置顶/对话灯同一数据口径,也与面板主过滤一致;不用全量搜索 universe
  // (那是跨机器全集,会为面板里看不到的项目点灯,review P1)。
  const projectLampSessions = useMemo(
    () =>
      sessions.filter(
        (s) =>
          s.workspaceKind === 'project' && s.status !== 'archived' && !isOrcaWorkerSession(s),
      ),
    [sessions],
  );
  const projectsAgg = useMemo(
    () => aggregate(projectLampSessions),
    [aggregate, projectLampSessions],
  );
  const dialoguesAgg = useMemo(
    () => aggregate(dialogueLampSessions),
    [aggregate, dialogueLampSessions],
  );

  const [preview, setPreview] = useState<PreviewState | null>(null);

  const handlePinnedClick = useCallback(
    async (id: string) => {
      setPreview(null);
      railPanelStore.closeAll();
      if (id === activeSessionId) return;
      const target = sessions.find((s) => s.id === id);
      navigate(await resolveSessionRoute(id, target));
    },
    [activeSessionId, navigate, sessions],
  );

  const openSectionAt = useCallback((section: RailPanelSection, el: HTMLElement) => {
    setPreview(null);
    const rect = el.getBoundingClientRect();
    railPanelStore.openSection(section, { right: rect.right, top: rect.top });
  }, []);

  return (
    <>
      {/* ── 置顶:平铺瓷砖(顶层直达)= 功能钮同款圆钮 + 下方 2~4 字简介。
          圆钮几何/配色镜像 SIDEBAR_RAIL_ICON_BUTTON_CLASS(hover 改挂 group:
          指针落在标签上也要点亮圆底,官方 class 的 hover 只作用于自身)。 ── */}
      {pinnedSessions.map((session) => {
        const isActive = session.id === activeSessionId;
        const isRunning = runningSessionIds.has(session.id);
        return (
          <button
            key={session.id}
            aria-label={session.title}
            aria-current={isActive ? 'page' : undefined}
            onClick={() => void handlePinnedClick(session.id)}
            onMouseEnter={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setPreview({
                session,
                anchorRight: rect.right,
                anchorTop: rect.top,
                isRunning,
                hasUnread: notifications.has(session.id),
              });
            }}
            onMouseLeave={() => setPreview(null)}
            className="group/pin flex w-full shrink-0 flex-col items-center gap-[2px] py-[2px]"
          >
            <span
              className={cn(
                'relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                'transition-colors duration-150',
                // 选中态用「选中胶囊」三件套 token(bg / border / foreground 配套,
                // SessionStatusIcon isActive 时自涂 active-foreground,必须同底出现;
                // 反相胶囊主题下混用功能钮 chip-bg 会得到白字浮浅灰的断层)。
                isActive
                  ? 'bg-sidebar-item-active border border-[var(--sidebar-item-active-border)]'
                  : 'text-[hsl(var(--titlebar-icon))] group-hover/pin:bg-[var(--update-btn-hover)]',
              )}
            >
              <SessionStatusIcon
                session={session}
                isRunning={isRunning}
                isAttached={attachedSessionIds.has(session.id)}
                hasAttentionNotification={notifications.has(session.id)}
                isActive={isActive}
                size={15}
              />
            </span>
            <span
              className={cn(
                'max-w-[56px] truncate text-[10px] font-medium leading-[1.2]',
                // 标签在 rail 底色上(胶囊之外),active 用正文色加粗,
                // 不用 active-foreground(那是胶囊底上的前景,底色外会失配)。
                isActive
                  ? 'font-semibold text-foreground'
                  : 'text-[var(--text-secondary)] group-hover/pin:text-foreground',
              )}
            >
              {pinnedTileLabel(session.title)}
            </span>
          </button>
        );
      })}

      {pinnedSessions.length > 0 && (
        <div className="my-[7px] h-px w-[22px] shrink-0 bg-sidebar-border" aria-hidden />
      )}

      {/* ── 项目 / 对话:功能钮同款圆钮;hover/点击经 railPanelStore 通知
          ExpandedView 的 RailPanels 渲染面板。呼吸橙挂 wrapper,状态点同位。 ── */}
      {(
        [
          ['projects', <Folder key="i" size={18} aria-hidden />, projectsAgg],
          ['dialogues', <MessageCircle key="i" size={18} aria-hidden />, dialoguesAgg],
        ] as const
      ).map(([key, icon, agg]) => (
        <button
          key={key}
          data-rail-panel-trigger={key}
          aria-label={t(`ccAgent.sidebar.railNav.${key}`)}
          title={t(`ccAgent.sidebar.railNav.${key}`)}
          aria-haspopup="menu"
          aria-expanded={panelState.openSection === key}
          onMouseEnter={(e) => openSectionAt(key, e.currentTarget)}
          onMouseLeave={() => railPanelStore.scheduleClose()}
          onClick={(e) => openSectionAt(key, e.currentTarget)}
          className={cn(
            'relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors duration-150',
            panelState.openSection === key
              ? 'bg-[var(--chat-input-chip-bg)] text-[var(--msg-assistant-text)]'
              : 'text-[hsl(var(--titlebar-icon))] hover:bg-[var(--update-btn-hover)]',
          )}
        >
          <span
            className={cn(
              'inline-flex',
              agg.running && 'text-[var(--status-bar-accent)] session-status-breathing',
            )}
          >
            {icon}
          </span>
          {agg.dotTone && (
            <AttentionDot size={6} tone={agg.dotTone} className="absolute right-1.5 top-1.5" />
          )}
        </button>
      ))}

      {preview && <SessionPreviewCard preview={preview} />}
    </>
  );
}
