/**
 * WorkGroupBlock
 * ---------------------------------------------------------------------------
 * 「工作过程」组 — 一段连续的 tool_segment + thinking 从运行开始就由
 * MessageStream 的 groupWorkRuns pass 聚成稳定 work_group item。运行中默认
 * 展示最近 5 条真实活动;结束后收成一行「已工作 Xs ›」摘要。
 *
 * 交互契约(两级展开):
 *   - 运行中默认露出 latest-five preview;结束后默认 collapsed。组头与
 *     AgentActionsBlock / ThinkingCard 同款视觉(icon 14 + Inter 14 in
 *     `--msg-tool-card-chevron` + trailing chevron)。
 *   - 第一级:点开组只渲染子卡(AgentActionsBlock / ThinkingCard)的折叠头行,
 *     **不**替用户展开子卡内部 — 各子卡保持自身默认折叠态。
 *   - 第二级:用户在组内逐个点开想看的 thinking / 工具调用。
 *   - 展开状态走 useExpandedBlockMemory(`work:<groupKey>`),app 运行期内记住;
 *     子卡各自独立记忆,与组互不影响。
 *
 * 时长缺失(老历史数据没有 createdAt)时退化为「工作过程」文案,不显示时间。
 */

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, Layers, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { describeToolUse } from '@lizi/maker-shared';

import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/lib/makerChatStore';
import { useExpandedBlockMemory } from '@/hooks/useExpandedBlockMemory';
import { Spinner } from '@/components/ui/spinner';
import {
  verbForTool,
  verbLabelKeyForIntent,
  verbLabelKeyForRow,
} from '@/lib/agent-actions/verbAggregator';
import { extractDisplayParam } from '@/lib/agent-actions/actionPresentation';

import { AgentActionsBlock } from './AgentActionsBlock';
import { ThinkingCard, formatDuration } from './ThinkingCard';

/** work_group 子项的窄类型 — 与 MessageStream 的 RenderItem 解耦,由调用方映射。 */
export type WorkGroupChild =
  | {
      kind: 'tools';
      key: string;
      toolCalls: ChatMessage[];
      resultMap: Map<string, string>;
      settledIds: Set<string>;
    }
  | { kind: 'thinking'; key: string; message: ChatMessage }
  | { kind: 'rendered'; key: string; renderNode: () => ReactNode };

export type LiveWorkActivity =
  | { kind: 'tool'; key: string; message: ChatMessage; status: 'running' | 'done' }
  | { kind: 'thinking'; key: string; content: string };

/** 运行中默认只露出最近 5 条真实活动,与 Slack 远控的滚动窗口同一思路。 */
export const MAX_LIVE_WORK_ACTIVITIES = 5;

/** 把完整 work_group 历史投影成轻量 live preview。rendered assistant 文本
 *  不属于动作;空 / redacted thinking 也不生成「Thought for 1s」之类噪音行。 */
export function collectLiveWorkActivities(
  childItems: WorkGroupChild[],
  isStreaming: boolean,
): LiveWorkActivity[] {
  const activities: LiveWorkActivity[] = [];
  // 从尾部反扫,收够 5 条就停。live reasoning 每个 delta 都会触发 renderer
  // 更新,不能在这条热路径上反复 flatten 整段长历史。
  for (let childIdx = childItems.length - 1; childIdx >= 0; childIdx--) {
    const child = childItems[childIdx];
    if (child.kind === 'tools') {
      for (let toolIdx = child.toolCalls.length - 1; toolIdx >= 0; toolIdx--) {
        const message = child.toolCalls[toolIdx];
        const done =
          child.resultMap.has(message.clientId) || child.settledIds.has(message.clientId);
        activities.push({
          kind: 'tool',
          key: message.clientId,
          message,
          status: isStreaming && !done ? 'running' : 'done',
        });
        if (activities.length === MAX_LIVE_WORK_ACTIVITIES) return activities.reverse();
      }
      continue;
    }
    if (child.kind !== 'thinking' || child.message.thinkingRedacted) continue;
    const content = child.message.content.replace(/\s+/g, ' ').trim();
    if (!content) continue;
    activities.push({ kind: 'thinking', key: child.message.clientId, content });
    if (activities.length === MAX_LIVE_WORK_ACTIVITIES) return activities.reverse();
  }
  return activities.reverse();
}

export interface WorkGroupBlockProps {
  /** Stable persistence key, single-layer convention `work:<clientId>`. */
  blockId: string;
  /** Wall-clock span of the run; undefined when timestamps are unavailable. */
  durationMs?: number;
  /** True while this is the active trailing work run. */
  isStreaming?: boolean;
  /** Epoch ms of the first real activity, used for the live elapsed ticker. */
  startedAtMs?: number;
  childItems: WorkGroupChild[];
}

function ToolActivityRow({ activity }: { activity: Extract<LiveWorkActivity, { kind: 'tool' }> }) {
  const { t } = useTranslation();
  const toolName = activity.message.toolName ?? '';
  const descriptor = useMemo(
    () => describeToolUse(toolName, activity.message.toolInput),
    [activity.message.toolInput, toolName],
  );
  const displayParam = useMemo(() => extractDisplayParam(descriptor), [descriptor]);
  const hideVerb = descriptor.kind === 'command' && Boolean(descriptor.description);
  const intentAction =
    descriptor.kind === 'command' && !descriptor.description
      ? descriptor.intent?.action
      : undefined;
  const verbLabel = t(
    intentAction ? verbLabelKeyForIntent(intentAction) : verbLabelKeyForRow(verbForTool(toolName)),
  );
  const label = hideVerb
    ? (displayParam?.text ?? verbLabel)
    : displayParam
      ? `${verbLabel} ${displayParam.text}`
      : verbLabel;

  return (
    <div
      data-live-work-activity="tool"
      className="flex min-w-0 items-center gap-[6px] px-2 py-[3px]"
    >
      <span
        role="img"
        aria-label={t(`chat.agentActionRow.status.${activity.status}`)}
        className="inline-flex h-[18px] w-4 shrink-0 items-center justify-center text-[var(--msg-tool-card-chevron)]"
      >
        {activity.status === 'running' ? <Spinner size={13} /> : <Check size={13} />}
      </span>
      <span
        className="min-w-0 truncate text-[14px] text-[var(--msg-tool-card-chevron)]"
        title={displayParam?.fullTitle}
      >
        {label}
      </span>
    </div>
  );
}

