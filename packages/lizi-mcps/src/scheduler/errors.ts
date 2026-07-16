/**
 * scheduler/errors.ts
 *
 * Translate `Scheduler` business errors into structured MCP tool result codes.
 *
 * 与 IPC 层 `apps/desktop/src/main/maker-ipc/schedule.ts:73-78` 的
 * `rewrapSchedulerError` 嗅探规则**保持一致**（cron / timezone / not found 三类
 * message → 三个 IPC 错误码），多了一个 `SCHEDULER_NOT_READY` 用于 reset 期间
 * `getScheduler()` 抛 'scheduler not started' 的场景。
 *
 * Phase 5 hard rule (plan §C.6)：MCP tool result 错误码必须复用 IPC 层 3 种 +
 * 新增 SCHEDULER_NOT_READY，禁止自创新错误码集。Phase 7 cleanup 会把这条逻辑
 * 抽成 IPC + MCP 共享 util；本 Phase 先在 lizi-mcps 内就近实现，签名与 IPC 层对应
 * （IPC 抛带 code 的 Error；MCP 返回 `{code, message}` 由 caller 包成 isError
 * tool result）。
 */
export type SchedulerToolErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_PARAMS'
  | 'INTERNAL'
  | 'SCHEDULER_NOT_READY';

export interface SchedulerToolError {
  code: SchedulerToolErrorCode;
  message: string;
}

/**
 * Map an unknown error thrown by `Scheduler` (or `getScheduler()`) to a
 * structured `{code, message}` payload. Pure — no throw, no logging.
 */
export function classifySchedulerError(err: unknown): SchedulerToolError {
  const message = err instanceof Error ? err.message : String(err);
  if (/scheduler not started/i.test(message)) {
    return { code: 'SCHEDULER_NOT_READY', message };
  }
  if (/not found/i.test(message)) {
    return { code: 'NOT_FOUND', message };
  }
  // 'script execution ...' 是引擎 validateScheduleExecutionShape 对 script 模式
  // 形状校验的固定前缀(engine/scheduler.ts),属参数错误而非内部错误。
  if (/invalid|cron|timezone|script execution/i.test(message)) {
    return { code: 'INVALID_PARAMS', message };
  }
  return { code: 'INTERNAL', message };
}
