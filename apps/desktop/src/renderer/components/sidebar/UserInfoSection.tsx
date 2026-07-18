import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Flame } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useUpdateStatus } from '@/hooks/useUpdateStatus';
import { useUpdateBannerDismiss } from '@/hooks/useUpdateBannerDismiss';

interface UserInfoSectionProps {
  isCollapsed: boolean;
  onOpenUpdateNotice?: () => void;
}

export function UserInfoSection({ isCollapsed, onOpenUpdateNotice }: UserInfoSectionProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [avatarError, setAvatarError] = useState(false);
  const { t } = useTranslation();

  // 火焰按钮双职责:
  // - 正常情况(无 pending update 或 banner 未 dismiss)→ 弹更新历史 Dialog。
  // - 有 pending update 且 banner 已被 dismiss → 涂黑 + 点击唤回 banner
  //   (更新历史入口暂时让位,banner 再次出现后关掉才会回到"历史入口"模式)。
  const { status } = useUpdateStatus();
  const { dismissed, restore } = useUpdateBannerDismiss();
  const hasPendingUpdate = status === 'ready' || status === 'superseding';
  const isFlameReopen = hasPendingUpdate && dismissed;

  // 头像地址变化(设置页改头像 / 服务端资料更新)时重置加载失败标记,
  // 让新地址有机会渲染,而不是永远停在首字母兜底。
  const avatarUrl = user?.avatar ?? null;
  useEffect(() => {
    setAvatarError(false);
  }, [avatarUrl]);

  if (!user) return null;

  const initial = user.name.charAt(0).toUpperCase();
  const appDisplayVersion = window.electronAPI.appDisplayVersion;
  const appDisplayVersionDetail = window.electronAPI.appDisplayVersionDetail;

  const handleClick = () => {
    if (location.pathname !== '/settings') {
      navigate('/settings');
    }
  };

  return (
    <div className="mt-auto border-t border-sidebar-border h-[66px] px-3 flex items-center transition-colors hover:bg-sidebar-item-hover has-[.flame-btn:hover]:!bg-transparent">
      <button
        onClick={handleClick}
        role="link"
        aria-label={t('sidebar.user.settingsLink', { name: user.name })}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-[10px]',
          'text-left',
          isCollapsed && 'justify-center',
        )}
      >
        {/* Avatar(admin 角标已随产品 role 退役,2026-07) */}
        <div className="relative h-9 w-9 shrink-0">
          {user.avatar && !avatarError ? (
            <img
              src={user.avatar}
              alt={user.name}
              className="h-9 w-9 rounded-full object-cover"
              onError={() => setAvatarError(true)}
            />
          ) : (
            <div
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-full',
                'bg-sidebar-item-hover text-base font-medium text-foreground',
                // 无头像兜底加一圈细描边(与侧边栏分隔线同 token)
                'border border-sidebar-border',
              )}
            >
              {initial}
            </div>
          )}
        </div>

        {/* Name & version — fade in/out with collapse。
            折叠 rail（64px）下必须整个移出布局（hidden）——flex-1 占位会把
            头像挤出 64px 可视区（旧 w-0 折叠时代 opacity 即可，rail 时代不行）。 */}
        <div
          className={cn(
            'flex h-9 min-w-0 flex-1 translate-y-[2px] flex-col justify-center',
            'transition-opacity duration-200 ease-in-out',
            isCollapsed ? 'hidden' : 'opacity-100',
          )}
        >
          <p className="truncate text-sm font-medium leading-tight text-foreground">
            {user.name}
          </p>
          {/* 2px gap 对齐 cc-agent-view.pen 里 userNameContainer 的 gap: 2 */}
          <p className="mt-0.5 truncate text-xs leading-tight text-sidebar-muted" title={appDisplayVersionDetail}>
            {appDisplayVersion}
          </p>
        </div>
      </button>

      {/* Flame icon button — 默认打开更新历史;banner 被 dismiss 且有 pending
          update 时切换为「唤回 banner」入口,视觉涂黑(fill 实心 + foreground 主色)
          告诉用户还有更新等待确认。 */}
      {(onOpenUpdateNotice || isFlameReopen) && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (isFlameReopen) {
              restore();
            } else {
              onOpenUpdateNotice?.();
            }
          }}
          aria-label={
            isFlameReopen
              ? t('sidebar.user.reopenUpdateBanner')
              : t('sidebar.user.viewReleaseNotes')
          }
          className={cn(
            'flame-btn',
            'flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full',
            'transition-colors hover:bg-sidebar-item-hover',
            'transition-opacity duration-200 ease-in-out',
            // rail 折叠态整体移出布局——38px 占位会把头像挤出 64px rail
            isCollapsed ? 'hidden' : 'opacity-100',
          )}
        >
          <Flame
            className={cn(
              'h-5 w-5',
              isFlameReopen
                ? 'fill-current text-foreground'
                : 'text-[hsl(var(--sidebar-muted))]',
            )}
          />
        </button>
      )}
    </div>
  );
}
