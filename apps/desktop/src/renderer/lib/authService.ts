import type { AuthFlowState } from '@cindy/auth-client';
import type { DesktopLoginAction, DesktopLoginActionResult } from '../../shared/authIpc';
import type { Effort } from '@/lib/userPreferences.types';

/** Renderer-safe projection of the authenticated auth-server membership. */
// 产品增强字段(role/isCanary)已随 /api/user/me、/api/me 退役(2026-07):
// 身份即 auth-server membership,renderer 不再有二段式 role 水合。
export interface User {
  id: string;
  name: string;
  avatar: string | null;
  email: string | null;
  defaultModel: string;
  defaultEffort: Effort;
  membershipKind: 'personal' | 'org';
  membershipRole: 'owner' | 'admin' | 'member';
  orgId: string | null;
  orgName: string | null;
  passportId: string;
}

export interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  deviceId: string;
}

export interface AuthService {
  initialize(): Promise<AuthState>;
  getLoginState(): Promise<DesktopLoginActionResult>;
  dispatchLoginAction(action: DesktopLoginAction): Promise<DesktopLoginActionResult>;
  logout(): Promise<void>;
  onAuthStateChange(callback: (state: AuthState) => void): () => void;
  dispose(): void;
}

/** Thin IPC wrapper. Tokens and transient login tickets never enter the renderer. */
export function createAuthService(): AuthService {
  const listeners = new Set<(state: AuthState) => void>();
  const unsubscribeIpc = window.electronAPI.onAuthStateChange((rawState) => {
    const normalized: AuthState = {
      user: rawState.user as User | null,
      isAuthenticated: rawState.isAuthenticated,
      deviceId: rawState.deviceId,
    };
    listeners.forEach((listener) => listener(normalized));
  });

  return {
    async initialize(): Promise<AuthState> {
      const raw = await window.electronAPI.authInitialize();
      return {
        user: raw.user as User | null,
        isAuthenticated: raw.isAuthenticated,
        deviceId: raw.deviceId,
      };
    },

    getLoginState(): Promise<DesktopLoginActionResult> {
      return window.electronAPI.authGetLoginState();
    },

    dispatchLoginAction(action: DesktopLoginAction): Promise<DesktopLoginActionResult> {
      return window.electronAPI.authDispatchLoginAction(action);
    },

    async logout(): Promise<void> {
      await window.electronAPI.authLogout();
    },

    onAuthStateChange(callback: (state: AuthState) => void): () => void {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },

    dispose(): void {
      unsubscribeIpc();
      listeners.clear();
    },
  };
}

export type { AuthFlowState, DesktopLoginAction, DesktopLoginActionResult };
