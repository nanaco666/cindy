/**
 * clientEndpoints — 客户端远程端点清单的共享 schema / 校验 / 严格解析。
 *
 * 背景:desktop / mobile 的生产端点在构建期内联进包体,发版后无法变更。OSS 上
 * 存放一份公开读的清单(仓内正本 `config/client-endpoints.json`,人肉上传),
 * 应用启动第一步、**先于检查更新**从 CDN 拉取;OSS 清单修改后重启应用生效。
 *
 * 语义是**强一致阻断式**(2026-07 与 Lizi 定案):清单拉不到 / 校验不过 = 启动
 * 阻断,宿主必须报错并提供重试,**没有缓存回退、没有超时后静默继续**。烘焙值只在
 * 两种场景使用:(a) dev 构建(desktop 未打包 / mobile __DEV__)整个跳过拉取;
 * (b) 清单里**缺省**的字段逐项回退烘焙值(清单本身必须成功拉到并整份合法)。
 *
 * 职责边界(仓规则 2):本模块是纯逻辑层,不做任何 IO——fetch / 报错交互由宿主
 * (desktop main / mobile 启动闸门)实现,这里只提供确定性的解析与合并(仓规则 9)。
 *
 * 校验语义(与 scripts/shared/production-endpoints.mjs 的协议白名单对齐):
 *  - 未知字段忽略(向前兼容,新增字段不 bump schemaVersion);
 *  - 任一【存在】字段非法(协议不符 / 带凭据 / 非字符串)→ 整份拒绝;
 *  - schemaVersion 缺失、非正整数或大于当前支持版本 → 整份拒绝(breaking change
 *    才 bump 版本)。
 */

/** 当前客户端支持的清单 schema 版本;清单里更大的版本号会被整份拒绝。 */
export const CLIENT_ENDPOINTS_SCHEMA_VERSION = 1;

/** 清单允许携带的端点字段(与 config/production-endpoints.json 同名的客户端子集)。 */
export const CLIENT_ENDPOINT_KEYS = [
  'apiBaseUrl',
  // auth 不分 cn/global:国内/海外是两条 CDN 各发各的清单,清单本身已 region 化,
  // 客户端无脑取本字段即可(2026-07 与 Lizi 定案)。
  'authApiBaseUrl',
  'deviceLinkApiBaseUrl',
  'oauthBrokerApiBaseUrl',
  'heartbeatUrl',
  'slackHookWsUrl',
  'websiteUrl',
  'xdGatewayBaseUrl',
  // model-access-server(登录后自动下发 LLM 网关凭据)的 API 基址。
  'modelAccessApiBaseUrl',
  'cdnBaseUrl',
  'cdnInternalBaseUrl',
] as const;

export type ClientEndpointKey = (typeof CLIENT_ENDPOINT_KEYS)[number];

/** 解析完成后的端点全集(每个 key 都有值,清单缺省字段已回退烘焙值)。 */
export type ClientEndpointMap = Record<ClientEndpointKey, string>;

/** 各字段允许的 URL 协议白名单。 */
const FIELD_PROTOCOLS: Record<ClientEndpointKey, readonly string[]> = {
  apiBaseUrl: ['https:'],
  authApiBaseUrl: ['https:'],
  deviceLinkApiBaseUrl: ['https:'],
  oauthBrokerApiBaseUrl: ['https:'],
  heartbeatUrl: ['https:'],
  slackHookWsUrl: ['wss:'],
  websiteUrl: ['https:'],
  xdGatewayBaseUrl: ['https:'],
  modelAccessApiBaseUrl: ['https:'],
  cdnBaseUrl: ['https:'],
  cdnInternalBaseUrl: ['http:', 'https:'],
};

export type ParseClientEndpointManifestResult =
  | { ok: true; endpoints: Partial<ClientEndpointMap> }
  | { ok: false; reason: string };

/**
 * 解析并校验一份清单原文。纯函数,输入任意文本都不会抛出。
 * 返回的 endpoints 只含清单中实际出现且合法的字段(缺省回退由 resolve 负责)。
 */
export function parseClientEndpointManifest(rawText: string): ParseClientEndpointManifestResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not-an-object' };
  }
  const record = parsed as Record<string, unknown>;

  const schemaVersion = record.schemaVersion;
  if (
    typeof schemaVersion !== 'number' ||
    !Number.isInteger(schemaVersion) ||
    schemaVersion < 1
  ) {
    return { ok: false, reason: 'invalid-schema-version' };
  }
  if (schemaVersion > CLIENT_ENDPOINTS_SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported-schema-version:${schemaVersion}` };
  }

  const endpoints: Partial<ClientEndpointMap> = {};
  for (const key of CLIENT_ENDPOINT_KEYS) {
    if (!(key in record)) continue;
    const raw = record[key];
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, reason: `invalid-field:${key}` };
    }
    const normalized = raw.trim().replace(/\/+$/, '');
    let url: URL;
    try {
      url = new URL(normalized);
    } catch {
      return { ok: false, reason: `invalid-field:${key}` };
    }
    if (!FIELD_PROTOCOLS[key].includes(url.protocol)) {
      return { ok: false, reason: `invalid-protocol:${key}` };
    }
    if (url.username || url.password) {
      return { ok: false, reason: `credentials-in-url:${key}` };
    }
    endpoints[key] = normalized;
  }
  return { ok: true, endpoints };
}

export type ResolveClientEndpointsResult =
  | { ok: true; endpoints: ClientEndpointMap }
  | { ok: false; reason: string };

/**
 * 严格解析:清单原文 → 完整端点 map。
 *
 *  - rawText 为 null(拉取失败/超时)→ ok:false('fetch-failed'),宿主必须阻断并重试;
 *  - 清单非法 → ok:false(带 parse reason),同样阻断——**坏清单不静默降级**,
 *    否则发布事故会被回退链掩盖成"部分用户端点漂移";
 *  - 成功 → 清单字段覆盖烘焙值,缺省字段逐项回退烘焙值。
 */
export function resolveClientEndpointsStrict(
  rawText: string | null,
  bakedDefaults: ClientEndpointMap,
): ResolveClientEndpointsResult {
  if (rawText === null) {
    return { ok: false, reason: 'fetch-failed' };
  }
  const parsed = parseClientEndpointManifest(rawText);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  const endpoints = { ...bakedDefaults };
  for (const key of CLIENT_ENDPOINT_KEYS) {
    const value = parsed.endpoints[key];
    if (value) endpoints[key] = value;
  }
  return { ok: true, endpoints };
}
