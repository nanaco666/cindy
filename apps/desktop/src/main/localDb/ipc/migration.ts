/**
 * chat-data-localization F4：Migration IPC handlers + 进度事件 fan-out（C8）。
 */

import { ipcMain, BrowserWindow } from 'electron';

import { isIpcError, type IpcErrorCode } from '../../../shared/ipc-errors.js';
import { createLogger } from '../../logger';
import { throwIpcError } from '../../utils/ipcValidate';

const log = createLogger('migration');

import {
  migrationCoordinator,
  readMeta,
  writeMeta,
  type ProgressPhase,
} from '../migrationCoordinator';

type LocalStatus = 'pending' | 'in_progress' | 'done' | 'skipped' | null;

export function registerMigrationIpc(): void {
  ipcMain.handle('local-db:migration:getStatus', async (): Promise<LocalStatus> => {
    const v = await readMeta('cloud_migration_status');
    const normalized =
      v === 'pending' || v === 'in_progress' || v === 'done' || v === 'skipped' ? v : null;
    log.info(
      JSON.stringify({
        event: 'localDb.migration.getStatus',
        raw: v ?? null,
        normalized,
      }),
    );
    return normalized;
  });

  ipcMain.handle(
    'local-db:migration:setStatus',
    async (_e, s: unknown): Promise<void> => {
      log.info(
        JSON.stringify({ event: 'localDb.migration.setStatus', status: s }),
      );
      if (s !== 'done' && s !== 'skipped') {
        throwIpcError('INVALID_PARAMS', 'status 仅支持 done / skipped');
      }
      await writeMeta('cloud_migration_status', s);
    },
  );

  ipcMain.handle(
    'local-db:migration:start',
    async (_e, totals: unknown): Promise<void> => {
      const t = (totals ?? {}) as { totalSessions?: number; totalMessages?: number };
      await writeMeta('cloud_migration_status', 'in_progress');
      await writeMeta(
        'cloud_migration_total_sessions',
        String(toInt(t.totalSessions, 0)),
      );
      await writeMeta(
        'cloud_migration_total_messages',
        String(toInt(t.totalMessages, 0)),
      );
      // 重置 cursor 与 synced（新一次完整迁移）
      await writeMeta('cloud_migration_last_session_id', '');
      await writeMeta('cloud_migration_synced', '0');
      await writeMeta('cloud_migration_has_more', '1');
      // 不 await：立即返回让 renderer 订阅 progress 事件
      void migrationCoordinator.start();
    },
  );

  ipcMain.handle('local-db:migration:resume', async (): Promise<void> => {
    void migrationCoordinator.resume();
  });

  ipcMain.handle('local-db:migration:abort', async (): Promise<void> => {
    migrationCoordinator.abort();
  });

  ipcMain.handle(
    'local-db:migration:markDone',
    async (_e, deviceName: unknown): Promise<{ ok: true; alreadyMigrated?: boolean }> => {
      const name =
        typeof deviceName === 'string' && deviceName ? deviceName : 'unknown-device';
      try {
        return await migrationCoordinator.markDone(name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code: IpcErrorCode = isIpcError(err) ? err.code : 'MARK_DONE_FAILED';
        throwIpcError(code, msg);
      }
    },
  );
}

/**
 * 进度事件向所有渲染窗 fan-out。
 * `migrationCoordinator` 在每页完成后调用。
 */
export function emitMigrationProgress(p: ProgressPhase): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.webContents.send('local-db:migration:progress', p);
    } catch {
      /* renderer 已销毁等 */
    }
  }
}

function toInt(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? Math.max(Math.floor(n), 0) : fallback;
}

