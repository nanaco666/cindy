// =============================================================================
// release-pointers.mjs —— Mobile 自建线 canary / stable 可变指针约定
//
// 冷更与 JS OTA 的不可变产物继续共用；只有下面两类可变指针分轨：
//   - <platform>/canary-release.json / release.json
//   - <platform>/<runtimeVersion>/canary-latest.json / latest.json
//
// 客户端选择 canary 时不回退 stable，避免灰度用户被静默降级；只有发版机读取
// “上一条”基线时允许 canary 404 后回退 stable，让首个 canary 能从现网起步。
// =============================================================================

export const MOBILE_RELEASE_CHANNELS = Object.freeze(['stable', 'canary']);

/** @param {unknown} platform */
export function assertMobilePlatform(platform) {
  if (platform !== 'ios' && platform !== 'android') {
    throw new Error(`mobile platform 必须是 ios 或 android,收到: ${String(platform)}`);
  }
  return platform;
}

/** @param {unknown} channel */
export function assertMobileReleaseChannel(channel) {
  if (!MOBILE_RELEASE_CHANNELS.includes(channel)) {
    throw new Error(`mobile release channel 必须是 stable 或 canary,收到: ${String(channel)}`);
  }
  return channel;
}

/** @param {'stable' | 'canary'} channel */
export function releasePointerFile(channel) {
  assertMobileReleaseChannel(channel);
  return channel === 'canary' ? 'canary-release.json' : 'release.json';
}

/** @param {'stable' | 'canary'} channel */
export function otaPointerFile(channel) {
  assertMobileReleaseChannel(channel);
  return channel === 'canary' ? 'canary-latest.json' : 'latest.json';
}

/**
 * @param {{ cdnBase: string; ossPrefix: string; platform: 'ios' | 'android'; channel: 'stable' | 'canary' }} input
 */
export function buildReleasePointerLocation({ cdnBase, ossPrefix, platform, channel }) {
  assertMobilePlatform(platform);
  const file = releasePointerFile(channel);
  const cleanCdn = String(cdnBase).replace(/\/+$/, '');
  const cleanPrefix = String(ossPrefix).replace(/^\/+|\/+$/g, '');
  return {
    file,
    key: `${cleanPrefix}/mobile-ota/${platform}/${file}`,
    url: `${cleanCdn}/mobile-ota/${platform}/${file}`,
  };
}

/**
 * @param {{ cdnBase: string; ossPrefix: string; platform: 'ios' | 'android'; runtimeVersion: string; channel: 'stable' | 'canary' }} input
 */
export function buildOtaPointerLocation({ cdnBase, ossPrefix, platform, runtimeVersion, channel }) {
  assertMobilePlatform(platform);
  const runtime = String(runtimeVersion ?? '').trim();
  if (!runtime) throw new Error('buildOtaPointerLocation requires runtimeVersion');
  const file = otaPointerFile(channel);
  const cleanCdn = String(cdnBase).replace(/\/+$/, '');
  const cleanPrefix = String(ossPrefix).replace(/^\/+|\/+$/g, '');
  const encodedRuntime = encodeURIComponent(runtime);
  return {
    file,
    key: `${cleanPrefix}/mobile-ota/${platform}/${runtime}/${file}`,
    url: `${cleanCdn}/mobile-ota/${platform}/${encodedRuntime}/${file}`,
  };
}

/**
 * Fail-closed 读取一个公开 JSON 指针。只有 404 被解释为“尚不存在”；网络、HTTP、
 * JSON 与 shape 错误都抛出，不能把线上故障误判成首发。
 *
 * @param {string} url
 * @param {(input: string, init?: object) => Promise<any>} [fetchImpl]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function fetchJsonPointer(url, fetchImpl = fetch) {
  const bustedUrl = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
  let response;
  try {
    response = await fetchImpl(bustedUrl, {
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    });
  } catch (error) {
    throw new Error(`读取发布指针网络错误: ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`读取发布指针失败: HTTP ${response.status}: ${url}`);

  let value;
  try {
    value = await response.json();
  } catch (error) {
    throw new Error(`发布指针 JSON 解析失败: ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`发布指针必须是 JSON object: ${url}`);
  }
  return value;
}

/**
 * 发版基线：优先 canary，canary 尚未创建时回退 stable。两个都不存在才是首发。
 * 客户端请求路径不使用本函数，因此不会发生 canary → stable 静默降级。
 *
 * @param {{ canaryUrl: string; stableUrl: string; fetchImpl?: (input: string, init?: object) => Promise<any> }} input
 */
