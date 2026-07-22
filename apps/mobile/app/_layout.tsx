import {
  DarkTheme as NavigationDarkTheme,
  DefaultTheme as NavigationLightTheme,
  Stack,
  ThemeProvider as NavigationThemeProvider,
  useRouter,
  useSegments,
} from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, type ReactElement } from 'react';
import { Alert, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '@/auth/AuthContext';
import { DeviceLinkProvider } from '@/device-link/DeviceLinkContext';
import { GestureHandlerRootView } from '@/platform/gestureHandler';
import { ThemeProvider, useTheme } from '@/theme/ThemeProvider';
import { createNavigationTheme } from '@/theme/navigationTheme';
import { StartupBlockedScreen } from '@/components/StartupBlockedScreen';
import { StartupSplashOverlay, useStartupSplash } from '@/components/StartupSplashOverlay';
import { registerDevCacheMenu } from '@/debug/devCacheMenu';
import { startJsStallWatchdog } from '@/debug/jsStallWatchdog';
import { initMobileTapdb } from '@/analytics/mobileTapdb';
import { useBundleUpdatePrompt } from '@/update/useBundleUpdatePrompt';
import { useResumeUpdateCheck } from '@/update/useResumeUpdateCheck';
import { useStartupOtaGate } from '@/update/useStartupOtaGate';
import { useCanaryChannelGate } from '@/update/useCanaryChannelGate';
import { useStartupEndpointGate } from '@/config/useStartupEndpointGate';
import { IS_OTA_SELFHOST } from '@/config/env';
import { Observe, ObserveRoot } from '@/observability/observe';

// EAS Observe:启用 expo-router 集成,采集 per-route 导航指标(cold_ttr / warm_ttr / tti)。
// 必须在挂载前的模块作用域调用;否则 useObserve().markInteractive 会退化为全局兜底、不记 per-route。
Observe.configure({ integrations: { 'expo-router': true } });

function NavigationGate() {
  const auth = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const { mode, colors } = useTheme();
  const { releaseSplash, splashActive } = useStartupSplash();
  const navigationTheme = useMemo(
    () => createNavigationTheme(
      mode === 'dark' ? NavigationDarkTheme : NavigationLightTheme,
      colors,
    ),
    [mode, colors],
  );

  // auth 恢复是启动闸门链的最后一道门:这里统一释放根部常驻 splash。
  // 放在 NavigationGate 而不是具体页面,是为了深链冷启动(首屏不是 index)也能释放。
  useEffect(() => {
    if (auth.initialized) releaseSplash();
  }, [auth.initialized, releaseSplash]);

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

  useEffect(() => {
    if (!auth.isAuthenticated || !auth.accountDeletionRestored) return;
    auth.consumeAccountDeletionRestored();
    Alert.alert('账号已恢复', '本次登录已取消账号注销，账号和数据将继续保留。');
  }, [
    auth.accountDeletionRestored,
    auth.consumeAccountDeletionRestored,
    auth.isAuthenticated,
  ]);

  return (
    <NavigationThemeProvider value={navigationTheme}>
      {/* splash 覆盖层仍在时状态栏保持浅色(红底白字);淡出开始后切回主题样式 */}
      <StatusBar style={splashActive || mode === 'dark' ? 'light' : 'dark'} />
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
    </NavigationThemeProvider>
  );
}

/**
 * 端点闸门之后的应用主体:OTA 检查更新与业务树都在这里——保证「拉端点清单」
 * 严格先于「检查更新」(本组件只在端点闸门 ready 后才挂载)。
 */
function RootAfterUpdateChannel({ isCanary }: { isCanary: boolean }) {
  // 自建变体:启动即生效的 JS 热更门(冷启动 check→fetch→reload,本次启动就跑上最新 JS)。
  // 内部 gate 自建 + 非 dev + updates 可用,其余直接 ready=true 不阻塞。见 useStartupOtaGate。
  const otaReady = useStartupOtaGate(isCanary);
  // 自建变体:启动时检查整包更新(runtimeVersion 变化 → 引导跳 NPKG)。
  // 内部 IS_OTA_SELFHOST gate,EAS 包为 no-op。JS 热更由上面的门 + expo-updates 处理,与此互补。
  useBundleUpdatePrompt({ auto: true, isCanary });
  // 自建变体:后台切回前台时静默补一次检查(OTA 静默 fetch 不 reload、整包仅强更提示)。
  // 内部节流 + IS_OTA_SELFHOST gate,非自建为 no-op。见 useResumeUpdateCheck。
  useResumeUpdateCheck(isCanary);
  // 热更门未就绪(自建变体冷启动正在 check/fetch/reload)时不挂载业务树,避免闪旧 UI;
  // 期间根部常驻 splash 覆盖层在上面顶着,这里返回 null 即可。
  if (!otaReady) {
    return null;
  }
  return (
    <AuthProvider>
      <DeviceLinkProvider>
        <NavigationGate />
      </DeviceLinkProvider>
    </AuthProvider>
  );
}

function RootAfterEndpoints() {
  // 更新检查早于 AuthProvider，必须先恢复上次登录同步到本机的 canary 快照。
  // 未持久化/读取失败一律 stable；读取完成前不允许发任何 /manifest 或 /latest 请求。
  const channel = useCanaryChannelGate(IS_OTA_SELFHOST);
  // 未就绪期间由根部常驻 splash 覆盖层顶着,不再各自渲染 splash 实例(避免交接闪帧)。
  if (!channel.ready) return null;
  return <RootAfterUpdateChannel isCanary={channel.isCanary} />;
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
  let body: ReactElement | null;
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
    // pending 期间由 StartupSplashOverlay 顶着,不渲染业务内容。
    body = null;
  } else {
    body = <RootAfterEndpoints />;
  }
  return (
    <GestureHandlerRootView style={styles.gestureRoot}>
      <SafeAreaProvider>
        <ThemeProvider>
          {/* 启动闸门全程共用这一个 splash 实例;端点错误屏需要交互时才隐藏它 */}
          <StartupSplashOverlay hidden={endpointGate.status === 'error'}>
            {body}
          </StartupSplashOverlay>
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
