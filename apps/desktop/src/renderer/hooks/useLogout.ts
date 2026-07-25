import { useCallback } from 'react';

import { useAuth } from '@/contexts/AuthContext';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';

export function useLogout(): { handleLogout: () => Promise<void> } {
  const { logout } = useAuth();
  const { confirm } = useConfirmDialog();

  const handleLogout = useCallback(async () => {
    const confirmed = await confirm({
      title: '退出登录',
      description: '确定要退出当前账号吗？',
      confirmText: '退出',
      cancelText: '取消',
    });
    if (confirmed) {
      await logout();
    }
  }, [logout, confirm]);

  return { handleLogout };
}
