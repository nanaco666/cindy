import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { clearWorkersCache } from '@/features/cc-agent/hooks/useWorkers';
import {
  createAuthService,
  type AuthService,
  type AuthState,
  type AuthFlowState,
  type DesktopLoginAction,
  type DesktopLoginActionResult,
  type MigrationStatus,
  type User,
} from '@/lib/authService';
import { setCurrentUserName } from '@/lib/makerChatStore';
import { sessionsStore } from '@/lib/sessionsStore';

/**
 * chat-data-localization V0.5: AuthContext 暴露 `migration` 字段——最近一次
 * login/refresh 响应里的迁移摘要。MigrationGate / MigrationProgressView 用它
 * 决定路由分发与进度分母。
 *
 * 注意：本项目的 `AuthProvider` 在 `App.tsx` 中位于 `RouterProvider` **之外**，
 * 因此此处不能用 `useNavigate()`——分发逻辑下沉到路由层的 `<MigrationGate />`
 * 包装组件（在 ProtectedRoute 内消费 useAuth().migration）。这是与 spec 的
 * 实现差异，结果等价。
 */
export interface AuthContextValue {
  user: User | null;
  isAuthenticated: boolean;
  isInitializing: boolean;
  /** 最近一次响应的 migration（V0.5 2 态）。null = 还没拿过任何响应。 */
  migration: MigrationStatus | null;
  /** SkillHub 跨设备识别：本机 deviceId（machineIdSync），登录前后都有值；初始化前为 null */
  deviceId: string | null;
  /** Renderer-safe login screen state; auth tickets remain in main. */
  loginState: AuthFlowState | null;
  loadLoginState: () => Promise<DesktopLoginActionResult>;
  dispatchLoginAction: (action: DesktopLoginAction) => Promise<DesktopLoginActionResult>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [migration, setMigration] = useState<MigrationStatus | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [loginState, setLoginState] = useState<AuthFlowState | null>(null);
  const { confirm } = useConfirmDialog();
  const { t } = useTranslation();

  const authServiceRef = useRef<AuthService | null>(null);
  if (authServiceRef.current === null) {
    authServiceRef.current = createAuthService();
  }

  const activeUserIdRef = useRef<string | null>(null);
  const authStateVersionRef = useRef(0);

  /**
   * 身份即 auth-server membership(产品 role 水合已随 /api/me 退役,2026-07)。
   * 这里只负责账号切换时清 renderer 会话快照,防旧账号的在途响应/挂载态泄漏。
   */
  const applyIncomingUser = useCallback((incoming: User) => {
    if (activeUserIdRef.current !== incoming.id) {
      sessionsStore.reset();
    }
    activeUserIdRef.current = incoming.id;
    setUser(incoming);
  }, []);

  useEffect(() => {
    const service = authServiceRef.current!;
    const initializeVersion = authStateVersionRef.current;

    const unsubscribe = service.onAuthStateChange((state: AuthState) => {
      authStateVersionRef.current += 1;
      setIsAuthenticated(state.isAuthenticated);
      setDeviceId(state.deviceId);
      if (state.user) {
        setLoginState(null);
        applyIncomingUser(state.user);
      } else {
        sessionsStore.reset();
        activeUserIdRef.current = null;
        setLoginState(null);
        clearWorkersCache();
        setUser(null);
      }
      // V0.5：refresh 推送的 migration 也要同步进 context；缺失（logout）→ null
      if (state.migration !== undefined) {
        setMigration(state.migration);
      } else if (!state.isAuthenticated) {
        setMigration(null);
      }
    });

    void service
      .initialize()
      .then(async (state) => {
        // A pushed auth event is newer than this initialize response.
        if (authStateVersionRef.current !== initializeVersion) return;
        setIsAuthenticated(state.isAuthenticated);
        setDeviceId(state.deviceId);
        if (state.user) {
          applyIncomingUser(state.user);
        } else {
          activeUserIdRef.current = null;
          setLoginState(null);
          clearWorkersCache();
          setUser(null);
        }
        if (state.migration !== undefined) setMigration(state.migration);
      })
      .finally(() => setIsInitializing(false));

    return () => {
      unsubscribe();
      service.dispose();
    };
  }, [applyIncomingUser]);

  useEffect(() => {
    let handling = false;
    return window.electronAPI.onAuthSessionExpired((payload) => {
      if (handling) return;
      handling = true;
      void confirm({
        title: t('logic.confirm.sessionExpiredTitle'),
        description: payload.message || t('logic.confirm.sessionExpiredDescription'),
        confirmText: t('logic.confirm.sessionExpiredConfirm'),
        showCancel: false,
      }).then(() => {
        activeUserIdRef.current = null;
        sessionsStore.reset();
        clearWorkersCache();
        setUser(null);
        setIsAuthenticated(false);
        setMigration(null);
        setLoginState(null);
        handling = false;
      });
    });
  }, [confirm, t]);

  const loadLoginState = useCallback(async (): Promise<DesktopLoginActionResult> => {
    const result = await authServiceRef.current!.getLoginState();
    setLoginState(result.state);
    return result;
  }, []);

  const dispatchLoginAction = useCallback(
    async (action: DesktopLoginAction): Promise<DesktopLoginActionResult> => {
      // Main keeps the browser request open until its loopback callback arrives,
      // so project the waiting screen immediately to expose the cancel action.
      if (action.type === 'start-browser') {
        setLoginState({ step: 'browser-redirect', label: action.label });
      }
      const result = await authServiceRef.current!.dispatchLoginAction(action);
      setLoginState(result.state);
      return result;
    },
    [],
  );

  const logout = useCallback(async () => {
    await authServiceRef.current!.logout();
    sessionsStore.reset();
    clearWorkersCache();
    setMigration(null);
  }, []);

  // 同步用户名到 makerChatStore 模块级 cache — dispatchToSdk 把它透传给 maker.send
  // 让 turn-start status 文案带 "<userName> Just Wait ..." (登出 / 切账号自动清空)。
  useEffect(() => {
    setCurrentUserName(user?.name);
  }, [user?.name]);

  const value = useMemo(
    () => ({
      user,
      isAuthenticated,
      isInitializing,
      migration,
      deviceId,
      loginState,
      loadLoginState,
      dispatchLoginAction,
      logout,
    }),
    [
      user,
      isAuthenticated,
      isInitializing,
      migration,
      deviceId,
      loginState,
      loadLoginState,
      dispatchLoginAction,
      logout,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
