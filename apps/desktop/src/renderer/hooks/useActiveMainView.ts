/**
 * useActiveMainView
 * ---------------------------------------------------------------------------
 * 推导主区域当前激活的 View（Chat / Issues / SkillHub），并返回 navigateToView 切换函数。
 *
 * 激活态由 URL 派生：pathname === prefix || pathname.startsWith(prefix + '/')。
 * 当 pathname 不匹配任何 view prefix 时（如 /settings），保留最近一次匹配过的 key —
 * 否则 tabbar 会在打开 Settings 等"非 view 页面"时整体失去选中态。
 *
 * navigateToView 内部做同源去重，避免重复 navigate 触发 FadeSwitcher
 * 不必要的子树重挂载。
 *
 * 见 .sivi/docs/tech_specs/horizontal-tabbar-frontend.md M2。
 */

import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

export type MainViewKey = 'cc-agent' | 'issues' | 'skillhub';

interface ViewDef {
  key: MainViewKey;
  to: string;
  prefix: string;
}

const VIEWS: ViewDef[] = [
  { key: 'cc-agent', to: '/cc-agent', prefix: '/cc-agent' },
  { key: 'issues', to: '/issues', prefix: '/issues' },
  { key: 'skillhub', to: '/skillhub', prefix: '/skillhub' },
];

const DEFAULT_KEY: MainViewKey = 'cc-agent';

export function useActiveMainView() {
  const location = useLocation();
  const navigate = useNavigate();

  const matchedKey: MainViewKey | null =
    VIEWS.find(
      (v) =>
        location.pathname === v.prefix ||
        location.pathname.startsWith(v.prefix + '/'),
    )?.key ?? null;

  // Sticky last-matched key — when path leaves a view (e.g. /settings),
  // keep showing the previously active tab as selected.
  const lastMatchedRef = useRef<MainViewKey>(matchedKey ?? DEFAULT_KEY);
  // Per-view last full pathname — switching back to a tab restores its sub-route
  // (e.g. /cc-agent/<sessionId>, /skillhub/local/...) instead of dropping to the bare prefix.
  const lastPathPerViewRef = useRef<Partial<Record<MainViewKey, string>>>({});
  useEffect(() => {
    if (matchedKey) {
      lastMatchedRef.current = matchedKey;
      lastPathPerViewRef.current[matchedKey] = location.pathname + location.search;
    }
  }, [matchedKey, location.pathname, location.search]);

  const activeKey: MainViewKey = matchedKey ?? lastMatchedRef.current;

  const navigateToView = useCallback(
    (key: MainViewKey) => {
      const view = VIEWS.find((v) => v.key === key);
      if (!view) return;
      if (
        location.pathname === view.to ||
        location.pathname.startsWith(view.prefix + '/')
      ) {
        return; // 同视图不重复 navigate，与旧 FeatureRail 行为一致
      }
      navigate(lastPathPerViewRef.current[key] ?? view.to);
    },
    [location.pathname, navigate],
  );

  return { activeKey, navigateToView };
}
