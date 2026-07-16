/**
 * scheduler/_enums.ts
 *
 * Shared zod enum tuples (single source of truth for tool input schemas).
 * Mirror the literal-union types in `@lizi/maker-scheduler` types.ts.
 *
 * EFFORT: 与 Phase 3 changelog L1340 / Phase 6 plan §C.7 一致 —
 *   `['minimal','low','medium','high','xhigh','max']`。
 *   runner.ts:82-86 已经做白名单校验，MCP 这一层提前在 zod schema 里拦更友好
 *   （非白名单值直接变 INVALID_ARGS，不会进入 runner）。
 */
export const AGENT_KIND = ['claude-code', 'codex'] as const;
export const EFFORT = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const SCHEDULE_STATUS = ['active', 'paused', 'expired'] as const;
export const EXECUTION_MODE = ['agent', 'script'] as const;
export const SCRIPT_CAPABILITY = ['jira.read', 'jira.comment', 'sessions.dispatch', 'feishu.read'] as const;
