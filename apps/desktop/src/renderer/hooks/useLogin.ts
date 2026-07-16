import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/contexts/AuthContext';
import type { DesktopLoginAction } from '@/lib/authService';

interface UseLoginReturn {
  isLoading: boolean;
  errorCode: string | null;
  loginState: ReturnType<typeof useAuth>['loginState'];
  dispatch: (action: DesktopLoginAction) => Promise<boolean>;
  clearError: () => void;
}

/** Coordinates presentation state while all credentials and tickets stay in main. */
export function useLogin(): UseLoginReturn {
  const { loginState, loadLoginState, dispatchLoginAction } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const loadingRef = useRef(false);

  useEffect(() => {
    if (loginState || loadingRef.current) return;
    loadingRef.current = true;
    setIsLoading(true);
    void loadLoginState()
      .then((result) => {
        if (!result.success) setErrorCode(result.code);
      })
      .catch(() => setErrorCode('AUTH_SERVICE_UNAVAILABLE'))
      .finally(() => {
        loadingRef.current = false;
        setIsLoading(false);
      });
  }, [loadLoginState, loginState]);

  const dispatch = useCallback(
    async (action: DesktopLoginAction): Promise<boolean> => {
      if (loadingRef.current && action.type !== 'cancel-browser') return false;
      loadingRef.current = true;
      setIsLoading(true);
      setErrorCode(null);
      try {
        const result = await dispatchLoginAction(action);
        if (!result.success) {
          setErrorCode(result.code === 'USER_CANCELLED' ? null : result.code);
          return false;
        }
        return true;
      } catch {
        setErrorCode('AUTH_REQUEST_FAILED');
        return false;
      } finally {
        loadingRef.current = false;
        setIsLoading(false);
      }
    },
    [dispatchLoginAction],
  );

  return {
    isLoading,
    errorCode,
    loginState,
    dispatch,
    clearError: () => setErrorCode(null),
  };
}
