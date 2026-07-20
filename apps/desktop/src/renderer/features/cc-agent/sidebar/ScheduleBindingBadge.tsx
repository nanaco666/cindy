/**
 * ScheduleBindingBadge — 会话被自动化任务(heartbeat schedule)绑定时的标识。
 *
 * 数据来自 useSessionBoundSchedules(schedulesStore 反向索引):schedule 删除 /
 * 过期后列表为空,调用方据此不渲染,徽章自动消失。SessionItem(size 10)与
 * SessionContentHeader(size 13)共用。
 *
 * 视觉:lucide Timer + meta 灰,与 scheduler 频率 chip 同图标语义("挂在定时器
 * 上"),区别于"自动化创建"的 Clock。全部绑定均 paused 时主图标弱化 + 右下叠
 * Pause mini-badge(视觉语言照 AutomationSessionGroupItem)。
 */

import { Pause, Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import type { Schedule } from '@lizi/maker-scheduler';

import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';
import {
  cronToConfig,
  summarizeConfig,
} from '@/features/scheduler/lib/cronCodexPreset';
import { scheduleFocusPath } from '@/features/scheduler/lib/scheduleSessionBinding';

export interface ScheduleBindingBadgeProps {
  /** 绑定到当前会话的 schedules(expired 已由 selector 滤掉)。空数组不渲染。 */
  schedules: readonly Schedule[];
  /** Timer 图标尺寸,sidebar 10 / header 13。 */
  size?: number;
  className?: string;
  /** 宿主行处于红胶囊选中态 → Timer 反白(用户规则 2026-07-19:选中态前景与文字同色)。 */
  activeForeground?: boolean;
}

/** 单条 schedule 的触发频率文案(与 RunHistoryPane 同源逻辑)。 */
function frequencyText(
  schedule: Schedule,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  return schedule.manual
    ? t('scheduler.detail.manualTrigger')
    : summarizeConfig(cronToConfig(schedule.cronExpr));
}

export function ScheduleBindingBadge({
  schedules,
  size = 10,
  className,
  activeForeground = false,
}: ScheduleBindingBadgeProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  if (schedules.length === 0) return null;

  const allPaused = schedules.every((s) => s.status === 'paused');

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          aria-label={t('ccAgent.sidebar.scheduleBinding.viewTask')}
          onClick={(e) => {
            // 防止冒泡触发 SessionItem 行导航(与 WorktreeBadge 同款处理)
            e.stopPropagation();
            navigate(scheduleFocusPath(schedules[0].id));
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className={cn(
            'relative inline-flex size-3 shrink-0 items-center justify-center',
            'cursor-pointer focus:outline-none',
            className,
          )}
        >
          <Timer
            size={size}
            strokeWidth={1.75}
            className={cn(
              activeForeground
                ? 'text-[var(--sidebar-item-active-foreground)]'
                : 'text-[var(--cmd-palette-item-meta)] hover:text-foreground transition-colors',
              allPaused && 'opacity-60',
            )}
            aria-hidden
          />
          {allPaused && (
            <span
              aria-hidden
              className={cn(
                'absolute -bottom-1 -right-1 flex size-2.5 items-center justify-center rounded-full',
                // 反白态下角标随红胶囊取色(底=胶囊底遮住 Timer,前景反白),
                // 否则沿用页面级 chip 配色。
                activeForeground
                  ? 'border border-[var(--sidebar-item-active-border)] bg-sidebar-item-active text-[var(--sidebar-item-active-foreground)]'
                  : 'border border-[var(--cmd-palette-border)] bg-[var(--chat-input-chip-bg)] text-[var(--cmd-palette-item-meta)]',
              )}
            >
              <Pause size={6} strokeWidth={3} />
            </span>
          )}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Content side="top" variant="mono">
        <div className="flex flex-col gap-1">
          <span>{t('ccAgent.sidebar.scheduleBinding.label')}</span>
          {schedules.map((s) => (
            <div key={s.id} className="flex flex-col gap-0.5">
              <span>
                {t('ccAgent.sidebar.scheduleBinding.tooltipName', { name: s.name })}
                {s.status === 'paused'
                  ? ` ${t('ccAgent.sidebar.scheduleBinding.pausedSuffix')}`
                  : ''}
              </span>
              <span>
                {t('ccAgent.sidebar.scheduleBinding.tooltipFrequency', {
                  frequency: frequencyText(s, t),
                })}
              </span>
            </div>
          ))}
        </div>
      </Tooltip.Content>
    </Tooltip.Root>
  );
}
