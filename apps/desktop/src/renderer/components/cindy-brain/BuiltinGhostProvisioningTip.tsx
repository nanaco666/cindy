import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';

/**
 * 内置意识播种进行中的胶囊提示(视觉同 WindowControls 的 ClosingOverlay
 * capsule,但**非阻塞**:无整窗 dim、pointer-events-none,底部居中悬浮,
 * 不打断任何操作)。
 *
 * 触发:main 的播种对账只在真实发生装/覆盖/回收时广播 active=true(no-op
 * 对账不闪),完成后 false。播种通常极快(拷贝百 KB 级),为避免一闪而过的
 * 视觉噪音,亮起后至少停留 MIN_VISIBLE_MS 再收起(规则 7:杜绝跳变)。
 *
 * spinner 只在 visible 时挂载(动画只在有状态含义时存在,规则 7)。
 */
const MIN_VISIBLE_MS = 1000;

export function BuiltinGhostProvisioningTip() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<number | null>(null);
  const shownAt = useRef(0);

  useEffect(() => {
    const off = window.electronAPI.ghosts.onProvisioning(({ active }) => {
      if (active) {
        if (hideTimer.current !== null) {
          window.clearTimeout(hideTimer.current);
          hideTimer.current = null;
        }
        shownAt.current = Date.now();
        setVisible(true);
      } else {
        const remain = Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt.current));
        hideTimer.current = window.setTimeout(() => {
          setVisible(false);
          hideTimer.current = null;
        }, remain);
      }
    });
    return () => {
      off();
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    };
  }, []);

  if (!visible) return null;
  return createPortal(
    <div
      className="pointer-events-none fixed inset-x-0 bottom-10 z-[9000] flex select-none justify-center"
      aria-live="polite"
    >
      <div
        className="flex items-center gap-2 rounded-full border border-[var(--border-default)] px-4 py-2 shadow-sm"
        style={{ background: 'var(--surface-elevated)' }}
      >
        <Spinner size={16} className="text-[var(--text-primary)]" />
        <span className="text-sm text-[var(--text-primary)]">{t('settings.ghosts.provisioning.updating')}</span>
      </div>
    </div>,
    document.body,
  );
}
