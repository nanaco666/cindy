import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';

export function UserProfileCard() {
  const { user } = useAuth();
  const [avatarError, setAvatarError] = useState(false);
  const { t } = useTranslation();

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
            'text-18 font-medium text-[var(--settings-profile-avatar-text)]',
          )}
          aria-label={avatarAlt}
        >
          {initial}
        </div>
      )}

      {/* User name — 18px/500, line-height 1.2 */}
      <p className="text-18 font-medium leading-[1.2] text-[var(--settings-profile-name)]">
        {displayName}
      </p>
    </div>
  );
}
