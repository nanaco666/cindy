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
  type MigrationStatus,
  type User,
} from '@/lib/authService';
import { setCurrentUserName } from '@/lib/makerChatStore';
import * as meService from '@/lib/meService';

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
  login: () => Promise<void>;
  devLogin: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [migration, setMigration] = useState<MigrationStatus | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const { confirm } = useConfirmDialog();
  const { t } = useTranslation();

  const authServiceRef = useRef<AuthService | null>(null);
  if (authServiceRef.current === null) {
    authServiceRef.current = createAuthService();
  }

  /** 已合并 role 的用户 id 集合（去抖：避免 onAuthStateChange 多次触发重复请求）。 */
  const fetchedRoleForUserRef = useRef<Set<string>>(new Set());

  /**
   * V0.3：合并 role 进 user。失败不阻断（视为 user）。
   * 同一 user.id 只拉一次（用 fetchedRoleForUserRef 去抖）。
   */
  const mergeRoleIntoUser = useCallback(async (incoming: User) => {
    if (incoming.role) {
      setUser(incoming);
      return;
    }
    if (fetchedRoleForUserRef.current.has(incoming.id)) {
      // 已经尝试过：直接落 user（即便失败也不再重试）
      setUser(incoming);
      return;
    }
    fetchedRoleForUserRef.current.add(incoming.id);
    try {
      const me = await meService.getMe();
      setUser({ ...incoming, role: me.role });
    } catch {
      setUser(incoming);
    }
  }, []);

  useEffect(() => {
    const service = authServiceRef.current!;

    const unsubscribe = service.onAuthStateChange((state: AuthState) => {
      setIsAuthenticated(state.isAuthenticated);
      setDeviceId(state.deviceId);
      // V0.3：user 设置走 mergeRoleIntoUser，登出时清空 role 缓存
      if (state.user) {
        void mergeRoleIntoUser(state.user);
      } else {
        fetchedRoleForUserRef.current.clear();
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

    service.initialize().then(async (state) => {
      setIsAuthenticated(state.isAuthenticated);
      setDeviceId(state.deviceId);
      // V0.3：user 设置走 mergeRoleIntoUser
      if (state.user) {
        await mergeRoleIntoUser(state.user);
      } else {
        clearWorkersCache();
        setUser(null);
      }
      // V0.5：拉一份 migration 进 context
      if (state.migration !== undefined) setMigration(state.migration);
      setIsInitializing(false);
    });

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
        fetchedRoleForUserRef.current.clear();
        clearWorkersCache();
        setUser(null);
        setIsAuthenticated(false);
        setMigration(null);
        handling = false;
      });
    });
  }, [confirm, t]);

  const login = useCallback(async () => {
    const result = await authServiceRef.current!.login();
    setUser(result.user);
    setIsAuthenticated(true);
    setMigration(result.migration);
  }, []);

  const devLogin = useCallback(async () => {
    const result = await authServiceRef.current!.devLogin();
    setUser(result.user);
    setIsAuthenticated(true);
    setMigration(result.migration);
  }, []);

  const logout = useCallback(async () => {
    await authServiceRef.current!.logout();
    clearWorkersCache();
    setMigration(null);
  }, []);

  // 同步用户名到 makerChatStore 模块级 cache — dispatchToSdk 把它透传给 maker.send
  // 让 turn-start status 文案带 "<userName> Just Wait ..." (登出 / 切账号自动清空)。
  useEffect(() => {
    setCurrentUserName(user?.name);
  }, [user?.name]);

  const value = useMemo(
    () => ({ user, isAuthenticated, isInitializing, migration, deviceId, login, devLogin, logout }),
    [user, isAuthenticated, isInitializing, migration, deviceId, login, devLogin, logout],
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
