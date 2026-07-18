/**
 * chat-data-localization F2/F5：聚合注册所有 localDb IPC handlers + ensure-ready。
 *
 * 在 main 进程 `app.whenReady()` 后调用一次。
 *
 * 退出钩子：本文件**不**再注册——干净退出快照与 `closeDb` 由 main/index.ts 通过
 * lifecycle 统一编排（避免与 feishuBot.dispose 等其它清理 race）。
 */

import { ipcMain } from 'electron';

import { ensureReady } from '../index';
import { registerSessionIpc } from './sessions';
import { registerMessageIpc } from './messages';
import { registerOrcaWorkflowIpc } from './orcaTeams';
import { registerSessionImportIpc } from './session-import';
import { registerSessionShareIpc } from './session-share';
import { registerRecentWorkdirsIpc } from './recentWorkdirs';
import { registerProjectAliasesIpc } from './projectAliases';
import { registerRightSidebarTabsIpc } from './rightSidebarTabs';
import { registerDevSqliteVecIpc } from './dev/sqliteVec';
import { registerSearchIpc } from './search';

import { createLogger } from '../../logger';

const log = createLogger('registerAll');

export interface RegisterLocalDbIpcOpts {
  /** ensureReady 打开/创建目标库前执行；失败时阻断，避免跳过认领后创建空库。 */
  beforeEnsureReady?: (userId: string) => void | Promise<void>;
  /**
   * 可选回调：localDb.ensureReady 成功（含已就绪复用路径）后触发。
   * 用途：启动依赖 localDb 的 host 单例（如 scheduler-host），失败仅记日志，
   * 不影响 ensure-ready 自身返回值。
   *
   * 设计原因：scheduler-host 的 startScheduler 需要 localDb + maker 都 ready，
   * 二者就绪时序不固定（splash check-environment 走在 user login 前/后都可能）；
   * 在两个就绪事件源（registerMakerIpcsAfterSplash + 本回调）各调一次幂等的
   * startScheduler，谁后到谁负责真正启动。
   */
  onReady?: (userId: string) => void | Promise<void>;
}

export function registerLocalDbIpc(opts: RegisterLocalDbIpcOpts = {}): void {
  ipcMain.handle('local-db:ensure-ready', async (_e, userId: unknown) => {
    log.info(
      JSON.stringify({
        event: 'localDb.ipc.ensure-ready.recv',
        userId: typeof userId === 'string' ? userId : `<${typeof userId}>`,
      }),
    );
    if (typeof userId !== 'string' || !userId) {
      log.warn(
        JSON.stringify({
          event: 'localDb.ipc.ensure-ready.reject',
          reason: 'invalid userId',
        }),
      );
      return {
        ready: false,
        error: { code: 'DB_INIT_FAILED', message: 'invalid userId' },
      };
    }
    if (opts.beforeEnsureReady) {
      try {
        await opts.beforeEnsureReady(userId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(JSON.stringify({
          event: 'localDb.ipc.ensure-ready.before.failed',
          userId,
          error: message,
        }));
        return { ready: false, error: { code: 'DB_INIT_FAILED', message } };
      }
    }
    const result = await ensureReady(userId);
    log.info(
      JSON.stringify({
        event: 'localDb.ipc.ensure-ready.done',
        userId,
        ready: result.ready,
        ...(result.ready ? {} : { error: result.error }),
      }),
    );
    if (result.ready && opts.onReady) {
      try {
        await opts.onReady(userId);
      } catch (err) {
        log.warn(
          JSON.stringify({
            event: 'localDb.ipc.ensure-ready.onReady.failed',
            userId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
    return result;
  });

  registerSessionIpc();
  registerMessageIpc();
  registerSessionImportIpc();
  registerSessionShareIpc();
  registerOrcaWorkflowIpc();
  registerRecentWorkdirsIpc();
  registerProjectAliasesIpc();
  registerRightSidebarTabsIpc();
  registerSearchIpc();
  registerDevSqliteVecIpc();
}
