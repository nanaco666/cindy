// renderer 不枚举具体值 —— 合法值完全由 maker capabilities 在运行时给出。
// renderer 只把 ID 当不透明 string 透传, 显示用 capabilities 里的 displayName。
// (类型别名保留是为了语义可读, 不是约束)
export type Effort = string;
export type PermissionMode = string;

export interface UserPreferences {
  defaultModel: string;
  defaultEffort: Effort;
}

/**
 * 与服务端 `DEFAULT_PREFERENCES`（apps/server/src/services/userPreferences.ts）保持一致。
 *
 * 强制约束：任一端修改默认值时，必须同步另一端，保证 fallback 与服务端 default 完全对齐。
 */
export const FALLBACK_PREFERENCES: UserPreferences = {
  defaultModel: 'claude-sonnet-4-6',
  defaultEffort: 'medium',
};

