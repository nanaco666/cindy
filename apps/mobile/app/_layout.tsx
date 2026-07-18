import { Observe, ObserveRoot } from 'expo-observe';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, type ReactElement } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '@/auth/AuthContext';
import { DeviceLinkProvider } from '@/device-link/DeviceLinkContext';
import { ThemeProvider, useTheme } from '@/theme/ThemeProvider';
import { CenteredScreen } from '@/components/CenteredScreen';
import { StartupBlockedScreen } from '@/components/StartupBlockedScreen';
import { registerDevCacheMenu } from '@/debug/devCacheMenu';
import { startJsStallWatchdog } from '@/debug/jsStallWatchdog';
import { initMobileTapdb } from '@/analytics/mobileTapdb';
import { useBundleUpdatePrompt } from '@/update/useBundleUpdatePrompt';
import { useResumeUpdateCheck } from '@/update/useResumeUpdateCheck';
import { useStartupOtaGate } from '@/update/useStartupOtaGate';
import { useStartupEndpointGate } from '@/config/useStartupEndpointGate';

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

/**
 * 端点闸门之后的应用主体:OTA 检查更新与业务树都在这里——保证「拉端点清单」
 * 严格先于「检查更新」(本组件只在端点闸门 ready 后才挂载)。
 */
function RootAfterEndpoints() {
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
  if (!otaReady) {
    return <CenteredScreen title="Cindy" subtitle="正在检查更新" />;
  }
  return (
    <AuthProvider>
      <DeviceLinkProvider>
        <NavigationGate />
      </DeviceLinkProvider>
    </AuthProvider>
  );
}

function RootLayout() {
  // Dev-only:注册开发者菜单的"清缓存 + reload"项(内部 __DEV__ gate,生产为 no-op)。
  useEffect(() => {
    registerDevCacheMenu();
  }, []);
  // Dev-only:JS 停摆探测器,把 JS 线程忙死的时间边界钉进 Metro 日志流(内部 __DEV__ gate)。
  useEffect(() => startJsStallWatchdog(), []);
  useEffect(() => {
    void initMobileTapdb();
  }, []);
  // 远程端点清单闸门(阻断式):冷启动第一步、先于 OTA 检查更新拉取 OSS 清单,
  // 回写 env live binding。拉不到 / 清单非法 → 错误屏等用户重试,无缓存与超时兜底;
  // __DEV__ 直接放行。ready 前 RootAfterEndpoints(含 OTA 门与业务树)不挂载。
  const endpointGate = useStartupEndpointGate();
  // 所有 hook 已在上方调用,下面条件返回不违反 hooks 规则。
  // GestureHandlerRootView 必须在根部常驻(RNGH 官方要求;缺失时 Android 手势整体不响应)。
  // 各分支都包同一层,避免闸门状态切换时 root 重挂。
  let body: ReactElement;
  if (endpointGate.status === 'error') {
    body = (
      <StartupBlockedScreen
        title="无法获取服务器配置"
        subtitle={`请检查网络连接后重试(${endpointGate.reason ?? 'unknown'})`}
        retryLabel="重试"
        onRetry={endpointGate.retry}
      />
    );
  } else if (endpointGate.status === 'pending') {
    body = <CenteredScreen title="Cindy" subtitle="正在启动" />;
  } else {
    body = <RootAfterEndpoints />;
  }
  return (
    <GestureHandlerRootView style={styles.gestureRoot}>
      <SafeAreaProvider>
        <ThemeProvider>{body}</ThemeProvider>
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
