import { getClientEndpoint } from '../clientEndpointsService.js';
import { getModelAccessCredentialsStore } from './credentialsStore.js';

/**
 * effectiveEndpoint.ts — 当前生效的 XD 网关推理入口(endpoint 与 key 同源不变量)。
 * ---------------------------------------------------------------------------
 * - 凭据来源为 server(model-access 自动下发)→ 用下发时配套的 endpoint;
 * - 手填 / 无标记 → 回落端点清单值(manifest / 烘焙 xdGatewayBaseUrl)。
 *
 * 所有「拿 XD key 打网关」的 main 消费方都应经此取 endpoint(直接或经
 * runtime-configs.claudeUpstreamEndpoint()),保证 key 与 endpoint 永远同租户。
 * 例外:api-key:test-connection 验证的是**正在手填**的 key,必须配手填 pairing
 * 的清单值,故保持直读 getClientEndpoint(见 bootstrap-electron 注释)。
 *
 * 纯内存读(store 有缓存),可安全出现在请求期热路径(规则 10)。
 */
export function effectiveXdGatewayBaseUrl(): string {
  return (
    getModelAccessCredentialsStore().getServerEndpoint() ?? getClientEndpoint('xdGatewayBaseUrl')
  );
}
