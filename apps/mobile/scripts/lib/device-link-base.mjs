/**
 * device-link-base.mjs — 冒烟 / mock 脚本共享的 device-link API base 推导
 * (原先 6 个脚本各持一份逐字节相同的副本,2026-07 端点收敛时抽到这里)。
 * 生产域名从 config/production-endpoints.json 权威源派生,不再散写字面量
 * (仓库根 scripts/check-endpoint-literals.mjs 门禁扫描)。
 */
import { loadProductionEndpoints } from '../../../../scripts/shared/production-endpoints.mjs';

/** 从主 API base 推导 device-link relay base:生产域名做 hostname 替换,本地 3333 → 3335。 */
export function deriveDeviceLinkApiBase(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    // Keep the historical single-base behavior for unusual test URLs.
    return baseUrl;
  }
  if (url.port === '3333') {
    url.port = '3335';
    return url.toString();
  }
  const productionEndpoints = loadProductionEndpoints();
  if (url.hostname === new URL(productionEndpoints.apiBaseUrl).hostname) {
    url.hostname = new URL(productionEndpoints.deviceLinkApiBaseUrl).hostname;
    return url.toString();
  }
  return baseUrl;
}
