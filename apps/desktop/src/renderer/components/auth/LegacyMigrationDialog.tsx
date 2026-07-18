import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';

type LegacyMigrationPhase = 'confirm' | 'running' | 'done' | 'failed' | null;

/**
 * LegacyMigrationDialog — 首登轻量数据迁移(mToc)的全局确认 / 进度弹窗。
 *
 * main 在首次登录成功、db 打开前检测到老版本 userData 时,经
 * `legacy-migration:state` 推送阶段;本组件挂在 App 顶层(与 Toast 同层),
 * 按阶段渲染:
 *  - confirm:标题 + 说明 + 唯一的「确定」按钮(不可关闭 / 不可取消);
 *  - running:说明切「正在迁移…」,ConfirmDialog 的 loading 态接管
 *    (按钮换 compositor-only Spinner、禁 ESC / 外点关闭);
 *  - failed:失败文案 + 「继续」按钮,点击关闭(main 侧同步清态);
 *  - done:直接关闭,登录流程继续。
 *
 * 挂载时经 get-state 补拉一次,兜住「main 先推送、组件后挂载」的时序。
 * 视觉完全复用 ConfirmDialog 组件体系(token 化配色),不新造样式。
 */
export function LegacyMigrationDialog() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<LegacyMigrationPhase>(null);

  useEffect(() => {
    let mounted = true;
    window.electronAPI.legacyMigration
      .getState()
      .then((state) => {
        if (mounted && state?.phase) setPhase(state.phase);
      })
      .catch(() => {});
    const unsubscribe = window.electronAPI.legacyMigration.onState((payload) => {
      if (payload && typeof payload.phase === 'string') setPhase(payload.phase);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const open = phase === 'confirm' || phase === 'running' || phase === 'failed';
  const failed = phase === 'failed';

  return (
    <ConfirmDialog
      open={open}
      // 状态完全由 main 推送 + 按钮点击驱动;confirm/running 期间不允许任何
      // 途径关闭(ESC / 外点由此忽略,loading 态 ConfirmDialog 自身也拦 ESC)。
      onOpenChange={() => {}}
      title={failed ? t('legacyMigration.failedTitle') : t('legacyMigration.title')}
      description={
        failed
          ? t('legacyMigration.failedDescription')
          : phase === 'running'
            ? t('legacyMigration.migrating')
            : t('legacyMigration.description')
      }
      confirmText={failed ? t('legacyMigration.continue') : t('legacyMigration.confirm')}
      showCancel={false}
      autoFocusConfirm
      loading={phase === 'running'}
      onConfirm={() => {
        if (phase === 'confirm') {
          // 乐观切 loading;main 收到确认后会紧接着推 running(幂等)。
          setPhase('running');
          void window.electronAPI.legacyMigration.confirm();
        } else if (failed) {
          setPhase(null);
          // 同一通道让 main 清掉 failed 态,避免重挂载后 get-state 再弹。
          void window.electronAPI.legacyMigration.confirm();
        }
      }}
    />
  );
}
