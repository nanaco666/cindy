/**
 * chat-data-localization F4：迁移协调器的 renderer 侧门面。
 *
 * 仅做命令转 IPC + 进度事件订阅，不持久化任何状态——所有状态在 main 的
 * `migrationCoordinator` + `migration_meta`。
 */

export type MigrationProgress = MigrationProgressPayload;

export const migrationService = {
  start(totals: { totalSessions: number; totalMessages: number }): Promise<void> {
    return window.electronAPI.localDb.migration.start(totals);
  },
  resume(): Promise<void> {
    return window.electronAPI.localDb.migration.resume();
  },
  abort(): Promise<void> {
    return window.electronAPI.localDb.migration.abort();
  },
  setStatus(s: 'done' | 'skipped'): Promise<void> {
    return window.electronAPI.localDb.migration.setStatus(s);
  },
  markDone(deviceName: string): Promise<{ ok: true; alreadyMigrated?: boolean }> {
    return window.electronAPI.localDb.migration.markDone(deviceName);
  },
  /** Subscribe to fan-out progress events. Returns unsubscribe. */
  onProgress(cb: (p: MigrationProgress) => void): () => void {
    return window.electronAPI.localDb.migration.onProgress(cb);
  },
  getStatus(): Promise<'pending' | 'in_progress' | 'done' | 'skipped' | null> {
    return window.electronAPI.localDb.migration.getStatus();
  },
};
