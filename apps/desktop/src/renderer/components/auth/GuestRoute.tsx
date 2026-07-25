import { Navigate, Outlet } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';

export function GuestRoute() {
  const { isAuthenticated, isInitializing } = useAuth();

  if (isInitializing) return null;
  if (isAuthenticated) return <Navigate to="/" replace />;
  return <Outlet />;
}
