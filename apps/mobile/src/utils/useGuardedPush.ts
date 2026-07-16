import { useCallback, useEffect, useMemo } from 'react';
import { useFocusEffect, useNavigation, useRouter } from 'expo-router';

import { createRefocusReset, forwardNavigationLock, navigationTargetKey } from './navigationLock';

type Router = ReturnType<typeof useRouter>;
type Href = Parameters<Router['push']>[0];

/**
 * 有防重复守卫的 router.push(锁语义见 navigationLock.ts)。
 * 列表页 / 头部按钮等所有用户可快速连点的前进导航入口统一走这里,
 * 不要在调用点再裸调 router.push。
 *
 * 锁的释放(抑制只应覆盖「导航在途」期间,review P2 反馈):
 *  - 转场动画完成(transitionEnd)即释放——排队的补点 press 在 JS 恢复后、
 *    转场完成前就已 fire 并被挡下;转场完成后目标页上的首次点击是新意图,
 *    不该再被来源页设下的窗口压住。
 *  - 本页从下一层返回、重新获得焦点时释放(首挂载 focus 跳过,原因见
 *    createRefocusReset)——兜住 transitionEnd 不触发的平台(web)。
 */
export function useGuardedPush(): (href: Href) => void {
  const router = useRouter();
  const navigation = useNavigation();
  useEffect(() => {
    // native-stack 的 transitionEnd 不在默认 NavigationProp 事件类型里,宽化注册;
    // 不支持的平台不会触发,行为回退到 refocus 释放 + 时间窗兜底。
    const nav = navigation as unknown as {
      addListener: (type: string, callback: () => void) => () => void;
    };
    return nav.addListener('transitionEnd', () => {
      forwardNavigationLock.reset();
    });
  }, [navigation]);
  const onFocus = useMemo(() => createRefocusReset(forwardNavigationLock), []);
  useFocusEffect(useCallback(() => {
    onFocus();
  }, [onFocus]));
  return useCallback((href: Href) => {
    if (!forwardNavigationLock.shouldAllow(navigationTargetKey(href))) return;
    router.push(href);
  }, [router]);
}
