/**
 * clientEndpointStartup —— 客户端端点清单(`<hotfix CDN base>/endpoint.json`)
 * 的 mobile 启动解析(useStartupEndpointGate 的执行体;依赖注入、可纯函数单测)。
 *
 * 语义:**CDN 清单是正式包唯一事实源**。拉不到、非法 JSON、schemaVersion
 * 不兼容、任一必填字段缺失或值非法都返回失败，由启动闸门阻断业务树
 * 并显示重试页。不读包内 `endpoint.json`、不做字段合并、不做整份回退，
 * 避免线上配置错误被静默掩盖或不同端点跑在不同版本。
 *
 * 共享逻辑(schema / 校验)在 @lizi/maker-shared/client-endpoints;本文件负责
 * mobile 侧 IO(全局 fetch + AbortController)与启动阻断;成功后经
 * env.applyResolvedClientEndpoints 回写 live binding。
 */

import {
  resolveClientEndpointsStrict,
  type ClientEndpointMap,
} from '@lizi/maker-shared/client-endpoints';

import { ENDPOINT_MANIFEST_BASE_URL, applyResolvedClientEndpoints } from './env';

const MANIFEST_RELATIVE_PATH = '/endpoint.json';
/** 单次请求的网络超时——超时即阻断启动,不是无限等待。 */
const ATTEMPT_TIMEOUT_MS = 10_000;

async function fetchManifestTextViaCdn(timeoutMs: number): Promise<string | null> {
  // 构建缺自举基址属打包配置事故:CDN 级不可用,交给启动闸门阻断。
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
  apply?: (resolved: ClientEndpointMap & { reviewVersion: string | null }) => void;
  timeoutMs?: number;
}

export type StartupEndpointResolveOutcome =
  | {
      ok: true;
      /** 正式包的生效端点只能来自 CDN 清单。 */
      source: 'cdn';
    }
  | { ok: false; reason: string };

/**
 * 单次严格解析:成功 → 回写 env live binding;失败 → 返回 reason,
 * 由闸门渲染错误屏,重试 = 再调一次本函数。本函数自身永不 reject。
 */
export async function runStartupEndpointResolve(
  deps: StartupEndpointResolveDeps = {},
): Promise<StartupEndpointResolveOutcome> {
  try {
    const fetchManifestText = deps.fetchManifestText ?? fetchManifestTextViaCdn;
    const apply = deps.apply ?? applyResolvedClientEndpoints;
    let rawText: string | null = null;
    try {
      rawText = await fetchManifestText(deps.timeoutMs ?? ATTEMPT_TIMEOUT_MS);
    } catch {
      rawText = null;
    }

    const result = resolveClientEndpointsStrict(rawText);
    if (!result.ok) return { ok: false, reason: result.reason };

    apply({ ...result.endpoints, reviewVersion: result.reviewVersion });
    return { ok: true, source: 'cdn' };
  } catch {
    return { ok: false, reason: 'internal-error' };
  }
}
