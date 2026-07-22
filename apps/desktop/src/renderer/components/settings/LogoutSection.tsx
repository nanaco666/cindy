import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useLogout } from '@/hooks/useLogout';
import { AccountDeletionSection } from './AccountDeletionSection';

export function LogoutSection() {
  const { handleLogout } = useLogout();
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-2.5">
      <button
        type="button"
        onClick={handleLogout}
        aria-label={t('settings.logout.aria')}
        className={cn(
          'flex h-[42px] w-full items-center justify-center rounded-full',
          'bg-[var(--settings-logout-bg)]',
          'border border-[var(--settings-logout-border)]',
          'text-13 font-medium text-[var(--settings-logout-text)]',
          'hover:bg-[var(--settings-logout-hover-bg)]',
          'transition-colors',
        )}
      >
        {t('settings.logout.button')}
      </button>
      <AccountDeletionSection />
    </div>
  );
}
