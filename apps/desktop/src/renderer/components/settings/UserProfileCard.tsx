import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { ProfileEditDialog } from './ProfileEditDialog';

export function UserProfileCard() {
  const { user } = useAuth();
  const [avatarError, setAvatarError] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const { t } = useTranslation();

  // 换头像(本地覆写保存 / 服务端资料更新)后给新地址重试的机会,
  // 不让一次历史加载失败永远钉死在首字母兜底上。
  const avatarUrl = user?.avatar ?? null;
  useEffect(() => {
    setAvatarError(false);
  }, [avatarUrl]);

  if (!user) return null;

  const displayName = user.name || t('settings.userProfile.fallbackName');
  const initial = displayName.charAt(0).toUpperCase();
  const avatarAlt = t('settings.userProfile.avatarAlt', { name: displayName });

  return (
    <div
      className={cn(
        'flex w-full items-center gap-[14px] rounded-xl p-5',
        'bg-[var(--settings-profile-card-bg)]',
        'border border-[var(--settings-profile-card-border)]',
      )}
    >
      {/* Avatar — 52×52 pill */}
      {user.avatar && !avatarError ? (
        <img
          src={user.avatar}
          alt={avatarAlt}
          className="h-[52px] w-[52px] shrink-0 rounded-full object-cover"
          onError={() => setAvatarError(true)}
        />
      ) : (
        <div
          className={cn(
            'flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full',
            'bg-[var(--settings-profile-avatar-bg)]',
            // 无头像的首字母兜底加一圈细描边,与卡片边框同 token,避免圆盘悬空
            'border border-[var(--settings-profile-card-border)]',
            'text-18 font-medium text-[var(--settings-profile-avatar-text)]',
          )}
          aria-label={avatarAlt}
        >
          {initial}
        </div>
      )}

      {/* User name — 18px/500, line-height 1.2 */}
      <p className="min-w-0 flex-1 truncate text-18 font-medium leading-[1.2] text-[var(--settings-profile-name)]">
        {displayName}
      </p>

      {/* 编辑名字 / 头像(本地覆写,弹窗见 ProfileEditDialog) */}
      <button
        type="button"
        onClick={() => setEditOpen(true)}
        aria-label={t('settings.userProfile.edit.open')}
        title={t('settings.userProfile.edit.open')}
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          'text-[var(--text-tertiary)] transition-colors',
          'hover:bg-[var(--settings-profile-avatar-bg)] hover:text-[var(--text-primary)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
        )}
      >
        <Pencil size={15} />
      </button>

      <ProfileEditDialog open={editOpen} onOpenChange={setEditOpen} />
    </div>
  );
}
