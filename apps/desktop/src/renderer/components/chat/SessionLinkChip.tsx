/**
 * SessionLinkChip — 聊天正文里 `xdt-maker://session/<id>[?message=<clientId>]`
 * 深链的行内 chip 渲染(图标 + 会话标题),点击跳转到对应会话;带 `?message=`
 * 锚点时进一步定位并高亮目标消息(复用会话搜索的 searchJump 机制)。
 *
 * 标题解析三级降级:
 *   1. 作者显式给的 label(`[自定义文案](xdt-maker://…)`)——作者意图优先,不查库;
 *   2. 异步查本地库(sessionService.get),miss 再查 device-link 远程会话镜像;
 *   3. 都查不到 → shortSessionId 短 ID(未知 / 离线设备的会话)。
 * 查询期间先显示短 ID,拿到标题后原地刷新——chip 宽度变化是行内文本流的自然
 * 重排,不产生视觉跳变(规则 7 的"先显示已有内容再增量刷新"口径)。
 *
 * 样式与 UserMessage 的 @file chip 同一套 token(--chat-input-chip-*),
 * inline-flex 不打断文本流;不硬编码颜色(规则 16)。
 */

import { useEffect, useMemo, useState } from 'react';
import { CornerDownRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { cn } from '@/lib/utils';
import { parseSessionDeepLinkHref } from '@/lib/deepLink';
import { resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import { shortSessionId } from '@/lib/sessionId';
import * as sessionService from '@/lib/sessionService';
import { useRemoteProjectSessions } from '@/features/device-link/remoteProjectsStore';
import { useSessionNavigationMode } from '@/features/cc-agent/embeddedSessionNavigation';

const chipClass = cn(
  'inline-flex max-w-full items-center gap-[3px] px-[5px] py-[0.5px]',
  'rounded-[4px] border',
  'bg-[var(--chat-input-chip-bg)]',
  'border-[var(--chat-input-chip-border)]',
  'text-[var(--chat-input-chip-text)]',
  'font-mono text-[13px] leading-[18px]',
  'relative top-[-1px] align-middle -my-[1px]',
);

export interface SessionLinkChipProps {
  href: string;
  /** 作者显式链接文案(`[label](…)`,label ≠ href 时传入);有值则不查标题。 */
  label?: string;
}

export function SessionLinkChip({ href, label }: SessionLinkChipProps) {
  const navigate = useNavigate();
  const navigationMode = useSessionNavigationMode();
  const target = useMemo(() => parseSessionDeepLinkHref(href), [href]);
  const remoteSessions = useRemoteProjectSessions();
  const [fetchedTitle, setFetchedTitle] = useState<string | null>(null);

  const sessionId = target?.sessionId ?? null;
  const explicitLabel = label?.trim() || null;

  useEffect(() => {
    // 先清旧值:同一实例被复用渲染另一个 href(虚拟列表 / 消息 patch)时,
    // 不能让上一个会话的标题串到新链接上(Codex review P2)。
    setFetchedTitle(null);
    if (!sessionId || explicitLabel) return;
    let cancelled = false;
    sessionService
      .get(sessionId)
      .then((session) => {
        if (!cancelled && session.title?.trim()) setFetchedTitle(session.title.trim());
      })
      .catch(() => {
        // 本地库没有(远程 / 未知会话)→ 静默,走 remote 镜像 / 短 ID 降级。
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, explicitLabel]);

  // 深链形状不合法(理论上被 tokenizer / 渲染分支挡住,防御性兜底)→ 纯文本。
  if (!target || !sessionId) return <span>{label ?? href}</span>;

  const remoteSession = remoteSessions.find((s) => s.id === sessionId) ?? null;
  const remoteTitle = fetchedTitle ? null : remoteSession?.title?.trim() || null;
  const display = explicitLabel ?? fetchedTitle ?? remoteTitle ?? shortSessionId(sessionId);
  const content = (
    <>
      <CornerDownRight size={12} className="shrink-0 text-[var(--chat-input-chip-icon)]" />
      <span className="min-w-0 truncate">{display}</span>
    </>
  );

  if (navigationMode === 'sidebar-embedded') {
    return (
      <span title={href} className={cn(chipClass, 'cursor-default')}>
        {content}
      </span>
    );
  }

  const handleClick = () => {
    // device-link 远程会话本地无 row,resolveSessionRoute 内部的 sessionService.get
    // 会 miss → 远程 Orca 会话被当普通会话路由,后续 redirect 会丢 searchJump 锚点。
    // 把远程镜像里的 session 对象直接传入,让 Orca 路由一步到位(Codex review P2)。
    void resolveSessionRoute(sessionId, remoteSession).then((route) => {
      navigate(
        route,
        target.messageClientId
          ? {
              state: {
                searchJump: {
                  kind: 'conversation-search',
                  sessionId,
                  messageId: target.messageClientId,
                  messageIdKind: 'clientId',
                  messageClientId: target.messageClientId,
                },
              },
            }
          : undefined,
      );
    });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title={href}
      className={cn(
        chipClass,
        'cursor-pointer transition-colors hover:bg-[var(--cmd-palette-item-hover)]',
      )}
    >
      {content}
    </button>
  );
}
