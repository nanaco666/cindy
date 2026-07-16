import { ApiError } from '@/lib/httpClient';

export type UserRole = 'user' | 'admin';
import type { Effort } from '@/lib/userPreferences.types';

export interface User {
  id: string;
  name: string;
  avatar: string | null;
  email: string | null;
  defaultModel: string;
  defaultEffort: Effort;
  /**
   * V0.3 新增：用户角色。
   * 来源：AuthContext mount 后调 `meService.getMe()` 合并得到，未拉到时为 undefined。
   * 当前 user / admin 等权，预留扩展位。
   */
  role?: UserRole;
  /**
   * canary-release V0.1 的服务端灰度标记，main 的 authManager 随 login/refresh/me
   * 原样透传过来（IPC user 对象本就带此字段，这里只是补类型声明）。
   * renderer 侧当前无消费方（意识入口灰度已于 2026-07-14 全量放开）；main 侧
   * 仍用它切换更新 manifest 通道（canaryFlagStore / manifestService）。
   */
  isCanary?: boolean;
}

/**
 * chat-data-localization V0.5: 2-state migration snapshot.
 * 删除原 'migrated_elsewhere'——按 (userId, deviceId) 切片隔离后该状态自洽不再需要。
 *
 * - 'none'    → 该切片无可迁移数据 / 已 done 过 / 服务端 count 失败兜底降级。客户端无须区分子情况。
 * - 'pending' → 服务端有未迁移的数据；客户端应跳到 /login/migration 触发拉取。
 */
export type MigrationStatus =
  | { status: 'none' }
  | { status: 'pending'; totalSessions: number; totalMessages: number };

export interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  /** chat-data-localization V0.5: latest migration snapshot from login/refresh response. */
  migration?: MigrationStatus;
  /** SkillHub 跨设备识别：本机 deviceId（machineIdSync 结果），登录前后都有值 */
  deviceId: string;
}

export interface AuthService {
  initialize(): Promise<AuthState>;
  login(): Promise<{ user: User; migration: MigrationStatus }>;
  devLogin(): Promise<{ user: User; migration: MigrationStatus }>;
  logout(): Promise<void>;
  onAuthStateChange(callback: (state: AuthState) => void): () => void;
  dispose(): void;
}

/** 客户端兼容：响应缺失或结构异常 → 一律视为 `{ status: 'none' }`。 */
function normalizeMigration(raw: unknown): MigrationStatus {
  if (!raw || typeof raw !== 'object') return { status: 'none' };
  const m = raw as { status?: unknown; totalSessions?: unknown; totalMessages?: unknown };
  if (m.status === 'pending') {
    const totalSessions =
      typeof m.totalSessions === 'number' && Number.isFinite(m.totalSessions)
        ? Math.max(0, Math.floor(m.totalSessions))
        : 0;
    const totalMessages =
      typeof m.totalMessages === 'number' && Number.isFinite(m.totalMessages)
        ? Math.max(0, Math.floor(m.totalMessages))
        : 0;
    return { status: 'pending', totalSessions, totalMessages };
  }
  return { status: 'none' };
}

/**
 * Thin IPC wrapper — all auth logic (token management, refresh scheduling,
 * OAuth window, PKCE) lives in the main process authManager.
 */
export function createAuthService(): AuthService {
  const listeners = new Set<(state: AuthState) => void>();

  // Subscribe to auth state changes pushed from main process
  const unsubIpc = window.electronAPI.onAuthStateChange((rawState) => {
    const normalized: AuthState = {
      user: rawState.user as User | null,
      isAuthenticated: rawState.isAuthenticated,
      migration: rawState.migration
        ? normalizeMigration(rawState.migration)
        : undefined,
      deviceId: rawState.deviceId,
    };
    listeners.forEach((cb) => cb(normalized));
  });

  return {
    async initialize(): Promise<AuthState> {
      const raw = await window.electronAPI.authInitialize();
      return {
        user: raw.user as User | null,
        isAuthenticated: raw.isAuthenticated,
        migration: raw.migration ? normalizeMigration(raw.migration) : undefined,
        deviceId: raw.deviceId,
      };
    },

    async login(): Promise<{ user: User; migration: MigrationStatus }> {
      const result = await window.electronAPI.authLogin();
      if (!result.success) {
        throw new ApiError(result.code, result.statusCode, result.message);
      }
      return {
        user: result.user as User,
        migration: normalizeMigration(result.migration),
      };
    },

    async devLogin(): Promise<{ user: User; migration: MigrationStatus }> {
      const result = await window.electronAPI.authDevLogin();
      if (!result.success) {
        throw new ApiError(result.code, result.statusCode, result.message);
      }
      return {
        user: result.user as User,
        migration: normalizeMigration(result.migration),
      };
    },

    async logout(): Promise<void> {
      await window.electronAPI.authLogout();
    },

    onAuthStateChange(callback: (state: AuthState) => void): () => void {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },

    dispose(): void {
      unsubIpc();
      listeners.clear();
    },
  };
}
