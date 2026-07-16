/**
 * device-link-base.mjs — 冒烟 / mock 脚本共享的 device-link API base 推导
 * (原先 6 个脚本各持一份逐字节相同的副本,2026-07 端点收敛时抽到这里)。
 * 生产域名从 config/production-endpoints.json 权威源派生,不再散写字面量
 * (仓库根 scripts/check-endpoint-literals.mjs 门禁扫描)。
 */
import { productionEndpoints } from '../../../../scripts/shared/production-endpoints.mjs';

const API_PROD_HOSTNAME = new URL(productionEndpoints.apiBaseUrl).hostname;
const DEVICE_LINK_PROD_HOSTNAME = new URL(productionEndpoints.deviceLinkApiBaseUrl).hostname;

/** 从主 API base 推导 device-link relay base:生产域名做 hostname 替换,本地 3333 → 3335。 */
export function deriveDeviceLinkApiBase(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (url.hostname === API_PROD_HOSTNAME) {
      url.hostname = DEVICE_LINK_PROD_HOSTNAME;
      return url.toString();
    }
    if (url.port === '3333') {
      url.port = '3335';
      return url.toString();
    }
  } catch {
    // Keep the historical single-base behavior for unusual test URLs.
  }
  return baseUrl;
}
