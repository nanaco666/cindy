/**
 * WorkGroupBlock
 * ---------------------------------------------------------------------------
 * 折叠的「工作过程」组 — 一段连续的 tool_segment + thinking(中间无正文)在
 * 后续正文出现(或 turn 结束)后,由 MessageStream 的 groupWorkRuns pass 聚成
 * work_group item,这里渲染成一行「已工作 Xs ›」摘要。
 *
 * 交互契约(两级展开):
 *   - **Default collapsed**,与 AgentActionsBlock / ThinkingCard 同款视觉
 *     (icon 14 + Inter 14 in `--msg-tool-card-chevron` + trailing chevron)。
 *   - 第一级:点开组只渲染子卡(AgentActionsBlock / ThinkingCard)的折叠头行,
 *     **不**替用户展开子卡内部 — 各子卡保持自身默认折叠态。
 *   - 第二级:用户在组内逐个点开想看的 thinking / 工具调用。
 *   - 展开状态走 useExpandedBlockMemory(`work:<groupKey>`),app 运行期内记住;
 *     子卡各自独立记忆,与组互不影响。
 *
 * 时长缺失(老历史数据没有 createdAt)时退化为「工作过程」文案,不显示时间。
 */

import { Fragment, useCallback, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/lib/makerChatStore';
import { useExpandedBlockMemory } from '@/hooks/useExpandedBlockMemory';

import { AgentActionsBlock } from './AgentActionsBlock';
import { ThinkingCard, formatDuration } from './ThinkingCard';

/** work_group 子项的窄类型 — 与 MessageStream 的 RenderItem 解耦,由调用方映射。 */
export type WorkGroupChild =
  | { kind: 'tools'; key: string; toolCalls: ChatMessage[]; resultMap: Map<string, string> }
  | { kind: 'thinking'; key: string; message: ChatMessage }
  | { kind: 'rendered'; key: string; renderNode: () => ReactNode };

export interface WorkGroupBlockProps {
  /** Stable persistence key, single-layer convention `work:<clientId>`. */
  blockId: string;
  /** Wall-clock span of the run; undefined when timestamps are unavailable. */
  durationMs?: number;
  childItems: WorkGroupChild[];
}

export function WorkGroupBlock({ blockId, durationMs, childItems }: WorkGroupBlockProps) {
  const { t } = useTranslation();
  const { expanded, setExpanded } = useExpandedBlockMemory(blockId);

  // 两级展开:点开组只显示子卡折叠头行,内部 thinking / 工具调用不替用户展开,
  // 由用户在组内逐个点开。
  const onToggle = useCallback(() => {
    setExpanded((v) => !v);
  }, [setExpanded]);

  if (childItems.length === 0) return null;

  // durationMs === 0(同毫秒时间戳的极短 run)也显示时长 — formatDuration
  // 自带最小 1s 钳制;只有时间戳缺失(undefined)才退化为无时长文案。
  const summaryText =
    durationMs !== undefined
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
            <Layers size={14} className="text-[var(--msg-tool-card-chevron)]" />
          </span>
          <span className="text-14 text-[var(--msg-tool-card-chevron)] truncate min-w-0 translate-y-[1px]">
            {summaryText}
          </span>
          <div className="flex-1" />
          {expanded ? (
            <ChevronDown size={14} className="shrink-0 text-[var(--msg-tool-card-chevron)]" />
          ) : (
            <ChevronRight size={14} className="shrink-0 text-[var(--msg-tool-card-chevron)]" />
          )}
        </button>

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
                <AgentActionsBlock key={c.key} toolCalls={c.toolCalls} resultMap={c.resultMap} />
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