function ThinkingActivityRow({
  activity,
}: {
  activity: Extract<LiveWorkActivity, { kind: 'thinking' }>;
}) {
  return (
    <div
      data-live-work-activity="thinking"
      className="flex min-w-0 items-center gap-[6px] px-2 py-[3px]"
    >
      <span className="inline-flex h-[18px] w-4 shrink-0 items-center justify-center text-[var(--msg-tool-card-chevron)]">
        <Sparkles size={13} />
      </span>
      <span
        className="min-w-0 truncate text-[14px] italic text-[var(--thinking-body-text)]"
        title={activity.content}
      >
        {activity.content}
      </span>
    </div>
  );
}

export function WorkGroupBlock({
  blockId,
  durationMs,
  isStreaming = false,
  startedAtMs,
  childItems,
}: WorkGroupBlockProps) {
  const { t } = useTranslation();
  const { expanded, setExpanded } = useExpandedBlockMemory(blockId);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!isStreaming || startedAtMs === undefined) return;
    setElapsedMs(Math.max(0, Date.now() - startedAtMs));
    const id = window.setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - startedAtMs));
    }, 500);
    return () => window.clearInterval(id);
  }, [isStreaming, startedAtMs]);

  const liveActivities = useMemo(
    () => collectLiveWorkActivities(childItems, isStreaming),
    [childItems, isStreaming],
  );

  // 两级展开:点开组只显示子卡折叠头行,内部 thinking / 工具调用不替用户展开,
  // 由用户在组内逐个点开。
  const onToggle = useCallback(() => {
    setExpanded((v) => !v);
  }, [setExpanded]);

  if (childItems.length === 0) return null;

  // durationMs === 0(同毫秒时间戳的极短 run)也显示时长 — formatDuration
  // 自带最小 1s 钳制;只有时间戳缺失(undefined)才退化为无时长文案。
  const summaryText = isStreaming
    ? t('chat.workGroup.working')
    : durationMs !== undefined
      ? t('chat.workGroup.worked', { duration: formatDuration(durationMs) })
      : t('chat.workGroup.workDetails');

  return (
    <div className="flex w-full justify-start">
      <div className="w-full">
        <button
          type="button"
          onClick={onToggle}
          className={cn(
            'flex w-full items-center gap-[6px] py-[2px]',
            'select-none cursor-pointer',
            'hover:opacity-80 transition-opacity',
            'text-left',
          )}
          aria-expanded={expanded}
        >
          <span className="inline-flex h-[1lh] items-center shrink-0">
            {isStreaming ? (
              <Spinner size={14} className="text-[var(--msg-tool-card-chevron)]" />
            ) : (
              <Layers size={14} className="text-[var(--msg-tool-card-chevron)]" />
            )}
          </span>
          <span className="text-14 text-[var(--msg-tool-card-chevron)] truncate min-w-0 translate-y-[1px]">
            {summaryText}
          </span>
          <div className="flex-1" />
          {isStreaming && startedAtMs !== undefined && (
            <span className="font-mono text-12 text-[var(--msg-tool-card-chevron)]">
              {formatDuration(elapsedMs)}
            </span>
          )}
          {expanded ? (
            <ChevronDown size={14} className="shrink-0 text-[var(--msg-tool-card-chevron)]" />
          ) : (
            <ChevronRight size={14} className="shrink-0 text-[var(--msg-tool-card-chevron)]" />
          )}
        </button>

        {isStreaming && !expanded && liveActivities.length > 0 && (
          <div
            data-live-work-preview="true"
            className={cn(
              'mt-1 border-l-2 border-[var(--agent-actions-rail)] py-[2px] pl-3',
              'flex flex-col',
            )}
          >
            {liveActivities.map((activity) =>
              activity.kind === 'tool' ? (
                <ToolActivityRow key={activity.key} activity={activity} />
              ) : (
                <ThinkingActivityRow key={activity.key} activity={activity} />
              ),
            )}
          </div>
        )}

        {expanded && (
          <div
            className={cn(
              'mt-1 pl-3 py-[2px]',
              'border-l-2 border-[var(--agent-actions-rail)]',
              'flex flex-col gap-2',
            )}
          >
            {childItems.map((c) =>
              c.kind === 'tools' ? (
                <AgentActionsBlock
                  key={c.key}
                  toolCalls={c.toolCalls}
                  resultMap={c.resultMap}
                  settledIds={c.settledIds}
                  isSessionStreaming={isStreaming}
                />
              ) : c.kind === 'thinking' ? (
                <ThinkingCard
                  key={c.key}
                  blockKey={c.message.clientId}
                  content={c.message.content}
                  isStreaming={c.message.isStreaming}
                  startedAt={c.message.thinkingStartedAt}
                  durationMs={c.message.thinkingDurationMs}
                  isRedacted={c.message.thinkingRedacted}
                />
              ) : (
                <Fragment key={c.key}>{c.renderNode()}</Fragment>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}
