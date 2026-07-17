/**
 * 单测用的端点清单 fixture(2026-07 端点清单重构后,shared/endpoints.ts 的
 * 烘焙端点常量全部退役,测试不再从那里拿"真值"当 fixture)。
 *
 * 用法:
 *  - 只需要一个 URL 当输入/预期:直接引 TEST_* 常量;
 *  - 被测代码内部会调 getClientEndpoint():beforeEach 里
 *    `resetClientEndpointsForTest(TEST_CLIENT_ENDPOINTS)` 注入整份清单
 *    (init 前调用 getClientEndpoint 会抛错——这是刻意的启动时序守卫)。
 *
 * 值全部是 .invalid 保留域名(RFC 2606),不会撞 check-endpoint-literals 的
 * 生产域名门禁,也不可能被真实网络解析。
 */
import type { ClientEndpointMap } from '@lizi/maker-shared/client-endpoints';

export const TEST_XD_GATEWAY_BASE_URL = 'https://gateway.test.invalid';
export const TEST_CDN_BASE_URL = 'https://cdn.test.invalid/app';

export const TEST_CLIENT_ENDPOINTS: ClientEndpointMap = {
  apiBaseUrl: 'https://api.test.invalid',
  authApiBaseUrl: 'https://auth.test.invalid',
  deviceLinkApiBaseUrl: 'https://device.test.invalid',
  oauthBrokerApiBaseUrl: 'https://oauth.test.invalid',
  ossApiBaseUrl: 'https://oss.test.invalid',
  heartbeatUrl: 'https://heartbeat.test.invalid',
  slackHookWsUrl: 'wss://slack-hook.test.invalid',
  websiteUrl: 'https://website.test.invalid',
  xdGatewayBaseUrl: TEST_XD_GATEWAY_BASE_URL,
  cdnBaseUrl: TEST_CDN_BASE_URL,
  cdnInternalBaseUrl: 'http://cdn-internal.test.invalid:20080/app',
};
