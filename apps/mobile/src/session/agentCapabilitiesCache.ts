/**
 * agentCapabilitiesCache —— 远程 agent 能力表的 (deviceId, agentKind) 内存缓存。
 * ---------------------------------------------------------------------------
 * capabilities 是模型 / 权限 / effort 选择器的唯一数据源,旧行为每次进会话页 /
 * 新建页都重新走一次 device-link 往返,期间面板显示「正在读取远程运行能力」+
 * 空模型列表,返回后选项弹入(可见跳变)。能力表按 (设备, agent) 基本不变,
 * 这里对照 deviceProvidersCache 的先例做内存缓存:命中先画,后台静默刷新覆盖
 * (规则 7:先有内容再刷新)。纯逻辑零 react-native,node 可单测。
 */
import type { MobileAgentCapabilities } from '@/session/agentCapabilities';

const cache = new Map<string, MobileAgentCapabilities>();

export function buildAgentCapabilitiesCacheKey(deviceId: string, agentKind: string): string {
  return `${deviceId} ${agentKind}`;
}

export function getCachedAgentCapabilities(key: string): MobileAgentCapabilities | null {
  return cache.get(key) ?? null;
}

export function setCachedAgentCapabilities(key: string, value: MobileAgentCapabilities): void {
  cache.set(key, value);
}

/** device-link:设备下线 / 切换时按 deviceId 前缀驱逐(与 providers 缓存同时机由调用方触发)。 */
export function evictAgentCapabilitiesForDevice(deviceId: string): void {
  const prefix = `${deviceId} `;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/** 清空缓存(登出账号隔离用;测试亦复用)。 */
export function resetAgentCapabilitiesCache(): void {
  cache.clear();
}
