import { useTranslation } from 'react-i18next';
import { BRAND_NAME } from '@lizi/maker-shared/branding';

import splashLogo from '@/assets/splash-logo.png';

export function WelcomePage() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center">
      <img
        src={splashLogo}
        alt={BRAND_NAME}
        className="h-[80px] w-[80px] rounded-[12px] pointer-events-none"
        draggable={false}
      />
      <p className="mt-[20px] text-28 font-semibold text-welcome-text">
        {t('welcome.greeting')}
      </p>
    </div>
  );
}
