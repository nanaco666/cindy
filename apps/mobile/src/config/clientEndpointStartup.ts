/**
 * clientEndpointStartup —— 客户端端点清单(`<hotfix CDN base>/endpoint.json`)
 * 的 mobile 启动解析(useStartupEndpointGate 的执行体;依赖注入、可纯函数单测)。
 *
 * 语义是**清单即唯一事实源 + 阻断式**(2026-07 与 Lizi 定案,三次收紧):
 * 冷启动第一步、先于 OTA 检查更新拉取清单;拉不到 / 清单非法 / 任一字段缺失 →
 * 返回失败,闸门渲染错误屏等用户重试。**没有缓存回退、没有超时后静默继续、
 * 没有逐字段烘焙回退**——生效端点全部来自清单,CDN 配置错立刻在启动时暴露。
 * 构建期烘焙值只剩两个位置:拉清单用的 ENDPOINT_MANIFEST_BASE_URL(region 化
 * hotfix 域名,自举必需、防自锁死),以及 __DEV__ 默认路径(闸门跳过,端点
 * 初值来自仓内 config/endpoint.json,见 env.ts;EXPO_PUBLIC_ENDPOINTS_CDN=1
 * 可让 dev 走本函数的完整 CDN 链路)。
 *
 * 共享逻辑(schema / 全字段必填校验)在 @lizi/maker-shared/client-endpoints;
 * 本文件负责 mobile 侧 IO:全局 fetch + AbortController;成功后经
 * env.applyResolvedClientEndpoints 回写 live binding。
 */

import {
  resolveClientEndpointsStrict,
  type ClientEndpointMap,
} from '@lizi/maker-shared/client-endpoints';

import { ENDPOINT_MANIFEST_BASE_URL, applyResolvedClientEndpoints } from './env';

const MANIFEST_RELATIVE_PATH = '/endpoint.json';
/** 单次请求的网络超时——只用于触发错误屏,不是静默降级。 */
const ATTEMPT_TIMEOUT_MS = 10_000;

async function fetchManifestTextViaCdn(timeoutMs: number): Promise<string | null> {
  // 构建缺自举基址属打包配置事故,同样阻断暴露
  if (!ENDPOINT_MANIFEST_BASE_URL) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${ENDPOINT_MANIFEST_BASE_URL}${MANIFEST_RELATIVE_PATH}?t=${Date.now()}`,
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
    const result = resolveClientEndpointsStrict(rawText);
    if (!result.ok) return { ok: false, reason: result.reason };
    (deps.apply ?? applyResolvedClientEndpoints)(result.endpoints);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'internal-error' };
  }
}
