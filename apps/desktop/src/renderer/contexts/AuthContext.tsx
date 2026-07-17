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
import * as meService from '@/lib/meService';
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

  /** 已合并 role 的用户 id 集合（去抖：避免 onAuthStateChange 多次触发重复请求）。 */
  const fetchedRoleForUserRef = useRef<Set<string>>(new Set());
  const roleByUserRef = useRef<Map<string, User['role']>>(new Map());
  const activeUserIdRef = useRef<string | null>(null);
  const activeUserRevisionRef = useRef(0);
  const authStateVersionRef = useRef(0);

  /**
   * V0.3：合并 role 进 user。失败不阻断（视为 user）。
   * 同一 user.id 只拉一次（用 fetchedRoleForUserRef 去抖）。
   */
  const mergeRoleIntoUser = useCallback(async (incoming: User) => {
    const revision = ++activeUserRevisionRef.current;
    if (activeUserIdRef.current !== incoming.id) {
      // Auth transitions can leave an old request in flight. Clear the
      // renderer session snapshot before exposing the new identity so that
      // neither the old response nor the old mounted hook state can leak.
      sessionsStore.reset();
    }
    activeUserIdRef.current = incoming.id;
    // Identity changes should render immediately. Product-role hydration is a
    // non-blocking enhancement and may never overwrite a newer account/logout.
    const cachedRole = incoming.role ?? roleByUserRef.current.get(incoming.id);
    const visibleUser = cachedRole ? { ...incoming, role: cachedRole } : incoming;
    setUser(visibleUser);
    if (cachedRole) {
      return;
    }
    if (fetchedRoleForUserRef.current.has(incoming.id)) {
      return;
    }
    fetchedRoleForUserRef.current.add(incoming.id);
    try {
      const me = await meService.getMe();
      roleByUserRef.current.set(incoming.id, me.role);
      if (activeUserIdRef.current !== incoming.id || activeUserRevisionRef.current !== revision)
        return;
      setUser({ ...incoming, role: me.role });
    } catch {
      // The identity was already rendered above; product role defaults to user.
    }
  }, []);

  useEffect(() => {
    const service = authServiceRef.current!;
    const initializeVersion = authStateVersionRef.current;

    const unsubscribe = service.onAuthStateChange((state: AuthState) => {
      authStateVersionRef.current += 1;
      setIsAuthenticated(state.isAuthenticated);
      setDeviceId(state.deviceId);
      // V0.3：user 设置走 mergeRoleIntoUser，登出时清空 role 缓存
      if (state.user) {
        setLoginState(null);
        void mergeRoleIntoUser(state.user);
      } else {
        sessionsStore.reset();
        activeUserIdRef.current = null;
        setLoginState(null);
        fetchedRoleForUserRef.current.clear();
        roleByUserRef.current.clear();
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
          await mergeRoleIntoUser(state.user);
        } else {
          activeUserIdRef.current = null;
          setLoginState(null);
          roleByUserRef.current.clear();
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
  }, [mergeRoleIntoUser]);

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
        fetchedRoleForUserRef.current.clear();
        roleByUserRef.current.clear();
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
