/**
 * BoundSessionCard — 任务编辑表单里"持续会话已绑定"形态的展示卡片。
 *
 * 仅用于 persistent 已绑(runner 回写 targetSessionId):该形态没有会话选择器,
 * 需要卡片承载绑定信息。bound(手绑)形态由 ThreadPickerInline 单行选择器
 * 承担,不用本卡片。内容:会话标题 + vendor 图标 + 打开会话 + 解除绑定 +
 * "归档后自动重建续绑"说明。
 *
 * 标题查找:useCCSessions('active') 命中 → miss 时 sessionService.get 兜底
 * (归档会话不在 active 桶,单条查询比拉全量 'all' 桶省)→ 仍找不到回退
 * id 前 8 位。project 自动化模式不传 onUnbind(loader 的 update input 不含
 * targetSessionId key,解绑无法落库,提供按钮只会制造静默失败)。
 */

import { useEffect, useState } from 'react';
import { ExternalLink, Unlink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type { Session } from '@/lib/ccAgent.types';
import * as sessionService from '@/lib/sessionService';
import { useCCSessions } from '@/hooks/useCCSessions';
import { VendorIcon } from '@/components/sidebar/VendorIcon';

export interface BoundSessionCardProps {
  sessionId: string;
  /** 不传 = 不显示解绑按钮(project 自动化模式)。 */
  onUnbind?: () => void;
  /** 点击"打开会话":调用方负责 navigate + 关闭 dialog。 */
  onOpen: () => void;
}

export function BoundSessionCard({ sessionId, onUnbind, onOpen }: BoundSessionCardProps) {
  const { t } = useTranslation();
  const { sessions } = useCCSessions({ includeArchived: 'active' });
  const fromStore = sessions.find((s) => s.id === sessionId) ?? null;
  const [fetched, setFetched] = useState<Session | null>(null);

  useEffect(() => {
    if (fromStore) return;
    let alive = true;
    void sessionService
      .get(sessionId)
      .then((s) => {
        if (alive) setFetched(s);
      })
      .catch(() => {
        /* 找不到(已删除等)→ 回退 id 前 8 位显示 */
      });
    return () => {
      alive = false;
    };
  }, [sessionId, fromStore]);

  // fetched 必须按 id 校验:卡片挂载期间 sessionId 变化(连续编辑多个已绑任务)
  // 时,旧绑定的查询结果会残留;新查询失败(会话已删)时若不校验,会永远显示
  // 上一个会话的标题而非 id 兜底(PR #103 review)。
  const session = fromStore ?? (fetched?.id === sessionId ? fetched : null);
  const title =
    session?.title?.trim() ||
    t('scheduler.editor.runSession.card.fallbackTitle', { id: sessionId.slice(0, 8) });

  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-[10px] px-3 py-2',
        'border border-[var(--cmd-palette-border)] bg-[var(--chat-input-chip-bg)]',
      )}
    >
      <VendorIcon vendor={session?.agentKind === 'codex' ? 'codex' : 'cc'} size={13} />
      <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--msg-assistant-text)]" title={title}>
        {title}
      </span>
      <span className="hidden min-w-0 shrink-[2] truncate text-xs text-[var(--cmd-palette-item-meta)] sm:inline">
        {t('scheduler.editor.runSession.card.persistentNote')}
      </span>
      <button
        type="button"
        onClick={onOpen}
        title={t('scheduler.editor.runSession.card.open')}
        className={cn(
          'inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium',
          'text-[var(--settings-btn-secondary-text)] hover:bg-[var(--surface-hover)]',
          'transition-colors focus:outline-none',
        )}
      >
        <ExternalLink size={12} strokeWidth={1.75} aria-hidden />
        {t('scheduler.editor.runSession.card.open')}
      </button>
      {onUnbind && (
        <button
          type="button"
          onClick={onUnbind}
          title={t('scheduler.editor.runSession.card.unbind')}
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium',
            'text-[var(--settings-btn-secondary-text)] hover:bg-[var(--surface-hover)]',
            'transition-colors focus:outline-none',
          )}
        >
          <Unlink size={12} strokeWidth={1.75} aria-hidden />
          {t('scheduler.editor.runSession.card.unbind')}
        </button>
      )}
    </div>
  );
}
