import { useCallback, useState } from 'react';
import { BRAND_NAME } from '@lizi/maker-shared/branding';

import { useAuth } from '@/contexts/AuthContext';
import { ApiError } from '@/lib/httpClient';

interface UseLoginReturn {
  isLoading: boolean;
  error: string | null;
  handleLogin: () => void;
  handleDevLogin: () => void;
}

export function useLogin(): UseLoginReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { login, devLogin } = useAuth();

  const runLogin = useCallback(async (action: () => Promise<void>, fallbackError: string) => {
    if (isLoading) return;
    setIsLoading(true);
    setError(null);

    try {
      await action();
    } catch (err) {
      if (err instanceof ApiError) {
        switch (err.code) {
          case 'USER_CANCELLED':
            setError(null);
            break;
          case 'STATE_MISMATCH':
            setError('安全验证失败，请重试');
            break;
          case 'FEISHU_AUTH_FAILED':
            setError('飞书授权失败，请重试');
            break;
          case 'FEISHU_UNAVAILABLE':
            setError('飞书服务暂不可用，请稍后重试');
            break;
          case 'FEISHU_SCOPE_INCOMPLETE':
            setError(`登录失败。使用 ${BRAND_NAME} 需要飞书的完整内容访问授权，请重新登录并同意所有授权请求。`);
            break;
          case 'NETWORK_ERROR':
            setError('网络连接失败，请检查网络');
            break;
          case 'SERVICE_UNAVAILABLE':
            setError(err.message || fallbackError);
            break;
          default:
            setError(fallbackError);
        }
      } else {
        setError(fallbackError);
      }
    } finally {
      setIsLoading(false);
    }
  }, [isLoading]);

  const handleLogin = useCallback(() => {
    void runLogin(login, '登录失败，请重试');
  }, [login, runLogin]);

  const handleDevLogin = useCallback(() => {
    void runLogin(devLogin, '本地模拟登录失败，请确认本地 server 已启动并开启 XDT_DEV_AUTH_ENABLED=1');
  }, [devLogin, runLogin]);

  return { isLoading, error, handleLogin, handleDevLogin };
}