export async function fetchCanaryReleaseBaseline({ canaryUrl, stableUrl, fetchImpl = fetch }) {
  const canary = await fetchJsonPointer(canaryUrl, fetchImpl);
  if (canary) return { record: canary, source: 'canary', url: canaryUrl };
  const stable = await fetchJsonPointer(stableUrl, fetchImpl);
  if (stable) return { record: stable, source: 'stable', url: stableUrl };
  return { record: null, source: 'none', url: null };
}

/**
 * @param {{ record: Record<string, unknown> | null; source: string; url: string | null }} baseline
 */
export function baselineBuildNumber(baseline) {
  if (!baseline.record) return null;
  const value = baseline.record.buildNumber;
  if (
    (typeof value !== 'string' && typeof value !== 'number')
    || (typeof value === 'string' && !value.trim())
    || (typeof value === 'number' && !Number.isFinite(value))
  ) {
    throw new Error(`冷更基线记录存在但缺 buildNumber(${baseline.url});记录可能损坏,已中止`);
  }
  return value;
}

/**
 * Promote 前复用同一条冷更基线校验，避免把损坏的 canary 指针原样广播到 stable。
 * @param {{ record: Record<string, unknown> | null; source: string; url: string | null }} baseline
 */
export function assertReleaseRecordForPromotion(baseline) {
  if (!baseline.record) throw new Error(`canary release 指针不存在: ${baseline.url ?? '(unknown)'}`);
  baselineBuildNumber(baseline);
  baselineRuntimeVersion(baseline);
  const version = baseline.record.version;
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error(`canary release 记录存在但缺 version(${baseline.url});记录可能损坏,已中止`);
  }
  const installUrl = baseline.record.installUrl;
  if (typeof installUrl !== 'string' || !installUrl.trim()) {
    throw new Error(`canary release 记录存在但缺 installUrl(${baseline.url});记录可能损坏,已中止`);
  }
  return baseline.record;
}

/**
 * Promote 前严格校验 Expo OTA manifest，避免把损坏的 canary 指针广播到 stable。
 * 服务端只透传 CDN JSON，故这里必须校验 runtime 与最小协议形状。
 * @param {Record<string, unknown> | null} manifest
 * @param {string} runtimeVersion
 * @param {string} url
 */
export function assertExpoManifestForPromotion(manifest, runtimeVersion, url) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`canary OTA manifest 必须是 JSON object(${url});记录可能损坏,已中止`);
  }
  if (manifest.runtimeVersion !== runtimeVersion) {
    throw new Error(
      `canary OTA manifest runtimeVersion 不匹配(${String(manifest.runtimeVersion)} != ${runtimeVersion},${url});已中止`,
    );
  }
  if (typeof manifest.id !== 'string' || !manifest.id.trim()) {
    throw new Error(`canary OTA manifest 缺 id(${url});记录可能损坏,已中止`);
  }
  const launchAsset = manifest.launchAsset;
  if (!launchAsset || typeof launchAsset !== 'object' || Array.isArray(launchAsset)) {
    throw new Error(`canary OTA manifest 缺 launchAsset(${url});记录可能损坏,已中止`);
  }
  if (typeof launchAsset.url !== 'string' || !launchAsset.url.trim()) {
    throw new Error(`canary OTA manifest launchAsset 缺 url(${url});记录可能损坏,已中止`);
  }
  if (!Array.isArray(manifest.assets)) {
    throw new Error(`canary OTA manifest 缺 assets 数组(${url});记录可能损坏,已中止`);
  }
  return manifest;
}

/**
 * @param {{ record: Record<string, unknown> | null; source: string; url: string | null }} baseline
 */
export function baselineRuntimeVersion(baseline) {
  if (!baseline.record) return null;
  const value = baseline.record.runtimeVersion;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`冷更基线记录存在但缺 runtimeVersion(${baseline.url});记录可能损坏,已中止`);
  }
  return value.trim();
}
