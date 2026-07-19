/**
 * useProviders — 模型供应商列表 hook(设置 → 模型供应商页消费)。
 *
 * 数据来自 main 的 `maker.listProviders()`(读 @lizi/model-providers 注册表,
 * 每次调用都现读各 agent 的连接态)。App 根节点统一监听 catalog / 鉴权广播并联合刷新
 * providers + 两份 capabilities；本 hook 只消费共享快照，并暴露 `refetch` 给页面处理
 * 不改变模型目录的连接动作(例如 api-key 断开)。
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
 * 后台由 App 的联合刷新静默校正(连接态在两次开页之间几乎不变 → 通常无可见变化)。
 * 只缓存"快照"不缓存"是否在拉取中",故不破坏 refetch 的现有刷新语义。
 */
let cachedProviders: ProviderView[] | null = null;
let providersGeneration = 0;
const providerListeners = new Set<(providers: ProviderView[]) => void>();

/** 为一次 provider 快照读取分配代际；更早请求完成后不得再覆盖缓存。 */
export function beginProvidersRefresh(): number {
  providersGeneration += 1;
  return providersGeneration;
}

/** 读取 provider 快照。失败向上抛，由调用方保留上一份有效缓存。 */
export async function loadProvidersSnapshot(): Promise<ProviderView[]> {
  const result = await window.electronAPI.maker.listProviders();
  return result.providers;
}

export function isProvidersRefreshCurrent(generation: number): boolean {
  return providersGeneration === generation;
}

/** 仅提交当前代际的完整快照，并一次通知所有 mounted hooks。 */
export function commitProvidersSnapshot(
  generation: number,
  next: ProviderView[],
): boolean {
  if (!isProvidersRefreshCurrent(generation)) return false;
  cachedProviders = next;
  for (const listener of providerListeners) listener(next);
  return true;
}

export async function refreshProviders(): Promise<boolean> {
  const generation = beginProvidersRefresh();
  try {
    return commitProvidersSnapshot(generation, await loadProvidersSnapshot());
  } catch {
    return false;
  }
}

export function useProviders(): UseProvidersReturn {
  const [providers, setProviders] = useState<ProviderView[]>(() => cachedProviders ?? []);
  // 有缓存即视为已就绪:重开时第一帧就有可用数据,不再走 loading 态。
  const [loading, setLoading] = useState(cachedProviders == null);

  const refetch = useCallback(() => {
    void refreshProviders();
  }, []);

  useEffect(() => {
    const onRefresh = (next: ProviderView[]): void => {
      setProviders(next);
      setLoading(false);
    };
    providerListeners.add(onRefresh);
    return () => {
      providerListeners.delete(onRefresh);
    };
  }, []);

  return { providers, loading, refetch };
}
