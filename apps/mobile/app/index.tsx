import { Redirect } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { CenteredScreen } from '@/components/CenteredScreen';
import HomeScreen from './devices';

export default function IndexScreen() {
  const auth = useAuth();
  if (!auth.initialized) {
    return <CenteredScreen title="Cindy" variant="splash" />;
  }
  if (!auth.isAuthenticated) return <Redirect href="/login" />;
  return <HomeScreen />;
}
