import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { useAuth } from '@/contexts/AuthContext';
import { patchPreferences } from '@/lib/userPreferencesService';
import {
  FALLBACK_PREFERENCES,
  type UserPreferences,
} from '@/lib/userPreferences.types';

export interface UserPreferencesContextValue {
  preferences: UserPreferences;
  updatePreferences: (patch: Partial<UserPreferences>) => Promise<void>;
  isUpdating: boolean;
  error: Error | null;
}

const UserPreferencesContext = createContext<UserPreferencesContextValue | null>(null);

function derivePreferences(
  userId: string | null,
  defaultModel: string | null | undefined,
  defaultEffort: UserPreferences['defaultEffort'] | null | undefined,
): UserPreferences {
  if (userId === null || defaultModel == null || defaultEffort == null) {
    return FALLBACK_PREFERENCES;
  }
  return {
    defaultModel,
    defaultEffort,
  };
}

export function UserPreferencesProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const userDefaultModel = user?.defaultModel;
  const userDefaultEffort = user?.defaultEffort;

  const [preferences, setPreferences] = useState<UserPreferences>(() =>
    derivePreferences(userId, userDefaultModel, userDefaultEffort),
  );
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // 同步 user 身份变化（登录 / 登出 / refresh 后拿到新 user）到本地 preferences。
  // 依赖 user.id / defaultModel / defaultEffort —— 任一变化都重放。
  useEffect(() => {
    setPreferences(derivePreferences(userId, userDefaultModel, userDefaultEffort));
    // 身份变化时清理上一轮的错误
    setError(null);
  }, [userId, userDefaultModel, userDefaultEffort]);

  const updatePreferences = useCallback(
    async (patch: Partial<UserPreferences>) => {
      setIsUpdating(true);
      setError(null);
      try {
        const next = await patchPreferences(patch);
        // 用服务端返回的完整 preferences 替换本地 state（不做 optimistic update）
        setPreferences(next);
      } catch (err) {
        const normalized = err instanceof Error ? err : new Error(String(err));
        setError(normalized);
        // 失败时保留本地 state 不变，抛给调用方
        throw normalized;
      } finally {
        setIsUpdating(false);
      }
    },
    [],
  );

  const value = useMemo<UserPreferencesContextValue>(
    () => ({ preferences, updatePreferences, isUpdating, error }),
    [preferences, updatePreferences, isUpdating, error],
  );

  return (
    <UserPreferencesContext.Provider value={value}>{children}</UserPreferencesContext.Provider>
  );
}

export function useUserPreferences(): UserPreferencesContextValue {
  const ctx = useContext(UserPreferencesContext);
  if (!ctx) {
    throw new Error('useUserPreferences must be used within UserPreferencesProvider');
  }
  return ctx;
}
