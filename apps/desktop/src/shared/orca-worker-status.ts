/**
 * main / renderer 共用的 worker 状态枚举与"占用槽位"判定。
 *
 * 单一事实源: 加新状态(如未来的 paused)只改这里; main 的 orcaTeamStore
 * 与 renderer 的 useWorkers 都从此 import, 不再各自手写 `idle || running`,
 * 避免 F6 那种"前后端计数算法漂移导致 UI 卡死/虚高"。
 *
 * 必须保持 renderer-safe: 不允许 import 任何 electron / drizzle / better-sqlite3,
 * 否则 renderer bundle 会把它们拖进来。
 */

export type OrcaWorkerStatus = 'idle' | 'running' | 'done' | 'error';

/** 占用 worker 槽位、计入软/硬上限的状态集合(idle 也占内存但不算"活跃")。 */
export const ACTIVE_WORKER_STATUSES = ['idle', 'running'] as const satisfies readonly OrcaWorkerStatus[];

/** UI 展示层的"运行中"计数——只有正在干活的 worker 才算。 */
export function isRunningWorkerStatus(status: OrcaWorkerStatus): boolean {
  return status === 'running';
}

/** 是否占槽位(计入软/硬上限)。idle + running 都占。 */
export function isActiveWorkerStatus(status: OrcaWorkerStatus): boolean {
  return (ACTIVE_WORKER_STATUSES as readonly OrcaWorkerStatus[]).includes(status);
}
