/**
 * endpoints.ts — desktop 端硬编码服务端点的唯一定义点。
 *
 * 约定(2026-07 端点收敛):
 *  - 任何「运行时会真正请求的服务地址」的默认值/字面量,一律定义在本文件,
 *    业务代码只允许 import 常量,不允许再散写 URL 字面量。
 *    受控域名清单与允许位置由仓库根 `scripts/check-endpoint-literals.mjs` 门禁扫描。
 *  - env 覆盖逻辑(import.meta.env.VITE_* / process.env.*)留在各消费方,
 *    本文件只放纯常量——shared 目录会被 main / renderer / 测试多端引用,
 *    不在这里读环境,避免绑定构建上下文。
 *  - 生产域名(xdt-api / device-link / oauth-broker / CDN)的跨端权威源是仓库根
 *    `config/production-endpoints.json`;本文件中的对应值必须与其一致
 *    (门禁脚本校验),改生产域名先改那份 JSON。
 *  - 第三方协议固定端点(Anthropic / OpenAI / 飞书 OAuth 等)不在本文件范围,
 *    按模块就近定义;本文件只管「自家部署域名 + 少量全局单点」。
 */

/**
 * XD 网关(litellm proxy)base URL。
 * Claude Code 上游(maker-host 的 CLAUDE_UPSTREAM_ENDPOINT 即此值)、embedding、
 * Cindy 媒体代理、语音凭据、用量查询共用。消费方可用 VITE_XDPROXY_BASE_URL 覆盖
 * (Claude 上游链路目前不提供覆盖,见 runtime-configs.ts 注释)。
 */
export const XD_GATEWAY_BASE_URL = 'https://llm-proxy.tapsvc.com';

/** 主 server API 的 dev 兜底地址(生产由构建期注入 VITE_API_BASE_URL,不走此值)。 */
export const API_BASE_URL_DEV_FALLBACK = 'http://localhost:3333';

/** device-link relay 的 dev 兜底地址(生产由构建期注入 VITE_DEVICE_LINK_API_BASE_URL)。 */
export const DEVICE_LINK_API_BASE_DEV_FALLBACK = 'http://localhost:3335';

/** 心跳服务(apps/heartbeat-server)生产默认地址,可用 VITE_HEARTBEAT_URL 覆盖。 */
export const HEARTBEAT_DEFAULT_ENDPOINT = 'https://xdt-heartbreak.magiclizi.com';

/** 更新/资源 manifest 的外网 CDN base(XDT_CDN_BASE_URL 可整体旁路,见 manifestService)。 */
export const CDN_EXTERNAL_BASE_URL = 'https://dev-cdn.fp.xd.com/xdt-maker';

/** 公司内网 CDN base(manifestService 探测命中内网时使用)。 */
export const CDN_INTERNAL_BASE_URL = 'http://xdtown-static-maker.xdcdn.cn:20080/xdt-maker';

/** TapDB 埋点上报端点(renderer tapdbClient 使用;SDK 直接 POST 到该完整 URL)。 */
export const TAPDB_EVENT_URL = 'https://e.tapdb.com/event';

/** 公司内部 GitLab 域名(urlTextBoundary 按 host 识别 MR/issue 链接边界时使用)。 */
export const INTERNAL_GITLAB_HOST = 'git.xindong.com';
