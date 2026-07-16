/**
 * Desktop 端点适配层。
 *
 * 生产 URL 由构建脚本读取未提交的 config/production-endpoints.json 后注入 VITE_*；
 * 本文件只提供类型化出口，不保存任何生产地址。空值表示当前开发构建未配置该能力，
 * 正式构建会在进入 Vite 前由加载器 fail closed。
 */

function injectedEndpoint(value: string | undefined): string {
  return value?.trim().replace(/\/+$/, '') ?? '';
}

/** XD 网关 base URL。 */
export const XD_GATEWAY_BASE_URL = injectedEndpoint(import.meta.env.VITE_XDPROXY_BASE_URL);

/** 主 server API 的本地开发兜底地址。 */
export const API_BASE_URL_DEV_FALLBACK = 'http://localhost:3333';

/** Cindy auth-server 的本地开发兜底地址。*/
export const AUTH_BASE_URL_DEV_FALLBACK = 'http://localhost:3344';

/** device-link relay 的本地开发兜底地址。 */
export const DEVICE_LINK_API_BASE_DEV_FALLBACK = 'http://localhost:3335';

/** 产品官网(更新横幅 / splash 的手动下载跳转);国内/海外差异由各分发渠道的端点配置承载。 */
export const WEBSITE_URL = injectedEndpoint(import.meta.env.VITE_WEBSITE_URL);

/** 心跳服务端点。 */
export const HEARTBEAT_DEFAULT_ENDPOINT = injectedEndpoint(import.meta.env.VITE_HEARTBEAT_URL);

/** 更新/资源 manifest 的外部 CDN base。 */
export const CDN_EXTERNAL_BASE_URL = injectedEndpoint(import.meta.env.VITE_CDN_BASE_URL);

/** 公司内网 CDN base。 */
export const CDN_INTERNAL_BASE_URL = injectedEndpoint(import.meta.env.VITE_CDN_INTERNAL_BASE_URL);

/** Slack Hook WebSocket 地址。 */
export const SLACK_HOOK_DEFAULT_URL = injectedEndpoint(import.meta.env.VITE_SLACK_HOOK_WS_URL);

/** TapDB 埋点上报端点；第三方固定协议地址不属于生产端点私有配置。 */
export const TAPDB_EVENT_URL = 'https://e.tapdb.com/event';

/** 公司内部 GitLab 域名，仅用于 renderer 识别链接边界，不发起请求。 */
export const INTERNAL_GITLAB_HOST = 'git.xindong.com';
