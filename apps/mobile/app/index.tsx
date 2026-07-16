import { Redirect } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { CenteredScreen } from '@/components/CenteredScreen';
import HomeScreen from './devices';

export default function IndexScreen() {
  const auth = useAuth();
  if (!auth.initialized) {
    return <CenteredScreen title="XDMaker" subtitle="正在恢复登录状态" />;
  }
  if (!auth.isAuthenticated) return <Redirect href="/login" />;
  return <HomeScreen />;
}
