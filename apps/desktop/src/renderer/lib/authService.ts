import type { AuthFlowState } from '@cindy/auth-client';
import type { DesktopLoginAction, DesktopLoginActionResult } from '../../shared/authIpc';
import type { Effort } from '@/lib/userPreferences.types';

/** Renderer-safe projection of the authenticated auth-server membership. */
// role 已随 /api/user/me、/api/me 退役；isCanary 改由 main 进程从专用
// feature-flags 端点读取。两者都不再进入 renderer User。
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
