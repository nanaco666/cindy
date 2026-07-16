/**
 * clientEndpointStartup —— 客户端远程端点清单(OSS `config/client-endpoints.json`)
 * 的 mobile 启动解析(useStartupEndpointGate 的执行体;依赖注入、可纯函数单测)。
 *
 * 语义是**强一致阻断式**(2026-07 与 Lizi 定案):冷启动第一步、先于 OTA 检查
 * 更新拉取清单;拉不到 / 清单非法 → 返回失败,闸门渲染错误屏等用户重试,
 * **没有缓存回退、没有超时后静默继续**。烘焙值只用于清单缺省字段的逐项回退
 * (__DEV__ 下闸门整体跳过,不走本函数)。
 *
 * 共享逻辑(schema / 校验 / 严格合并)在 @lizi/maker-shared/client-endpoints;
 * 本文件负责 mobile 侧 IO:全局 fetch + AbortController,基址是烘焙 CDN_BASE_URL
 * (不吃清单自己的 cdnBaseUrl,防自锁死);成功后经 env.applyResolvedClientEndpoints
 * 回写 live binding。
 */

import {
  resolveClientEndpointsStrict,
  type ClientEndpointMap,
} from '@lizi/maker-shared/client-endpoints';

import {
  API_BASE_URL,
  AUTH_API_BASE_URL,
  CDN_BASE_URL,
  DEVICE_LINK_API_BASE_URL,
  MOBILE_VOICE_LITELLM_BASE_URL,
  applyResolvedClientEndpoints,
} from './env';

const MANIFEST_RELATIVE_PATH = '/config/client-endpoints.json';
/** 单次请求的网络超时——只用于触发错误屏,不是静默降级。 */
const ATTEMPT_TIMEOUT_MS = 10_000;

/** 构建期烘焙的端点全集(mobile 未消费的字段填空串,仅作缺省字段回退占位)。 */
export function bakedMobileClientEndpoints(): ClientEndpointMap {
  return {
    apiBaseUrl: API_BASE_URL,
    // 构建期已按 region 解析出单一 auth 地址;清单同样是 region 化下发的单一字段。
    authApiBaseUrl: AUTH_API_BASE_URL,
    deviceLinkApiBaseUrl: DEVICE_LINK_API_BASE_URL,
    oauthBrokerApiBaseUrl: '',
    heartbeatUrl: '',
    slackHookWsUrl: '',
    websiteUrl: '',
    xdGatewayBaseUrl: MOBILE_VOICE_LITELLM_BASE_URL,
    cdnBaseUrl: CDN_BASE_URL,
    cdnInternalBaseUrl: '',
  };
}

async function fetchManifestTextViaCdn(timeoutMs: number): Promise<string | null> {
  if (!CDN_BASE_URL) return null; // 构建缺 CDN base 属打包配置事故,同样阻断暴露
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${CDN_BASE_URL}${MANIFEST_RELATIVE_PATH}?t=${Date.now()}`,
      { signal: controller.signal },
    );
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 测试注入点;生产走默认实现。 */
export interface StartupEndpointResolveDeps {
  fetchManifestText?: (timeoutMs: number) => Promise<string | null>;
  bakedDefaults?: ClientEndpointMap;
  apply?: (resolved: ClientEndpointMap) => void;
  timeoutMs?: number;
}

export type StartupEndpointResolveOutcome =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * 单次解析尝试:成功 → 回写 env live binding 返回 ok;失败 → 返回 reason,
 * 由闸门渲染错误屏,重试 = 再调一次本函数。本函数自身永不 reject。
 */
export async function runStartupEndpointResolve(
  deps: StartupEndpointResolveDeps = {},
): Promise<StartupEndpointResolveOutcome> {
  try {
    const fetchManifestText = deps.fetchManifestText ?? fetchManifestTextViaCdn;
    let rawText: string | null = null;
    try {
      rawText = await fetchManifestText(deps.timeoutMs ?? ATTEMPT_TIMEOUT_MS);
    } catch {
      rawText = null;
    }
    const result = resolveClientEndpointsStrict(
      rawText,
      deps.bakedDefaults ?? bakedMobileClientEndpoints(),
    );
    if (!result.ok) return { ok: false, reason: result.reason };
    (deps.apply ?? applyResolvedClientEndpoints)(result.endpoints);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'internal-error' };
  }
}
