/**
 * useProviders — 模型供应商列表 hook(设置 → 模型供应商页消费)。
 *
 * 数据来自 main 的 `maker.listProviders()`(读 @lizi/model-providers 注册表,
 * 每次调用都现读各 agent 的连接态)。本 hook 不持久化连接逻辑,只负责拉取 +
 * 在鉴权态变更时重新拉取:
 *   - 订阅 `maker.auth.onStateChanged`(claude-code / codex OAuth 登录登出),
 *   - 暴露 `refetch` 给页面在任何连接动作后(含 api-key 变更)手动刷新。
 *
 * 遵守「先取数据、拿到后再刷新显示」时序:数据来自本地 IPC,极快返回,因此
 * 不做 loading 态界面;`loading` 仅用于首帧避免渲染空列表(初值空数组 + loading
 * true,IPC 返回后一次性填充)。
 */

import { useCallback, useEffect, useState } from 'react';

import type { ProviderView } from '@lizi/model-providers';

export interface UseProvidersReturn {
  providers: ProviderView[];
  loading: boolean;
  refetch: () => void;
}

/**
 * 跨 mount 的供应商快照缓存。
 *
 * 消费方(设置 → 模型供应商页、ModelSelector、CreateWorkerPopover 等)大多是
 * conditional render —— 切走即卸载、重开即重新 mount。没有缓存时每次 mount 都从
 * `providers: []` 起步,第一帧把所有来源按"未连接"画出来,IPC 返回后 connected 才
 * 翻 true:XD 行会因此多撑出一行 masked-key chip,cell 高度跳变一帧(供应商页最明显)。
 *
 * 这里把最近一次拉到的快照存到模块级:重开时第一帧直接用上次连接态渲染(高度即终态),
 * 后台仍重新拉取并静默校正(连接态在两次开页之间几乎不变 → 通常无可见变化)。
 * 只缓存"快照"不缓存"是否在拉取中",故不破坏 refetch / 鉴权态订阅的现有刷新语义。
 */
let cachedProviders: ProviderView[] | null = null;

/**
 * 启动时预热供应商快照(在 App 的 MakerBootstrap 里与 preloadAllCapabilities 并列调用)。
 *
 * 模型下拉的"双栏 / 单栏"完全由 connectedProvidersForAgent(providers,...).length>=2 决定:
 * 打开瞬间 providers 还没到位 → 先按单栏(320px)画出来,IPC 回来后 >=2 → rail 出现、宽度
 * 撑到 500px → 单→双跳变一帧。组件侧已用上面的模块缓存 seed,但首次启动后的第一次打开
 * 缓存仍是空的(冷启动窗口)。这里在启动早期就把快照灌进缓存,保证第一次打开即终态布局,
 * 永不翻栏。best-effort:失败也不影响——组件自身的 fetch 会兜底补上(遵循规则 7)。
 */
export async function preloadProviders(): Promise<void> {
  try {
    const result = await window.electronAPI.maker.listProviders();
    cachedProviders = result.providers;
  } catch {
    // 忽略:首屏 IPC 偶发失败时,组件 mount 的 fetch 会再取一次。
  }
}

export function useProviders(): UseProvidersReturn {
  const [providers, setProviders] = useState<ProviderView[]>(() => cachedProviders ?? []);
  // 有缓存即视为已就绪:重开时第一帧就有可用数据,不再走 loading 态。
  const [loading, setLoading] = useState(cachedProviders == null);

  const fetchProviders = useCallback(async () => {
    try {
      const result = await window.electronAPI.maker.listProviders();
      return result.providers;
    } catch {
      return [] as ProviderView[];
    }
  }, []);

  // 拉到新快照后同时回填模块缓存 + 本地 state,保证下次 mount 第一帧就是最新连接态。
  const apply = useCallback((next: ProviderView[]) => {
    cachedProviders = next;
    setProviders(next);
  }, []);

  const refetch = useCallback(() => {
    void fetchProviders().then(apply);
  }, [fetchProviders, apply]);

  useEffect(() => {
    let cancelled = false;
    void fetchProviders().then((next) => {
      if (cancelled) return;
      apply(next);
      setLoading(false);
    });
    const refresh = () => {
      void fetchProviders().then((next) => {
        if (!cancelled) apply(next);
      });
    };
    // 鉴权态变更(任一 agent OAuth 登录/登出)→ 重新拉取连接态。
    // listProviders 每次现读连接态,重拉即可同步;不区分 agentKind(三行都可能受影响)。
    const offAuth = window.electronAPI.maker.auth.onStateChanged(refresh);
    // 自定义供应商增删改广播 → 重拉(设置页列表 + 对话模型选择器各 useProviders 实例 live 刷新)。
    const offProviders = window.electronAPI.maker.onProvidersChanged(refresh);
    return () => {
      cancelled = true;
      offAuth?.();
      offProviders?.();
    };
  }, [fetchProviders, apply]);

  return { providers, loading, refetch };
}
