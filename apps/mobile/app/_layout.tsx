import { Observe, ObserveRoot } from 'expo-observe';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '@/auth/AuthContext';
import { DeviceLinkProvider } from '@/device-link/DeviceLinkContext';
import { ThemeProvider, useTheme } from '@/theme/ThemeProvider';
import { CenteredScreen } from '@/components/CenteredScreen';
import { registerDevCacheMenu } from '@/debug/devCacheMenu';
import { initMobileTapdb } from '@/analytics/mobileTapdb';
import { useBundleUpdatePrompt } from '@/update/useBundleUpdatePrompt';
import { useResumeUpdateCheck } from '@/update/useResumeUpdateCheck';
import { useStartupOtaGate } from '@/update/useStartupOtaGate';

// EAS Observe:启用 expo-router 集成,采集 per-route 导航指标(cold_ttr / warm_ttr / tti)。
// 必须在挂载前的模块作用域调用;否则 useObserve().markInteractive 会退化为全局兜底、不记 per-route。
Observe.configure({ integrations: { 'expo-router': true } });

function NavigationGate() {
  const auth = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const { mode, colors } = useTheme();

  useEffect(() => {
    if (!auth.initialized) return;
    const inAuthGroup = segments[0] === '(auth)';
    if (!auth.isAuthenticated && !inAuthGroup) {
      router.replace('/login');
      return;
    }
    if (auth.isAuthenticated && inAuthGroup) {
      router.replace('/');
    }
  }, [auth.initialized, auth.isAuthenticated, router, segments]);

  return (
    <>
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.surface },
          // iOS 26 起 react-native-screens 的返回手势默认全屏识别(fullScreenSwipe 默认 true),
          // 判定范围过大:会与消息内表格/代码块的横向 ScrollView 抢手势,拖动内容时还会误触返回。
          // 限定手势起始点在屏幕前缘 44pt 内(end = 距前缘最大 x),恢复经典边缘返回的判定范围;
          // iOS < 26 默认就是边缘返回,本配置不改变其行为;Android 返回手势不走这条路径,不受影响。
          gestureResponseDistance: { end: 44 },
        }}
      />
    </>
  );
}

function RootLayout() {
  // Dev-only:注册开发者菜单的"清缓存 + reload"项(内部 __DEV__ gate,生产为 no-op)。
  useEffect(() => {
    registerDevCacheMenu();
  }, []);
  useEffect(() => {
    void initMobileTapdb();
  }, []);
  // 自建变体:启动即生效的 JS 热更门(冷启动 check→fetch→reload,本次启动就跑上最新 JS)。
  // 内部 gate 自建 + 非 dev + updates 可用,其余直接 ready=true 不阻塞。见 useStartupOtaGate。
  const otaReady = useStartupOtaGate();
  // 自建变体:启动时检查整包更新(runtimeVersion 变化 → 引导跳 NPKG)。
  // 内部 IS_OTA_SELFHOST gate,EAS 包为 no-op。JS 热更由上面的门 + expo-updates 处理,与此互补。
  useBundleUpdatePrompt({ auto: true });
  // 自建变体:后台切回前台时静默补一次检查(OTA 静默 fetch 不 reload、整包仅强更提示)。
  // 内部节流 + IS_OTA_SELFHOST gate,非自建为 no-op。见 useResumeUpdateCheck。
  useResumeUpdateCheck();
  // 热更门未就绪(自建变体冷启动正在 check/fetch/reload)时先渲染 loading,避免闪旧 UI。
  // 所有 hook 已在上方调用,此处条件返回不违反 hooks 规则。
  // GestureHandlerRootView 必须在根部常驻(RNGH 官方要求;缺失时 Android 手势整体不响应)。
  // 两个 return 分支都包同一层,避免热更 loading 分支切换时 root 重挂。
  if (!otaReady) {
    return (
      <GestureHandlerRootView style={styles.gestureRoot}>
        <SafeAreaProvider>
          <ThemeProvider>
            <CenteredScreen title="XDMaker" subtitle="正在检查更新" />
          </ThemeProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }
  return (
    <GestureHandlerRootView style={styles.gestureRoot}>
      <SafeAreaProvider>
        <ThemeProvider>
          <AuthProvider>
            <DeviceLinkProvider>
              <NavigationGate />
            </DeviceLinkProvider>
          </AuthProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  gestureRoot: {
    flex: 1,
  },
});

// EAS Observe:包裹根布局以采集启动 / 首屏 / OTA 等性能与采用数据。
// 入口屏(首页 / 会话 / 登录)各自用 useObserve().markInteractive 标记可交互时刻。
export default ObserveRoot.wrap(RootLayout);
